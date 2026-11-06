# Work-grouped history view channels

<!-- state: current -->
## Current behavior

The controller's own paging rules make a raw transcript window a poor fit for re-entering a
session, so this Host serves the three **history view** channels the phone prefers:

```
local-db:messages:view         (sessionId, { before? })   → { version: 1, items, nextCursor, hasMore }
local-db:messages:work-details (sessionId, ref, { after? }) → { version: 1, messages, nextCursor, hasMore }
local-db:messages:view-intent  (sessionId, refs)          → true
```

Why the raw window is not enough: the phone pages **20 rows at a time**
(`MESSAGE_FETCH_PAGE_SIZE = 20` in `apps/mobile/src/session/messagePaging.ts`, driving
`[20,10,5,1]` on open) and one row there is one content block, so a single turn can fill a
page; on a full-page sync `setLatestMessageWindow` also drops cached segments whose
contiguity it cannot prove (`sessionWindowCoverage` in
`apps/mobile/src/session/remoteSessionStore.ts`). The visible symptom is 「打开会话只显示
一两条、重进还丢历史」. A work window carries its own cursor, so the controller no longer has to
infer continuity from 20-row pages.

Page and cursor semantics:

- A page's `items` are **chronological** (oldest → newest); `nextCursor` is the **oldest** id
  of that page (`firstId(items[0])`) and is sent back as `before` to walk further back.
  `hasMore` is what lights the controller's 「加载更早」.
- Page budgets are the contract's, not this Host's choice: 20 items / 256 KiB for a view page
  and 256 KiB for a detail page (`HISTORY_PAGE_ITEMS`, `HISTORY_PAGE_BYTES`,
  `HISTORY_DETAIL_PAGE_BYTES`, `HISTORY_VIEW_VERSION = 1` in
  `src/host-history-view-limits.js`, mirrored from `@cindy/maker-shared/message-window`).
- A `work` item carries a `HistoryWorkSummary` (including a content `revision`, FNV-1a over the
  group's rows); a `messages` item is a plain row the controller renders itself.
  `preview`/`children` are optional.
- `work-details` reads the inclusive range `firstMessageId…lastMessageId` one detail page at a
  time, with `after` = the last row already sent; `view-intent` replaces the expanded-work set
  wholesale and is advisory (at most 100 refs).
- Grouping here is by **DSH turn boundary as the controller can see it**: a row whose role is
  `user` opens a work group and everything up to the next one belongs to it. The desktop
  reference groups more finely (sealed answers and activity runs from row shapes this Host does
  not have), but the contract governs the page, not the grouping granularity.

Refusal and fallback semantics (fail closed, deliberately):

- **`UNSUPPORTED_CAPABILITY` and `CHANNEL_NOT_ALLOWED` are reserved for "this Host has no
  projection capability at all"** — a deployment fact. They must never answer a property of one
  session, because the controller reads them as a **permanent** downgrade: its
  `historyViewController.refresh()` returns immediately once its error matches that family
  (`packages/maker-shared/src/historyViewController.ts:95`, `historyView.ts:8`) and only
  `reset()` clears it, which re-entry does not reliably do. A code that kills the view for the
  life of the screen is not a fallback.
- A transcript of any length is therefore **served**. The reader's transcript
  (`readMessages.all`) is already read and cached before any budget could be consulted, so
  refusing saved no work while killing the view; `HISTORY_SCAN_MAX_ROWS` survives only as a
  marker of the removed rule. With no session API it answers `NOT_AVAILABLE`; an
  unreadable/absent transcript answers `NOT_FOUND`; a missing session or an out-of-range detail
  cursor answers `BAD_REQUEST`. Those stay retryable.
- **The `link-accept` capabilities are load-bearing.** The phone reads
  `device-link/historyViewCapability.ts` and will not call these three channels at all unless
  this Host advertised `history-view-v1`, which `HOST_CAPABILITIES` in
  `src/host-authorization.js` does. Serving the channels without advertising the capability is
  indistinguishable from not implementing them — and withdrawing the view means withdrawing the
  capability with it, never leaving registered channels to answer `CHANNEL_NOT_ALLOWED`.
- Advertising must also survive the capability seam: the channel layer reads
  `capabilitiesNow().historyView`, so `capabilityProvider` in `src/dsh-plugin.js` has to
  forward `sources.historyView` (the project's seam-forwarding invariant test catches an
  omission here).

Live reasoning overlay and paging behavior:

### Current Host correction (2026-11-06)

- History pages/details now share an explicit source-order snapshot (`src/history-snapshot.js`, `src/host-history-view.js`); raw transcript ordering/wire contract remains separate. Validated durable reads still use their flush/contiguous-prefix evidence rather than being bypassed by fallback cache. Pagination resolves `before`/`first`/`last`/`after` against that same snapshot; an unknown cursor fails explicitly instead of masquerading as the oldest page.
- Live reasoning uses `history-live:<logical clientId>` and preserves logical identity when durable. Retired display-only rows retain only a replay-reconstructible paging cut, not their body; resolver/replay does not add database or event-log records.
- Thinking `created` filtering is scoped to the accepted controller/session subscription whose latest history page was successfully written on its current connection (`src/history-delivery-state.js`, `src/host.js`). It is not a remote application ACK; pending, failed, stale, or unauthorized delivery does not establish readiness.
- Interim reasoning publication (`src/reasoning-publisher.js`) is deduplicated/latest-wins with a one-second coalescing interval, a 32 KiB/s token rate, 64 KiB burst and 64 KiB per-snapshot UTF-8 payload ceiling before fan-out. Oversized interim content is not truncated and mislabeled complete; complete content remains available through raw/history details or durable output. Automatic work preview is capped at 5 rows / 6 KiB serialized content. These are source-publisher budgets, not total network or end-to-end memory bounds.
- Automated evidence in `doc/history-stability-verification.md`: 1209 tests (1201 pass, 8 skipped, 0 failed), channel audit 249 (75 served, 174 declined, 0 unclassified), and `git diff --check` passed. This does not establish deployment, handset acceptance, or the Android blank-screen root cause.

<!-- state: history -->
## Evolution history

<!-- dated: 2026-11-06 -->
### Projection-order, cursor-continuity and interim-push correction

The investigation reproduced the ordering and cursor defects described below. The Host correction above records current behavior; those findings remain useful as defect/incident context, not current contracts:

- The live reader composed `visibleRows` as reasoning overlay rows followed by cached transcript rows (`src/dsh-message-fold.js`), while the history grouper reversed its input (`src/host-history-view.js`). A production-module memory reproduction recorded a thinking+assistant sequence as assistant+work and marked the trailing work group streaming while the turn remained active. This was a reproduced projection/order defect, not evidence that it alone caused a phone blank screen.
- Before the correction, an unplaceable `before` cursor selected the oldest available page, and retirement of temporary reasoning IDs could create a paging gap. Regression coverage was added for the corrected explicit unknown-cursor failure and live-to-durable continuity.
- A publisher simulation (600 × 100-character increments; 60 KB final text) produced 18,199,200 bytes of cumulative full-message payload. This was a local simulated measurement, not observed phone-network traffic. The simulation motivated source-side budgeting; it was not proof of a measured handset traffic volume.
- Native comparison in the investigation found per-controller/history-readiness filtering, bounded work previews, revision-based patches and live-to-durable alias resolution. Those comparisons do not prove the Android blank-screen mechanism. Renderer-mount, JS and OOM causes remain unresolved absent phone-side traces/device reproduction.

Pitfalls:

- Do not answer a page with fewer rows than the budget merely to make `hasMore` false; the
  cursor and `hasMore` pair is what the controller trusts.
- Do not widen the scan budget to "make the view always available" — a session past the budget
  falls back correctly today, while a multi-minute scan would simply time out on the phone.
- `nextCursor` is the **oldest** id of the page; returning the newest id makes the next page
  repeat itself.

Code anchors:

- `src/host-history-view.js` (`groupHistoryItems`, `createHistoryViewController`,
  `HISTORY_SCAN_MAX_ROWS`, `firstIdOf`, revision/`keyOf` row shape)
- `src/host-history-view-limits.js` (page budgets, `HISTORY_VIEW_VERSION`)
- `src/cindy-channels.js` (`SUPPORTED_CHANNELS` entries for the three channels, the
  `local-db:messages:view` / `work-details` / `view-intent` branch, `invokeError`)
- `src/host-authorization.js` (`HOST_CAPABILITIES = ['history-view-v1']`, `acceptLink`)
- `src/dsh-plugin.js` (`capabilityProvider` forwarding `historyView`)
- `doc/cindy-phone-link.md` section 「收尾：媒体取件补齐 + 历史视图通道」

Verification rules:

- `test/host-history-view.test.js` covers grouping and the page/detail cursor semantics
  (`hasMore`/`nextCursor`); `test/cindy-channels.test.js` covers the channel layer's forwarding
  and its fail-closed refusals.
- `tools/acceptance.mjs` checks a live view page (`version === 1`, array `items`), a
  `work-details` range, and that `view-intent` accepts an expanded set.
- Live verification of these three channels on this Host is only meaningful **after** `dsh web`
  is restarted: channels and capabilities are composed at startup, so a pre-restart process
  still answers `CHANNEL_NOT_ALLOWED` for all three.
