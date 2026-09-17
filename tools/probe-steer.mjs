#!/usr/bin/env node
/**
 * Reproduce the controller's steer on a queued item.
 *
 * The phone sent `maker:input:steer` and the Host answered `THREW` with no
 * message — so the interesting part is the raw error, not the summary. This runs
 * the same sequence the composer does: start a turn, queue behind it, then
 * promote the queued row.
 *
 * Usage: node tools/probe-steer.mjs [--base …] [--session <id>]
 */

const args = process.argv.slice(2);
const baseAt = args.indexOf('--base');
const BASE = baseAt === -1 ? 'http://127.0.0.1:3081' : args[baseAt + 1];
const sessionAt = args.indexOf('--session');
const SESSION = sessionAt === -1 ? 'session-acceptance-probe' : args[sessionAt + 1];

async function raw(channel, channelArgs = []) {
  const response = await fetch(`${BASE}/api/dsh-cindy-host/selftest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel, args: channelArgs }),
  });
  const text = await response.text();
  try {
    return JSON.parse(text).reply?.payload ?? { ok: false, error: { code: 'NO_REPLY', message: text } };
  } catch {
    return { ok: false, error: { code: 'UNPARSEABLE', message: text.slice(0, 300) } };
  }
}

const run = Date.now().toString(36);
console.log(`session: ${SESSION}  run: ${run}\n`);

await raw('device-link:subscribe', [{ topics: [`session:${SESSION}`] }]);

console.log('1) start a turn');
const first = await raw('maker:input:enqueue', [SESSION, { text: 'steer probe, reply with one word', clientId: `steer-run-${run}` }]);
console.log(`   ok=${first.ok} ${first.error?.code ?? ''}`);
await new Promise((resolve) => setTimeout(resolve, 2500));

console.log('2) queue behind it');
const itemId = `steer-item-${run}`;
const second = await raw('maker:input:enqueue', [SESSION, { text: 'queued for the steer', clientId: itemId }]);
const held = (second.result?.pendingQueue ?? []).map((row) => row.clientId);
console.log(`   ok=${second.ok} pending=[${held.join(',')}]`);

console.log('3) the projection, authoritatively');
const projection = await raw('maker:input:get-projection', [SESSION]);
console.log(`   pending=[${(projection.result?.pendingQueue ?? []).map((row) => row.clientId).join(',')}]`);

console.log('4) steer the item, exactly as the composer does');
const steer = await raw('maker:input:steer', [SESSION, { clientId: itemId, text: 'queued for the steer' }]);
console.log(`   ${JSON.stringify(steer)}`);

console.log('5) steer with a fresh id (the new-message path)');
const fresh = await raw('maker:input:steer', [SESSION, { clientId: `steer-fresh-${run}`, text: 'brand new' }]);
console.log(`   ${JSON.stringify(fresh)}`);

await raw('maker:input:stop', [SESSION]);
await raw('device-link:unsubscribe', [{ topics: [`session:${SESSION}`] }]);
console.log('\ndone');
