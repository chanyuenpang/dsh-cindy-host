import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createChannelRouter, SUPPORTED_CHANNELS } from '../src/cindy-channels.js';

/**
 * The fail-closed guard, proved against the controller's own channel list rather
 * than a hand-picked sample.
 *
 * The fixture is extracted from Cindy's `REMOTE_INVOKE_ALLOWLIST` — the
 * authoritative set of channels a controlled device may be asked for — and is
 * documented there as a LOWER BOUND (two entries are not statically resolvable).
 * That is enough for the property this file guards: every channel the controller
 * can legitimately ask for is either served by this Host, or refused with the one
 * code the controller degrades on. A channel that answers anything else — a
 * crash, an accidental `NOT_AVAILABLE`, a silent success — is a bug.
 */
const FIXTURE = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/cindy-invoke-allowlist.json', import.meta.url)), 'utf8'));
const ALL_CHANNELS = FIXTURE.channels;

/** A router that serves whatever it can and refuses the rest. */
function router() {
  return createChannelRouter({
    listSessions: async () => [],
    resolveCapabilities: () => ({}),
    subscribers: new Set(),
  });
}

/** One invoke request for a channel. */
function request(channel) {
  return { v: 1, kind: 'invoke', id: 'r', src: 'phone-1', payload: { channel, args: [] } };
}

test('the fixture is the controller’s real list, not a sample', () => {
  assert.ok(ALL_CHANNELS.length >= 190, `expected the full allowlist, got ${ALL_CHANNELS.length}`);
  assert.equal(FIXTURE.count, ALL_CHANNELS.length);
  for (const sentinel of ['maker:input:enqueue', 'fs:stat-path', 'maker:goal:get-status', 'local-db:sessions:list', 'maker:send']) {
    assert.ok(ALL_CHANNELS.includes(sentinel), `${sentinel} missing from the fixture`);
  }
  // The supported set must be drawn from the allowlist, with one documented
  // exception: `maker:goal:get-status` is in the list, and so is everything else.
  for (const channel of SUPPORTED_CHANNELS) {
    assert.ok(ALL_CHANNELS.includes(channel), `${channel} is served but is not a channel the controller may ask for`);
  }
});

test('every channel OUTSIDE the supported set is refused with the code controllers degrade on', async () => {
  const handle = router();
  const wrong = [];
  for (const channel of ALL_CHANNELS) {
    // A supported channel is implemented: `BAD_REQUEST`/`NOT_FOUND` for an
    // empty-args invoke is a correct answer, not a fail-closed violation.
    if (SUPPORTED_CHANNELS.includes(channel)) continue;
    const reply = await handle(request(channel));
    if (reply === null) {
      wrong.push(`${channel}: answered nothing`);
      continue;
    }
    if (reply.payload?.ok === true) {
      wrong.push(`${channel}: served`);
      continue;
    }
    // `CHANNEL_NOT_ALLOWED` is "this device has no such capability";
    // `NOT_AVAILABLE` would claim a capability this Host does not have, and any
    // other code would be a failure the controller cannot attribute to absence.
    if (reply.payload?.error?.code !== 'CHANNEL_NOT_ALLOWED') wrong.push(`${channel}: ${String(reply.payload?.error?.code)}`);
  }
  assert.deepEqual(wrong, [], 'these channels did not fail closed');
});

test('a supported channel answers a validation error, never CHANNEL_NOT_ALLOWED', async () => {
  // The complement: a channel this Host implements must not pretend to be
  // absent when its arguments are wrong, or the controller would hide a feature
  // that is actually there.
  const handle = router();
  for (const channel of SUPPORTED_CHANNELS) {
    const reply = await handle(request(channel));
    assert.notEqual(reply?.payload?.error?.code, 'CHANNEL_NOT_ALLOWED', `${channel} is served but reported itself absent`);
  }
});

test('no allowlisted channel outside the supported set is ever served', async () => {
  const handle = router();
  const served = [];
  for (const channel of ALL_CHANNELS) {
    if (SUPPORTED_CHANNELS.includes(channel)) continue;
    const reply = await handle(request(channel));
    if (reply?.payload?.ok === true) served.push(channel);
  }
  assert.deepEqual(served, [], 'these channels were silently implemented');
});

test('a channel outside the allowlist altogether is still refused', async () => {
  const handle = router();
  for (const channel of ['totally:unknown', '', 'maker:goal:set-nothing']) {
    const reply = await handle(request(channel));
    assert.equal(reply.payload.ok, false);
    assert.equal(reply.payload.error.code, 'CHANNEL_NOT_ALLOWED');
  }
});
