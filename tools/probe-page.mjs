/**
 * Probe one message page through the live Host's self-test route and print a
 * compact table: what the page contains, and how long the Host took to build it.
 *
 * Usage: node tools/probe-page.mjs <sessionId> [limit] [before]
 */
const [sessionId, limitArg, beforeArg] = process.argv.slice(2);
if (!sessionId) {
  console.error('usage: node tools/probe-page.mjs <sessionId> [limit] [before]');
  process.exit(1);
}
const limit = Number(limitArg ?? 80);
const args = [sessionId, Number.isFinite(limit) && limit > 0 ? { limit, ...(beforeArg ? { before: beforeArg } : {}) } : {}];
const started = Date.now();
const response = await fetch('http://127.0.0.1:3080/api/dsh-cindy-host/selftest', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ channel: 'local-db:messages:list', args }),
});
const body = await response.json();
const elapsed = Date.now() - started;
const payload = body?.reply?.payload;
if (payload?.ok !== true) {
  console.log(`FAILED in ${elapsed} ms: ${JSON.stringify(payload?.error ?? payload)}`);
  process.exit(1);
}
const rows = payload.result;
const bytes = Buffer.byteLength(JSON.stringify(body.reply), 'utf8');
console.log(`rows=${rows.length} elapsed=${elapsed}ms replyBytes=${bytes}`);
const groups = new Map();
for (const row of rows) groups.set(row.createdAt, (groups.get(row.createdAt) ?? 0) + 1);
console.log(`timestamps=${groups.size}`);
for (const row of rows) {
  const content = row.content ?? {};
  const text = typeof content.text === 'string' ? content.text.replace(/\s+/g, ' ').slice(0, 46) : `[${Object.keys(content).join(',')}]`;
  console.log(`${row.createdAt} ${String(row.role).padEnd(10)} ${row.id.slice(row.id.lastIndexOf(':') + 1).padEnd(10)} ${text}`);
}
