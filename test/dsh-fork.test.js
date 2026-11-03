import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeForkCut, createDshFork } from '../src/dsh-fork.js';
import { foldSessionEvent } from '../src/dsh-message-fold.js';
import { createChannelRouter } from '../src/cindy-channels.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
function log() {
  const events = [];
  const add = (type, data, surfaceOp) => events.push({ type, seq: events.length, time: events.length + 1, data, ...(surfaceOp ? { surfaceOp } : {}) });
  for (let turn = 1; turn <= 3; turn++) {
    add('turn/start', { turn }); add('step/start', { turn, step: 1 });
    add('user/message', { id: 'u-' + turn, role: 'user', source: { kind: 'user', rpcId: 'rpc-' + turn }, content: [{ type: 'text', text: 'question' }] }, 'append');
    add('assistant/message', { turn, step: 1, message: { id: 'a:' + turn, role: 'assistant', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] } }, 'append');
    if (turn < 3) { add('step/end', { turn, step: 1 }); add('turn/end', { turn, reason: { kind: 'completed' } }); }
  }
  return events;
}
const assistantId = (events, seq, block = 0) => foldSessionEvent(events[seq], { sessionId: 'source' })[block].clientId;
function fixture() {
  const events = log(); const calls = []; const published = []; let disposed = 0; let visible = true; let childVisible = true; let hidden = false; let observations = 0;
  let nativeFork = async () => ({ sessionId: 'child' });
  let observe = async () => ({ header: { id: 'source' }, events, [Symbol.dispose]: () => disposed++ });
  const controller = { fork: args => { calls.push(args); return nativeFork(args); } };
  const query = { observeSession: async (...args) => { observations++; return observe(...args); } };
  const getSession = async id => (id === 'source' ? visible : childVisible) ? { id, title: id, cwd: '/workspace', createdAt: 1, updatedAt: 2 } : undefined;
  let availableController = controller; let availableQuery = query;
  const port = createDshFork({ getController: () => availableController, getQuery: () => availableQuery, getSession, isHidden: () => hidden });
  const router = createChannelRouter({ listSessions: async () => [], getSession,
    resolveCapabilities: () => ({ forkSession: port, publishSessionCreated: id => published.push(id), sessionHidden: () => hidden }), subscribers: new Set() });
  const invoke = (args = ['source', assistantId(events, 3)], id = 'request', channel = 'maker:fork') => router({ v: 1, id, src: 'phone', kind: 'invoke', payload: { channel, args } });
  return { events, calls, published, port, invoke, get disposed() { return disposed; }, get observations() { return observations; },
    setFork: fn => { nativeFork = fn; }, setObserve: fn => { observe = fn; }, setVisible: value => { visible = value; },
    setChildVisible: value => { childVisible = value; }, setHidden: value => { hidden = value; },
    removeController: () => { availableController = undefined; }, removeQuery: () => { availableQuery = undefined; } };
}
test('assistant row blocks map to the end of the entire completed native turn', () => {
  const events = log();
  for (const block of [0, 1]) assert.equal(nativeForkCut(events, 'source', assistantId(events, 3, block)), 5);
  assert.equal(nativeForkCut(events, 'source', assistantId(events, 9)), 11);
});
test('user fork cuts before admission, allowing real DSH pre-admission turn/step markers', () => {
  const events = log(); assert.equal(nativeForkCut(events, 'source', 'rpc-2'), 7);
  assert.throws(() => nativeForkCut(events, 'source', 'rpc-1'), /NO_PRIOR_ASSISTANT/);
  assert.throws(() => nativeForkCut(events, 'source', 'rpc-404'), { refusalCode: 'NOT_FOUND' });
});
test('unfinished or aborted assistant, synthetic IDs and steering cuts refuse instead of slicing partial turns', () => {
  const events = log(); assert.throws(() => nativeForkCut(events, 'source', assistantId(events, 15)), /completed native turn/);
  const aborted = structuredClone(events); aborted[5].data.reason = { kind: 'aborted' };
  assert.throws(() => nativeForkCut(aborted, 'source', assistantId(events, 3)), /completed native turn/);
  const steered = structuredClone(events); steered.push({ type: 'user/message', seq: steered.length, time: 20, surfaceOp: 'append', data: { id: 'steer', role: 'user', source: { kind: 'user', rpcId: 'steer' }, content: [{ type: 'text', text: 'wait' }] } });
  assert.throws(() => nativeForkCut(steered, 'source', 'steer'), /unfinished assistant/);
  assert.throws(() => nativeForkCut(events, 'source', 'source:3:0:not-a-real-id'), { refusalCode: 'NOT_FOUND' });
});
test('shadowed and ambiguous client identities and over-budget/corrupt prefixes refuse safely', () => {
  const events = log(); const shadow = structuredClone(events);
  shadow.push({ ...structuredClone(events[3]), seq: shadow.length, time: 20, surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 }, data: { ...events[3].data, message: { ...events[3].data.message, id: 'replacement' } } });
  assert.throws(() => nativeForkCut(shadow, 'source', assistantId(events, 3)), /shadowed/);
  const ambiguous = structuredClone(events); ambiguous[8].data.source.rpcId = 'rpc-1';
  assert.throws(() => nativeForkCut(ambiguous, 'source', 'rpc-1'), /ambiguous/);
  assert.throws(() => nativeForkCut(events, 'source', 'rpc-2', 2), /budget/);
  assert.throws(() => nativeForkCut(events.slice(1), 'source', 'rpc-2'), /contiguous/);
});
test('native fork receives an exact cut and returns a discovered real child row and official created push', async () => {
  const f = fixture(); const original = structuredClone(f.events); const value = (await f.invoke()).payload;
  assert.equal(value.ok, true); assert.equal(value.result.id, 'child'); assert.equal(value.result.title, 'child');
  assert.deepEqual(f.calls, [{ sessionId: 'source', atSeq: 5 }]); assert.equal(f.disposed, 1);
  assert.deepEqual(f.events, original); assert.deepEqual(f.published, ['child']);
});
test('malformed, unsupported, hidden, missing-service and invisible forks never create or activate', async () => {
  const f = fixture();
  for (const args of [['source'], ['source', {}], ['source', 'rpc-2', {}], ['', 'rpc-2']]) assert.equal((await f.invoke(args)).payload.error.code, 'BAD_REQUEST');
  assert.equal((await f.invoke(['source'], 'strip', 'maker:fork-strip-encrypted')).payload.error.code, 'CHANNEL_NOT_ALLOWED');
  assert.deepEqual(f.calls, []); assert.equal(f.observations, 0);
  for (const mode of ['hidden', 'invisible', 'controller', 'query']) {
    const g = fixture(); if (mode === 'hidden') g.setHidden(true); if (mode === 'invisible') g.setVisible(false);
    if (mode === 'controller') g.removeController(); if (mode === 'query') g.removeQuery();
    assert.equal((await g.invoke()).payload.ok, false); assert.deepEqual(g.calls, []); assert.equal(g.observations, 0);
  }
});
test('duplicate envelopes share native creation and completed receipts; reused IDs cannot change the cut', async () => {
  const f = fixture(); let finish; f.setFork(() => new Promise(resolve => { finish = resolve; }));
  const first = f.invoke(); const duplicate = f.invoke(); await tick(); assert.equal(f.calls.length, 1);
  finish({ sessionId: 'child' }); assert.equal((await first).payload.ok, true); assert.equal((await duplicate).payload.ok, true);
  assert.equal((await f.invoke()).payload.ok, true); assert.equal(f.calls.length, 1);
  assert.equal((await f.invoke(['source', 'rpc-2'])).payload.error.code, 'BAD_REQUEST');
});
test('attachment failure and unreadable child retain its real ID and never repeat native fork', async () => {
  for (const mode of ['attach', 'read']) {
    const f = fixture();
    if (mode === 'attach') f.setFork(async () => { throw Object.assign(Error('native attach failed'), { code: 'session/workspace-attach-failed', data: { sessionId: 'child' } }); });
    else f.setChildVisible(false);
    const value = (await f.invoke()).payload; assert.equal(value.ok, false); assert.match(value.error.message, /sessionId=child.*do not repeat fork/);
    assert.equal((await f.invoke()).payload.ok, false); assert.equal(f.calls.length, 1);
  }
});
test('source replacement before creation disposes observation and prevents writes', async () => {
  const f = fixture(); let finish; let released = 0;
  f.setObserve(() => new Promise(resolve => { finish = resolve; })); const pending = f.invoke(); await tick(); f.port.cancelAll();
  finish({ header: { id: 'source' }, events: f.events, [Symbol.dispose]: () => released++ });
  assert.equal((await pending).payload.ok, false); assert.equal(released, 1); assert.deepEqual(f.calls, []);
});
test('source replacement during noncancellable native creation reports the known child, not rollback or retry', async () => {
  const f = fixture(); let finish; f.setFork(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.invoke(); await tick(); f.port.cancelAll(); finish({ sessionId: 'child' });
  const value = (await pending).payload; assert.equal(value.ok, false); assert.match(value.error.message, /created.*connection changed.*sessionId=child/);
  assert.equal(f.calls.length, 1);
});
