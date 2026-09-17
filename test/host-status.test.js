import test from 'node:test';
import assert from 'node:assert/strict';
import { HostStatus, CONNECTION_STATES, STATE_LABELS, isMobilePlatform } from '../src/host-status.js';

/** A clock that advances one second per read, so `updatedAt` moves observably. */
function steppingClock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
}

test('starts disconnected with the six-state vocabulary', () => {
  const status = new HostStatus();
  const snapshot = status.snapshot();
  assert.deepEqual(CONNECTION_STATES, ['disconnected', 'authenticating', 'connecting', 'waiting', 'connected', 'failed']);
  assert.equal(snapshot.state, 'disconnected');
  assert.equal(snapshot.stateLabel, STATE_LABELS.disconnected);
  assert.equal(snapshot.message, null);
  assert.equal(snapshot.host, null);
  assert.deepEqual(snapshot.devices, []);
  assert.deepEqual(snapshot.login, { authenticated: false, required: false, kind: null, identifier: null });
});

test('a lost connection has an honest state to sit in while it retries', () => {
  // `connecting` exists so a dropped socket is not forced into `failed`: that is the
  // difference between "DSH is gone until you press reconnect" and "DSH is coming back".
  const status = new HostStatus();
  status.setState('connecting', '与 Cindy relay 的连接已断开，1s 后自动重连（第 1 次）');
  const snapshot = status.snapshot();
  assert.equal(snapshot.state, 'connecting');
  assert.equal(snapshot.stateLabel, '正在重连');
  assert.match(snapshot.message, /自动重连/);
});

test('rejects a state outside the vocabulary', () => {
  const status = new HostStatus();
  assert.throws(() => status.setState('paired'), /Unknown Cindy host state/);
});

test('classifies phone platforms', () => {
  assert.equal(isMobilePlatform('android'), true);
  assert.equal(isMobilePlatform('ios'), true);
  assert.equal(isMobilePlatform('win32'), false);
  assert.equal(isMobilePlatform(null), false);
});

test('keeps the host identity out of the device list and orders phones first', () => {
  const status = new HostStatus();
  status.setHost({ deviceId: 'dev-host', userId: 'user-1', protocolVersion: 1 });
  status.upsertDevice('dev-host', { name: 'DSH Host' });
  status.upsertDevice('desktop-2', { name: 'Workstation', platform: 'win32', online: true });
  status.upsertDevice('phone-1', { name: 'Pixel', platform: 'android', online: false });
  const devices = status.snapshot().devices;
  assert.deepEqual(devices.map((device) => device.deviceId), ['phone-1', 'desktop-2']);
});

test('merges device patches instead of dropping known fields', () => {
  const status = new HostStatus();
  status.upsertDevice('phone-1', { name: 'Pixel', platform: 'android', online: true });
  status.upsertDevice('phone-1', { isController: true });
  const device = status.snapshot().devices[0];
  assert.equal(device.name, 'Pixel');
  assert.equal(device.platform, 'android');
  assert.equal(device.online, true);
  assert.equal(device.isController, true);
});

test('derives connected from a linked controller and waiting from the relay alone', () => {
  const status = new HostStatus();
  status.setState('waiting');
  // No relay identity yet: a stray controller does not make a connection.
  status.refreshConnectionState();
  assert.equal(status.snapshot().state, 'waiting');

  status.setHost({ deviceId: 'dev-host' });
  status.setState('waiting');
  status.upsertDevice('phone-1', { isController: true });
  status.refreshConnectionState();
  assert.equal(status.snapshot().state, 'connected');

  status.upsertDevice('phone-1', { isController: false });
  status.refreshConnectionState();
  assert.equal(status.snapshot().state, 'waiting');
});

test('never lets a late frame repaint a failure or a switch-off', () => {
  const status = new HostStatus();
  status.setHost({ deviceId: 'dev-host' });
  status.setState('failed', 'boom');
  status.upsertDevice('phone-1', { isController: true });
  status.refreshConnectionState();
  assert.equal(status.snapshot().state, 'failed');
  assert.equal(status.snapshot().message, 'boom');

  status.setState('disconnected');
  status.refreshConnectionState();
  assert.equal(status.snapshot().state, 'disconnected');
});

test('snapshots are copies the caller may serialize and mutate', () => {
  const status = new HostStatus();
  status.upsertDevice('phone-1', { name: 'Pixel' });
  const snapshot = status.snapshot();
  snapshot.devices[0].name = 'mutated';
  snapshot.login.authenticated = true;
  assert.equal(status.snapshot().devices[0].name, 'Pixel');
  assert.equal(status.snapshot().login.authenticated, false);
});

test('notifies subscribers only when the snapshot actually changed', () => {
  const status = new HostStatus();
  let calls = 0;
  const off = status.subscribe(() => {
    calls += 1;
  });
  status.setState('authenticating');
  assert.equal(calls, 1);
  status.setState('authenticating');
  assert.equal(calls, 1, 'a repeated identical state must not wake the card');
  status.setState('waiting');
  assert.equal(calls, 2);
  off();
  status.setState('connected');
  assert.equal(calls, 2);
});

test('a throwing subscriber cannot corrupt the Host status', () => {
  const status = new HostStatus();
  status.subscribe(() => {
    throw new Error('observer exploded');
  });
  status.setState('waiting');
  assert.equal(status.snapshot().state, 'waiting');
});

test('reset returns the whole snapshot to the switch-off shape', () => {
  const status = new HostStatus({ now: steppingClock() });
  status.setHost({ deviceId: 'dev-host' });
  status.setState('connected');
  status.setLogin({ authenticated: true, kind: 'phone', identifier: '138' });
  status.upsertDevice('phone-1', { name: 'Pixel', isController: true });
  status.reset();
  const snapshot = status.snapshot();
  assert.equal(snapshot.state, 'disconnected');
  assert.equal(snapshot.host, null);
  assert.deepEqual(snapshot.devices, []);
  assert.equal(snapshot.login.authenticated, false);
  assert.equal(status.ownDeviceId, null);
});

test('clearDevices empties the ledger without touching the connection state', () => {
  const status = new HostStatus();
  status.setHost({ deviceId: 'dev-host' });
  status.setState('connected');
  status.upsertDevice('phone-1', { isController: true });
  status.clearDevices();
  assert.deepEqual(status.snapshot().devices, []);
  assert.equal(status.snapshot().state, 'connected');
  assert.equal(status.hasLinkedController, false);
});
