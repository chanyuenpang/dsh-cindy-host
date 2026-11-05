import test from 'node:test';
import assert from 'node:assert/strict';
import { interruptedTurnClosers } from '@deepseek-ai/dsh-session';
import { turnDiagnosticRow, turnDiagnosticPayload, turnStateFromEvents } from '../src/turn-error.js';
import { foldSessionEvent, createMessageReader } from '../src/dsh-message-fold.js';
import { createDshInputDeliveryBackend } from '../src/dsh-input-delivery.js';
import { groupHistoryItems } from '../src/host-history-view.js';

const end = (kind, cause) => ({ type: 'turn/end', seq: 1, time: 1000, data: { turn: 1, reason: { kind, ...(cause ? { reason: cause } : {}) } } });
const start = { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } };
const retry = { type: 'llm/retry', seq: 1, time: 1100, data: { turn: 1, step: 1, mode: 'normal', retry: 1, maxRetries: 3, delayMs: 1500,
  failure: { message: 'SECRET', code: 'RATE_LIMIT', status: 429, requestId: 'SECRET' }, provider: 'SECRET' } };

test('restart interruption preserves the desktop unknown-tool-outcome message as a visible notice', () => {
  const row = turnDiagnosticRow(end('interrupted'), 's1');
  assert.equal(row.id, 's1:turn-notice:1'); assert.equal(row.role, 'system');
  assert.match(row.content, /DSH 进程在本轮完成前退出/); assert.match(row.content, /未完成的工具调用结果未知/);
  assert.equal(turnDiagnosticPayload(row).event.type, 'done');
  assert.equal(turnDiagnosticPayload(row).persistId, row.clientId);
  assert.deepEqual(foldSessionEvent(end('interrupted'), { sessionId: 's1' }), [row]);
  assert.equal(groupHistoryItems([row], { running: false })[0].type, 'messages');
});

test('user cancellation, sign-out, blocking and output limit are not process crashes or model failures', () => {
  for (const [event, expected] of [[end('aborted', { kind: 'user' }), /用户取消/],
    [end('aborted', { kind: 'hook', reason: 'deepseek-account/signed-out', message: 'SECRET' }), /退出 DeepSeek 登录/],
    [end('max-tokens'), /回答被截断/], [end('blocked'), /执行被阻止/]]) {
    const row = turnDiagnosticRow(event, 's1');
    assert.equal(row.role, 'system'); assert.match(row.content, expected);
    assert.doesNotMatch(row.content, /进程在本轮|SECRET/);
  }
  assert.equal(turnDiagnosticRow(end('completed'), 's1'), null);
  assert.equal(turnDiagnosticRow(end('forked'), 's1'), null);
  const unknown = turnDiagnosticRow(end('SECRET_UNKNOWN_CODE'), 's1');
  assert.match(unknown.content, /尚不能显示/); assert.doesNotMatch(unknown.content, /SECRET/);
});

test('only a scheduled native retry is visible; safe details do not invent a terminal error', () => {
  const row = turnDiagnosticRow(retry, 's1');
  assert.equal(row.role, 'system'); assert.match(row.content, /已安排重试.*等待 2 秒/); assert.ok(row.content.includes('1/3'));
  assert.match(row.content, /RATE_LIMIT; HTTP 429/); assert.doesNotMatch(row.content, /SECRET/);
  assert.equal(turnDiagnosticRow({ ...retry, type: 'assistant/attempt' }, 's1'), null);
  const state = turnStateFromEvents([start, retry], 's1');
  assert.equal(state.running, true); assert.equal(state.error, null); assert.equal(state.retryNotice.id, row.id);
  assert.equal(turnStateFromEvents([start, retry, { ...end('completed'), seq: 2 }], 's1').retryNotice, undefined);
  assert.equal(turnDiagnosticRow({ ...retry, data: { ...retry.data, retry: -1 } }, 's1'), null);
});

function crashedLog() {
  return [start, { type: 'step/start', seq: 1, time: 1100, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: 2, time: 1200, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'a', role: 'assistant',
      content: [{ type: 'tool-call', id: 'call-1', name: 'pwsh', arguments: '{}' }] } } },
    { type: 'tool/call', seq: 3, time: 1300, data: { turn: 1, step: 1, callId: 'call-1' } }];
}

test('cold durable history matches native query recovery, without altering persistence or receipt evidence', async () => {
  const persisted = crashedLog(); const original = structuredClone(persisted); let live = false; let flushes = 0;
  const services = { sessions: { get: () => live ? {} : undefined, flush: async () => { flushes++; return true; } },
    agents: { get: () => live ? { status: 'running' } : undefined }, persistence: { open: async () => ({ read: async () => ({ events: structuredClone(persisted) }), close: async () => {} }) } };
  const backend = createDshInputDeliveryBackend({ getServices: () => services, sessionController: {}, getSession: async () => ({ id: 's1' }) });
  const native = [...persisted, ...interruptedTurnClosers(persisted)];
  const reader = createMessageReader({ readSessionLog: async () => ({ events: native }) });
  const rows = await backend.readRows('s1'); const queryRows = await reader.all('s1');
  assert.deepEqual(rows.map(({ rowid, ...row }) => row), queryRows);
  const notice = rows.find(row => row.role === 'system'); assert.match(notice.content, /工具调用结果未知/);
  assert.equal(rows.find(row => row.role === 'tool_result').content.isError, true);
  assert.equal((await reader.turnState('s1')).notice.id, notice.id);
  const evidence = await backend.evidence('s1');
  assert.deepEqual(evidence.users, []); assert.equal(evidence.throughSeq, persisted.length - 1);
  assert.deepEqual(persisted, original); assert.equal(flushes, 0);
  live = true; const runningRows = await backend.readRows('s1');
  assert.equal(runningRows.some(row => row.role === 'system'), false, 'an active writer must not be called crashed');
  assert.equal(runningRows.some(row => row.role === 'tool_result'), false, 'live tool outcome remains unknown, not fabricated');
});

test('replay, incremental cache and cursor paging share stable notice identities', async () => {
  const events = [start]; const reader = createMessageReader({ readSessionLog: async () => ({ events }) });
  await reader.all('s1'); events.push(end('interrupted')); reader.noteEvent('s1', events[1]);
  const [row] = await reader.all('s1'); reader.noteEvent('s1', events[1]);
  assert.equal((await reader.all('s1')).length, 1); assert.equal(await reader.count('s1'), 1);
  assert.deepEqual(await reader('s1', { before: row.id, limit: 1 }), []);
  events.push({ ...start, seq: 2, data: { turn: 2 } });
  assert.equal((await reader.turnState('s1')).notice, undefined, 'an old notice is not the new turn terminal');
});
