import test from 'node:test';
import assert from 'node:assert/strict';
import { startHost } from '../src/host.js';
import { FixtureDshSource } from '../src/fixture-source.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const names = ['manualCompact','forkSession','keywordSearch','backgroundJobs','subagentReads','reminders','projectOrder','referenceHistory'];
class Socket {
  handlers = new Map(); sent = []; readyState = 1;
  on(name, fn) { const values = this.handlers.get(name) ?? []; values.push(fn); this.handlers.set(name, values); return this; }
  emit(name, ...args) { for (const fn of this.handlers.get(name) ?? []) fn(...args); }
  send(value) { this.sent.push(JSON.parse(value)); } close() {}
  frame(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}
function source() {
  const value = new FixtureDshSource(); const cancellations = []; const listeners = new Set();
  for (const name of names) value[name] = { cancelAll: () => cancellations.push(name) };
  value.reminders.onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
  return { value, cancellations, listeners };
}
async function runtime(value) {
  const socket = new Socket(); const host = await startHost(value, { transportEnabled: true, remoteControlEnabled: true, controllers: {} }, { resolveSession: async () => ({ ok: true, session: { deviceId: 'host', kind: 'phone', identifier: 'fixture' } }), openSocket: () => socket, heartbeatMs: 0, reconnectBaseMs: 60000, fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  await host.connect(); socket.emit('open'); socket.frame({ v: 1, kind: 'hello-ack', payload: { deviceId: 'host', userId: 'verified' } }); return { host, socket };
}
test('source replacement invalidates every native request port and closes old native event observers', async () => {
  const a = source(); const b = source(); const { host, socket } = await runtime(a.value);
  try { socket.frame({ v: 1, kind: 'link-open', src: 'phone', id: 'link' }); const old = [...a.listeners][0]; a.cancellations.length = 0;
    await host.setSource(b.value); assert.deepEqual(a.cancellations.sort(), [...names].sort()); assert.equal(a.listeners.size, 0); assert.equal(b.listeners.size, 1);
    const before = socket.sent.length; old({ type: 'ready' }); assert.equal(socket.sent.length, before);
  } finally { await host.stop(); }
});
test('actual socket close follows disconnect cancellation and releases native subscriptions without executing business stop', async () => {
  const a = source(); const { host, socket } = await runtime(a.value);
  try { socket.frame({ v: 1, kind: 'link-open', src: 'phone', id: 'link' }); a.cancellations.length = 0;
    socket.emit('close'); await tick(); assert.deepEqual(a.cancellations.sort(), [...names].sort()); assert.equal(a.listeners.size, 0);
  } finally { await host.stop(); }
});
test('one peer unlink leaves another authorized peer live; account boundary cancels all old native requests', async () => {
  const a = source(); const { host, socket } = await runtime(a.value);
  try {
    socket.frame({ v: 1, kind: 'link-open', src: 'phone-a', id: 'a' }); socket.frame({ v: 1, kind: 'link-open', src: 'phone-b', id: 'b' });
    socket.frame({ v: 1, kind: 'link-close', src: 'phone-a' }); assert.equal(a.listeners.size, 1);
    for (const fn of a.listeners) fn({ type: 'ready' }); const pushes = socket.sent.filter(frame => frame.payload?.channel === 'maker:schedule:event'); assert.deepEqual(pushes.map(frame => frame.dst), ['phone-b']);
    a.cancellations.length = 0; await host.beginIdentityChange(); assert.deepEqual(a.cancellations.sort(), [...names].sort()); assert.equal(a.listeners.size, 0); assert.equal(host.getProjectOrderOwner(), undefined);
  } finally { await host.stop(); }
});
