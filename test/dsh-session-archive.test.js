import test from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { createDshSessionArchive, NATIVE_PIN_MEMBERSHIP_AT } from '../src/dsh-session-archive.js';
import { buildDshSource, capabilityProvider } from '../src/dsh-plugin.js';
import { startHost } from '../src/host.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const OFF = { transportEnabled: false, remoteControlEnabled: false, controllers: {} };

function fixture(initialArchive = [], initialFlags = {}, initialPins = []) {
  const listeners = new Map();
  const state = { archivedSessionIds: [...initialArchive], pinnedSessionIds: [...initialPins] };
  const calls = [];
  const running = new Set();
  let writeError;
  let flags = structuredClone(initialFlags);
  const known = ['one', 'two'];
  function on(event, listener) {
    const group = listeners.get(event) ?? new Set(); group.add(listener); listeners.set(event, group);
    return () => group.delete(listener);
  }
  function emit(change) { for (const listener of listeners.get('domain/changed') ?? []) listener(change); }
  const committed = () => emit({ domain: 'workspace', table: '', operation: 'put', value: structuredClone(state) });
  const registry = {
    get archivedSessionIds() { return state.archivedSessionIds; },
    get pinnedSessionIds() { return state.pinnedSessionIds; },
    async pinSession(id) {
      calls.push(['pin', id]);
      if (writeError) throw writeError;
      if (!known.includes(id)) throw Object.assign(new Error('unknown session'), { name: 'WorkspaceUnknownSessionError' });
      if (state.archivedSessionIds.includes(id)) throw Object.assign(new Error('archived session cannot be pinned'), { name: 'WorkspaceArchivedSessionPinError' });
      state.pinnedSessionIds = [id, ...state.pinnedSessionIds.filter(item => item !== id)]; committed();
    },
    async unpinSession(id) {
      calls.push(['unpin', id]);
      if (writeError) throw writeError;
      state.pinnedSessionIds = state.pinnedSessionIds.filter(item => item !== id); committed();
    },
    async archiveSession(...args) {
      calls.push(['archive', ...args]);
      const [id] = args;
      if (writeError) throw writeError;
      if (state.archivedSessionIds.includes(id)) return;
      if (!known.includes(id)) throw Object.assign(new Error('unknown session'), { name: 'WorkspaceUnknownSessionError' });
      if (running.has(id)) throw Object.assign(new Error('session is active'), { name: 'WorkspaceActiveSessionError' });
      state.archivedSessionIds.push(id);
      state.pinnedSessionIds = state.pinnedSessionIds.filter(item => item !== id); committed();
    },
    async unarchiveSession(...args) {
      calls.push(['unarchive', ...args]);
      if (writeError) throw writeError;
      state.archivedSessionIds = state.archivedSessionIds.filter(id => id !== args[0]); committed();
    },
  };
  let supplied = registry;
  const archive = createDshSessionArchive({ getRegistry: () => supplied, subscribe: on });
  const rows = () => known.map(id => ({ id, title: 'Task ' + id, running: running.has(id), createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }));
  const source = { archive, listSessions: async () => rows(), getSession: async id => rows().find(row => row.id === id),
    listSessionStates: async () => rows(), onEvent: () => () => {} };
  async function start(options = {}) {
    return startHost(source, { ...OFF, sessionFlags: flags }, { persistSessionFlags: async value => { flags = structuredClone(value); }, ...options });
  }
  return { archive, source, registry, calls, state, on, emit, committed, running, start,
    getFlags: () => flags, setError: value => { writeError = value; }, setRegistry: value => { supplied = value; },
    external(ids) { state.archivedSessionIds = [...ids]; committed(); },
    externalPins(ids) { state.pinnedSessionIds = [...ids]; committed(); },
    listenerCount: () => listeners.get('domain/changed')?.size ?? 0 };
}
async function invoke(host, channel, args = []) {
  const result = await host.invokeForTest(channel, args);
  assert.equal(result.ok, true, result.error);
  return result.reply.payload;
}
async function result(host, channel, args) {
  const reply = await invoke(host, channel, args);
  assert.equal(reply.ok, true, reply.error?.message);
  return reply.result;
}
const patch = (host, id, value) => invoke(host, 'local-db:sessions:patch-meta', [id, value]);

test('native registry archive is idempotent, persistent, and never sends stopActivity', async () => {
  const f = fixture();
  await f.archive.setArchived('one', true);
  await f.archive.setArchived('one', true);
  assert.deepEqual(f.state.archivedSessionIds, ['one']);
  assert.deepEqual(f.calls, [['archive', 'one'], ['archive', 'one']]);
  const restarted = createDshSessionArchive({ getRegistry: () => f.registry });
  assert.equal(restarted.isArchived('one'), true);
  await restarted.setArchived('one', false);
  await restarted.setArchived('one', false);
  assert.equal(f.archive.isArchived('one'), false);
  assert.deepEqual(f.calls.at(-1), ['unarchive', 'one']);
});

test('native service injection is optional, activates late, and is forwarded without creating a shadow API', async () => {
  const f = fixture();
  const injections = new Map();
  const services = { sessionController: { list: async () => ({ items: [] }) } };
  const ctx = { get: name => services[name], on: f.on, inject(names, callback) { injections.set(names.join(','), callback); return () => {}; } };
  const seam = buildDshSource(ctx, 'sessionController');
  assert.equal(seam.source.archive, seam.sessionArchive);
  assert.equal(capabilityProvider(seam).sessionArchive, seam.sessionArchive);
  await assert.rejects(seam.sessionArchive.setArchived('one', true), { refusalCode: 'NOT_AVAILABLE' });
  services.workspaceRegistry = f.registry;
  const dispose = injections.get('workspaceRegistry')(ctx);
  await seam.sessionArchive.setArchived('one', true);
  assert.equal(seam.sessionArchive.isArchived('one'), true);
  dispose();
  assert.equal(seam.sessionArchive.isArchived('one'), null);
});

test('Cindy metadata archives and restores native DSH state, not local archive flags', async () => {
  const f = fixture([], { one: { pinnedAt: '2026-01-01T00:00:00Z' } });
  let host = await f.start();
  try {
    await result(host, 'local-db:sessions:list', [100, 'active']); // warm the page
    const archived = await patch(host, 'one', { status: 'archived', pinnedAt: null });
    assert.equal(archived.ok, true);
    assert.equal(archived.result.status, 'archived');
    assert.equal(archived.result.pinnedAt, null);
    assert.deepEqual(f.state.archivedSessionIds, ['one']);
    assert.deepEqual(f.getFlags(), {}, 'no new archived shadow state is saved');
    assert.deepEqual((await result(host, 'local-db:sessions:list', [100, 'active'])).map(row => row.id), ['two']);
    assert.deepEqual((await result(host, 'local-db:sessions:list', [100, 'archived'])).map(row => row.id), ['one']);
    await host.stop(); host = await f.start();
    assert.equal((await result(host, 'local-db:sessions:get', ['one'])).status, 'archived');
    const restored = await patch(host, 'one', { status: 'active' });
    assert.equal(restored.result.status, 'active');
    assert.deepEqual(f.state.archivedSessionIds, []);
    assert.deepEqual((await result(host, 'local-db:sessions:list', [100, 'active'])).map(row => row.id), ['one', 'two']);
  } finally { await host.stop(); }
});

test('active, missing and failed native writes cannot become successful local hides', async () => {
  const f = fixture(); const host = await f.start();
  try {
    f.running.add('one');
    const active = await patch(host, 'one', { status: 'archived', pinnedAt: null });
    assert.equal(active.ok, false); assert.equal(active.error.code, 'NOT_AVAILABLE');
    assert.equal((await result(host, 'local-db:sessions:get', ['one'])).status, 'active');
    const missing = await patch(host, 'absent', { status: 'archived' });
    assert.equal(missing.error.code, 'NOT_FOUND');
    f.setError(new Error('native persistence failed'));
    const failed = await host.invokeForTest('local-db:sessions:patch-meta', ['one', { status: 'archived' }]);
    assert.equal(failed.ok, false); assert.match(failed.error, /native persistence failed/);
    f.setError(undefined); f.setRegistry(undefined);
    assert.equal((await patch(host, 'one', { status: 'archived' })).error.code, 'NOT_AVAILABLE');
    assert.deepEqual(f.state.archivedSessionIds, []); assert.deepEqual(f.getFlags(), {});
  } finally { await host.stop(); }
});

test('unknown legacy archives survive upgrade until explicitly restored, and deletes remain local', async () => {
  const f = fixture([], { one: { status: 'archived' }, two: { status: 'archived' } });
  const host = await f.start();
  try {
    assert.deepEqual((await result(host, 'local-db:sessions:list', [100, 'active'])), []);
    assert.deepEqual(f.calls, [], 'reading legacy flags must not bulk archive DSH sessions');
    assert.equal((await patch(host, 'one', { status: 'active' })).result.status, 'active');
    assert.deepEqual(f.getFlags(), { two: { status: 'archived' } });
    await patch(host, 'one', { status: 'deleted' });
    assert.deepEqual(f.state.archivedSessionIds, []);
    f.external(['one']); await tick();
    assert.equal((await result(host, 'local-db:sessions:get', ['one'])).status, 'deleted');
  } finally { await host.stop(); }
});

test('native desktop commits invalidate warm lists, patch linked controllers, and hide activity', async () => {
  const f = fixture([], { one: { pinnedAt: '2026-01-01T00:00:00Z' } });
  const host = await f.start();
  try {
    await result(host, 'local-db:sessions:list', [100, 'active']);
    const before = host.getPushLog().length;
    f.running.add('one'); f.external(['one']); await tick();
    assert.deepEqual((await result(host, 'local-db:sessions:list', [100, 'active'])).map(row => row.id), ['two']);
    assert.deepEqual(await result(host, 'maker:list-active'), []);
    assert.equal((await result(host, 'local-db:sessions:get', ['one'])).pinnedAt, null);
    assert.ok(host.getPushLog().slice(before).some(entry => entry.channel === 'local-db:sessions:patched'));
    assert.deepEqual(f.getFlags(), {}, 'a desktop archive retires the old Host pin');
    f.external([]); await tick();
    assert.equal((await result(host, 'local-db:sessions:get', ['one'])).status, 'active');
    assert.deepEqual((await result(host, 'maker:list-active')).map(row => row.sessionId), ['one']);
    assert.equal(f.listenerCount(), 1);
    await host.setSource(undefined); assert.equal(f.listenerCount(), 0);
    await host.setSource(f.source); assert.equal(f.listenerCount(), 1);
  } finally { await host.stop(); }
  assert.equal(f.listenerCount(), 0);
});

test('malformed archive metadata is rejected before any native mutation', async () => {
  const f = fixture(); const host = await f.start();
  try {
    assert.equal((await patch(host, 'one', { status: 'archived', pinnedAt: 7 })).error.code, 'BAD_REQUEST');
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.state.archivedSessionIds, []);
  } finally { await host.stop(); }
});

test('native commit notifications ignore unrelated changes and dispose cleanly', async () => {
  const f = fixture(); const changes = [];
  const dispose = f.archive.onChange(ids => changes.push(ids));
  f.emit({ domain: 'other', table: '', operation: 'put' });
  f.emit({ domain: 'workspace', table: 'workspaces', operation: 'put' });
  f.emit({ domain: 'workspace', table: '', operation: 'deleted' });
  f.committed();
  assert.deepEqual(changes, []);
  f.external(['one']); f.external(['one']); f.external([]);
  assert.deepEqual(changes, [['one'], ['one']]);
  dispose(); f.external(['two']);
  assert.deepEqual(changes, [['one'], ['one']]);
});

test('a source replacement cannot turn a queued native archive into a local-only hide', async () => {
  const f = fixture(); const host = await f.start();
  try {
    const pending = host.invokeForTest('local-db:sessions:patch-meta', ['one', { status: 'archived' }]);
    await host.setSource(undefined);
    const reply = await pending;
    assert.equal(reply.reply.payload.ok, false);
    assert.equal(reply.reply.payload.error.code, 'NOT_AVAILABLE');
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.getFlags(), {});
  } finally { await host.stop(); }
});

test('committed desktop archive updates are multicast only to linked row watchers', async () => {
  const f = fixture(); const sent = [];
  const socket = Object.assign(new EventEmitter(), { readyState: 1, send(value) { sent.push(JSON.parse(value)); }, close() {} });
  const host = await startHost(f.source, { ...OFF, transportEnabled: true, remoteControlEnabled: true, controllers: { phone: {state:'authorized'}, 'desktop-controller': {state:'authorized'} } }, {
    resolveSession: async () => ({ ok: true, session: { deviceId: 'host' } }),
    openSocket: () => socket, heartbeatMs: 0, listDevices: async () => ({ devices: [] }),
  });
  try {
    socket.emit('message', JSON.stringify({v:1,kind:'hello-ack',payload:{deviceId:'host',userId:'u',serverProtocolVersion:1}}));
    for (const peer of ['phone','desktop-controller']) {
      socket.emit('message', JSON.stringify({v:1,kind:'invoke',id:`subscribe-${peer}`,src:peer,payload:{channel:'device-link:subscribe',args:[{topics:['sessions']}]}}));
    }
    await tick();
    f.external(['one']); await tick();
    const patches = sent.filter(frame => frame.kind === 'push' && frame.payload.channel === 'local-db:sessions:patched');
    assert.deepEqual(patches.map(frame => frame.dst).sort(), ['desktop-controller', 'phone']);
    for (const frame of patches) {
      assert.equal(frame.payload.payload.sessionId, 'one');
      assert.equal(frame.payload.payload.patch.status, 'archived');
      assert.equal(frame.payload.payload.patch.pinnedAt, null);
    }
  } finally { await host.stop(); }
});

test('native pin retries preserve original order and unpin is idempotent', async () => {
  const f = fixture([], {}, ['two']);
  await f.archive.setPinned('one', true);
  await f.archive.setPinned('one', true);
  assert.deepEqual(f.state.pinnedSessionIds, ['one', 'two']);
  assert.deepEqual(f.calls, [['pin', 'one']]);
  await f.archive.setPinned('one', false);
  await f.archive.setPinned('one', false);
  assert.deepEqual(f.calls, [['pin', 'one'], ['unpin', 'one']]);
  assert.equal(f.archive.isPinned('one'), false);
});

test('Cindy pin writes native membership and retires only its own legacy overlay', async () => {
  const f = fixture([], { one: { pinnedAt: '2026-01-01T00:00:00Z' }, two: { pinnedAt: '2026-02-01T00:00:00Z' } });
  let host = await f.start();
  try {
    assert.deepEqual(f.calls, [], 'old overlays must never be auto-migrated into native pins');
    const pinned = await patch(host, 'one', { pinnedAt: '2026-11-03T12:00:00Z' });
    assert.equal(pinned.ok, true);
    assert.equal(pinned.result.pinnedAt, NATIVE_PIN_MEMBERSHIP_AT);
    assert.deepEqual(f.state.pinnedSessionIds, ['one']);
    assert.deepEqual(f.getFlags(), { two: { pinnedAt: '2026-02-01T00:00:00Z' } });
    await host.stop(); host = await f.start();
    assert.equal((await result(host, 'local-db:sessions:get', ['one'])).pinnedAt, NATIVE_PIN_MEMBERSHIP_AT);
    assert.equal((await patch(host, 'one', { pinnedAt: null })).result.pinnedAt, null);
    assert.deepEqual(f.state.pinnedSessionIds, []);
    assert.deepEqual(f.getFlags(), { two: { pinnedAt: '2026-02-01T00:00:00Z' } });
  } finally { await host.stop(); }
});

test('desktop native pin and unpin refresh warm lists and clear stale local pins', async () => {
  const f = fixture([], { one: { pinnedAt: '2026-01-01T00:00:00Z' } }); const host = await f.start();
  try {
    await result(host, 'local-db:sessions:list', [100, 'active']);
    const before = host.getPushLog().length;
    f.externalPins(['one']); await tick();
    assert.equal((await result(host, 'local-db:sessions:get', ['one'])).pinnedAt, NATIVE_PIN_MEMBERSHIP_AT);
    assert.deepEqual(f.getFlags(), {});
    f.externalPins([]); await tick();
    assert.equal((await result(host, 'local-db:sessions:get', ['one'])).pinnedAt, null);
    assert.equal((await result(host, 'local-db:sessions:list', [100, 'active']))[0].pinnedAt, null);
    assert.ok(host.getPushLog().slice(before).filter(entry => entry.channel === 'local-db:sessions:patched').length >= 2);
  } finally { await host.stop(); }
});

test('native archive clears native pin and never leaves a local pin shadow', async () => {
  const f = fixture([], {}, ['one']); const host = await f.start();
  try {
    const reply = await patch(host, 'one', { status: 'archived', pinnedAt: null });
    assert.equal(reply.ok, true);
    assert.equal(reply.result.status, 'archived'); assert.equal(reply.result.pinnedAt, null);
    assert.deepEqual(f.state.pinnedSessionIds, []);
    assert.deepEqual(f.getFlags(), {});
    assert.equal((await patch(host, 'one', { status: 'active' })).result.pinnedAt, null);
  } finally { await host.stop(); }
});

test('invalid mixed and hidden-session pins reject before every native write', async () => {
  const f = fixture(['one']); const host = await f.start();
  try {
    for (const value of ['yesterday', 7, {}, '2026-99-99T00:00:00Z']) {
      assert.equal((await patch(host, 'two', { pinnedAt: value })).error.code, 'BAD_REQUEST');
    }
    for (const status of ['archived', 'active', 'deleted']) {
      assert.equal((await patch(host, 'two', { status, pinnedAt: '2026-11-03T00:00:00Z' })).error.code, 'BAD_REQUEST');
    }
    assert.equal((await patch(host, 'one', { pinnedAt: '2026-11-03T00:00:00Z' })).error.code, 'BAD_REQUEST');
    await patch(host, 'two', { status: 'deleted' });
    assert.equal((await patch(host, 'two', { pinnedAt: '2026-11-03T00:00:00Z' })).error.code, 'BAD_REQUEST');
    assert.equal((await patch(host, 'not-visible', { pinnedAt: '2026-11-03T00:00:00Z' })).error.code, 'NOT_FOUND');
    assert.deepEqual(f.calls, []);
  } finally { await host.stop(); }
});

test('missing native pin API and persistence failure never fall back to local-only success', async () => {
  const f = fixture(); const host = await f.start();
  try {
    f.setRegistry(undefined);
    assert.equal((await patch(host, 'one', { pinnedAt: '2026-11-03T00:00:00Z' })).error.code, 'NOT_AVAILABLE');
    f.setRegistry({ archivedSessionIds: [], pinnedSessionIds: [] });
    assert.equal((await patch(host, 'one', { pinnedAt: null })).error.code, 'NOT_AVAILABLE');
    f.setRegistry(f.registry); f.setError(new Error('native pin persistence failed'));
    const failed = await host.invokeForTest('local-db:sessions:patch-meta', ['one', { pinnedAt: '2026-11-03T00:00:00Z' }]);
    assert.equal(failed.ok, false); assert.match(failed.error, /native pin persistence failed/);
    assert.deepEqual(f.state.pinnedSessionIds, []); assert.deepEqual(f.getFlags(), {});
  } finally { await host.stop(); }
});

test('native pin order changes invalidate while the membership sentinel remains stable', async () => {
  const f = fixture([], {}, ['one', 'two']); const seen = [];
  const dispose = f.archive.onChange((ids, change) => seen.push({ ids, change }));
  const host = await f.start();
  try {
    const before = await result(host, 'local-db:sessions:get', ['one']);
    f.externalPins(['two', 'one']); await tick();
    assert.deepEqual(new Set(seen[0].ids), new Set(['one', 'two']));
    assert.equal((await result(host, 'local-db:sessions:get', ['one'])).pinnedAt, before.pinnedAt);
    assert.deepEqual(f.calls, []);
  } finally { dispose(); await host.stop(); }
});

test('mixed rename and pin or status changes reject before native rename', async () => {
  const f = fixture(); let renames = 0;
  const host = await f.start({ resolveCapabilities: () => ({ renameSession: async () => { renames++; } }) });
  try {
    for (const fields of [{ pinnedAt: '2026-11-03T00:00:00Z' }, { status: 'archived' }, { pinnedAt: null }, { status: 'unsupported' }]) {
      assert.equal((await patch(host, 'one', { title: 'Changed', ...fields })).error.code, 'BAD_REQUEST');
    }
    assert.equal(renames, 0); assert.deepEqual(f.calls, []); assert.deepEqual(f.getFlags(), {});
  } finally { await host.stop(); }
});
