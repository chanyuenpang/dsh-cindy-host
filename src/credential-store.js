import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve as resolvePath, win32 } from 'node:path';
import { runCredentialCommand, DPAPI_SCRIPT, CredentialStoreUnavailableError } from './credential-command.js';
export { CredentialStoreUnavailableError } from './credential-command.js';

const SERVICE = 'DSH Cindy Host';
const FORMAT = 'dpapi-current-user-v1';

export const DEFAULT_ACCOUNT = 'session-v1';

/** DSH's own default home: `~/.dsh` (the same precedence `dsh-home-paths` documents). */
export function defaultDshHome() {
  return resolvePath(homedir(), '.dsh');
}

/** Compare two home paths the way the filesystem would: `~` expanded, case-insensitive on Windows. */
function sameHome(left, right) {
  const normalize = (value) => {
    const expanded = value.startsWith('~')
      ? resolvePath(homedir(), value.slice(1).replace(/^[\\/]+/, ''))
      : resolvePath(value);
    const trimmed = expanded.replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
  };
  return normalize(left) === normalize(right);
}

/**
 * Which credential entry this process owns.
 *
 * The rule is **"is this the default home"**, not **"is `DSH_HOME` set"**. That
 * distinction is not academic: this deployment sets `DSH_HOME=C:\Users\<user>\.dsh`
 * explicitly — the default home, spelled out — and a rule keyed on the variable being
 * present sent the real installation looking for an entry that had never existed, so it
 * booted with no session and would not connect, offering a login form for an account that
 * was already signed in. Measured right after a restart: `no stored session`.
 *
 * `DSH_HOME` naming a *different* home is a separate installation and does get its own
 * entry.
 *
 * Why scoping exists at all: the relay's device identity comes from the *login* —
 * `hello-ack` echoes a `deviceId` that the stored credential also carries — so two
 * installations sharing one entry present the **same** device id. The relay enforces one
 * connection per device (the client's own code: `4409: 同 deviceId 的新连接顶掉了本连接`),
 * and with a reconnect ladder on both sides that is not a brief overlap but a kicking
 * loop, with the controller's session list caught in the middle. A scoped credential gives
 * each installation its own device, its own login, and therefore its own task list.
 *
 * @param env - environment to read (injectable for tests).
 * @param defaultHome - the home treated as the default installation.
 * @returns the OS credential account name for this process.
 */
export function credentialAccount(env = process.env, defaultHome = defaultDshHome()) {
  const home = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (home === '' || sameHome(home, defaultHome)) return DEFAULT_ACCOUNT;
  // A digest, not the path: this string is written into the OS credential store, and a
  // Windows path with backslashes and a drive letter has no business being there.
  const digest = createHash('sha256').update(home).digest('hex').slice(0, 12);
  return `${DEFAULT_ACCOUNT}@${digest}`;
}


function parseSession(text) {
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['deviceId', 'authBaseUrl', 'accessToken', 'refreshToken'].every(key => typeof value[key] === 'string' && value[key].length > 0)) {
    throw new CredentialStoreUnavailableError();
  }
  return value;
}

function base64(value) {
  if (typeof value !== 'string' || !value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new CredentialStoreUnavailableError();
  return value;
}

// security's interactive command parser accepts quoted arguments. Secrets stay off argv.
const securityQuote = value => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

/** One installation's store. No process-global registration and no native npm modules.
 * Linux/macOS keep the historical service/account, so existing keychain records remain readable.
 * Windows stores ONLY DPAPI ciphertext in DSH's native record service, never in settings.
 */
export function createCredentialStore({ platform = process.platform, env = process.env, account = credentialAccount(env),
  getCredentials = () => undefined, run = runCredentialCommand } = {}) {
  if (!/^session-v1(?:@[0-9a-f]{12})?$/.test(account)) throw new TypeError('Invalid credential account');
  const recordKey = 'dsh-cindy-host/' + account.replace('@', '-home-');
  const attributes = ['service', SERVICE, 'account', account];
  function provider() {
    const value = getCredentials();
    if (!value || !['readRecord', 'modifyRecord', 'deleteRecord'].every(key => typeof value[key] === 'function')) throw new CredentialStoreUnavailableError();
    return value;
  }
  async function command(file, args, input = '') {
    return run(file, args, input);
  }
  async function dpapi(operation, data) {
    if (!env.SystemRoot) throw new CredentialStoreUnavailableError();
    const file = win32.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = await command(file, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT], JSON.stringify({
      operation, data, entropy: Buffer.from(SERVICE + '/' + account).toString('base64'),
    }));
    if (result.code !== 0) throw new CredentialStoreUnavailableError();
    return base64(result.stdout.trim());
  }
  async function read() {
    if (platform === 'win32') {
      const record = await provider().readRecord(recordKey);
      if (record === undefined) return null;
      if (record?.kind !== 'grant' || record.payload?.format !== FORMAT) throw new CredentialStoreUnavailableError();
      const clear = await dpapi('unprotect', base64(record.payload.ciphertext));
      return parseSession(Buffer.from(clear, 'base64').toString('utf8'));
    }
    if (platform === 'linux') {
      const result = await command('secret-tool', ['lookup', ...attributes]);
      if (result.code === 1 && !result.stdout && !result.stderr.trim()) return null;
      if (result.code !== 0) throw new CredentialStoreUnavailableError();
      return parseSession(result.stdout.trimEnd());
    }
    if (platform === 'darwin') {
      const result = await command('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w']);
      if (result.code === 44) return null; // errSecItemNotFound, not a locked/denied keychain
      if (result.code !== 0) throw new CredentialStoreUnavailableError();
      return parseSession(result.stdout.trimEnd());
    }
    throw new CredentialStoreUnavailableError();
  }
  async function write(session) {
    const text = JSON.stringify(session);
    parseSession(text);
    if (Buffer.byteLength(text) > 512 * 1024) throw new CredentialStoreUnavailableError();
    if (platform === 'win32') {
      const credentials = provider();
      const ciphertext = await dpapi('protect', Buffer.from(text).toString('base64'));
      await credentials.modifyRecord(recordKey, () => ({ kind: 'grant', payload: { format: FORMAT, ciphertext } }));
      return;
    }
    let result;
    if (platform === 'linux') result = await command('secret-tool', ['store', '--label=' + SERVICE, ...attributes], text);
    else if (platform === 'darwin') {
      const args = ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', text];
      result = await command('/usr/bin/security', ['-i'], args.map(securityQuote).join(' ') + '\n');
      // security -i may exit zero after a failed subcommand. Its diagnostics must still fail closed.
      if ([result.stdout, result.stderr].some(text => text.replace(/security>\s*/g, '').trim())) throw new CredentialStoreUnavailableError();
    } else throw new CredentialStoreUnavailableError();
    if (result.code !== 0) throw new CredentialStoreUnavailableError();
  }
  async function clear() {
    if (platform === 'win32') { await provider().deleteRecord(recordKey); return; }
    let result;
    if (platform === 'linux') {
      result = await command('secret-tool', ['clear', ...attributes]);
      if (result.code === 1 && !result.stderr.trim()) return;
    } else if (platform === 'darwin') {
      result = await command('/usr/bin/security', ['delete-generic-password', '-s', SERVICE, '-a', account]);
      if (result.code === 44) return;
    } else throw new CredentialStoreUnavailableError();
    if (result.code !== 0) throw new CredentialStoreUnavailableError();
  }
  // Neither child diagnostics nor JSON parse errors may carry credentials into logs/UI.
  const guarded = action => async (...args) => {
    try { return await action(...args); }
    catch { throw new CredentialStoreUnavailableError(); }
  };
  return {
    loadSession: guarded(read), saveSession: guarded(write), clearSession: guarded(clear),
    credentialStoreAvailable: () => {
      if (platform === 'linux' || platform === 'darwin') return true;
      if (platform !== 'win32' || !env.SystemRoot) return false;
      try { provider(); return true; } catch { return false; }
    },
  };
}

// Standalone Linux/macOS CLIs use the same system keychain. Windows needs a DSH
// credential service; without a host context fail explicitly, never write plaintext.
export const loadSession = (ports = {}) => createCredentialStore(ports).loadSession();
export const saveSession = (session, ports = {}) => createCredentialStore(ports).saveSession(session);
export const clearSession = (ports = {}) => createCredentialStore(ports).clearSession();
export const credentialStoreAvailable = (ports = {}) => createCredentialStore(ports).credentialStoreAvailable();
