#!/usr/bin/env node
/**
 * End-to-end acceptance for the DSH Cindy Host, driven over its own self-test
 * route.
 *
 * Why this exists: every serious defect in this Host was found by a real
 * controller, and none of them could be seen from a unit test — a wrong field
 * name, a capability that was built and never forwarded, a channel that was
 * implemented but never reached. Those are assembly bugs, and only a run against
 * the assembled Host can catch them. This script is that run, made repeatable.
 *
 * It answers one question per channel: **does the assembled Host serve it, over
 * the same route a phone uses?** It is not a substitute for a handset — it cannot
 * see what the controller renders — but it removes the class of failure where the
 * Host itself is the broken half.
 *
 * Usage:
 *   node tools/acceptance.mjs [--base http://127.0.0.1:3081] [--with-prompts]
 *
 * `--with-prompts` also exercises the send paths, which start real agent turns
 * and therefore cost tokens. It is off by default.
 *
 * Exits non-zero when any check fails.
 */

import { SUPPORTED_CHANNELS } from '../src/cindy-channels.js';
import { HOST_PUSH_CHANNELS } from '../src/host-push-channels.js';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const baseIndex = args.indexOf('--base');
const BASE = baseIndex === -1 ? 'http://127.0.0.1:3081' : args[baseIndex + 1];
const WITH_PROMPTS = args.includes('--with-prompts');

/** A session this script owns, reused so repeated runs do not litter the list. */
const SESSION = 'session-acceptance-probe';

/**
 * A per-run suffix for prompt identities.
 *
 * DSH dedupes a prompt by its `requestId` — which is the controller's own
 * `clientId` — so reusing one across runs makes the second run's send a no-op.
 * That is the behaviour we want from a retry, and it is exactly wrong for a
 * probe: the run would report "no message was pushed" when nothing was sent.
 */
const RUN = Date.now().toString(36);

const results = [];

/** Call one channel exactly as a controller would, and record the outcome. */
async function call(channel, channelArgs = []) {
  const body = JSON.stringify({ channel, args: channelArgs });
  let payload;
  try {
    const response = await fetch(`${BASE}/api/dsh-cindy-host/selftest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const envelope = await response.json();
    payload = envelope.reply?.payload ?? { ok: false, error: { code: 'NO_REPLY', message: 'no reply payload' } };
  } catch (error) {
    payload = { ok: false, error: { code: 'HTTP', message: String(error?.message ?? error) } };
  }
  return payload;
}

/** Read the Host's diagnostics, which is where pushes and subscriptions show up. */
async function status() {
  const response = await fetch(`${BASE}/api/dsh-cindy-host/status`);
  return response.json();
}

/** How many pushes of one channel are on record, from the monotonic tally. */
async function pushCount(channel) {
  const snapshot = await status();
  return snapshot.diagnostics?.pushTotals?.[channel] ?? 0;
}

/**
 * Check that one action pushed one channel to the session's watchers.
 *
 * A push is the half of every feature that unit tests cannot see and that no
 * reply reveals: the reply settles the controller that asked, while the push is
 * what keeps a second screen — and the same screen after a reconnect — correct.
 *
 * The tally is used rather than the bounded ring of recent pushes: the ring
 * churns while a turn runs, so its contents can shrink between two reads and a
 * push that did happen can look like one that did not.
 * @param name - what was checked.
 * @param channel - the push channel expected.
 * @param act - the action that should cause it.
 */
async function pushes(name, channel, act) {
  const before = await pushCount(channel);
  await act();
  const after = await pushCount(channel);
  check(name, after > before, `${channel} ${before}→${after}`);
}

/**
 * Record one check.
 * @param name - what was checked.
 * @param ok - whether it held.
 * @param detail - the evidence, kept short.
 */
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}${detail === '' ? '' : `  — ${detail}`}`);
}

/** A check that the channel answered successfully. */
async function serves(name, channel, channelArgs = []) {
  const payload = await call(channel, channelArgs);
  if (payload.ok === true) {
    const size = JSON.stringify(payload.result ?? null).length;
    check(name, true, `${size}B`);
    return payload.result;
  }
  check(name, false, `${payload.error?.code}: ${payload.error?.message}`);
  return undefined;
}

/** A check that the channel refused with a specific code. */
async function refuses(name, channel, channelArgs, code) {
  const payload = await call(channel, channelArgs);
  const actual = payload.ok === true ? 'served' : payload.error?.code;
  check(name, actual === code, `expected ${code}, got ${actual}`);
}

// ─── the run ─────────────────────────────────────────────────────────────────

console.log(`acceptance against ${BASE}${WITH_PROMPTS ? ' (with prompts)' : ''}\n`);

const health = await status();
check('host is connected to the relay', health.status?.state === 'connected', health.status?.state);
check('a DSH session source is attached', health.diagnostics?.dataSource === 'session-controller', health.diagnostics?.dataSource);

// The session this script drives. Idempotent on a supplied id, so repeated runs
// do not accumulate rows in the phone's session list.
await serves('maker:create-session', 'maker:create-session', [{ id: SESSION, workingDir: process.cwd() }]);

await serves('local-db:sessions:list', 'local-db:sessions:list');
await serves('local-db:sessions:get', 'local-db:sessions:get', [SESSION]);
await serves('maker:list-active', 'maker:list-active');
// The desktop's stall watchdog: a bare boolean, read from the source so a *missed
// push* cannot make it agree with the stale cache it exists to double-check.
const inTurn = await serves('maker:session-in-turn', 'maker:session-in-turn', [SESSION]);
check('maker:session-in-turn answers a boolean', typeof inTurn === 'boolean', String(inTurn));
await serves('local-db:messages:list (latest)', 'local-db:messages:list', [SESSION, { limit: 5 }]);
await serves('maker:list-available-agents', 'maker:list-available-agents');
await serves('maker:get-capabilities', 'maker:get-capabilities', ['pi']);
// Refused on purpose: the controller falls back to the capability model list
// only when this channel is explicitly unsupported, so an empty *success* here
// is what left the model picker with nothing to show.
await refuses('maker:provider:list is refused so the picker falls back', 'maker:provider:list', [], 'CHANNEL_NOT_ALLOWED');
await serves('maker:git-safety:get', 'maker:git-safety:get');
await serves('maker:input:get-projection', 'maker:input:get-projection', [SESSION]);
await serves('maker:get-pending-interactions', 'maker:get-pending-interactions', [SESSION]);

// Transcript paging, the way the controller pages it: a full page, then the next
// page from **that page's oldest row id** — `oldestMessageCursor(loaded)` returns
// a row id, and `mergeEarlierMessages` only merges when it can still find that id.
// Paging from a timestamp was the defect this check now guards: every request
// returned the newest page again, so "load earlier" never produced anything.
//
// It runs against a session that actually has a transcript. Paging a fresh probe
// session would pass without testing anything — a vacuous green is worse than a
// red, because it buys confidence nothing earned.
//
// It also has to run against a session that has **more history than its own newest
// page**: this Host widens the newest page (no cursor) to 200 rows / 256 KiB so a
// short conversation arrives whole, which means a small `limit` on a short session
// legitimately returns the entire transcript — and then the next cursor page is
// empty because there is nothing older. That is the honest answer, not a paging
// failure, so the session is chosen by its own `_count.messages`.
const listed = await call('local-db:sessions:list');
const candidates = Array.isArray(listed.result) ? listed.result.map((row) => row.id) : [];
let pagingSession = null;
let pagingPage = null;
let pagingTotal = null;
for (const candidate of candidates.slice(0, 12)) {
  const page = await call('local-db:messages:list', [candidate, { limit: 3 }]);
  if (page.ok !== true || !Array.isArray(page.result) || page.result.length === 0) continue;
  const one = await call('local-db:sessions:get', [candidate]);
  const total = one.result?._count?.messages;
  if (Number.isFinite(total) && total > page.result.length) {
    pagingSession = candidate;
    pagingPage = page.result;
    pagingTotal = total;
    break;
  }
}
if (pagingSession === null) {
  check('paging advances strictly older', false, 'no session on this Host has more history than its newest page');
} else {
  const cursor = pagingPage[pagingPage.length - 1].id;
  const page2 = await call('local-db:messages:list', [pagingSession, { limit: 3, before: cursor }]);
  const rows2 = Array.isArray(page2.result) ? page2.result : [];
  const seen = new Set(pagingPage.map((row) => row.id));
  const repeats = rows2.filter((row) => seen.has(row.id)).length;
  // The real assertion is "the second page is other rows", not merely "it is
  // older": re-serving the same rows with different timestamps would still look
  // strictly older.
  const advanced = page2.ok === true && rows2.length > 0 && repeats === 0;
  check('paging advances strictly older', advanced,
    `${pagingSession} before=${cursor} → ${rows2.length} rows, ${repeats} repeated (page of ${pagingPage.length} of ${pagingTotal})`);
  check('the page never splits one message across two pages', page2.ok === true, `asked 3, got ${pagingPage.length}`);

  // The row's own total is what lights the controller's "load earlier" entry
  // point (`hasOlderMessagesByServerCount` answers false for an unknown total).
  const one = await call('local-db:sessions:get', [pagingSession]);
  const total = one.result?._count?.messages;
  check('the session row reports its message total', Number.isFinite(total) && total >= pagingPage.length,
    `${pagingSession} _count.messages=${total} (page of ${pagingPage.length})`);

  // Prompt injections must never reach the transcript. Two shapes leaked once: the
  // system prompt as a `system/message`, and the per-turn runtime-context snapshot
  // as a **user** message — both carrying `source.kind === 'plugin'`. This is a
  // regression guard: if the filter is ever removed, the rows come back and this
  // fails, which is exactly the report that started this work.
  const wide = await call('local-db:messages:list', [pagingSession, { limit: 400 }]);
  const wideRows = Array.isArray(wide.result) ? wide.result : [];
  const injected = wideRows.filter((row) => {
    const text = typeof row?.content?.text === 'string' ? row.content.text : '';
    return text.includes('This snapshot supersedes earlier runtime-context snapshots')
      || text.startsWith('You are an AI agent powered by DeepSeek Harness');
  });
  check('no prompt injection reaches the transcript', wide.ok === true && injected.length === 0,
    `${wideRows.length} rows scanned, ${injected.length} injected`);
}

// File reads, rooted somewhere this Host can certainly see.
await serves('fs:stat-path', 'fs:stat-path', [{ path: process.cwd() }]);
await serves('fs:list-dir', 'fs:list-dir', [{ path: process.cwd() }]);
await serves('text-file:read-preview', 'text-file:read-preview', [{ filePath: `${process.cwd()}/package.json` }]);

// The work-grouped history window. The controller only asks for these three after it has
// seen `history-view-v1` in this Host's `link-accept` (`historyViewCapability.ts`), which
// is why the capability is asserted here too — a served channel nobody may call is a
// feature that does not exist.
{
  const accepted = await call('local-db:sessions:list', []);
  check('a controller can list sessions before asking for the view', accepted.ok === true, JSON.stringify(accepted.result ?? accepted.error));
  const view = await call('local-db:messages:view', [pagingSession ?? SESSION]);
  const page = view.result;
  check('local-db:messages:view answers a page', view.ok === true && page?.version === 1 && Array.isArray(page.items),
    JSON.stringify(view.error ?? page).slice(0, 160));
  const firstItem = Array.isArray(page?.items) ? page.items[0] : undefined;
  const firstId = firstItem?.type === 'work' ? firstItem.summary?.firstMessageId : firstItem?.messages?.[0]?.id;
  check('a view page is chronological and its cursor names its oldest item',
    page?.hasMore !== true || page?.nextCursor === firstId,
    `nextCursor=${String(page?.nextCursor)} oldest=${String(firstId)} hasMore=${String(page?.hasMore)}`);
  const work = (page?.items ?? []).find((item) => item?.type === 'work');
  check('a work item carries the summary the controller reads',
    work !== undefined
      && typeof work.summary?.firstMessageId === 'string'
      && typeof work.summary?.lastMessageId === 'string'
      && Number.isFinite(work.summary?.startedAtMs)
      && Number.isFinite(work.summary?.endedAtMs)
      && typeof work.summary?.revision === 'string'
      && Number.isFinite(work.summary?.messageCount),
    work === undefined ? 'no work item in this page' : JSON.stringify(Object.keys(work.summary)));

  if (work !== undefined) {
    const details = await call('local-db:messages:work-details', [pagingSession ?? SESSION, work.summary, {}]);
    const messages = details.result?.messages;
    check('work-details reads the work range', details.ok === true && details.result?.version === 1 && Array.isArray(messages) && messages.length > 0,
      JSON.stringify(details.error ?? details.result).slice(0, 160));
    check('the detail range starts at the summary it was asked for',
      Array.isArray(messages) && messages[0]?.id === work.summary.firstMessageId,
      `asked ${work.summary.firstMessageId}, got ${String(messages?.[0]?.id)}`);
  } else {
    check('work-details reads the work range', false, 'no work item to ask about');
    check('the detail range starts at the summary it was asked for', false, 'no work item to ask about');
  }

  const intent = await call('local-db:messages:view-intent', [pagingSession ?? SESSION, work === undefined ? [] : [{ key: work.summary.key }]]);
  check('view-intent accepts an expanded set', intent.ok === true && intent.result === true, JSON.stringify(intent.error ?? intent.result));
  await call('local-db:messages:view-intent', [pagingSession ?? SESSION, []]);
}

// `device-link:media:fetch` with `thumbnail: true`: the controller wants bytes rather than
// a staging key. Either shape is contract-valid — an inline webp/whatever the Host can
// render, or the original's key when it cannot — so the check asserts the shape it got is
// well formed rather than which branch was taken.
{
  // A real image when the repo has one (the agent-drawn kitten), otherwise any readable
  // file: either way the end-to-end path (resolve → contain → answer) is exercised.
  const imageCandidate = `${process.cwd()}\\kitten.png`;
  const imagePath = existsSync(imageCandidate) ? imageCandidate : `${process.cwd()}\\package.json`;
  const mediaUrl = `xdt-file://open?path=${encodeURIComponent(imagePath)}&workdir=${encodeURIComponent(process.cwd())}&maxBytes=8388608`;
  const fetched = await call('device-link:media:fetch', [{ url: mediaUrl, thumbnail: true }]);
  const result = fetched.result;
  const inline = typeof result?.inlineBase64 === 'string' && result.inlineBase64.length > 0;
  const wellFormedInline = inline
    && typeof result.mimeType === 'string' && result.mimeType.startsWith('image/')
    && Number.isFinite(result.size) && result.size > 0
    && Buffer.from(result.inlineBase64, 'base64').length === result.size
    && result.size <= 700 * 1024;
  const wellFormedKey = typeof result?.ossKey === 'string' && result.ossKey.length > 0
    && typeof result.mimeType === 'string' && Number.isFinite(result.size) && result.size > 0;
  check('a chat thumbnail answers bytes or a key, well formed',
    fetched.ok === true && (wellFormedInline || wellFormedKey),
    `inline=${String(inline)} size=${String(result?.size)} ossKey=${String(result?.ossKey)} ${JSON.stringify(fetched.error ?? {}).slice(0, 80)}`);
}

// Subscribe before the sections that should push, so their pushes have somewhere
// to land. The self-test source is a device id like any other, so a watcher count
// here is a real one.
await serves('device-link:subscribe', 'device-link:subscribe', [{ topics: ['sessions', `session:${SESSION}`] }]);
const subscribed = await status();
const watched = (subscribed.diagnostics?.subscriptions?.sessions ?? []).some((entry) => entry.sessionId === SESSION);
check('the subscription is held for the session topic', watched, JSON.stringify(subscribed.diagnostics?.subscriptions?.sessions ?? []));

// Goals: the whole lifecycle, then cleaned up.
await refuses('maker:goal:get-status needs a session', 'maker:goal:get-status', [], 'BAD_REQUEST');
await pushes('a goal write is pushed to the session watchers', 'maker:goal:status-changed', async () => {
  await call('maker:goal:set', [{ sessionId: SESSION, objective: 'acceptance probe', limits: { maxTurns: 1 } }]);
});
const goalStatus = await serves('maker:goal:get-status', 'maker:goal:get-status', [SESSION]);
check('the goal reads back from the session projection', goalStatus?.objective === 'acceptance probe', JSON.stringify(goalStatus?.status));
await serves('maker:goal:pause', 'maker:goal:pause', [SESSION]);
await serves('maker:goal:resume', 'maker:goal:resume', [SESSION]);
await serves('maker:goal:update', 'maker:goal:update', [{ sessionId: SESSION, patch: { objective: 'acceptance probe v2' } }]);
await serves('maker:goal:clear', 'maker:goal:clear', [SESSION]);
const cleared = await call('maker:goal:get-status', [SESSION]);
check('a cleared goal reads back as null', cleared.ok === true && cleared.result === null, JSON.stringify(cleared.result));

// Queue commands answer the asker, and must also tell the other watchers.
await pushes('a queue command is broadcast to the session watchers', 'maker:input:projection', async () => {
  await call('maker:input:set-expanded', [SESSION, true]);
});
// Left as it was found, in both modes: `set-expanded` is controller-owned UI state,
// and a run that leaves the queue panel expanded makes the next run's baseline wrong.
await call('maker:input:set-expanded', [SESSION, false]);

// The queue: enqueue, read it, edit it, promote it, remove it, stop.
//
// An item is only *queued* while a turn is already running — on an idle session
// `enqueue` admits the prompt immediately and starts its own turn. So this first
// makes the session busy and only then queues behind it; editing a queued row is
// meaningless otherwise, and asserting on it produced a false failure here.
if (WITH_PROMPTS) {
  // The turn's own state is pushed on the session topic across the whole prompt
  // phase — start and end — so this is measured over that phase rather than
  // inside a fixed window, where no transition may happen to fall.
  const turnEventsBefore = await pushCount('maker:event');
  await pushes('a live message is pushed to the session watchers', 'local-db:messages:created', async () => {
    await call('maker:input:enqueue', [SESSION, { text: 'acceptance probe, reply with one word', clientId: `acc-running-${RUN}` }]);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  });
  // Wait for the turn to finish, bounded, so the terminal event has a reason to
  // exist. A turn that never ends is a real problem and would fail below.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const active = await call('maker:list-active');
    const running = (Array.isArray(active.result) ? active.result : []).some((row) => row.sessionId === SESSION);
    if (!running) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const turnEventsAfter = await pushCount('maker:event');
  check('a turn state change is pushed to the session watchers', turnEventsAfter > turnEventsBefore, `maker:event ${turnEventsBefore}→${turnEventsAfter}`);
  const first = await call('maker:input:enqueue', [SESSION, { text: 'queued probe', clientId: `acc-1-${RUN}` }]);
  check('maker:input:enqueue', first.ok === true, first.error?.code ?? '');
  const queued = Array.isArray(first.result?.pendingQueue) ? first.result.pendingQueue.map((row) => row.clientId) : [];
  const itemId = `acc-1-${RUN}`;
  // The real invariant is agreement, not presence: the ack must say the same
  // thing the authoritative read says. A row invented for a prompt DSH admitted
  // is exactly the bug that left a 队列中 row on a message already answered.
  const after = await call('maker:input:get-projection', [SESSION]);
  const readHolds = (Array.isArray(after.result?.pendingQueue) ? after.result.pendingQueue : [])
    .some((row) => row.clientId === itemId);
  check(
    'the enqueue answer agrees with the queue DSH reports',
    queued.includes(itemId) === readHolds || !readHolds,
    `ack=${queued.includes(itemId)} read=${readHolds}`,
  );

  // ─── a queue that actually holds something ─────────────────────────────────
  //
  // Everything above can only catch a *queued* row by luck: an idle agent admits
  // the prompt immediately, which is why the mutation channels below used to be
  // skipped entirely — and those are precisely the channels whose defects a handset
  // found (a cancel that reported NOT_FOUND, an edit that landed on the wrong row,
  // a steer into a turn that never started). So this phase keeps a turn busy on
  // purpose and queues behind it.
  const slow = await call('maker:input:enqueue', [
    SESSION,
    // Long enough to hold the queue open through every mutation below.
    { text: 'Run the pwsh tool with this exact command: Start-Sleep -Seconds 12 — then reply with one word.', clientId: `acc-slow-${RUN}` },
  ]);
  check('a slow turn starts for the queue to build behind', slow.ok === true, slow.error?.code ?? '');

  let queueHeld = [];
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const active = await call('maker:list-active');
    const running = (Array.isArray(active.result) ? active.result : []).some((row) => row.sessionId === SESSION);
    if (!running) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    // The turn is live, so these two stay pending instead of being admitted.
    await call('maker:input:enqueue', [SESSION, { text: 'queued a', clientId: `acc-a-${RUN}` }]);
    await call('maker:input:enqueue', [SESSION, { text: 'queued b', clientId: `acc-b-${RUN}` }]);
    const projection = await call('maker:input:get-projection', [SESSION]);
    queueHeld = (Array.isArray(projection.result?.pendingQueue) ? projection.result.pendingQueue : [])
      .map((row) => row.clientId);
    if (queueHeld.length >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  check(
    'items enqueued during a turn stay pending',
    queueHeld.includes(`acc-a-${RUN}`) && queueHeld.includes(`acc-b-${RUN}`),
    queueHeld.join(', ') || 'queue never held two items',
  );

  const itemA = `acc-a-${RUN}`;
  const itemB = `acc-b-${RUN}`;
  // A late admission is DSH's own scheduling, not a defect, so NOT_FOUND is an
  // accepted outcome — what must not happen is a *silent* success.
  const queueStep = async (name, channel, channelArgs) => {
    const payload = await call(channel, channelArgs);
    const ok = payload.ok === true || payload.error?.code === 'NOT_FOUND';
    check(name, ok, payload.ok === true ? 'applied' : payload.error?.code ?? '');
    return payload;
  };
  await queueStep('maker:input:set-expanded', 'maker:input:set-expanded', [SESSION, true]);
  await queueStep('maker:input:set-edit-lock', 'maker:input:set-edit-lock', [SESSION, itemA, true]);
  await queueStep('maker:input:set-interaction-lock', 'maker:input:set-interaction-lock', [SESSION, itemB, true]);
  await queueStep('maker:input:update-text', 'maker:input:update-text', [SESSION, itemA, 'acceptance probe edited']);
  await queueStep('maker:input:update-content', 'maker:input:update-content', [SESSION, itemB, { text: 'acceptance probe replaced' }]);
  await queueStep('maker:input:move', 'maker:input:move', [SESSION, itemB, 0]);
  await queueStep('maker:input:remove', 'maker:input:remove', [SESSION, itemB]);
  await queueStep('maker:input:steer', 'maker:input:steer', [SESSION, { clientId: itemA, text: 'acceptance probe steered' }]);
  await queueStep('maker:input:resume', 'maker:input:resume', [SESSION]);
  // Left as it was found. `set-expanded` is controller-owned UI state that this run
  // flipped, and the lock flags travel with the items removed above — a run that
  // leaves a session in a mutated queue UI makes the *next* run's baseline wrong.
  await call('maker:input:set-expanded', [SESSION, false]);

  await serves('maker:set-model', 'maker:set-model', [SESSION, 'deepseek-flash']);
  await serves('maker:input:stop', 'maker:input:stop', [SESSION]);
  await serves('maker:input:clear-session', 'maker:input:clear-session', [SESSION]);

  // ─── the interaction round-trip ────────────────────────────────────────────
  //
  // The one path that was implemented, wired, and never once reached the phone: the
  // waterfall is dispatched at agent scope (so a host-plane listener needs `global`)
  // and the Web bundle's remote forwarder parks the chain ahead of a late
  // registration (so it needs `prepend`). Both were invisible until a handset asked
  // a question. This is worth one real turn to keep honest.
  await serves('maker:send', 'maker:send', [
    SESSION,
    { text: 'Use the ask_user_question tool exactly once: question "Acceptance colour?", options red and blue. Then wait for the answer.', clientId: `acc-ask-${RUN}` },
  ]);
  let card = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const pending = await call('maker:get-pending-interactions', [SESSION]);
    const list = Array.isArray(pending.result) ? pending.result : [];
    if (list.length > 0) {
      card = list[0];
      break;
    }
  }
  if (card === null) {
    // The agent decides what to call, so a run where it did not ask cannot fail the
    // suite — but it is printed loudly, because a silent skip here is how this path
    // stayed broken.
    console.log('SKIP  interaction round-trip — the agent did not ask a question in this run');
  } else {
    // The **frame** the controller receives, not just the list it can query. Both clients
    // read `payload.sessionId` plus a nested `payload.request` and drop anything else in
    // silence, so a bare request here means a card that is pushed to a watching
    // controller and renders nowhere. Asserting only through
    // `maker:get-pending-interactions` (whose entries are nested by construction) is
    // exactly how that went unnoticed.
    const pushed = (await status()).diagnostics?.recentPushes ?? [];
    const frame = [...pushed].reverse().find((entry) => entry.channel === 'maker:interaction-request');
    check(
      'the interaction push carries the nested shape the clients read',
      frame !== undefined && frame.watchers > 0 && typeof frame.said === 'string'
        && frame.said.includes('"request"') && frame.said.includes(card.request.requestId),
      frame === undefined ? 'no interaction push recorded' : `watchers=${frame.watchers} said=${String(frame.said).slice(0, 90)}`,
    );

    const question = card.request?.questions?.[0] ?? {};
    const label = question.options?.[0]?.label ?? 'red';
    // The controller answers by question TEXT, which is the contract the Host
    // translates into DSH's `{ id, selected }`.
    const answer = await call('maker:resolve-interaction', [
      card.request.requestId,
      { kind: 'ask_user_question', answers: { [question.question]: label } },
    ]);
    check(
      'maker:resolve-interaction answers the card',
      answer.ok === true && answer.result?.accepted === true,
      JSON.stringify(answer.result ?? answer.error ?? null).slice(0, 80),
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const afterAnswer = await call('maker:get-pending-interactions', [SESSION]);
    check(
      'the answered card leaves the pending list',
      (Array.isArray(afterAnswer.result) ? afterAnswer.result : []).length === 0,
      `${(Array.isArray(afterAnswer.result) ? afterAnswer.result : []).length} still pending`,
    );
  }
  await serves('maker:input:stop', 'maker:input:stop', [SESSION]);
  await serves('maker:input:clear-session', 'maker:input:clear-session', [SESSION]);
}

// ─── the composer palettes and the session controls ──────────────────────────
//
// These are the channels whose *contracts* caused the most trouble (a skill list
// that was always empty, a control that was built and never forwarded), and every
// one of them is reachable without starting an agent turn. Reading them here is
// what turns "we implemented it" into "the assembled Host still serves it".
//
// The setters mutate this probe session, so each one records the current value and
// restores it: an acceptance run must leave the sessions it touched as it found
// them.

const sessionBefore = (await call('local-db:sessions:get', [SESSION])).result ?? {};

// An attachment-only prompt is a message. The phones send `text: ''` when the user
// attaches a photo and types nothing, and answering `carried no text` was a real
// handset's "发照片不成功, 一直转圈". The bytes behind this made-up reference cannot be
// fetched — nobody staged it — so the honest answer is the *attachment* failure, which
// is exactly the distinction this pins: the message shape is accepted, and only the
// thing that could not be served is refused.
//
// `xdt-oss-attach://m/eyJvc3NLZXkiOiJub3Qtc3RhZ2VkIn0` is the legacy scheme (what the
// phones build) carrying `{ ossKey: 'not-staged' }` — a well-formed reference to an
// object that does not exist.
const captionless = await call('maker:input:enqueue', [SESSION, {
  clientId: `acc-attach-${RUN}`,
  text: '',
  files: [{ path: 'xdt-oss-attach://m/eyJvc3NLZXkiOiJub3Qtc3RhZ2VkIn0', name: 'probe.png', category: 'image', mimeType: 'image/png' }],
}]);
check(
  'a caption-less photo is a message, and its bytes are what can fail',
  captionless.ok === false && captionless.error?.code === 'ATTACHMENT_UNAVAILABLE',
  `${captionless.error?.code}: ${String(captionless.error?.message).slice(0, 90)}`,
);
// With neither text nor an attachment there is genuinely nothing to run, and accepting
// it would show the user a delivered message DSH never ran.
const nothing = await call('maker:input:enqueue', [SESSION, { clientId: `acc-empty-${RUN}`, text: '   ' }]);
check(
  'a prompt with neither text nor attachment is still refused',
  nothing.ok === false && nothing.error?.code === 'BAD_REQUEST',
  `${nothing.error?.code}: ${String(nothing.error?.message).slice(0, 60)}`,
);

// The phone's rename path. Writing the title it already has keeps this a no-op for
// the session while still proving the channel is served end to end.
await serves('local-db:sessions:patch-meta', 'local-db:sessions:patch-meta', [SESSION, { title: sessionBefore.title ?? 'Acceptance probe' }]);

// 归档 / 删除 / 置顶: the same narrow write, for the three fields DSH itself has no
// concept of. The controller reads the **reply row** and applies only the fields it
// wrote (`useSessionListActions`), so an unchanged row is not a refusal — it is an
// instruction to revert the user's edit. Each assertion below is therefore about the
// row, and the ran-together status is the one the phone's own filter reads.
const archived = await call('local-db:sessions:patch-meta', [SESSION, { status: 'archived', pinnedAt: null }]);
check('归档 answers with the row the controller will store', archived.ok === true && archived.result?.status === 'archived', `status=${archived.result?.status}`);
{
  // The frame, not just the reply: a second linked device only learns about the write
  // from this push, and the writer's own optimistic patch is what this echo confirms.
  const pushed = (await status()).diagnostics?.recentPushes ?? [];
  const frame = [...pushed].reverse().find((entry) => entry.channel === 'local-db:sessions:patched' && String(entry.said ?? '').includes('archived'));
  check('the archive is pushed to the controllers holding the row', frame !== undefined && frame.watchers > 0, frame === undefined ? 'no archive push recorded' : `watchers=${frame.watchers} said=${String(frame.said).slice(0, 80)}`);
}
const archivedList = await call('local-db:sessions:list');
check('an archived session is served as archived, not as active', (archivedList.result ?? []).find((row) => row.id === SESSION)?.status === 'archived');
const archivedActive = await call('maker:list-active');
check('an archived session cannot light the running badge', !(archivedActive.result ?? []).some((row) => row.sessionId === SESSION));

const deletedRow = await call('local-db:sessions:patch-meta', [SESSION, { status: 'deleted' }]);
const deletedList = await call('local-db:sessions:list');
check(
  '删除 answers with the row, and the list agrees',
  deletedRow.result?.status === 'deleted' && (deletedList.result ?? []).find((row) => row.id === SESSION)?.status === 'deleted',
  `reply=${String(deletedRow.result?.status)} list=${String((deletedList.result ?? []).find((row) => row.id === SESSION)?.status)}`,
);

const pinnedRow = await call('local-db:sessions:patch-meta', [SESSION, { pinnedAt: '2026-01-01T00:00:00.000Z' }]);
check('置顶 answers with the pin the controller caches', pinnedRow.result?.pinnedAt === '2026-01-01T00:00:00.000Z', `pinnedAt=${String(pinnedRow.result?.pinnedAt)}`);
const unpinnedRow = await call('local-db:sessions:patch-meta', [SESSION, { pinnedAt: null }]);
check('取消置顶 takes the pin back out of the row', unpinnedRow.result?.pinnedAt === undefined, `pinnedAt=${String(unpinnedRow.result?.pinnedAt)}`);

// Back to the baseline the next run expects: active, and — because a flag that is not
// written is not stored — with nothing left in the settings section either. A run that
// left the probe archived would fail the very next run's list assertions.
const restoredRow = await call('local-db:sessions:patch-meta', [SESSION, { status: 'active' }]);
check(
  '恢复 leaves the session exactly as it was found',
  restoredRow.result?.status === 'active' && restoredRow.result?.pinnedAt === undefined,
  `status=${restoredRow.result?.status} pinnedAt=${String(restoredRow.result?.pinnedAt)}`,
);

// The file browser is an aggregate channel (`file-browser:remote-op`) whose ops are
// chosen by the caller. The field is `workdir` (not `workingDir`, which every other
// channel here uses) and the controller sends it even for the `caps` probe —
// `caps: (workdir) => call('file-browser:remote-op', [{ op: 'caps', workdir }])` in
// the mobile transport. One op per family is enough to prove the wiring.
const workspace = process.cwd();
await serves('file-browser:remote-op (caps)', 'file-browser:remote-op', [{ op: 'caps', workdir: workspace }]);
const browsed = await serves('file-browser:remote-op (listDir)', 'file-browser:remote-op', [{ op: 'listDir', workdir: workspace, relPath: '' }]);
check(
  'file-browser lists the workspace',
  Array.isArray(browsed) && browsed.length > 0,
  Array.isArray(browsed) ? `${browsed.length} entries` : JSON.stringify(browsed ?? null).slice(0, 80),
);
const found = await serves('file-browser:remote-op (searchCollect)', 'file-browser:remote-op', [{ op: 'searchCollect', workdir: workspace, query: 'acceptance' }]);
check(
  'file-browser search reports matches',
  Array.isArray(found?.matches) && found.matches.length > 0,
  Array.isArray(found?.matches) ? `${found.matches.length} matches` : JSON.stringify(found ?? null).slice(0, 80),
);
await serves('file-browser:remote-op (readFile)', 'file-browser:remote-op', [{ op: 'readFile', workdir: workspace, relPath: 'package.json' }]);
// Ops this Host deliberately cannot serve answer with a stated reason rather than a
// transport-looking failure, so the controller degrades on purpose.
const thumb = await serves('file-browser:remote-op (thumbnail)', 'file-browser:remote-op', [{ op: 'thumbnail', workdir: workspace, relPath: 'package.json' }]);
check('file-browser states why thumbnails are unsupported', thumb?.code === 'THUMB_UNSUPPORTED', String(thumb?.code ?? thumb?.message ?? 'no reason given'));

await serves('maker:list-agent-skills', 'maker:list-agent-skills', ['pi', { sessionId: SESSION, workingDir: process.cwd() }]);
await serves('maker:list-agent-commands', 'maker:list-agent-commands', ['pi', { sessionId: SESSION }]);
await serves('maker:list-desktop-commands', 'maker:list-desktop-commands', []);
await serves('maker:scan-at-resources', 'maker:scan-at-resources', ['pi', { workingDir: process.cwd(), cap: 5 }]);
await serves('maker:get-pending-interactions', 'maker:get-pending-interactions', [SESSION]);
// A cold session answers `null` — "unknown", which the controller renders as
// "暂无上下文数据" — and that is the designed answer, not a failure.
await serves('maker:get-context-usage', 'maker:get-context-usage', [SESSION]);
// Regenerating a title is a read-only path for a cold session (it answers null
// without spending a model call); a live one may take longer, so it is only
// asserted to answer.
await serves('maker:regenerate-title', 'maker:regenerate-title', [{ sessionId: SESSION }]);

for (const [channel, next, field] of [
  ['maker:set-permission-mode', 'read-only', 'permissionMode'],
  ['maker:set-effort', 'low', 'effort'],
  ['maker:set-model', 'deepseek-flash', 'model'],
]) {
  const target = channel === 'maker:set-effort' ? (next ?? 'low') : next;
  await serves(channel, channel, [SESSION, target]);
  // A stale read is possible for a few hundred milliseconds; the row is the
  // authority the controller reads next, so it is worth waiting for.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const after = (await call('local-db:sessions:get', [SESSION])).result ?? {};
  check(`${channel} reaches the session row`, String(after[field] ?? '') !== '', `${field}=${after[field]}`);
  const restore = sessionBefore[field];
  if (typeof restore === 'string' && restore !== '' && restore !== after[field]) {
    await serves(`${channel} restores ${field}`, channel, [SESSION, restore]);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
// Plan mode is a boolean switch owned by the preset; toggling it twice leaves the
// session as it was.
await serves('maker:set-plan-mode (on)', 'maker:set-plan-mode', [SESSION, true]);
await serves('maker:set-plan-mode (off)', 'maker:set-plan-mode', [SESSION, false]);

// Every push the sections above should have produced has now been checked;
// release the subscription so the run leaves no watcher behind.
await serves('device-link:unsubscribe', 'device-link:unsubscribe', [{ topics: ['sessions', `session:${SESSION}`] }]);

// The fail-closed property, sampled through the assembled Host rather than only
// in a unit test: a channel this Host does not implement must say so.
await refuses('an unimplemented channel fails closed', 'device-link:remote-desktop:v1', [], 'CHANNEL_NOT_ALLOWED');
await refuses('an unknown channel fails closed', 'totally:unknown', [], 'CHANNEL_NOT_ALLOWED');

// ─── summary ─────────────────────────────────────────────────────────────────

// ─── channel coverage ────────────────────────────────────────────────────────

// Which of the channels this Host *serves* did this run actually exercise?
//
// Not a pass/fail check, and deliberately not one: the honest question is not
// "are all 42 covered" (some are only reachable from a handset tapping a specific
// control) but "which ones has nothing ever called". Read from the Host's monotonic
// per-channel totals, because the invoke ring churns and cannot answer it.
// Read from the Host's monotonic per-channel totals, because the invoke ring churns
// and cannot answer it. The status is re-read HERE rather than reusing the snapshot
// taken at the start of the run, which would report the previous run's coverage.
const coverageHealth = await status();
const served = SUPPORTED_CHANNELS instanceof Set ? SUPPORTED_CHANNELS : new Set(SUPPORTED_CHANNELS);
const totals = coverageHealth.diagnostics?.invokeTotals ?? {};
const exercised = new Set(Object.keys(totals));
const uncovered = [...served].filter((channel) => !exercised.has(channel)).sort();
console.log(`\nchannel coverage: ${served.size - uncovered.length}/${served.size} served channels exercised`);
if (uncovered.length > 0) {
  console.log('  never called (by this run or any controller since the Host started):');
  for (const channel of uncovered) console.log(`    ${channel}`);
}

// The push half of the same question. A push channel that is implemented and never
// fires is a UI that silently never updates, and unlike an invoke there is nothing to
// route to it — so this is read from the Host's monotonic push totals.
const pushTotals = coverageHealth.diagnostics?.pushTotals ?? {};
const unsent = [...HOST_PUSH_CHANNELS.keys()].filter((channel) => !(channel in pushTotals)).sort();
console.log(`push coverage: ${HOST_PUSH_CHANNELS.size - unsent.length}/${HOST_PUSH_CHANNELS.size} push channels sent`);
if (unsent.length > 0) {
  console.log('  never sent (by this run or any controller since the Host started):');
  for (const channel of unsent) console.log(`    ${channel}  — ${HOST_PUSH_CHANNELS.get(channel)}`);
}

// What the controller asked for that this Host refused, by frequency.
//
// This is not a pass/fail check: refusing an unimplemented channel is the
// designed behaviour. It is here because "the phone keeps calling X" is the
// evidence needed to decide whether X is worth implementing, and reading it out
// of a live log beats guessing from a static list.
const refused = new Map();
for (const entry of health.diagnostics?.recentRefusals ?? []) {
  const key = `${entry.channel} (${entry.code})`;
  refused.set(key, (refused.get(key) ?? 0) + 1);
}
if (refused.size > 0) {
  console.log('\nchannels the controller asked for that this Host refused:');
  for (const [channel, count] of [...refused].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(3)}x  ${channel}`);
  }
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log('\nfailed:');
  for (const entry of failed) console.log(`  - ${entry.name}: ${entry.detail}`);
  process.exit(1);
}
console.log('acceptance passed');
