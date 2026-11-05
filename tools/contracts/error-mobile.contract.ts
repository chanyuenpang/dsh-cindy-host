// Opt-in tests against actual mobile sources through their own aliases/config.
// Validate turn notices as visible system text, never generic hidden error details.
import { beforeEach, expect, test } from 'vitest';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { normalizeRemoteMessages } from '@/session/messageNormalize';
import { i18n } from '@/i18n';
import { foldSessionEvent, createMessageReader } from '../../src/dsh-message-fold.js';
import { turnErrorPayload, turnDiagnosticPayload } from '../../src/turn-error.js';
import { runningStatusEvent } from '../../src/session-publisher.js';
import { interruptedTurnClosers } from '@deepseek-ai/dsh-session';

const event = { type: 'turn/end', seq: 1, time: Date.now(), data: { turn: 1, reason: { kind: 'error',
  error: { code: 'RATE_LIMIT', status: 429, message: 'SECRET provider token' } } } };
const wire = value => JSON.parse(JSON.stringify(value));
beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  remoteSessionStore.clear();
  remoteSessionStore.setDeviceSessions('host', 'DSH', [{ id: 's1', userId: 'user', title: 'Task',
    workingDir: '/repo', workspaceKind: 'project', model: 'model', effort: 'medium', permissionMode: 'default',
    fastMode: false, status: 'active', agentKind: 'codex', userSendAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]);
});

test('Host terminal payload closes the real mobile turn with stable identity and safe details', () => {
  const [row] = foldSessionEvent(event, { sessionId: 's1' });
  remoteSessionStore.applyRemotePush('host', 'maker:event', { sessionId: 's1', event: { type: 'status', data: { isRunning: true, status: 'running' } } });
  expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(true);
  remoteSessionStore.applyRemotePush('host', 'maker:event', wire(turnErrorPayload(row)));
  expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(false);
  expect(remoteSessionStore.getSessionRunStatus('s1').hasTerminalError).toBe(true);
  expect(remoteSessionStore.getSessionRunStatus('s1').terminalError).toEqual({ clientId: row.clientId, message: row.content.message });
  const [normalized] = normalizeRemoteMessages([wire(row)]);
  expect(normalized).toMatchObject({ kind: 'system', label: 'error', rawError: row.content.message });
  expect(normalized.body).toBeTruthy();
  expect(normalized.rawError).toContain('RATE_LIMIT; HTTP 429');
  expect(JSON.stringify(normalized)).not.toContain('SECRET');
});

test('live error rows and replayed history merge once through the real mobile ingress', async () => {
  const reader = createMessageReader({ readSessionLog: async () => ({ events: [event] }) });
  const [row] = foldSessionEvent(event, { sessionId: 's1' });
  for (let i = 0; i < 2; i++) remoteSessionStore.applyRemotePush('host', 'local-db:messages:created', wire({ sessionId: 's1', message: row }));
  expect(remoteSessionStore.getMessages('s1').filter(message => message.role === 'error')).toHaveLength(1);
  remoteSessionStore.setMessages('s1', wire(await reader('s1')));
  remoteSessionStore.applyRemotePush('host', 'local-db:messages:created', wire({ sessionId: 's1', message: row }));
  expect(remoteSessionStore.getMessages('s1').filter(message => message.role === 'error')).toHaveLength(1);
  expect(normalizeRemoteMessages(remoteSessionStore.getMessages('s1'))[0].rawError).toBe(row.content.message);
});

for (const reason of [{ kind: 'interrupted' }, { kind: 'aborted', reason: { kind: 'user' } },
  { kind: 'aborted', reason: { kind: 'hook', reason: 'deepseek-account/signed-out' } }, { kind: 'max-tokens' }, { kind: 'blocked' }]) {
  test(`actual mobile displays ${reason.kind} text directly and keeps non-model semantics`, () => {
    const [row] = foldSessionEvent({ ...event, data: { turn: 1, reason } }, { sessionId: 's1' });
    remoteSessionStore.applyRemotePush('host', 'maker:event', { sessionId: 's1', event: runningStatusEvent() });
    const created = wire({ sessionId: 's1', message: row });
    remoteSessionStore.applyRemotePush('host', 'local-db:messages:created', created);
    remoteSessionStore.applyRemotePush('host', 'maker:event', wire(turnDiagnosticPayload(row)));
    remoteSessionStore.setMessages('s1', [wire(row)]);
    remoteSessionStore.applyRemotePush('host', 'local-db:messages:created', created);
    const normalized = normalizeRemoteMessages(remoteSessionStore.getMessages('s1'));
    expect(normalized).toHaveLength(1); expect(normalized[0].body).toBe(row.content);
    expect(normalized[0].kind).toBe('system');
    expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(false);
    expect(remoteSessionStore.getSessionRunStatus('s1').hasTerminalError).not.toBe(true);
    if (reason.kind === 'interrupted') expect(normalized[0].body).toContain('未完成的工具调用结果未知');
  });
}

test('actual mobile sees safe retry details without treating an ongoing retry as terminal failure', () => {
  const retry = { type: 'llm/retry', seq: 2, time: Date.now(), data: { turn: 1, retry: 1, maxRetries: 3, mode: 'normal', delayMs: 2000,
    failure: { code: 'RATE_LIMIT', status: 429, message: 'SECRET' } } };
  const [row] = foldSessionEvent(retry, { sessionId: 's1' });
  remoteSessionStore.applyRemotePush('host', 'local-db:messages:created', wire({ sessionId: 's1', message: row }));
  remoteSessionStore.applyRemotePush('host', 'maker:event', { sessionId: 's1', event: runningStatusEvent(row.content) });
  expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(true);
  expect(remoteSessionStore.getSessionRunStatus('s1').hasTerminalError).not.toBe(true);
  const [normalized] = normalizeRemoteMessages(remoteSessionStore.getMessages('s1'));
  expect(normalized.body).toContain('已安排重试'); expect(normalized.body).toContain('RATE_LIMIT');
  expect(normalized.body).not.toContain('SECRET');
});

test('native recovered unknown tool result remains visible in the real mobile paired tool details', () => {
  const prefix = [{ type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: Date.now(), data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: 2, time: Date.now(), surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'a', role: 'assistant',
      content: [{ type: 'tool-call', id: 'call-1', name: 'pwsh', arguments: '{}' }] } } },
    { type: 'tool/call', seq: 3, time: Date.now(), data: { turn: 1, step: 1, callId: 'call-1' } }];
  const rows = [...prefix, ...interruptedTurnClosers(prefix)].flatMap(e => foldSessionEvent(e, { sessionId: 's1' }));
  const normalized = normalizeRemoteMessages(wire(rows));
  expect(normalized.some(row => row.kind === 'system' && row.body.includes('工具调用结果未知'))).toBe(true);
  const tool = normalized.find(row => row.kind === 'tool');
  expect(tool.toolSettled).toBe(true); expect(tool.secondaryBody).toBeTruthy();
  expect(tool.secondaryBody.toLowerCase()).toContain('unknown');
});
