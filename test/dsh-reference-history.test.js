import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshReferenceHistory } from '../src/dsh-reference-history.js';
import { assertNoStructuredSessionReferences } from '../src/session-reference-boundary.js';
import { createChannelRouter } from '../src/cindy-channels.js';
import { createDshInputDeliveryBackend } from '../src/dsh-input-delivery.js';
import { createInputDeliveryCoordinator } from '../src/host-input-delivery.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const request = extra => ({ sessionId: 'source', workdir: null, fromMs: null, toMs: null, agentKind: null, roles: ['user','assistant'], includeRewound: false, limit: 20, cursor: null, order: 'asc', contentCharLimit: 8000, ...extra });
function fixture() {
  const events = []; let disposed = 0; let reads = 0; let visible = true; let observe;
  const add = (type, data, surfaceOp, time = 1000) => { const event = { type, seq: events.length, time, data, ...(surfaceOp ? { surfaceOp } : {}) }; events.push(event); return event; };
  const user = text => add('user/message', { id: 'user-' + events.length, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }, 'append');
  const assistant = text => add('assistant/message', { turn: 1, step: 1, message: { id: 'assistant-' + events.length, role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }] } }, 'append');
  user('question'); assistant('answer');
  const query = { observeSession: async (...args) => { reads++; return observe ? observe(...args) : { header: { id: 'source' }, events: [...events], [Symbol.dispose]: () => disposed++ }; } };
  const getSession = async id => visible && id === 'source' ? { id, cwd: '/project', title: 'Source', model: 'deepseek-chat', providerId: 'deepseek' } : undefined;
  const options = { getView: async id => ({ id, workingDir: '/project', agentKind: 'pi', title: 'Source' }) };
  const port = createDshReferenceHistory({ getQuery: () => query, getSession });
  return { port, events, add, user, assistant, options, getSession, get reads() { return reads; }, get disposed() { return disposed; }, setVisible: value => { visible = value; }, setObserve: fn => { observe = fn; } };
}
test('native source history returns genuine public IDs/content and role/session metadata without Agent activation', async () => {
  const f = fixture(); const result = await f.port.read(request(), f.options);
  assert.equal(result.items.length, 2); assert.equal(result.items[0].role, 'user'); assert.equal(result.items[1].content, 'answer'); assert.equal(result.items[0].sessionAgentKind, 'pi');
  assert.equal(result.hasMore, false); assert.equal(result.nextCursor, null); assert.equal(result.terminal, null); assert.equal(f.disposed, 1);
});
test('source pagination has a stable positive native-log ordinal tie-breaker and correct reverse traversal', async () => {
  const f = fixture(); f.user('third'); const first = await f.port.read(request({ limit: 1 }), f.options); assert.ok(first.nextCursor.rowid > 0);
  const second = await f.port.read(request({ limit: 1, cursor: first.nextCursor }), f.options); assert.equal(second.items[0].content, 'answer');
  const third = await f.port.read(request({ cursor: second.nextCursor }), f.options); assert.equal(third.items[0].content, 'third');
  const reverse = await f.port.read(request({ order: 'desc' }), f.options); assert.deepEqual(reverse.items.map(row => row.content), ['third','answer','question']);
});
test('all accepted workdir, agent, role and inclusive timestamp filters actually execute', async () => {
  const f = fixture(); f.add('user/message', { id: 'later', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'later' }] }, 'append', 2000);
  assert.equal((await f.port.read(request({ workdir: '/different' }), f.options)).items.length, 0);
  assert.equal((await f.port.read(request({ agentKind: 'cc' }), f.options)).items.length, 0);
  assert.deepEqual((await f.port.read(request({ roles: ['user'], fromMs: 2000, toMs: 2000 }), f.options)).items.map(row => row.content), ['later']);
});
test('source clipping marks actual loss and preserves the official bounded tail-text convention', async () => {
  const f = fixture(); f.assistant('0123456789'); const result = await f.port.read(request({ contentCharLimit: 5, order: 'desc' }), f.options);
  assert.equal(result.items[0].content, '…6789'); assert.equal(result.items[0].agentMeta.remoteContentTruncated, true);
});
test('only current native surface rows are returned; replaced user text does not leak through append history', async () => {
  const f = fixture(); f.add('user/message', { id: 'replacement', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'new surface' }] }, { op: 'replace', startSeq: 0, endSeq: 0 }).sourceEventSeqs = [0];
  const result = await f.port.read(request(), f.options); assert.equal(result.items.some(row => row.content === 'question'), false); assert.ok(result.items.some(row => row.content === 'new surface'));
});
test('terminal error is captured with the source page and never exports private error bodies', async () => {
  const f = fixture(); f.add('turn/end', { reason: { kind: 'error', error: 'PRIVATE provider credentials' } }, undefined, 2100);
  const result = await f.port.read(request(), f.options); assert.deepEqual(result.terminal, { status: 'error', createdAt: 2100 }); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  f.add('turn/start', { turn: 2 }, undefined, 2200); assert.equal((await f.port.read(request(), f.options)).terminal, null);
});
test('unreadable ordinary sources and unsupported history variants refuse before observing arbitrary data', async () => {
  const f = fixture(); f.setVisible(false); await assert.rejects(f.port.read(request(), f.options), { refusalCode: 'NOT_FOUND' }); assert.equal(f.reads, 0);
  for (const patch of [{ includeRewound: true }, { roles: null }, { roles: ['thinking'] }, { unknown: true }, { limit: 1001 }]) await assert.rejects(f.port.read(request(patch), f.options)); assert.equal(f.reads, 0);
});
test('a late cancelled observation is released and cannot become a successful reference snapshot', async () => {
  const f = fixture(); let finish; let disposed = 0; f.setObserve(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.port.read(request(), f.options); await tick(); f.port.cancelAll(); finish({ header: { id: 'source' }, events: f.events, [Symbol.dispose]: () => disposed++ });
  await assert.rejects(pending, { refusalCode: 'NOT_AVAILABLE' }); assert.equal(disposed, 1);
});
test('ordinary literal link text stays text but every nonempty structured reference carrier fails closed', () => {
  assert.doesNotThrow(() => assertNoStructuredSessionReferences({ text: 'literal link @session:x', sessionRefs: [], sessionReferencesRequireTrustedSnapshot: false }));
  for (const value of [{ sessionRefs: [{ sessionId: 'other' }] }, { trustedSessionReferenceContexts: [{ messages: [] }] }, { sessionReferencesRequireTrustedSnapshot: true }, { options: { requireTrustedSnapshot: true } }, { persistedContent: JSON.stringify({ sessionRefs: [{}] }) }]) assert.throws(() => assertNoStructuredSessionReferences(value), /SESSION_REFERENCE_UNSUPPORTED/);
});
test('all public send/enqueue/steer/edit routes reject structured refs before any admission callback', async () => {
  let writes = 0; const router = createChannelRouter({ listSessions: async () => [], subscribers: new Set(), resolveCapabilities: () => ({ sendMessage: () => writes++, enqueueInput: () => writes++, steerInput: () => writes++, updateQueuedInput: () => writes++ }) });
  for (const channel of ['maker:send','maker:input:enqueue','maker:input:steer','maker:input:update-text','maker:input:update-content','maker:create-session']) {
    const reply = await router({ v: 1, id: channel, src: 'phone', kind: 'invoke', payload: { channel, args: ['source', { text: 'plain part', sessionRefs: [{ sessionId: 'other' }] }] } });
    assert.equal(reply.payload.ok, false); assert.match(reply.payload.error.message, /SESSION_REFERENCE_UNSUPPORTED/);
  } assert.equal(writes, 0);
});
test('durable coordinator and native replay guard before prepare, remove, Agent resolution or persistence', async () => {
  let touched = 0; const backend = createDshInputDeliveryBackend({ getServices: () => { touched++; throw Error('must not touch native services'); }, sessionController: { resolveAgent: () => touched++ }, getSession: () => touched++ });
  const value = { clientId: 'id', text: 'part', trustedSessionReferenceContexts: [{}] };
  await assert.rejects(backend.prepare('source', value), /SESSION_REFERENCE_UNSUPPORTED/);
  await assert.rejects(backend.dispatch({ sessionId: 'source', request: value, payload: {} }), /SESSION_REFERENCE_UNSUPPORTED/);
  await assert.rejects(backend.recoverColdInbox('source', [{ request: value }]), /SESSION_REFERENCE_UNSUPPORTED/);
  const coordinator = createInputDeliveryCoordinator({ store: {}, backend: {} });
  await assert.rejects(coordinator.accept('source', value), /SESSION_REFERENCE_UNSUPPORTED/); await assert.rejects(coordinator.steer('source', value), /SESSION_REFERENCE_UNSUPPORTED/); await assert.rejects(coordinator.edit('source','id',value), /SESSION_REFERENCE_UNSUPPORTED/); assert.equal(touched, 0);
});
test('existing source RPC and negative target capability remain distinct', async () => {
  const f = fixture(); const router = createChannelRouter({ listSessions: async () => [], getSession: f.getSession, subscribers: new Set(), resolveCapabilities: () => ({ referenceHistory: f.port }) });
  const invoke = (channel, args) => router({ v: 1, id: channel, src: 'phone', kind: 'invoke', payload: { channel, args } });
  assert.deepEqual((await invoke('maker:input:session-reference-capability', [])).payload.result, { supported: false, version: 1 });
  assert.equal((await invoke('local-db:history:messages', [request()])).payload.result.items.length, 2);
});
