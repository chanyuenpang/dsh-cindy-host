#!/usr/bin/env node
/**
 * Steer a genuinely queued item, the way the controller does.
 *
 * The controller reported `queued item is no longer pending` for an item the Host
 * was still listing as queued, so this exercises the exact sequence and prints the
 * raw answer.
 *
 * Usage: node tools/probe-steer-queued.mjs [--base …] [--session <id>] [--item <clientId>]
 */

const args = process.argv.slice(2);
const pick = (flag, fallback) => {
  const at = args.indexOf(flag);
  return at === -1 ? fallback : args[at + 1];
};

const BASE = pick('--base', 'http://127.0.0.1:3081');
const SESSION = pick('--session', 'session-selftest-secondsend-1789585030081-b2b');
const ITEM = pick('--item', 'b2b-b-1789585030081');

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

console.log(`session: ${SESSION}`);
console.log(`item:    ${ITEM}\n`);

const before = await raw('maker:input:get-projection', [SESSION]);
console.log('queued before:');
for (const row of before.result?.pendingQueue ?? []) console.log(`  id=${row.clientId}  text=${JSON.stringify(row.text)}`);

console.log('\nsteer (promotion path):');
const steer = await raw('maker:input:steer', [SESSION, { clientId: ITEM, text: 'back to back two' }]);
console.log(`  ${JSON.stringify(steer).slice(0, 400)}`);

const after = await raw('maker:input:get-projection', [SESSION]);
console.log('\nqueued after:');
for (const row of after.result?.pendingQueue ?? []) console.log(`  id=${row.clientId}  text=${JSON.stringify(row.text)}`);
console.log(`  steering: ${JSON.stringify(after.result?.steeringQueueClientIds ?? [])}`);

console.log('\nrunning turns:');
console.log(`  ${JSON.stringify((await raw('maker:list-active')).result)}`);

console.log('\nremove (the other mutation, for comparison):');
const remove = await raw('maker:input:remove', [SESSION, ITEM]);
console.log(`  ${JSON.stringify(remove).slice(0, 300)}`);
