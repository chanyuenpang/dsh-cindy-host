// Actual Cindy interruption semantics, not an imitation of the banner resolver.
import { expect, test } from 'vitest';
import { resolveSessionTailBanner, isContinuationQueueItem } from '@/session/sessionTailBannerModel';
import { buildQueuedTextMessage } from '@/session/inputProjection';
import { normalizeRemoteMessages } from '@/session/messageNormalize';
import { CONTINUE_INTERRUPTED, CONTINUE_ERROR } from '../../src/continuation-protocol.js';
import { turnStateFromEvents } from '../../src/turn-error.js';
import { interruptionFields, diagnosticOwner } from '../../src/diagnostic-presentation.js';
import { diagnosticSettings } from '../../test/support/diagnostic-settings.js';
import { toCindySessionListRow } from '../../src/cindy-session-row.js';
import { createMobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { resolveMobileSessionRightStatus } from '@/session/sessionRightStatus';
import { CONTINUE_AFTER_ERROR_PROMPT, CONTINUE_AFTER_APP_EXIT_PROMPT, APP_EXIT_INTERRUPTED_REASON } from 'cindy-trigger-protocol';

const session = { id: 's1', title: 'Task', workingDir: '/repo', agentKind: 'codex', model: 'model', effort: 'medium', permissionMode: 'default',
  fastMode: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  activeTurnStartedAt: 2000, lastTurnEndedAt: null, clearedAt: null };
const input = overrides => ({ messages: [], session, projection: { error: null, credentialSwitchWait: null },
  isSessionStreaming: false, continuationInFlight: false, sessionMetadataSyncedForConnection: true, interruptAcked: false, hiddenErrorClientIds: new Set(), ...overrides });

test('actual native banner and homepage alert consume the same Host wire tuple and durable acknowledgement', async () => {
  const events = [{ seq: 0, time: 2000, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, time: 3000, type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } }];
  const candidate = turnStateFromEvents(events, 's1').interruption;
  const pref = diagnosticSettings(); const owner = diagnosticOwner('account|realm|host');
  const wire = () => JSON.parse(JSON.stringify(toCindySessionListRow({ id: 's1', cwd: '/repo', running: false,
    ...interruptionFields(candidate, false, false, pref.preferences.snapshot(), owner, 's1') })));
  remoteSessionStore.setDeviceSessions('host', 'DSH', [wire()]);
  const stored = () => remoteSessionStore.getSessions().find(item => item.id === 's1');
  expect(resolveSessionTailBanner(input({ session: stored() }))).toEqual({ kind: 'interrupted' });
  const right = interruption => resolveMobileSessionRightStatus({ interruption, liveAttention: false, pendingInteractionCount: 0, running: false, scheduleUnreadCount: 0 });
  expect(right(wire())).toBe('error'); // native right-slot enum renders the red dot
  await pref.preferences.commit({ owner, sessionId: 's1', kind: 'interruptions', id: candidate.id });
  remoteSessionStore.applyRemotePush('host', 'local-db:sessions:patched', { sessionId: 's1', patch: wire() });
  expect(resolveSessionTailBanner(input({ session: stored() }))).toBeNull(); expect(right(stored())).toBe('time');
  const calls = []; const transport = createMobileMakerTransport({ deviceId: 'host', invoke: async (device, channel, args) => { calls.push({ device, channel, args }); return null; } });
  await transport.ackInterruptedTurn('s1'); await transport.dismissErrorMessage('s1', 's1:turn-error:1');
  expect(calls).toEqual([{ device: 'host', channel: 'local-db:sessions:ack-interrupted', args: ['s1'] },
    { device: 'host', channel: 'local-db:messages:dismiss-error', args: ['s1', 's1:turn-error:1'] }]);
});

test('native interruption banner is timestamp-derived and gated by current metadata and running state', () => {
  expect(resolveSessionTailBanner(input({}))).toEqual({ kind: 'interrupted' });
  expect(resolveSessionTailBanner(input({ sessionMetadataSyncedForConnection: false }))).toBeNull();
  expect(resolveSessionTailBanner(input({ isSessionStreaming: true }))).toBeNull();
  expect(resolveSessionTailBanner(input({ continuationInFlight: true }))).toBeNull();
  expect(resolveSessionTailBanner(input({ session: { ...session, lastTurnEndedAt: 2000 } }))).toBeNull();
  expect(resolveSessionTailBanner(input({ session: { ...session, activeTurnStartedAt: null } }))).toBeNull();
});

test('the legacy error marker is a different banner branch, not the native timestamp protocol', () => {
  const messages = [{ id: 'old', clientId: 'old', sessionId: 's1', role: 'error', toolUseId: null, agentMeta: null, createdAt: session.createdAt,
    content: { message: 'Old interrupted row', reason: APP_EXIT_INTERRUPTED_REASON } }];
  expect(resolveSessionTailBanner(input({ messages }))).toMatchObject({ kind: 'error-tail', continueKind: 'interrupted' });
});

test('manual continuation uses the actual safe shared prompt and is hidden from the normal message stream', () => {
  const queued = buildQueuedTextMessage(session, CONTINUE_AFTER_APP_EXIT_PROMPT, new Date(3000), 'manual-continue', { planMode: false });
  expect(CONTINUE_INTERRUPTED).toBe(CONTINUE_AFTER_APP_EXIT_PROMPT);
  expect(CONTINUE_ERROR).toBe(CONTINUE_AFTER_ERROR_PROMPT);
  expect(queued.text).toBe(CONTINUE_AFTER_APP_EXIT_PROMPT);
  expect(queued.text).toContain('Do not repeat steps that already completed');
  expect(queued.createOpts.planMode).toBe(false);
  expect(isContinuationQueueItem(queued)).toBe(true);
  const [row] = normalizeRemoteMessages([{ ...queued.chatMessage, id: queued.clientId, sessionId: 's1', toolUseId: null, agentMeta: null }]);
  expect(row.isSyntheticTrigger).toBe(true); expect(row.body).toBe('');
  expect(resolveSessionTailBanner(input({ continuationInFlight: isContinuationQueueItem(queued) }))).toBeNull();
  expect(resolveSessionTailBanner(input({}))).toEqual({ kind: 'interrupted' });
});
