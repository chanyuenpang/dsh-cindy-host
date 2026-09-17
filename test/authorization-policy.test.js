import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthorizationPolicy } from '../src/authorization-policy.js';

test('admits every same-account device once the phone switch is on', () => {
  const policy = new AuthorizationPolicy({ transportEnabled: true, controllers: {} });
  assert.ok(policy.isEnabled());
  // No per-device enrollment exists; the relay already scopes frames to one account.
  assert.ok(policy.canAccept('phone-1'));
  assert.ok(policy.canAccept('tablet-2'));
});

test('admits nothing while the phone switch is off', () => {
  const policy = new AuthorizationPolicy({ transportEnabled: false, remoteControlEnabled: false, controllers: {} });
  assert.equal(policy.isEnabled(), false);
  for (const deviceId of ['phone-1', '', undefined, null]) assert.equal(policy.canAccept(deviceId), false);
});

test('still honours an explicit revocation even with the switch on', () => {
  const policy = new AuthorizationPolicy({ transportEnabled: true, controllers: { phone: { state: 'authorized' } } });
  assert.ok(policy.canAccept('phone'));
  policy.update(policy.revoke('phone'));
  assert.equal(policy.canAccept('phone'), false);
  assert.equal(policy.canAccept('other'), true);
});

test('treats the legacy remoteControlEnabled spelling as the same intent', () => {
  const policy = new AuthorizationPolicy({ remoteControlEnabled: true, controllers: {} });
  assert.ok(policy.isEnabled());
  assert.ok(policy.canAccept('phone-1'));
});

test('revoke records a revision and keeps unrelated controllers', () => {
  const policy = new AuthorizationPolicy({ transportEnabled: true, controllers: { a: { state: 'authorized' }, b: { state: 'authorized' } } });
  const next = policy.revoke('a');
  assert.equal(next.controllers.a.state, 'revoked');
  assert.equal(next.controllers.a.grantRevision, 1);
  assert.equal(next.controllers.b.state, 'authorized');
  // revoke is pure: only re-applying the result advances the revision.
  policy.update(policy.revoke('a'));
  assert.equal(policy.revoke('a').controllers.a.grantRevision, 2);
});
