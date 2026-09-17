#!/usr/bin/env node
/**
 * Which invoke channels the phone calls, and what this Host does with each.
 *
 * The goal is "align the invoke channels with the reference host", and the honest
 * way to check that is mechanically: read the channel names out of the phone's own
 * transport, compare them with what this Host serves, and require every refusal to
 * be *classified* — either a family this project deliberately declines
 * (`CHANNEL_NOT_ALLOWED` is the protocol's answer, and the controller degrades), or
 * a channel somebody has to look at.
 *
 * Without this, "the phone shows nothing" and "we chose not to serve that" look
 * identical from the outside, and a real gap hides inside a long list of refusals.
 *
 * Usage:
 *   node tools/channel-audit.mjs [--cindy <path to the Cindy checkout>]
 *
 * Exits non-zero when an unclassified channel is found.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { SUPPORTED_CHANNELS } from '../src/cindy-channels.js';
import { HOST_PUSH_CHANNELS } from '../src/host-push-channels.js';

const args = process.argv.slice(2);
const cindyIndex = args.indexOf('--cindy');
const CINDY = cindyIndex === -1 ? 'G:/Projects/Cindy' : args[cindyIndex + 1];
const TRANSPORT = path.join(CINDY, 'apps/mobile/src/device-link/mobileMakerTransport.ts');
const ALLOWLIST = path.join(CINDY, 'packages/device-link/src/allowlist.ts');
const INVOKE_POLICY = path.join(CINDY, 'packages/device-link/src/invokePolicy.ts');

/**
 * Channel families this project declines on purpose, with the rule that says so.
 *
 * Each entry is a prefix or exact name plus the reason it is not served. A refusal
 * that matches none of these is a question, not a decision.
 *
 * `candidate: true` marks a refusal that is *decided for now* but that this Host
 * could plausibly serve — it is listed separately so the next round can pick it up
 * rather than rediscover it.
 */
const DECLINED = [
  { match: (channel) => channel.startsWith('maker:schedule:') || channel.startsWith('maker:project-automation:'), why: 'schedule family — plan rule' },
  { match: (channel) => channel.startsWith('device-link:remote-desktop') || channel.startsWith('remote-desktop'), why: 'remote-desktop family — plan rule' },
  { match: (channel) => channel.startsWith('device-link:media:') || channel.startsWith('media:'), why: 'media pipeline — plan rule' },
  { match: (channel) => channel.startsWith('voice:') || channel.startsWith('device-link:voice:'), why: 'voice family — plan rule' },
  { match: (channel) => /orca/i.test(channel), why: 'orca family — plan rule' },
  { match: (channel) => /worktree/i.test(channel), why: 'worktree family — plan rule' },
  { match: (channel) => channel.startsWith('maker:usage:') || channel === 'local-db:messages:estimatedSessionValue', why: 'usage/account reads — plan rule' },
  { match: (channel) => channel.startsWith('maker:learn') || channel.startsWith('learn:'), why: 'learn family — plan rule' },
  { match: (channel) => channel.startsWith('maker:plugins'), why: 'plugin management — plan rule' },
  { match: (channel) => /bot/i.test(channel), why: 'bots family — plan rule' },
  {
    match: (channel) => channel.startsWith('maker:provider:list'),
    why: 'deliberate: a successful empty catalog hides the model list (defect #18). The client has a designed path for the refusal — `useDeviceProviders`: "仅结构化确认旧端没有 provider:list 时允许 capabilities-only 回退" — so refusing is what makes its capability-only fallback legitimate rather than a guess',
  },
  { match: (channel) => channel.startsWith('maker:set-fast-mode'), why: 'deliberate: every model declares supportsFastMode:false' },
  { match: (channel) => channel.startsWith('maker:set-session-model-pref') || channel.startsWith('maker:apply-new-maker-draft-pref'), why: 'desktop-only write-through tunnels; the phone degrades on refusal' },
  { match: (channel) => channel.startsWith('maker:api-key:present'), why: 'credential probing — not exposed by this Host' },
  { match: (channel) => channel.startsWith('maker:remote-resources:manifest'), why: 'desktop remote-resource inventory — not composed here' },
  {
    match: (channel) => channel.startsWith('sidebar-settings:'),
    why: 'desktop sidebar preferences. The client has a designed path for the refusal — `SyncedProjectOrderSnapshot.available === false` means "被控端没有这个接口，控制端应回退到自己的混排" — and ships `UNAVAILABLE_PROJECT_ORDER_SNAPSHOT` for it',
  },
  {
    match: (channel) => channel.startsWith('local-db:history:') || channel.startsWith('local-db:messages:view') || channel.startsWith('local-db:messages:around'),
    why: 'the newer history view; the paged transcript this Host does serve is the fallback, and the client has a designed path for that — `isHistoryViewUnavailable` matches exactly `CHANNEL_NOT_ALLOWED | UNSUPPORTED_CAPABILITY | not registered | No handler` (maker-shared/historyView.ts)',
  },
  { match: (channel) => channel.startsWith('local-db:conversations:search') || channel.startsWith('local-db:recent-workdirs'), why: 'reads this Host does not implement (search/workdir history)' },
  {
    // Ahead of the general `local-db:sessions:` rule because this one is not a read:
    // both clients call it when the user dismisses an "this session was interrupted"
    // banner, and the reason for refusing is about *state this Host does not track*.
    match: (channel) => channel.startsWith('local-db:sessions:interrupted-pending') || channel.startsWith('local-db:sessions:ack-interrupted'),
    why: 'the interrupted-turn attention flag and its acknowledgement — this Host tracks no such flag: DSH repairs an interrupted turn itself on resume (writing the turn/end and the synthetic tool result, both already visible in the transcript), so there is nothing here to acknowledge',
  },
  { match: (channel) => channel.startsWith('local-db:sessions:'), why: 'only list/get/patch-meta are implemented; other session reads are not' },
  { match: (channel) => channel.startsWith('local-db:messages:work-details'), why: 'the history view\'s detail read; refusing it keeps the phone on the paged transcript this Host does serve' },
  { match: (channel) => channel.startsWith('local-db:messages:dismiss-error'), why: 'a client-side error affordance with no DSH counterpart' },
  { match: (channel) => channel.startsWith('maker:goal:') && !['maker:goal:get-status', 'maker:goal:set', 'maker:goal:pause', 'maker:goal:resume', 'maker:goal:clear', 'maker:goal:update'].includes(channel), why: 'goal reads/writes beyond the implemented set' },
  { match: (channel) => channel.startsWith('maker:rewind') || channel.startsWith('maker:fork'), why: 'rewind/fork family — plan rule' },
  { match: (channel) => channel.startsWith('maker:subagent') || channel.startsWith('maker:get-session-tree') || channel.startsWith('maker:navigate-session-tree'), why: 'subagent/session-tree family — plan rule' },
  { match: (channel) => channel.startsWith('maker:switch-session-agent') || channel.startsWith('maker:get-session-agent-switch-intent'), why: 'deliberate: capabilities report supportsSessionAgentSwitch:false' },
  { match: (channel) => channel.startsWith('maker:close-session'), why: 'DSH sessions are neither closed nor archived (patch-meta already refuses to pretend)' },
  { match: (channel) => channel.startsWith('maker:message:delete'), why: 'the session log is append-only; there is nothing to delete' },
  { match: (channel) => channel.startsWith('maker:set-extra-dirs'), why: 'extra working directories are not part of this Host\'s scope' },
  {
    // The precise reason, measured rather than assumed: the client's error banner is a
    // *trailing un-dismissed `role='error'` message row* (`CCAgentSessionView`: "会话尾部
    // 停在未忽略的 role='error' 行"), and this Host's fold emits no such row — so the
    // retry/dismiss affordances cannot appear at all. DSH's own turn/end reasons observed
    // across this deployment's session logs are completed/interrupted/aborted/blocked;
    // there is no failure reason to translate yet.
    match: (channel) => channel.startsWith('maker:input:retry-last-error') || channel.startsWith('maker:input:clear-error') || channel.startsWith('local-db:messages:dismiss-error'),
    why: 'the failed-turn affordances: the client offers retry/dismiss only for a trailing un-dismissed `role=\'error\'` row, and this Host emits none — DSH\'s observed turn/end reasons are completed/interrupted/aborted/blocked, so there is no failure state to surface',
    candidate: 'would need two halves: map a failed turn to a trailing `role: \'error\'` row, and serve retry as a re-send of the last user prompt (or the shared continue prompt when the failed turn already produced output)',
  },
  { match: (channel) => channel.startsWith('maker:input:compact'), why: 'the Claude-Code-specific compact; the phone uses maker:compact-session for a pi session' },
  { match: (channel) => channel.startsWith('maker:get-new-maker-defaults'), why: 'the phone reads capabilities and the session row instead (its own type says so)' },
  { match: (channel) => channel.startsWith('notification:'), why: 'local notification state; the phone owns it' },
  {
    match: (channel) => channel.startsWith('fs:mkdir-p'),
    why: 'not a gap: the phone declares `mkdirP` in its transport and has no call site for it, so nothing reaches this channel; `ctx.fs` also has no create-directory API',
  },
  {
    match: (channel) => channel.startsWith('maker:compact-session'),
    why: 'blocked by the phone\'s own budget: it is absent from MOBILE_INVOKE_TIMEOUT_OVERRIDES_MS, so it gets the 15s mobile default, while a compaction is one LLM summarization call (the reference `/compact` command runs it with no such bound). Serving it would time out on the phone while the Host kept compacting — a failure the user sees and a history change they do not.',
    candidate: 'waiting on a Cindy-side timeout entry, not on Host work',
  },

  // ── the desktop controller's vocabulary ────────────────────────────────────────
  //
  // Read from device-link's shared allowlist rather than from the phone's call sites.
  // The desktop app is a controller too — and the one actually driving this Host in
  // practice — so these channels are on the wire whether or not the phone names them.
  { match: (channel) => channel === 'desktop-cmd:run', why: 'runs a command in the *controlling* desktop\'s own registry (/learn and friends); this Host owns no such registry' },
  { match: (channel) => channel.startsWith('device-link:telegram:'), why: 'Telegram integration — plan rule' },
  { match: (channel) => channel.startsWith('fs:resolve-path'), why: 'the desktop\'s @-mention path resolution (relPath → absolute); the phone\'s @ palette resolves through maker:scan-at-resources, which this Host serves' },
  { match: (channel) => channel.startsWith('git-context:') || channel.startsWith('git-review:'), why: 'git context/review family — plan rule' },
  { match: (channel) => channel.startsWith('local-db:subagent-runs:'), why: 'subagent runs family — plan rule' },
  { match: (channel) => channel === 'maker:abort-session', why: 'the same effect this Host serves as maker:input:stop, which is the name the phone calls; nothing calls this one' },
  { match: (channel) => channel.startsWith('maker:agent:'), why: 'the controlled desktop\'s agent runtime (CLI install/version/status); DSH runs its agent in-process, so there is no such runtime to report' },
  { match: (channel) => channel === 'maker:any-session-in-turn', why: 'maker:session-in-turn is served for the per-session question and maker:list-active answers it for the whole list; nothing names this one' },
  { match: (channel) => channel === 'maker:auth:get-state' || channel === 'maker:claude-session-route:get', why: 'the vendor-CLI auth/routing state of a desktop; this Host routes through its own model catalog' },
  { match: (channel) => channel === 'maker:collaboration-settings:get', why: 'desktop collaboration settings — not composed here' },
  { match: (channel) => channel === 'maker:generate-title', why: 'the new-draft title path (`NewMakerDraftRoute`); the session title path this Host serves is maker:regenerate-title, which is what the desktop rename box actually calls' },
  { match: (channel) => channel === 'maker:get-workflow-progress', why: 'workflow runs — plan rule' },
  { match: (channel) => channel === 'maker:input:session-reference-capability', why: 'probes whether the host can consume session references; refusing it is what makes the controller refuse the send explicitly instead of silently dropping the reference' },
  { match: (channel) => channel === 'maker:list-customizations', why: 'desktop customization inventory (agents/commands/skills) — not composed here' },
  { match: (channel) => channel.startsWith('maker:memory:'), why: 'memory family — plan rule' },
  { match: (channel) => channel === 'maker:persist-turn-error-deferred', why: 'desktop turn-error bookkeeping with no DSH counterpart' },
  { match: (channel) => channel === 'maker:pi-subagent:control', why: 'subagent control — plan rule' },
  { match: (channel) => channel === 'maker:session-background-tasks:list', why: 'background-task inventory — plan rule' },
  { match: (channel) => channel === 'maker:set-thinking-enabled', why: 'a display toggle for thinking blocks; this Host emits reasoning rows and the controller renders them as it likes' },
  { match: (channel) => channel === 'maker:set-writable-dirs', why: 'the file sandbox\'s writable roots are DSH-owned policy, not something a controller sets remotely' },
  { match: (channel) => channel === 'maker:steer', why: 'the same effect this Host serves as maker:input:steer, which is the name the phone calls; nothing calls this one' },
  { match: (channel) => channel === 'maker:team:end' || channel.startsWith('maker:worker:'), why: 'worker/team family — plan rule' },
];

/**
 * Served channels whose handler can take longer than a plain read.
 *
 * A channel missing from the phone's timeout table gets the 15s mobile default
 * (`invokePolicy.ts`: "mobile 把默认请求超时从 30s 收紧到 15s"). That is fine for a
 * read and not obviously fine for a resume, so the Host's own slow channels are
 * checked against the table instead of assumed to fit.
 */
const SLOW_CHANNELS = new Map([
  ['maker:create-session', 'creates a DSH session'],
  ['maker:set-plan-mode', 'resolves (and may resume) the session agent'],
  ['maker:set-permission-mode', 'resolves (and may resume) the session agent'],
  ['maker:goal:set', 'resolves the agent, then mutates the goal'],
  ['maker:goal:pause', 'resolves the agent, then mutates the goal'],
  ['maker:goal:resume', 'resolves the agent, then mutates the goal'],
  ['maker:goal:clear', 'resolves the agent, then mutates the goal'],
  ['maker:goal:update', 'resolves the agent, then mutates the goal'],
  ['maker:send', 'awaits prompt acceptance'],
  ['maker:input:enqueue', 'awaits prompt acceptance'],
  ['maker:input:steer', 'awaits prompt acceptance'],
  ['local-db:messages:list', 'folds a transcript'],
  ['file-browser:remote-op', 'may walk the work directory'],
  ['maker:get-context-usage', 'measures the live session'],
]);

/**
 * The phone's per-channel timeout overrides, read from Cindy's policy file.
 *
 * Both tables live in one file; membership is what matters here, not which table.
 */
function mobileTimeoutOverrides(source) {
  const overrides = new Map();
  for (const match of source.matchAll(/'([a-z0-9-]+:[^']+)':\s*([\d_]+)/g)) {
    overrides.set(match[1], Number(match[2].replaceAll('_', '')));
  }
  return overrides;
}

/** Recursively list files under `root` with one of `extensions`. */
function listFiles(root, extensions) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'dist') continue;
        walk(full);
      } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/** The channels the phone asks for by literal name. */
function channelsCalledByPhone(source) {
  const found = new Map();
  for (const match of source.matchAll(/\bcall\(\s*'([^']+)'/g)) found.set(match[1], (found.get(match[1]) ?? 0) + 1);
  return found;
}

/**
 * The channels a *desktop* controller asks a remote host for.
 *
 * The desktop reaches this Host through exactly the same device-link channel as the
 * phone, but its call sites live in a different shape: a `t('<channel>')` table plus
 * explicit `invokeRemote(deviceId, '<channel>'` calls. Counting only the phone is how
 * `maker:session-in-turn` — the desktop's stall watchdog, and a real gap — stayed
 * invisible until it was found by hand.
 * @param sources - renderer sources to scan.
 * @returns channel → how many call sites name it.
 */
function channelsCalledByDesktop(sources) {
  const found = new Map();
  const bump = (channel) => found.set(channel, (found.get(channel) ?? 0) + 1);
  for (const source of sources) {
    for (const match of source.matchAll(/\bt\(\s*'([a-z][a-z0-9-]*:[^']+)'/g)) bump(match[1]);
    for (const match of source.matchAll(/invokeRemote\(\s*[^,]+,\s*'([^']+)'/g)) bump(match[1]);
  }
  return found;
}

/**
 * Every channel `device-link` permits a controller to invoke on a remote host.
 *
 * The phone's `call()` sites are only *one* controller's vocabulary. The desktop app
 * is a controller too — and the one actually driving this Host — and its channels are
 * chosen at the wire level by this shared allowlist: anything absent from it cannot
 * cross device-link at all, whatever a client names. Auditing the phone alone left
 * whole families (`maker:worker:*`, `maker:team:*`, `git-context:*`, …) unseen, so a
 * refusal there would have been unclassified without anyone noticing.
 *
 * The file is parsed by the ranges that hold real entries — the two arrays plus the
 * explicit set — rather than by every quoted string, because this file's own comments
 * discuss channels precisely in order to say they must never be allowed.
 * @param text - `allowlist.ts` source.
 * @returns channel name → the family label for the report.
 */
function remoteInvokeAllowlist(text) {
  const lines = text.split(/\r?\n/);
  const found = new Set();
  const add = (block) => {
    for (const match of block.matchAll(/'([a-z][a-z0-9-]*:[a-z0-9:._-]+)'/g)) found.add(match[1]);
  };
  // The `DL_*_CHANNEL` constants: the value sometimes sits on the following line.
  for (let index = 0; index < lines.length; index += 1) {
    if (!/export const DL_[A-Z0-9_]*CHANNEL/.test(lines[index])) continue;
    add(`${lines[index]}\n${lines[index + 1] ?? ''}`);
  }
  // The two arrays `REMOTE_INVOKE_ALLOWLIST` spreads.
  for (const name of ['CORE_INVOKE_CHANNELS', 'EXTENDED_INVOKE_CHANNELS']) {
    const [from, to] = arrayRange(lines, name);
    add(lines.slice(from - 1, to).join('\n'));
  }
  // Its one explicit entry. The file's `PUSH_FORWARD_ALLOWLIST` is deliberately NOT
  // read here: those are push channels, and the push half of this report classifies
  // them against their own list.
  found.add('device-link:remote-desktop:v1');
  return found;
}

/** The inclusive line range of one `const NAME: readonly string[] = [ … ];` array. */
function arrayRange(lines, name) {
  const start = lines.findIndex((line) => line.includes(`const ${name}`));
  if (start === -1) return [1, 1];
  const end = lines.findIndex((line, index) => index > start && /^\];/.test(line));
  return [start + 1, end === -1 ? lines.length : end + 1];
}

const source = readFileSync(TRANSPORT, 'utf8');
const called = channelsCalledByPhone(source);
// The desktop's own remote-invoke sites, read from the renderer that holds them.
const rendererFiles = listFiles(path.join(CINDY, 'apps/desktop/src/renderer'), ['.ts', '.tsx']);
const calledByDesktop = channelsCalledByDesktop(rendererFiles.map((file) => readFileSync(file, 'utf8')));
for (const [channel, count] of calledByDesktop) called.set(channel, (called.get(channel) ?? 0) + count);
const allowlisted = remoteInvokeAllowlist(readFileSync(ALLOWLIST, 'utf8'));
const served = new Set(SUPPORTED_CHANNELS);

// The union of what a controller may ask for and what the phone names. A channel in
// both is listed once; a phone-only channel is still worth seeing, because it means
// the two sides disagree about the wire.
const vocabulary = [...new Set([...allowlisted, ...called.keys()])];
const rows = [];
for (const channel of vocabulary.sort()) {
  if (served.has(channel)) {
    rows.push({ channel, count: called.get(channel) ?? 0, verdict: 'served' });
    continue;
  }
  const declined = DECLINED.find((entry) => entry.match(channel));
  rows.push({
    channel,
    count: called.get(channel) ?? 0,
    verdict: declined === undefined ? 'UNCLASSIFIED' : 'declined',
    why: declined?.why ?? '',
    // Carried through, or the `candidate:` note a rule records is silently dropped and
    // the "pick one up next" list renders empty forever.
    ...(declined?.candidate === undefined ? {} : { candidate: declined.candidate }),
  });
}

const serveds = rows.filter((row) => row.verdict === 'served');
const declined = rows.filter((row) => row.verdict === 'declined');
const open = rows.filter((row) => row.verdict === 'UNCLASSIFIED');
const candidates = declined.filter((row) => row.candidate !== undefined);
// Declined channels a client actually calls. This is the shortlist that decides what to
// serve next: a refusal nobody reaches costs nothing, while one a live controller calls
// is a feature that visibly does not work — which is exactly how the desktop's stall
// watchdog (`maker:session-in-turn`) was found.
const calledButDeclined = declined
  .filter((row) => row.count > 0)
  .sort((a, b) => b.count - a.count || a.channel.localeCompare(b.channel));

console.log(`device-link allowlist: ${ALLOWLIST}`);
console.log(`desktop renderer: ${rendererFiles.length} files`);
console.log(`phone transport: ${TRANSPORT}`);
console.log(`channels a controller may name: ${vocabulary.length}`);
console.log(`  call sites seen: ${[...called.values()].reduce((a, b) => a + b, 0)}  (phone + desktop renderer)`);
console.log(`  served:      ${serveds.length}`);
console.log(`  declined:    ${declined.length}`);
console.log(`  unclassified:${open.length}`);
console.log('');
console.log('served:');
for (const row of serveds) console.log(`  ${row.channel}`);
if (calledButDeclined.length > 0) {
  console.log('');
  console.log('declined, but a controller calls it (ranked — the shortlist for what to serve next):');
  for (const row of calledButDeclined) console.log(`  ${String(row.count).padStart(3)}x  ${row.channel}  — ${row.why}`);
}
if (declined.length > 0) {
  console.log('');
  console.log('declined on purpose:');
  for (const row of declined) console.log(`  ${row.channel}  — ${row.why}`);
}
if (candidates.length > 0) {
  console.log('');
  console.log('decided for now, but serveable — pick one up next:');
  for (const row of candidates) console.log(`  ${row.channel}  — ${row.candidate}`);
}
if (open.length > 0) {
  console.log('');
  console.log('UNCLASSIFIED — the phone asks and nobody decided:');
  for (const row of open) console.log(`  ${row.channel}  (${row.count} call sites)`);
  process.exitCode = 1;
}

// ── the push half ──────────────────────────────────────────────────────────────
//
// The same question in the other direction: every push channel the phone handles
// must be either one this Host sends, or one it does not send *for a reason*. An
// unclassified push is a UI that silently never updates.
//
// The "this Host sends" list is imported rather than repeated here, because
// `tools/acceptance.mjs` reports coverage against the same list — one authority, so a
// channel added to the Host cannot be audited by one tool and forgotten by the other.
// See `src/host-push-channels.js`.

/**
 * Push channels the phone handles that this Host does not send, and why not.
 *
 * "No fact to report" is the honest reason for most of them: DSH has no deletion,
 * no closed sessions, no provider registry, and a roster of exactly one harness.
 */
const DECLINED_PUSH = [
  { match: (channel) => channel.startsWith('usage:'), why: 'usage/account reads — plan rule' },
  { match: (channel) => /bot/.test(channel), why: 'bots family — plan rule' },
  { match: (channel) => channel.startsWith('maker:schedule'), why: 'schedule family — plan rule' },
  { match: (channel) => /worktree/.test(channel), why: 'worktree family — plan rule' },
  { match: (channel) => channel.startsWith('maker:new-maker-draft'), why: 'desktop new-session preferences; this Host keeps no such draft state' },
  { match: (channel) => channel.startsWith('maker:session-model-pref'), why: 'desktop write-through preference; this Host stores the selection on the session instead' },
  { match: (channel) => channel.startsWith('local-db:messages:deleted'), why: 'the session log is append-only: there is no deletion to announce' },
  { match: (channel) => channel.startsWith('local-db:session:error-persisted'), why: 'there is no separate error-persistence path; failures travel as maker:event plus the message rows' },
  { match: (channel) => channel.startsWith('maker:status-changed'), why: 'DSH sessions are never `closed`, which is the only state that push retires' },
  { match: (channel) => channel.startsWith('maker:provider:changed'), why: 'this Host exposes a model catalog, not a provider registry (maker:provider:list is refused for the same reason)' },
  { match: (channel) => channel.startsWith('maker:agents:changed'), why: 'the roster is exactly one harness (`pi`) and never changes, so there is nothing to announce' },
  { match: (channel) => channel.startsWith('sidebar-settings:'), why: 'desktop sidebar ordering; the phone keeps its own' },
  { match: (channel) => channel.startsWith('maker:remote-resources'), why: 'desktop remote-resource inventory — not composed here' },
  { match: (channel) => channel.startsWith('file-browser:') || channel.startsWith('maker:file-browser:'), why: 'no file-watch events are produced here' },
  { match: (channel) => channel.startsWith('device-link:voice'), why: 'voice family — plan rule' },
  { match: (channel) => channel.startsWith('maker:history-view-changed'), why: 'the history view it invalidates is the one this Host refuses, so the phone pages the transcript instead' },
  { match: (channel) => channel.startsWith('maker:event:batch'), why: 'batching is an optional transport optimization behind a capability this Host does not advertise; it sends each event unbatched instead' },
  { match: (channel) => channel.startsWith('maker:session-sync'), why: 'a desktop bulk-sync frame; this Host sends per-event pushes plus an authoritative snapshot when a controller attaches' },
];

/**
 * Push channel names the phone references by constant, resolved to their values.
 *
 * Without this the report would carry seven `<CONSTANT>` rows and claim to be
 * complete while quietly not checking them — including the one constant that names a
 * channel this Host *does* send.
 */
const PUSH_CHANNEL_CONSTANTS = new Map([
  ['SESSION_ACTIVITY_CHANNEL', 'local-db:sessions:activity'],
  ['SESSION_SYNC_CHANNEL', 'maker:session-sync'],
  ['MAKER_EVENT_BATCH_CHANNEL', 'maker:event:batch'],
  ['REMOTE_RESOURCE_CHANGED_CHANNEL', 'maker:remote-resources:changed'],
  ['SIDEBAR_PROJECT_ORDER_CHANGED_CHANNEL', 'sidebar-settings:project-order-changed'],
  ['FILE_BROWSER_EVENT_CHANNEL', 'maker:file-browser:event'],
  ['DEVICE_LINK_VOICE_DICTIONARY_SNAPSHOT_CHANNEL', 'device-link:voice:dictionary-snapshot'],
]);

/** Push channel names a mobile source handles by comparing a channel string. */
function pushChannelsHandledByPhone(...sources) {
  const found = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/(?:push\.)?channel === '([^']+)'/g)) found.add(match[1]);
    for (const match of source.matchAll(/(?:push\.)?channel === ([A-Z][A-Z0-9_]+)/g)) {
      found.add(PUSH_CHANNEL_CONSTANTS.get(match[1]) ?? `<${match[1]}>`);
    }
  }
  return found;
}

try {
  const storeSource = readFileSync(path.join(CINDY, 'apps/mobile/src/session/remoteSessionStore.ts'), 'utf8');
  const contextSource = readFileSync(path.join(CINDY, 'apps/mobile/src/device-link/DeviceLinkContext.tsx'), 'utf8');
  const handled = [...pushChannelsHandledByPhone(storeSource, contextSource)].sort();
  const sent = handled.filter((channel) => HOST_PUSH_CHANNELS.has(channel));
  const constantRefs = handled.filter((channel) => channel.startsWith('<'));
  const named = handled.filter((channel) => !channel.startsWith('<') && !HOST_PUSH_CHANNELS.has(channel));
  const reasoned = named.map((channel) => ({ channel, why: DECLINED_PUSH.find((entry) => entry.match(channel))?.why }));
  const unclassifiedPush = reasoned.filter((row) => row.why === undefined);

  console.log('');
  console.log('push channels the phone handles:');
  console.log(`  this Host sends: ${sent.length}`);
  console.log(`  not sent, with a reason: ${reasoned.length - unclassifiedPush.length}`);
  console.log(`  by constant reference (value in a shared package): ${constantRefs.length}`);
  console.log(`  unclassified: ${unclassifiedPush.length}`);
  for (const channel of sent) console.log(`  SENT     ${channel}  — ${HOST_PUSH_CHANNELS.get(channel)}`);
  for (const row of reasoned) {
    console.log(`  ${row.why === undefined ? 'UNKNOWN ' : 'NOT-SENT'} ${row.channel}  — ${row.why ?? 'nobody decided'}`);
  }
  for (const channel of constantRefs) console.log(`  CONST    ${channel}`);
  if (unclassifiedPush.length > 0) process.exitCode = 1;
} catch {
  console.log('');
  console.log('push audit skipped: mobile sources not found');
}
// The other direction: a channel this Host serves, whose handler can take longer
// than a plain read, and that the phone will abandon after its 15s default.
try {
  const policy = readFileSync(INVOKE_POLICY, 'utf8');
  const overrides = mobileTimeoutOverrides(policy);
  const bare = serveds
    .filter((row) => SLOW_CHANNELS.has(row.channel) && !overrides.has(row.channel))
    .map((row) => row.channel);
  console.log('');
  console.log(`slow channels with no phone-side timeout override (15s default): ${bare.length}`);
  for (const channel of bare) console.log(`  ${channel}  — ${SLOW_CHANNELS.get(channel)}`);
  if (bare.length > 0) console.log('  (a resume that legitimately takes longer than 15s is a request the phone drops)');
} catch {
  // Without Cindy's policy file this half cannot be checked; the classification
  // above still stands.
  console.log('');
  console.log('timeout audit skipped: Cindy invokePolicy.ts not found');
}
