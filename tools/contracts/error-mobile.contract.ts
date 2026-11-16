// Opt-in tests against actual mobile sources through their own aliases/config.
// Validate turn notices as visible system text, never generic hidden error details.
import { beforeEach, expect, test } from 'vitest';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { normalizeRemoteMessages } from '@/session/messageNormalize';
import { i18n } from '@/i18n';
import { foldSessionEvent, createMessageReader } from '../../src/dsh-message-fold.js';
import { turnErrorPayload, turnDiagnosticPayload } from '../../src/turn-error.js';
import { runningStatusEvent } from '../../src/session-publisher.js';
import { startHost } from '../../src/host.js';
import { FixtureDshSource } from '../../src/fixture-source.js';
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

class RetrySocket {
  sent: any[] = []; handlers = new Map<string, Function[]>(); readyState = 1;
  on(type: string, fn: Function) { this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]); return this; }
  emit(type: string, data?: unknown) { for (const fn of this.handlers.get(type) ?? []) fn(data); }
  frame(data: unknown) { this.emit('message', Buffer.from(JSON.stringify(data))); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() {}
}
const nextTick = () => new Promise(resolve => setImmediate(resolve));
async function retryHost(events: any[], liveAssistant?: any) {
  const socket = new RetrySocket(); const source = new FixtureDshSource(); let running = true;
  source.listSessionStates = async id => [{ id: id ?? 's1', running }];
  source.getSession = async id => ({ id, title: 'Task', running, cwd: '/repo', updatedAt: 1000 });
  const reader = createMessageReader({ readSessionLog: async () => ({ events }) });
  const runtime = await startHost(source, { transportEnabled: true, remoteControlEnabled: true, controllers: {} }, {
    resolveSession: async () => ({ ok: true, session: { deviceId: 'host' } }), openSocket: () => socket,
    heartbeatMs: 0, listDevices: async () => ({ devices: [] }), resolveCapabilities: () => ({ readMessages: reader, liveAssistant }),
  });
  const consume = () => {
    for (const frame of socket.sent.splice(0)) if (frame.kind === 'push' && frame.dst === 'phone') {
      remoteSessionStore.applyRemotePush('host', frame.payload.channel, wire(frame.payload.payload));
    }
  };
  socket.emit('open');
  socket.frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'host', userId: 'account' } });
  socket.frame({ v: 1, kind: 'invoke', id: 'sub', src: 'phone', payload: { channel: 'device-link:subscribe', args: [{ topics: ['session:s1'] }] } });
  await nextTick(); consume();
  return { runtime, reader, socket, source, consume, idle: () => { running = false; } };
}
const turnStart = { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } };
const scheduledRetry = (seq = 1, patch = {}) => ({ type: 'llm/retry', seq, time: 1000 + seq * 1000,
  data: { turn: 1, step: 1, retryId: 'r1', retry: 6, maxRetries: 10, mode: 'normal', delayMs: 10000,
    failure: { code: 'TRANSPORT', message: 'SECRET' }, ...patch } });
const startedRetry = { type: 'llm/retry-started', seq: 2, time: 3000, data: { turn: 1, step: 1, retryId: 'r1', retry: 6 } };

test('actual mobile consumes real Host frames: retry 6/10 is inline, survives started/summary, clears on progress', async () => {
  const events = [turnStart]; const x = await retryHost(events);
  try {
    x.runtime.pushTurnRunning('s1', turnStart); x.consume();
    const retry = scheduledRetry(); events.push(retry); x.reader.noteEvent('s1', retry);
    x.runtime.pushSessionDiagnostic('s1', retry); x.consume();
    expect(remoteSessionStore.getMessages('s1')).toHaveLength(0);
    expect(remoteSessionStore.getSessionRunStatus('s1').reconnectAttempt).toEqual({ attempt: 6, maxAttempts: 10 });
    expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(true);
    expect(remoteSessionStore.getSessionRunStatus('s1').hasTerminalError).not.toBe(true);
    expect(i18n.t('session.screen.networkReconnecting')).toBe('正在重新连接…');
    events.push(startedRetry); x.reader.noteEvent('s1', startedRetry);
    x.runtime.pushSessionDiagnostic('s1', startedRetry); x.consume();
    expect(remoteSessionStore.getSessionRunStatus('s1').reconnectAttempt).toEqual({ attempt: 6, maxAttempts: 10 });
    await x.source.emit({ kind: 'session-status', sessionId: 's1', phase: 'running', sequence: 1 }); x.consume();
    expect(remoteSessionStore.getSessionRunStatus('s1').reconnectAttempt?.attempt).toBe(6);
    const progress = { type: 'step/start', seq: 3, time: 4000, data: { turn: 1, step: 2 } };
    events.push(progress); x.reader.noteEvent('s1', progress); x.runtime.pushSessionDiagnostic('s1', progress); x.consume();
    expect(remoteSessionStore.getSessionRunStatus('s1').reconnectAttempt).toBeNull();
    expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(true);
    expect(remoteSessionStore.getMessages('s1')).toHaveLength(0);
    const done = { type: 'turn/end', seq: 4, time: 5000, data: { turn: 1, reason: { kind: 'completed' } } };
    x.runtime.pushTurnIdle('s1', done); x.consume();
    expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(false);
    expect(remoteSessionStore.getSessionRunStatus('s1').hasTerminalError).not.toBe(true);
  } finally { await x.runtime.stop(); }
});

test('actual mobile keeps retry through delayed old native text and its deletion barrier, then clears on a newer attempt', async () => {
  let notify: Function;
  const x = await retryHost([turnStart], { watch: (_id, listener) => { notify = listener; return () => {}; } });
  const row = (id, content) => ({ id, clientId: id, sessionId: 's1', role: 'assistant', content, createdAt: new Date(1000).toISOString() });
  try {
    notify({ rows: [row('old', '部分旧输出')], immediate: true, attempt: { turn: 1, step: 1, startedAfterSeq: 0 } }); x.consume();
    x.runtime.pushSessionDiagnostic('s1', scheduledRetry()); x.consume();
    notify({ rows: [row('old', '部分旧输出迟到片段')], immediate: true, attempt: { turn: 1, step: 1, startedAfterSeq: 0 } }); x.consume();
    expect(remoteSessionStore.getSessionRunStatus('s1').reconnectAttempt).toEqual({ attempt: 6, maxAttempts: 10 });
    notify({ rows: [], immediate: true, reason: 'abandoned' }); x.consume();
    expect(remoteSessionStore.getSessionRunStatus('s1').reconnectAttempt?.attempt).toBe(6);
    expect(remoteSessionStore.getMessages('s1')).toHaveLength(0);
    x.runtime.pushSessionDiagnostic('s1', startedRetry); x.consume();
    notify({ rows: [row('new', '恢复输出')], immediate: true, attempt: { turn: 1, step: 1, startedAfterSeq: 2 } }); x.consume();
    expect(remoteSessionStore.getSessionRunStatus('s1').reconnectAttempt).toBeNull();
    expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(true);
  } finally { await x.runtime.stop(); }
});

test.each(['waiting', 'started', 'always', 'RATE_LIMIT', 'SERVER', 'TIMEOUT'])('actual mobile cold recovery for %s is honest and message-free', async phase => {
  const events = [turnStart, scheduledRetry(1, phase === 'always' ? { mode: 'always', maxRetries: undefined }
    : ['RATE_LIMIT', 'SERVER', 'TIMEOUT'].includes(phase) ? { failure: { code: phase } } : {})];
  if (phase === 'started') events.push(startedRetry);
  const x = await retryHost(events);
  try {
    expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(true);
    expect(remoteSessionStore.getMessages('s1')).toHaveLength(0);
    expect(remoteSessionStore.getSessionRunStatus('s1').hasTerminalError).not.toBe(true);
    const attempt = remoteSessionStore.getSessionRunStatus('s1').reconnectAttempt;
    if (['waiting', 'started'].includes(phase)) expect(attempt).toEqual({ attempt: 6, maxAttempts: 10 });
    else expect(attempt).toBeNull();
    const failure = { ...event, seq: events.length, time: 1000 + events.length * 1000 };
    events.push(failure); x.reader.noteEvent('s1', failure); x.idle();
    x.runtime.pushTurnIdle('s1', failure); x.runtime.pushTurnIdle('s1', failure);
    const [row] = foldSessionEvent(failure, { sessionId: 's1' });
    await x.runtime.pushSessionMessage('s1', row); x.consume();
    remoteSessionStore.setMessages('s1', wire(await x.reader('s1')));
    remoteSessionStore.applyRemotePush('host', 'local-db:messages:created', wire({ sessionId: 's1', message: row }));
    expect(remoteSessionStore.getMessages('s1')).toHaveLength(1);
    expect(remoteSessionStore.getSessionRunStatus('s1').terminalError?.clientId).toBe(row.clientId);
    expect(remoteSessionStore.getSessionRunStatus('s1').reconnectAttempt).toBeNull();
    expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(false);
  } finally { await x.runtime.stop(); }
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
