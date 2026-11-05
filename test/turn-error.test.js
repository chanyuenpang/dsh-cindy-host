import test from 'node:test';
import assert from 'node:assert/strict';
import { turnErrorRow, turnErrorPayload, turnStateFromEvents } from '../src/turn-error.js';
import { foldSessionEvent, createMessageReader } from '../src/dsh-message-fold.js';
import { groupHistoryItems } from '../src/host-history-view.js';

const failed = (seq = 2, error = {}) => ({ type: 'turn/end', seq, time: seq * 1000,
  data: { turn: 1, reason: { kind: 'error', error: { message: 'SECRET '.repeat(50000), code: 'RATE_LIMIT', status: 429, ...error } } } });

test('failed turn has a bounded safe row and matching terminal identity', () => {
  const row = turnErrorRow(failed(), 's1');
  assert.equal(row.id, 's1:turn-error:2');
  assert.equal(row.clientId, row.id);
  assert.equal(row.createdAt, '1970-01-01T00:00:02.000Z');
  assert.equal(row.role, 'error');
  assert.match(row.content.message, /RATE_LIMIT; HTTP 429/);
  assert.equal(JSON.stringify(row).includes('SECRET'), false);
  const payload = turnErrorPayload(row);
  assert.equal(payload.persistId, row.clientId);
  assert.equal(payload.event.type, 'error');
  assert.equal(payload.event.data.isTerminal, true);
  assert.equal(payload.event.data.willRetry, false);
});

test('unknown failure fields and status are not reflected or inferred from prose', () => {
  const row = turnErrorRow(failed(2, { code: 'SECRET', status: 'SECRET', requestId: 'SECRET', cause: { token: 'SECRET' } }), 's1');
  assert.deepEqual(row.content, { message: 'This turn failed. See the local DSH diagnostics for details.', reason: 'dsh-turn-error' });
  for (const status of [-1, 99, 600, NaN, 429.5, '429']) assert.equal(turnErrorRow(failed(2, { status }), 's1').content.status, undefined);
});

test('only durable failed turn boundaries render; attempts and other endings are not failures', () => {
  for (const type of ['assistant/attempt', 'assistant/chunk', 'tool/result', 'step/end', 'turn/start']) {
    assert.equal(turnErrorRow({ ...failed(), type }, 's1'), null);
  }
  for (const kind of ['completed', 'aborted', 'blocked', 'max-tokens']) {
    const end = { ...failed(), data: { reason: { kind } } };
    assert.equal(turnErrorRow(end, 's1'), null);
    assert.ok(foldSessionEvent(end, { sessionId: 's1' }).every(row => row.role !== 'error'));
  }
  for (const seq of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.equal(turnErrorRow(failed(seq), 's1'), null);
});

test('invalid error identities have no wall-clock fallback', () => {
  for (const patch of [{ seq: undefined }, { time: undefined }, { time: NaN }, { time: 9e18 }]) {
    assert.equal(turnErrorRow({ ...failed(), ...patch }, 's1'), null);
  }
});

test('live, cached, replayed, paged and counted failed turns share exactly one row', async () => {
  const events = [{ type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } }];
  const live = createMessageReader({ readSessionLog: async () => ({ events }) });
  assert.equal(await live.count('s1'), 0);
  events.push(failed());
  assert.equal(live.noteEvent('s1', events[1]), true);
  const row = foldSessionEvent(events[1], { sessionId: 's1' })[0];
  assert.deepEqual(await live.all('s1'), [row]);
  const grouped = groupHistoryItems(await live.all('s1'), { running: false });
  assert.equal(grouped[0].type, 'messages');
  assert.deepEqual(grouped[0].messages, [row]);
  assert.equal(await live.count('s1'), 1);
  assert.deepEqual(await live('s1', { before: row.id, limit: 1 }), []);
  live.noteEvent('s1', events[1]); // duplicate invalidates safely, never appends a second row
  assert.deepEqual(await live.all('s1'), [row]);
  events.push(failed(3));
  const cold = createMessageReader({ readSessionLog: async () => ({ events: [...events, events.at(-1)] }) });
  assert.deepEqual((await cold.all('s1')).map(row => row.id), ['s1:turn-error:3', 's1:turn-error:2']);
  assert.equal(await cold.count('s1'), 2);
  assert.deepEqual(await cold('s1', { before: 's1:turn-error:3', limit: 1 }), [row]);
});

test('terminal recovery reads the latest native boundary fresh, not the cached last error', async () => {
  const events = [failed()];
  const reader = createMessageReader({ readSessionLog: async () => ({ events }) });
  await reader.all('s1');
  assert.equal((await reader.turnState('s1')).error.id, 's1:turn-error:2');
  events.push({ type: 'turn/start', seq: 3, time: 3000, data: { turn: 2 } });
  assert.equal((await reader.turnState('s1')).running, true);
  assert.equal((await reader.turnState('s1')).error, null);
  assert.throws(() => turnStateFromEvents([failed(2), failed(1)], 's1'));
  assert.throws(() => turnStateFromEvents([failed(1), failed(3)], 's1'));
  assert.throws(() => turnStateFromEvents(null, 's1'));
});
