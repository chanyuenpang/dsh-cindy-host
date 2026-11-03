import test from 'node:test';
import assert from 'node:assert/strict';
import { createReasoningStream } from '../src/reasoning-stream.js';
import { createReasoningPublisher } from '../src/reasoning-publisher.js';

const delta = (seq, text, index = 0, step = 1) => ({ type: 'assistant/chunk', seq, time: 1000 + seq, data: { turn: 1, step, chunk: { type: 'reasoning-delta', index, text } } });
function harness() {
  const timers = new Map();
  const frames = [];
  const invalidated = [];
  let watching = true;
  let id = 0;
  const publisher = createReasoningPublisher({
    push: (sessionId, channel, payload) => frames.push({ sessionId, channel, payload }),
    invalidate: sessionId => invalidated.push(sessionId), watched: () => watching,
    setTimeout: callback => { timers.set(++id, callback); return id; },
    clearTimeout: id => timers.delete(id),
  });
  return { publisher, timers, frames, invalidated,
    flush: () => { for (const callback of [...timers.values()]) callback(); },
    unwatch: () => { watching = false; },
  };
}

test('token updates coalesce and upsert one thinking row, then delete before durable completion', () => {
  const h = harness();
  for (let seq = 1; seq <= 100; seq++) h.publisher.noteEvent('s', delta(seq, '字'));
  assert.equal(h.frames.length, 0);
  assert.equal(h.timers.size, 1);
  h.flush();
  assert.equal(h.frames.length, 1);
  const row = h.frames[0].payload.message;
  assert.equal(row.content.text, '字'.repeat(100));
  assert.equal(row.role, 'thinking');
  h.publisher.noteEvent('s', delta(101, '尾'));
  h.flush();
  assert.equal(h.frames[1].payload.message.id, row.id);
  assert.equal(h.frames[1].payload.message.content.text, '字'.repeat(100) + '尾');
  h.publisher.noteEvent('s', delta(102, '未发送'));
  h.publisher.noteEvent('s', { type: 'assistant/message', seq: 103, data: { turn: 1, step: 1 } });
  assert.equal(h.timers.size, 0);
  assert.equal(h.frames.at(-1).channel, 'local-db:messages:deleted');
  assert.deepEqual(h.frames.at(-1).payload.clientIds, [row.clientId]);
  assert.ok(h.invalidated.length > 0);
});

test('mid-block history preview is retired even when the publisher sees only the final event', () => {
  const h = harness();
  const stream = createReasoningStream('s');
  stream.consume(delta(1, '公开摘要'));
  const before = stream.rows();
  h.publisher.noteEvent('s', { type: 'assistant/message', seq: 2 }, { before, after: [] });
  assert.deepEqual(h.frames[0].payload.clientIds, [before[0].clientId]);
});

test('cached full prefix wins over publisher tail after subscribing mid-stream', () => {
  const h = harness();
  const stream = createReasoningStream('s');
  stream.consume(delta(1, '完整'));
  const before = stream.rows();
  stream.consume(delta(2, '后缀'));
  h.publisher.noteEvent('s', delta(2, '后缀'), { before, after: stream.rows() });
  h.flush();
  assert.equal(h.frames[0].payload.message.content.text, '完整后缀');
});

test('block-end replaces text verbatim, ignores opaque metadata, and cancellation removes previews', () => {
  const h = harness();
  h.publisher.noteEvent('s', delta(1, '片段'));
  h.publisher.noteEvent('s', { type: 'assistant/chunk', seq: 2, time: 1002, data: { turn: 1, step: 1, chunk: {
    type: 'block-end', index: 0, block: { type: 'reasoning', text: '最终摘要', signature: 'private', replayState: 'secret' },
  } } });
  assert.equal(h.timers.size, 0);
  assert.equal(h.frames[0].payload.message.content.text, '最终摘要');
  assert.equal(h.frames[0].payload.message.isStreaming, false);
  assert.doesNotMatch(JSON.stringify(h.frames), /private|secret/);
  h.publisher.noteEvent('s', { type: 'turn/end', seq: 3 });
  assert.equal(h.frames.at(-1).channel, 'local-db:messages:deleted');
});

test('sessions, steps and interleaved block indexes keep distinct identities; duplicate events do not append twice', () => {
  const stream = createReasoningStream('s');
  stream.consume(delta(1, '甲', 4));
  stream.consume(delta(2, '乙', 9));
  stream.consume(delta(2, '乙', 9));
  assert.deepEqual(stream.rows().map(row => row.content.text), ['甲', '乙']);
  assert.notEqual(stream.rows()[0].id, stream.rows()[1].id);
  const other = createReasoningStream('other');
  other.consume(delta(1, '甲', 4));
  assert.notEqual(stream.rows()[0].id, other.rows()[0].id);
  stream.consume(delta(3, '新步骤', 4, 2));
  assert.deepEqual(stream.rows().map(row => row.content.text), ['新步骤']);
});

test('non-reasoning, empty, malformed and private chunks never become visible text', () => {
  const stream = createReasoningStream('s');
  for (const chunk of [null, {}, { type: 'reasoning-delta', index: -1, text: 'bad' },
    { type: 'reasoning-delta', index: 0, text: '' },
    { type: 'text-delta', index: 0, text: 'answer' },
    { type: 'finish', replayState: { text: 'private' } },
    { type: 'block-end', index: 0, block: { type: 'reasoning', signature: 'private' } }]) {
    stream.consume({ type: 'assistant/chunk', time: 1, data: { turn: 1, step: 1, chunk } });
  }
  assert.deepEqual(stream.rows(), []);
});

test('unwatched sessions and teardown never send queued snapshots', () => {
  const h = harness();
  h.publisher.noteEvent('s', delta(1, '摘要'));
  h.unwatch();
  h.flush();
  assert.equal(h.frames.length, 0);
  assert.equal(h.timers.size, 0);
  const next = harness();
  next.publisher.noteEvent('s', delta(1, '摘要'));
  next.publisher.clear();
  next.flush();
  assert.equal(next.frames.length, 0);
  assert.equal(next.timers.size, 0);
});
