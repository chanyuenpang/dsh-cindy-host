import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionControllerSource, selectSessionRows } from '../src/dsh-session-source.js';
import { toCindySessionListRow } from '../src/cindy-session-row.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
function item(id, at = 100, title = id) {
  return { sessionId: id, createdAt: 1, updatedAt: at, cwd: 'G:/work', running: false,
    projections: { kind: 'sequenced', asOfSeq: 2, values: { title, sessionListMetadata: { blank: false, lastPromptAt: at } } } };
}
function setup(initial = [item('a')], extra = {}) {
  const handlers = new Map(); let items = initial, calls = 0;
  const subscribe = (name, fn) => { const set = handlers.get(name) ?? new Set(); set.add(fn); handlers.set(name, set); return () => set.delete(fn); };
  const source = createSessionControllerSource({
    sessionController: { async list() { calls++; return { items: structuredClone(items) }; } },
    subscribe, readSessionSummary: async id => structuredClone(items.find(row => row.sessionId === id)), ...extra,
  });
  return { source, set: next => { items = next; }, calls: () => calls,
    emit(name, ...args) { for (const fn of handlers.get(name) ?? []) fn(...args); },
    listeners: () => [...handlers.values()].reduce((sum, set) => sum + set.size, 0) };
}

test('requires the native controller', () => {
  assert.throws(() => createSessionControllerSource({}), /requires sessionController/);
});
test('one core owner supplies exact title, route, permission and paired activity time', async t => {
  const row = item('a'); row.projections.values.modelSelection = { next: { model: 'gpt', provider: 'openai', reasoningEffort: 'high' } };
  row.projections.values.permissions = { currentValue: 'read-only' };
  const { source } = setup([row]); t.after(() => source.dispose());
  const [listed] = await source.listSessions(); const exact = await source.getSession('a');
  assert.deepEqual(exact, listed);
  assert.equal(listed.title, 'a'); assert.equal(listed.model, 'gpt'); assert.equal(listed.providerId, 'openai');
  assert.equal(listed.effort, 'high'); assert.equal(listed.permissionMode, 'read-only');
  assert.equal(listed.updatedAt, new Date(100).toISOString()); assert.equal(listed.lastActivityAt, listed.updatedAt);
});
test('drafts and delegated runs are not discovery; exact draft remains addressable', async t => {
  const draft = item('draft', 1, null); draft.projections.values.sessionListMetadata.blank = true;
  const sub = { ...item('sub'), origin: 'subagent', parentSessionId: 'a' };
  const fork = { ...item('fork'), parentSessionId: 'a' };
  const { source } = setup([draft, sub, fork]); t.after(() => source.dispose());
  assert.deepEqual((await source.listSessions()).map(row => row.id), ['fork']);
  assert.equal((await source.getSession('draft')).blank, true);
  assert.equal(await source.getSession('sub'), undefined);
});
test('known or newly declared subagent lifecycle cannot invalidate the task catalog', async t => {
  const child = { ...item('child'), origin: 'subagent' };
  const env = setup([item('root'), child]); t.after(() => env.source.dispose());
  await env.source.listSessions({ evidence: false }); const revision = env.source.listVersion(), reads = env.source.listDiagnostics().exactReads;
  env.emit('api-session/status', 'child', true); env.emit('api-session/removed', 'child');
  env.emit('api-session/added', { ...item('new-child'), origin: 'subagent' });
  env.emit('api-session/status', 'new-child', true); env.emit('api-session/removed', 'new-child');
  await env.source.titlesSettled();
  assert.equal(env.source.listVersion(), revision); assert.equal(env.source.listDiagnostics().exactReads, reads);
  assert.deepEqual(env.source.snapshotRows().map(row => row.id), ['root']);
});

test('first real title appears immediately, without null TTL or another list poll', async t => {
  const env = setup([item('a', 10, null)]); t.after(() => env.source.dispose());
  assert.deepEqual(await env.source.listSessions(), []);
  const events = []; env.source.onListChange(event => events.push(event));
  env.set([item('a', 10, 'Named')]);
  env.emit('session/event', { id: 'a', header: { id: 'a' } }, { type: 'session/title' });
  await env.source.titlesSettled();
  assert.equal(env.source.peekSession('a').title, 'Named');
  assert.equal(events.some(event => event.discovered && event.row.title === 'Named'), true);
});
test('a failed catalog is a failure, never the previous successful list', async t => {
  let fail = false;
  const { source } = setup([], { sessionController: { async list() { if (fail) throw new Error('disk offline'); return { items: [item('a')] }; } } });
  t.after(() => source.dispose()); await source.listSessions(); fail = true;
  await assert.rejects(source.listSessions({ fresh: true }), /disk offline/);
  assert.equal(source.listDiagnostics().staleServes, 0);
});
test('fresh does not join a read started before its request; equivalent ordinary flights do share', async t => {
  const hold = gate(); let reads = 0;
  const { source } = setup([], { sessionController: { async list() { const n = ++reads; if (n === 1) await hold.promise; return { items: [] }; } } });
  t.after(() => source.dispose());
  const a = source.listSessions(), b = source.listSessions();
  await tick(); assert.equal(reads, 1);
  const fresh = source.listSessions({ fresh: true }); await tick();
  assert.equal(reads, 1, 'cold catalog scans are serialized, not multiplied per caller');
  hold.release(); await Promise.all([a, b, fresh]); assert.equal(reads, 2, 'fresh starts a new source read after its request');
  await source.listSessions(); assert.equal(reads, 3, 'no settled result TTL');
});
test('an old exact completion cannot overwrite or reply over a committed rename', async t => {
  const hold = gate(); let reads = 0; let current = item('a', 10, 'old');
  const env = setup([current], { readSessionSummary: async () => { const snap = structuredClone(current); if (++reads === 1) await hold.promise; return snap; } });
  t.after(() => env.source.dispose());
  const pending = env.source.getSession('a'); await tick();
  current = item('a', 20, 'new'); env.set([current]); env.source.invalidateTitle('a');
  hold.release();
  assert.equal((await pending).title, 'new');
  assert.equal(env.source.peekSession('a').title, 'new');
  assert.ok(env.source.listDiagnostics().rejectedVersions > 0);
});
test('an invalidated global baseline cannot publish its old exact rows', async t => {
  const hold = gate(); let reads = 0; let current = item('a', 10, 'old');
  const env = setup([current], { readSessionSummary: async () => { const snap = structuredClone(current); if (++reads === 1) await hold.promise; return snap; } });
  t.after(() => env.source.dispose());
  const pending = env.source.listSessions(); await tick();
  current = item('a', 20, 'new'); env.set([current]); env.source.invalidateListing(); hold.release();
  assert.equal((await pending)[0].title, 'new');
});
test('observers exist before initial list; a creation during bootstrap is not lost', async t => {
  const hold = gate(); let reads = 0; const a = item('a'), b = item('b');
  const env = setup([a, b], { sessionController: { async list() { const n = ++reads; if (n === 1) { await hold.promise; return { items: [a] }; } return { items: [a, b] }; } } });
  t.after(() => env.source.dispose()); assert.ok(env.listeners() > 0);
  const pending = env.source.listSessions(); await tick(); env.emit('api-session/added', b); hold.release();
  assert.deepEqual((await pending).map(row => row.id).sort(), ['a', 'b']);
});
test('native live removal is not persistent deletion', async t => {
  const env = setup(); t.after(() => env.source.dispose()); await env.source.listSessions();
  env.emit('api-session/removed', 'a'); await env.source.titlesSettled();
  assert.equal(env.source.peekSession('a').title, 'a');
});
test('strict core refuses unknown title/time/blank instead of inventing success', async t => {
  const broken = item('a'); delete broken.projections.values.sessionListMetadata;
  const { source } = setup([broken]); t.after(() => source.dispose());
  await assert.rejects(source.listSessions(), /core projections/);
  assert.equal(source.listDiagnostics().coverage, 'rebuilding');
});
test('selection applies flags, stable activity order, status and outside-window pins before evidence', async t => {
  const activity = []; const env = setup([item('a', 30), item('b', 20), item('c', 10)], { readActivityEvidence: async id => { activity.push(id); return { messageCount: 1, userSendAt: null }; } });
  t.after(() => env.source.dispose());
  const selected = await env.source.listSessions({ limit: 1, status: 'active', includePinned: true,
    projectRows: rows => rows.map(row => ({ ...row, status: row.id === 'a' ? 'archived' : 'active', ...(row.id === 'c' ? { pinnedAt: 'pin' } : {}) })) });
  assert.deepEqual(selected.map(row => row.id), ['b', 'c']); await env.source.evidenceSettled();
  assert.deepEqual(activity.sort(), ['b', 'c']);
});
test('evidence never blocks list or warms the entire corpus; completion pushes with no poll', async t => {
  const hold = gate(); const calls = []; const events = [];
  const env = setup(Array.from({ length: 200 }, (_, i) => item(String(i), i + 1)), { readActivityEvidence: async id => { calls.push(id); await hold.promise; return { messageCount: 3, userSendAt: '2020-01-01T00:00:00.000Z' }; } });
  t.after(() => { hold.release(); env.source.dispose(); }); env.source.onListChange(event => events.push(event));
  const rows = await env.source.listSessions({ limit: 3 }); assert.equal(rows.length, 3);
  assert.equal('messageCount' in rows[0], false); assert.equal(calls.length, 2);
  const coreVersion = env.source.listVersion();
  hold.release(); await env.source.evidenceSettled();
  assert.equal(calls.length, 3); assert.equal(events.filter(event => event.kind === 'evidence').length, 3);
  assert.equal(env.source.listVersion(), coreVersion, 'optional completion cannot revoke an in-flight core read');
  assert.equal(env.source.listDiagnostics().enrichmentRevision, 3);
});
test('invalidating an in-flight evidence read prevents old values reentering the memo', async t => {
  const hold = gate(); let n = 0;
  const env = setup([item('a')], { readActivityEvidence: async () => { const snap = ++n; if (snap === 1) await hold.promise; return { messageCount: snap, userSendAt: null }; } });
  t.after(() => env.source.dispose()); await env.source.listSessions(); await tick();
  env.emit('session/event', { id: 'a', header: { id: 'a' } }, { type: 'assistant/message' }); hold.release();
  await env.source.evidenceSettled();
  assert.equal(env.source.peekSession('a').messageCount, 2);
});
test('authoritative activity can correct a previous future value, and first-user evidence cannot shadow it', async t => {
  const env = setup([item('a', 999)]); t.after(() => env.source.dispose()); await env.source.listSessions();
  env.set([item('a', 20)]); env.source.invalidateSession('a'); await env.source.titlesSettled();
  const row = await env.source.getSession('a'); assert.equal(row.lastActivityAt, new Date(20).toISOString());
  const wire = toCindySessionListRow({ ...row, userSendAt: '1970-01-01T00:00:00.001Z' });
  assert.equal(wire.lastActivityAt, row.updatedAt);
});
test('active state uses live registry and an absent requested ID is explicitly idle', async t => {
  const env = setup([], { readActiveSessions: async () => [{ ...item('a'), running: true }, { ...item('child'), origin: 'subagent', running: true }] });
  t.after(() => env.source.dispose()); const states = await env.source.listSessionStates('missing');
  assert.deepEqual(states.map(row => [row.id, row.running]), [['a', true], ['missing', false]]); assert.equal(env.calls(), 0);
});
test('source disposal fences outstanding observations and releases every listener', async () => {
  const hold = gate(); const env = setup([], { readSessionSummary: async () => { await hold.promise; return item('a'); } });
  const pending = env.source.getSession('a'); await tick(); env.source.dispose(); hold.release();
  await assert.rejects(pending, /disposed/); assert.equal(env.listeners(), 0); assert.equal(env.source.peekSession('a'), undefined);
});
test('selection is deterministic and never drops pinned outside the bounded window', () => {
  const rows = ['a', 'b', 'c'].map(id => ({ id, updatedAt: 'same', ...(id === 'a' ? { pinnedAt: 'pin' } : {}) }));
  assert.deepEqual(selectSessionRows(rows, { limit: 1, includePinned: true }).map(row => row.id), ['c', 'a']);
});
