import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionControllerSource } from '../src/dsh-session-source.js';
import { createChannelRouter } from '../src/cindy-channels.js';
import { buildDshSource } from '../src/dsh-plugin.js';
import { startHost } from '../src/host.js';

const at = 1_790_774_329_425;
const summary = (id, extra = {}) => ({ sessionId: id, cwd: 'G:/project', blank: false, createdAt: at, updatedAt: at, ...extra });
const invoke = (router, channel, args = []) => router({ v: 1, kind: 'invoke', id: 'req', src: 'phone', payload: { channel, args } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function makeSeam() {
  const records = new Map();
  let disposed = 0;
  let error;
  const query = {
    async observeSession(id, options) {
      assert.equal(options.projectionMode, 'all');
      if (error) throw error;
      const record = records.get(id);
      if (!record) throw Object.assign(new Error('missing'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' });
      return { header: { id, createdAt: at, cwd: 'G:/project', ...record.header }, events: [],
        projections: { values: { sessionListMetadata: { blank: true }, ...record.values } },
        [Symbol.dispose]() { disposed++; } };
    },
    async readSession(id) {
      if (!records.has(id)) throw new Error('missing transcript');
      return { events: [] };
    },
  };
  const controller = {
    list: async () => ({ items: [...records.keys()].map(id => summary(id, { blank: true })) }),
    create: async ({ sessionId }) => { records.set(sessionId, {}); return { sessionId }; },
  };
  const services = { sessionController: controller, sessionQuery: query };
  const seam = buildDshSource({ get: name => services[name], on: () => () => {}, inject: () => () => {} }, 'sessionController');
  return { seam, records, controller, disposed: () => disposed, setError: value => { error = value; } };
}

test('known blank ID reads bypass discovery filtering and retain applied model metadata', async () => {
  const blank = summary('new', { blank: true, projections: { values: { modelSelection: {
    next: { provider: 'openai-codex', model: 'gpt-test', reasoningEffort: 'high' },
  }, permissions: { currentValue: 'read-only' } } } });
  const items = [blank, summary('visible'), summary('child', { origin: 'subagent' }), summary('nested', { parentSessionId: 'visible' })];
  const source = createSessionControllerSource({ sessionController: { list: async () => ({ items }) } });
  assert.deepEqual((await source.listSessions()).map(row => row.id), ['visible']);
  const row = await source.getSession('new');
  assert.equal(row.id, 'new');
  assert.equal(row.blank, true);
  assert.equal(row.model, 'gpt-test');
  assert.equal(row.providerId, 'openai-codex');
  assert.equal(row.effort, 'high');
  assert.equal(row.permissionMode, 'read-only');
  assert.equal(await source.getSession('child'), undefined);
  assert.equal(await source.getSession('nested'), undefined);
  assert.equal(await source.getSession('missing'), undefined);
  assert.deepEqual((await source.listSessions()).map(row => row.id), ['visible'], 'direct reads never publish all drafts');
});

test('blank identity reads do not cache an absent title past the first prompt', async () => {
  let blank = true;
  let title;
  const source = createSessionControllerSource({
    sessionController: { list: async () => ({ items: [summary('new', { blank })] }) },
    readTitles: async () => new Map([['new', title]]),
  });
  assert.equal((await source.getSession('new')).title, undefined);
  blank = false;
  title = 'First prompt title';
  assert.equal((await source.listSessions())[0].title, title);
});

test('exact observation uses the same activity timestamp floor as the Host list', async () => {
  const f = makeSeam();
  f.records.set('new', { values: { sessionListMetadata: { blank: false, lastPromptAt: at - 1000 } } });
  assert.equal((await f.seam.source.getSession('new')).updatedAt, new Date(at).toISOString());
});

test('create then get/history works before first enqueue using the live observation contract', async () => {
  const f = makeSeam();
  const router = createChannelRouter({ listSessions: () => f.seam.source.listSessions(), getSession: id => f.seam.source.getSession(id),
    subscribers: new Set(), resolveCapabilities: () => f.seam });
  assert.deepEqual((await invoke(router, 'local-db:sessions:list')).payload.result, []);
  const created = await invoke(router, 'maker:create-session', [{ id: 'new', workingDir: 'G:/project' }]);
  assert.equal(created.payload.ok, true);
  assert.equal(created.payload.result.sessionId, 'new');
  const get = await invoke(router, 'local-db:sessions:get', ['new']);
  assert.equal(get.payload.ok, true);
  assert.equal(get.payload.result.id, 'new');
  assert.equal(get.payload.result.workingDir, 'G:/project');
  assert.equal(get.payload.result.createdAt, new Date(at).toISOString());
  assert.deepEqual(get.payload.result._count, { messages: 0 });
  const history = await invoke(router, 'local-db:messages:view', ['new']);
  assert.equal(history.payload.ok, true);
  assert.deepEqual(history.payload.result.items, []);
  assert.deepEqual((await invoke(router, 'local-db:sessions:list')).payload.result, []);
  const missing = await invoke(router, 'local-db:sessions:get', ['unknown']);
  assert.equal(missing.payload.ok, false);
  assert.equal(missing.payload.error.code, 'NOT_FOUND');
  assert.equal(f.disposed(), 1);
});

test('exact observation releases leases and never invents absence for I/O errors', async () => {
  const f = makeSeam();
  f.records.set('child', { header: { origin: 'subagent' } });
  f.records.set('nested', { header: { parentSession: 'parent' } });
  f.records.set('no-cwd', { header: { cwd: undefined } });
  for (const id of ['child', 'nested', 'no-cwd']) assert.equal(await f.seam.source.getSession(id), undefined);
  assert.equal(f.disposed(), 3);
  assert.equal(await f.seam.source.getSession('missing'), undefined);
  f.setError(new Error('disk I/O failed'));
  await assert.rejects(f.seam.source.getSession('new'), /disk I\/O failed/);
});

test('router create fences an old list flight and old completion cannot replace the new cache', async () => {
  const old = deferred();
  let reads = 0;
  const router = createChannelRouter({ subscribers: new Set(),
    listSessions: async () => ++reads === 1 ? old.promise : [{ id: 'new', cwd: 'G:/project' }],
    createSession: async () => ({ sessionId: 'new' }),
  });
  const beforeCreate = invoke(router, 'local-db:sessions:list');
  await tick();
  await invoke(router, 'maker:create-session', [{ id: 'new' }]);
  const afterCreate = invoke(router, 'local-db:sessions:list');
  await tick();
  assert.equal(reads, 2, 'post-create list starts its own read before the old one settles');
  assert.equal((await afterCreate).payload.result[0].id, 'new');
  old.resolve([]);
  await beforeCreate;
  assert.equal((await invoke(router, 'local-db:sessions:list')).payload.result[0].id, 'new');
});

test('source create fences the in-flight list independently of router cache', async () => {
  const f = makeSeam();
  const old = deferred();
  let reads = 0;
  f.controller.list = async () => ++reads === 1 ? old.promise : { items: [summary('new')] };
  const before = f.seam.source.listSessions();
  await tick();
  await f.seam.createSession({ sessionId: 'new' });
  const after = f.seam.source.listSessions();
  await tick();
  assert.equal(reads, 2);
  assert.equal((await after)[0].id, 'new');
  old.resolve({ items: [] });
  await before;
  f.controller.list = async () => { throw new Error('temporarily unavailable'); };
  assert.equal((await f.seam.source.listSessions())[0].id, 'new', 'stale fallback retained the post-create page, not old empty result');
});

test('legacy get retries a missing cached ID instead of proving absence from a warm list', async () => {
  let rows = [];
  const router = createChannelRouter({ listSessions: async () => rows, subscribers: new Set() });
  await invoke(router, 'local-db:sessions:list');
  rows = [{ id: 'external-new' }];
  const get = await invoke(router, 'local-db:sessions:get', ['external-new']);
  assert.equal(get.payload.ok, true);
  assert.equal(get.payload.result.id, 'external-new');
});

test('creation prerequisite subscription does not wait for the entire session corpus', async () => {
  const gate = deferred();
  let listReads = 0;
  let acknowledged = false;
  const router = createChannelRouter({
    listSessions: async () => { listReads++; return gate.promise; }, subscribers: new Set(),
    resolveCapabilities: () => ({ isSessionRunning: () => false, pushTurnIdle() {}, pushTurnRunning() {} }),
  });
  const pending = invoke(router, 'device-link:subscribe', [{ topics: ['sessions'] }]).then(result => { acknowledged = true; return result; });
  await tick();
  const fast = acknowledged;
  gate.resolve([]);
  const result = await pending;
  assert.equal(fast, true, 'the phone must be able to proceed to create without waiting for a cold listing');
  assert.equal(listReads, 0);
  assert.deepEqual(result.payload.result, { subscribed: ['sessions'] });
});

test('session attachment reads only subscribed identities, never the full listing', async () => {
  const seen = [];
  let listReads = 0;
  const router = createChannelRouter({
    listSessions: async () => { listReads++; return []; },
    getSession: async id => { seen.push(['get', id]); return id === 'active' ? { id, running: true } : undefined; },
    subscribers: new Set(),
    resolveCapabilities: () => ({
      isSessionRunning: () => false,
      pushTurnIdle: id => seen.push(['idle', id]), pushTurnRunning: id => seen.push(['running', id]),
      pushInputProjection: id => seen.push(['input', id]), invalidateHistoryView: id => seen.push(['history', id]),
    }),
  });
  const result = await invoke(router, 'device-link:subscribe', [{ topics: ['sessions', 'session:active', 'session:not-created'] }]);
  assert.equal(result.payload.ok, true);
  assert.equal(listReads, 0);
  for (const id of ['active', 'not-created']) {
    assert.ok(seen.some(([kind, value]) => kind === 'get' && value === id));
    assert.ok(seen.some(([kind, value]) => kind === 'input' && value === id));
    assert.ok(seen.some(([kind, value]) => kind === 'history' && value === id));
  }
  assert.ok(seen.some(([kind, id]) => kind === 'running' && id === 'active'));
  assert.ok(seen.some(([kind, id]) => kind === 'idle' && id === 'not-created'));
});

test('failed exact attachment read falls back to current runtime state without a corpus retry', async () => {
  const seen = [];
  let listReads = 0;
  const router = createChannelRouter({ subscribers: new Set(),
    listSessions: async () => { listReads++; return []; },
    getSession: async () => { throw new Error('temporarily unavailable'); },
    resolveCapabilities: () => ({ isSessionRunning: () => true, pushTurnIdle: id => seen.push(['idle', id]), pushTurnRunning: id => seen.push(['running', id]) }),
  });
  assert.equal((await invoke(router, 'device-link:subscribe', [{ topics: ['session:active'] }])).payload.ok, true);
  assert.equal(listReads, 0);
  assert.deepEqual(seen, [['running', 'active']]);
});

class Socket {
  handlers = new Map(); sent = []; readyState = 1;
  on(name, callback) { this.handlers.set(name, callback); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() {}
  emit(name, value) { this.handlers.get(name)?.(value); }
}

test('Host exact lookup applies archived/deleted flags instead of reviving a blank session', async () => {
  const socket = new Socket();
  const source = { listSessions: async () => [], getSession: async id => ({ id, blank: true }), onEvent: () => () => {} };
  const runtime = await startHost(source, { transportEnabled: true, remoteControlEnabled: true, controllers: {},
    sessionFlags: { new: { status: 'deleted', pinnedAt: '2026-09-30T00:00:00Z' } } }, {
    resolveSession: async () => ({ ok: true, session: { deviceId: 'host' } }), openSocket: () => socket, heartbeatMs: 0,
  });
  try {
    socket.emit('message', Buffer.from(JSON.stringify({ v: 1, kind: 'invoke', id: 'read', src: 'phone', payload: { channel: 'local-db:sessions:get', args: ['new'] } })));
    await tick();
    const reply = socket.sent.find(frame => frame.id === 'read');
    assert.equal(reply.payload.ok, true);
    assert.equal(reply.payload.result.status, 'deleted');
    assert.equal(reply.payload.result.pinnedAt, '2026-09-30T00:00:00Z');
  } finally { await runtime.stop(); }
});
