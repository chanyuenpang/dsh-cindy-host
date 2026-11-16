import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceRetryPresentation, retryPresentationEvent } from '../src/retry-presentation.js';
import { createMessageReader, foldSessionEvent } from '../src/dsh-message-fold.js';
import { createDshInputDeliveryBackend } from '../src/dsh-input-delivery.js';
import { createHistoryViewController } from '../src/host-history-view.js';
import { turnStateFromEvents } from '../src/turn-error.js';

const start = { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } };
const retry = { type: 'llm/retry', seq: 1, time: 2000, data: { turn: 1, step: 1, retryId: 'r1',
  retry: 6, maxRetries: 10, delayMs: 10000, mode: 'normal', failure: { code: 'TRANSPORT', message: 'SECRET', status: 502 }, provider: 'SECRET' } };
const started = { type: 'llm/retry-started', seq: 2, time: 3000, data: { turn: 1, step: 1, retryId: 'r1', retry: 6 } };
const fold = events => events.reduce(reduceRetryPresentation, null);

test('finite transport progress is safe, nonterminal and survives a matching started event', () => {
  const state = fold([start, retry, started]);
  assert.equal(state.retry.phase, 'started');
  assert.equal(JSON.stringify(state).includes('SECRET'), false);
  assert.deepEqual(retryPresentationEvent(state), { type: 'error', data: {
    isTerminal: false, willRetry: true, reason: 'dsh-model-retry', message: 'Reconnecting... 6/10' } });
  assert.deepEqual(turnStateFromEvents([start, retry, started], 's1').retryPresentation, state);
});

test('unlimited, unmapped and invalid attempts never invent a type or finite budget', () => {
  for (const data of [
    { mode: 'always' }, ...['TIMEOUT', 'SERVER', 'RATE_LIMIT', 'AUTH', 'SECRET'].map(code => ({ failure: { code } })),
    ...[undefined, 0, 5, Infinity, 10.5, '10'].map(maxRetries => ({ maxRetries })),
    ...[0, -1, Infinity, 1.5, '6'].map(retry => ({ retry })),
    { retryId: '' }, { step: -1 }, { delayMs: NaN },
  ]) assert.equal(retryPresentationEvent(fold([start, { ...retry, data: { ...retry.data, ...data } }])), null);
});

test('monotonic source state fences duplicates, wrong turns and unmatched starts', () => {
  const state = fold([start, retry]);
  assert.equal(reduceRetryPresentation(state, retry), state);
  assert.equal(reduceRetryPresentation(state, { ...retry, seq: 2, data: { ...retry.data, turn: 2 } }), state);
  assert.equal(retryPresentationEvent(reduceRetryPresentation(state, { ...started, data: { ...started.data, retryId: 'other' } })), null);
  assert.equal(retryPresentationEvent(fold([start, started])), null);
});

for (const type of ['step/start', 'assistant/message', 'turn/end', 'turn/start']) test(`${type} clears retry progress`, () => {
  const state = fold([start, retry, started, { type, seq: 3, time: 4000, data: { turn: type === 'turn/start' ? 2 : 1, step: 1, reason: { kind: 'completed' } } }]);
  assert.equal(retryPresentationEvent(state), null);
  assert.equal(state.retry, null);
  if (type === 'turn/end') assert.equal(reduceRetryPresentation(state, { ...retry, seq: 4 }), state);
});

test('ten retries have zero live/cold/incremental/grouped/durable rows and leave native evidence intact', async () => {
  const events = [start];
  const reader = createMessageReader({ readSessionLog: async () => ({ events }) });
  await reader.all('s1');
  for (let attempt = 1; attempt <= 10; attempt++) {
    const scheduled = { ...retry, seq: events.length, data: { ...retry.data, retryId: `r${attempt}`, retry: attempt } };
    const active = { ...started, seq: events.length + 1, data: { ...started.data, retryId: `r${attempt}`, retry: attempt } };
    for (const event of [scheduled, active]) {
      events.push(event); reader.noteEvent('s1', event);
      assert.deepEqual(foldSessionEvent(event, { sessionId: 's1' }), []);
    }
  }
  assert.deepEqual(await reader.all('s1'), []);
  assert.equal(await reader.count('s1'), 0);
  assert.deepEqual(await reader('s1'), []);
  assert.deepEqual((await reader.historySnapshot('s1')).rows, []);
  const cold = createMessageReader({ readSessionLog: async () => ({ events: structuredClone(events) }) });
  assert.deepEqual(await cold.all('s1'), []);
  const view = createHistoryViewController({ snapshot: id => reader.historySnapshot(id), sessionRunning: () => true });
  assert.deepEqual((await view.page('s1')).result.items, []);
  const original = structuredClone(events);
  const backend = createDshInputDeliveryBackend({ getServices: () => ({
    sessions: { get: () => ({}), flush: async () => true }, agents: { get: () => ({ status: 'running' }) },
    persistence: { open: async () => ({ read: async () => ({ events }), close: async () => {} }) },
  }), sessionController: {}, getSession: async () => ({ id: 's1' }) });
  assert.deepEqual(await backend.readRows('s1'), []);
  assert.deepEqual((await backend.historySnapshot('s1')).rows, []);
  assert.equal((await backend.evidence('s1')).throughSeq, 20);
  assert.deepEqual(events, original);
});
