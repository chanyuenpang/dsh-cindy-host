import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryDeliveryState } from '../src/history-delivery-state.js';

const request = (deviceId = 'phone', before) => ({ src: deviceId,
  payload: { channel: 'local-db:messages:view', args: ['s', { before }] } });

test('pending is raw and only successful latest delivery enables this controller', () => {
  const state = createHistoryDeliveryState(() => true);
  const pending = state.begin(request());
  assert.equal(state.ready('phone', 's'), false);
  state.changed('s');
  assert.equal(state.finish(pending, true), true, 'pending changes require a trailing refresh');
  assert.equal(state.ready('phone', 's'), true);
  assert.equal(state.ready('other', 's'), false);
  const older = state.begin(request('other', 'anchor'));
  state.finish(older, true);
  assert.equal(state.ready('other', 's'), false, 'an older page alone cannot opt into folding');
});

test('failed reads, lost leases and stale completions cannot revive readiness', () => {
  let allowed = true;
  const state = createHistoryDeliveryState(() => allowed);
  const old = state.begin(request()); const latest = state.begin(request());
  state.finish(old, true); assert.equal(state.ready('phone', 's'), false);
  state.finish(latest, true); assert.equal(state.ready('phone', 's'), true);
  state.finish(state.begin(request('phone', 'older')), false);
  assert.equal(state.ready('phone', 's'), false);
  const pending = state.begin(request()); state.forget('phone');
  state.finish(pending, true); assert.equal(state.ready('phone', 's'), false);
  const revoked = state.begin(request()); allowed = false; state.finish(revoked, true);
  assert.equal(state.ready('phone', 's'), false);
  allowed = true; assert.equal(state.ready('phone', 's'), false);
  assert.equal(state.begin({ src: 'phone', payload: { channel: 'local-db:messages:view-intent', args: ['s', []] } }), null);
});

test('patch receipts use actual fitted pages, CAS versions and isolated controller intents', () => {
  const state = createHistoryDeliveryState(() => true);
  const latest = deviceId => ({ src: deviceId, payload: { channel: 'local-db:messages:view', args: ['s', { workLines: true }] } });
  const fitted = { version: 1, items: [], hasMore: true, nextCursor: 'actually-fitted' };
  state.finish(state.begin(latest('a')), true, fitted);
  state.finish(state.begin(latest('b')), true, fitted);
  const a = state.capture('a', 's');
  assert.deepEqual(a.page, fitted);
  fitted.nextCursor = 'mutated-reader';
  assert.equal(a.page.nextCursor, 'actually-fitted', 'the receipt does not alias the reader result');
  assert.equal(state.acceptPatch(a, { ...a.page, nextCursor: 'patch' }), true);
  assert.equal(state.acceptPatch(a, fitted), false, 'a patch receipt is single-use');
  const concurrent = state.capture('a', 's');
  const page = state.begin(latest('a'));
  assert.equal(state.current(concurrent), false, 'a new page read fences old patch construction');
  state.finish(page, true, fitted);
  assert.deepEqual(state.intent('a', 's', [{ key: 'preview-work-a' }]), { ok: true, result: true });
  assert.deepEqual(state.expandedFor('a', 's'), ['work-a']);
  assert.deepEqual(state.expandedFor('b', 's'), []);
  const stale = state.capture('a', 's');
  state.forget('a');
  assert.equal(state.current(stale), false);
  assert.deepEqual(state.expandedFor('a', 's'), []);
  assert.equal(state.capture('b', 's').page.nextCursor, 'actually-fitted');
});

test('legacy and older pages cannot establish a patch baseline', () => {
  const state = createHistoryDeliveryState(() => true);
  const page = { version: 1, items: [], hasMore: false, nextCursor: null };
  state.finish(state.begin(request('legacy')), true, page);
  assert.equal(state.capture('legacy', 's').page, null);
  const older = request('older', 'cursor'); older.payload.args[1].workLines = true;
  state.finish(state.begin(older), true, page);
  assert.equal(state.capture('older', 's').page, null);
});
