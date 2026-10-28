import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteAccountDevice } from '../src/host-device-delete.js';
import { createHostRoutes, API_PREFIX } from '../src/host-routes.js';
const base = { deviceId: 'old/id', session: { deviceId: 'self', accessToken: 'test-token' }, snapshot: { host: { deviceId: 'self' }, devices: [{ deviceId: 'old/id', online: false }] }, url: 'https://example.test/devices' };
const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
test('delete uses existing bearer, encoded ID and requires server confirmation', async () => {
  let calls = 0;
  const result = await deleteAccountDevice({ ...base, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, base.url + '/old%2Fid');
    assert.equal(options.method, 'DELETE');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    return response({ deviceId: base.deviceId, deleted: true });
  } });
  assert.equal(result.ok, true); assert.equal(calls, 1);
});
test('self, online, unknown and unauthenticated deletes never make network calls', async () => {
  for (const patch of [{ deviceId: 'self' }, { deviceId: 'unknown' }, { session: null }, { snapshot: { devices: [{ deviceId: base.deviceId, online: true }] } }]) {
    const result = await deleteAccountDevice({ ...base, ...patch, fetchImpl: () => { throw new Error('unexpected network'); } });
    assert.equal(result.ok, false);
    assert.notEqual(result.statusCode, 502);
  }
});
test('refused, malformed, mismatched and failed responses never report deletion', async () => {
  for (const fetchImpl of [async () => response({}, 409), async () => response({}, 401), async () => response({ deleted: true, deviceId: 'other' }), async () => response({ deleted: false, deviceId: base.deviceId }), async () => { throw new Error('network secret'); }]) {
    const result = await deleteAccountDevice({ ...base, fetchImpl });
    assert.equal(result.ok, false);
    assert.ok(!result.message.includes('secret'));
  }
});
test('route requires JSON and blocks cross-site requests, then forwards result', async () => {
  let calls = 0;
  const routes = createHostRoutes({ getRuntime: () => ({ deleteDevice: async id => { calls++; assert.equal(id, 'old'); return { ok: true }; }, getStatus: () => ({ devices: [] }) }) });
  for (const [headers, expected] of [[{}, 403], [{ 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, 403], [{ 'content-type': 'application/json' }, 200]]) {
    const req = { method: 'POST', url: API_PREFIX + '/devices/delete', headers, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ deviceId: 'old' })); } };
    const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    await routes.handle(req, res); assert.equal(res.status, expected);
  }
  assert.equal(calls, 1);
});
