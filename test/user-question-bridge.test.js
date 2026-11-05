import test from 'node:test';
import assert from 'node:assert/strict';
import { startHost } from '../src/host.js';
import { FixtureDshSource } from '../src/fixture-source.js';
import { arbitrateInteraction } from '../src/dsh-plugin.js';
import { createApprovalRegistry } from '../src/host-approvals.js';

const ON = { transportEnabled: true, remoteControlEnabled: true, controllers: {} };
const questions = [{ id: 'q1', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }];
const answer = (label) => ({ answers: [{ id: 'q1', selected: [label] }] });
const decision = (label) => ({ kind: 'ask_user_question', answers: { 'Pick one': label } });
const tick = () => new Promise(resolve => setImmediate(resolve));

class Socket {
  handlers = new Map(); sent = []; readyState = 1;
  on(event, fn) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]); return this; }
  emit(event, ...args) { for (const fn of this.handlers.get(event) ?? []) fn(...args); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() {}
  frame(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}

async function setup(t, options = {}, settings = ON) {
  const socket = new Socket();
  const runtime = await startHost(new FixtureDshSource(), settings, {
    resolveSession: async () => ({ ok: true, session: { deviceId: 'host-test', kind: 'phone', identifier: 'test' } }),
    openSocket: () => socket, heartbeatMs: 0, ...options,
  });
  t.after(() => runtime.stop());
  function hello() {
    socket.emit('open');
    socket.frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'host-test', userId: 'test' } });
  }
  let count = 0;
  async function call(channel, args = [], src = 'phone') {
    const id = 'call-' + ++count;
    socket.frame({ v: 1, kind: 'invoke', id, src, payload: { channel, args } });
    await tick(); await tick();
    const reply = socket.sent.find(frame => frame.id === id && frame.kind === 'invoke-result');
    assert.ok(reply, channel + ' must reply');
    assert.equal(reply.payload.ok, true, JSON.stringify(reply.payload));
    return reply.payload.result;
  }
  hello();
  return { runtime, socket, call, hello };
}

function bridge(runtime, request, next) {
  return arbitrateInteraction({ request, next,
    begin: signal => runtime.beginUserQuestion({ sessionId: 's1', questions, signal }),
    settleLocal: (id, value) => runtime.settleInteractionOutcome(id, value),
  });
}

test('a question asked before the first phone visit is listed, replayed and answered', async t => {
  const { runtime, socket, call } = await setup(t);
  let localAbort = false;
  const request = {};
  const result = bridge(runtime, request, () => new Promise((_, reject) => {
    request.signal.addEventListener('abort', () => { localAbort = true; reject(request.signal.reason); }, { once: true });
  }));
  await tick();
  assert.equal(runtime.watchersFor('s1'), 0);
  const pending = await call('maker:get-pending-interactions', ['s1']);
  assert.equal(pending.length, 1);
  const id = pending[0].request.requestId;
  await call('device-link:subscribe', [{ topics: ['session:s1'] }]);
  assert.ok(socket.sent.some(frame => frame.kind === 'push' && frame.payload.channel === 'maker:interaction-request'
    && frame.payload.payload.request.requestId === id));
  assert.deepEqual(await call('maker:resolve-interaction', [id, decision('A')]), { accepted: true });
  assert.deepEqual(await result, answer('A'));
  assert.equal(localAbort, true);
  assert.deepEqual(await call('maker:get-pending-interactions', ['s1']), []);
});

test('a local answer dismisses the phone and refuses a late mobile answer', async t => {
  const { runtime, socket, call } = await setup(t);
  await call('device-link:subscribe', [{ topics: ['session:s1'] }]);
  let local;
  const result = bridge(runtime, {}, () => new Promise(resolve => { local = resolve; }));
  await tick();
  const id = runtime.listPendingInteractions('s1')[0].request.requestId;
  local(answer('B'));
  assert.deepEqual(await result, answer('B'));
  assert.ok(socket.sent.some(frame => frame.kind === 'push' && frame.payload.channel === 'maker:interaction-dismissed'
    && frame.payload.payload.requestId === id));
  assert.deepEqual(await call('maker:resolve-interaction', [id, decision('A')]), { accepted: false });
});

test('a same-tick local callback cannot override a phone answer already accepted by the registry', async () => {
  const registry = createApprovalRegistry();
  const handle = await registry.askUser({ sessionId: 's1', questions });
  const result = arbitrateInteraction({ request: {}, begin: async () => handle,
    next: () => { registry.settle(handle.requestId, decision('A')); return answer('B'); },
    settleLocal: (id, value) => registry.settleOutcome(id, value),
  });
  assert.deepEqual(await result, answer('A'));
});

test('questions survive relay recovery and replay with the same request id', async t => {
  const { runtime, socket, call, hello } = await setup(t);
  const handle = await runtime.beginUserQuestion({ sessionId: 's1', questions });
  const permission = await runtime.beginApproval({ sessionId: 's1', toolName: 'write' });
  assert.equal(permission, null, 'permission ownership remains unchanged');
  socket.emit('close'); // Exercise automatic dropAndRetry, not only direct disconnect.
  await tick(); await tick();
  assert.equal(runtime.listPendingInteractions('s1')[0].request.requestId, handle.requestId);
  // Reconnect through the real runtime connect path, then restore the subscription.
  await runtime.connect(); hello();
  await call('device-link:subscribe', [{ topics: ['session:s1'] }]);
  assert.ok(socket.sent.some(frame => frame.kind === 'push' && frame.payload.channel === 'maker:interaction-request'
    && frame.payload.payload.request.requestId === handle.requestId));
  assert.deepEqual(await call('maker:resolve-interaction', [handle.requestId, decision('B')]), { accepted: true });
  assert.deepEqual(await handle.answered, answer('B'));
});

test('questions have no Host timeout while permission keeps its deadline', async () => {
  const timers = [];
  const registry = createApprovalRegistry({ timeoutMs: 30 * 60_000,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer() {},
  });
  const asked = await registry.askUser({ sessionId: 's1', questions });
  const permission = await registry.ask({ sessionId: 's1', toolName: 'write' });
  assert.deepEqual(timers.map(item => item.ms), [30 * 60_000]);
  timers[0].fn();
  assert.equal(await permission.answered, 'cancelled');
  assert.equal(registry.list('s1')[0].request.requestId, asked.requestId);
  registry.settle(asked.requestId, decision('A'));
  assert.deepEqual(await asked.answered, answer('A'));
});

test('native timeout and cancellation stay typed failures and clear the mobile card', async () => {
  for (const code of ['ASK_TIMED_OUT', 'ASK_CANCELLED']) {
    const registry = createApprovalRegistry();
    const handle = await registry.askUser({ sessionId: 's1', questions });
    const error = Object.assign(new Error(code), { name: 'UserQuestionError', code });
    await assert.rejects(arbitrateInteraction({ request: {}, begin: async () => handle,
      next: async () => { throw error; }, settleLocal: (id, value) => registry.settleOutcome(id, value),
    }), value => value === error);
    assert.deepEqual(registry.list('s1'), []);
  }
});

test('stop task cancels both cards through the original caller signal', async t => {
  const upstream = new AbortController();
  const { runtime, socket, call } = await setup(t, { resolveCapabilities: () => ({
    queueControl: { cancel: async () => upstream.abort(new Error('Stopped by user')) },
  }) });
  await call('device-link:subscribe', [{ topics: ['session:s1'] }]);
  const request = { signal: upstream.signal };
  let nativeAbort = false;
  const result = bridge(runtime, request, () => new Promise((_, reject) => {
    request.signal.addEventListener('abort', () => { nativeAbort = true; reject(request.signal.reason); }, { once: true });
  }));
  const rejected = assert.rejects(result, { name: 'UserQuestionError', code: 'ASK_ABORTED' });
  await tick();
  const id = runtime.listPendingInteractions('s1')[0].request.requestId;
  await call('maker:input:stop', ['s1', { keepQueue: true }]);
  await rejected;
  assert.equal(nativeAbort, true);
  assert.deepEqual(runtime.listPendingInteractions('s1'), []);
  assert.ok(socket.sent.some(frame => frame.kind === 'push' && frame.payload.channel === 'maker:interaction-dismissed'
    && frame.payload.payload.requestId === id));
});

test('an already aborted question never publishes a live card', async () => {
  const events = [];
  const registry = createApprovalRegistry();
  registry.observeUserQuestions(event => events.push(event));
  const signal = AbortSignal.abort();
  const handle = await registry.askUser({ sessionId: 's1', questions, signal });
  await assert.rejects(handle.answered, { code: 'ASK_ABORTED' });
  assert.equal(events.some(event => event.type === 'interaction-request'), false);
  assert.deepEqual(registry.list('s1'), []);
});

test('disabled Host defers to native and immutable requests never create a phone-only card', async t => {
  const { runtime } = await setup(t, {}, { transportEnabled: false, remoteControlEnabled: false, controllers: {} });
  assert.equal(await runtime.beginUserQuestion({ sessionId: 's1', questions }), null);
  let began = false;
  assert.deepEqual(await arbitrateInteraction({ request: Object.freeze({}),
    begin: async () => { began = true; }, next: async () => answer('A'), settleLocal() {},
  }), answer('A'));
  assert.equal(began, false);
});
