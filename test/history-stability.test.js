import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageReader } from '../src/dsh-message-fold.js';
import { createHistoryViewController, WORK_PREVIEW_BYTES } from '../src/host-history-view.js';
import { createDshInputDeliveryBackend } from '../src/dsh-input-delivery.js';

const delta = (seq, text, index = 0) => ({ type: 'assistant/chunk', seq, time: 1000,
  data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index, text } } });
const final = (seq) => ({ type: 'assistant/message', seq, time: 1000, surfaceOp: 'append',
  data: { turn: 1, step: 1, message: { id: 'answer', role: 'assistant', content: [
    { type: 'reasoning', text: 'THINK' }, { type: 'text', text: 'ANSWER' },
  ] } } });
const viewFor = (reader, options = {}) => createHistoryViewController({
  snapshot: reader.historySnapshot, sessionRunning: () => true, ...options,
});

test('real cold and live readers preserve block order in history pages and details at equal timestamps', async () => {
  const events = [delta(0, 'THINK')];
  const live = createMessageReader({ readSessionLog: async () => ({ events: [...events] }) });
  await live.all('s');
  events.push(final(1));
  live.noteEvent('s', events[1]);
  const cold = createMessageReader({ readSessionLog: async () => ({ events: [...events] }) });
  for (const reader of [live, cold]) {
    const view = viewFor(reader);
    const page = await view.page('s');
    assert.equal(page.ok, true);
    assert.deepEqual(page.result.items.map(item => item.type), ['work', 'messages']);
    const work = page.result.items[0].summary;
    assert.equal(work.isStreaming, false, 'an answer seals the preceding activity even if the task is still running');
    const detail = await view.details('s', work);
    assert.deepEqual(detail.result.messages.map(row => row.content.text), ['THINK']);
    assert.equal(page.result.items[1].messages[0].content, 'ANSWER');
  }
});

test('growing multi-block reasoning retains its first work anchor and source order', async () => {
  const events = [delta(0, 'A', 0)];
  const reader = createMessageReader({ readSessionLog: async () => ({ events: [...events] }) });
  const view = viewFor(reader);
  const initial = (await view.page('s')).result.items[0].summary;
  const next = delta(1, 'B', 1);
  events.push(next); reader.noteEvent('s', next);
  const current = (await view.page('s')).result.items[0].summary;
  assert.equal(current.key, initial.key);
  assert.equal(current.firstMessageId, initial.firstMessageId);
  const detail = await view.details('s', current);
  assert.deepEqual(detail.result.messages.map(row => row.content.text), ['A', 'B']);
});

test('a retired temporary before cursor never silently skips intermediate history', async () => {
  const row = (id, role = 'user') => ({ id, clientId: id, sessionId: 's', role,
    content: role === 'thinking' ? { text: id } : id, createdAt: new Date(1000).toISOString() });
  let rows = [row('temporary', 'thinking'), row('u3'), row('u2'), row('u1')];
  const view = createHistoryViewController({ rows: async () => rows, pageItems: 1 });
  const before = (await view.page('s')).result.nextCursor;
  rows = [row('final', 'thinking'), row('u3'), row('u2'), row('u1')];
  const older = await view.page('s', before);
  if (older.ok) {
    assert.deepEqual(older.result.items.map(item => item.key), ['u3']);
    assert.equal(older.result.hasMore, true);
  } else {
    assert.ok(['NOT_FOUND', 'BAD_REQUEST'].includes(older.code), 'an unknown reference must be an explicit retryable range failure');
  }
});

function source(events, mounted) {
  let flushes = 0;
  const services = { sessions: { get: () => ({}), flush: async () => { flushes++; return true; } },
    persistence: { open: async () => ({ read: async () => ({ events: [...events] }), close: async () => {} }) } };
  const backend = createDshInputDeliveryBackend({ getServices: () => services });
  const reader = createMessageReader({ readSessionLog: async () => ({ events: [...events] }) });
  const snapshot = mounted ? sid => backend.historySnapshot(sid) : reader.historySnapshot;
  return { reader, snapshot, raw: mounted ? sid => backend.readRows(sid) : reader.all, flushes: () => flushes };
}
const user = seq => ({ type: 'user/message', seq, time: 2000 - seq, surfaceOp: 'append',
  data: { id: 'u' + seq, role: 'user', source: { kind: 'user', rpcId: 'u' + seq }, content: [{ type: 'text', text: 'u' + seq }] } });

for (const mounted of [false, true]) test('source snapshot preserves live references across durable replay; backend mounted=' + mounted, async () => {
  const events = [user(0), user(1), user(2), delta(3, 'THINK')];
  const s = source(events, mounted);
  const view = createHistoryViewController({ snapshot: s.snapshot, sessionRunning: () => true, pageItems: 1 });
  const initial = (await view.page('s')).result;
  const ref = initial.items[0].summary;
  assert.match(ref.firstMessageId, /^history-live:/);
  const rawLive = await s.raw('s');
  assert.equal(rawLive[0].content.text, 'THINK', 'raw fallback sees the full current public prefix too');
  assert.equal(rawLive[0].id, ref.firstMessageId);
  events.push(final(4));
  if (!mounted) s.reader.noteEvent('s', events[4]);
  const detail = await view.details('s', ref);
  assert.equal(detail.ok, true);
  assert.equal(detail.result.messages[0].clientId, ref.firstMessageId.slice(13), 'the unmodified native alias matcher recognizes the durable row');
  assert.equal(detail.result.messages[0].content.text, 'THINK');
  const older = await view.page('s', initial.nextCursor);
  assert.equal(older.result.items[0].messages[0].content, 'u2');
  assert.equal(older.result.hasMore, true);
  const again = await view.page('s', initial.nextCursor);
  assert.deepEqual(again, older);
  // Eviction/replay must not depend on an in-memory alias memo.
  s.reader.invalidate('s');
  assert.equal((await view.details('s', ref)).ok, true);
  assert.deepEqual((await s.raw('s')).slice(0, 2).map(row => row.role), mounted ? ['assistant', 'thinking'] : ['thinking', 'assistant'], 'each raw source preserves its pre-existing message/block order');
  const complete = (await view.page('s')).result.items;
  assert.equal(complete[0].messages[0].content, 'ANSWER');
  assert.equal((await view.page('s', 'other:reasoning-stream:1:1:0')).code, 'NOT_FOUND');
  if (mounted) assert.ok(s.flushes() > 0, 'the history path still flushes and validates persistent evidence');
});

for (const mounted of [false, true]) test('cancelled live references keep their source cut but never resurrect text; backend mounted=' + mounted, async () => {
  const events = [user(0), user(1), delta(2, 'cancelled')];
  const s = source(events, mounted);
  const view = createHistoryViewController({ snapshot: s.snapshot, sessionRunning: () => true, pageItems: 1 });
  const initial = (await view.page('s')).result;
  const end = { type: 'step/end', seq: 3, time: 3000, data: { turn: 1, step: 1 } };
  events.push(end); if (!mounted) s.reader.noteEvent('s', end);
  const older = await view.page('s', initial.nextCursor);
  assert.equal(older.ok, true);
  assert.equal(older.result.items[0].messages[0].content, 'u1');
  assert.equal((await view.details('s', initial.items[0].summary)).code, 'NOT_FOUND');
  s.reader.invalidate('s');
  assert.deepEqual(await view.page('s', initial.nextCursor), older);
});

test('source cuts inside regrouped work keep every older row reachable across the 40-row boundary', async () => {
  const rows = Array.from({ length: 85 }, (_, index) => ({ id: 'r' + index, clientId: 'r' + index,
    role: 'thinking', content: { text: 'r' + index }, createdAt: new Date(1000).toISOString() }));
  const view = createHistoryViewController({ rows: async () => [...rows].reverse(), pageItems: 1 });
  let before = 'r73'; const found = [];
  while (true) {
    const page = await view.page('s', before); assert.equal(page.ok, true);
    for (const item of page.result.items) {
      const detail = await view.details('s', item.summary); found.unshift(...detail.result.messages.map(row => row.id));
    }
    if (!page.result.hasMore) break;
    assert.notEqual(page.result.nextCursor, before); before = page.result.nextCursor;
  }
  assert.deepEqual(found, rows.slice(0, 73).map(row => row.id));
});

test('huge reasoning has no automatic full-body preview but explicit details remain complete', async () => {
  const events = [delta(0, '字'.repeat(WORK_PREVIEW_BYTES))];
  const s = source(events, false); const view = createHistoryViewController({ snapshot: s.snapshot, sessionRunning: () => true });
  const work = (await view.page('s')).result.items[0].summary;
  assert.equal(work.preview, undefined);
  assert.equal((await view.details('s', work)).result.messages[0].content.text, events[0].data.chunk.text);
});

test('validated backend still rejects corrupt prefixes and failed flushes on the history path', async () => {
  const events = [user(5)];
  await assert.rejects(() => source(events, true).snapshot('s'), /contiguous/);
  const backend = createDshInputDeliveryBackend({ getServices: () => ({ sessions: { get: () => ({}), flush: async () => false }, persistence: { open() { throw new Error('must not read'); } } }) });
  await assert.rejects(() => backend.historySnapshot('s'), /durability/);
});
