import test from 'node:test';
import assert from 'node:assert/strict';
import { startHost } from '../src/host.js';
import { FixtureDshSource } from '../src/fixture-source.js';

const page = () => ({ ok: true, result: { version: 1, items: [], hasMore: false, nextCursor: null } });
const settle = () => new Promise(resolve => setImmediate(resolve));
async function harness() {
  const handlers = new Map(); const sent = []; const timers = new Set();
  let read = async () => page(); let failSend = false; let id = 0;
  const socket = { readyState: 1, on(name, fn) { handlers.set(name, fn); }, close() {},
    send(text) { const frame = JSON.parse(text); if (failSend && frame.kind === 'invoke-result') throw new Error('lost socket'); sent.push(frame); } };
  const runtime = await startHost(new FixtureDshSource(), { transportEnabled: true, remoteControlEnabled: true, controllers: {} }, {
    resolveSession: async () => ({ ok: true, session: { deviceId: 'host' } }), openSocket: () => socket, heartbeatMs: 0,
    resolveCapabilities: () => ({ historyView: { page: (...args) => read(...args), details: async () => ({ ok: false, code: 'NOT_FOUND' }), intent: async () => ({ ok: true, result: true }) } }),
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.add(timer); return timer; }, clearTimeout: timer => timers.delete(timer),
  });
  const frame = value => handlers.get('message')(Buffer.from(JSON.stringify({ v: 1, ...value })));
  handlers.get('open')(); frame({ kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'host', userId: 'owner' } });
  async function invoke(src, channel, args) { const requestId = 'r' + id++; frame({ kind: 'invoke', id: requestId, src, payload: { channel, args } }); await settle(); return requestId; }
  for (const src of ['ready', 'raw']) await invoke(src, 'device-link:subscribe', [{ topics: ['session:s1'] }]);
  const push = async (role = 'thinking') => { await runtime.pushSessionMessage('s1', { id: 'm' + id++, clientId: 'c' + id, role, content: { text: role } }); };
  const targets = () => sent.filter(f => f.kind === 'push' && f.payload.channel === 'local-db:messages:created').map(f => f.dst).sort();
  const reopen = () => { handlers.get('open')(); frame({ kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'host', userId: 'owner' } }); };
  return { runtime, sent, timers, invoke, frame, push, targets, reopen, clear: () => { sent.length = 0; },
    read: fn => { read = fn; }, failSend: value => { failSend = value; } };
}

test('only a successfully delivered view folds thinking, never answers, errors, tools or user echoes', async () => {
  const h = await harness();
  try {
    await h.invoke('ready', 'local-db:messages:view', ['s1', { workLines: true }]);
    h.clear(); await h.push(); assert.deepEqual(h.targets(), ['raw']);
    for (const role of ['assistant', 'user', 'error', 'tool_use', 'tool_result']) {
      h.clear(); await h.push(role); assert.deepEqual(h.targets(), ['raw', 'ready']);
    }
    h.read(async () => { throw new Error('read failed'); });
    await h.invoke('ready', 'local-db:messages:view', ['s1']);
    h.clear(); await h.push(); assert.deepEqual(h.targets(), ['raw', 'ready']);
    h.read(async () => page()); h.failSend(true);
    await h.invoke('ready', 'local-db:messages:view', ['s1']);
    h.failSend(false); h.clear(); await h.push(); assert.deepEqual(h.targets(), ['raw', 'ready']);
    await h.invoke('ready', 'local-db:messages:view', ['s1']);
    h.clear(); await h.push(); assert.deepEqual(h.targets(), ['raw']);
  } finally { await h.runtime.stop(); }
});

test('pending changes get a trailing notice and stale unsubscribed reads cannot opt back in', async () => {
  const h = await harness();
  try {
    let resolve; h.read(() => new Promise(done => { resolve = done; }));
    await h.invoke('ready', 'local-db:messages:view', ['s1']);
    h.clear(); await h.push(); assert.deepEqual(h.targets(), ['raw', 'ready']);
    // Consume the original notice before the page settles: dirty tracking must replace it.
    for (const timer of [...h.timers]) if (timer.ms === 1000) { h.timers.delete(timer); timer.fn(); }
    resolve(page()); await settle();
    assert.ok([...h.timers].some(timer => timer.ms === 1000), 'pending sampling race gets a trailing invalidation');
    h.clear(); await h.push(); assert.deepEqual(h.targets(), ['raw']);
    await h.invoke('ready', 'local-db:messages:view', ['s1']);
    await h.invoke('ready', 'device-link:unsubscribe', [{ topics: ['session:s1'] }]);
    await h.invoke('ready', 'device-link:subscribe', [{ topics: ['session:s1'] }]);
    resolve(page()); await settle();
    h.clear(); await h.push(); assert.deepEqual(h.targets(), ['raw', 'ready']);
  } finally { await h.runtime.stop(); }
});

test('link-close, offline presence and revoke/reset require a new history delivery', async () => {
  const h = await harness();
  try {
    await h.invoke('ready', 'local-db:messages:view', ['s1']);
    h.frame({ kind: 'link-close', src: 'ready' });
    await h.invoke('ready', 'maker:list-active', []);
    h.clear(); await h.push(); assert.deepEqual(h.targets(), ['raw', 'ready']);
    await h.invoke('ready', 'local-db:messages:view', ['s1']);
    h.frame({ kind: 'presence-changed', payload: { deviceId: 'ready', online: false } });
    await h.invoke('ready', 'maker:list-active', []);
    h.clear(); await h.push(); assert.deepEqual(h.targets(), ['raw', 'ready']);
    await h.invoke('ready', 'local-db:messages:view', ['s1']);
    await h.runtime.updateSettings({ transportEnabled: true, remoteControlEnabled: true, controllers: { ready: { revoked: true } } });
    await h.runtime.updateSettings({ transportEnabled: true, remoteControlEnabled: true, controllers: {} });
    h.clear(); await h.push(); assert.deepEqual(h.targets(), ['raw', 'ready']);
  } finally { await h.runtime.stop(); }
});

test('an old relay generation cannot deliver its pending page or change the new ready state', async () => {
  const h = await harness();
  try {
    let resolve; h.read(() => new Promise(done => { resolve = done; }));
    const staleId = await h.invoke('ready', 'local-db:messages:view', ['s1']);
    await h.runtime.updateSettings({ transportEnabled: false, remoteControlEnabled: false, controllers: {} });
    await h.runtime.updateSettings({ transportEnabled: true, remoteControlEnabled: true, controllers: {} }); h.reopen();
    await h.invoke('ready', 'device-link:subscribe', [{ topics: ['session:s1'] }]);
    await h.invoke('raw', 'device-link:subscribe', [{ topics: ['session:s1'] }]);
    h.read(async () => page()); await h.invoke('ready', 'local-db:messages:view', ['s1']);
    h.clear(); resolve(page()); await settle();
    assert.equal(h.sent.some(frame => frame.kind === 'invoke-result' && frame.id === staleId), false);
    await h.push(); assert.deepEqual(h.targets(), ['raw']);
  } finally { await h.runtime.stop(); }
});
