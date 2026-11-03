import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshSubagentReads } from '../src/dsh-subagent-reads.js';
import { createChannelRouter } from '../src/cindy-channels.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
function child(id = 'child', reason = 'completed') {
  const events = []; const add = (type, data, surfaceOp) => { const event = { type, data, seq: events.length, time: 1100 + events.length, ...(surfaceOp ? { surfaceOp } : {}) }; events.push(event); return event; };
  add('turn/start', { turn: 40 }); add('user/message', { id: 'inherited', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'PRIVATE inherited parent history' }] }, 'append');
  const inherited = events.length; add('turn/end', { turn: 40, reason: { kind: 'forked' } });
  add('turn/start', { turn: 1 }); add('step/start', { turn: 1, step: 1 });
  add('user/message', { id: 'task', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'task for ' + id }] }, 'append');
  add('user/message', { id: 'context', role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'PRIVATE injected context' }] }, 'append');
  add('assistant/message', { turn: 1, step: 1, message: { id: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'answer from ' + id }] } }, 'append');
  add('step/end', { turn: 1, step: 1 }); const end = add('turn/end', { turn: 1, reason: { kind: reason } });
  return { id, events, inherited, end, add, header: { id, createdAt: 1000, parentSession: 'root' }, values: { inbox: { 'next-turn': [], 'next-step': [] } } };
}
function fixture(count = 1, options = {}) {
  const children = new Map(); let catalog = []; const accounting = new Map(); const live = new Map(); let disposed = 0; let observed = 0; let catalogs = 0; let visible = async id => id === 'root' ? { id } : undefined;
  for (let i = 0; i < count; i++) { const record = child('child-' + i); children.set(record.id, record); catalog.push({ id: record.id, mode: 'continuable', label: record.id, createdAt: 1000 }); accounting.set(record.events[record.inherited], { end: record.end, droppedUnrun: false }); }
  const subagents = { listChildren: async (_root, signal) => { assert.equal(signal.aborted, false); catalogs++; return catalog; }, resume: () => { throw Error('must not resume'); } };
  let observe = async (id, options) => { assert.equal(options.projectionMode, 'all'); const c = children.get(id); if (!c) throw Error('native missing child'); return { header: c.header, inheritedEventCount: c.inherited, events: c.events, projections: { values: c.values }, [Symbol.dispose]: () => disposed++ }; };
  const query = { observeSession: (...args) => { observed++; return observe(...args); } }; const agents = { get: id => live.get(id), resolveAgent: () => { throw Error('must not wake'); } };
  let service = subagents;
  const port = createDshSubagentReads({ getSubagents: () => service, getQuery: () => query, getAgents: () => agents,
    getParent: (id, options) => visible(id, options), readConsumedWork: async events => accounting.get(events[0]) ?? { droppedUnrun: false }, ...options });
  const first = children.get('child-0');
  const address = (id = first?.id) => ({ sessionId: 'root', provider: 'pi', runIdOrAlias: id });
  return { children, accounting, live, subagents, port, first, address, get disposed() { return disposed; }, get observed() { return observed; }, get catalogs() { return catalogs; },
    setCatalog: rows => { catalog = rows; }, remove: () => { service = undefined; }, setObserve: fn => { observe = fn; }, setVisible: fn => { visible = fn; } };
}
test('native durable catalog authorizes stable read-only run IDs without agent activation or invented returned results', async () => {
  const f = fixture(); const page = await f.port.list({ sessionId: 'root' }); const run = page.runs[0];
  assert.equal(page.supported, true); assert.match(run.id, /^dsh-child:/); assert.equal(run.status, 'completed'); assert.match(run.title, /^DSH:/);
  assert.deepEqual(run.providerRunIds, ['child-0']); assert.deepEqual([run.capabilities.resume, run.capabilities.steer, run.capabilities.stop], [false, false, false]);
  const detail = await f.port.detail({ ...f.address(), runIdOrAlias: run.id }); assert.equal(detail.run.id, run.id); assert.equal(detail.run.returnedResult, undefined); assert.equal(detail.run.capabilities.viewReturnedResult, false); assert.equal(f.disposed, 2);
});
test('inactive is never completed without native consumed-work evidence; live execution is real running', async () => {
  const f = fixture(); f.accounting.set(f.first.events[f.first.inherited], { droppedUnrun: false });
  await assert.rejects(f.port.list({ sessionId: 'root' }), /no consumed terminal work/);
  f.live.set(f.first.id, { status: 'running' }); assert.equal((await f.port.detail(f.address())).run.status, 'running');
});
test('native errors/interruption and discarded unrun input retain their real terminal meanings and timestamps', async () => {
  const f = fixture(); f.first.end.data.reason.kind = 'error'; assert.equal((await f.port.detail(f.address())).run.status, 'failed');
  f.first.end.data.reason.kind = 'interrupted'; assert.equal((await f.port.detail(f.address())).run.status, 'stopped');
  const cancellation = f.first.add('agent/inbox/spliced', { target: 'next-turn', removedCount: 1, inserted: [], outcome: 'canceled' });
  f.accounting.set(f.first.events[f.first.inherited], { droppedUnrun: true }); const run = (await f.port.detail(f.address())).run;
  assert.equal(run.status, 'stopped'); assert.equal(run.endedAt, cancellation.time); assert.equal(run.activity.at(-1).kind, 'stopped');
});
test('unknown pending-work projection or queued input is not disguised as completed', async () => {
  const f = fixture(); delete f.first.values.inbox; await assert.rejects(f.port.detail(f.address()), /pending-work state is unknown/);
  f.first.values.inbox = { 'next-turn': [{}], 'next-step': [] }; await assert.rejects(f.port.detail(f.address()), /pending input/);
});
test('every detail/transcript rechecks the ordinary parent and its catalog before observing an arbitrary child', async () => {
  const f = fixture(); await assert.rejects(f.port.transcript(f.address('not-in-catalog')), { refusalCode: 'NOT_FOUND' }); assert.equal(f.observed, 0);
  f.setVisible(async () => undefined); await assert.rejects(f.port.detail(f.address()), { refusalCode: 'NOT_FOUND' }); assert.equal(f.observed, 0); assert.equal(f.catalogs, 1);
});
test('external, unknown and corrupt branches refuse explicitly instead of disappearing or gaining fake transcript capability', async () => {
  const f = fixture(); f.setCatalog([{ id: 'external', mode: 'external', createdAt: 1000 }]); await assert.rejects(f.port.list({ sessionId: 'root' }), /external, unknown/);
  f.setCatalog([{ id: 'broken', mode: 'unknown', createdAt: 1000 }]); await assert.rejects(f.port.transcript(f.address('broken')), /external, unknown/); assert.equal(f.observed, 0);
});
test('list pagination is real and its opaque cursors cannot cross parent/source/catalog generations', async () => {
  const f = fixture(3); const a = await f.port.list({ sessionId: 'root', limit: 2 }); assert.equal(a.runs.length, 2); assert.ok(a.nextCursor);
  const b = await f.port.list({ sessionId: 'root', limit: 2, cursor: a.nextCursor }); assert.equal(b.runs.length, 1); assert.equal(b.nextCursor, undefined);
  f.port.cancelAll(); await assert.rejects(f.port.list({ sessionId: 'root', cursor: a.nextCursor }), /catalog changed/);
});
test('transcript excludes inherited history, constructor closers and injected context while preserving own public text', async () => {
  const f = fixture(); const result = await f.port.transcript(f.address());
  assert.deepEqual(result.entries.map(row => row.role), ['parent', 'subagent']); assert.equal(result.entries[0].content, 'task for child-0');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false); assert.ok(result.tailCursor); assert.equal(result.nextCursor, undefined); assert.equal(f.disposed, 1);
});
test('transcript pages/tail reads preserve append identities and reject foreign cursors', async () => {
  const f = fixture(); const a = await f.port.transcript({ ...f.address(), limit: 1 }); assert.equal(a.entries.length, 1); assert.ok(a.nextCursor);
  const b = await f.port.transcript({ ...f.address(), cursor: a.nextCursor, limit: 1 }); assert.equal(b.entries.length, 1); assert.equal(b.nextCursor, undefined);
  assert.deepEqual((await f.port.transcript({ ...f.address(), cursor: b.tailCursor })).entries, []);
  f.first.add('turn/start', { turn: 2 }); f.first.add('assistant/message', { turn: 2, step: 1, message: { id: 'next', role: 'assistant', content: [{ type: 'text', text: 'appended answer' }] } }, 'append');
  const tail = await f.port.transcript({ ...f.address(), cursor: b.tailCursor }); assert.deepEqual(tail.entries.map(row => row.content), ['appended answer']);
  await assert.rejects(f.port.transcript({ ...f.address(), cursor: a.nextCursor + 'x' }), { refusalCode: 'BAD_REQUEST' });
});
test('native tool call/result pairs preserve call identity and actual public output without private tool arguments', async () => {
  const f = fixture(); f.first.add('assistant/message', { turn: 2, step: 1, message: { id: 'call', role: 'assistant', content: [{ type: 'tool-call', id: 'native-call', name: 'pwsh', arguments: '{"command":"PRIVATE tool input"}' }] } }, 'append');
  f.first.add('tool/result', { message: { id: 'result', role: 'user', source: { kind: 'tool' }, content: [{ type: 'tool-result', toolCallId: 'native-call', content: [{ type: 'text', text: 'actual tool output' }], isError: true }] } }, 'append');
  const result = await f.port.transcript(f.address()); const tools = result.entries.filter(row => row.role === 'tool');
  assert.deepEqual(tools.map(row => [row.toolCallId, row.toolPhase]), [['native-call', 'start'], ['native-call', 'end']]); assert.equal(tools[0].toolName, 'pwsh'); assert.equal(tools[1].content, 'actual tool output'); assert.equal(tools[1].isError, true); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});
test('long text is paginated as stable chunks rather than silently shortened', async () => {
  const f = fixture(); const text = 'x'.repeat(17000); f.first.events[7].data.message.content[0].text = text;
  const result = await f.port.transcript(f.address()); assert.equal(result.entries.filter(row => row.role === 'subagent').map(row => row.content).join(''), text);
  assert.equal(new Set(result.entries.map(row => row.sequence)).size, result.entries.length);
});
test('late cancelled child observations release their native lease and do not return a stale page', async () => {
  const f = fixture(); let finish; let released = 0; f.setObserve(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.port.transcript(f.address()); await tick(); f.port.cancelAll();
  finish({ header: f.first.header, events: f.first.events, inheritedEventCount: f.first.inherited, [Symbol.dispose]: () => released++ });
  await assert.rejects(pending, { refusalCode: 'NOT_AVAILABLE' }); assert.equal(released, 1);
});
test('missing native catalog, invalid fields, oversized pages and foreign providers never become pretend supported sessions', async () => {
  const f = fixture(); f.remove(); await assert.rejects(f.port.list({ sessionId: 'root' }), { refusalCode: 'NOT_AVAILABLE' });
  await assert.rejects(f.port.list({ sessionId: 'root', extra: true }), { refusalCode: 'BAD_REQUEST' });
  await assert.rejects(f.port.list({ sessionId: 'root', limit: 26 }), { refusalCode: 'NOT_AVAILABLE' });
  assert.deepEqual(await f.port.detail({ ...f.address(), provider: 'codex' }), { supported: false, run: null });
});

test('official three read routes use the Host port and keep control unsupported', async () => {
  const f = fixture(); const router = createChannelRouter({ listSessions: async () => [], subscribers: new Set(), resolveCapabilities: () => ({ subagentReads: f.port }) });
  const invoke = (channel, args) => router({ v: 1, id: 'read', src: 'phone', kind: 'invoke', payload: { channel, args } });
  assert.equal((await invoke('local-db:subagent-runs:list', [{ sessionId: 'root' }])).payload.result.runs.length, 1);
  assert.equal((await invoke('local-db:subagent-runs:detail', [f.address()])).payload.result.run.status, 'completed');
  assert.equal((await invoke('local-db:subagent-runs:transcript', [f.address()])).payload.result.entries.length, 2);
  assert.equal((await invoke('local-db:subagent-runs:detail', [f.address(), {}])).payload.error.code, 'BAD_REQUEST');
  assert.equal((await invoke('maker:pi-subagent:control', [{ ...f.address(), action: 'stop' }])).payload.error.code, 'CHANNEL_NOT_ALLOWED');
});
test('native descendant traversal retains root authorization and rejects disconnected catalog relations', async () => {
  const f = fixture(2); f.children.get('child-1').header.parentSession = 'child-0';
  f.subagents.listDescendants = async () => [{ id: 'child-0', parentId: 'root', kind: 'child', mode: 'continuable', activity: 'inactive' }, { id: 'child-1', parentId: 'child-0', kind: 'child', mode: 'continuable', activity: 'inactive' }];
  const listed = await f.port.list({ sessionId: 'root' }); assert.equal(listed.runs.length, 2); assert.ok(listed.runs.every(run => run.parentSessionId === 'root' && run.status === 'completed'));
  assert.equal((await f.port.detail(f.address('child-1'))).run.logicalAgentId, 'child-1');
  f.subagents.listDescendants = async () => [{ id: 'child-1', parentId: 'unrelated-root', kind: 'child', mode: 'continuable' }];
  await assert.rejects(f.port.transcript(f.address('child-1')), /not rooted/);
});
test('public transcript budgets fail explicitly and every failed native observation lease closes', async () => {
  const f = fixture(1, { maxBytes: 4 }); await assert.rejects(f.port.transcript(f.address()), /byte budget/); assert.equal(f.disposed, 1);
  const g = fixture(1, { maxEvents: 2 }); await assert.rejects(g.port.detail(g.address()), /over budget/); assert.equal(g.disposed, 1);
});

test('serialized page budgets retain real next cursors without dropping long control-character text', async () => {
  const f = fixture(1, { maxPageBytes: 60000 }); const text = String.fromCharCode(0).repeat(64000); f.first.events[7].data.message.content[0].text = text;
  let cursor; let combined = ''; let pages = 0;
  do { const page = await f.port.transcript({ ...f.address(), ...(cursor ? { cursor } : {}) });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 60000); combined += page.entries.filter(entry => entry.role === 'subagent').map(entry => entry.content).join(''); cursor = page.nextCursor; pages++;
  } while (cursor);
  assert.equal(combined, text); assert.ok(pages > 1);
});
test('consumed-work SDK stays host-provided: no private SDK dependency graph is installed', async () => {
  const { readFile } = await import('node:fs/promises'); const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.peerDependencies['@deepseek-ai/dsh-agent'].includes('0.2.1-rc.5'));
  assert.equal(manifest.dependencies?.['@deepseek-ai/dsh-agent'], undefined); assert.equal(manifest.optionalDependencies?.['@deepseek-ai/dsh-agent'], undefined);
});
