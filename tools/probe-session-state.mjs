#!/usr/bin/env node
/**
 * What is the state of the session the user steered in?
 *
 * Prints the queue the Host actually holds, the running turns, and then attempts
 * the same steer, so the failing path reports its own error instead of a summary.
 *
 * Usage: node tools/probe-session-state.mjs [--base …] [--session <id>]
 */

const args = process.argv.slice(2);
const baseAt = args.indexOf('--base');
const BASE = baseAt === -1 ? 'http://127.0.0.1:3081' : args[baseAt + 1];
const sessionAt = args.indexOf('--session');
const SESSION = sessionAt === -1 ? 'session-selftest-secondsend-1789585030081-b2b' : args[sessionAt + 1];

async function raw(channel, channelArgs = []) {
  const response = await fetch(`${BASE}/api/dsh-cindy-host/selftest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel, args: channelArgs }),
  });
  return (await response.json()).reply?.payload ?? { ok: false, error: { code: 'NO_REPLY' } };
}

console.log(`session: ${SESSION}\n`);

const sessions = await raw('local-db:sessions:list');
for (const row of sessions.result ?? []) {
  console.log(`  ${String(row.id).padEnd(52)} running=${row.running} updated=${row.updatedAt}`);
}

console.log('\nrunning turns:');
console.log(`  ${JSON.stringify((await raw('maker:list-active')).result)}`);

console.log('\nthe queue this Host holds for that session:');
const projection = await raw('maker:input:get-projection', [SESSION]);
console.log(`  pendingQueue: ${JSON.stringify((projection.result?.pendingQueue ?? []).map((row) => ({ clientId: row.clientId, text: row.text })))}`);
console.log(`  steeringQueueClientIds: ${JSON.stringify(projection.result?.steeringQueueClientIds ?? [])}`);

console.log('\nthe transcript tail:');
const messages = await raw('local-db:messages:list', [SESSION, { limit: 6 }]);
for (const row of messages.result ?? []) {
  const text = JSON.stringify(row.content?.text ?? row.content ?? '').slice(0, 60);
  console.log(`  ${String(row.role).padEnd(11)} ${row.createdAt}  ${text}`);
}
