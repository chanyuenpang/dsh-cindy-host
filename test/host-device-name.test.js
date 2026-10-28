import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceNameSync } from '../src/host-device-name.js';

const tick = () => new Promise(setImmediate);
const input = (name) => ({ name, deviceId: 'host/1', session: { accessToken: 'secret' } });
const answer = (name) => ({ ok: true, json: async () => ({ deviceId: 'host/1', name }) });

test('sync is opt-in, offline-safe and confirms the exact renamed device and name', async () => {
  const requests = [];
  const sync = createDeviceNameSync({ url: 'https://relay/api/device-link/devices', fetchImpl: async (url, init) => {
    requests.push({ url, init }); return answer(JSON.parse(init.body).name);
  } });
  sync.update({ name: null });
  sync.update({ name: 'Host' });
  assert.equal(requests.length, 0);
  assert.equal(sync.snapshot().state, 'pending');
  sync.update(input('中文 🖥'));
  await tick();
  assert.equal(sync.snapshot().state, 'synced');
  assert.equal(requests[0].url, 'https://relay/api/device-link/devices/host%2F1');
  assert.equal(requests[0].init.method, 'PATCH');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer secret');
  assert.deepEqual(JSON.parse(requests[0].init.body), { name: '中文 🖥' });
  assert.doesNotMatch(JSON.stringify(sync.snapshot()), /secret/);
});

test('rapid renames are serialized and coalesced, so the newest write lands last', async () => {
  const pending = [];
  const sync = createDeviceNameSync({ url: 'https://relay/devices', fetchImpl: (url, init) => new Promise(resolve => {
    pending.push({ name: JSON.parse(init.body).name, resolve });
  }) });
  sync.update(input('first'));
  sync.update(input('middle'));
  sync.update(input('last'));
  assert.equal(pending.length, 1);
  pending[0].resolve(answer('first'));
  await tick();
  assert.deepEqual(pending.map(row => row.name), ['first', 'last']);
  pending[1].resolve(answer('last'));
  await tick();
  assert.deepEqual(sync.snapshot(), { state: 'synced', name: 'last' });
});

test('disconnect aborts writes and stale success cannot mark a new owner synced', async () => {
  const pending = [];
  const sync = createDeviceNameSync({ url: 'https://relay/devices', fetchImpl: (url, init) => new Promise(resolve => {
    pending.push({ init, resolve });
  }) });
  sync.update(input('old'));
  sync.reset('new');
  assert.equal(pending[0].init.signal.aborted, true);
  pending[0].resolve(answer('old'));
  await tick();
  assert.deepEqual(sync.snapshot(), { state: 'pending', name: 'new' });
  sync.update(input('new'));
  pending[1].resolve(answer('new'));
  await tick();
  assert.deepEqual(sync.snapshot(), { state: 'synced', name: 'new' });
});

test('network, authentication and malformed responses report failed; explicit retry recovers', async () => {
  for (const response of [
    () => { throw new Error('secret'); },
    () => ({ ok: false, json: async () => ({ deviceId: 'host/1', name: 'Host' }) }),
    () => ({ ok: true, json: async () => ({ deviceId: 'wrong', name: 'Host' }) }),
    () => ({ ok: true, json: async () => ({ deviceId: 'host/1', name: 'wrong' }) }),
    () => ({ ok: true, json: async () => { throw new Error('not JSON'); } }),
  ]) {
    let fails = true;
    const sync = createDeviceNameSync({ url: 'https://relay/devices', fetchImpl: async () => fails ? response() : answer('Host') });
    sync.update(input('Host'));
    await tick();
    assert.deepEqual(sync.snapshot(), { state: 'failed', name: 'Host' });
    fails = false;
    sync.update(input('Host'));
    await tick();
    assert.equal(sync.snapshot().state, 'synced');
  }
});
