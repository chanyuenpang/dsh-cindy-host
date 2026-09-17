import test from 'node:test';
import assert from 'node:assert/strict';
import { FixtureDshSource } from '../src/fixture-source.js';
import { startHost, HEARTBEAT_INTERVAL_MS, RELAY_WS_URL, deviceListUrl } from '../src/host.js';

/** The relay URL a default-configured runtime reports. */
function expectRelayUrl() {
  return RELAY_WS_URL;
}

const OFF = { transportEnabled: false, remoteControlEnabled: false, controllers: {} };
const ON = { transportEnabled: true, remoteControlEnabled: true, controllers: {} };

/** Minimal `ws` stand-in: records outbound frames and replays inbound ones. */
class FakeSocket {
  constructor() {
    this.sent = [];
    this.handlers = new Map();
    this.readyState = 1;
    this.closed = false;
  }

  on(event, handler) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  emit(event, ...args) {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.closed = true;
  }

  last(kind) {
    return [...this.sent].reverse().find((frame) => frame.kind === kind);
  }

  frame(data) {
    this.emit('message', Buffer.from(JSON.stringify(data)));
  }
}

/** A runtime wired to a fake socket and an already-authenticated session. */
async function runtimeWithSocket(options = {}) {
  const socket = new FakeSocket();
  const runtime = await startHost(new FixtureDshSource(), ON, {
    resolveSession: async () => ({ ok: true, session: { deviceId: 'host-handle', kind: 'phone', identifier: '13800000000' } }),
    openSocket: () => socket,
    heartbeatMs: 0,
    ...options,
  });
  return { runtime, socket };
}

test('connects nothing while the phone switch is off', async () => {
  let opened = false;
  const runtime = await startHost(new FixtureDshSource(), OFF, {
    resolveSession: async () => {
      throw new Error('must not authenticate while transport is off');
    },
    openSocket: () => {
      opened = true;
      return new FakeSocket();
    },
  });
  try {
    assert.equal(opened, false);
    assert.equal(runtime.getStatus().state, 'disconnected');
    assert.equal(runtime.getStatus().host, null);
    // The projection feeds the phone, so it is off with the phone.
    assert.equal(runtime.model.list().length, 0);
    assert.equal(typeof runtime.updateSettings, 'function');
  } finally {
    await runtime.stop();
  }
});

test('reports a required login instead of a failure when no Cindy session exists', async () => {
  const runtime = await startHost(new FixtureDshSource(), ON, {
    resolveSession: async () => ({ ok: false, reason: 'missing', message: '本机还没有 Cindy 登录态' }),
    openSocket: () => {
      throw new Error('must not open a socket without a session');
    },
  });
  try {
    const status = runtime.getStatus();
    assert.equal(status.state, 'disconnected');
    assert.equal(status.login.authenticated, false);
    assert.equal(status.login.required, true);
    assert.equal(status.message, '本机还没有 Cindy 登录态');
  } finally {
    await runtime.stop();
  }
});

test('announces controllability so the relay will route the phone, then links it', async () => {
  const { runtime, socket } = await runtimeWithSocket();
  try {
    assert.equal(runtime.getStatus().state, 'authenticating');

    socket.emit('open');
    const hello = socket.last('hello');
    assert.equal(hello.v, 1);
    assert.equal(hello.payload.remoteControlEnabled, true, 'relay only routes link-open to a target that advertised this');
    assert.equal(hello.payload.deviceName, 'DSH Host');

    socket.frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'dev-host', userId: 'user-1' } });
    let status = runtime.getStatus();
    assert.equal(status.state, 'waiting');
    assert.equal(status.host.deviceId, 'dev-host');
    assert.equal(status.host.userId, 'user-1');

    socket.frame({ v: 1, kind: 'presence-changed', payload: { deviceId: 'phone-1', online: true, deviceName: 'Pixel 8', platform: 'android', lastSeenAt: Date.now(), remoteControlEnabled: false, busy: false } });
    status = runtime.getStatus();
    assert.equal(status.devices.length, 1);
    assert.equal(status.devices[0].name, 'Pixel 8');
    assert.equal(status.devices[0].platform, 'android');
    assert.equal(status.state, 'waiting', 'presence alone is not a connection');

    socket.frame({ v: 1, kind: 'link-open', id: 'req-1', src: 'phone-1' });
    status = runtime.getStatus();
    assert.equal(status.state, 'connected');
    assert.equal(status.devices[0].isController, true);
    const accept = socket.last('link-accept');
    assert.equal(accept.id, 'req-1');
    assert.equal(accept.dst, 'phone-1');
    assert.match(accept.payload.allowlistHash, /^[0-9a-f]{8}$/);
    assert.ok(runtime.acceptedControllers.has('phone-1'));
  } finally {
    await runtime.stop();
  }
});

test('serves an allowlisted invoke and links a listing-only controller', async () => {
  const { runtime, socket } = await runtimeWithSocket();
  try {
    socket.emit('open');
    socket.frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'dev-host', userId: 'user-1' } });

    socket.frame({ v: 1, kind: 'invoke', id: 'inv-1', src: 'phone-2', payload: { channel: 'local-db:sessions:list', args: [] } });
    // The channel router is async (it reads the DSH corpus), so the reply lands
    // a tick after the frame, exactly as it does over the real relay.
    await new Promise((resolve) => setImmediate(resolve));
    const result = socket.last('invoke-result');
    assert.equal(result.id, 'inv-1');
    assert.equal(result.dst, 'phone-2');
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.result.length, 2);
    // The wire shape is a flat RemoteSession, not the controller's view model.
    assert.equal(typeof result.payload.result[0].id, 'string');
    assert.equal(runtime.getStatus().state, 'connected');

    socket.frame({ v: 1, kind: 'invoke', id: 'inv-2', src: 'phone-2', payload: { channel: 'fs:read', args: [] } });
    await new Promise((resolve) => setImmediate(resolve));
    const denied = socket.last('invoke-result');
    assert.equal(denied.payload.ok, false);
    assert.equal(denied.payload.error.code, 'CHANNEL_NOT_ALLOWED');
  } finally {
    await runtime.stop();
  }
});

test('answers NOT_AVAILABLE, not a crash, when no session source is attached', async () => {
  const socket = new FakeSocket();
  const runtime = await startHost(undefined, ON, {
    resolveSession: async () => ({ ok: true, session: { deviceId: 'host-handle' } }),
    openSocket: () => socket,
    heartbeatMs: 0,
  });
  try {
    socket.emit('open');
    socket.frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'dev-host', userId: 'user-1' } });
    socket.frame({ v: 1, kind: 'invoke', id: 'inv-1', src: 'phone-2', payload: { channel: 'local-db:sessions:list', args: [] } });
    await new Promise((resolve) => setImmediate(resolve));
    const result = socket.last('invoke-result');
    assert.equal(result.payload.ok, false);
    assert.equal(result.payload.error.code, 'NOT_AVAILABLE', 'an absent capability must be distinguishable from a broken one');
  } finally {
    await runtime.stop();
  }
});

test('a device offline relay error does not mark the Host failed', async () => {
  const { runtime, socket } = await runtimeWithSocket();
  try {
    socket.emit('open');
    socket.frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'dev-host', userId: 'user-1' } });
    assert.equal(runtime.getStatus().state, 'waiting');

    // A push to a phone that just locked its screen is ordinary, not a dead Host.
    socket.frame({ v: 1, kind: 'relay-error', payload: { code: 'DEVICE_OFFLINE', message: 'target device offline' } });
    assert.equal(runtime.getStatus().state, 'waiting', 'the relay link is healthy; only one delivery failed');
    assert.equal(runtime.getStatus().message, 'target device offline');

    socket.frame({ v: 1, kind: 'relay-error', payload: { code: 'VERSION_MISMATCH', message: 'protocol v2 required' } });
    assert.equal(runtime.getStatus().state, 'failed', 'a protocol mismatch is a real connection failure');
  } finally {
    await runtime.stop();
  }
});

test('answers relay ping and clears the device ledger on link-close', async () => {
  const { runtime, socket } = await runtimeWithSocket();
  try {
    socket.emit('open');
    socket.frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'dev-host', userId: 'user-1' } });
    socket.frame({ v: 1, kind: 'link-open', id: 'req-1', src: 'phone-1' });
    assert.equal(runtime.getStatus().state, 'connected');

    socket.frame({ v: 1, kind: 'ping' });
    assert.equal(socket.last('pong').kind, 'pong');
    assert.ok(socket.last('pong').v === 1);

    socket.frame({ v: 1, kind: 'link-close', src: 'phone-1', payload: { reason: 'user' } });
    assert.equal(runtime.acceptedControllers.has('phone-1'), false);
    assert.equal(runtime.getStatus().state, 'waiting');
  } finally {
    await runtime.stop();
  }
});

test('ignores unknown frames and relay frames from a revoked device', async () => {
  const socket = new FakeSocket();
  const runtime = await startHost(new FixtureDshSource(), { ...ON, controllers: { 'phone-1': { state: 'revoked' } } }, {
    resolveSession: async () => ({ ok: true, session: { deviceId: 'host-handle' } }),
    openSocket: () => socket,
    heartbeatMs: 0,
  });
  try {
    socket.emit('open');
    socket.frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'dev-host', userId: 'user-1' } });
    socket.frame({ v: 1, kind: 'something-new', payload: {} });
    assert.equal(runtime.getStatus().state, 'waiting');
    socket.frame({ v: 1, kind: 'link-open', id: 'req-1', src: 'phone-1' });
    assert.equal(runtime.getStatus().state, 'waiting');
    assert.equal(socket.last('link-accept'), undefined);
  } finally {
    await runtime.stop();
  }
});

test('turning the switch off closes the socket and forgets devices', async () => {
  const { runtime, socket } = await runtimeWithSocket();
  try {
    socket.emit('open');
    socket.frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'dev-host', userId: 'user-1' } });
    socket.frame({ v: 1, kind: 'link-open', id: 'req-1', src: 'phone-1' });
    assert.equal(runtime.model.list().length, 2);
    assert.equal(runtime.projectionRunning, true);

    await runtime.updateSettings(OFF);

    const status = runtime.getStatus();
    assert.equal(status.state, 'disconnected');
    assert.equal(status.host, null);
    assert.equal(status.devices.length, 0);
    assert.equal(runtime.subscribers.size, 0);
    assert.equal(runtime.acceptedControllers.size, 0);
    assert.equal(runtime.projectionRunning, false, 'the projection feeds the phone, so it stops with the phone');
    assert.equal(socket.closed, true);
  } finally {
    await runtime.stop();
  }
});

test('pushes a live message only to the controllers watching that session', async () => {
  const { runtime, socket } = await runtimeWithSocket();
  try {
    socket.emit('open');
    socket.frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'dev-host', userId: 'user-1' } });

    // Nothing is watching yet: the push must go nowhere rather than to everyone.
    assert.equal(runtime.watchersFor('s1'), 0);
    runtime.pushSessionMessage('s1', { id: 'm1' });
    assert.equal(socket.sent.filter((frame) => frame.kind === 'push').length, 0);

    socket.frame({ v: 1, kind: 'invoke', id: 'sub-1', src: 'phone-2', payload: { channel: 'device-link:subscribe', args: [{ topics: ['sessions', 'session:s1'] }] } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.watchersFor('s1'), 1);
    assert.equal(runtime.watchersFor('s2'), 0);

    // Attaching to a session that is not running is answered with an explicit
    // terminal event: the controller clears its spinner only on one of those (a
    // session merely absent from `maker:list-active` is not read as idle), so a
    // steered row whose turn never started would otherwise spin forever.
    //
    // The row patch rides alongside it. A **list** spinner reads the cached row
    // rather than the turn event, so the terminal event alone left the controller
    // holding `running: true` on the row it already had — the reported "agent 已经
    // 结束了，但我这边还是显示 思考中". Both frames are asserted, each exactly once:
    // a controller holds the list topic and this session's topic at the same time,
    // and it is still one reader of one row.
    const announced = socket.sent.filter((frame) => frame.kind === 'push');
    assert.equal(announced.length, 2, 'the new watcher is told the turn state, once');
    assert.deepEqual(announced.map((frame) => frame.payload.channel), ['maker:event', 'local-db:sessions:patched']);
    assert.deepEqual(announced[0].payload.payload.event, { type: 'done' });
    // Exactly what the controller's `local-db:sessions:patched` handler reads.
    assert.equal(announced[1].payload.payload.sessionId, 's1');
    assert.equal(announced[1].payload.payload.patch.running, false);
    assert.ok(announced.every((frame) => frame.dst === 'phone-2'), 'a session patch is addressed to its readers');

    runtime.pushSessionMessage('s1', { id: 'm1', role: 'assistant', content: { text: 'hi' } });
    const pushes = socket.sent.filter((frame) => frame.kind === 'push');
    assert.equal(pushes.length, 3);
    const messagePush = pushes[pushes.length - 1];
    assert.equal(messagePush.dst, 'phone-2', 'a session push is addressed to its watcher');
    // Exactly what the controller's `local-db:messages:created` handler reads.
    assert.equal(messagePush.payload.channel, 'local-db:messages:created');
    assert.equal(messagePush.payload.payload.sessionId, 's1');
    assert.equal(messagePush.payload.payload.message.id, 'm1');

    // A session nobody watches must not leak into another session's stream.
    runtime.pushSessionMessage('s2', { id: 'm2' });
    assert.equal(socket.sent.filter((frame) => frame.kind === 'push').length, 3);

    // Unsubscribing, or the socket going away, stops the stream.
    socket.frame({ v: 1, kind: 'invoke', id: 'unsub-1', src: 'phone-2', payload: { channel: 'device-link:unsubscribe', args: [{ topics: ['session:s1'] }] } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.watchersFor('s1'), 0);
  } finally {
    await runtime.stop();
  }
});

test('a finished turn patches the row for a controller that is only holding the list', async () => {
  // The reported bug, in the shape the phone actually has it: the session list
  // spin. A controller holding only `sessions` never receives the session-scoped
  // `maker:event`, so the row it cached at the optimistic start kept
  // `running: true` and the list went on saying 思考中 after the agent had
  // finished — including when a goal round ended.
  const { runtime, socket } = await runtimeWithSocket();
  try {
    socket.emit('open');
    socket.frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'dev-host', userId: 'user-1' } });
    socket.frame({ v: 1, kind: 'invoke', id: 'sub-1', src: 'phone-3', payload: { channel: 'device-link:subscribe', args: [{ topics: ['sessions'] }] } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.watchersFor('s1'), 0, 'the list holder is not a watcher of the session');
    const before = socket.sent.filter((frame) => frame.kind === 'push').length;

    runtime.pushTurnIdle('s1');

    const pushes = socket.sent.filter((frame) => frame.kind === 'push').slice(before);
    // Two frames, and both are load-bearing for a controller that holds only the list:
    // the terminal event (a subscription that died with the process leaves a spinner with
    // nothing to end it — reported as 手机一直显示思考中，5 分钟都没抓到最新的信息), and the
    // row patch the list's own badge reads.
    assert.deepEqual(pushes.map((frame) => frame.payload.channel), ['maker:event', 'local-db:sessions:patched']);
    assert.ok(pushes.every((frame) => frame.dst === 'phone-3'), 'only the controller that linked is told');
    assert.deepEqual(pushes[0].payload.payload, { sessionId: 's1', event: { type: 'done' } });
    assert.equal(pushes[1].payload.payload.sessionId, 's1');
    assert.equal(pushes[1].payload.payload.patch.running, false);
    assert.equal(typeof pushes[1].payload.payload.patch.updatedAt, 'string');

    // And the other direction: nobody is told anything twice.
    socket.frame({ v: 1, kind: 'invoke', id: 'sub-2', src: 'phone-3', payload: { channel: 'device-link:subscribe', args: [{ topics: ['session:s1'] }] } });
    await new Promise((resolve) => setImmediate(resolve));
    const both = socket.sent.filter((frame) => frame.kind === 'push').length;
    runtime.pushTurnIdle('s1');
    const after = socket.sent.filter((frame) => frame.kind === 'push').slice(both);
    const channels = after.filter((frame) => frame.dst === 'phone-3').map((frame) => frame.payload.channel);
    assert.deepEqual(channels, ['maker:event', 'local-db:sessions:patched'], 'a controller holding both topics reads one row patch, not two');
  } finally {
    await runtime.stop();
  }
});

test('a controller archives a session, and every device holding the row is patched once', async () => {
  // The three actions DSH has no concept of (删除/归档/置顶) are the Host's own
  // bookkeeping. This is the whole path a controller depends on: the write lands in
  // the settings section, the reply row carries the status (the controller reverts
  // the edit if it does not), the row leaves the live list, and the other controller
  // watching the list is told — once, not once per topic.
  const saved = [];
  const { runtime, socket } = await runtimeWithSocket({ persistSessionFlags: async (flags) => saved.push(flags) });
  try {
    socket.emit('open');
    socket.frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'dev-host', userId: 'user-1' } });
    /** Send one invoke and read the reply the relay would deliver. */
    async function invoke(id, src, channel, args) {
      socket.frame({ v: 1, kind: 'invoke', id, src, payload: { channel, args } });
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        const hit = socket.sent.find((frame) => frame.kind === 'invoke-result' && frame.id === id);
        if (hit !== undefined) return hit;
      }
      throw new Error(`no reply to ${channel}; status=${JSON.stringify(runtime.getStatus())}; frames: ${JSON.stringify(socket.sent.map((frame) => ({ kind: frame.kind, id: frame.id, code: frame.payload?.error?.code }))).slice(0, 400)}`);
    }

    // The laptop holds the list topic; the phone holds both.
    await invoke('sub-1', 'laptop-1', 'device-link:subscribe', [{ topics: ['sessions'] }]);
    await invoke('sub-2', 'phone-2', 'device-link:subscribe', [{ topics: ['sessions', 'session:dsh-host-demo'] }]);
    const before = socket.sent.length;

    const reply = await invoke('req-1', 'phone-2', 'local-db:sessions:patch-meta', ['dsh-host-demo', { status: 'archived', pinnedAt: null }]);

    assert.equal(reply.payload.ok, true);
    assert.equal(reply.payload.result.status, 'archived', 'the reply is what the controller applies');
    assert.deepEqual(saved, [{ 'dsh-host-demo': { status: 'archived' } }], 'the flag is persisted through the settings section');

    const patches = socket.sent.slice(before)
      .filter((frame) => frame.kind === 'push' && frame.payload.channel === 'local-db:sessions:patched')
      .map((frame) => ({ dst: frame.dst, patch: frame.payload.payload.patch }));
    assert.deepEqual(patches, [
      { dst: 'laptop-1', patch: { status: 'archived', pinnedAt: null, updatedAt: patches[0].patch.updatedAt } },
      { dst: 'phone-2', patch: { status: 'archived', pinnedAt: null, updatedAt: patches[0].patch.updatedAt } },
    ], 'one frame per controller, and the phone is not told twice for holding two topics');

    // The hidden row is out of the live list, and out of the phone's list read. The
    // fixture's only running session is the archived one, so the live list goes empty:
    // an entry for a row the phone does not show would light its running badge.
    const active = await invoke('req-2', 'phone-2', 'maker:list-active', []);
    assert.deepEqual(active.payload.result, [], 'the archived session cannot light a badge');
    const list = await invoke('req-3', 'phone-2', 'local-db:sessions:list', []);
    assert.equal(list.payload.result.find((row) => row.id === 'dsh-host-demo').status, 'archived');

    // And the flag is still there after a settings round trip, which is what makes the
    // hide survive a restart instead of silently reappearing.
    await runtime.updateSettings({ ...ON, sessionFlags: { 'dsh-host-demo': { status: 'archived' } } });
    const again = await invoke('req-4', 'phone-2', 'local-db:sessions:list', []);
    assert.equal(again.payload.result.find((row) => row.id === 'dsh-host-demo').status, 'archived');

    // 恢复: `active` leaves the row back on every live surface.
    const restored = await invoke('req-5', 'phone-2', 'local-db:sessions:patch-meta', ['dsh-host-demo', { status: 'active' }]);
    assert.equal(restored.payload.result.status, 'active');
    assert.deepEqual(saved[saved.length - 1], {}, 'a restored session leaves no flag behind');
    const back = await invoke('req-6', 'phone-2', 'maker:list-active', []);
    assert.deepEqual(back.payload.result, [{ sessionId: 'dsh-host-demo', isTurnRunning: true }], 'the restored session is live again');
  } finally {
    await runtime.stop();
  }
});

test('a dropped relay socket comes back on its own, because nobody is at the desk', async () => {
  // The reported failure: the relay dropped, the Host reported `failed` and stopped, and
  // the phone had no DSH in its device list until a person pressed reconnect. A
  // phone-controlled Host cannot work that way — the reference is the Cindy client, which
  // keeps a `connecting` status and retries with backoff forever.
  const timers = [];
  const sockets = [new FakeSocket(), new FakeSocket()];
  let opened = 0;
  const runtime = await startHost(new FixtureDshSource(), ON, {
    resolveSession: async () => ({ ok: true, session: { deviceId: 'host-handle', kind: 'phone', identifier: '13800000000' } }),
    openSocket: () => sockets[opened++],
    heartbeatMs: 0,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      if (timer !== null && typeof timer === 'object') timer.cleared = true;
    },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  try {
    sockets[0].emit('open');
    sockets[0].frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'dev-host', userId: 'user-1' } });
    assert.equal(runtime.getStatus().state, 'waiting');
    assert.deepEqual(runtime.getReconnectState(), { attempts: 0, pending: false, lastReason: null });

    // The relay goes away under us.
    sockets[0].emit('close');
    await settle();
    await settle();

    const status = runtime.getStatus();
    assert.notEqual(status.state, 'failed', 'a lost socket is not a terminal state');
    assert.equal(status.state, 'connecting');
    assert.match(status.message, /自动重连/);
    const state = runtime.getReconnectState();
    assert.equal(state.pending, true, 'a retry is queued');
    assert.equal(state.attempts, 1);
    assert.match(String(state.lastReason), /连接已断开/);

    // The first retry is the base delay with downward jitter, never an instant loop.
    const retry = timers.find((timer) => timer.cleared !== true && timer.ms > 0);
    assert.ok(retry.ms >= 700 && retry.ms <= 1_000, `first retry waits ${retry.ms}ms`);

    // Firing it re-opens the socket without any call from a person.
    await retry.fn();
    await settle();
    assert.equal(opened, 2, 'the Host reconnected by itself');
    sockets[1].emit('open');
    sockets[1].frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'dev-host', userId: 'user-1' } });
    assert.equal(runtime.getStatus().state, 'waiting');
    assert.equal(runtime.getReconnectState().pending, false);

    // Ten seconds of a held connection forgets the ladder, so a Host that flapped for a
    // week still retries in a second once the link is healthy.
    assert.equal(runtime.getReconnectState().attempts, 1);
    const stable = timers.filter((timer) => timer.ms === 10_000 && timer.cleared !== true);
    assert.equal(stable.length, 1, 'the stable-reset timer is armed on a live connection');
    await stable[0].fn();
    assert.equal(runtime.getReconnectState().attempts, 0);
  } finally {
    await runtime.stop();
  }
});

test('reconnecting stops when the user turns the phone link off', async () => {
  // The retry must never fight the switch: an explicit off means off.
  const timers = [];
  const socket = new FakeSocket();
  const runtime = await startHost(new FixtureDshSource(), ON, {
    resolveSession: async () => ({ ok: true, session: { deviceId: 'host-handle', kind: 'phone', identifier: '13800000000' } }),
    openSocket: () => socket,
    heartbeatMs: 0,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      if (timer !== null && typeof timer === 'object') timer.cleared = true;
    },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  try {
    socket.emit('open');
    socket.frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'dev-host', userId: 'user-1' } });
    socket.emit('close');
    await settle();
    await settle();
    const queued = timers.find((timer) => timer.ms > 0 && timer.cleared !== true);
    assert.ok(queued !== undefined, 'a retry was queued first');

    await runtime.updateSettings(OFF);
    assert.equal(queued.cleared, true, 'turning the switch off cancels the queued retry');
    assert.equal(runtime.getReconnectState().pending, false);
    assert.equal(runtime.getStatus().state, 'disconnected');
  } finally {
    await runtime.stop();
  }
});

test('a socket that cannot even be created is retried instead of reported dead', async () => {
  // Booting before the network is up is the ordinary version of this, and it used to
  // leave the Host `failed` until somebody noticed.
  const timers = [];
  const socket = new FakeSocket();
  let attempts = 0;
  const runtime = await startHost(new FixtureDshSource(), ON, {
    resolveSession: async () => ({ ok: true, session: { deviceId: 'host-handle', kind: 'phone', identifier: '13800000000' } }),
    openSocket: () => {
      attempts += 1;
      if (attempts === 1) throw new Error('network down');
      return socket;
    },
    heartbeatMs: 0,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      if (timer !== null && typeof timer === 'object') timer.cleared = true;
    },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  try {
    await settle();
    assert.equal(runtime.getStatus().state, 'connecting');
    assert.match(runtime.getStatus().message, /无法建立/);
    const retry = timers.find((timer) => timer.ms > 0 && timer.cleared !== true);
    await retry.fn();
    await settle();
    assert.equal(attempts, 2, 'the second attempt really opened a socket');
    socket.emit('open');
    socket.frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'dev-host', userId: 'user-1' } });
    assert.equal(runtime.getStatus().state, 'waiting');
  } finally {
    await runtime.stop();
  }
});

test('a file on this machine can be exported to a controller, and nothing outside the workdir can', async () => {
  // The reported "取图失败": an image the agent produced lives on this machine, and the
  // controller's only way to see it is `file-browser:remote-op`'s export pair — start
  // answers a transfer id immediately, the upload happens behind the reply, and the status
  // poll carries the key the controller downloads.
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const workdir = await mkdtemp(join(tmpdir(), 'dsh-export-'));
  await writeFile(join(workdir, 'cat.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  // The file the escape tries to reach has to *exist*: a missing path fails at
  // `realpath` and answers NOT_FOUND, so without it the containment check under test
  // is never the one that refuses.
  const outside = join(workdir, '..', `dsh-export-secret-${process.pid}.png`);
  await writeFile(outside, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]));

  const staged = [];
  const fetchImpl = async (url, init = {}) => {
    // `hello-ack` also triggers the device directory read; the staging double must answer
    // it, or that unrelated call fails its way through every later step.
    if (String(url).endsWith('/devices')) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => [] };
    }
    if (String(url).endsWith('/media/presign-put')) {
      staged.push({ step: 'presign', body: JSON.parse(String(init.body)) });
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ putUrl: 'https://oss.example/put', key: 'cindy/device-link/u/cat.png' }) };
    }
    staged.push({ step: 'put', headers: init.headers, size: init.body?.length });
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) };
  };

  const socket = new FakeSocket();
  const runtime = await startHost(new FixtureDshSource(), ON, {
    // The staging upload rides this Host's own account session, so the fake one needs a
    // token: without it the uploader refuses with `no-credential` (which is the point of
    // that check).
    resolveSession: async () => ({ ok: true, session: { deviceId: 'host-handle', kind: 'phone', identifier: '13800000000', accessToken: 'tok-host' } }),
    openSocket: () => socket,
    heartbeatMs: 0,
    fetch: fetchImpl,
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 2));
  try {
    socket.emit('open');
    socket.frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'dev-host', userId: 'user-1' } });
    async function invoke(id, channel, args) {
      socket.frame({ v: 1, kind: 'invoke', id, src: 'phone-2', payload: { channel, args } });
      // A wall-clock budget, not an iteration count: the refusal paths do real
      // filesystem work (`realpath` on a missing path costs tens of milliseconds on
      // Windows), so counting microtask turns gives up before the Host has answered.
      for (let attempt = 0; attempt < 250; attempt += 1) {
        await settle();
        const hit = socket.sent.find((frame) => frame.kind === 'invoke-result' && frame.id === id);
        if (hit !== undefined) return hit;
      }
      throw new Error(`no reply to ${channel}; status=${JSON.stringify(runtime.getStatus())}; frames: ${JSON.stringify(socket.sent.map((frame) => ({ kind: frame.kind, id: frame.id, code: frame.payload?.error?.code }))).slice(0, 400)}; serviced: ${JSON.stringify(runtime.getInvokeLog().slice(-4))}`);
    }

    const started = await invoke('exp-1', 'file-browser:remote-op', [{ op: 'exportFileStart', workdir, relPath: 'cat.png' }]);
    assert.equal(started.payload.ok, true, JSON.stringify(started.payload.error ?? null));
    assert.match(started.payload.result.transferId, /^exp_/);
    assert.equal(started.payload.result.size, 4);

    // The upload runs behind the reply; the poll is what the controller waits on.
    let status = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await settle();
      const polled = await invoke(`exp-s-${attempt}`, 'file-browser:remote-op', [{ op: 'exportFileStatus', workdir, transferId: started.payload.result.transferId }]);
      status = polled.payload.result;
      if (status?.state !== 'uploading') break;
    }
    assert.equal(status.state, 'done', `staging said: ${String(status.message ?? '')} | staged=${JSON.stringify(staged)}`);
    assert.equal(status.key, 'cindy/device-link/u/cat.png');
    assert.equal(status.size, 4);
    assert.deepEqual(staged.map((entry) => entry.step), ['presign', 'put']);
    assert.deepEqual(staged[0].body, { size: 4, ext: 'png', contentType: 'image/png' });
    // `x-oss-object-acl: private` is signed into the presigned url: without it OSS answers
    // 403, which is how the first version of the probe failed.
    assert.equal(staged[1].headers['x-oss-object-acl'], 'private');

    // Reading *out* of the workdir is refused, by `..` and by absolute path alike.
    const escaped = await invoke('exp-2', 'file-browser:remote-op', [{ op: 'exportFileStart', workdir, relPath: `../${outside.split(/[\\/]/).pop()}` }]);
    assert.equal(escaped.payload.ok, false);
    assert.equal(escaped.payload.error.code, 'FORBIDDEN');
    const absolute = await invoke('exp-3', 'file-browser:remote-op', [{ op: 'exportFileStart', workdir, relPath: 'C:\\Windows\\win.ini' }]);
    assert.equal(absolute.payload.error.code, 'BAD_REQUEST');

    // An unknown transfer is refused the way the reference refuses it.
    const unknown = await invoke('exp-4', 'file-browser:remote-op', [{ op: 'exportFileStatus', workdir, transferId: 'exp_nope' }]);
    assert.equal(unknown.payload.error.code, 'NOT_FOUND');
  } finally {
    await runtime.stop();
    await rm(workdir, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

test('a controller that re-links is told which sessions are in a turn', async () => {
  // Subscriptions live in this process's memory, so a Host restart empties them while the
  // controller still believes it is inside a session — reported as 手机一直显示思考中，
  // 5 分钟都没抓到最新的信息, with no terminal event that could end the spinner.
  const { runtime, socket } = await runtimeWithSocket({ persistSessionFlags: async () => {} });
  try {
    socket.emit('open');
    socket.frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'dev-host', userId: 'user-1' } });
    // Learn the listing so the cached rows say which session runs (the fixture's demo one).
    socket.frame({ v: 1, kind: 'invoke', id: 'list-1', src: 'phone-2', payload: { channel: 'local-db:sessions:list', args: [] } });
    await new Promise((resolve) => setImmediate(resolve));
    const before = socket.sent.length;

    socket.frame({ v: 1, kind: 'link-open', id: 'link-2', src: 'phone-2' });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const events = socket.sent.slice(before).filter((frame) => frame.kind === 'push' && frame.payload.channel === 'maker:event');
    assert.deepEqual(events.map((frame) => frame.dst), ['phone-2'], 'told directly, without a subscription');
    assert.deepEqual(events.map((frame) => frame.payload.payload), [
      { sessionId: 'dsh-host-demo', event: { type: 'status', data: { isRunning: true } } },
    ]);
  } finally {
    await runtime.stop();
  }
});

test('turning the switch off forgets every subscription', async () => {
  const { runtime, socket } = await runtimeWithSocket();
  try {
    socket.emit('open');
    socket.frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'dev-host', userId: 'user-1' } });
    socket.frame({ v: 1, kind: 'invoke', id: 'sub-1', src: 'phone-2', payload: { channel: 'device-link:subscribe', args: [{ topics: ['sessions', 'session:s1'] }] } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.watchersFor('s1'), 1);

    await runtime.updateSettings(OFF);
    assert.equal(runtime.watchersFor('s1'), 0);
    assert.equal(runtime.subscribers.size, 0);
  } finally {
    await runtime.stop();
  }
});

test('a session the controller attached to keeps its cards answerable after it looks away', async () => {
  // "Currently watching" and "belongs to the phone" are different questions. A user
  // who starts a turn from the phone and then leaves the session unsubscribes its
  // topic, and a question asked in that window used to be handed to the Web
  // bundle's remote forwarder — measured: `pending []` while unwatched, still `[]`
  // after re-subscribing, session `running` forever, no card anywhere the user was
  // looking. A session this Host has served stays claimable; a session it never
  // served is still the desk's.
  const { runtime, socket } = await runtimeWithSocket();
  try {
    socket.emit('open');
    socket.frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'dev-host', userId: 'user-1' } });

    assert.equal(
      await runtime.askApproval({ sessionId: 's-untouched', toolName: 'write_file' }),
      null,
      'a session no controller has ever attached to belongs to the desk',
    );

    socket.frame({ v: 1, kind: 'invoke', id: 'sub-1', src: 'phone-2', payload: { channel: 'device-link:subscribe', args: [{ topics: ['session:s1'] }] } });
    await new Promise((resolve) => setImmediate(resolve));
    socket.frame({ v: 1, kind: 'invoke', id: 'unsub-1', src: 'phone-2', payload: { channel: 'device-link:unsubscribe', args: [{ topics: ['session:s1'] }] } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.watchersFor('s1'), 0, 'the controller has looked away');

    const answer = runtime.askApproval({ sessionId: 's1', toolName: 'write_file' });
    await new Promise((resolve) => setImmediate(resolve));

    const listed = runtime.listPendingInteractions('s1');
    assert.equal(listed.length, 1, 'the card is still the phone user’s to answer');

    socket.frame({ v: 1, kind: 'invoke', id: 'res-1', src: 'phone-2', payload: { channel: 'maker:resolve-interaction', args: [listed[0].request.requestId, { kind: 'permission', behavior: 'allow' }] } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await answer, 'allowed-once');
    assert.equal(runtime.listPendingInteractions('s1').length, 0);
  } finally {
    await runtime.stop();
  }
});

test('invoke totals are monotonic, so channel coverage survives a churning ring', async () => {
  // `recentInvokes` holds forty entries and a controller polling a transcript
  // evicts it within seconds. "Has this channel ever been asked for" is therefore
  // unanswerable from the ring — and that question is what separates a feature that
  // is exercised from one that is merely implemented.
  const { runtime, socket } = await runtimeWithSocket();
  try {
    socket.emit('open');
    socket.frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'dev-host', userId: 'user-1' } });

    const invoke = (id, channel, args) => socket.frame({ v: 1, kind: 'invoke', id, src: 'phone-2', payload: { channel, args } });
    invoke('i1', 'local-db:sessions:list');
    invoke('i2', 'local-db:sessions:list');
    invoke('i3', 'maker:list-agent-skills', ['pi', {}]);
    invoke('i4', 'totally:unknown');
    await new Promise((resolve) => setImmediate(resolve));

    const totals = runtime.getInvokeTotals();
    assert.equal(totals['local-db:sessions:list'], 2, 'every serve counts, not just the ring');
    assert.equal(totals['maker:list-agent-skills'], 1);
    assert.equal(totals['totally:unknown'], 1, 'a refused channel is still an ask');
    assert.equal(runtime.getRefusalTotals()['totally:unknown'], 1);
    assert.equal(runtime.getRefusalTotals()['local-db:sessions:list'], undefined, 'served channels are not refusals');

    // Serving many more of one channel only ever adds: the ring may churn, the
    // tally never goes down.
    for (let index = 0; index < 60; index += 1) invoke(`bulk-${index}`, 'local-db:sessions:list');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.getInvokeTotals()['local-db:sessions:list'], 62);
    assert.ok(
      runtime.getInvokeLog().length < 62,
      'the ring is bounded, which is exactly why the tally has to exist',
    );
  } finally {
    await runtime.stop();
  }
});

test('asks a watching controller to decide a DSH approval, and defers when none watches', async () => {
  const { runtime, socket } = await runtimeWithSocket();
  try {
    socket.emit('open');
    socket.frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'dev-host', userId: 'user-1' } });

    // Nobody is watching: the answerer must be told to pass the question on, so
    // the local UI (or DSH's fail-closed default) decides instead.
    assert.equal(await runtime.askApproval({ sessionId: 's1', toolName: 'write_file' }), null);

    socket.frame({ v: 1, kind: 'invoke', id: 'sub-1', src: 'phone-2', payload: { channel: 'device-link:subscribe', args: [{ topics: ['session:s1'] }] } });
    await new Promise((resolve) => setImmediate(resolve));

    const answer = runtime.askApproval({ sessionId: 's1', toolName: 'write_file', reason: 'needs write' });
    await new Promise((resolve) => setImmediate(resolve));

    // The question reached the controller as a push, and in the shape its handler reads:
    // `{ sessionId, request }` with the request **nested**. Both clients do
    // `isRecord(payload.request) ? payload.request : null` and drop anything else in
    // silence, so asserting a flat `payload.kind` here is what let a real handset receive
    // frames that rendered nothing.
    const ask = socket.sent.filter((frame) => frame.kind === 'push' && frame.payload.channel === 'maker:interaction-request');
    assert.equal(ask.length, 1);
    assert.equal(ask[0].dst, 'phone-2');
    assert.equal(ask[0].payload.payload.sessionId, 's1');
    assert.equal(ask[0].payload.payload.request.kind, 'permission');
    assert.equal(ask[0].payload.payload.request.toolName, 'write_file');
    assert.equal(ask[0].payload.payload.request.sessionId, 's1');

    const listed = runtime.listPendingInteractions('s1');
    assert.equal(listed.length, 1);
    const requestId = listed[0].request.requestId;

    socket.frame({ v: 1, kind: 'invoke', id: 'res-1', src: 'phone-2', payload: { channel: 'maker:resolve-interaction', args: [requestId, { kind: 'permission', behavior: 'allow' }] } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await answer, 'allowed-once', 'the controller answer becomes DSH’s outcome');
    assert.equal(runtime.listPendingInteractions('s1').length, 0);
  } finally {
    await runtime.stop();
  }
});

test('turning the switch off cancels a question the controller can no longer answer', async () => {
  const { runtime, socket } = await runtimeWithSocket();
  try {
    socket.emit('open');
    socket.frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'dev-host', userId: 'user-1' } });
    socket.frame({ v: 1, kind: 'invoke', id: 'sub-1', src: 'phone-2', payload: { channel: 'device-link:subscribe', args: [{ topics: ['session:s1'] }] } });
    await new Promise((resolve) => setImmediate(resolve));

    const answer = runtime.askApproval({ sessionId: 's1', toolName: 'write_file' });
    await new Promise((resolve) => setImmediate(resolve));

    await runtime.updateSettings(OFF);
    assert.equal(await answer, 'cancelled', 'a question over a link that is going away cannot stay open');
    assert.equal(runtime.listPendingInteractions().length, 0);
  } finally {
    await runtime.stop();
  }
});

test('exposes the heartbeat period the Cindy client uses', () => {
  assert.equal(HEARTBEAT_INTERVAL_MS, 20_000);
});

test('derives the device directory URL from the relay WebSocket URL', () => {
  assert.equal(deviceListUrl('wss://device-link.cindy.com.cn/api/device-link/ws'), 'https://device-link.cindy.com.cn/api/device-link/devices');
  assert.equal(deviceListUrl('ws://localhost:3335/api/device-link/ws'), 'http://localhost:3335/api/device-link/devices');
  assert.equal(deviceListUrl(), 'https://device-link.cindy.com.cn/api/device-link/devices');
});

test('names devices the account already had, and skips this Host itself', async () => {
  const socket = new FakeSocket();
  let announced = null;
  const runtime = await startHost(new FixtureDshSource(), ON, {
    resolveSession: async () => ({ ok: true, session: { deviceId: 'host-handle' } }),
    openSocket: () => socket,
    heartbeatMs: 0,
    listDevices: async (session, relayUrl) => {
      announced = { accessToken: session.accessToken, relayUrl };
      return {
        devices: [
          { deviceId: 'dev-host', name: 'DSH Host', platform: 'win32', online: true, isSelf: true },
          { deviceId: 'phone-9', name: '', selfName: 'Alice’s Pixel', platform: 'android', online: true, lastSeenAt: '2026-01-01T00:00:00.000Z' },
          { deviceId: 'laptop-1', name: 'Laptop', platform: 'darwin', online: false },
          { deviceId: '', name: 'broken' },
        ],
      };
    },
  });
  try {
    socket.emit('open');
    socket.frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'dev-host', userId: 'user-1' } });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(announced.relayUrl, expectRelayUrl(), 'the directory is read from the same relay the socket uses');
    const devices = runtime.getStatus().devices;
    assert.deepEqual(devices.map((device) => device.deviceId).sort(), ['laptop-1', 'phone-9']);
    const phone = devices.find((device) => device.deviceId === 'phone-9');
    assert.equal(phone.name, 'Alice’s Pixel', 'selfName wins over an empty profile name');
    assert.equal(phone.platform, 'android');
    assert.equal(phone.online, true);
    assert.equal(phone.lastSeenAt, '2026-01-01T00:00:00.000Z');
  } finally {
    await runtime.stop();
  }
});

test('a failing device directory read never breaks the connection', async () => {
  const socket = new FakeSocket();
  const runtime = await startHost(new FixtureDshSource(), ON, {
    resolveSession: async () => ({ ok: true, session: { deviceId: 'host-handle' } }),
    openSocket: () => socket,
    heartbeatMs: 0,
    listDevices: async () => {
      throw new Error('directory unavailable');
    },
  });
  try {
    socket.emit('open');
    socket.frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'dev-host', userId: 'user-1' } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.getStatus().state, 'waiting');
    assert.deepEqual(runtime.getStatus().devices, []);
  } finally {
    await runtime.stop();
  }
});

test('asks the directory to name a controller that linked without presence', async () => {
  const socket = new FakeSocket();
  let reads = 0;
  const runtime = await startHost(new FixtureDshSource(), ON, {
    resolveSession: async () => ({ ok: true, session: { deviceId: 'host-handle' } }),
    openSocket: () => socket,
    heartbeatMs: 0,
    // An empty (or unrecognized) directory: the controller stays a bare id.
    listDevices: async () => {
      reads += 1;
      return { devices: [] };
    },
  });
  try {
    socket.emit('open');
    socket.frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'dev-host', userId: 'user-1' } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads, 1);

    socket.frame({ v: 1, kind: 'link-open', id: 'req-1', src: 'phone-1' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads, 2, 'an unnamed controller triggers one more directory read');

    const device = runtime.getStatus().devices.find((row) => row.deviceId === 'phone-1');
    assert.equal(device.isController, true);
    assert.equal(device.platform, null);
    assert.equal(runtime.getStatus().state, 'connected');
  } finally {
    await runtime.stop();
  }
});

test('does not re-read the directory for a controller it already named', async () => {
  const socket = new FakeSocket();
  let reads = 0;
  const runtime = await startHost(new FixtureDshSource(), ON, {
    resolveSession: async () => ({ ok: true, session: { deviceId: 'host-handle' } }),
    openSocket: () => socket,
    heartbeatMs: 0,
    listDevices: async () => {
      reads += 1;
      return { devices: [{ deviceId: 'phone-1', name: 'Pixel 8', platform: 'android', online: true }] };
    },
  });
  try {
    socket.emit('open');
    socket.frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'dev-host', userId: 'user-1' } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads, 1);

    socket.frame({ v: 1, kind: 'link-open', id: 'req-1', src: 'phone-1' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads, 1, 'a device the directory already named needs no second read');

    const device = runtime.getStatus().devices.find((row) => row.deviceId === 'phone-1');
    assert.equal(device.name, 'Pixel 8');
    assert.equal(device.platform, 'android');
    assert.equal(device.isController, true, 'a directory read must not clear the controller flag');
    assert.equal(runtime.getStatus().state, 'connected');
  } finally {
    await runtime.stop();
  }
});
