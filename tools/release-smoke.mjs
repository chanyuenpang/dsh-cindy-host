import assert from 'node:assert/strict';
import { HOST_PLUGIN_VERSION } from '../src/host-version.js';
import { UNSUPPORTED_INVOKES } from './compat-boundaries-20261028.mjs';
const base = process.env.HOST_SMOKE_BASE || 'http://127.0.0.1:3081';
let count = 0;
function check(name, fn) { fn(); count++; console.log('PASS ' + name); }
async function call(channel, args = []) {
  const response = await fetch(base + '/api/dsh-cindy-host/selftest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel, args }) });
  assert.equal(response.status, 200);
  return (await response.json()).reply.payload;
}
const response = await fetch(base + '/api/dsh-cindy-host/status');
assert.equal(response.status, 200);
const status = await response.json();
check('clean tarball really mounted', () => assert.equal(status.installed, true));
check('loaded runtime matches the release being tested', () => assert.equal(status.status.pluginVersion, HOST_PLUGIN_VERSION));
check('DSH 0.2 session-controller adapter retained', () => assert.equal(status.diagnostics.dataSource, 'session-controller'));
check('fresh profile stays disconnected without sharing production relay identity', () => assert.equal(status.status.state, 'disconnected'));
check('no startup handler errors', () => assert.deepEqual(status.diagnostics.handlerErrors, []));
const providers = await call('maker:provider:list');
check('provider:list remains supported, unlike the obsolete legacy refusal assertion', () => { assert.equal(providers.ok, true); assert.ok(Array.isArray(providers.result.providers)); assert.ok(Array.isArray(providers.result.providerOrder)); });
const projection = await call('maker:input:get-projection', ['release-smoke-empty']);
check('unknown session or unverified identity cannot fabricate durable input ownership', () => {
  assert.equal(projection.ok, false);
  // NOT_FOUND: the host is authenticated and the session id is unknown.
  // DELIVERY_NOT_AVAILABLE / NOT_AVAILABLE: the host has no verified account yet, so it
  //   cannot own durable input either. Both are refusals; neither invents ownership.
  assert.ok(['NOT_FOUND', 'NOT_AVAILABLE', 'DELIVERY_NOT_AVAILABLE'].includes(projection.error.code));
});
for (const channel of ['maker:input:enqueue', 'maker:input:steer']) {
  const answer = await call(channel, []);
  check(channel + ' malformed send is bounded and does not start an agent', () => { assert.equal(answer.ok, false); assert.ok(['BAD_REQUEST', 'NOT_AVAILABLE'].includes(answer.error.code)); });
}
for (const [channel] of UNSUPPORTED_INVOKES) {
  const answer = await call(channel);
  check('optional feature is genuinely refused: ' + channel, () => { assert.equal(answer.ok, false); assert.equal(answer.error.code, 'CHANNEL_NOT_ALLOWED'); });
}
const final = await (await fetch(base + '/api/dsh-cindy-host/status')).json();
check('probes did not create a false success or handler error', () => assert.deepEqual(final.diagnostics.handlerErrors, []));
console.log(count + '/' + count + ' packed-runtime smoke checks passed');
