#!/usr/bin/env node
/**
 * Does the live-message push actually fire?
 *
 * `local-db:messages:created` is the push that makes a reply appear on a phone
 * that is watching a session, and a unit test cannot see it: the handler is
 * registered against DSH's own `session/event`, which only exists in the assembled
 * Host. This subscribes as a watcher, sends one prompt, and watches the push ring.
 *
 * Reading the diagnostics correctly is the whole trick, and two properties of the
 * Host make the naive reading wrong:
 *
 *   1. `recentPushes` is a sliding window. The Host keeps 40 entries and the status
 *      endpoint exposes only the newest 20 (`getPushLog().slice(-20)`); every
 *      session on the Host shares it. On a busy Host other sessions evict this
 *      run's entries between samples, so a per-sample count can read zero even
 *      though the push fired. The ring is therefore reported as colour only.
 *   2. `pushTotals` is monotonic per channel and never decreases. Its delta across
 *      the enqueue is the actual evidence, and it cannot be evicted.
 *
 * The delta spans the whole Host, so it also counts other sessions' traffic; the
 * ring sample is what attributes the traffic to this session. Both are printed.
 *
 * Usage: node tools/probe-push-visibility.mjs [--base http://127.0.0.1:3081] [--session <id>]
 */

const args = process.argv.slice(2);
const baseAt = args.indexOf('--base');
const BASE = baseAt === -1 ? 'http://127.0.0.1:3081' : args[baseAt + 1];
const sessionAt = args.indexOf('--session');
const SESSION = sessionAt === -1 ? 'session-acceptance-probe' : args[sessionAt + 1];
const CLIENT_ID = `pushvis-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
/** The channel whose firing is the question this probe exists to answer. */
const KEY_CHANNEL = 'local-db:messages:created';

async function call(channel, channelArgs = []) {
  const response = await fetch(`${BASE}/api/dsh-cindy-host/selftest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel, args: channelArgs }),
  });
  const envelope = await response.json();
  return envelope.reply?.payload ?? { ok: false, error: { code: 'NO_REPLY' } };
}

async function status() {
  return (await fetch(`${BASE}/api/dsh-cindy-host/status`)).json();
}

function tally(entries) {
  const counts = new Map();
  for (const entry of entries) counts.set(entry.channel, (counts.get(entry.channel) ?? 0) + 1);
  return [...counts].map(([channel, count]) => `${channel}=${count}`).join(' ') || '(none)';
}

function deltas(before, after) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out = {};
  for (const name of names) out[name] = (after[name] ?? 0) - (before[name] ?? 0);
  return out;
}

/** Channel deltas that are non-zero, as a readable string. */
function active(delta) {
  return Object.entries(delta)
    .filter(([, count]) => count !== 0)
    .map(([channel, count]) => `${channel}=+${count}`)
    .join(' ') || '(no push of any channel)';
}

console.log(`session: ${SESSION}`);
console.log(`clientId: ${CLIENT_ID}`);
console.log(`key channel: ${KEY_CHANNEL}\n`);

await call('device-link:subscribe', [{ topics: [`session:${SESSION}`] }]);
const held = (await status()).diagnostics.subscriptions.sessions;
console.log(`subscribed: ${JSON.stringify(held)}\n`);

const baseline = await status();
const totalsBefore = baseline.diagnostics.pushTotals ?? {};
const rowsBefore = (await call('local-db:messages:list', [SESSION, { limit: 1 }])).result?.length ?? 0;
console.log(`pushTotals before: ${JSON.stringify(totalsBefore)}\n`);

const sent = await call('maker:input:enqueue', [
  SESSION,
  { text: 'push visibility probe', clientId: CLIENT_ID },
]);
console.log(`enqueue ok=${sent.ok} ${sent.error?.code ?? ''}\n`);

// Poll fast: the shared ring can evict this run's entries within a couple of
// seconds, so a slow loop would sample after they are already gone.
const seen = new Map();
for (let step = 1; step <= 20; step += 1) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  const snapshot = await status();
  const mine = (snapshot.diagnostics.recentPushes ?? []).filter((entry) => entry.sessionId === SESSION);
  for (const entry of mine) seen.set(`${entry.at}|${entry.channel}`, entry);
  if (step % 4 === 0) {
    console.log(`t+${(step * 0.25).toFixed(1)}s  ring(last 1s): ${tally([...seen.values()].filter((e) => Date.parse(e.at) > Date.now() - 1000))}`);
  }
}

const after = await status();
const delta = deltas(totalsBefore, after.diagnostics.pushTotals ?? {});
const ring = after.diagnostics.recentPushes ?? [];
const ringMine = ring.filter((entry) => entry.sessionId === SESSION);

console.log(`\npushTotals after : ${JSON.stringify(after.diagnostics.pushTotals ?? {})}`);
console.log(`host-wide delta  : ${active(delta)}`);
console.log(`ring attribution : ${ringMine.length} of ${ring.length} entries name this session  ${tally(ringMine)}`);

const messages = await call('local-db:messages:list', [SESSION, { limit: 3 }]);
const rows = Array.isArray(messages.result) ? messages.result : [];
console.log(`\ndurable rows: ${rows.length} (baseline ${rowsBefore})  newest role=${rows[0]?.role ?? 'none'}`);

await call('device-link:unsubscribe', [{ topics: [`session:${SESSION}`] }]);

const fired = (delta[KEY_CHANNEL] ?? 0) > 0;
console.log(`\nRESULT: ${KEY_CHANNEL} ${fired ? `FIRED (+${delta[KEY_CHANNEL]})` : 'did NOT fire'} during this run`);
console.log(`        verdict source: monotonic pushTotals delta (eviction-proof)`);
if (!fired && rows.length > 0) {
  console.log('        note: durable rows exist, so the turn ran — the push, not the write, is what failed');
}
process.exitCode = fired ? 0 : 1;
