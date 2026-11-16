import test from 'node:test';
import assert from 'node:assert/strict';
import { startHost } from '../src/host.js';
import { FixtureDshSource } from '../src/fixture-source.js';
import { groupHistoryItems } from '../src/host-history-view.js';

const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };
const thinking = text => ({ id: 'live:thought', clientId: 'live:thought', role: 'thinking',
  content: { text, isStreaming: true }, agentMeta: { isStreaming: true }, createdAt: '2026-11-15T00:00:00.000Z' });
const text = body => ({ id: 'live:text', clientId: 'live:text', role: 'assistant', content: body,
  agentMeta: { isStreaming: true }, createdAt: '2026-11-15T00:00:00.000Z' });
const page = rows => ({ version: 1, items: groupHistoryItems(rows.filter(row => row.role === 'thinking'),
  { chronological: true, running: true, workLines: true }), hasMore: false, nextCursor: null });

async function harness() {
  const handlers = new Map(); const sent = []; const timers = new Set(); const watches = [];
  let rows = [thinking('开头')]; let read = async () => ({ ok: true, result: page(rows) });
  let fail = () => false; let reads = 0; let request = 0; let clock = 1000;
  const liveAssistant = {
    watch(sessionId, onChange, signal) {
      const watch = { sessionId, onChange, signal, disposed: false }; watches.push(watch);
      onChange({ rows, immediate: true, historyChanged: true, revision: 1 });
      return () => { watch.disposed = true; };
    }, snapshot: () => rows,
  };
  const historyView = { page: async (...args) => { reads++; return read(...args); },
    details: async () => ({ ok: false, code: 'NOT_FOUND' }), intent: () => { throw new Error('shared intent must not run'); } };
  const socket = { readyState: 1, on: (name, fn) => handlers.set(name, fn), close() {},
    send(serialized) { const frame = JSON.parse(serialized); if (fail(frame)) throw new Error('send failed'); sent.push(frame); } };
  const runtime = await startHost(new FixtureDshSource(), { transportEnabled: true, remoteControlEnabled: true, controllers: {} }, {
    resolveSession: async () => ({ ok: true, session: { deviceId: 'host' } }), openSocket: () => socket, heartbeatMs: 0,
    now: () => new Date(clock), resolveCapabilities: () => ({ liveAssistant, historyView }),
    setTimeout: (fn, ms) => { const timer = { ms, fn: () => { timers.delete(timer); fn(); } }; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer),
  });
  const frame = value => handlers.get('message')(Buffer.from(JSON.stringify({ v: 1, ...value })));
  handlers.get('open')(); frame({ kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'host', userId: 'owner' } });
  async function invoke(src, channel, args) {
    const id = 'r' + request++; frame({ kind: 'invoke', id, src, payload: { channel, args } }); await settle(); return id;
  }
  const subscribe = src => invoke(src, 'device-link:subscribe', [{ topics: ['session:s1'] }]);
  const latest = (src, workLines = true) => invoke(src, 'local-db:messages:view', ['s1', { workLines }]);
  const emit = (next, options = {}) => {
    rows = next;
    for (const watch of watches.filter(value => !value.disposed)) watch.onChange({ rows, immediate: false, historyChanged: true, ...options });
  };
  async function run(ms = 50) {
    for (const timer of [...timers]) if (timer.ms === ms) timer.fn();
    await settle();
  }
  const pushes = (channel, dst) => sent.filter(frame => frame.kind === 'push' && frame.payload.channel === channel && (!dst || frame.dst === dst));
  return { runtime, sent, timers, watches, frame, invoke, subscribe, latest, emit, run, pushes, historyView, liveAssistant,
    reopen: (userId = 'owner') => { handlers.get('open')(); frame({ kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'host', userId } }); },
    read: fn => { read = fn; }, fail: fn => { fail = fn; }, reads: () => reads, resetReads: () => { reads = 0; },
    clear: () => { sent.length = 0; }, advance: ms => { clock += ms; } };
}

test('old-attempt chunks and retirement barriers cannot erase retry progress; newer output clears it', async () => {
  const h = await harness();
  const maker = () => h.pushes('maker:event', 'a').map(frame => frame.payload.payload.event);
  try {
    await h.subscribe('a');
    h.runtime.pushTurnRunning('s1', { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } });
    h.emit([text('旧请求部分输出')], { immediate: true, attempt: { turn: 1, step: 1, startedAfterSeq: 0 } });
    h.runtime.pushSessionDiagnostic('s1', { type: 'llm/retry', seq: 1, time: 2000,
      data: { turn: 1, step: 1, retryId: 'r1', retry: 1, maxRetries: 3, delayMs: 1000, mode: 'normal', failure: { code: 'TRANSPORT' } } });
    h.clear();
    h.emit([text('旧请求部分输出迟到片段')], { immediate: true, attempt: { turn: 1, step: 1, startedAfterSeq: 0 } });
    assert.equal(maker().at(-1).data.message, 'Reconnecting... 1/3', 'queued old content is not new request progress');
    h.clear(); h.emit([], { immediate: true, reason: 'abandoned' });
    assert.equal(maker()[0].type, 'text', 'preserve the existing mobile delta consumption barrier');
    assert.equal(maker().at(-1).data.message, 'Reconnecting... 1/3', 'restore retry after retirement text clears the mobile field');
    h.runtime.pushSessionDiagnostic('s1', { type: 'llm/retry-started', seq: 2, time: 3000, data: { turn: 1, step: 1, retryId: 'r1', retry: 1 } });
    h.clear();
    h.emit([{ ...text('恢复输出'), id: 'live:new', clientId: 'live:new' }], { immediate: true, attempt: { turn: 1, step: 1, startedAfterSeq: 2 } });
    assert.equal(maker()[0].type, 'status');
    assert.equal(maker().some(event => event.type === 'error'), false);
  } finally { await h.runtime.stop(); }
});

test('native first content is immediate, one session source serves two phones and text never folds with ready history', async () => {
  const h = await harness();
  try {
    await h.subscribe('a'); await h.subscribe('b');
    assert.equal(h.watches.length, 1);
    await h.latest('a'); await h.latest('b'); await h.run();
    h.clear(); h.resetReads();
    h.emit([thinking('开头实时'), text('中文正文')], { immediate: true }); await settle();
    assert.equal(h.pushes('maker:event').filter(frame => frame.payload.payload.event.type === 'text').length, 2);
    assert.equal(h.pushes('local-db:messages:created').length, 0);
    assert.equal(h.reads(), 1, 'one candidate shared across controllers');
    assert.equal(h.pushes('maker:history-work-patch').length, 2);
    assert.equal(h.pushes('maker:history-view-changed').length, 0, 'a patch does not carry a duplicate notice');
    h.clear(); h.resetReads();
    h.emit([thinking('开头实时'), text('中文正文第二片')], { historyChanged: false });
    assert.equal(h.pushes('maker:event').length, 0);
    assert.ok([...h.timers].some(timer => timer.ms === 50));
    assert.equal([...h.timers].some(timer => timer.ms === 1000), false);
    await h.run();
    assert.deepEqual(h.pushes('maker:event').map(frame => frame.payload.payload.event.data), [
      { text: '第二片', isFinal: false }, { text: '第二片', isFinal: false },
    ]);
    assert.equal(h.reads(), 0, 'text-only deltas never project a history page');
  } finally { await h.runtime.stop(); }
});

test('unnegotiated controller gets a notice; failed patch sends do not advance its accepted base', async () => {
  const h = await harness();
  try {
    await h.subscribe('a'); await h.subscribe('b'); await h.subscribe('legacy');
    await h.latest('a'); await h.latest('b'); await h.latest('legacy', false); await h.run();
    const base = page([thinking('开头')]).items[0].summary.revision;
    h.clear(); h.resetReads();
    h.fail(frame => frame.kind === 'push' && frame.dst === 'a' && frame.payload.channel === 'maker:history-work-patch');
    h.emit([thinking('开头第二片')]); await h.run();
    assert.equal(h.reads(), 1);
    assert.deepEqual(h.pushes('maker:history-work-patch').map(frame => frame.dst), ['b']);
    assert.deepEqual(h.pushes('maker:history-view-changed').map(frame => frame.dst), ['legacy']);
    h.fail(() => false); h.clear();
    h.emit([thinking('开头第三片')]); await h.run();
    assert.equal(h.pushes('maker:history-work-patch', 'a')[0].payload.payload.baseRevision, base);
    assert.notEqual(h.pushes('maker:history-work-patch', 'b')[0].payload.payload.baseRevision, base);
  } finally { await h.runtime.stop(); }
});

test('new latest page, unsubscribe and lease renewal fence a slow candidate', async () => {
  const h = await harness();
  try {
    await h.subscribe('a'); await h.subscribe('b'); await h.latest('a'); await h.latest('b'); await h.run();
    let release;
    const stale = page([thinking('开头旧候选')]);
    h.read(() => new Promise(resolve => { release = resolve; }));
    h.emit([thinking('开头旧候选')]); await h.run();
    assert.equal(typeof release, 'function');
    h.read(async () => ({ ok: true, result: stale }));
    await h.latest('a');
    await h.invoke('b', 'device-link:unsubscribe', [{ topics: ['session:s1'] }]);
    await h.subscribe('b');
    h.clear(); release({ ok: true, result: stale }); await settle();
    assert.equal(h.pushes('maker:history-work-patch').length, 0);
    assert.equal(h.pushes('maker:history-view-changed').length, 0, 'old receipts cannot invalidate the new delivery either');
  } finally { await h.runtime.stop(); }
});

test('retirement and structural notification bypass an outstanding candidate; last watcher aborts', async () => {
  const h = await harness();
  try {
    await h.subscribe('a'); await h.latest('a'); await h.run();
    // A body row is delivered independently of the history page.
    h.emit([thinking('开头'), text('临时正文')], { immediate: true, historyChanged: false });
    let release; h.read(() => new Promise(resolve => { release = resolve; }));
    h.emit([thinking('开头正在生成'), text('临时正文')]); await h.run();
    h.clear(); h.emit([], { immediate: true });
    assert.equal(h.pushes('local-db:messages:deleted', 'a').length, 1);
    assert.equal(h.pushes('maker:history-view-changed', 'a').length, 1, 'terminal does not wait for the page read');
    release({ ok: true, result: page([thinking('开头正在生成')]) }); await settle();
    assert.equal(h.pushes('maker:history-work-patch').length, 0);
    await h.invoke('a', 'device-link:unsubscribe', [{ topics: ['session:s1'] }]);
    assert.equal(h.watches[0].signal.aborted, true);
    assert.equal(h.watches[0].disposed, true);
    h.clear(); h.watches[0].onChange({ rows: [text('late')], immediate: true, historyChanged: true });
    await h.run(); assert.equal(h.sent.length, 0);
  } finally { await h.runtime.stop(); }
});

test('expanded detail intent is per controller and sends bounded trailing notices, not patches plus notices', async () => {
  const h = await harness();
  try {
    await h.subscribe('expanded'); await h.subscribe('collapsed');
    await h.latest('expanded'); await h.latest('collapsed'); await h.run();
    const key = page([thinking('开头')]).items[0].key;
    await h.invoke('expanded', 'local-db:messages:view-intent', ['s1', [{ key }]]);
    h.clear(); h.emit([thinking('开头详情一')]); await h.run();
    assert.equal(h.pushes('maker:history-view-changed', 'expanded').length, 1);
    assert.equal(h.pushes('maker:history-work-patch', 'expanded').length, 0);
    assert.equal(h.pushes('maker:history-work-patch', 'collapsed').length, 1);
    h.clear(); h.advance(100); h.emit([thinking('开头详情二')]); await h.run();
    assert.equal(h.pushes('maker:history-view-changed', 'expanded').length, 0);
    const trailing = [...h.timers].find(timer => timer.ms === 400);
    assert.ok(trailing, 'a stopped stream retains one trailing detail refresh');
    h.advance(400); trailing.fn(); await settle();
    assert.equal(h.pushes('maker:history-view-changed', 'expanded').length, 1);
  } finally { await h.runtime.stop(); }
});

test('authorization, hidden session and connection teardown suppress all native pushes and abort the source', async () => {
  const h = await harness();
  try {
    await h.subscribe('a'); await h.latest('a'); await h.run();
    await h.runtime.updateSettings({ transportEnabled: true, remoteControlEnabled: true, controllers: { a: { state: 'revoked' } } });
    assert.equal(h.watches[0].signal.aborted, true);
    h.clear(); h.watches[0].onChange({ rows: [], immediate: true, historyChanged: true }); await h.run();
    assert.equal(h.sent.length, 0);
    await h.runtime.updateSettings({ transportEnabled: true, remoteControlEnabled: true, controllers: {} });
    assert.equal(h.watches.length, 2);
    await h.runtime.updateSettings({ transportEnabled: true, remoteControlEnabled: true, controllers: {}, sessionFlags: { s1: { status: 'archived' } } });
    assert.equal(h.watches[1].signal.aborted, true);
    h.clear(); h.watches[1].onChange({ rows: [text('secret')], immediate: true }); await h.run();
    assert.equal(h.sent.length, 0);
  } finally { await h.runtime.stop(); }
});

test('full text repairs allow 256KiB intact and larger prefixes degrade once to observable waiting-durable', async () => {
  const h = await harness();
  try {
    await h.subscribe('a'); await h.run(); h.clear();
    const prefix = '中'.repeat(30_000); // 90KiB: larger than the old raw-thinking budget.
    h.emit([text(prefix)], { historyChanged: false, immediate: true });
    const payload = h.pushes('maker:event', 'a').find(frame => frame.payload.payload.event.type === 'text').payload.payload;
    assert.equal(payload.event.data.text, prefix);
    assert.equal(payload.event.data.isFullText, true);
    h.clear();
    h.emit([{ ...text('中'.repeat(100_000)), id: 'live:huge', clientId: 'live:huge' }], { historyChanged: false, immediate: true });
    assert.equal(h.pushes('maker:event').filter(frame => frame.payload.payload.persistId === 'live:huge').length, 0, 'no truncated prefix masquerades as full text');
    assert.equal(h.pushes('maker:history-view-changed').length, 1);
    assert.deepEqual(h.runtime.getStatus().liveAssistant, [{ sessionId: 's1', oversizedRepairs: 1, waitingDurable: 1 }]);
    h.clear(); h.emit([{ ...text('中'.repeat(100_001)), id: 'live:huge', clientId: 'live:huge' }], { historyChanged: false }); await h.run();
    assert.equal(h.pushes('maker:history-view-changed').length, 0, 'degraded block does not spam notices every batch');
    h.emit([], { immediate: true });
    assert.equal(h.runtime.getStatus().liveAssistant[0].waitingDurable, 0);
  } finally { await h.runtime.stop(); }
});

test('raw thinking block-end corrects isStreaming even when the body text is unchanged', async () => {
  const h = await harness();
  try {
    await h.subscribe('a'); await h.run(); h.clear();
    const final = thinking('开头'); final.content.isStreaming = false;
    h.emit([final], { immediate: true });
    assert.equal(h.pushes('local-db:messages:created', 'a').length, 1);
    assert.equal(h.pushes('local-db:messages:created', 'a')[0].payload.payload.message.content.isStreaming, false);
  } finally { await h.runtime.stop(); }
});

test('a pending native watch cannot block subscription ACK and source replacement fences late callbacks', async () => {
  const h = await harness();
  try {
    let signal; h.liveAssistant.watch = (_sessionId, _onChange, value) => { signal = value; return new Promise(() => {}); };
    const id = await h.subscribe('a');
    assert.ok(h.sent.some(frame => frame.kind === 'invoke-result' && frame.id === id && frame.payload.ok));
    const oldSignal = signal;
    await h.runtime.setSource(new FixtureDshSource());
    assert.equal(oldSignal.aborted, true);
    assert.notEqual(signal, oldSignal);
    assert.equal(signal.aborted, false, 'the replacement source owns a fresh watch signal');
    await h.runtime.updateSettings({ transportEnabled: false, remoteControlEnabled: false, controllers: {} });
    assert.equal(signal.aborted, true);
    assert.equal([...h.timers].some(timer => timer.ms === 50), false);
  } finally { await h.runtime.stop(); }
});

test('raw thinking observes 32KiB/s and 64KiB burst, retains a complete trailing prefix and retires without tokens', async () => {
  const h = await harness();
  try {
    await h.subscribe('a'); await h.run(); h.clear();
    h.emit([thinking('中'.repeat(19_000))], { immediate: true });
    assert.equal(h.pushes('local-db:messages:created').length, 1);
    h.clear(); h.emit([thinking('中'.repeat(19_001))]); await h.run();
    assert.equal(h.pushes('local-db:messages:created').length, 0, 'second complete snapshot is rate limited');
    const trailing = [...h.timers].find(timer => timer.ms > 50 && timer.ms < 3000);
    assert.ok(trailing);
    h.advance(trailing.ms); trailing.fn(); await settle();
    assert.equal(h.pushes('local-db:messages:created')[0].payload.payload.message.content.text, '中'.repeat(19_001));
    h.clear(); h.emit([], { immediate: true });
    assert.equal(h.pushes('local-db:messages:deleted').length, 1, 'retirement does not spend raw-body tokens');
  } finally { await h.runtime.stop(); }
});

test('nonfinal full-prefix barrier flushes a simulated mobile 32ms delta batch before deletion; failure retains retirement', async () => {
  const h = await harness();
  try {
    await h.subscribe('a'); await h.run(); h.clear();
    h.emit([text('首片')], { immediate: true, historyChanged: false });
    h.emit([text('首片第二片')], { historyChanged: false }); await h.run();
    h.emit([], { immediate: true });
    const frames = h.sent.filter(frame => frame.kind === 'push');
    // Mirrors mobile applyMakerEvent: deltas enqueue; non-deltas flush all queued text; removeMessages alone does not flush.
    function consume(input) {
      const messages = new Map(); let pending = [];
      const flush32ms = () => { for (const [id, value] of pending) messages.set(id, (messages.get(id) ?? '') + value); pending = []; };
      for (const frame of input) {
        const value = frame.payload.payload;
        if (frame.payload.channel === 'maker:event' && value.event.type === 'text') {
          const data = value.event.data;
          if (!data.isFullText && !data.isFinal) pending.push([value.persistId, data.text]);
          else { flush32ms(); messages.set(value.persistId, data.text); }
        } else if (frame.payload.channel === 'local-db:messages:deleted') for (const id of value.clientIds) messages.delete(id);
      }
      flush32ms(); return messages;
    }
    assert.equal(consume(frames).has('live:text'), false);
    const barriers = frames.filter(frame => frame.payload.channel === 'maker:event' && frame.payload.payload.event.data.isFullText);
    assert.equal(barriers.length, 2, 'initial full baseline plus retirement flush barrier');
    assert.equal(barriers[1].payload.payload.event.data.text, '首片第二片');
    assert.equal(barriers[1].payload.payload.event.data.isFinal, false);
    const unsafe = frames.filter(frame => frame !== barriers[1]);
    assert.equal(consume(unsafe).has('live:text'), true, 'the fixture reproduces the real pending-batch resurrection without a barrier');
    h.emit([text('新临时内容')], { immediate: true, historyChanged: false }); h.clear();
    h.fail(frame => frame.kind === 'push' && frame.payload.channel === 'maker:event' && frame.payload.payload.event.data?.isFullText);
    h.emit([], { immediate: true });
    assert.equal(h.pushes('local-db:messages:deleted').length, 0, 'failed barrier cannot advance retirement');
    h.fail(() => false); h.clear(); h.emit([], { immediate: true });
    assert.equal(h.pushes('local-db:messages:deleted').length, 1, 'a retained receipt retries the same retirement');
  } finally { await h.runtime.stop(); }
});

test('reconnect retires old live ids before a new baseline and never replays receipts across accounts', async () => {
  for (const owner of ['owner', 'different-account']) {
    const h = await harness();
    try {
      await h.subscribe('a'); h.emit([text('旧账户公开前缀')], { immediate: true, historyChanged: false });
      await h.runtime.updateSettings({ transportEnabled: false, remoteControlEnabled: false, controllers: {} });
      h.emit([]); // The attempt settled while no follow/controller link existed.
      await h.runtime.updateSettings({ transportEnabled: true, remoteControlEnabled: true, controllers: {} }); h.reopen(owner);
      h.clear(); await h.subscribe('a'); await h.run();
      const oldTextFrames = h.pushes('maker:event').filter(frame => frame.payload.payload.persistId === 'live:text');
      assert.equal(oldTextFrames.length, owner === 'owner' ? 1 : 0);
      const removals = h.pushes('local-db:messages:deleted').flatMap(frame => frame.payload.payload.clientIds);
      assert.equal(removals.includes('live:text'), owner === 'owner');
    } finally { await h.runtime.stop(); }
  }
});

test('workLines options reach the reader and an oversized fitted error cannot establish an accepted patch base', async () => {
  const h = await harness();
  try {
    await h.subscribe('a'); await h.run();
    const huge = page([thinking('开头')]); huge.items[0].summary.padding = '中'.repeat(750_000);
    h.read(async (sessionId, before, options) => {
      assert.equal(sessionId, 's1'); assert.equal(before, undefined); assert.deepEqual(options, { workLines: true });
      return { ok: true, result: huge };
    });
    const id = await h.latest('a');
    const reply = h.sent.find(frame => frame.kind === 'invoke-result' && frame.id === id);
    assert.equal(reply.payload.ok, false);
    assert.equal(reply.payload.error.code, 'PAYLOAD_TOO_LARGE');
    h.read(async () => ({ ok: true, result: page([thinking('开头后续')]) }));
    h.clear(); h.emit([thinking('开头后续')]); await h.run();
    assert.equal(h.pushes('maker:history-work-patch').length, 0);
    assert.equal(h.pushes('local-db:messages:created', 'a').length, 1, 'a failed fitted page keeps raw thinking enabled');
    assert.equal(h.pushes('maker:history-view-changed', 'a').length, 1);
  } finally { await h.runtime.stop(); }
});
