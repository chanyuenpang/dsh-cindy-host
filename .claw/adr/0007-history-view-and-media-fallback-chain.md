# ADR: Serve the controller's work-window channels, and answer media fetch with a descending fallback chain

## Context

Two phone-visible gaps were recorded against this Host, both of them places where the
controller already has a preferred protocol this Host was not speaking.

The first is history. The phone opens a session with a 20-row request
(`MESSAGE_FETCH_PAGE_SIZE = 20`), one row there is one content block, and on a full-page
sync `setLatestMessageWindow` drops cached segments whose contiguity it cannot prove. So
the user sees 「打开会话只显示一两条」 and loses the history they had already paged
through as soon as the session is recycled. The reference controlled end avoids this by
serving a **work-grouped history view** (`local-db:messages:view`, `work-details`,
`view-intent`) whose pages carry their own cursor, and the phone gates that path behind a
`history-view-v1` capability it reads from `link-accept`.

The second is media. `device-link:media:fetch` already staged a file and returned an
`ossKey` the controller presign-gets, which costs an upload → presign → download round
trip for every image, including thumbnails the controller asked to be downsampled
(`thumbnail: true`). The desktop reference answers that request in three layers with exact
limits the mobile client already validates against (`mediaFetch.ts`: png/jpeg/webp,
input ≤ 48 MiB, longest edge 1024, webp q80, 5 s soft timeout, ≤ 700 KiB products
inlined).

Both features are only useful if they land as the controller's contract, not as this
Host's approximation of it.

## Decision

Serve the controller's protocol on both fronts, mirroring the reference limits rather than
inventing local ones.

For history, implement the three work-window channels with the contract's page budgets
(20 items / 256 KiB view page, 256 KiB detail page, `version: 1`), chronological items, a
`nextCursor` that is the page's **oldest** id, and `hasMore` driving 「加载更早」.
Group by DSH turn boundary (`role === 'user'` opens a work group) because the contract
governs the page, not the grouping granularity. Fail closed on what this Host cannot
project: past `HISTORY_SCAN_MAX_ROWS = 20_000` answer `UNSUPPORTED_CAPABILITY`, with no
session API answer `NOT_AVAILABLE` — both of which the controller recognises as "no view
here" and falls back to the raw window. And **advertise `history-view-v1` in
`link-accept`** (`HOST_CAPABILITIES` in `src/host-authorization.js`, forwarded through
`capabilityProvider` in `src/dsh-plugin.js`), because the phone will not call the channels
otherwise.

For media, answer `thumbnail: true` with a descending chain: downsample with the
harness's own `sharp` (resolved from `process.argv[1]`, the `dsh web` entry, so this
plugin adds no second native image stack) and inline the product as webp when it is
≤ 700 KiB; otherwise inline the original bytes when it is `image/*` and ≤ 512 KiB;
otherwise upload and return an `ossKey`, reusing one staged object per unchanged file for
30 minutes (`skipCache: true` bypasses that cache). Every layer fails downward, never
upward: a missing codec or a failed render is not a fetch failure, because the controller
always accepts the `ossKey` form. Without `thumbnail: true`, behaviour is unchanged.

## Alternatives

- Keep answering the raw transcript window and let the phone keep re-paging: rejected —
  the loss is the client's own contiguity rule, which this Host cannot change from the
  outside; the work window is the only lever available to the controlled end.
- Implement the channels without advertising `history-view-v1`, or advertise without
  serving them: rejected — the capability is the gate, so half of the pair is
  indistinguishable from not implementing the feature.
- Group as finely as the desktop reference: rejected — that grouping reads row shapes
  (sealed answers, activity runs) this Host does not have, and a coarser work item still
  satisfies the page contract (`preview`/`children` are optional).
- Raise the scan budget instead of refusing long transcripts: rejected — a multi-minute
  scan simply times out on the phone, while `UNSUPPORTED_CAPABILITY` degrades to the
  fallback the phone already knows.
- Add `sharp` as a plugin dependency: rejected — it is a native image pipeline the
  harness already ships and uses to normalise every stored image; resolving the
  installation's copy keeps one pipeline per process.
- Always upload the original and return a key: rejected — it is exactly the round trip
  the thumbnail request exists to avoid, and for a small unrenderable image the inline
  fallback removes it for free.
- Inline whatever the renderer produces regardless of size: rejected — an inline frame
  that overruns the relay's 2 MiB budget is rejected at the relay, and the phone shows a
  vanished history rather than an oversized image.

## Consequences

- The phone's history survives re-entry through the work window, and its fallback to the
  raw window stays intact for sessions this Host refuses.
- `thumbnail: false` callers, and every pre-existing media caller, keep the staged-key
  shape; the inline shape is additive.
- The staged-object cache is keyed by path|size|mtime, so an object deleted at the relay
  stays gone until a caller sends `skipCache: true`.
- Both features are composed at startup: an existing process keeps answering
  `CHANNEL_NOT_ALLOWED` and advertises no capability until `dsh web` is restarted, so
  their live verification is only meaningful after a restart.
- Work-grouped history view and the media-fetch limits now have one current owner each in
  `.claw/truth` (`dsh-cindy-host-history-view.md`, `dsh-cindy-host-device-link-protocol.md`),
  and the capability advertisement has a seam-forwarding invariant test that fails when
  `capabilityProvider` stops forwarding `historyView`.

<!-- state: history -->
## Decision evolution

<!-- dated: 2026-09-17 -->
### The scan budget was refused for a reason that does not hold, and the refusal was permanent

This ADR decided "past `HISTORY_SCAN_MAX_ROWS = 20_000` answer `UNSUPPORTED_CAPABILITY`", and
its Alternatives section rejected raising the budget because "a multi-minute scan simply times
out on the phone". Both halves of that reasoning are wrong, and the second one is damage:

- **It saved no scan.** The rows come from the reader's transcript
  (`createHistoryViewController({ rows: (sessionId) => readMessages.all(sessionId) })`; `all` is
  `ensureTranscript`), so the full read has already happened and been cached by the time the
  budget is consulted, and `page()` windows that array in O(page). The refusal cost the client
  everything and saved the host nothing.
- **It did not degrade, it killed.** The controller's `historyViewController.refresh()` returns
  immediately for the rest of the screen's life once its error matches `UNSUPPORTED_CAPABILITY`
  (`packages/maker-shared/src/historyViewController.ts:95`), only `reset()` clears it, and the
  row count is a permanent property of the session — so re-entry re-poisons the view. Since
  `maker:history-view-changed` is the controller's **only** refresh trigger, every push this Host
  sent for such a session landed on a dead path. The claimed fallback to the raw window is not
  what happens.

Amended decision: **serve the transcript at any length**, and reserve `UNSUPPORTED_CAPABILITY` /
`CHANNEL_NOT_ALLOWED` for "this Host has no projection capability at all" — never for a property
of one session. That is now an invariant in `test/host-history-view.test.js`: no answer this Host
gives may match the controller's downgrade regex, and the budget test is inverted so the reversal
is visible in the diff.

Two constraints travel with it, both verified in client source:

- Serve the tail page; never raise `HISTORY_VIEW_VERSION`. The client ignores `page.version`, so
  a shape change would not surface as an error — it would draw wrong.
- Withdrawing the view means withdrawing the capability. A registered channel answering
  `CHANNEL_NOT_ALLOWED` reaches the client through the same `isHistoryViewUnavailable` family and
  poisons it identically.

<!-- dated: 2026-09-17 -->
### The channels first shipped without the capability that gates them

The three view channels were implemented and registered before `link-accept` advertised
`history-view-v1`. That is functionally equivalent to not implementing them: the phone
reads the capability first and never issues the invoke. The project's existing
"seam-built capabilities must be forwarded" invariant test caught the same class of
mistake again — this time for `capabilityProvider.historyView` — and the retention here is
the rule it enforces: a capability and the channels behind it are one unit, and the
gateway declaration has to land with them.
