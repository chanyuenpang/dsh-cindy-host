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
