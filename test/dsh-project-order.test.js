import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshProjectOrder, projectOrderKey } from '../src/dsh-project-order.js';
import { createChannelRouter } from '../src/cindy-channels.js';
import { startHost } from '../src/host.js';
import { FixtureDshSource } from '../src/fixture-source.js';
function fixture(paths = ['/a', '/b', '/c', '/d']) {
  let rows = paths.map((path, i) => ({ id: String(i), path })); let owner = { dataOwnerId: 'verified-account-device-source', ownerGeneration: 1 }; const moves = []; const listeners = new Set(); let beforeMove;
  const registry = { list: () => rows }; const controller = { insertBefore: async request => { moves.push(request); if (beforeMove) await beforeMove(request); const moved = rows.find(row => row.id === request.workspaceId); rows = rows.filter(row => row !== moved); const index = rows.findIndex(row => row.id === request.beforeWorkspaceId); rows.splice(index < 0 ? rows.length : index, 0, moved); for (const fn of listeners) fn(); return { workspaceIds: rows.map(row => row.id) }; } };
  const port = createDshProjectOrder({ getRegistry: () => registry, getController: () => controller, getOwner: () => owner, subscribeChanged: fn => { listeners.add(fn); return () => listeners.delete(fn); } });
  const request = keys => ({ manualProjectOrder: keys, projectOrder: 'custom', ...owner });
  return { port, moves, listeners, request, rows: () => rows, replace: value => { rows = value; }, setOwner: value => { owner = value; }, before: fn => { beforeMove = fn; } };
}
test('native registry order is authoritative only with a verified owner and real move API', () => {
  const f = fixture(); assert.deepEqual(f.port.read().manualProjectOrder, ['local:/a', 'local:/b', 'local:/c', 'local:/d']);
  f.setOwner(undefined); assert.equal(f.port.read().available, false); assert.equal(f.port.read().authoritative, false);
});
test('partial custom priority persists actual native order and preserves unrequested relative order', async () => {
  const f = fixture(); const result = await f.port.apply(f.request(['local:/c', 'local:/a']));
  assert.deepEqual(result.manualProjectOrder, ['local:/c', 'local:/a', 'local:/b', 'local:/d']); assert.equal(f.moves.length, 1); assert.deepEqual(f.moves[0], { workspaceId: '2', beforeWorkspaceId: '0' });
});
test('unknown, repeated, cross-device and activity variants are rejected before the first native move', async () => {
  for (const change of [{ manualProjectOrder: ['local:/missing'] }, { manualProjectOrder: ['local:/a', 'local:/a/'] }, { manualProjectOrder: ['device:phone:/a'] }, { projectOrder: 'activity' }, { revision: 1 }]) {
    const f = fixture(); await assert.rejects(f.port.apply({ ...f.request(['local:/b']), ...change })); assert.equal(f.moves.length, 0);
  }
});
test('Windows case/slash keys and worktree grouping map only if a unique registered Workspace exists', async () => {
  const f = fixture(['C:/Project/', 'D:/Other']); const result = await f.port.apply(f.request(['local:D:/OTHER/'])); assert.equal(result.manualProjectOrder[0], 'local:d:/other');
  const ambiguous = fixture(['/repo', '/repo/.worktrees/branch']); assert.throws(() => ambiguous.port.read(), /Ambiguous/); assert.equal(ambiguous.moves.length, 0);
  assert.equal(projectOrderKey('/Case/Path'), 'local:/Case/Path');
});
test('stale account/source owner stamps cannot grant a move', async () => {
  const f = fixture(); const request = f.request(['local:/c']); f.setOwner({ dataOwnerId: 'new-account', ownerGeneration: 2 }); await assert.rejects(f.port.apply(request), /PRECONDITION_FAILED/); assert.equal(f.moves.length, 0);
});
test('a native failure after one move returns the actual partial snapshot without fake rollback', async () => {
  const f = fixture(); f.before(() => { if (f.moves.length === 2) throw Error('native persistence failed'); });
  await assert.rejects(f.port.apply(f.request(['local:/d', 'local:/c', 'local:/b', 'local:/a'])), error => { assert.match(error.message, /PARTIAL_FAILURE/); assert.ok(error.message.includes('local:/d')); assert.match(error.message, /actual=/); return true; });
  assert.equal(f.rows()[0].path, '/d'); assert.equal(f.moves.length, 2);
});
test('desktop concurrent changes are detected after the native move and are not overwritten', async () => {
  const f = fixture(); f.before(() => f.replace([...f.rows()].reverse())); await assert.rejects(f.port.apply(f.request(['local:/c'])), /CONFLICT/); assert.equal(f.moves.length, 1);
});
test('ownership rotation during a committed move stops the sequence and withholds the new-owner snapshot', async () => {
  const f = fixture(); f.before(() => f.setOwner({ dataOwnerId: 'another-account', ownerGeneration: 2 }));
  await assert.rejects(f.port.apply(f.request(['local:/d', 'local:/c'])), error => { assert.match(error.message, /owner changed/); assert.equal(error.message.includes('actual='), false); return true; }); assert.equal(f.moves.length, 1);
});
test('native domain notifications project only real changed order, with source-scoped cleanup', () => {
  const f = fixture(); const events = []; const close = f.port.onChange(snapshot => events.push(snapshot));
  for (const fn of f.listeners) fn(); assert.equal(events.length, 0); f.replace([...f.rows()].reverse()); for (const fn of f.listeners) fn(); assert.equal(events.length, 1); assert.equal(events[0].ownerStamp.ownerGeneration, 1);
  close(); assert.equal(f.listeners.size, 0);
});
test('official get/apply RPCs retain the owner stamp without adding a fake revision field', async () => {
  const f = fixture(); const router = createChannelRouter({ listSessions: async () => [], subscribers: new Set(), resolveCapabilities: () => ({ projectOrder: f.port }) });
  const call = (channel, args) => router({ v: 1, id: channel, src: 'phone', kind: 'invoke', payload: { channel, args } });
  const snapshot = (await call('sidebar-settings:get-project-order', [])).payload.result; assert.equal(snapshot.available, true);
  const result = await call('sidebar-settings:apply-project-order', [{ manualProjectOrder: ['local:/d'], projectOrder: 'custom', ...snapshot.ownerStamp }]); assert.equal(result.payload.result.manualProjectOrder[0], 'local:/d');
});

class OrderSocket {
  handlers = new Map(); sent = []; readyState = 1;
  on(name, fn) { const handlers = this.handlers.get(name) ?? []; handlers.push(fn); this.handlers.set(name, handlers); return this; }
  emit(name, ...args) { for (const fn of this.handlers.get(name) ?? []) fn(...args); }
  send(value) { this.sent.push(JSON.parse(value)); } close() {}
  frame(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}
test('runtime owner is unavailable before authenticated handshake and binds account/device/source generation', async () => {
  const source = new FixtureDshSource(); const socket = new OrderSocket(); let host;
  const registry = { list: () => [{ id: 'workspace', path: '/registered' }] }; const controller = { insertBefore: async () => ({ workspaceIds: ['workspace'] }) };
  const port = createDshProjectOrder({ getRegistry: () => registry, getController: () => controller, getOwner: () => host?.getProjectOrderOwner() }); source.projectOrder = port;
  host = await startHost(source, { transportEnabled: true, remoteControlEnabled: true, controllers: {} }, { resolveSession: async () => ({ ok: true, session: { deviceId: 'host', kind: 'phone', identifier: 'fixture' } }), openSocket: () => socket, heartbeatMs: 0, fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  try {
    assert.equal(port.read().available, false); await host.connect(); socket.emit('open'); assert.equal(port.read().available, false);
    socket.frame({ v: 1, kind: 'hello-ack', payload: { deviceId: 'host', userId: 'verified-account' } });
    const before = port.read(); assert.equal(before.available, true); assert.ok(before.ownerStamp.dataOwnerId.includes('host'));
    const nextSource = new FixtureDshSource(); await host.setSource(nextSource); assert.notEqual(host.getProjectOrderOwner().dataOwnerId, before.ownerStamp.dataOwnerId);
    await host.disconnect(); assert.equal(host.getProjectOrderOwner(), undefined);
  } finally { await host.stop(); }
});

test('oversized native order snapshots refuse before any persistent move', async () => {
  const f = fixture(['/' + 'x'.repeat(300000), '/short']);
  assert.throws(() => f.port.read(), /byte budget/);
  await assert.rejects(f.port.apply(f.request(['local:/short'])), /byte budget/); assert.equal(f.moves.length, 0);
});
