import test from 'node:test';
import assert from 'node:assert/strict';
import { readActiveSessionSummaries } from '../src/dsh-active-sessions.js';

function fixture() {
  const liveAgents = new Map();
  const liveSessions = new Map();
  const metadata = new Map();
  const reads = [];
  const unexpected = () => { throw new Error('unexpected corpus/log read'); };
  const services = {
    agents: { list: () => [...liveAgents.values()], get: (id) => liveAgents.get(id) },
    sessions: { get: (id) => liveSessions.get(id), list: unexpected },
    sessionProjections: {
      snapshot(session, keys) {
        assert.deepEqual(keys, ['sessionListMetadata']);
        reads.push(session.id);
        return { asOfSeq: session.seq - 1, values: metadata.has(session.id)
          ? { sessionListMetadata: metadata.get(session.id) } : {} };
      },
      cachedSnapshot: unexpected,
    },
    sessionController: { list: unexpected },
    sessionQuery: { listSessions: unexpected, observeSession: unexpected },
    sessionPersist: { list: unexpected, read: unexpected },
  };
  const lookups = [];
  const ctx = { get(key) { lookups.push(key); return services[key]; } };
  function add(id, { status = 'running', seq = 5, header = {}, meta = { blank: false, lastPromptAt: 200 } } = {}) {
    const session = {
      id, seq, header: { id, cwd: 'G:\\project', createdAt: 100, ...header },
      snapshotEvents: unexpected, ownEvents: unexpected, deriveMessages: unexpected,
    };
    const agent = { id, status, session };
    liveSessions.set(id, session);
    liveAgents.set(id, agent);
    if (meta !== undefined) metadata.set(id, meta);
    return { agent, session };
  }
  return { ctx, services, liveAgents, liveSessions, metadata, reads, lookups, add };
}

test('returns only current running summaries, using selected live metadata and activity ordering', () => {
  const f = fixture();
  f.add('older', { meta: { blank: false, lastPromptAt: 150 } });
  f.add('newer', { header: { createdAt: 300 }, meta: { blank: false, lastPromptAt: 250 } });
  f.add('idle', { status: 'idle' });
  f.add('no-status', { status: undefined });
  f.liveAgents.get('no-status').status = undefined;
  const rows = readActiveSessionSummaries(f.ctx);
  assert.deepEqual(rows.map(({ sessionId, running, blank, updatedAt, cwd, agentAvailable }) =>
    ({ sessionId, running, blank, updatedAt, cwd, agentAvailable })), [
    { sessionId: 'newer', running: true, blank: false, updatedAt: 300, cwd: 'G:\\project', agentAvailable: true },
    { sessionId: 'older', running: true, blank: false, updatedAt: 150, cwd: 'G:\\project', agentAvailable: true },
  ]);
  assert.deepEqual(f.reads, ['older', 'newer']);
  assert.deepEqual(Object.keys(rows[0].projections.values), ['sessionListMetadata']);
  assert.deepEqual(f.lookups, ['agents', 'sessions', 'sessionProjections']);
});

test('running to idle, disposal, and replacement services take effect without a TTL', () => {
  const f = fixture();
  const { agent } = f.add('s');
  assert.equal(readActiveSessionSummaries(f.ctx).length, 1);
  agent.status = 'idle';
  assert.deepEqual(readActiveSessionSummaries(f.ctx), []);
  agent.status = 'running';
  assert.equal(readActiveSessionSummaries(f.ctx).length, 1);
  f.liveAgents.delete('s');
  assert.deepEqual(readActiveSessionSummaries(f.ctx), []);
  f.services.agents = { list: () => [], get: () => undefined };
  assert.deepEqual(readActiveSessionSummaries(f.ctx), []);
  f.services.sessionProjections = undefined;
  assert.equal(readActiveSessionSummaries(f.ctx), null);
});

test('filters durable children, subagents, missing cwd, and blanks before exposing tasks', () => {
  const f = fixture();
  f.add('child', { header: { parentSession: 'parent' } });
  f.add('subagent', { header: { origin: 'subagent' } });
  f.add('no-cwd', { header: { cwd: undefined } });
  f.add('empty-cwd', { header: { cwd: '' } });
  f.add('blank', { meta: { blank: true } });
  f.add('empty', { seq: 0 });
  f.metadata.delete('empty');
  f.add('nonempty');
  f.metadata.delete('nonempty');
  f.add('projected-nonblank', { seq: 0, header: { parentSession: null }, meta: { blank: false } });
  const rows = readActiveSessionSummaries(f.ctx);
  assert.deepEqual(rows.map((row) => row.sessionId), ['nonempty', 'projected-nonblank']);
  assert.equal(rows[0].updatedAt, 100);
  assert.equal(rows[1].blank, false, 'authoritative metadata overrides seq fallback');
  assert.deepEqual(f.reads, ['blank', 'empty', 'nonempty', 'projected-nonblank']);
});

test('unavailable registry APIs return null, while an available empty registry is authoritative', () => {
  assert.equal(readActiveSessionSummaries(undefined), null);
  assert.equal(readActiveSessionSummaries({}), null);
  for (const service of ['agents', 'sessions', 'sessionProjections']) {
    const f = fixture();
    f.services[service] = undefined;
    assert.equal(readActiveSessionSummaries(f.ctx), null);
  }
  for (const [service, method] of [['agents', 'list'], ['agents', 'get'], ['sessions', 'get'], ['sessionProjections', 'snapshot']]) {
    const f = fixture();
    f.services[service][method] = undefined;
    assert.equal(readActiveSessionSummaries(f.ctx), null);
  }
  assert.deepEqual(readActiveSessionSummaries(fixture().ctx), []);
});

test('propagates real lookup, listing, and projection failures instead of fabricating no running tasks', () => {
  const failure = new Error('read failed');
  assert.throws(() => readActiveSessionSummaries({ get() { throw failure; } }), (err) => err === failure);
  for (const [service, method] of [['agents', 'list'], ['agents', 'get'], ['sessions', 'get'], ['sessionProjections', 'snapshot']]) {
    const f = fixture();
    f.add('s');
    f.services[service][method] = () => { throw failure; };
    assert.throws(() => readActiveSessionSummaries(f.ctx), (err) => err === failure);
  }
  const f = fixture();
  f.services.agents.list = () => null;
  assert.throws(() => readActiveSessionSummaries(f.ctx), /must return an array/);
});

test('excludes detached sessions, mismatched attached instances, and superseded registry agents', () => {
  const f = fixture();
  f.add('detached');
  f.liveSessions.delete('detached');
  const mismatched = f.add('mismatched');
  f.liveSessions.set('mismatched', { ...mismatched.session });
  const stale = f.add('stale');
  const replacement = { ...stale.agent };
  const realGet = f.services.agents.get;
  f.services.agents.get = (id) => id === 'stale' ? replacement : realGet(id);
  f.add('wrong-header', { header: { id: 'other' } });
  assert.deepEqual(readActiveSessionSummaries(f.ctx), []);
  assert.deepEqual(f.reads, []);
});

test('revalidates identity and running status if projection read synchronously changes lifecycle', () => {
  for (const mutate of [
    (f, agent) => { agent.status = 'idle'; },
    (f, agent) => { f.liveAgents.delete(agent.id); },
    (f, agent) => { f.liveSessions.set(agent.id, { ...agent.session }); },
    (f, agent) => { agent.session = { ...agent.session }; },
  ]) {
    const f = fixture();
    const { agent } = f.add('s');
    const snapshot = f.services.sessionProjections.snapshot;
    f.services.sessionProjections.snapshot = (...args) => {
      const result = snapshot(...args);
      mutate(f, agent);
      return result;
    };
    assert.deepEqual(readActiveSessionSummaries(f.ctx), []);
  }
});

test('does not visit idle/cold logs or controller/query/persistence APIs', () => {
  const f = fixture();
  for (let i = 0; i < 200; i++) f.add(`idle-${i}`, { status: 'idle' });
  f.add('running');
  assert.equal(readActiveSessionSummaries(f.ctx).length, 1);
  assert.deepEqual(f.reads, ['running']);
  assert.deepEqual(f.lookups, ['agents', 'sessions', 'sessionProjections']);
});
