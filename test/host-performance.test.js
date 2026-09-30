import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDshSource } from '../src/dsh-plugin.js';
import { createSessionControllerSource } from '../src/dsh-session-source.js';
import { startHost } from '../src/host.js';

const at = 1790774329425;
const call = (runtime, channel, args = []) => runtime.invokeForTest(channel, args);
function fixture() {
  let corpusReads = 0;
  let metadataReads = 0;
  const session = { id: 'task', header: { id: 'task', createdAt: at, cwd: 'G:/project' }, seq: 10 };
  const agent = { id: 'task', session, status: 'running' };
  let agents = [agent];
  const services = {
    agents: { list: () => agents, get: id => agents.find(item => item.id === id) },
    sessions: { get: id => id === session.id ? session : undefined },
    sessionProjections: { snapshot: (_session, keys) => {
      assert.deepEqual(keys, ['sessionListMetadata']);
      return { values: { sessionListMetadata: { blank: false, lastPromptAt: at + 100 } } };
    } },
    sessionController: { list: async () => { corpusReads++; return { items: [] }; } },
    sessionQuery: {
      listSessions: async () => { metadataReads++; return []; },
      readTitleSnapshots: async ids => ids.map(sessionId => ({ sessionId, status: 'fulfilled', value: { title: { title: 'A title' } } })),
      observeSession: async id => ({ header: { ...session.header, id }, projections: { values: {
        modelSelection: { next: { provider: 'provider', model: 'model', reasoningEffort: 'high' } }, permissions: { currentValue: 'read-only' },
      } }, [Symbol.dispose]() {} }),
    },
  };
  const ctx = { get: name => services[name], on: () => () => {}, inject: () => () => {} };
  const seam = buildDshSource(ctx, 'sessionController');
  return { seam, services, agent, removeAgent: () => { agents = []; }, reads: () => ({ corpusReads, metadataReads }) };
}

test('real plugin/source active polls use current live states with zero persistent corpus reads', async () => {
  const f = fixture();
  for (let index = 0; index < 8; index++) {
    const rows = await f.seam.source.listSessionStates();
    assert.deepEqual(rows.map(row => row.id), ['task']);
  }
  f.agent.status = 'idle';
  assert.deepEqual(await f.seam.source.listSessionStates(), []);
  assert.deepEqual(await f.seam.source.listSessionStates('task'), [{ id: 'task', running: false, updatedAt: null }]);
  f.agent.status = 'running';
  assert.equal((await f.seam.source.listSessionStates('task'))[0].running, true);
  f.removeAgent();
  assert.equal((await f.seam.source.listSessionStates('task'))[0].running, false);
  assert.deepEqual(f.reads(), { corpusReads: 0, metadataReads: 0 });
  assert.equal(f.seam.source.listDiagnostics().activeStateFallbacks, 0);
  assert.equal(f.seam.source.listDiagnostics().activeStateReads, 12);
});

test('cold concurrent exact gets preserve metadata and perform no metadata corpus scan', async () => {
  const f = fixture();
  const rows = await Promise.all([f.seam.source.getSession('task'), f.seam.source.getSession('task')]);
  for (const row of rows) {
    assert.equal(row.createdAt, new Date(at).toISOString());
    assert.equal(row.cwd, 'G:/project');
    assert.equal(row.title, 'A title');
    assert.equal(row.providerId, 'provider');
    assert.equal(row.model, 'model');
    assert.equal(row.effort, 'high');
    assert.equal(row.permissionMode, 'read-only');
  }
  assert.deepEqual(f.reads(), { corpusReads: 0, metadataReads: 0 });
});

test('legacy summaries missing immutable metadata still use their metadata reader', async () => {
  const reads = [];
  const source = createSessionControllerSource({
    sessionController: { list: async () => ({ items: [{ sessionId: 'legacy', updatedAt: at }] }) },
    readSessionMeta: async ids => { reads.push(ids); return new Map([['legacy', { createdAt: new Date(at - 100).toISOString(), cwd: 'G:/legacy' }]]); },
  });
  const [row] = await source.listSessions();
  assert.equal(row.createdAt, new Date(at - 100).toISOString());
  assert.equal(row.cwd, 'G:/legacy');
  assert.deepEqual(reads, [['legacy']]);
});

test('missing live service APIs or failed observations fall back explicitly, not to fabricated empty states', async () => {
  for (const mode of ['missing', 'failure']) {
    const f = fixture();
    f.services.sessionController.list = async () => ({ items: [{ sessionId: 'fallback', running: true, updatedAt: at }] });
    if (mode === 'missing') delete f.services.agents;
    else f.services.agents.list = () => { throw new Error('registry unavailable'); };
    const [row] = await f.seam.source.listSessionStates();
    assert.equal(row.id, 'fallback');
    const diagnostics = f.seam.source.listDiagnostics();
    assert.equal(diagnostics.activeStateReads, 0);
    assert.equal(diagnostics.activeStateFallbacks, 1);
    assert.equal(diagnostics.lastActiveStateError, mode === 'failure' ? 'registry unavailable' : null);
  }
});

test('actual Host passes watchdog identity and preserves archived/deleted active filtering', async () => {
  const f = fixture();
  const runtime = await startHost(f.seam.source, { transportEnabled: false, remoteControlEnabled: false }, { resolveCapabilities: () => ({ isSessionRunning: () => true }) });
  try {
    assert.equal((await call(runtime, 'maker:session-in-turn', ['task'])).reply.payload.result, true);
    f.removeAgent();
    assert.equal((await call(runtime, 'maker:session-in-turn', ['task'])).reply.payload.result, false, 'authoritative absence beats stale runtime running=true');
    assert.deepEqual((await call(runtime, 'maker:list-active')).reply.payload.result, []);
  } finally { await runtime.stop(); }
  for (const status of ['archived', 'deleted']) {
    const hidden = fixture();
    const host = await startHost(hidden.seam.source, { transportEnabled: false, remoteControlEnabled: false, sessionFlags: { task: { status } } }, {});
    try { assert.deepEqual((await call(host, 'maker:list-active')).reply.payload.result, []); }
    finally { await host.stop(); }
    assert.deepEqual(hidden.reads(), { corpusReads: 0, metadataReads: 0 });
  }
});
