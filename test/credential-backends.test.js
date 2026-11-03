import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCredentialStore } from '../src/credential-store.js';
import { runCredentialCommand, DPAPI_SCRIPT } from '../src/credential-command.js';

const SESSION = { deviceId: 'fake-device', authBaseUrl: 'https://auth.invalid', accessToken: 'fake-access', refreshToken: 'fake-refresh', identifier: '测试 "quoted" \n identity' };
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const unavailable = { code: 'CREDENTIAL_STORE_UNAVAILABLE' };
function memory() {
  const records = new Map();
  return { records, async readRecord(key) { return structuredClone(records.get(key)); },
    async modifyRecord(key, change) { records.set(key, structuredClone(await change(records.get(key)))); },
    async deleteRecord(key) { records.delete(key); } };
}
function fakeDpapi() {
  const values = new Map();
  const calls = [];
  const run = async (file, args, input) => {
    calls.push({ file, args, input });
    const request = JSON.parse(input);
    if (request.operation === 'protect') {
      const cipher = Buffer.from('cipher-' + values.size).toString('base64');
      values.set(cipher, { clear: request.data, entropy: request.entropy });
      return ok(cipher);
    }
    const value = values.get(request.data);
    if (!value || value.entropy !== request.entropy) return { code: 1, stdout: '', stderr: 'sensitive failure' };
    return ok(value.clear);
  };
  return { run, calls };
}
const windows = (provider, command, account) => createCredentialStore({ platform: 'win32', env: { SystemRoot: 'C:/Windows' },
  getCredentials: () => provider, run: command, ...(account ? { account } : {}) });

test('Windows passes only DPAPI ciphertext to DSH; a fresh instance reads the same record', async () => {
  const provider = memory();
  const dpapi = fakeDpapi();
  const first = windows(provider, dpapi.run);
  assert.equal(first.credentialStoreAvailable(), true);
  assert.equal(await first.loadSession(), null);
  await first.saveSession(SESSION);
  assert.equal(provider.records.size, 1);
  const serialized = JSON.stringify([...provider.records]);
  assert.doesNotMatch(serialized, /fake-access|fake-refresh|fake-device/);
  assert.match(serialized, /dpapi-current-user-v1/);
  assert.deepEqual(await windows(provider, dpapi.run).loadSession(), SESSION);
  for (const call of dpapi.calls) {
    assert.doesNotMatch(JSON.stringify(call.args), /fake-access|fake-refresh|fake-device/);
    assert.equal(call.args.at(-1), DPAPI_SCRIPT);
    assert.match(call.file, /WindowsPowerShell/);
  }
  await first.clearSession();
  assert.equal(await first.loadSession(), null);
});

test('Windows isolates homes and binds DPAPI entropy to the account', async () => {
  const provider = memory();
  const dpapi = fakeDpapi();
  const a = windows(provider, dpapi.run, 'session-v1@aaaaaaaaaaaa');
  const b = windows(provider, dpapi.run, 'session-v1@bbbbbbbbbbbb');
  await a.saveSession(SESSION);
  assert.equal(await b.loadSession(), null);
  provider.records.set('dsh-cindy-host/session-v1-home-bbbbbbbbbbbb', [...provider.records.values()][0]);
  await assert.rejects(b.loadSession(), unavailable);
  await b.clearSession();
  assert.deepEqual(await a.loadSession(), SESSION);
});

test('missing DSH service, malformed ciphertext and failed DPAPI never look like missing login', async () => {
  const absent = windows(undefined, async () => assert.fail('no encryption without persistence'));
  assert.equal(absent.credentialStoreAvailable(), false);
  for (const action of [() => absent.loadSession(), () => absent.saveSession(SESSION), () => absent.clearSession()]) await assert.rejects(action(), unavailable);
  const provider = memory();
  for (const record of [null, { kind: 'grant', payload: SESSION }, { kind: 'grant', payload: { format: 'dpapi-current-user-v1', ciphertext: 'not base64' } }]) {
    provider.records.set('dsh-cindy-host/session-v1', record);
    await assert.rejects(windows(provider, async () => assert.fail()).loadSession(), unavailable);
    assert.equal(provider.records.size, 1);
  }
  const failure = windows(provider, async () => { throw new Error(SESSION.refreshToken); });
  await assert.rejects(failure.saveSession(SESSION), error => error.code === unavailable.code && !error.message.includes(SESSION.refreshToken));
});

test('Linux uses legacy service/account attributes; secrets are stdin only', async () => {
  const calls = [];
  let stored = null;
  const store = createCredentialStore({ platform: 'linux', env: {}, run: async (file, args, input) => {
    calls.push({ file, args, input });
    assert.equal(file, 'secret-tool');
    if (args[0] === 'store') { stored = input; return ok(); }
    if (args[0] === 'clear') { stored = null; return ok(); }
    return stored === null ? { code: 1, stdout: '', stderr: '' } : ok(stored + '\n');
  } });
  assert.equal(await store.loadSession(), null);
  await store.saveSession(SESSION);
  assert.deepEqual(await store.loadSession(), SESSION);
  await store.clearSession();
  assert.equal(await store.loadSession(), null);
  for (const call of calls) {
    assert.doesNotMatch(JSON.stringify(call.args), /fake-access|fake-refresh/);
    assert.deepEqual(call.args.slice(-4), ['service', 'DSH Cindy Host', 'account', 'session-v1']);
  }
});

test('Linux locked service, missing command and malformed stored value fail without deletion', async () => {
  for (const result of [{ code: 1, stdout: '', stderr: 'locked' }, ok('not-json'), ok('{}')]) {
    const calls = [];
    const store = createCredentialStore({ platform: 'linux', run: async (_file, args) => { calls.push(args); return result; } });
    await assert.rejects(store.loadSession(), unavailable);
    assert.equal(calls.length, 1);
  }
  const store = createCredentialStore({ platform: 'linux', run: async () => { throw new Error('ENOENT'); } });
  await assert.rejects(store.loadSession(), unavailable);
});

test('macOS reads/deletes existing Keychain entries and writes via stdin, never argv', async () => {
  const calls = [];
  const store = createCredentialStore({ platform: 'darwin', env: {}, run: async (file, args, input) => {
    assert.equal(file, '/usr/bin/security');
    calls.push({ args, input });
    if (args[0] === 'find-generic-password') return ok(JSON.stringify(SESSION) + '\n');
    if (args[0] === 'delete-generic-password') return { code: 44, stdout: '', stderr: 'not found' };
    return { ...ok(), stderr: 'security> security> ' };
  } });
  assert.deepEqual(await store.loadSession(), SESSION);
  await store.saveSession(SESSION);
  await store.clearSession();
  assert.deepEqual(calls[1].args, ['-i']);
  assert.match(calls[1].input, /add-generic-password/);
  assert.equal(calls[1].input.split('\n').length, 2, 'embedded JSON escapes cannot inject another command');
  for (const call of calls) assert.doesNotMatch(JSON.stringify(call.args), /fake-access|fake-refresh/);
});

test('macOS only treats item-not-found as absence; interactive failures propagate', async () => {
  const missing = createCredentialStore({ platform: 'darwin', run: async () => ({ code: 44, stdout: '', stderr: 'not found' }) });
  assert.equal(await missing.loadSession(), null);
  for (const result of [{ code: 36, stdout: '', stderr: 'locked' }, { code: 0, stdout: '', stderr: 'security> SecKeychainItemModifyAttributesAndData: denied' }]) {
    const store = createCredentialStore({ platform: 'darwin', run: async () => result });
    await assert.rejects(store.saveSession(SESSION), unavailable);
  }
});

test('unsupported platform fails closed and command errors are sanitized', async () => {
  const store = createCredentialStore({ platform: 'unknown' });
  assert.equal(store.credentialStoreAvailable(), false);
  await assert.rejects(store.loadSession(), unavailable);
  await assert.rejects(runCredentialCommand('nonexistent-cindy-test-command', []), unavailable);
  await assert.rejects(runCredentialCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], '', { timeoutMs: 30 }), unavailable);
  await assert.rejects(runCredentialCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], '', { maxBytes: 10 }), unavailable);
});

// No real credentials or user profile are ever opened. Separate Node processes use
// real system DPAPI with a fake persistence seam confined to an OS temp directory.
test('Windows DPAPI survives fresh processes and never persists plaintext', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cindy-dpapi-test-'));
  const script =     'const fs = await import("node:fs/promises");' +
    'let input=""; for await (const c of process.stdin) input+=c;' +
    'const r=JSON.parse(input); const {createCredentialStore}=await import(r.module);' +
    'const provider={async readRecord(){try{return JSON.parse(await fs.readFile(r.path,"utf8"));}catch(e){if(e.code==="ENOENT")return undefined;throw e;}},' +
    'async modifyRecord(k,change){await fs.writeFile(r.path,JSON.stringify(await change()));},async deleteRecord(){await fs.rm(r.path,{force:true});}};' +
    'const store=createCredentialStore({account:"session-v1",getCredentials:()=>provider});' +
    'if(r.op==="save")await store.saveSession(r.session);' +
    'if(r.op==="read")process.stdout.write(JSON.stringify(await store.loadSession()));' +
    'if(r.op==="clear")await store.clearSession();';
  const path = join(dir, 'record.json');
  const run = op => execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    input: JSON.stringify({ op, path, session: SESSION, module: new URL('../src/credential-store.js', import.meta.url).href }), encoding: 'utf8', windowsHide: true,
  });
  try {
    run('save');
    assert.doesNotMatch(await readFile(path, 'utf8'), /fake-access|fake-refresh|fake-device/);
    assert.deepEqual(JSON.parse(run('read')), SESSION);
    run('clear');
    assert.equal(JSON.parse(run('read')), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
