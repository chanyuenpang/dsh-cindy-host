# ADR: Client-visible ordering, and the codes that may not poison a view

## Context

Four reports from a real handset over one day, all of them about a conversation that looked
wrong *while it was happening*, and none of them reproducible from the desktop:

- 「你一直在我的对话之上在工作…最好是我发完对话之后无论如何你都把正在工作这个信息调到最后」
- 「插入之后顺序会变，它会插入到我前面说的两行话前面」
- 「打开会话看不到进度，要退出会话再进入才有」
- 「转圈转圈然后就消失了」

The client's side of these is fixed and cannot be changed. It has **one** history refresh
trigger (`maker:history-view-changed`) and one permanent downgrade switch: once its
`historyViewController.refresh()` sees an error matching `UNSUPPORTED_CAPABILITY` /
`CHANNEL_NOT_ALLOWED`, it returns early **forever** and only a reset clears it
(`packages/maker-shared/src/historyViewController.ts:95`, `historyView.ts:8`). Its
`sessionRunning` defaults to `() => false`. Its transcript order is delivery order, and DSH's
**steer jumps the queue**: a message inserted while a turn runs becomes durable before
messages that were already queued for the next turn.

The Host's own contribution to the disorder was threefold: pending prompts were appended
after the whole page (so rows typed earlier appeared below one typed later), the running
group was never marked streaming (the view's `sessionRunning` was never wired, and the turn
state it would have read was itself dropped by the row cache), and a long transcript was
refused with the very code that permanently poisons the view.

## Decision

1. **Pending prompts are published where the user typed them.** The newest page of both
   `local-db:messages:view` and `local-db:messages:list` merges accepted-but-not-durable rows
   into its own sequence by acceptance time (`mergePendingByTime`), not at the end. This is a
   **prediction**, and it is allowed to move once: a queued prompt is delivered at the next
   turn boundary, so it may still end up after the insert that overtook it.
2. **A running work group is pinned last.** While a group `isStreaming`, anything that sorts
   after it by time is placed above it. A finished group keeps its historical place.
3. **The turn state's authority is DSH's boundaries.** `turn/start` and `turn/end` write
   `liveTurnState`; `isSessionRunning` consults it first and falls back to a read row only when
   no boundary has been seen. The history view is **wired** to it (`buildDshSource` takes the
   reader as an option); the controller's `() => false` default must never be what answers.
4. **`UNSUPPORTED_CAPABILITY` and `CHANNEL_NOT_ALLOWED` answer capability absence only** — a
   deployment fact. Never a property of one session, and never a transient state. A transcript
   of any length is served; withdrawing the view means withdrawing the advertised
   `history-view-v1` capability with it.

## Alternatives

- **Keep appending pending rows after the page**: rejected — measured. The user's own words
  appeared below a message they typed later, and below the running card, which is the report
  this ADR answers.
- **Order strictly by delivery (the transcript's own order)**: rejected — it is honest about
  the log and wrong about the screen. While nothing has been delivered yet, the only ordering
  the user can check against is the one they typed.
- **Have the Host reorder delivered rows too** (move a queued message above the insert that
  overtook it, permanently): rejected — that would make the Host's transcript disagree with
  what the agent actually saw, and the disagreement would be invisible.
- **Leave the view controller's `sessionRunning` at its default**: rejected — it silently
  disables both the live card and the pin, and both failures look like client bugs.
- **Refuse transcripts past `HISTORY_SCAN_MAX_ROWS`** (the previous decision): rejected in
  ADR-0007's decision evolution — it saved no scan and killed the view permanently.

## Consequences

- A queued prompt can move once, when it becomes durable. The trade is deliberate: the
  prediction is right while the user is looking, and the transcript is right afterwards.
- The pin only applies while a group is streaming, so a completed turn's card never floats.
- The turn state is correct on a Host that has never listed sessions, which is the state every
  restart starts in.
- Every one of these is pinned by a test that fails without it: `test/pending-order.test.js`
  (ordering and the pin), `test/host.test.js` ("a live turn is visible on a Host that has never
  read a session list"), `test/host-history-view.test.js` ("no answer this Host gives can poison
  the controller view").

<!-- state: current -->
