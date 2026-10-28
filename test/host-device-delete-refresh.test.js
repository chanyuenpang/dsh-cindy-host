import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteAccountDevice } from '../src/host-device-delete.js';
const snapshot = { host: { deviceId: 'self' }, devices: [{ deviceId: 'old', online: false }] };
const base = { deviceId: 'old', session: { deviceId: 'self', accessToken: 'expired' }, snapshot, url: 'https://example.test/devices' };
const reply = status => ({ status, ok: status === 200, json: async () => ({ deleted: true, deviceId: 'old' }) });
test('expired token renews once through owner and retries with renewed bearer', async () => {
  let calls = 0, refreshes = 0;
  const result = await deleteAccountDevice({ ...base, refreshSession: async session => { refreshes++; assert.equal(session, base.session); return { ...session, accessToken: 'renewed' }; }, fetchImpl: async (_, options) => { calls++; assert.equal(options.headers.Authorization, calls === 1 ? 'Bearer expired' : 'Bearer renewed'); return reply(calls === 1 ? 401 : 200); } });
  assert.equal(result.ok, true); assert.equal(calls, 2); assert.equal(refreshes, 1);
});
test('failed renewal and repeated unauthorized never loop or report deletion', async () => {
  for (const renew of [null, { ...base.session, accessToken: 'renewed' }]) {
    let calls = 0, refreshes = 0;
    const result = await deleteAccountDevice({ ...base, refreshSession: async () => { refreshes++; return renew; }, fetchImpl: async () => { calls++; return reply(401); } });
    assert.equal(result.statusCode, 401); assert.equal(result.ok, false); assert.equal(refreshes, 1); assert.equal(calls, renew ? 2 : 1);
  }
});
test('renewal rechecks current presence before retrying deletion', async () => {
  let calls = 0, current = snapshot;
  const result = await deleteAccountDevice({ ...base, getSnapshot: () => current, refreshSession: async () => { current = { ...snapshot, devices: [{ deviceId: 'old', online: true }] }; return base.session; }, fetchImpl: async () => { calls++; return reply(401); } });
  assert.equal(result.statusCode, 409); assert.equal(calls, 1);
});
test('upstream HTTP errors keep distinct status without leaking response secrets', async () => {
  for (const status of [401, 403, 404, 405, 409, 429, 500, 503]) {
    const result = await deleteAccountDevice({ ...base, fetchImpl: async () => ({ status, ok: false, json: async () => ({ message: 'secret-token' }) }) });
    assert.equal(result.statusCode, status); assert.equal(result.ok, false); assert.ok(!result.message.includes('secret-token'));
    if (status !== 409) assert.ok(!result.message.includes('设备状态冲突'));
  }
});
