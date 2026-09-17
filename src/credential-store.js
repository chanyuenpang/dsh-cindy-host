import keytar from 'keytar';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';

const SERVICE = 'DSH Cindy Host';

/**
 * The credential-store entry the default installation has always used.
 *
 * The OS keeps these per (service, account), and the account is what separates two DSH
 * installations on one machine — not a folder, because there is no folder: one machine,
 * one credential store.
 */
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
 * @returns the keytar account name for this process.
 */
export function credentialAccount(env = process.env, defaultHome = defaultDshHome()) {
  const home = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (home === '' || sameHome(home, defaultHome)) return DEFAULT_ACCOUNT;
  // A digest, not the path: this string is written into the OS credential store, and a
  // Windows path with backslashes and a drive letter has no business being there.
  const digest = createHash('sha256').update(home).digest('hex').slice(0, 12);
  return `${DEFAULT_ACCOUNT}@${digest}`;
}

export async function loadSession(ports = {}) {
  const account = ports.account ?? credentialAccount();
  const value = await keytar.getPassword(SERVICE, account);
  return value ? JSON.parse(value) : null;
}

export async function saveSession(session, ports = {}) {
  const account = ports.account ?? credentialAccount();
  await keytar.setPassword(SERVICE, account, JSON.stringify(session));
}

export async function clearSession(ports = {}) {
  const account = ports.account ?? credentialAccount();
  await keytar.deletePassword(SERVICE, account);
}
