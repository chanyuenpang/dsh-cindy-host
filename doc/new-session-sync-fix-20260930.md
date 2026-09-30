# New-session synchronization NOT_FOUND — 2026-09-30

## Evidence

After the desktop connection fixes, the real Host reports authenticated/connected and the user confirms existing running sessions synchronize. A newly created session `02df58ff-6ec6-43fd-bb74-b3c79e5d0efa` instead produced `[NOT_FOUND] No DSH session ...`.

- The ID has a real local session projection record, created at 2026-09-30 13:18:49 UTC, with a first user message recorded. No session data was deleted or recreated during diagnosis.
- Live refusal counters include `local-db:sessions:get` and `local-db:messages:view`. The user supplied the exact metadata NOT_FOUND message above; the bounded diagnostics window can evict individual earlier failures.
- Later **read-only** local selftest calls for that same ID return metadata successfully (active, 5 messages) and history successfully (4 history items). This proves the reported failure was not permanent absence. The reads do not create or resume a session and do not send a prompt.

## Phone contract

The handset preallocates an ID, mounts the screen/subscription, creates the DSH session, calls `local-db:sessions:get` **before the first enqueue**, then enqueues its initial message. Exact-ID probes also support idempotent creation retries. The normal full-sync guard does not prevent the independently mounted history-view hook from reading the preallocated ID before create finishes.

Relevant Cindy source: `apps/mobile/src/session/newSessionCreation.ts` (creation pipeline and exact-ID probe), `apps/mobile/app/sessions/[sessionId].tsx` (sync and independently mounted history view), `packages/maker-shared/src/historyViewController.ts` (initial refresh and unavailable fallback).

A real created blank session must be readable by ID; an unknown preallocated ID before successful create must remain NOT_FOUND. Never synthesize success from an arbitrary ID, disable subagent filtering, or globally convert history failures into empty success.

## Causes and changes

1. **Discovery was used as existence proof.** Router get searched the cached visible list; the source deliberately excludes blank drafts and subagents. An existing new blank session was therefore called missing. The real DSH `sessionQuery.observeSession(id, { projectionMode: 'all', signal })` contract can read a live or persisted identity without a listing preflight or Agent activation. The new exact read uses that contract, releases its lease, retains model/provider/effort/permission projections and creation metadata, excludes subagents/parented rows, and keeps archive/delete/pin flags. Only the explicit `SESSION_QUERY_SESSION_NOT_FOUND` code becomes absence; I/O/replay errors propagate.
2. **Pre-write list flights survived invalidation.** Clearing rowsCache did not clear/fence rowsRefresh, and the source had its own inFlightList. Create now invalidates both layers; old completions cannot overwrite the new cache. A legacy lookup without the exact port rechecks a cache miss instead of treating a stale page as absence.
3. **Failed history reads seeded a false empty cache.** ensureTranscript touched the transcript cache from finally even when the initial log read rejected. It now caches only successful seeds; a real empty transcript is still cacheable and a failed read remains retryable.

The discovery list continues to hide unprompted drafts. Exact-ID reads do not insert every draft into that list. Deleted/archived rows remain flagged, never revived by a get. No handset code changes are required.

## Verification

- New end-to-end seam/router/source regression file: `test/new-session-sync.test.js`, 9 tests passed (create→get→empty history before enqueue, exact observation disposal, unknown/subagent exclusions, applied selection metadata, both cache race layers, legacy miss recovery, actual Host flag projection).
- Transcript regression reproduces the previous false-empty cache before the fix, then verifies failed→successful retry, persistent unknown errors and legitimate empty caching.
- Full final suite: **714 passed, 1 skipped, 0 failed** (715 total), including review follow-ups for blank→titled transition and timestamp parity.
- Log: `G:\Projects\DSH-cindy-host\artifacts\desktop-runtime-inspect\new-session-tests-final.log`.
- Exact reads of an unnamed blank session no longer retain a negative title-cache entry for 60 seconds after its first prompt.

## Post-restart follow-up: creation prerequisite timeout

The user's next attempt reported `任务创建失败` / `invoke timeout`. Live diagnostics showed connected/authenticated, about 176 seconds uptime, phone subscription to draft ID `db4d802e-83bb-46ba-9d9b-5517f4089dbb`, **zero `maker:create-session` invokes**, and real listing TimeoutErrors at 13:48:14 UTC. Exact-ID selftest correctly returned NOT_FOUND for this uncreated draft. This is a separate pre-create failure, not proof that the create→get repair failed.

Confirmed blocking dependency: `device-link:subscribe` awaited `listSessions()` to announce turn state **even when subscribing only to `sessions` and no session ID needed a state announcement**. The handset pipeline awaits precisely that acknowledgement before sending create (`newSessionCreation.ts:911–917`). A slow cold listing therefore stalls creation before any create request reaches the Host. Three regressions failed against the deployed implementation: corpus-only subscription blocked on a deferred listing; targeted attachment performed a global list instead of an exact read; exact-read failure retried through the corpus rather than the runtime fallback.

Follow-up: sessions-only subscription now acknowledges without any corpus read; targeted session subscriptions use the exact-ID reader, preserving live/idle, input projection and history-repair pushes. Legacy sources without an exact read use the cheaper state listing. If an exact read fails, turn announcement uses the established runtime fallback instead of starting another global list. No timeout was merely increased; no unknown session was synthesized into existence. Post-reload handset validation is still required.

Follow-up validation: all 3 new regressions failed before the router change and passed afterward; focused suites 118/118 passed; full suite **717 passed, 1 skipped, 0 failed** (718 total), recorded in `G:\Projects\DSH-cindy-host\artifacts\desktop-runtime-inspect\subscribe-timeout-tests.log`. Only `src/cindy-channels.js` was deployed again, after backing up the installed file to `C:\Users\chany\.dsh\profiles\desktop\cindy-subscribe-fix-backup-20260930`. Source/installed SHA256 equality, syntax and diff whitespace checks passed. The agent did not restart the desktop or submit a real create/prompt; awaiting the user's restart and retry.

## Successful handset retry

The user confirmed `重试成功了`. Subsequent read-only Host diagnostics showed connected/authenticated, 1 create invoke and 1 enqueue invoke. Exact-ID get for the same draft `db4d802e-83bb-46ba-9d9b-5517f4089dbb` succeeded with 2 messages; recent history reads at 13:58 UTC succeeded. Only the older 13:48 listing timeout records remained in the bounded handler-error log. This confirms successful retry with preserved identity, not repeated cold-start latency or independent proof that the final router module reloaded. The user subsequently requested a serious performance comparison with Cindy's native implementation; that is follow-up work, not evidence that functional success establishes acceptable latency.

## Deployment boundary

Source is the migration worktree `G:\Projects\DSH-cindy-host-020`, not old main. Deployment includes only these changed runtime files, preserving the previous desktop settings/auth/client repair:

- `src/dsh-plugin.js`
- `src/dsh-session-source.js`
- `src/cindy-channels.js`
- `src/host.js`
- `src/dsh-message-fold.js`

All five runtime files were copied to the installed desktop package after backing up the originals to `C:\Users\chany\.dsh\profiles\desktop\cindy-sync-fix-backup-20260930`. Source/deployed SHA256 equality and `node --check` passed for each file. No process restart or plugin enable/disable was performed; the existing running module is not assumed to have reloaded. Tests use mocked services and sockets; they are not a claim of real post-reload handset acceptance. After the user restarts the desktop, verify a phone-created session can be opened immediately and its first message/history synchronizes without NOT_FOUND. Preserve existing session IDs and login credentials throughout.
