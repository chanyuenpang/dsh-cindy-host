import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshBackgroundJobs, jobTaskId } from '../src/dsh-background-jobs.js';
import { createChannelRouter } from '../src/cindy-channels.js';
import { startHost } from '../src/host.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
function job(id, status = 'running', owner = 'one') { return { id, ...(owner === undefined ? {} : { owner }), status, kind: 'pwsh', label: 'Native test', startedAt: 1000,
  ...(status !== 'running' && status !== 'stopping' ? { finishedAt: 3000 } : {}), output: { total: 3, earliest: 0, spillPaths: ['/private/not-a-cindy-output-file'] } }; }
function fixture(initial = [job('own'), { ...job('open'), owner: undefined }, job('foreign', 'running', 'two')], options = {}) {
  let jobs = initial; let failure; let visible = async id => ['one', 'two'].includes(id) ? { id } : undefined; let reads = 0; let calls = 0; let observers = 0; let forceUnfenced = false;
  const registry = { list: id => { calls++; if (failure) throw failure; return forceUnfenced ? jobs : jobs.filter(item => item.owner === undefined || item.owner === id); },
    readAt: () => { throw Error('must never consume/read output'); }, kill: () => { throw Error('must not kill'); }, events: { subscribe: () => { observers++; throw Error('must reuse existing control stream'); } } };
  let service = registry;
  const port = createDshBackgroundJobs({ getRegistry: () => service, getSession: async (id, options) => { reads++; return visible(id, options); }, ...options });
  const router = createChannelRouter({ listSessions: async () => [], subscribers: new Set(), resolveCapabilities: () => ({ backgroundJobs: port }) });
  const invoke = (args = ['one'], channel = 'maker:session-background-tasks:list') => router({ v: 1, id: 'read', src: 'phone', kind: 'invoke', payload: { channel, args } });
  return { port, registry, invoke, get reads() { return reads; }, get calls() { return calls; }, get observers() { return observers; },
    setJobs: value => { jobs = value; }, setVisible: fn => { visible = fn; }, setFailure: value => { failure = value; },
    remove: () => { service = undefined; }, restore: () => { service = registry; }, unfence: () => { forceUnfenced = true; } };
}
test('native owner-fenced list includes own/unowned active jobs without output reads or fake continuation counts', async () => {
  const f = fixture(); const value = (await f.invoke()).payload;
  assert.equal(value.ok, true); assert.deepEqual(value.result.tasks.map(task => task.taskId), [jobTaskId('own'), jobTaskId('open')]);
  assert.equal(Object.hasOwn(value.result, 'pendingContinuations'), false); assert.equal(f.calls, 1); assert.equal(f.observers, 0);
  assert.equal(JSON.stringify(value).includes('/private/'), false);
});
test('Cindy roster contains active tasks only: stopping stays running, terminal facts are event-only', async () => {
  const f = fixture([job('running'), job('stopping', 'stopping'), job('complete', 'completed'), job('fail', 'failed'), job('kill', 'killed')]);
  const snapshot = await f.port.read('one'); assert.equal(snapshot.tasks.length, 2); assert.match(snapshot.tasks[1].title, /stopping/);
  const updates = await f.port.updates('one', [job('stopping', 'stopping'), job('complete', 'completed'), job('fail', 'failed'), job('kill', 'killed')]);
  assert.deepEqual(updates.map(event => event.data.status), ['running', 'completed', 'failed', 'stopped']);
  assert.match(updates[0].data.summary, /stopping/); assert.deepEqual(updates[1].data.usage, { durationMs: 2000 });
  assert.equal(Object.hasOwn(updates[1].data, 'outputFile'), false);
});
test('roster missing service, unreadable ordinary session and persistence errors refuse rather than return empty success', async () => {
  const f = fixture(); f.remove(); assert.equal((await f.invoke()).payload.error.code, 'NOT_AVAILABLE'); assert.equal(f.reads, 0);
  f.restore(); assert.equal((await f.invoke(['child'])).payload.error.code, 'NOT_FOUND'); assert.equal(f.calls, 0);
  f.setFailure(Error('native roster failed')); assert.match((await f.invoke()).payload.error.message, /native roster failed/);
});
test('malformed request and nonexistent stop/output protocols never reach native access', async () => {
  const f = fixture(); for (const args of [[], [4], ['one', {}], ['']]) assert.equal((await f.invoke(args)).payload.error.code, 'BAD_REQUEST');
  for (const channel of ['maker:agent-task:stop', 'maker:background-task:output-tail']) assert.equal((await f.invoke(['one'], channel)).payload.error.code, 'CHANNEL_NOT_ALLOWED');
  assert.equal(f.reads, 0); assert.equal(f.calls, 0);
});
test('a native owner fence violation or invalid state rejects the entire snapshot/update before exposure', async () => {
  const f = fixture(); f.unfence(); assert.equal((await f.invoke()).payload.error.code, 'FORBIDDEN');
  await assert.rejects(f.port.updates('one', [job('good'), job('secret', 'running', 'two')]), { refusalCode: 'FORBIDDEN' });
  await assert.rejects(f.port.updates('one', [job('unknown', 'not-a-native-state')]), { refusalCode: 'NOT_AVAILABLE' });
  f.setJobs([job('duplicate'), job('duplicate')]); assert.equal((await f.invoke()).payload.ok, false);
});
test('status deduplication does not resurrect terminal jobs or invent terminal status from disappearance', async () => {
  const f = fixture(); assert.equal((await f.port.updates('one', [job('id')])).length, 1);
  assert.equal((await f.port.updates('one', [job('id')])).length, 0);
  assert.equal((await f.port.updates('one', [job('id', 'completed')]))[0].data.status, 'completed');
  assert.equal((await f.port.updates('one', [job('id')])).length, 0);
  assert.deepEqual(await f.port.updates('one', []), []);
});
test('older asynchronous frame reads cannot overwrite a newer completed roster', async () => {
  const f = fixture(); let finish; let reads = 0;
  f.setVisible(async id => ++reads === 1 ? new Promise(resolve => { finish = resolve; }) : { id });
  const older = f.port.updates('one', [job('id')]); await tick();
  assert.equal((await f.port.updates('one', [job('id', 'completed')]))[0].data.status, 'completed');
  finish({ id: 'one' }); assert.deepEqual(await older, []);
});
test('source cancellation releases metadata reads and prevents a late registry list call', async () => {
  const f = fixture(); let nativeSignal;
  f.setVisible((_id, { signal }) => { nativeSignal = signal; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); });
  const pending = f.port.read('one'); await tick(); f.port.cancelAll();
  assert.equal(nativeSignal.aborted, true); await assert.rejects(pending, { refusalCode: 'NOT_AVAILABLE' }); assert.equal(f.calls, 0);
});
test('snapshot budgets are explicit refusals, not silently truncated rosters', async () => {
  const f = fixture([job('a'), job('b')], { maxJobs: 1 }); await assert.rejects(f.port.read('one'), /snapshot budget/);
});
test('existing native control frames publish legal session-scoped updates only for watched sessions', async () => {
  const f = fixture(); const source = { backgroundJobs: f.port, listSessions: async () => [{ id: 'one', title: 'One' }], onEvent: () => () => {} };
  const host = await startHost(source, { transportEnabled: false, remoteControlEnabled: false, controllers: {} });
  try {
    host.applyControlFrame({ type: 'jobs', sessionId: 'one', jobs: [job('id')] }); await tick(); assert.equal(f.reads, 0);
    await host.invokeForTest('device-link:subscribe', [{ topics: ['session:one'] }]);
    const initial = host.getPushLog().filter(entry => entry.channel === 'maker:event').length;
    host.applyControlFrame({ type: 'jobs', sessionId: 'one', jobs: [job('id')] }); await tick();
    assert.equal(host.getPushLog().filter(entry => entry.channel === 'maker:event').length, initial + 1);
    const before = host.getPushLog().filter(entry => entry.channel === 'maker:event').length;
    host.applyControlFrame({ type: 'jobs', sessionId: 'one', jobs: [job('id')] }); await tick();
    assert.equal(host.getPushLog().filter(entry => entry.channel === 'maker:event').length, before);
    host.applyControlFrame({ type: 'jobs', sessionId: 'one', jobs: [job('id', 'completed')] }); await tick();
    assert.equal(host.getPushLog().filter(entry => entry.channel === 'maker:event').length, before + 1);
  } finally { await host.stop(); }
});
