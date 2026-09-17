import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  RECONNECT_STABLE_RESET_MS,
  computeReconnectDelayMs,
} from '../src/host-reconnect.js';

// The policy is the Cindy device-link client's, so both ends of the same link recover on
// the same schedule. The numbers matter in one direction: too eager and a relay outage
// becomes a retry storm from every host at once, too lazy and the phone sits without a
// DSH for minutes.

test('the retry ladder doubles from one second and stops at thirty', () => {
  assert.equal(RECONNECT_BASE_MS, 1_000);
  assert.equal(RECONNECT_MAX_MS, 30_000);
  assert.equal(RECONNECT_STABLE_RESET_MS, 10_000);

  // `random: 1` is the top of the jitter band, so these are the longest waits.
  const ladder = [0, 1, 2, 3, 4, 5, 6, 7].map((attempt) => computeReconnectDelayMs({ attempt, random: 1 }));
  assert.deepEqual(ladder, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
});

test('jitter is downward only, so no retry waits longer than the cap', () => {
  // 0.7×–1.0×, which is the client's own band: many hosts that lost the same relay at the
  // same moment must not come back in lockstep and re-congest it.
  assert.equal(computeReconnectDelayMs({ attempt: 3, random: 0 }), 5_600);
  assert.equal(computeReconnectDelayMs({ attempt: 3, random: 0.5 }), 6_800);
  assert.equal(computeReconnectDelayMs({ attempt: 3, random: 1 }), 8_000);
  // Capped first, jittered after: a retry can never exceed the cap by the jitter factor.
  assert.equal(computeReconnectDelayMs({ attempt: 20, random: 1 }), RECONNECT_MAX_MS);
  assert.equal(computeReconnectDelayMs({ attempt: 20, random: 0 }), Math.round(RECONNECT_MAX_MS * 0.7));
});

test('a nonsensical input is clamped rather than turned into an immediate retry storm', () => {
  // A NaN delay would become setTimeout(fn, NaN) — an immediate retry, forever.
  for (const attempt of [undefined, null, NaN, -3, 1.7, '2']) {
    const delay = computeReconnectDelayMs({ attempt, random: 0.5 });
    assert.ok(Number.isFinite(delay) && delay >= 700 && delay <= RECONNECT_MAX_MS, `attempt=${String(attempt)} → ${delay}`);
  }
  assert.equal(computeReconnectDelayMs({ attempt: 1.7, random: 0.5 }), computeReconnectDelayMs({ attempt: 1, random: 0.5 }));
  assert.equal(computeReconnectDelayMs({ attempt: -3, random: 0.5 }), computeReconnectDelayMs({ attempt: 0, random: 0.5 }));
  // Out-of-range jitter clamps into the band instead of scaling past it.
  assert.equal(computeReconnectDelayMs({ attempt: 0, random: 9 }), 1_000);
  assert.equal(computeReconnectDelayMs({ attempt: 0, random: -9 }), 700);
  assert.equal(computeReconnectDelayMs(), 700, 'no arguments is the first retry, jitter floor');
});
