import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHostRoutes, API_PREFIX, isSafeHostMutation } from '../src/host-routes.js';
import { parseAuthEndpoints } from '../src/cindy-auth-endpoints.js';

const endpoints = region => parseAuthEndpoints({ schemaVersion: 1, authApiBaseUrl: region === 'cn' ? 'https://auth.cindy.com.cn' : 'https://auth.cindy.app',
  deviceLinkApiBaseUrl: region === 'cn' ? 'https://device-link.cindy.com.cn' : 'https://device-link.cindy.app' }, region);
const provider = region => ({ region, attribution: 'phone', phone: true, email: true, social: ['apple'] });
const outcome = () => ({ status: 'ok', accessToken: 'ACCESS_SECRET', refreshToken: 'REFRESH_SECRET', membership: { id: 'm', displayName: 'User' } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
async function call(routes, suffix, body, headers = { host: '127.0.0.1:41489', origin: 'http://127.0.0.1:41489', 'content-type': 'application/json' }) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = 'POST'; req.url = API_PREFIX + suffix; req.headers = headers;
  req.socket = { remoteAddress: '127.0.0.1' };
  let status, payload, responseHeaders;
  const res = { headersSent: false, writeHead(code, headers) { status = code; responseHeaders = headers; this.headersSent = true; }, end(value) { payload = JSON.parse(String(value)); } };
  await routes.handle(req, res); return { status, body: payload, headers: responseHeaders };
}
function setup(overrides = {}) {
  let stored = null; let connects = 0; const networks = [];
  const runtime = { status: { setLogin() {} }, getStatus: () => ({ login: { authenticated: !!stored } }),
    beginIdentityChange: async () => {}, connect: async () => { connects++; }, disconnect: async () => {} };
  const ports = { loadSession: async () => stored, saveSession: async session => { stored = session; }, clearSession: async () => { stored = null; } };
  const routes = createHostRoutes({ getRuntime: () => runtime, credentialPorts: ports, onAuthenticated: async session => { networks.push(session.realm); },
    authOptions: { registry: { load: async region => endpoints(region) }, request: async (ep, path) => path === '/api/auth/providers' ? provider(ep.region) : path.endsWith('request-code') ? { status: 'sent' } : outcome() }, ...overrides });
  return { routes, runtime, ports, get stored() { return stored; }, get connects() { return connects; }, networks };
}

test('mutation admission rejects cross-site forms, Origin forgery and rebinding before side effects', async t => {
  const h = setup(); t.after(() => h.routes.dispose());
  for (const headers of [
    { host: '127.0.0.1:41489', origin: 'https://evil.example', 'content-type': 'application/json' },
    { host: '127.0.0.1:41489', 'content-type': 'text/plain' },
    { host: 'evil.example:41489', 'content-type': 'application/json' },
    { host: '127.0.0.1:41489', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
  ]) assert.equal((await call(h.routes, '/login/flow', { action: 'start', region: 'cn' }, headers)).status, 403);
  assert.equal(h.connects, 0); assert.equal(h.stored, null);
  assert.equal(isSafeHostMutation({ headers: { host: '[::1]:41489', origin: 'http://[::1]:41489', 'content-type': 'application/json' } }), true);
});

test('flow routes return a secret-free projection and restart the network only after secure persistence', async t => {
  const h = setup(); t.after(() => h.routes.dispose());
  let response = await call(h.routes, '/login/flow', { action: 'start', region: 'global' });
  assert.equal(response.status, 200); assert.equal(response.headers['cache-control'], 'no-store');
  let view = response.body.view;
  response = await call(h.routes, '/login/flow', { action: 'request_code', attemptId: view.attemptId, revision: view.revision, kind: 'email', identifier: 'user@example.com' });
  view = response.body.view;
  response = await call(h.routes, '/login/flow', { action: 'verify_code', attemptId: view.attemptId, revision: view.revision, code: '123456' });
  assert.equal(response.body.view.step, 'completed');
  assert.equal(h.stored.realm, 'global'); assert.deepEqual(h.networks, ['global']);
  assert.doesNotMatch(JSON.stringify(response.body), /ACCESS_SECRET|REFRESH_SECRET/);
});

test('a late legacy verification result cannot sign in after logout', async t => {
  const pending = deferred();
  const h = setup({ auth: { verifyLoginCode: async () => pending.promise } });
  t.after(() => h.routes.dispose());
  const login = call(h.routes, '/login/verify-code', { kind: 'phone', identifier: '13800000000', code: '123456' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await call(h.routes, '/logout', {})).status, 200);
  pending.resolve({ ok: true, session: { deviceId: 'device', authBaseUrl: 'https://auth.cindy.com.cn', accessToken: 'late', refreshToken: 'late' } });
  assert.equal((await login).body.ok, false);
  assert.equal(h.stored, null); assert.equal(h.connects, 0);
});

test('logout drains an in-flight credential commit and prevents reconnect after its delayed completion', async t => {
  const saving = deferred(); const entered = deferred(); let stored = null; let connects = 0;
  const ports = { loadSession: async () => stored, saveSession: async session => { entered.resolve(); await saving.promise; stored = session; }, clearSession: async () => { stored = null; } };
  const h = setup({ credentialPorts: ports, getRuntime: () => ({ status: { setLogin() {} }, getStatus: () => ({}), beginIdentityChange: async () => {}, connect: async () => { connects++; }, disconnect: async () => {} }) });
  t.after(() => h.routes.dispose());
  let view = (await call(h.routes, '/login/flow', { action: 'start', region: 'cn' })).body.view;
  view = (await call(h.routes, '/login/flow', { action: 'request_code', attemptId: view.attemptId, revision: view.revision, kind: 'phone', identifier: '13800000000' })).body.view;
  const login = call(h.routes, '/login/flow', { action: 'verify_code', attemptId: view.attemptId, revision: view.revision, code: '123456' });
  await entered.promise; const logout = call(h.routes, '/logout', {});
  await new Promise(resolve => setImmediate(resolve)); saving.resolve();
  await Promise.all([login, logout]); assert.equal(stored, null); assert.equal(connects, 0);
});
