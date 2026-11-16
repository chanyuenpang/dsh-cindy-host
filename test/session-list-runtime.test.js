import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { startHost } from '../src/host.js';
import { createSessionControllerSource } from '../src/dsh-session-source.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const ON = { transportEnabled: true, remoteControlEnabled: true, controllers: {} };
const native = (id, title = id, time = 100) => ({ sessionId: id, createdAt: 1, cwd: 'G:/work', updatedAt: time,
  projections: { values: { title, sessionListMetadata: { blank: false, lastPromptAt: time } } } });
class Socket {
  sent = []; handlers = new Map(); replies = new Map(); readyState = 1;
  on(name, fn) { const list = this.handlers.get(name) ?? []; list.push(fn); this.handlers.set(name, list); }
  emit(name, ...args) { for (const fn of this.handlers.get(name) ?? []) fn(...args); }
  send(text) { const frame = JSON.parse(text); this.sent.push(frame); if (frame.kind === 'invoke-result') { this.replies.get(frame.id)?.(frame); this.replies.delete(frame.id); } }
  waitReply(id) { return new Promise(resolve => { this.replies.set(id, resolve); }); }
  close() { this.readyState = 3; }
  frame(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}
async function setup(t, initial = [native('a')], options = {}) {
  const data = new Map(initial.map(row => [row.sessionId, row])); const handlers = new Map();
  let clock = 0, counter = 0, calls = 0, readHook;
  const timers = new Map();
  const source = createSessionControllerSource({
    sessionController: { async list() { calls++; return { items: structuredClone([...data.values()]) }; } },
    readSessionSummary: async id => readHook ? readHook(id) : structuredClone(data.get(id)),
    subscribe(name, fn) { const set = handlers.get(name) ?? new Set(); set.add(fn); handlers.set(name, set); return () => set.delete(fn); },
    ...options.sourceOptions,
  });
  const socket = new Socket();
  const runtime = await startHost(source, ON, {
    heartbeatMs: 0, resolveSession: async () => ({ ok: true, session: { deviceId: 'host', accessToken: 'test' } }),
    openSocket: () => socket, listDevices: async () => ({ devices: [] }),
    listDeliveryOptions: { now: () => clock, random: () => 0,
      setTimer(fn, ms) { const id = ++counter; timers.set(id, { at: clock + ms, fn }); return id; }, clearTimer: id => timers.delete(id) },
    ...options,
  });
  t.after(async () => { await runtime.stop(); source.dispose(); assert.equal(timers.size, 0); });
  socket.emit('open'); socket.frame({ v: 1, kind: 'hello-ack', payload: { deviceId: 'host', userId: 'account', serverProtocolVersion: 1 } });
  await tick();
  const invoke = async (channel, args = [], peer = 'phone') => {
    const id = `req-${++counter}`; socket.frame({ v: 1, kind: 'invoke', src: peer, id, payload: { channel, args } });
    await tick(); return socket.sent.find(frame => frame.id === id && frame.kind === 'invoke-result');
  };
  await invoke('device-link:subscribe', [{ topics: ['sessions'] }]);
  return { runtime, socket, source, data, invoke, calls: () => calls,
    hook(fn) { readHook = fn; },
    event(id, type = 'session/title') { for (const fn of handlers.get('session/event') ?? []) fn({ id, header: { id } }, { type }); },
    advance(ms) {
      const end = clock + ms;
      for (let n = 0; n < 1000; n++) {
        const next = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) { clock = end; return; }
        const [id, value] = next; timers.delete(id); clock = value.at; value.fn();
      }
      throw new Error('timer loop');
    },
    pushes(channel) { return socket.sent.filter(frame => frame.kind === 'push' && frame.payload.channel === channel); },
  };
}

test('optional evidence progressing during a real catalog await must not starve the Host list', async t => {
  const rows = Array.from({ length: 100 }, (_, i) => native(`row-${i}`)); let slow = false;
  const f = await setup(t, rows, { listReadTimeoutMs: 300, sourceOptions: {
    sessionController: { async list() { if (slow) await new Promise(resolve => setTimeout(resolve, 60)); return { items: rows }; } },
    readActivityEvidence: async () => { await new Promise(resolve => setTimeout(resolve, 20)); return { messageCount: 3, userSendAt: null }; },
  } });
  await f.source.listSessions({ limit: 100, evidence: false });
  await f.source.listSessions({ limit: 100 }); slow = true;
  const result = await f.runtime.invokeForTest('local-db:sessions:list', [100, 'active', { fresh: true }]);
  assert.equal(result.ok, true, 'progress on optional fields cannot restart the entire catalog until the request expires');
  assert.equal(result.reply.payload.ok, true); assert.equal(result.reply.payload.result.length, 100);
  assert.ok(f.source.listDiagnostics().evidencePending > 0, 'response must not wait for all background evidence to finish');
});

test('repeated request headers with unchanged list facts cannot restart a whole catalog read', async t => {
  const rows = [native('a'), native('busy')]; let slow = false, catalogCalls = 0;
  const f = await setup(t, rows, { listReadTimeoutMs: 300, sourceOptions: {
    sessionController: { async list() { catalogCalls++; if (slow) await new Promise(resolve => setTimeout(resolve, 60)); return { items: rows }; } },
  } });
  await f.source.listSessions({ evidence: false }); slow = true;
  const version = f.source.listVersion(), before = catalogCalls;
  const timer = setInterval(() => f.event('busy', 'request/header'), 15);
  t.after(() => clearInterval(timer));
  const result = await f.runtime.invokeForTest('local-db:sessions:list', [20, 'active', { fresh: true }]);
  clearInterval(timer);
  assert.equal(result.ok, true, 'known row invalidations must be repaired by identity, not by re-enumerating the corpus');
  assert.equal(result.reply.payload.result.length, 2);
  assert.equal(catalogCalls - before, 1);
  assert.equal(f.source.listVersion(), version, 'unchanged domain values do not revoke a materialized core cut');
});

test('the actual Host socket emits opt-in gzip and unchanged tags without changing logical list rows', async t => {
  const f = await setup(t, Array.from({ length: 30 }, (_, i) => native(`task-${i}`, '中文'.repeat(60), i + 10)));
  async function rpc(id, transfer) {
    const pending = f.socket.waitReply(id);
    f.socket.frame({ v: 1, kind: 'invoke', src: 'phone', id, payload: { channel: 'local-db:sessions:list', args: [200, 'active', { fresh: true }], transfer } });
    return pending;
  }
  const first = await rpc('zip-first', { gzip: 1 });
  assert.equal(first.payload.ok, true); assert.ok(first.payload.transfer.gzipBase64);
  const rows = JSON.parse(gunzipSync(Buffer.from(first.payload.transfer.gzipBase64, 'base64')));
  assert.equal(rows.length, 30); assert.equal(rows[0].lastActivityAt, rows[0].updatedAt);
  const next = await rpc('zip-next', { gzip: 1, ifNoneMatch: first.payload.transfer.tag });
  assert.equal(next.payload.transfer.notModified, true); assert.equal(next.payload.result, null);
});

test('a list version changing during asynchronous compression cannot leak the old result', async t => {
  const entered = deferred(), hold = deferred();
  const f = await setup(t, Array.from({ length: 20 }, (_, i) => native(`task-${i}`, 'name'.repeat(30), i + 10)), {
    listTransferOptions: { compress: async bytes => { entered.resolve(); await hold.promise; return gzipSync(bytes); } },
  });
  const pending = f.socket.waitReply('zip-old');
  f.socket.frame({ v: 1, kind: 'invoke', id: 'zip-old', src: 'phone', payload: { channel: 'local-db:sessions:list', args: [200], transfer: { gzip: 1 } } });
  await entered.promise; f.data.set('task-1', native('task-1', 'changed', 1000)); f.event('task-1');
  await f.source.titlesSettled(); hold.resolve();
  const reply = await pending; assert.equal(reply.payload.ok, false); assert.equal(reply.payload.error.code, 'NOT_AVAILABLE');
});

test('a committed rename updates the list with no later list poll', async t => {
  const f = await setup(t); const reads = f.calls(); f.socket.sent.length = 0;
  f.data.set('a', native('a', 'renamed')); f.event('a'); await f.source.titlesSettled(); f.advance(250);
  const patch = f.pushes('local-db:sessions:patched').at(-1).payload.payload.patch;
  assert.equal(patch.title, 'renamed'); assert.equal(patch.lastActivityAt, patch.updatedAt);
  assert.equal(patch.updatedAt, new Date(100).toISOString()); assert.equal(f.calls(), reads);
});
test('new discovery notifies only after the named core is readable; no synthetic creation ID', async t => {
  const f = await setup(t, [native('new', null)]); f.socket.sent.length = 0;
  f.data.set('new', native('new', 'ready')); f.event('new'); await f.source.titlesSettled();
  assert.equal(f.source.peekSession('new').title, 'ready'); f.advance(250);
  const created = f.pushes('local-db:sessions:created'); assert.equal(created.length, 1);
  assert.deepEqual(created[0].payload.payload, { sessionId: 'new' });
  const list = await f.invoke('local-db:sessions:list', [200, 'active', { fresh: true }]);
  assert.equal(list.payload.result[0].title, 'ready');
});
test('the production path never enables generic invalidation merely from a peer/version claim', async t => {
  const f = await setup(t); f.socket.sent.length = 0; f.advance(120_000);
  assert.equal(f.pushes('local-db:sessions:created').length, 0);
  assert.ok(f.runtime.getListDeliveryDiagnostics().compatibilityBlocked > 0);
});
test('validated compatibility enables initial and periodic repair, with no business ACK claim', async t => {
  const f = await setup(t, [native('a')], { listReseedValidated: id => id === 'phone' });
  f.advance(250); assert.ok(f.pushes('local-db:sessions:created').some(frame => !frame.payload.payload.sessionId));
  const before = f.pushes('local-db:sessions:created').length; f.advance(60_000);
  assert.ok(f.pushes('local-db:sessions:created').length > before);
});
test('turn boundary patches do not replace native user recency with wall time', async t => {
  const f = await setup(t); f.socket.sent.length = 0;
  f.runtime.pushTurnRunning('a', { type: 'turn/start', seq: 10, time: 9000, data: { turn: 1 } });
  const patch = f.pushes('local-db:sessions:patched').at(-1).payload.payload.patch;
  assert.equal(patch.running, true); assert.equal(patch.updatedAt, new Date(100).toISOString());
  assert.equal(patch.lastActivityAt, patch.updatedAt);
  assert.equal(f.pushes('local-db:sessions:activity').at(-1).payload.payload.phase, 'running');
  f.runtime.pushTurnIdle('a', { type: 'turn/end', seq: 11, time: 9001, data: { turn: 1, reason: { kind: 'completed' } } });
  assert.equal(f.pushes('local-db:sessions:activity').at(-1).payload.payload.phase, 'completed');
});
test('revoke/regrant during a read cannot deliver the old owner result', async t => {
  const f = await setup(t); const gate = deferred(); f.hook(async () => { await gate.promise; return native('a', 'private'); });
  f.socket.frame({ v: 1, kind: 'invoke', id: 'private-read', src: 'phone', payload: { channel: 'local-db:sessions:get', args: ['a'] } });
  await tick(); await f.runtime.updateSettings({ ...ON, controllers: { phone: { state: 'revoked', grantRevision: 1 } } });
  await f.runtime.updateSettings({ ...ON, controllers: { phone: { state: 'allowed', grantRevision: 2 } } });
  gate.resolve(); await tick();
  assert.equal(f.socket.sent.some(frame => frame.id === 'private-read' && frame.payload?.ok), false);
});
test('source replacement drops delayed metadata and fences the old exact caller', async t => {
  const f = await setup(t); f.data.set('a', native('a', 'old pending')); f.event('a'); await f.source.titlesSettled();
  const gate = deferred(); f.hook(async () => { await gate.promise; return native('a', 'old private'); });
  f.socket.frame({ v: 1, kind: 'invoke', id: 'old-get', src: 'phone', payload: { channel: 'local-db:sessions:get', args: ['a'] } });
  await tick(); const before = f.socket.sent.length; await f.runtime.setSource(undefined); gate.resolve(); await tick(); f.advance(1000);
  const frames = f.socket.sent.slice(before);
  assert.equal(frames.some(frame => frame.payload?.payload?.patch?.title === 'old pending'), false);
  assert.equal(frames.some(frame => frame.id === 'old-get' && frame.payload?.ok), false);
});
