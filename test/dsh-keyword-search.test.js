import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshKeywordSearch, parseKeywordSearch, searchWorkingDir } from '../src/dsh-keyword-search.js';
import { createChannelRouter } from '../src/cindy-channels.js';
const NOW = Date.parse('2026-11-03T12:00:00Z');
const tick = () => new Promise(resolve => setImmediate(resolve));
function row(id, extra = {}) {
  return { id, title: id, status: 'active', agentKind: 'pi', workingDir: '/repo', workspaceKind: 'project',
    createdAt: new Date(NOW - 3 * 86400000).toISOString(), updatedAt: new Date(NOW).toISOString(), userSendAt: null, _count: null,
    deviceLinkDeviceId: 'host', deviceLinkDeviceName: 'DSH', ...extra };
}
function events(id, text = 'the needle is here') {
  const data = [
    ['turn/start', { turn: 1 }], ['step/start', { turn: 1, step: 1 }],
    ['user/message', { id: 'question', role: 'user', source: { kind: 'user', rpcId: 'request-' + id }, content: [{ type: 'text', text: 'Question' }] }, 'append'],
    ['assistant/message', { turn: 1, step: 1, message: { id: 'answer', role: 'assistant', content: [{ type: 'text', text }] } }, 'append'],
    ['step/end', { turn: 1, step: 1 }], ['turn/end', { turn: 1, reason: { kind: 'completed' } }],
  ];
  return data.map(([type, data, surfaceOp], seq) => ({ type, data, seq, time: NOW - 100 + seq, ...(surfaceOp ? { surfaceOp } : {}) }));
}
function fixture(rows = [row('one')], options = {}) {
  const calls = []; let released = 0; let reads = 0; let candidateReads = 0; let failure; let observation;
  const logs = new Map(rows.map(row => [row.id, events(row.id)]));
  const query = {
    filterEvents: async (id, filters) => { calls.push({ id, filters }); if (failure) throw failure;
      const term = filters[2].text.toLowerCase(); const body = logs.get(id)[3].data.message.content[0].text.toLowerCase();
      return body.includes(term) ? [{ sessionId: id, seq: 3, type: 'assistant/message', surface: 'current' }] : []; },
    observeSession: async id => { if (observation) return observation(id); return { header: { id }, events: logs.get(id), [Symbol.dispose]: () => released++ }; },
  };
  let service = query;
  const port = createDshKeywordSearch({ getQuery: () => service, getSession: async id => { reads++; return { id }; }, now: () => NOW, ...options });
  const candidates = async () => { candidateReads++; return rows; };
  const run = request => port.run({ query: 'needle', semanticMode: 'keyword', ...request }, { getCandidates: candidates });
  return { rows, logs, query, port, run, calls, candidates, get released() { return released; }, get reads() { return reads; }, get candidateReads() { return candidateReads; },
    setFailure: value => { failure = value; }, setObservation: value => { observation = value; }, removeService: () => { service = undefined; } };
}
test('keyword search calls native current-surface literal filters and returns true row identities/counts', async () => {
  const f = fixture(); const value = await f.run({});
  assert.equal(value.vectorUsed, false); assert.equal(value.poolCapped, false); assert.equal(value.results.length, 1);
  const item = value.results[0]; assert.equal(item.matchKind, 'content'); assert.deepEqual(item.session._count, { messages: 2 });
  assert.equal(item.contentHit.messageId, 'one:answer:0'); assert.equal(item.contentHit.messageClientId, 'one:answer:0');
  assert.equal(item.contentHit.ftsRank, null); assert.equal(item.contentHit.vectorRank, null); assert.equal(item.contentHit.snippet, null);
  assert.deepEqual(f.calls[0].filters, [{ kind: 'type', values: ['user/message', 'assistant/message'] }, { kind: 'surface', values: ['current'] }, { kind: 'text', text: 'needle' }]);
  assert.equal(f.released, 1);
});
test('keyword limits above twenty are real, with deterministic activity sorting before the limit', async () => {
  const rows = Array.from({ length: 45 }, (_, i) => row('s-' + i, { updatedAt: new Date(NOW - i * 1000).toISOString() }));
  const f = fixture(rows); const value = await f.run({ limit: 40, sortBy: 'activityAsc' });
  assert.equal(value.results.length, 40); assert.equal(value.results[0].session.id, 's-44'); assert.equal(value.poolCapped, false);
  assert.equal(f.calls.length, 45);
});
test('all accepted status/archive, agent alias, activity, ID and working-directory filters execute', async () => {
  const f = fixture([row('active', { agentKind: 'claude-code' }), row('archived', { status: 'archived', agentKind: 'codex' }),
    row('old', { updatedAt: new Date(NOW - 8 * 86400000).toISOString(), agentKind: 'pi' }), row('deleted', { status: 'deleted' }), row('worker', { orcaRole: 'worker' })]);
  assert.deepEqual((await f.run({ filters: { status: 'archived' } })).results.map(x => x.session.id), ['archived']);
  assert.deepEqual((await f.run({ includeArchived: false, filters: { agentKind: 'cc', lastActivity: '1d', workingDirs: ['/repo/'], sessionIds: ['active'] } })).results.map(x => x.session.id), ['active']);
  assert.equal((await f.run({ includeArchived: false, filters: { status: 'archived' } })).results[0].session.agentKind, 'codex');
  assert.deepEqual((await f.run({ filters: { sessionIds: [] } })).results, []);
  assert.equal((await f.run({ filters: { workingDirs: [] } })).results.length, 3);
  assert.deepEqual((await f.run({ filters: { agentKind: 'pi', lastActivity: '7d' } })).results, []);
});
test('title matching uses literal escaped text and the exact untrimmed unnamed-label projection', async () => {
  const f = fixture([row('draft', { title: 'New Maker' }), row('literal', { title: 'a.*b' })]);
  const draft = await f.run({ query: '命名', unnamedLabel: ' 未命名 ' });
  assert.equal(draft.results[0].session.title, 'New Maker'); assert.deepEqual(draft.results[0].titleMatchIndices, [2, 3]);
  assert.equal(draft.results[0].matchKind, 'title');
  assert.equal((await f.run({ query: '.*' })).results[0].session.id, 'literal');
  assert.equal((await f.run({ query: 'a.*z' })).results.length, 0);
});
test('invalid or unsupported fields/modes refuse before native reads, including explicit hybrid', async () => {
  const f = fixture();
  for (const request of [{ semanticMode: 'hybrid' }, { semanticMode: 'other' }, { query: '' }, { query: 'x'.repeat(513) },
    { unknown: true }, { limit: 201 }, { limit: 2.5 }, { sortBy: 'unknown' }, { includeArchived: 'yes' },
    { filters: { status: 'deleted' } }, { filters: { agentKind: 'gpt' } }, { filters: { lastActivity: '2d' } },
    { filters: { sessionIds: [null] } }, { filters: { workingDirs: [4] } }, { filters: { model: 'other' } }, { unnamedLabel: 'x'.repeat(121) }]) {
    await assert.rejects(f.run(request));
  }
  assert.equal(f.candidateReads, 0); assert.equal(f.calls.length, 0); assert.equal(f.reads, 0);
});
test('missing native search cannot become title-only pseudo search or an empty success', async () => {
  const f = fixture(); f.removeService(); await assert.rejects(f.run({ query: 'one' }), { refusalCode: 'NOT_AVAILABLE' });
  assert.equal(f.candidateReads, 0);
  const g = fixture(); g.setFailure(Error('native storage failed')); await assert.rejects(g.run({}), /native storage failed/);
});
test('scan/session/event/byte/response budgets report poolCapped, never a complete empty result', async () => {
  for (const options of [{ maxSessions: 1 }, { maxEvents: 1 }, { maxBytes: 1 }, { durationMs: 0 }, { maxResponseBytes: 300 }]) {
    const f = fixture([row('one'), row('two')], options); const value = await f.run({}); assert.equal(value.poolCapped, true);
    if (options.maxSessions) assert.equal(value.results.length, 1);
  }
});
test('cancellation rejects in-flight read and eventually disposes a late native observation lease', async () => {
  const f = fixture(); let finish; let released = 0;
  f.setObservation(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.run({}); await tick(); f.port.cancelAll(); await assert.rejects(pending, /cancelled/);
  finish({ header: { id: 'one' }, events: f.logs.get('one'), [Symbol.dispose]: () => released++ }); await tick(); assert.equal(released, 1);
});
test('read timeout reports a capped pool and releases its late lease', async () => {
  const f = fixture([row('one')], { durationMs: 10 }); let finish; let released = 0;
  f.setObservation(() => new Promise(resolve => { finish = resolve; })); const pending = f.run({}); await tick();
  assert.equal((await pending).poolCapped, true);
  finish({ header: { id: 'one' }, events: f.logs.get('one'), [Symbol.dispose]: () => released++ }); await tick(); assert.equal(released, 1);
});
test('search working-directory projection follows Windows prefixes and worktree grouping without rewriting POSIX backslashes', () => {
  const bs = String.fromCharCode(92);
  assert.equal(searchWorkingDir('C:' + bs + 'repo' + bs), 'C:/repo');
  assert.equal(searchWorkingDir(bs + bs + '?' + bs + 'C:' + bs + 'repo'), 'C:/repo');
  assert.equal(searchWorkingDir('/repo/.worktrees/branch/src'), '/repo');
  assert.equal(searchWorkingDir('/repo/.claude/worktrees/branch'), '/repo');
  assert.equal(searchWorkingDir('/repo/weird' + bs + '.worktrees/branch'), '/repo/weird' + bs + '.worktrees/branch');
});
test('official search channel consumes the existing projected session rows and preserves request fields', async () => {
  const f = fixture(); const router = createChannelRouter({ listSessions: f.candidates, subscribers: new Set(), resolveCapabilities: () => ({ keywordSearch: f.port }) });
  const request = { v: 1, id: 'search', src: 'phone', kind: 'invoke', payload: { channel: 'local-db:conversations:search', args: [{ query: 'needle', semanticMode: 'keyword', limit: 40 }] } };
  const value = (await router(request)).payload; assert.equal(value.ok, true); assert.equal(value.result.results[0].contentHit.messageClientId, 'one:answer:0');
  assert.equal(value.result.results[0].session.deviceLinkDeviceId, null);
});
test('concurrent native searches are bounded and a rejected reader does not start native IO', async () => {
  const f = fixture([row('one')], { maxConcurrent: 1 }); let finish;
  f.setObservation(() => new Promise(resolve => { finish = resolve; }));
  const first = f.run({}); await tick();
  await assert.rejects(f.run({}), /Too many concurrent/); assert.equal(f.calls.length, 1);
  finish({ header: { id: 'one' }, events: f.logs.get('one'), [Symbol.dispose]: () => {} });
  assert.equal((await first).results.length, 1);
});
test('cancelled uncancellable native reads retain their resource slot until the owner settles', async () => {
  const f = fixture([row('one')], { maxOutstandingReads: 1 }); let finish; let released = 0;
  f.setObservation(() => new Promise(resolve => { finish = resolve; }));
  const first = f.run({}); await tick(); f.port.cancelAll(); await assert.rejects(first, /cancelled/);
  const before = f.candidateReads; await assert.rejects(f.run({}), /still pending/); assert.equal(f.candidateReads, before);
  finish({ header: { id: 'one' }, events: f.logs.get('one'), [Symbol.dispose]: () => released++ }); await tick();
  assert.equal(released, 1); f.setObservation(undefined); assert.equal((await f.run({})).results.length, 1);
});
