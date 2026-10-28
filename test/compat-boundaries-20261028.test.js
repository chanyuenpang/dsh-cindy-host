import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelRouter, SUPPORTED_CHANNELS } from '../src/cindy-channels.js';
import { HOST_PUSH_CHANNELS } from '../src/host-push-channels.js';
import { UNSUPPORTED_INVOKES, UNSENT_PUSHES } from '../tools/compat-boundaries-20261028.mjs';
const router = createChannelRouter({ listSessions: async () => { assert.fail('optional refusal must not execute a session operation'); }, subscribers: new Set() });
for (const [channel, reason] of UNSUPPORTED_INVOKES) test('explicitly refuse unavailable optional channel: ' + channel, async () => {
  assert.ok(reason.length > 20);
  assert.ok(!SUPPORTED_CHANNELS.includes(channel));
  const response = await router({ v: 1, kind: 'invoke', id: 'optional', src: 'peer', payload: { channel, args: [] } });
  assert.equal(response.payload.ok, false);
  assert.equal(response.payload.error.code, 'CHANNEL_NOT_ALLOWED');
});
test('unavailable optional subsystems do not advertise fabricated changed pushes', () => {
  for (const [channel, reason] of UNSENT_PUSHES) { assert.ok(reason); assert.ok(!HOST_PUSH_CHANNELS.has(channel)); }
});
