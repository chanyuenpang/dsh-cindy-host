import test from 'node:test';
import assert from 'node:assert/strict';
import { startHost } from '../src/host.js';
import { FixtureDshSource } from '../src/fixture-source.js';
import { createMessageReader, foldSessionEvent } from '../src/dsh-message-fold.js';
import { turnStateFromEvents } from '../src/turn-error.js';

const ON = { transportEnabled: true, remoteControlEnabled: true, controllers: {} };
const tick = () => new Promise(resolve => setImmediate(resolve));
const start = seq => ({ type: 'turn/start', seq, time: 1000 + seq * 1000, data: { turn: 1 } });
const fail = seq => ({ type: 'turn/end', seq, time: 1000 + seq * 1000, data: { turn: 1, reason: { kind: 'error',
  error: { message: 'SECRET credential and provider prose', code: 'RATE_LIMIT', status: 429, requestId: 'SECRET' } } } });
class Socket {
  sent = []; handlers = new Map(); readyState = 1;
  on(type, fn) { const list = this.handlers.get(type) ?? []; list.push(fn); this.handlers.set(type, list); return this; }
  emit(type, data) { for (const fn of this.handlers.get(type) ?? []) fn(data); }
  frame(data) { this.emit('message', Buffer.from(JSON.stringify(data))); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() {}
}
async function setup(events = [], customize = () => {}) {
  const socket = new Socket(); const source = new FixtureDshSource();
  const state = { running: false };
  source.listSessionStates = async id => [{ id: id ?? 's1', running: state.running }];
  source.getSession = async id => ({ id, title: 'Task', running: state.running, cwd: 'G:/Projects', updatedAt: 1000 });
  const reader = createMessageReader({ readSessionLog: async () => ({ events }) });
  customize(reader, source);
  const runtime = await startHost(source, ON, {
    resolveSession: async () => ({ ok: true, session: { deviceId: 'host' } }),
    openSocket: () => socket, heartbeatMs: 0, listDevices: async () => ({ devices: [] }),
    resolveCapabilities: () => ({ readMessages: reader }),
  });
  socket.emit('open');
  socket.frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'host', userId: 'account' } });
  let id = 0;
  const invoke = async (channel, args, src = 'phone') => {
    socket.frame({ v: 1, kind: 'invoke', id: `req-${++id}`, src, payload: { channel, args } });
    await tick();
  };
  const subscribe = (topics = ['session:s1'], src = 'phone') => invoke('device-link:subscribe', [{ topics }], src);
  return { runtime, socket, source, reader, state, invoke, subscribe };
}
const terminals = socket => socket.sent.filter(frame => frame.kind === 'push' && frame.payload.channel === 'maker:event'
  && ['done', 'error'].includes(frame.payload.payload.event.type));

test('live failure emits the stable terminal error once, never done or unwatched detail', async () => {
  const x = await setup();
  try {
    await x.subscribe(); await x.subscribe(['sessions'], 'list-phone'); await x.subscribe(['session:s2'], 'other-phone');
    x.socket.sent.length = 0;
    x.runtime.pushTurnRunning('s1', start(0));
    const event = fail(1); const row = foldSessionEvent(event, { sessionId: 's1' })[0];
    await x.runtime.pushSessionMessage('s1', row);
    x.runtime.pushTurnIdle('s1', event);
    x.runtime.pushTurnIdle('s1', event);
    assert.equal(terminals(x.socket).length, 1);
    const frame = terminals(x.socket)[0];
    assert.equal(frame.dst, 'phone');
    assert.equal(frame.payload.payload.persistId, row.clientId);
    assert.equal(frame.payload.payload.event.type, 'error');
    assert.equal(frame.payload.payload.event.data.isTerminal, true);
    assert.equal(x.runtime.isSessionRunning('s1'), false);
    assert.equal(JSON.stringify(x.socket.sent).includes('SECRET'), false);
    x.runtime.pushTurnIdle('unwatched', fail(1));
    assert.equal(terminals(x.socket).length, 1);
  } finally { await x.runtime.stop(); }
});

test('cold subscribe and resubscribe recover the native failure with matching historical identity', async () => {
  const events = [start(0), fail(1)]; const x = await setup(events);
  try {
    await x.subscribe();
    const [row] = await x.reader('s1');
    assert.equal(terminals(x.socket).length, 1);
    assert.equal(terminals(x.socket)[0].payload.payload.persistId, row.clientId);
    assert.equal(terminals(x.socket)[0].payload.payload.event.data.message, row.content.message);
    x.socket.sent.length = 0;
    await x.subscribe();
    assert.equal(terminals(x.socket).length, 1, 'fresh subscription repairs a potentially missed frame');
    assert.equal(terminals(x.socket)[0].payload.payload.event.type, 'error');
    events.push(start(2)); x.state.running = true; x.socket.sent.length = 0;
    await x.subscribe();
    assert.equal(terminals(x.socket).length, 0, 'historical failure does not terminate the new turn');
  } finally { await x.runtime.stop(); }
});

test('offline delivery is repaired by link-open without resubscribing or time-window assumptions', async () => {
  const events = []; const x = await setup(events);
  try {
    await x.subscribe(); x.socket.sent.length = 0;
    x.socket.frame({ v: 1, kind: 'presence-changed', payload: { deviceId: 'phone', online: false } });
    events.push(start(0), fail(1));
    x.runtime.pushTurnRunning('s1', events[0]); x.runtime.pushTurnIdle('s1', events[1]);
    assert.equal(terminals(x.socket).length, 1);
    x.socket.sent.length = 0;
    x.socket.frame({ v: 1, kind: 'link-open', id: 'relink', src: 'phone' }); await tick();
    assert.equal(terminals(x.socket).length, 1);
    assert.equal(terminals(x.socket)[0].payload.payload.event.type, 'error');
  } finally { await x.runtime.stop(); }
});

test('legacy sources without native boundary reads retain their status-only failure ending', async () => {
  const x = await setup([], reader => { delete reader.turnState; });
  try {
    await x.subscribe(); x.socket.sent.length = 0;
    await x.source.emit({ kind: 'session-status', sessionId: 's1', phase: 'error', sequence: 1 });
    assert.equal(terminals(x.socket).length, 1);
    assert.equal(terminals(x.socket)[0].payload.payload.event.type, 'done');
  } finally { await x.runtime.stop(); }
});

test('non-error native endings remain done, not failed model messages', async () => {
  const x = await setup();
  try {
    await x.subscribe(); x.socket.sent.length = 0;
    let seq = 0;
    for (const kind of ['completed', 'aborted', 'blocked', 'max-tokens']) {
      x.runtime.pushTurnRunning('s1', start(seq++));
      const event = { ...fail(seq++), data: { turn: 1, reason: { kind } } };
      x.runtime.pushTurnIdle('s1', event);
      assert.deepEqual(foldSessionEvent(event, { sessionId: 's1' }), []);
    }
    assert.deepEqual(terminals(x.socket).map(frame => frame.payload.payload.event.type), ['done', 'done', 'done', 'done']);
  } finally { await x.runtime.stop(); }
});

test('late summary error is an invalidation, not a terminal signal to a list phone', async () => {
  const x = await setup([start(0), fail(1)]);
  try {
    await x.subscribe(['sessions']); x.state.running = true; x.socket.sent.length = 0;
    await x.source.emit({ kind: 'session-status', sessionId: 's1', phase: 'error', sequence: 1 }); await tick();
    assert.equal(terminals(x.socket).length, 0);
    assert.equal(x.socket.sent.some(frame => frame.payload?.channel === 'local-db:sessions:activity' && frame.payload.payload.phase === 'error'), false);
  } finally { await x.runtime.stop(); }
});

test('admitted running turn with no start in the snapshot is not falsely ended', async () => {
  const x = await setup([start(0), fail(1)]);
  try {
    x.state.running = true; await x.subscribe();
    assert.equal(terminals(x.socket).length, 0);
    assert.ok(x.socket.sent.some(frame => frame.payload?.payload?.event?.data?.isRunning === true));
  } finally { await x.runtime.stop(); }
});

for (const race of ['new-turn', 'unsubscribe', 'link-close', 'revoke', 'replace-source', 'stop']) {
  test(`recovery discards an old failed-turn read after ${race}`, async () => {
    let release;
    const x = await setup([], reader => { reader.turnState = () => new Promise(resolve => { release = resolve; }); });
    try {
      await x.subscribe(); assert.equal(typeof release, 'function');
      if (race === 'new-turn') x.runtime.pushTurnRunning('s1', start(2));
      if (race === 'unsubscribe') await x.invoke('device-link:unsubscribe', [{ topics: ['session:s1'] }]);
      if (race === 'link-close') x.socket.frame({ v: 1, kind: 'link-close', src: 'phone' });
      if (race === 'revoke') await x.runtime.updateSettings({ ...ON, controllers: { phone: { state: 'revoked' } } });
      if (race === 'replace-source') await x.runtime.setSource(new FixtureDshSource());
      if (race === 'stop') await x.runtime.stop();
      x.socket.sent.length = 0;
      release(turnStateFromEvents([start(0), fail(1)], 's1')); await tick();
      assert.equal(terminals(x.socket).length, 0);
      if (race === 'new-turn') assert.equal(x.runtime.isSessionRunning('s1'), true);
    } finally { await x.runtime.stop(); }
  });
}

test('read failure never manufactures done or reflects exception details', async () => {
  const x = await setup([], reader => { reader.turnState = async () => { throw new Error('SECRET'); }; });
  try {
    await x.subscribe();
    assert.equal(terminals(x.socket).length, 0);
    assert.equal(JSON.stringify(x.socket.sent).includes('SECRET'), false);
    assert.equal(JSON.stringify(x.runtime.getHandlerErrors()).includes('SECRET'), false);
    assert.ok(x.runtime.getHandlerErrors().some(row => row.where === 'turn-recovery'));
  } finally { await x.runtime.stop(); }
});

test('recovery corrects runtime running state when a native end notification was missed', async () => {
  const events = [start(0)]; const x = await setup(events);
  try {
    x.state.running = true; await x.subscribe(); x.runtime.pushTurnRunning('s1', start(0));
    events.push(fail(1)); x.state.running = false;
    x.socket.sent.length = 0; await x.subscribe();
    assert.equal(x.runtime.isSessionRunning('s1'), false);
    assert.equal(terminals(x.socket)[0].payload.payload.event.type, 'error');
  } finally { await x.runtime.stop(); }
});

test('late native ending cannot stop a newer turn; distinct failures retain distinct identity', async () => {
  const x = await setup();
  try {
    await x.subscribe(); x.socket.sent.length = 0;
    x.runtime.pushTurnRunning('s1', start(0)); x.runtime.pushTurnIdle('s1', fail(1));
    x.runtime.pushTurnRunning('s1', start(2)); x.runtime.pushTurnIdle('s1', fail(1));
    assert.equal(x.runtime.isSessionRunning('s1'), true);
    x.runtime.pushTurnIdle('s1', fail(3));
    assert.deepEqual(terminals(x.socket).map(frame => frame.payload.payload.persistId), ['s1:turn-error:1', 's1:turn-error:3']);
  } finally { await x.runtime.stop(); }
});
