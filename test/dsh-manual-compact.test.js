import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshManualCompact } from '../src/dsh-manual-compact.js';
import { createChannelRouter } from '../src/cindy-channels.js';
import { startHost } from '../src/host.js';
import { buildDshSource, capabilityProvider } from '../src/dsh-plugin.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const definition = { definitionId: '@deepseek-ai/dsh-command-compact' };
function fixture() {
  let execute = async () => ({ commandId: 'command', result: { kind: 'success', sourceEventSeq: 12 } });
  let commands = { find: () => definition, execute: (...args) => { calls.push(args); return execute(...args); } };
  let visible = true; let hidden = false; let resolves = 0; let reads = 0;
  const calls = []; const settled = []; const agent = { id: 'one', session: { id: 'one' } };
  const port = createDshManualCompact({ getCommands: () => commands,
    getSession: async () => { reads++; return visible ? { id: 'one' } : undefined; },
    resolveAgent: async () => { resolves++; return { agent }; }, isHidden: () => hidden,
    onSettled: id => settled.push(id) });
  const router = createChannelRouter({ listSessions: async () => [], subscribers: new Set(),
    resolveCapabilities: () => ({ manualCompact: port, sessionHidden: () => hidden }) });
  const invoke = (args = ['one'], id = 'request', channel = 'maker:compact-session') => router({ v: 1, id, src: 'phone', kind: 'invoke', payload: { channel, args } });
  return { port, calls, settled, agent, invoke, get resolves() { return resolves; }, get reads() { return reads; },
    setExecute: fn => { execute = fn; }, setCommands: value => { commands = value; },
    setVisible: value => { visible = value; }, setHidden: value => { hidden = value; } };
}
test('compact executes the exact native scoped command and official result subset', async () => {
  const f = fixture(); const value = await f.invoke(['one', '  ']);
  assert.equal(value.payload.ok, true); assert.deepEqual(value.payload.result, {});
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], f.agent);
  assert.equal(f.calls[0][1], '/compact'); assert.deepEqual(f.calls[0][2], []);
  assert.ok(f.calls[0][3] instanceof AbortSignal); assert.deepEqual(f.settled, ['one']);
});
test('native no-history success is noop without guessing text or token counts', async () => {
  const f = fixture(); f.setExecute(async () => ({ result: { kind: 'success', text: 'arbitrary diagnostic' } }));
  assert.deepEqual((await f.invoke()).payload.result, { noop: true });
});
test('invalid instructions and extra fields reject before activation; Claude compact is not an alias', async () => {
  const f = fixture();
  for (const args of [['one', 'keep details'], ['one', null], ['one', {}], ['one', '', {}], ['', ''], [42]]) assert.equal((await f.invoke(args)).payload.ok, false);
  assert.equal((await f.invoke(['one'], 'queue', 'maker:input:compact')).payload.error.code, 'CHANNEL_NOT_ALLOWED');
  assert.equal(f.resolves, 0); assert.equal(f.reads, 0); assert.deepEqual(f.calls, []);
});
test('missing native service, invisible session, hidden target and overridden command refuse honestly', async () => {
  for (const kind of ['missing', 'invisible', 'hidden', 'override']) {
    const f = fixture();
    if (kind === 'missing') f.setCommands(undefined);
    if (kind === 'invisible') f.setVisible(false);
    if (kind === 'hidden') f.setHidden(true);
    if (kind === 'override') f.setCommands({ find: () => ({ definitionId: 'another-plugin' }), execute: () => { throw Error('must not execute'); } });
    const value = (await f.invoke()).payload;
    assert.equal(value.ok, false); assert.equal(value.error.code, kind === 'invisible' ? 'NOT_FOUND' : 'NOT_AVAILABLE');
    assert.equal(f.calls.length, 0); if (kind !== 'override') assert.equal(f.resolves, 0);
  }
});
test('native errors are not successful promises and persistence failures stay genuine', async () => {
  for (const native of [undefined, { result: { kind: 'error', text: 'Native maintenance busy' } }]) {
    const f = fixture(); f.setExecute(async () => native);
    assert.equal((await f.invoke()).payload.error.code, 'NOT_AVAILABLE'); assert.deepEqual(f.settled, ['one']);
  }
  const f = fixture(); f.setExecute(async () => { throw Error('checkpoint persistence failed'); });
  const value = (await f.invoke()).payload;
  assert.equal(value.ok, false); assert.equal(value.error.code, 'THREW'); assert.match(value.error.message, /checkpoint persistence failed/);
  assert.deepEqual(f.settled, ['one']);
});
test('duplicate envelopes share execution; another click cannot silently queue a second compaction', async () => {
  const f = fixture(); let finish; f.setExecute(() => new Promise(resolve => { finish = resolve; }));
  const one = f.invoke(); const duplicate = f.invoke(); await tick(); assert.equal(f.calls.length, 1);
  assert.equal((await f.invoke(['one'], 'another-click')).payload.error.code, 'NOT_AVAILABLE');
  finish({ result: { kind: 'success', sourceEventSeq: 20 } });
  assert.deepEqual((await one).payload.result, {}); assert.deepEqual((await duplicate).payload.result, {});
  assert.deepEqual((await f.invoke()).payload.result, {}); assert.equal(f.calls.length, 1);
  await assert.rejects(f.port.run({ sessionId: 'two', requestKey: JSON.stringify(['phone', 'request']) }), { refusalCode: 'BAD_REQUEST' });
});
test('caller, session, link and disposal cancellation cannot report a late native commit as success', async () => {
  for (const action of ['caller', 'session', 'all', 'dispose']) {
    const f = fixture(); const caller = new AbortController(); let nativeSignal; let finish;
    f.setExecute((_a, _l, _f, signal) => { nativeSignal = signal; return new Promise(resolve => { finish = resolve; }); });
    const pending = f.port.run({ sessionId: 'one', signal: caller.signal }); await tick();
    if (action === 'caller') caller.abort(); if (action === 'session') f.port.cancelSession('one');
    if (action === 'all') f.port.cancelAll(); if (action === 'dispose') f.port.dispose();
    assert.equal(nativeSignal.aborted, true); finish({ result: { kind: 'success', sourceEventSeq: 20 } });
    await assert.rejects(pending, /cancelled.*may already have committed/); assert.deepEqual(f.settled, ['one']);
  }
});
test('secondary history failure does not mask primary native persistence failure', async () => {
  const service = { find: () => definition, execute: async () => { throw Error('primary native failure'); } };
  const port = createDshManualCompact({ getCommands: () => service, getSession: async () => ({ id: 'one' }),
    resolveAgent: async () => ({ agent: {} }), onSettled: () => { throw Error('secondary refresh failure'); } });
  await assert.rejects(port.run({ sessionId: 'one' }), /primary native failure/); port.dispose();
});
test('runtime teardown cancels native compaction without sending model prompts', async () => {
  for (const action of ['stop', 'source']) {
    const f = fixture(); let nativeSignal; let finish;
    f.setExecute((_a, _l, _f, signal) => { nativeSignal = signal; return new Promise(resolve => { finish = resolve; }); });
    const source = { manualCompact: f.port, listSessions: async () => [], onEvent: () => () => {} };
    const host = await startHost(source, { transportEnabled: false, remoteControlEnabled: false, controllers: {} });
    const pending = f.port.run({ sessionId: 'one' }); await tick();
    if (action === 'stop') await host.stop(); else await host.setSource(undefined);
    assert.equal(nativeSignal.aborted, true); finish({ result: { kind: 'success', sourceEventSeq: 20 } });
    await assert.rejects(pending, /cancelled/); await host.stop();
  }
});
test('DSH source dynamically injects and forwards real scoped commands', async () => {
  const injections = new Map(); let activations = 0; const agent = {};
  const services = { sessionController: { list: async () => ({ items: [{ sessionId: 'one', cwd: '/workspace', createdAt: 1, updatedAt: 1 }] }),
    resolveAgent: async () => { activations++; return { agent }; } } };
  const ctx = { get: name => services[name], on: () => () => {}, effect: run => run(),
    inject(names, callback) { injections.set(names.join(','), callback); return () => {}; } };
  const seam = buildDshSource(ctx, 'sessionController');
  assert.equal(capabilityProvider(seam).manualCompact, seam.manualCompact); assert.equal(seam.source.manualCompact, seam.manualCompact);
  await assert.rejects(seam.manualCompact.run({ sessionId: 'one' }), { refusalCode: 'NOT_AVAILABLE' }); assert.equal(activations, 0);
  services.commands = { find: () => definition, execute: async () => ({ result: { kind: 'success' } }) };
  const remove = injections.get('commands')(ctx);
  assert.deepEqual(await seam.manualCompact.run({ sessionId: 'one' }), { noop: true });
  remove(); await assert.rejects(seam.manualCompact.run({ sessionId: 'one' }), { refusalCode: 'NOT_AVAILABLE' });
});
