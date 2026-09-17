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

- A transcript past `HISTORY_SCAN_MAX_ROWS = 20_000` answers `UNSUPPORTED_CAPABILITY`; with no
  session API it answers `NOT_AVAILABLE`; an unreadable/absent transcript answers `NOT_FOUND`;
  a missing session or an out-of-range detail cursor answers `BAD_REQUEST`.
  `UNSUPPORTED_CAPABILITY` and `NOT_AVAILABLE` are both recognised by the controller as "no
  view here" (`isHistoryViewUnavailable`), which sends it back to the raw window — the same
  lever the desktop reference uses.
- **The `link-accept` capabilities are load-bearing.** The phone reads
  `device-link/historyViewCapability.ts` and will not call these three channels at all unless
  this Host advertised `history-view-v1`, which `HOST_CAPABILITIES` in
  `src/host-authorization.js` does. Serving the channels without advertising the capability is
  indistinguishable from not implementing them.
- Advertising must also survive the capability seam: the channel layer reads
  `capabilitiesNow().historyView`, so `capabilityProvider` in `src/dsh-plugin.js` has to
  forward `sources.historyView` (the project's seam-forwarding invariant test catches an
  omission here).

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
