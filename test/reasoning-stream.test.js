import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageReader } from '../src/dsh-message-fold.js';
import { createHistoryViewController } from '../src/host-history-view.js';

const chunk = (seq, chunk, step = 1) => ({ type: 'assistant/chunk', seq, time: 1000 + seq, data: { turn: 1, step, chunk } });
const delta = (seq, text, index = 0, step = 1) => chunk(seq, { type: 'reasoning-delta', index, text }, step);
const final = (seq, text = '公开摘要', interrupted = false) => ({
  type: 'assistant/message', seq, time: 1000 + seq, surfaceOp: 'append',
  data: { turn: 1, step: 1, ...(interrupted ? { interrupted: true } : {}), message: {
    id: 'answer', role: 'assistant', content: [{ type: 'reasoning', text }, { type: 'text', text: '答复' }],
  } },
});

test('active reasoning is visible on cold reads, live cache updates and work details, then reconciles to durable rows', async () => {
  const events = [delta(1, '公开'), delta(2, '摘要')];
  const reader = createMessageReader({ readSessionLog: async () => ({ events: [...events] }) });
  const initial = await reader('s');
  assert.equal(initial.length, 1, 'raw reasoning chunks must not vanish before assistant/message');
  assert.equal(initial[0].role, 'thinking');
  assert.equal(initial[0].content.text, '公开摘要');
  assert.equal(initial[0].isStreaming, true);
  assert.equal(await reader.count('s'), 0, 'in-flight preview is not durable grouping evidence');
  const id = initial[0].id;
  const next = delta(3, '继续');
  events.push(next);
  assert.equal(reader.noteEvent('s', next), true);
  assert.equal((await reader('s'))[0].id, id);
  assert.equal((await reader('s'))[0].content.text, '公开摘要继续');
  const view = createHistoryViewController({ rows: reader.all, sessionRunning: () => true });
  const page = await view.page('s');
  const work = page.result.items.find(item => item.type === 'work');
  assert.ok(work);
  const details = await view.details('s', work.summary);
  assert.equal(details.result.messages[0].content.text, '公开摘要继续');
  const completed = final(4, '公开摘要继续');
  events.push(completed);
  reader.noteEvent('s', completed);
  const rows = await reader('s');
  assert.deepEqual(rows.map(row => row.role), ['thinking', 'assistant']);
  assert.equal(rows[0].content.text, '公开摘要继续');
  assert.notEqual(rows[0].id, id);
  assert.equal(await reader.count('s'), 2);
  const cold = createMessageReader({ readSessionLog: async () => ({ events }) });
  assert.deepEqual(await cold('s'), rows, 'reconnect and live completion have the same durable result');
});

test('block-end snapshots do not duplicate deltas and interrupted messages replace temporary thinking', async () => {
  const events = [delta(1, '前缀')];
  const reader = createMessageReader({ readSessionLog: async () => ({ events }) });
  await reader('s');
  reader.noteEvent('s', chunk(2, { type: 'block-end', index: 0, block: { type: 'reasoning', text: '前缀最终' } }));
  assert.equal((await reader('s'))[0].content.text, '前缀最终');
  assert.equal((await reader('s'))[0].isStreaming, false);
  reader.noteEvent('s', final(3, '前缀最终', true));
  assert.equal((await reader('s')).filter(row => row.role === 'thinking').length, 1);
});

test('turn completion without a durable message clears the preview, and cache gaps reseed from the log', async () => {
  const events = [delta(1, '前缀')];
  const reader = createMessageReader({ readSessionLog: async () => ({ events: [...events] }) });
  await reader('s');
  const end = { type: 'turn/end', seq: 2, time: 2000, data: { turn: 1 } };
  reader.noteEvent('s', end);
  assert.deepEqual(await reader('s'), []);
  events.push(end, delta(3, '下一步', 0, 2));
  assert.equal(reader.noteEvent('s', delta(4, '新内容', 0, 2)), false);
  assert.equal((await reader('s'))[0].content.text, '下一步');
});
