import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostRoutes, API_PREFIX } from '../src/host-routes.js';
import { HOST_APP_VERSION } from '../src/host-version.js';
import { HostStatus } from '../src/host-status.js';
import { acceptLink } from '../src/host-authorization.js';
async function verify(routes) {
  const req = { method: 'POST', url: API_PREFIX + '/login/verify-code', socket: {}, async *[Symbol.asyncIterator]() { yield Buffer.from('{}'); } };
  const res = { writeHead(code) { this.code = code; }, end(body) { this.body = JSON.parse(body); } };
  await routes.handle(req, res); return res;
}
test('read failures cannot silently register a new device', async () => {
  let verified = 0;
  const routes = createHostRoutes({ getRuntime: () => null, auth: { loadSession: async () => { throw new Error('keytar unavailable'); }, verifyLoginCode: async () => { verified++; } } });
  assert.equal((await verify(routes)).code, 500);
  assert.equal(verified, 0);
});
test('new identities require durable settings before registration', async () => {
  let verified = 0;
  const routes = createHostRoutes({ getRuntime: () => null, getSettings: () => ({}), rememberDeviceId: async () => { throw new Error('disk'); }, auth: { loadSession: async () => null, verifyLoginCode: async () => { verified++; } } });
  assert.equal((await verify(routes)).code, 500);
  assert.equal(verified, 0);
});
test('concurrent verification shares one newly generated identity', async () => {
  const ids = []; let writes = 0;
  const routes = createHostRoutes({ getRuntime: () => null, getSettings: () => ({}), rememberDeviceId: async () => { writes++; }, auth: { loadSession: async () => null, verifyLoginCode: async ({ deviceId }) => { ids.push(deviceId); return { ok: false }; } } });
  await Promise.all([verify(routes), verify(routes)]);
  await verify(routes);
  assert.equal(new Set(ids).size, 1); assert.equal(ids.length, 3);
  assert.ok(writes >= 1);
});
test('credential identity wins even if settings mirror fails', async () => {
  let id;
  const routes = createHostRoutes({ getRuntime: () => null, rememberDeviceId: async () => { throw new Error('disk'); }, auth: { loadSession: async () => ({ deviceId: 'original' }), verifyLoginCode: async args => { id = args.deviceId; return { ok: false }; } } });
  await verify(routes); assert.equal(id, 'original');
});
test('status and link acceptance use the real September stable version', () => {
  const status = new HostStatus(); status.setHost({ deviceId: 'self' });
  assert.equal(HOST_APP_VERSION, '0.1.82');
  assert.equal(status.snapshot().host.appVersion, HOST_APP_VERSION);
  assert.equal(acceptLink({ src: 'peer', id: 'link' }, new Set()).payload.appVersion, HOST_APP_VERSION);
});
