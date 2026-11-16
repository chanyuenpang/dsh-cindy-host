import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeAssistantSource } from '../src/native-assistant-source.js';
import { createHistoryProjection } from '../src/history-snapshot.js';
import { foldSessionEvent } from '../src/dsh-message-fold.js';
import { appendReadonlyRows } from '../src/readonly-row-suffix.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const baseline = (activeAttempt, revision = 0) => ({ type: 'snapshot', assistantStream: { revision, ...(activeAttempt ? { activeAttempt } : {}) } });
function harness(options = {}) {
  const opens = []; const changes = []; const errors = [];
  const source = createNativeAssistantSource({
    follow: (sessionId, signal) => {
      const queued = []; let wake;
      const channel = { sessionId, signal, push(value) { queued.push(value); wake?.(); wake = null; } };
      opens.push(channel);
      return (async function* () {
        while (!signal.aborted) {
          if (!queued.length) await new Promise(resolve => {
            const done = () => { signal.removeEventListener('abort', done); resolve(); };
            wake = done; signal.addEventListener('abort', done, { once: true });
          });
          if (signal.aborted) return;
          yield queued.shift();
        }
      })();
    }, onError: error => errors.push(error.code), ...options,
  });
  const abort = new AbortController();
  const dispose = source.watch('s', change => changes.push(change), abort.signal);
  let revision = 0, index = 0;
  const push = frame => opens.at(-1).push({ type: 'assistant-stream', frame });
  return { source, opens, changes, errors, abort, dispose,
    open: async (active, rev = 0) => { await tick(); opens.at(-1).push(baseline(active, rev)); await tick(); revision = rev; },
    start: async (id = 'a', turn = 1) => { index = 0; push({ type: 'start', revision: ++revision, attemptId: id, turn, step: 1, startedAfterSeq: 0 }); await tick(); },
    chunk: async (text, kind = 'reasoning', id = 'a') => { push({ type: 'chunk', revision: ++revision, attemptId: id, index: index++, time: 1000,
      chunk: { type: kind === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: kind === 'reasoning' ? 0 : 1, text } }); await tick(); },
    end: async (outcome, id = 'a') => { push({ type: 'end', revision: ++revision, attemptId: id, index, outcome }); await tick(); },
    push,
  };
}
const final = (seq = 5, type = 'assistant/message') => ({ type, seq, time: 2000, surfaceOp: 'append', data: { turn: 1, step: 1,
  message: { id: 'answer', role: 'assistant', content: [{ type: 'reasoning', text: '中文' }, { type: 'text', text: '答复' }] } } });

test('native reasoning and text arrive before any durable settlement; two watchers share one passive source', async () => {
  const h = harness();
  try {
    await h.open(); await h.start(); await h.chunk('中文'); await h.chunk('答复', 'text');
    assert.equal(h.opens.length, 1);
    assert.deepEqual(h.changes.at(-1).rows.map(row => row.role), ['thinking', 'assistant']);
    assert.equal(h.changes[0].immediate, true);
    assert.equal(h.changes.at(-1).historyChanged, false);
    assert.deepEqual(h.changes.at(-1).attempt, { turn: 1, step: 1, startedAfterSeq: 0 });
    const other = new AbortController(); const received = [];
    h.source.watch('s', value => received.push(value), other.signal);
    assert.equal(received[0].rows[0].content.text, '中文');
    assert.deepEqual(received[0].attempt, { turn: 1, step: 1, startedAfterSeq: 0 });
    h.dispose(); assert.equal(h.opens[0].signal.aborted, false);
    other.abort(); assert.equal(h.opens[0].signal.aborted, true);
  } finally { h.source.stop(); }
});

test('official compact baseline restores a complete prefix and dense nextIndex, not compact record count', async () => {
  const h = harness();
  try {
    await h.open({ attemptId: 'a', turn: 1, step: 1, startedAfterSeq: 0, nextIndex: 3,
      stream: [{ type: 'reasoning-chunks', index: 0, time0: 1000, dt: [1, 1], texts: ['中', '文', '前缀'] }] }, 4);
    assert.equal(h.source.snapshot('s')[0].content.text, '中文前缀');
    h.push({ type: 'chunk', attemptId: 'a', revision: 5, index: 3, time: 1003, chunk: { type: 'reasoning-delta', index: 0, text: '继续' } });
    await tick();
    assert.equal(h.source.snapshot('s')[0].content.text, '中文前缀继续');
    assert.deepEqual(h.errors, []);
  } finally { h.source.stop(); }
});

for (const first of ['durable', 'end']) test('exact committed type+seq join retires live content, order=' + first, async () => {
  const h = harness();
  try {
    await h.open(); await h.start(); await h.chunk('中文');
    const id = h.source.snapshot('s')[0].id;
    const event = final(); const ending = { kind: 'committed', eventType: event.type, seq: event.seq };
    if (first === 'durable') { h.source.noteEvent('s', event); assert.equal(h.source.snapshot('s').length, 1); await h.end(ending); }
    else { await h.end(ending); assert.equal(h.source.snapshot('s').length, 1); h.source.noteEvent('s', event); }
    assert.deepEqual(h.source.snapshot('s'), []);
    const history = createHistoryProjection('s'); history.consume(event, foldSessionEvent(event, { sessionId: 's' }));
    const snapshot = h.source.overlay('s', history.snapshot());
    assert.equal(snapshot.resolve(id), 0);
    assert.equal(snapshot.rows[0].content.text, '中文');
    assert.equal(h.changes.at(-1).immediate, true);
  } finally { h.source.stop(); }
});

test('failed attempts, retry and abandoned content never concatenate or fabricate terminal maker events', async () => {
  const h = harness();
  try {
    await h.open(); await h.start(); await h.chunk('失败'); const previous = h.source.snapshot('s')[0].clientId;
    h.source.noteEvent('s', final(3, 'assistant/attempt'));
    await h.end({ kind: 'committed', eventType: 'assistant/attempt', seq: 3 });
    await h.start('b'); await h.chunk('新尝试', 'reasoning', 'b');
    assert.notEqual(h.source.snapshot('s')[0].clientId, previous);
    assert.equal(h.source.snapshot('s')[0].content.text, '新尝试');
    await h.end({ kind: 'abandoned' }, 'b');
    assert.deepEqual(h.source.snapshot('s'), []);
    assert.equal(h.changes.some(change => 'event' in change), false);
  } finally { h.source.stop(); }
});

test('duplicate frames are ignored; gaps trigger one bounded repair lease and old output cannot return', async () => {
  const timers = [];
  const h = harness({ schedule: fn => { timers.push(fn); return fn; }, cancel: () => {} });
  try {
    await h.open(); await h.start(); await h.chunk('中');
    h.push({ type: 'chunk', attemptId: 'a', revision: 2, index: 0, time: 1000, chunk: { type: 'reasoning-delta', index: 0, text: 'duplicate' } });
    await tick(); assert.equal(h.source.snapshot('s')[0].content.text, '中');
    h.push({ type: 'chunk', attemptId: 'a', revision: 5, index: 3, time: 1000, chunk: { type: 'reasoning-delta', index: 0, text: 'gap' } });
    await tick(); assert.deepEqual(h.source.snapshot('s'), []); assert.equal(timers.length, 1);
    timers.shift()(); await tick();
    assert.equal(h.opens.length, 2); assert.equal(h.opens[0].signal.aborted, true);
    h.opens[1].push(baseline()); await tick();
    assert.equal(h.source.stats().gaps, 1);
  } finally { h.source.stop(); }
});

test('turn terminal fences queued old chunks and oversized bodies retire honestly without dropping the source', async () => {
  const h = harness({ maxBytes: 6 });
  try {
    await h.open(); await h.start(); await h.chunk('中文'); await h.chunk('超限');
    assert.deepEqual(h.source.snapshot('s'), []);
    assert.equal(h.source.stats().limited, 1);
    await h.chunk('后续'); assert.equal(h.source.stats().errors, 0);
    h.source.noteEvent('s', { type: 'turn/end', seq: 8, data: { turn: 1 } });
    await h.end({ kind: 'abandoned' });
    assert.deepEqual(h.source.snapshot('s'), []);
  } finally { h.source.stop(); }
});

test('private protocol blocks never cross the public projection, unsupported follow is explicit and not retried forever', async () => {
  const h = harness();
  try {
    await h.open(); await h.start();
    h.push({ type: 'chunk', attemptId: 'a', revision: 2, index: 0, time: 1000,
      chunk: { type: 'finish', replayState: { text: 'secret' }, signature: 'private' } });
    await tick(); assert.deepEqual(h.source.snapshot('s'), []); assert.doesNotMatch(JSON.stringify(h.changes), /secret|private/);
  } finally { h.source.stop(); }
  const missing = harness();
  try {
    await tick(); missing.opens[0].push({ type: 'snapshot' }); await tick();
    assert.equal(missing.source.supported('s'), false);
    assert.equal(missing.source.stats().unsupported, 1);
    assert.equal(missing.opens.length, 1);
  } finally { missing.source.stop(); }
});

test('terminal observed before slow opening baseline cannot resurrect that active attempt', async () => {
  const h = harness();
  try {
    h.source.noteEvent('s', { type: 'turn/end', seq: 5, data: { turn: 1 } });
    await h.open({ attemptId: 'a', turn: 1, step: 1, startedAfterSeq: 0, nextIndex: 1,
      stream: [{ type: 'reasoning-chunks', index: 0, time0: 1000, dt: [], texts: ['already terminal'] }] }, 2);
    assert.deepEqual(h.source.snapshot('s'), []);
    assert.equal(h.changes.length, 0);
  } finally { h.source.stop(); }
});

test('terminal between durable commit and queued native end preserves exact alias without retaining the body', async () => {
  const h = harness();
  try {
    await h.open(); await h.start(); await h.chunk('中文');
    const id = h.source.snapshot('s')[0].id;
    const event = final();
    h.source.noteEvent('s', event);
    h.source.noteEvent('s', { type: 'turn/end', seq: 6, data: { turn: 1 } });
    assert.deepEqual(h.source.snapshot('s'), []);
    assert.equal(h.source.stats().liveBytes, 0);
    await h.end({ kind: 'committed', eventType: event.type, seq: event.seq });
    const history = createHistoryProjection('s'); history.consume(event, foldSessionEvent(event, { sessionId: 's' }));
    assert.equal(h.source.overlay('s', history.snapshot()).resolve(id), 0);
  } finally { h.source.stop(); }
});

test('prefix Array view preserves snapshots and array contract without reading the sealed prefix for a tail slice', () => {
  let accesses = 0;
  const prefix = new Proxy(Array.from({ length: 100000 }, (_, index) => index), {
    get(target, key, receiver) { if (/^\d+$/.test(String(key))) accesses++; return Reflect.get(target, key, receiver); },
  });
  const rows = appendReadonlyRows(prefix, ['live']);
  assert.equal(Array.isArray(rows), true);
  assert.equal(rows.length, 100001);
  assert.deepEqual(rows.slice(100000), ['live']);
  assert.equal(accesses, 0);
  const small = appendReadonlyRows([1, 2], [3]);
  assert.deepEqual([...small], [1, 2, 3]);
  assert.equal(JSON.stringify(small), '[1,2,3]');
  assert.deepEqual(Object.keys(small), ['0', '1', '2']);
  assert.throws(() => small.push(4), /read-only/);
  assert.throws(() => { delete small[0]; }, /read-only/);
});

test('oversized compact replay is bounded before decoding, without inventing a complete prefix', async () => {
  let decoded = false;
  const h = harness({ maxBytes: 6, decode: () => { decoded = true; throw Error('must not decode oversized replay'); } });
  try {
    await h.open({ attemptId: 'a', turn: 1, step: 1, startedAfterSeq: 0, nextIndex: 1,
      stream: [{ type: 'reasoning-chunks', index: 0, time0: 1000, dt: [], texts: ['中文超限'] }] }, 2);
    assert.equal(decoded, false);
    assert.deepEqual(h.source.snapshot('s'), []);
    assert.equal(h.source.stats().limited, 1);
    assert.equal(h.source.stats().errors, 0);
  } finally { h.source.stop(); }
});

test('opening records supply an exact settlement already covered by the follow cursor', async () => {
  const h = harness();
  try {
    await tick();
    const opening = baseline({ attemptId: 'a', turn: 1, step: 1, startedAfterSeq: 0, nextIndex: 1,
      stream: [{ type: 'reasoning-chunks', index: 0, time0: 1000, dt: [], texts: ['中文'] }] }, 2);
    const event = final();
    h.opens[0].push({ ...opening, records: [{ type: 'event', event }] }); await tick();
    const id = h.source.snapshot('s')[0].id;
    h.push({ type: 'end', attemptId: 'a', revision: 3, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 5 } });
    await tick();
    assert.deepEqual(h.source.snapshot('s'), []);
    const history = createHistoryProjection('s'); history.consume(event, foldSessionEvent(event, { sessionId: 's' }));
    assert.equal(h.source.overlay('s', history.snapshot()).resolve(id), 0);
  } finally { h.source.stop(); }
});
