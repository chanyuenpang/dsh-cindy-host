import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionListDelivery } from '../src/session-list-delivery.js';
function setup(extra = {}) {
  let time = 0, generation = 1, writable = true, counter = 0;
  const timers = new Map(), allowed = new Set(['phone']), validated = new Set(), frames = [];
  const delivery = createSessionListDelivery({
    stamp: id => `${id}:${generation}`, eligible: id => allowed.has(id), now: () => time, random: () => 0,
    reseedValidated: id => validated.has(id),
    send: (id, channel, payload) => { if (!writable) return false; frames.push({ id, channel, payload }); return true; },
    setTimer(fn, delay) { const id = ++counter; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimer: id => timers.delete(id), ...extra,
  });
  return { delivery, frames, allowed, validated, timers,
    scope() { generation++; }, writable(value) { writable = value; },
    advance(ms) {
      const end = time + ms;
      for (let n = 0; n < 1000; n++) {
        const next = [...timers].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) { time = end; return; }
        const [id, task] = next; time = task.at; timers.delete(id); task.fn();
      }
      throw new Error('timer loop');
    },
  };
}

test('latest field values merge in one bounded window', () => {
  const s = setup(); s.delivery.patch(['phone'], 'a', { title: 'old', model: 'm' });
  s.delivery.patch(['phone'], 'a', { title: 'new' }); s.advance(249); assert.equal(s.frames.length, 0);
  s.advance(1); assert.deepEqual(s.frames[0].payload, { sessionId: 'a', patch: { title: 'new', model: 'm' } });
  assert.equal(s.delivery.diagnostics().pendingBytes, 0); s.delivery.stop();
});
test('a status barrier includes older metadata and cannot be followed by a stale title batch', () => {
  const s = setup(); s.delivery.patch(['phone'], 'a', { title: 'name' });
  s.delivery.patch(['phone'], 'a', { status: 'archived', pinnedAt: null }, true);
  assert.deepEqual(s.frames[0].payload.patch, { title: 'name', status: 'archived', pinnedAt: null });
  s.advance(1000); assert.equal(s.frames.length, 1); s.delivery.stop();
});
test('no generic reseed without recorded target-consumer validation; real creates still work', () => {
  const s = setup(); s.delivery.subscribe('phone'); s.delivery.reseed(); s.advance(120_000);
  assert.equal(s.frames.length, 0); assert.ok(s.delivery.diagnostics().compatibilityBlocked > 0);
  s.delivery.created(['phone'], 'real-id'); s.advance(250);
  assert.deepEqual(s.frames[0].payload, { sessionId: 'real-id' }); s.delivery.stop();
});
test('validated initial/recovery/periodic reseed does not stop after local send success', () => {
  const s = setup(); s.validated.add('phone'); s.delivery.subscribe('phone'); s.advance(250);
  assert.deepEqual(s.frames[0].payload, {});
  s.advance(60_000); assert.ok(s.frames.length >= 2);
  s.delivery.recover('phone'); s.advance(1); assert.ok(s.frames.length >= 3);
  s.delivery.stop(); assert.equal(s.timers.size, 0);
});
test('failed local writes preserve current state and repair after backpressure', () => {
  const s = setup(); s.validated.add('phone'); s.writable(false); s.delivery.subscribe('phone');
  s.delivery.patch(['phone'], 'a', { title: 'current' }); s.advance(250);
  assert.equal(s.frames.length, 0); assert.ok(s.delivery.diagnostics().pending > 0);
  s.writable(true); s.advance(1000);
  assert.ok(s.frames.some(frame => frame.payload.patch?.title === 'current'));
  assert.ok(s.frames.some(frame => frame.channel === 'local-db:sessions:created'));
  s.delivery.stop();
});
test('grant/connection/source epoch changes discard delayed work', () => {
  const s = setup(); s.delivery.patch(['phone'], 'a', { title: 'private old scope' });
  s.scope(); s.advance(250); assert.deepEqual(s.frames, []);
  s.delivery.patch(['phone'], 'a', { title: 'new' }); s.advance(250);
  assert.equal(s.frames[0].payload.patch.title, 'new'); s.delivery.stop();
});
test('revocation and unsubscribe stop both pending and recurring work', () => {
  const s = setup(); s.validated.add('phone'); s.delivery.subscribe('phone');
  s.delivery.patch(['phone'], 'a', { title: 'never' }); s.allowed.delete('phone'); s.advance(60_001);
  assert.deepEqual(s.frames, []); assert.equal(s.delivery.diagnostics().peers, 0); s.delivery.stop();
});
test('row and aggregate byte overflow are bounded and request repair instead of an event log', () => {
  const s = setup({ maxRows: 2, maxBytes: 80 }); s.validated.add('phone');
  for (let i = 0; i < 20; i++) s.delivery.patch(['phone'], String(i), { title: 'x'.repeat(20) });
  assert.ok(s.delivery.diagnostics().pending <= 3); assert.ok(s.delivery.diagnostics().pendingBytes <= 80);
  assert.ok(s.delivery.diagnostics().overflow > 0); s.advance(250);
  assert.ok(s.frames.some(frame => frame.channel === 'local-db:sessions:created' && !frame.payload.sessionId)); s.delivery.stop();
});
test('flush slices a burst rather than refilling the socket in one tick', () => {
  const s = setup(); for (let i = 0; i < 20; i++) s.delivery.patch(['phone'], String(i), { title: 'x' });
  s.advance(250); assert.equal(s.frames.length, 8); s.advance(250); assert.equal(s.frames.length, 16);
  s.advance(250); assert.equal(s.frames.length, 20); s.delivery.stop();
});
test('terminal metadata supersedes an older activity held by backpressure', () => {
  const s = setup(); s.writable(false);
  s.delivery.activity(['phone'], { sessionId: 'a', phase: 'running', compactDetail: '', attention: false });
  s.delivery.patch(['phone'], 'a', { status: 'archived' }, true);
  s.writable(true); s.advance(250);
  assert.equal(s.frames.some(frame => frame.channel === 'local-db:sessions:activity'), false);
  assert.equal(s.frames[0].payload.patch.status, 'archived'); s.delivery.stop();
});
test('a broken validation port fails closed without escaping the timer boundary', () => {
  const s = setup({ reseedValidated: () => { throw Error('validation unavailable'); } });
  assert.doesNotThrow(() => s.delivery.subscribe('phone')); s.advance(120_000);
  assert.equal(s.frames.length, 0); s.delivery.stop();
});

test('forget and stop release bytes and timers, including source replacement', () => {
  const s = setup(); s.delivery.patch(['phone'], 'a', { title: 'x' });
  assert.ok(s.delivery.diagnostics().pendingBytes > 0); s.delivery.forget('phone');
  assert.equal(s.delivery.diagnostics().pendingBytes, 0); assert.equal(s.timers.size, 0);
  s.delivery.stop(); s.delivery.patch(['phone'], 'b', { title: 'never' }); s.advance(1000); assert.deepEqual(s.frames, []);
});
