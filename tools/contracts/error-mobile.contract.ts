// Opt-in tests against actual mobile sources through their own aliases/config.
import { beforeEach, expect, test } from 'vitest';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { normalizeRemoteMessages } from '@/session/messageNormalize';
import { i18n } from '@/i18n';
import { foldSessionEvent, createMessageReader } from '../../src/dsh-message-fold.js';
import { turnErrorPayload } from '../../src/turn-error.js';

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
