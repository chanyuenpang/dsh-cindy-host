import test from 'node:test';
import assert from 'node:assert/strict';
import { createReasoningPublisher, REASONING_BURST_BYTES, REASONING_RATE_BYTES } from '../src/reasoning-publisher.js';

const delta = (seq, text, index = 0) => ({ type: 'assistant/chunk', seq, time: seq,
  data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index, text } } });
function harness() {
  let clock = 0; let raw = true; const timers = new Set(); const frames = []; const notices = [];
  const publisher = createReasoningPublisher({ watched: () => true, rawNeeded: () => raw, now: () => clock,
    push: (sid, channel, payload) => frames.push({ channel, payload, at: clock }), invalidate: () => notices.push(clock),
    setTimeout: (fn, ms) => { const timer = { fn, at: clock + ms }; timers.add(timer); return timer; }, clearTimeout: timer => timers.delete(timer) });
  function advance(ms) {
    const end = clock + ms; let guard = 0;
    while (true) {
      const next = [...timers].sort((a, b) => a.at - b.at)[0]; if (!next || next.at > end) break;
      assert.ok(guard++ < 10000); clock = next.at; timers.delete(next); next.fn();
    }
    clock = end;
  }
  const created = () => frames.filter(frame => frame.channel === 'local-db:messages:created');
  return { publisher, frames, notices, timers, advance, created, setRaw: value => { raw = value; } };
}

test('60s of growing reasoning obeys the serialized UTF-8 rate/burst budget with a single latest-wins timer', () => {
  const h = harness();
  for (let seq = 0; seq < 600; seq++) {
    h.publisher.noteEvent('s', delta(seq, 'x'.repeat(100)));
    assert.ok(h.timers.size <= 1); h.advance(100);
  }
  const bytes = h.created().reduce((sum, frame) => sum + Buffer.byteLength(JSON.stringify(frame.payload), 'utf8'), 0);
  assert.ok(bytes <= REASONING_BURST_BYTES + 60 * REASONING_RATE_BYTES, String(bytes));
  assert.ok(h.created().length <= 60);
  h.advance(3000);
  assert.equal(h.created().at(-1).payload.message.content.text, 'x'.repeat(60000), 'pending work keeps the latest full prefix, not a queue of stale prefixes');
  h.publisher.noteEvent('s', { type: 'turn/end', seq: 601, data: { turn: 1 } });
  const count = h.created().length; h.advance(10000);
  assert.equal(h.created().length, count); assert.equal(h.timers.size, 0);
});

test('unchanged blocks are deduplicated, and block-end cannot bypass the budget', () => {
  const h = harness();
  h.publisher.noteEvent('s', delta(0, 'A', 0)); h.publisher.noteEvent('s', delta(1, 'B', 1)); h.advance(1000);
  assert.equal(h.created().length, 2);
  h.publisher.noteEvent('s', delta(2, 'C', 1)); h.advance(1000);
  assert.equal(h.created().length, 3); assert.equal(h.created()[2].payload.message.content.text, 'BC');
  const end = seq => ({ type: 'assistant/chunk', seq, time: seq, data: { turn: 1, step: 1, chunk: { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'BC' } } } });
  h.publisher.noteEvent('s', end(3)); const count = h.created().length;
  h.publisher.noteEvent('s', end(4)); assert.equal(h.created().length, count);
});

test('oversized multibyte interim text is not sent or silently truncated, and terminal retirement is immediate', () => {
  const h = harness();
  h.publisher.noteEvent('s', delta(0, '字'.repeat(23000))); h.advance(1000);
  assert.equal(h.created().length, 0); assert.equal(h.timers.size, 0);
  h.publisher.noteEvent('s', { type: 'assistant/message', seq: 1, data: { turn: 1, step: 1 } });
  assert.equal(h.frames.at(-1).channel, 'local-db:messages:deleted');
  h.advance(10000); assert.equal(h.created().length, 0);
});

test('history-ready-only sessions receive invalidations but no raw reasoning body', () => {
  const h = harness(); h.setRaw(false);
  for (let seq = 0; seq < 100; seq++) { h.publisher.noteEvent('s', delta(seq, '字'.repeat(100))); h.advance(100); }
  assert.equal(h.created().length, 0); assert.equal(h.notices.length, 10);
  h.setRaw(true); h.publisher.noteEvent('s', delta(100, 'NEW')); h.advance(1000);
  assert.equal(h.created().length, 1); assert.ok(h.created()[0].payload.message.content.text.endsWith('NEW'));
  h.publisher.clear(); assert.equal(h.timers.size, 0);
});
