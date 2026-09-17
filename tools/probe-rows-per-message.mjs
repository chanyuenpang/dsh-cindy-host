#!/usr/bin/env node
/**
 * How many rows does one DSH message become?
 *
 * The controller pages by **row**, and a row is one content block
 * (`RemoteMessageRole` includes `tool_use` / `tool_result` / `thinking`). So the
 * useful question behind "pull-to-load gives me one exchange" is how many rows a
 * single message produces: if one turn becomes twenty rows, a twenty-row page is
 * one turn, whatever the page size.
 *
 * This reads the transcript and buckets rows by their message id.
 *
 * Usage: node tools/probe-rows-per-message.mjs [--base …] [--session <id>]
 */

const args = process.argv.slice(2);
const baseAt = args.indexOf('--base');
const BASE = baseAt === -1 ? 'http://127.0.0.1:3081' : args[baseAt + 1];
const sessionAt = args.indexOf('--session');
const SESSION = sessionAt === -1 ? 'session-32859d1e-301b-423a-b62b-06f86fd97ebe' : args[sessionAt + 1];

const response = await fetch(`${BASE}/api/dsh-cindy-host/selftest`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ channel: 'local-db:messages:list', args: [SESSION, { limit: 200 }] }),
});
const payload = (await response.json()).reply?.payload;
const rows = Array.isArray(payload?.result) ? payload.result : [];

/** Rows are identified as `sessionId:messageId:blockIndex`. */
const perMessage = new Map();
for (const row of rows) {
  const parts = String(row.id).split(':');
  const messageId = parts.length >= 3 ? parts[parts.length - 2] : String(row.id);
  const bucket = perMessage.get(messageId) ?? { roles: [], createdAt: row.createdAt };
  bucket.roles.push(row.role);
  bucket.createdAt = row.createdAt;
  perMessage.set(messageId, bucket);
}

console.log(`${rows.length} rows across ${perMessage.size} messages\n`);
const sizes = [...perMessage.values()].map((bucket) => bucket.roles.length);
const average = sizes.length === 0 ? 0 : (sizes.reduce((sum, size) => sum + size, 0) / sizes.length).toFixed(1);
console.log(`rows per message: min=${Math.min(...sizes, 0)} max=${Math.max(...sizes, 0)} avg=${average}`);
console.log(`a 20-row page spans about ${(20 / (Number(average) || 1)).toFixed(1)} messages\n`);

console.log('the heaviest messages:');
for (const [messageId, bucket] of [...perMessage].sort((a, b) => b[1].roles.length - a[1].roles.length).slice(0, 8)) {
  const tally = bucket.roles.reduce((counts, role) => ({ ...counts, [role]: (counts[role] ?? 0) + 1 }), {});
  console.log(`  ${String(bucket.roles.length).padStart(2)} rows  ${messageId.slice(0, 12)}  ${JSON.stringify(tally)}`);
}
