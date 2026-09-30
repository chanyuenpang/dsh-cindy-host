# Host performance: native Cindy comparison and implementation

## Scope and evidence boundary

The earlier functional migration is complete: the user confirmed successful new-session retry. This separate plan addresses latency, not login or session-data recovery. No real create/prompt, credential reset, data deletion or process restart was performed by the agent.

Initial read-only loopback measurements on the running desktop (short session, warm caches):

| Channel | Samples |
| --- | --- |
| sessions:list | 38 / 7 / 18 ms |
| sessions:get | 3 / 1 / 1 ms |
| messages:view | 2 / 1 / 2 ms |
| input:get-projection | 1 / 1 ms |
| maker:list-active | **1757 / 3642 ms** |

A subsequent **pre-deployment** active-only probe measured 9770 / 8394 / 7578 ms while full regression tests were also running. Different load conditions mean these samples must not be mixed into a claimed speedup. Neither set measures relay/mobile round-trip latency, long histories, or cold startup.

Evidence: [initial samples](<G:/Projects/DSH-cindy-host/artifacts/desktop-runtime-inspect/performance-baseline-20260930.json>), [loaded pre-deployment samples](<G:/Projects/DSH-cindy-host/artifacts/desktop-runtime-inspect/performance-active-predeploy.json>).

## Comparison with native Cindy

- [Native subscription/dispatch](<G:/Projects/Cindy/apps/desktop/src/main/device-link/dispatch.ts#L3449-L3533>) updates subscription state and stages replay without waiting for a full corpus listing. Independent invokes do not share a global execution lock. Our existing Host is also concurrent; no imaginary global mutex was added or removed.
- [Native session queries](<G:/Projects/Cindy/apps/desktop/src/main/localDb/ipc/sessionQueries.ts#L139-L158>) limit selected IDs first and reuse persisted summary/count/preview projections. Exact get remains authoritative and is not served from a settled stale cache ([invoke policy](<G:/Projects/Cindy/packages/device-link/src/invokePolicy.ts#L145-L155>)). SQL indexes are evidence of architecture, not a proposal to add a second database to DSH.
- [Mobile device page](<G:/Projects/Cindy/apps/mobile/app/devices/index.tsx#L738-L797>) reads list and active in parallel but commits the combined result after both settle. A fast warm list cannot hide a slow active request. Existing conversation screens instead progressively commit some reads; not every mobile operation is serial.
- [Native history reader](<G:/Projects/Cindy/apps/desktop/src/main/localDb/ipc/historyViewReader.ts>) performs bounded cursor scans with complete-group and clear/rewind checks. This patch does not claim to reproduce that paging architecture or eliminate all long-history grouping CPU.

## Changes

### 1. Read authoritative live running state, not persisted discovery

The old active poll always called `source.listSessionStates → listItems → sessionController.list`, which queries the entire logical persisted corpus. Existing list singleflight only shared overlapping calls; sequential polls each paid again. Normal session-list SWR masked this cost on a different channel.

Verified current DSH Inspect contracts: `agents.list/get`, `sessions.get`, and `sessionProjections.snapshot(session, keys)`. Packaged [controller summary](<G:/Projects/DSH-cindy-host/artifacts/desktop-runtime-inspect/dsh-api-session-controller-index.js#L1870-L1905>) derives running from live Agent status; cold persisted summaries cannot be running.

The new [live reader](<../src/dsh-active-sessions.js>) enumerates the live registry, checks exact Agent/Session identity, filters subagents/parented/blank sessions, and reads current `sessionListMetadata` only for eligible running roots. It uses no running-state TTL, corpus read or log snapshot. Projection selection narrows output; missing in-memory cells may still materialize other registered units, so this is not a claim of zero CPU cost.

A successful empty registry is authoritative. The targeted watchdog receives explicit `running:false` when its ID is absent, preventing a stale push cache from resurrecting a disposed Agent. Archive/delete filtering remains at the Host/router boundary. Missing APIs or actual read failures retain the legacy fallback instead of inventing no running sessions.

Diagnostics now include `activeStateReads`, `activeStateFallbacks`, and `lastActiveStateError` under `listing`. These also distinguish a newly loaded module from a merely updated installation.

### 2. Reuse exact header metadata

The exact-ID observation already supplies immutable `createdAt` and `cwd`. Previously `projectItems` nevertheless asked `metaFor`, whose reader scanned every session header. Complete authoritative header fields now seed the metadata cache before that fallback. Legacy summaries missing fields retain their old metadata reader. Title/model/provider/effort/permission semantics are unchanged; exact observations are not replaced with a stale result cache.

### 3. Share concurrent transcript initialization

A per-session Promise flight replaces the old Set-only bookkeeping. Concurrent count/view/page cold reads share one full replay. Success/rejection releases the flight; a failed read never caches empty history. Live events dirty the owning flight; explicit invalidation detaches it so subsequent reads use a new generation. Old completion cannot cache over a newer generation or clear its dirty/flight state. Different sessions remain independent.

## Deterministic before/after work counts

[Probe script](<../tools/performance-path-probe.mjs>) imports the pre-deployment installed implementation and migration implementation with identical injected fixtures. These are **operation counts, not live latency estimates**:

| Scenario | Before | After |
| --- | ---: | ---: |
| 5 sequential active polls: corpus reads | 5 | 0 |
| 2 concurrent cold exact gets: extra metadata corpus reads | 2 | 0 |
| 3 concurrent transcript surfaces: complete log seeds | 3 | 1 |

[Recorded probe output](<G:/Projects/DSH-cindy-host/artifacts/desktop-runtime-inspect/performance-work-counts.json>).

## Verification and deployment

- Added 8 live-reader tests, 5 plugin/source/Host integration tests and 10 transcript concurrency/invalidation tests.
- Focused integration suites: 188 passed.
- Final full suite: **740 passed, 1 skipped, 0 failed (741 total)**. [Full log](<G:/Projects/DSH-cindy-host/artifacts/desktop-runtime-inspect/performance-tests-final.log>).
- Independent read-only review found no blocking regression. Retained limits: legacy fallback may still scan/stale-serve; live projection first-touch may cost CPU; long-history grouping/image hydration and mobile network latency are not eliminated by this patch.
- Six runtime files copied into the installed desktop package, with each source/installed SHA256 and syntax check verified. Original five files were backed up; the new helper's prior absence is recorded in [backup manifest](<C:/Users/chany/.dsh/profiles/desktop/cindy-performance-fix-backup-20260930/manifest.json>).
- Final read-only status: still connected/authenticated, but **`activeStateReads` is absent**, so the running module has **not** been verified to load the performance patch. No automatic restart was attempted.

## Post-restart live verification

The user confirmed a full restart. Read-only status at about 146 seconds uptime reports connected/authenticated and the new diagnostics fields, proving the performance module is now loaded. During the measurement, `activeStateReads` increased from 1 to 9, `activeStateFallbacks` stayed 0, `staleServes` stayed 0, and `handlerErrors` remained empty.

| Channel | Post-restart samples |
| --- | --- |
| maker:list-active | **10 / 2 / 1 / 1 / 1 ms** |
| maker:session-in-turn (known completed session) | 1 / 1 / 1 ms, all false |
| sessions:get (same known short session) | **1468 / 7 / 7 ms** |
| messages:view | 1 / 1 / 1 ms |
| sessions:list | 18 / 12 / 8 ms |

The initial active samples reported 3 running sessions. A later separate read reported 2; targeted watchdog checks for both returned true. The previously completed handset-created session returned false. This verifies current true and false paths without sending prompts or creating sessions; disposal/clear race behavior is covered by the deterministic regressions, not manufactured live transitions.

[Post-restart measurements and diagnostics](<G:/Projects/DSH-cindy-host/artifacts/desktop-runtime-inspect/performance-postrestart-20260930.json>).

The main active-poll bottleneck improved from the earlier 1757/3642 ms baseline to 1–10 ms in this local probe, with no legacy fallback. Samples are few and taken at different times; no universal percentile or phone round-trip speedup is claimed. **The first post-restart exact get still cost 1468 ms**, then warmed to 7 ms. Its title/projection/transcript initialization components were not individually timed, so its precise remaining cause is not yet established. Subsequent history samples follow that get and therefore do not establish cold-history performance.

## Remaining acceptance

Ask the user about actual phone device-page and session-opening responsiveness. Keep local service timing, remaining first-read cost, and phone end-to-end experience separate. Do not close user-experience acceptance solely because the local probe and unit suite pass.
