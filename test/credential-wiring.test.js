import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHostRoutes, API_PREFIX } from '../src/host-routes.js';
import { startHost } from '../src/host.js';
import { CredentialStoreUnavailableError } from '../src/credential-store.js';

const SESSION = { deviceId: 'fake-device', authBaseUrl: 'https://auth.cindy.com.cn', accessToken: 'fake-at', refreshToken: 'fake-rt' };
function ports() {
  let saved = null;
  let refreshes = 0;
  return {
    credentialStoreAvailable: () => true,
    loadSession: async () => saved,
    saveSession: async value => { saved = structuredClone(value); },
    clearSession: async () => { saved = null; },
    refreshStoredSession: async stored => ({ ok: true, session: { ...stored, accessToken: 'fake-at-' + ++refreshes, refreshToken: 'fake-rt-' + refreshes } }),
  };
}
async function call(routes, path) {
  const req = { method: 'POST', url: API_PREFIX + path, socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield Buffer.from('{}'); } };
  const res = { statusCode: 0, writeHead(code) { this.statusCode = code; }, end(value) { this.body = JSON.parse(String(value)); } };
  await routes.handle(req, res);
  return res;
}

test('card login, runtime restore/reconnect, account selection and logout share the injected store', async () => {
  const credentialPorts = ports();
  const routes = createHostRoutes({ getRuntime: () => undefined, credentialPorts,
    auth: { verifyLoginCode: async () => ({ ok: true, session: SESSION }), selectLoginAccount: async () => ({ ok: true, session: SESSION }) } });
  assert.equal((await call(routes, '/login/verify-code')).statusCode, 200);
  assert.deepEqual(await credentialPorts.loadSession(), SESSION);
  const socketSessions = [];
  const runtime = await startHost(undefined, { transportEnabled: true, remoteControlEnabled: false }, {
    credentialPorts, heartbeatMs: 0,
    openSocket: session => { socketSessions.push(session); const ws = new EventEmitter(); ws.readyState = 1; ws.close = () => {}; ws.send = () => {}; return ws; },
  });
  try {
    assert.equal(socketSessions[0].accessToken, 'fake-at-1');
    assert.equal((await credentialPorts.loadSession()).refreshToken, 'fake-rt-1');
    await runtime.disconnect({ keepSwitch: true });
    await runtime.reconnectNow();
    assert.equal(socketSessions[1].accessToken, 'fake-at-2');
    assert.equal((await credentialPorts.loadSession()).refreshToken, 'fake-rt-2');
  } finally { await runtime.stop(); }
  assert.equal((await call(routes, '/login/select-account')).statusCode, 200);
  assert.deepEqual(await credentialPorts.loadSession(), SESSION);
  assert.equal((await call(routes, '/logout')).statusCode, 200);
  assert.equal(await credentialPorts.loadSession(), null);
});

test('a corrupt/locked store fails runtime startup without presenting another login', async () => {
  const credentialPorts = { ...ports(), loadSession: async () => { throw new CredentialStoreUnavailableError(); } };
  const runtime = await startHost(undefined, { transportEnabled: true }, { credentialPorts,
    openSocket: () => assert.fail('no socket before credentials are readable'), heartbeatMs: 0 });
  try {
    assert.equal(runtime.getStatus().state, 'failed');
    assert.equal(runtime.getStatus().login.required, false);
  } finally { await runtime.stop(); }
});

test('a failed login save or logout never claims success', async () => {
  const broken = { ...ports(), saveSession: async () => { throw new CredentialStoreUnavailableError(); }, clearSession: async () => { throw new CredentialStoreUnavailableError(); } };
  const routes = createHostRoutes({ getRuntime: () => undefined, credentialPorts: broken,
    auth: { verifyLoginCode: async () => ({ ok: true, session: SESSION }) } });
  assert.equal((await call(routes, '/login/verify-code')).statusCode, 500);
  assert.equal((await call(routes, '/logout')).statusCode, 500);
});
