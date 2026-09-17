/**
 * Show the item mix `local-db:messages:view` would hand the phone for a real session.
 *
 * It reads rows through `local-db:messages:list` (the live Host's raw window) and groups
 * them with the *current* view implementation, so the shape can be checked without
 * restarting anything — the point being how much of a page is readable prose and how big
 * one expansion can get.
 *
 * Usage: node tools/probe-view-shape.mjs [sessionId] [rows]
 */
import { groupHistoryItems, HISTORY_PAGE_ITEMS } from '../src/host-history-view.js';

const sessionId = process.argv[2] ?? 'session-5020c98a-45ea-46dc-b454-455c07faf6ab';
const wanted = Number(process.argv[3] ?? 1200);

async function call(args) {
  const response = await fetch('http://127.0.0.1:3080/api/dsh-cindy-host/selftest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'local-db:messages:list', args }),
  });
  const body = await response.json();
  return body?.reply?.payload;
}

const collected = [];
let cursor;
while (collected.length < wanted) {
  const payload = await call(cursor === undefined ? [sessionId, { limit: 400 }] : [sessionId, { limit: 400, before: cursor }]);
  if (payload?.ok !== true || !Array.isArray(payload.result) || payload.result.length === 0) break;
  collected.push(...payload.result);
  cursor = payload.result[payload.result.length - 1].id;
}

// The reader serves newest first; grouping reverses to chronological itself.
const items = groupHistoryItems(collected, { running: true });
const prose = items.filter((item) => item.type === 'messages');
const work = items.filter((item) => item.type === 'work');
const sizes = work.map((item) => item.summary.messageCount);
console.log(`rows read: ${collected.length}`);
console.log(`items: ${items.length}  prose=${prose.length}  work=${work.length}`);
console.log(`work rows: max=${Math.max(0, ...sizes)} avg=${(sizes.reduce((a, b) => a + b, 0) / Math.max(1, sizes.length)).toFixed(1)}`);
console.log(`items a page would carry (newest first, ${HISTORY_PAGE_ITEMS} max):`);
for (const item of items.slice(-HISTORY_PAGE_ITEMS)) {
  console.log(item.type === 'messages'
    ? `  messages  ${item.messages[0].role.padEnd(10)} ${String(item.messages[0].content?.text ?? '').slice(0, 60)}`
    : `  work      rows=${String(item.summary.messageCount).padStart(3)} tools=${String(item.summary.toolCount).padStart(3)} ${new Date(item.summary.startedAtMs).toISOString().slice(11, 19)}`);
}
