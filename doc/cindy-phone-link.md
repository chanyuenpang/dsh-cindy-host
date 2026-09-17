# Cindy Phone Link: protocol findings and design

The settings card 「Cindy 手机连接」 makes this DSH Host reachable from the Cindy
mobile client. Before any UI was written, four questions were answered from
Cindy's own source. They are recorded here because the answer to the first one
removed a feature that the original request assumed existed.

## The four questions

### 1. Does the relay return a pairing token or pairing URL?

**No.** There is no pairing concept anywhere in the DeviceLink protocol. The
relay is a dumb router: it authenticates the WebSocket from the bearer token,
binds the connection to a Cindy account, and fills `Envelope.src` itself. The
only identity it ever hands back is in `hello-ack`:

```
HelloAckPayload = { serverProtocolVersion, deviceId, userId, capabilities? }
```

Evidence: `Cindy/packages/device-link-protocol/src/protocol.ts:28-121` (the
`EnvelopeKind` union has no pairing kind) and `:110-121` (the `hello-ack`
payload above). A repository-wide search for `配对`/`pairing`/`pairingCode`/
`deviceCode` across `apps/desktop/src`, `apps/mobile/src`, `packages/` and
`cindy-protocol/` returns only unrelated request/tool-call pairing.

### 2. What QR content does the Android app scan?

**The regional mobile download page URL** — and that QR is not part of DeviceLink
at all. Cindy's own "connect your phone" surface renders the website's
`/download/` path and tells the user to sign in to the same account:

- `Cindy/apps/desktop/src/renderer/components/sidebar/MobileDownloadDialog.tsx:119-127`
  builds the code from `websiteUrl` (`resolveMobileDownloadUrl`), canonicalizing
  `cindy.com.cn → cindy.cn`.
- `.../i18n/locales/zh-CN/common.json:7241` — `"scanToOpen": "扫码打开 Cindy App，并登录同一账号"`.

So the phone is linked by **account**, not by the code: scan → install → sign in.
Because the user dropped the QR requirement, this bundle renders no QR at all
rather than inventing a payload Cindy does not understand.

### 3. Which relay frame reports a successful pairing?

**There is none.** Association is account-scoped, so there is no handshake to
observe. What the Host can observe instead:

- `presence-changed` carries a `PresenceSnapshot` for every same-account device
  (`Cindy/packages/device-link/src/protocol.ts` and `.../src/client.ts:2202-2212`).
- `GET /api/device-link/devices` returns `DeviceView[]` for the whole account
  (`Cindy/packages/device-link/src/protocol.ts:203-219`).
- A phone that actually uses this Host sends `link-open` (dropped for
  listing-only controllers) or `invoke`.

This bundle therefore defines **connected** as *a device opened a link to, or
invoked, this Host* — an observed event, not a guess. Presence alone shows the
device row but leaves the state at `waiting`, which is why the card can honestly
say "等待手机连接" while a phone is merely online.

Because any same-account Cindy client is a valid controller, `connected` means
"a Cindy client reached this Host", not "a phone reached this Host". The device
list always names the platform, so the card distinguishes them rather than
hiding a linked desktop behind a green dot.

To name those rows, the runtime performs one read-only
`GET /api/device-link/devices` after `hello-ack`, and once more for a controller
whose platform is still unknown. `presence-changed` only arrives for devices
that come online while we are connected, so without this read a device that
linked earlier would show as a bare hex prefix.

### 4. Is there a ready-made QR component or pairing API?

There is no pairing API. For rendering, Cindy uses the `qrcode` package's
`toDataURL` (`MobileDownloadDialog.tsx:129-152`). Unused here, since there is no
QR.

## What the relay does require

The relay only routes `link-open`/`invoke` to a target that advertised
`remoteControlEnabled: true` in `hello` (`CONTROL_KINDS` in
`device-link-protocol/src/protocol.ts:75`). A Host that stays silent about this
is invisible to the phone. So the runtime's `hello` carries exactly the user's
own opt-in: `remoteControlEnabled: policy.isEnabled()`.

## The DSH data source

The bundle originally read DSH through `ctx.apiProxy` (`InProcessApiClient`).
Current DSH Web does not mount `apiProxy` — `dsh --dump-config` shows only
`typert`, `typert-gateway`, `api-remotes` and `session-controller` — so
`ctx.get('apiProxy')` was permanently `undefined`, the projection never started,
and the phone received an empty session list. The console demo's fixtures hid
this; the phone did not.

The replacement reads the same facts from services the Web profile does mount
(`src/dsh-session-source.js`):

| Need | Host seam | Counterpart |
|---|---|---|
| session list | `ctx.sessionController.list()` → `SessionSummary[]` | old `client.sessions.list()` |
| list lifecycle | cordis `api-session/added\|removed\|status\|activity\|error` | old `events.host()` frames |
| message history | `sessionController.page()` | `local-db:messages:list` |
| live session stream | `sessionController.follow()` → `AsyncIterable<SessionFollowFrame>` | `maker:event` |
| queue / projection | `sessionController.control()` → `AsyncIterable<SessionControlFrame>` | `maker:input:projection` |
| send / interrupt / queue | `sessionController.prompt()/cancel()/updateQueue()` | `maker:send` / `abort` / `maker:input:*` |
| create / fork / rename | `sessionController.create()/fork()/rename()` | `maker:create-session` 等 |
| agent roster | `sessionController.modelCatalog()/resolveAgent()` | `maker:list-available-agents` |
| titles | `ctx.sessionQuery.readTitleSnapshots(ids)` | session row title |
| goal | `ctx.goals` (`GoalService`) | `maker:goal:*` |
| approval | `ctx.approval` (`ApprovalService`) | `maker:resolve-interaction` |

### Two traps this seam hit

Both are the same mistake — reading a sibling plugin's contribution at `apply`
time instead of waiting for it:

1. **Services.** `ctx.get('sessionController')` in `apply` returned `undefined`
   because the supplying plugin had not activated yet. The fix is
   `ctx.inject(['sessionController'], (ctx) => …)`, which also re-runs on
   removal so a reloaded session API cannot leave the projection reading a dead
   service.
2. **Ordering against an async runtime.** `startHost` awaits a Cindy session
   (keychain + token refresh) before it resolves, while `ctx.inject` fires
   immediately. Attaching the source only through `runtime?.setSource(...)`
   silently dropped it when `runtime` was still `undefined`. The plugin now
   holds the source and re-applies it after the `await`, which covers both
   orders.

The status route reports which seam won (`diagnostics.dataSource`) and how much
has been projected, so a silent `none` can never be mistaken for "no sessions
yet":

```
GET /api/dsh-cindy-host/status
→ "diagnostics":{"dataSource":"session-controller","projectionRunning":true,"projectedSessions":0}
```

## The channel contract

`src/cindy-channels.js` is the Host's half of the DeviceLink tunnel: one invoke
in, one `invoke-result` out. Implemented so far:

| Channel | Behaviour |
|---|---|
| `device-link:subscribe` / `:unsubscribe` | registers/releases the controller as a push recipient; accepts the `sessions` and `session:<id>` topics |
| `local-db:sessions:list` | flat `RemoteSession[]` (also the responsiveness probe, so one cheap read) |
| `local-db:sessions:get` | the same flat row, by top-level `id` |
| `local-db:sessions:patch-meta` | applies the title via DSH `rename`; pin/archive have no DSH counterpart and are not pretended |
| `local-db:messages:list` | the transcript, newest first, paged by `before` |
| `maker:create-session` | DSH session creation; echoes a controller-preallocated id |
| `maker:send` | a prompt into the session |
| `maker:list-active` | `[{ sessionId, isTurnRunning }]` |
| `maker:get-pending-interactions` / `maker:resolve-interaction` | DSH approvals, answered by the watching controller |
| `maker:input:get-projection` | the folded `control()` stream's queue |
| `maker:git-safety:get` | the feature is off; the three booleans are read positionally |
| `maker:goal:get-status` | folded from the `goal` session projection; never resumes the session |
| `maker:input:enqueue` / `maker:input:steer` | the composer's send paths (`mode: 'queue'` / `'steer'`); enqueue answers the new projection with the accepted item already in it |
| `fs:stat-path` / `fs:list-dir` / `text-file:read-preview` | absolute-path reads over `ctx.fs`, translated to the controller's vocabulary |
| `maker:list-available-agents` / `maker:get-capabilities` / `maker:provider:list` | the agent roster — `pi` only |
| everything else | `CHANNEL_NOT_ALLOWED` |

**As of round 10, every channel the controller actually requests is answered.**
The only refusals left in a live log are `maker:get-capabilities` for
`claude-code` / `codex`: the controller probes all three harnesses, this Host
offers one, and `NOT_AVAILABLE` is the honest reply. That is by design — Cindy's
picker offers codex / claude / pi, and a single-entry picker was accepted.

Still unimplemented but *not currently requested*: `maker:goal:get-status`
(goal), the todo surface, and the `file-browser` family. Goal needs
`sessionController.resolveAgent`, which **activates** the session's agent — a
side effect that should not be triggered by a status query — so it needs a
design decision rather than a quick channel.

`CHANNEL_NOT_ALLOWED` is not a failure: it is what a Cindy controlled device
answers for a channel it does not serve, and the controller degrades on it. A
channel we accepted and then failed would be worse — the phone would show a
broken feature instead of an absent one. `NOT_AVAILABLE` is reserved for "this
DSH profile exposes no session API at all", so "no capability" stays
distinguishable from "it broke".

An invoke with no `id` or no `src` is answered with **nothing**: the relay could
not route such a reply, and a fabricated frame would be worse than silence.

### The wire shape is the FLAT `RemoteSession`, and it cost a day

`local-db:sessions:list` returns a flat `RemoteSession[]` — identity and status at
the top level — and `sessions:get` returns exactly one such row. `title` is part
of it; nothing else is.

`RemoteSessionListItem` (the `{ session: {…}, subtitle, detail, … }` view model)
is built **inside the controller's own renderers**
(`maker-shared/sessionList.ts`, `mobileHome.ts`) and must never cross the wire.

An earlier revision here emitted that view model, citing a
`mobileMakerTransport.listSessions()` that **does not exist in the Cindy tree**.
The controller neither validates nor unwraps: it hands the invoke result straight
to `remoteSessionStore.setDeviceSessions`, which de-dupes on `session.id`. So a
wrapped row arrives with `id`, `status` and `deviceLinkDeviceId` all `undefined`
and is discarded by **three independent filters**, without one error anywhere:

1. de-dupe key `session.id` → every row collapses onto a single `undefined` key;
2. status filter, default `'active'` → `undefined !== 'active'`;
3. device filter `canonicalDeviceId ?? deviceLinkDeviceId === selectedDeviceId`
   → both `undefined`.

The symptom is exactly "the device is online, but it has no tasks" — invisible
from the Host, which logs `ok: true, items: 1`.

Two more details of the flat row:

- **`deviceLinkDeviceId` / `deviceLinkDeviceName` must be top-level.** The
  controller's home aggregates sessions from every linked computer, so a row that
  names no device is dropped once the user selects this Host — the only way to
  see it.
- **`maker:list-active` has its own shape**, `[{ sessionId, isTurnRunning }]`.
  Answering it with session rows is silently skipped, and surfaces only as a
  running badge that never lights up.

### The gate that catches shape errors

`tools/probe-list-shape.ts` runs the controller's **own** builders over the row
this Host serves, with the retired wrapped shape as a control:

```
control (wrapped)  → home_rows: 0, detail_active_rows: 0
actual  (flat)     → home_rows: 1, detail_active_rows: 1
shape gate passed: the served rows render, the wrapped control does not.
```

`G:\Projects\Cindy\node_modules\.bin\tsx.cmd tools\probe-list-shape.ts`

Losing any of `id`, `status`, `deviceLinkDeviceId`, `deviceLinkDeviceName` at
the top level brings the symptom straight back, so the regression test asserts
those fields rather than a row count.

### Two capabilities that arrive late

The DSH services this Host reads (`sessionController`, `sessionQuery`) are
provided by *other* plugins and may activate after this one. `ctx.get` at `apply`
time yields nothing; the fix is `ctx.inject`. Even then, `startHost` awaits a
Cindy session (keychain + token refresh) while `ctx.inject` fires immediately —
so anything captured at construction freezes empty, and a perfectly capable Host
answers `NOT_AVAILABLE` forever. Both the session source and the write
capabilities are therefore resolved **per request** (`setSource`,
`resolveCapabilities`), never captured.

`SessionSummary` carries no `createdAt`, but the row requires one. The source
reads it from the session header **once per session id** (creation time and cwd
are immutable, so the cache cannot go stale) rather than on every listing —
`sessions:list` is also the phone's responsiveness probe and must stay cheap.

### Finding this class of bug

A controller's view is invisible from the Host, so "the phone shows nothing" has
three very different causes: the channel was never asked for, we refused it, or
we answered with something unusable. The status route therefore reports the last
20 invokes it served:

```
GET /api/dsh-cindy-host/status → diagnostics.recentInvokes
  [{ channel: "local-db:sessions:list", ok: true, items: 1, bytes: 820, ... },
   { channel: "maker:get-capabilities", ok: false, code: "CHANNEL_NOT_ALLOWED" }]
```

Only the channel name, outcome, item count, reply size, and timestamp are kept —
never a payload. That log is what turned "点不开" from a guess into the
device-stamp bug above.

### The agent kind is `pi`, always

Cindy's controller has a harness picker limited to **codex / claude / pi**, and
`MobileAgentKind` is a closed union (`apps/mobile/src/device-link/mobileMakerTransport.ts`).
A row whose `agentKind` is outside it has no label, no capability entry, and no
picker entry on the phone.

Whatever internal agent drives a DSH session is therefore erased at this
boundary: every session is presented as `pi`, and `maker:list-available-agents`
answers `['pi']` so the roster and the rows agree. `maker:get-capabilities` for
any other kind is refused with `NOT_AVAILABLE` rather than answered with a
capability this Host does not have.

An early stub in this repository reported `agentKind: 'pi'` and the phone showed
the task; a later rewrite reported `'dsh'` and the task silently disappeared —
the symptom was an empty list, with no error anywhere, while the Host logged
`ok: true, items: 1`.

### Verifying a row without a phone

`tools/probe-mobile-home.ts` runs the **controller's own** rendering code over the
exact row this Host serves, using Cindy's `tsx`:

```powershell
G:\Projects\Cindy\node_modules\.bin\tsx.cmd tools\probe-mobile-home.ts
```

It exercises both builders — `buildMobileHomePresentation` (the home, which
filters by `canonicalDeviceId ?? deviceLinkDeviceId === selectedDeviceId`) and
`buildRemoteSessionSections` (the device detail page) — and reports how many rows
survive each. This is what turned "the phone shows nothing" from a guess into a
specific missing field, and it is much faster than a round trip through a real
handset.

### The live stream needs `session:<id>` subscriptions

Two topics exist, and only two are served: `sessions` for list-level changes and
`session:<id>` for one session's live stream. `acceptTopics` used to accept only
`sessions`, so the controller's `session:<id>` subscription was **silently
dropped**: the subscribe call succeeded, the reply looked right, and no stream
ever arrived.

Pushes are routed per topic, not broadcast. `sessionSubscribers` keeps
`sessionId -> Set<deviceId>`, and a message push reaches exactly the controllers
watching that session — sending one session's transcript to every subscriber
would leak it into another session's view.

The payload is exactly what the controller's `local-db:messages:created` handler
reads (`apps/mobile/src/session/remoteSessionStore.ts`):

```js
{ sessionId, message }   // message is one RemoteMessage row
```

So a live append and a transcript read produce the same rows from the same fold
(`foldSessionEvent` / `toCindyMessages`), and the subscription set is cleared when
the switch goes off.

### Approvals are an answerer, not a feature

DSH raises `approval/request` as a **waterfall** event
(`@deepseek-ai/dsh-user-approval`), and the chain's terminal answerer is
fail-closed. That dictates the design:

- **No Cindy controller watching that session → `next()`.** The question passes
  down the chain so the local UI, or the fail-closed default, decides. A Host
  that swallowed the question would silently deny work the user could have
  approved at the desk — a worse failure than not answering at all.
- **A controller watching → register, push, wait.** `host-approvals.js` keeps the
  open questions, `maker:interaction-request` pushes the card, and
  `maker:resolve-interaction` settles it.

The vocabularies differ and must be translated, not passed through: the
controller answers `{ kind: 'permission', behavior: 'allow' | … }`, while DSH
speaks `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'` — and
`'allowed-once'` is the only grant DSH defines, so every non-allow answer becomes
`'rejected'`. An id the Host does not know, or a decision it cannot map, is
**refused rather than acknowledged**, so the controller keeps the card open
instead of believing it was answered.

Three lifecycle rules, each with a test: an aborted ask settles `cancelled` and
discards a late answer; an unanswered question times out rather than hanging
DSH's turn; and turning the switch off settles every open question, because a
question asked over a link that is going away can never be answered.

`maker:get-pending-interactions` is also requested by the controller on every
session open, so it answers even with nothing pending — an empty list is the
honest answer, and refusing it would look like a broken feature.

### The input queue is a stream, not a query

`maker:input:get-projection` cannot be answered from stored state: DSH publishes
the queue and job state as an `AsyncIterable` of control frames from
`sessionController.control()` — a `baseline` followed by per-session `queue` and
`jobs` replacements. `host-input-queue.js` folds that stream and answers from the
fold.

The controller's reader is defensive — an entry survives only with `clientId`,
`text`, `persistedContent`, `model`, `workingDir`, `createOpts` and
`chatMessage.role === 'user'`
(`apps/mobile/src/session/inputProjection.ts`) — so this Host emits an entry only
when it can fill all of those, and otherwise emits a shorter queue. A row the
controller would silently discard is worse than an absent one: it costs a corpus
read and teaches nothing.

The error/recovery fields describe a turn that failed inside the *controller's*
agent; DSH reports those as session events instead, so they are emitted as empty
rather than invented.

The channel also answers when no queue support is wired at all: the controller
requests it on every session open, and an empty projection is the honest answer
where a refusal looks like a broken composer.

#### The field was called `workingDir` on one side and `cwd` on the other

Every projection this Host built was empty, and the reason was a name:

- the cache behind `sessionRowFor` holds **source** rows, whose directory field
  is `cwd` (`dsh-session-source.js`);
- `cindy-session-row.js` renames it to `workingDir` when building the row the
  controller reads;
- both queue builders read `session.workingDir` — so on a cached source row they
  always saw `undefined` and returned `null`.

The visible damage was not a missing queue row. It was **duplicate prompts**:
`maker:input:enqueue` answers with the projection that must already contain the
item just accepted, so with `pendingQueue: []` the phone never settled its
composer. The draft stayed in the box, the spinner kept turning, and the user's
next action — 插话, which steers — sent the identical text again. Two byte-equal
user messages 39 seconds apart is what that looks like in the transcript.

It also emptied `maker:input:get-projection` for *real* queued items, so the
queue panel could never show anything.

`workingDirOf(session)` now accepts either name, and two tests pin it: one on the
builder, and one that wires the **real** `queuedRowFromController` into the
router over a `{ cwd }` row. The original test used a stub `queuedRow` that
ignored the session entirely, which is why a wrong name survived a full suite.

Measured on the live Host through the self-test route:

```
before:  enqueue -> ack pendingQueue=[]            (composer never settles)
after:   enqueue -> ack pendingQueue=[selftest-push-1]
```

The trap generalises: **a row that two modules both read is a contract, and the
rename between the cache and the wire is where it breaks.** A stub at the seam
hides it perfectly, because the stub is written in the shape the caller expects.

### Todos need no channel — but they do need the right tool *name*

The controller receives no todo channel. It reads them out of a **message**:

```js
message.content.input.todos -> [{ content, status, activeForm? }]
```

and this Host's `tool_use` rows carry `content.input` = the parsed tool
arguments. DSH's `todo_write` takes exactly `{ todos: [{ content, status }] }`
(`dsh-tool-todo`).

The shape is necessary but **not sufficient**, and believing otherwise cost a
round trip: the phone selects the card **by name**, not by shape.
`extractPlanTodos` returns todos for `TodoWrite` (and `update_plan`) and `null`
for every other name, so a row named `todo_write` renders nothing no matter how
correct its input is. `cindy-message-row.js` therefore translates the one name it
has verified — `todo_write → TodoWrite` — and passes the data through untouched.

Confirmed against a real session: the transcript's `todo_write` call now leaves
this Host as

```
toolName=TodoWrite todos=3
```

Two lessons, both about verification rather than protocol:

- **A probe must enter through the branch that decides.** `tools/probe-todo.ts`
  originally called `extractTodosFromSourceMessage` directly, which skips the
  name gate — so it passed for a whole round while the phone showed nothing. It
  now calls `extractPlanTodos(toolName, input)` and fails on a wrong name.
- **`extractTodosFromSourceMessage` is not the gate.** It is the *extractor* the
  gate calls. Testing the extractor tests half the contract.

The general rule stands: **check whether the controller derives the thing from
what you already send** before building a channel. But "it derives it" is only
true once you have run the derivation the way the controller runs it.

### A push is only as good as the subscription behind it

`pushSessionUpdate` fans out to the controllers holding `session:<id>`, and
returns silently when nobody holds it. So "the phone never updated" has two
indistinguishable causes — no subscriber, or a frame the controller dropped.

Both halves were verified locally, without a phone, using the self-test route:

1. subscribe as a controller, then watch `diagnostics.subscriptions`;
2. `maker:input:enqueue` and watch `diagnostics.recentPushes`.

```
subscribe session:<id>  -> sessions=[{sessionId:…, devices:[selftest]}]
enqueue                 -> local-db:messages:created watchers=1   (the prompt)
                           local-db:messages:created watchers=1   (the answer)
```

That the answer appears as its own push is the point: **a live reply needs the
`session:<id>` subscription and nothing else.** When a handset shows nothing, read
`subscriptions.sessions` first — an empty list there is not a push bug, it is a
missing subscription.

`recentPushes` and `subscriptions` exist for exactly this, and neither existed
while the phone was silently receiving nothing.

### Goals are read from a projection, never by waking a session

`ctx.goals` is keyed by `Agent`, and the only public way to obtain one session's
Agent is `sessionController.resolveAgent(sessionId)` — which **resumes** the
session. The controller asks for goal status on *every* session open, so
answering it that way would resume a cold session to look at it: a side effect
nobody asked for.

It is also unnecessary. `dsh-goal` registers a session projection under the key
`goal` (`dsh-goal/lib/index.js`), and projection frames ride the same
`sessionController.control()` stream this Host already folds for the input queue.
So the goal arrives as data and a status read costs nothing.

The vocabularies line up for free: DSH phases are `active | paused | blocked |
complete`, a direct subset of the controller's `… | budgetLimited |
usageLimited` (`maker-shared/deviceLinkContract.ts`), so the mapping is the
identity. This Host has no goal token budget, so `budgetTokens` /
`noProgressLimit` / `usageResetAt` are `null` rather than a fabricated zero the
card would render as real usage.

One distinction matters: the controller treats `undefined` as "never fetched" and
`null` as "fetched, no goal", so an unseen projection stays `undefined` instead
of being flattened.

The **write** commands (`goal:set|pause|resume|clear`) are a separate task: those
legitimately need `resolveAgent`, because the user is acting on that session — the
rule is that a *status read* must not wake a session, not that waking is always
wrong.

### Fail-closed is a property, not a sample

`test/cindy-channels-fail-closed.test.js` proves the guard against Cindy's own
`REMOTE_INVOKE_ALLOWLIST` rather than a hand-picked list. The fixture
(`test/fixtures/cindy-invoke-allowlist.json`) is extracted from
`allowlist.ts` with the constant references its blocks use resolved, and is
documented there as a **lower bound** — `REMOTE_RESOURCE_CHANNELS` is a spread
from another module and `DL_VOICE_CREDENTIAL_SYNC` is not a plain literal, so
both are absent.

The property is two-sided:

- **outside** the supported set, every allowlisted channel answers exactly
  `CHANNEL_NOT_ALLOWED` — the one code the controller degrades on;
- **inside** it, no channel ever answers `CHANNEL_NOT_ALLOWED`, because a
  supported channel that hid itself would make the controller hide a feature that
  is actually there. (`BAD_REQUEST` / `NOT_FOUND` for an empty-args invoke is
  correct — that is a validation answer, not absence.)

Writing that test immediately found a hole in its own first rule, not in the
implementation: the original rule treated a validation error from a supported
channel as a fail-closed violation. The two-sided form says what was meant.

## Design

```
设置 → Cindy 手机连接                     (lib/client.js)
        │  settings.section, id = dsh-cindy-host
        │  reads/writes transportEnabled via ctx.settingsScope
        │  polls GET /api/dsh-cindy-host/status
        ▼
src/dsh-plugin.js          settings namespace + optional /api route
        ▼
src/host.js                runtime: session → relay socket → projection → status
        ├── src/host-status.js     the five states and the device ledger
        ├── src/host-routes.js     status / reconnect / login / logout
        ├── src/cindy-login-flow.js non-interactive request-code → verify-code
        └── src/authorization-policy.js who may control this Host
```

The page is a `settings.section` contribution rather than a
`settings.plugin.item` card. It carries a switch, a sign-in flow and a device
list — a page's worth of state — and the section slot is where the shell's own
contract puts "a feature owns its own settings page". `slots.inject` again, for
the same reason as the plugin tab: the shell declares the slot when
`ui-settings-general` activates, which may be after this bundle.

### Host is the only truth

The card never decides whether the Host is connected. The switch is a settings
write; everything drawn on the card comes from the last `status` answer:

| State | Means |
|---|---|
| `disconnected` | switch off, or no session yet |
| `authenticating` | reading/refreshing the Cindy session, or dialing the relay |
| `waiting` | relay online (`hello-ack` received), no phone has reached us |
| `connected` | a phone opened a link or invoked this Host |
| `failed` | a concrete failure; `message` names it |

### Switch off means torn down

Turning the switch off closes the WebSocket, stops the DSH session projection,
and clears the in-process subscriber set, accepted controllers, and device
ledger. The projection is not left idling: it exists to feed the phone.

### Login lives in the card

A host has no TTY, so the CLI's readline fallback could never run there. The
card drives the same three Cindy auth calls as steps: request code, verify code,
and (when Cindy answers `select_account`) pick an account. Tokens go to the OS
credential store through `keytar` and are never sent to the browser — the card
only ever sees booleans and a masked identifier.

### Who may control this Host

Admission needs two facts: the switch is on, and the device is not explicitly
revoked. There is deliberately no per-device enrollment step, because the relay
only routes frames between devices of one Cindy account — a `link-open` that
arrives here is already same-account. Revocation stays honored, so an enrollment
UI can be added later without reworking this decision.

## Boundaries

- Not changed: the DSH Web shell, the shipped presets, and the user's main
  profile. The smoke test uses a disposable `DSH_HOME`.
- Out of scope by request: device management, revocation UI, remote-control
  configuration, and any QR surface.
- The relay's own source (`apps/server`) is not in the Cindy checkout, so relay
  behaviour here is taken from the shared protocol package both sides compile
  against, not from the server implementation.
- `fs-watch:<workdir>` is a legal topic that this Host deliberately does **not**
  accept: there is no file-watch engine behind it, so acknowledging it would
  promise `maker:file-browser:event` pushes that never come. File browsing works
  on demand (`fs:stat-path` / `fs:list-dir` / `text-file:read-preview`); only the
  live directory refresh is absent.

## Verifying by hand

```powershell
$env:DSH_HOME = Join-Path (Get-Location) '.sandbox/dsh-home'
dsh --profile cindy-smoke --from-default-profile web --dump-config
dsh plugin --profile cindy-smoke add .
dsh --profile cindy-smoke --dump-config          # Gate 1: composition
dsh --profile cindy-smoke --no-open --port 3081  # Gate 2: a second UI
```

Then, against `http://127.0.0.1:3081`:

```
GET  /api/dsh-cindy-host/status      → {"ok":true,"installed":true,"status":{…}}
GET  /?token=…                       → window.__DSH_BOOT__ lists dsh-cindy-host-demo
GET  /plugins/??dsh-cindy-host-demo/client.js&rev=…  → the card bundle
```

### The assembled Host, not the unit tests

```powershell
npm run verify            # unit tests + channel audit + acceptance, in that order
```

Each part answers a different question, and the order is deliberate:

| command | the question it answers |
|---|---|
| `npm test` | do the mappings, shapes and guards hold in isolation? |
| `npm run audit:channels` | is every channel the phone names either served, or declined **with a recorded reason**? |
| `npm run acceptance` | does the assembled Host serve them over the route a phone uses, and does every push it claims to make actually go out? |

`npm run acceptance -- --with-prompts` additionally drives real agent turns — a queue that
is genuinely held, the interaction round-trip, and the send paths — which is what takes
the report from "34/48 exercised" to **48/48**, at the cost of a few model calls. It is
off by default for that reason.

Both modes end with the two coverage lines, and those are the numbers to read first:

```
channel coverage: 48/48 served channels exercised
push coverage:    9/9 push channels sent
```

They were verified from a **cold start** — fresh process, zero counters, every session
cold — because that is where the cold-session defects hid, and because a coverage figure
read from a long-running instance's accumulated totals proves less than it looks like.

Before a handset session it is also worth a glance at `/api/dsh-cindy-host/status`:
`status.state` (`connected`), `status.host.online`, `status.login.authenticated`, and
`host.deviceId` — the last one is what the phone links to, so a changed id means the
phone will want a fresh pairing. `diagnostics.pushTotals` / `invokeTotals` are monotonic,
so "did the phone ever call X" and "did that frame ever go out" are readable from a
snapshot rather than reconstructed from a churning ring.

`npm run acceptance` exists because **every real defect in this Host was an
assembly bug** — a field named differently on the two sides of a seam, a
capability built and never forwarded, a channel implemented but unreachable. Unit
tests cannot see that class by construction; only a run against the assembled
Host can. The script drives the same self-test route a handset does and prints one
line per channel.

It is deliberately no substitute for a handset: it cannot see what the controller
*renders*. What it removes is the other half of the search space — the case where
the Host itself is the broken side.

Two habits it enforces on itself, both learned the hard way:

- **No vacuous checks.** The paging check first ran against a freshly created
  session with no transcript, so "paging advances" passed while testing nothing.
  It now finds a session that actually has rows — and has since observed a page
  answering `asked 3, got 5`, the boundary-group rule working on real data.
- **Report what was refused.** Every run ends with the channels the controller
  asked for that this Host refused, by count. Refusing an unimplemented channel is
  correct behaviour, but *which* channels those are is the evidence needed to
  decide whether one is worth implementing.

Prompts are opt-in (`--with-prompts`), because exercising the send paths starts
real agent turns and costs tokens.

## Observed result

With the switch turned on in that isolated profile, the Host:

1. read the Cindy session the OS credential store already held and refreshed it;
2. connected to `wss://device-link.cindy.com.cn/api/device-link/ws` and received
   `hello-ack` with a real `deviceId` and `userId`;
3. resolved real device names and platforms for the account through the device
   directory (`<phone>` / android, `YOP` / win32, …);
4. reported `connected` once a same-account Cindy client opened a link to it.

Turning the switch off returned the status to `disconnected`, cleared the device
ledger and the host identity, and left the process with **zero** established
sockets — the relay connection was genuinely closed rather than idled.

Note: the OS credential store is shared across DSH profiles (`keytar` service
`DSH Cindy Host`), so a session created by `npm run login` is visible to the
smoke profile too. The smoke profile itself only owns its settings document.

### Two installations on one machine need two credentials, and the rule is the *home*

That sharing became a real defect once this plugin was installed in the real deployment
alongside the sandbox: the relay's device identity comes from the **login** (the stored
credential carries the `deviceId` that `hello-ack` echoes), so two installations on one
credential present the same device — and the relay keeps **one** connection per device
(`4409: 同 deviceId 的新连接顶掉了本连接`). With the new reconnect ladder on both sides that
is not a brief overlap but a one-second kicking loop, and the controller's session list is
what the user sees while it happens.

So the entry is scoped by home: the **default** home (`~/.dsh`) keeps `session-v1`, and any
other `DSH_HOME` gets `session-v1@<digest>`.

The first version of that rule was wrong in a way only the real deployment could show: it
keyed on **`DSH_HOME` being set** rather than on **which home it names**, and this
deployment sets `DSH_HOME=C:\Users\<user>\.dsh` explicitly — the default home, spelled out.
The result was a Host that booted with *no* session ("重启 dsh 貌似不会自动连接 cindy",
with a login form for an account that was already signed in) and `no stored session` when
read directly. The rule now compares the resolved paths (`~` expanded, trailing separator
ignored, case-insensitive on Windows), which is also what makes it testable without
depending on where the test runs.

## What the phone found that the tests did not

Connecting a real handset surfaced eight defects in one session, none of which
any unit test could see. They are worth naming together, because the pattern is
the lesson:

| Symptom | Cause |
|---|---|
| prompts sent twice | `workingDir` on the wire vs `cwd` in the cache |
| no todo card | the phone picks that card by tool **name**, `TodoWrite` |
| no live reply | nobody held the `session:<id>` topic |
| spinner forever | turn end is signalled only by a session-scoped `maker:event` |
| queue buttons dead | ten queue channels, none implemented |
| inputs merged | the prompt identity was the relay id, not the phone's `clientId` |
| queue buttons NOT_AVAILABLE | the capability was built and never forwarded |
| cancel/edit NOT_FOUND | the controller's id is not DSH's `MessageId` |

Three verification habits would each have caught part of this:

- **Probes must enter through the branch that decides.** `probe-todo.ts` called
  the extractor directly and skipped the name gate, so it passed for a round
  while the phone rendered nothing.
- **Tests must not stub the seam under test.** The enqueue test replaced the real
  row builder, so a wrong field name survived a green suite.
- **A capability that is built is not a capability that is wired.** There is now
  an invariant test: every key the source seam produces must arrive at the
  channel layer.

### Pushed projections are a convenience, not a source of truth

The control stream *broadcasts* projection changes, and this Host treated those
frames as the only source. So a frame that never arrived was indistinguishable
from "nothing changed" — a goal existed while every status read answered `null`
for twenty seconds, and a queue fold reported empty while DSH held items.

`projectionMode: 'all'` on `sessionQuery.observeSession` computes the registered
projections on demand, and that is what the status reads use now:

```
before:  maker:goal:get-status → null   (20s, while a goal existed)
after:   maker:goal:get-status → { status: 'paused', maxTurns: 1, … }
```

`queueItemsFromInbox` is a faithful port of the controller's own
`queueItemsFromInbox`, so the queue the controller sees is the queue DSH holds.
The observation is a lease and is always released.

The same idea caught a second bug the fold had been hiding: a queued item's
optimistic row outlived the message it described. The durable user message *is*
the proof that DSH's inbox dropped the entry, so `promptRpcIdOf(event)` retires
that row and pushes the corrected projection to `session:<id>`.

### Two identities, and both send paths

A queued item has two ids, and confusing them fails quietly:

- the controller's `clientId`, which DSH persists as the prompt's `rpcId`, and
  which the controller retires its local submission echo on;
- DSH's durable `MessageId`, which is what `updateQueue` is keyed on.

Both send paths must therefore carry the controller's `clientId` as the prompt
identity — `maker:input:enqueue` **and** `maker:send`. Getting this wrong does not
produce an error: the draft stays in the composer, so the next thing the user
types is appended to it and both go out as one message (`也可能叫 progress哈喽`),
or the message sits "sending" and disappears on the next transcript read.

This is the defect that was reported as "第二句发送失败 / host failed to serve this
channel" and could not be reproduced from the Host in one session — two sends 15 ms and
4 ms apart came back as two independent turns. It was the **`maker:send`** half (the
enqueue half had already been fixed), and it is now **confirmed on the handset in the real
deployment**: the second message appears once, the composer clears, and the reply streams.

### Paging never splits a message

A message's rows (thought, tool call, answer) share one `createdAt`, and the
controller's cursor is exactly that timestamp. Cutting a group at the `limit`
means the next page filters with a strict `< cursor` and drops the rest, so those
rows become unreachable and the transcript shows a hole the user cannot page
past. `pageRows` finishes the boundary group instead.

### The model catalog has three ways to be silently wrong

- the label field is **`displayName`**, not `label`;
- plan mode is read from **`planMode.supported`**, an object, not a boolean;
- `MobileModelOption` carries **no provider id**, because the catalog flattens
  models out of their provider groups. So `maker:set-model` usually arrives with a
  model alone, and the Host resolves the provider from its own catalog rather
  than refusing a choice the user already made.

### Pushes are verified too, and counted monotonically

The reply settles the controller that asked; the **push** is what keeps a second
screen — and the same screen after a reconnect — correct. `npm run acceptance`
therefore checks both, and for pushes it compares a **monotonic per-channel
total** (`diagnostics.pushTotals`) rather than the ring of recent pushes:

```
PASS  a goal write is pushed to the session watchers       maker:goal:status-changed 5→6
PASS  a queue command is broadcast to the session watchers maker:input:projection     4→5
PASS  a live message is pushed to the session watchers     local-db:messages:created 2→4
PASS  a turn state change is pushed                        maker:event               5→8
```

The ring is only the last twenty entries and churns during a turn, so a count
taken from it can *fall* between two reads — a push that happened can look like
one that did not. That is not a hypothetical: it produced a false failure the
first time this check ran.

Two further self-inflicted false failures are worth remembering, because both
came from the Host being right:

- the script reused one `clientId` per run, and DSH dedupes a prompt by its
  `rpcId` — so the second run sent nothing and reported "no message pushed";
- a queued item can be admitted between two checks, so a late `NOT_FOUND` on an
  edit is DSH's own scheduling, not a defect.

## Controls that are owned by a preset, not by the Host

Plan mode is the sharpest example yet of a service that exists, works, and is
still unreachable from the Host context. In this deployment the Web bundle
**disables** the base `plan-mode` row:

```yaml
# @deepseek-ai/dsh-web-app/cordis.patch.yml
- id: plan-mode
  disabled: true
```

and each agent preset mounts `@deepseek-ai/dsh-plan-mode` inside the scope it
owns — `cordis`, `ptc`, and `standard` do, `minimal` does not. So
`ctx.inject(['planMode'])` never fires on the host plane, `agent.ctx.get('planMode')`
did not answer either, and the phone's plan switch answered *"this session
composes no plan mode"* while `maker:list-agent-commands` plainly listed `plan`.

What did answer is the thing the preset itself registered: the `/plan` command.
`dsh-plan-mode` registers it through the command registry of whatever scope it
was mounted in, and that registry already resolves per agent for the `/` palette
— so the switch and the palette read the same source:

```js
commands.find(agent, 'plan')                     // the per-session capability test
commands.execute(agent, '/plan' | '/plan off', [], signal)  // the switch itself
```

Notes that matter:

- the capability is `{ supported: ... }`, an object, and it is now answered in
  order of evidence: a host-plane service, then a **live** agent whose scope
  carries the switch, then the **default preset's own composition rows**
  (`agentPresets.compositionInventory()` → `{ isDefault, rows[].moduleName }`).
  Without the last step a freshly restarted Host would answer "unsupported" and
  take the control away from every controller until somebody opened a session;
- a row reported `'conditional'` (an unevaluated `!!js disabled` expression)
  counts as mounted — a refusal to evaluate is not evidence of absence;
- the command answers with human text ("Plan mode on." vs "applies from the next
  step"), not with DSH's `committed`/`queued` word, so the channel reports
  `{ outcome: 'accepted', message }` instead of inventing an outcome;
- permission presets are the opposite case and stay simple: `ctx.permissionPresets`
  **is** a host-plane service, so `permissionModes` comes straight from
  `presets.names` — verified live as `read-only` / `workspace-write` /
  `danger-full-access`.

## Effort is part of a selection, and a write nobody reports is invisible

`maker:set-effort` looks like a knob and is not one: `SessionSelectModelRequest
extends ModelSelection`, so effort can only be written **with** the model it
belongs to. Two things followed:

- the write re-states the session's own selection (`modelSelection.next ??
  lastUsed`, catalog default only for a session that never chose). Picking the
  catalog default would move the session onto another model as a side effect of
  changing effort — a different action than the user took;
- the **row** had `effort` hardcoded to `'default'`, so a write that landed was
  invisible: the composer reads the current value from the row, and the live check
  showed `set-effort high → {ok:true}` with the row still answering `default`.
  The row now carries the selection's `reasoningEffort`, and the same live run
  reads `effort=high → low → high` back. DSH also validates the value itself:
  a bogus effort is refused with *"provider … does not support reasoning effort
  …"* and the row keeps its previous value, which is the right shape for an
  invalid input.

`maker:set-fast-mode` stays unimplemented on purpose: every model in this Host's
catalog declares `supportsFastMode: false` and the capability says
`hasFastMode: false`, so the controller never draws the toggle.

### The forwarding bug, for the third time — and the fix that ends it

`setEffort` was built in the seam, forwarded through `capabilityProvider`, and
then left out of the **runtime's** hand-written field list, so the channel
answered `NOT_AVAILABLE` on a Host advertising four effort levels. The same class
of bug had already hit `queueControl`. The field list is gone: the runtime now
forwards the seam output whole (`capabilityProvider({ ...currentSeam, files,
goalWrite })`) and `capabilityProvider` remains the single place that decides what
the channel layer may see. Two of the three capabilities that live outside the
seam — `files` and `goalWrite` — are named explicitly because they come from
their own injections.

## Record what was asked, not just what was answered

Two diagnostics earned their place this round, both for the same reason: the
reply alone cannot explain a refusal.

- `maker:get-capabilities` now logs `ask=agentKind=…`. It showed the two linked
  desktop controllers asking about `codex` and `claude-code` and receiving
  `NOT_AVAILABLE` while every `pi` request succeeded — i.e. the refusals are the
  honest answer about harnesses this Host does not offer, not a broken catalog.
  Without the kind in the log, those four refusals per poll read exactly like a
  defect.
- The send channels now log attachments:
  `ask=attachments=2 form=mixed (not materialized)`. See below for why.

## Attachments: what the wire carries, and what this Host can serve

The phone sends attachments **inside the message**, not over a channel of their
own: `maker:send` and `maker:input:enqueue` carry
`files?: RemoteSerializedAttachment[]`, and `extractSendText` threw that away
without a word. Recorded shapes (`apps/mobile/src/session/types.ts`):

```ts
interface RemoteSerializedAttachment {
  id, name, path, ext, size, sha256?, category, mimeType,
  url?, originalName?, base64?, textContent?, truncated?, annotated?
}
```

The mobile app's two builders — `buildMobileRemoteFileAttachment(remotePath)` and
`buildMobileUploadedAttachment({ossKey, …})` in `apps/mobile/src/session/attachments.ts`
— fill neither `base64` nor `textContent`, and a search of the mobile sources
found no attachment path that does. So the wire carries two forms, and neither is
inline bytes.

1. **Uploaded** — the bytes are PUT to the account's OSS staging area
   (`POST /api/device-link/media/presign-put`, `apps/mobile/src/session/mobileAttachmentUpload.ts`)
   and `path` becomes a transit reference. **Served since this round**: see
   "Uploaded attachments are fetched with this Host's own account" below. It was dropped
   before, and that is what "发照片不成功, 一直转圈" was.
2. **Host path** — an absolute path on this machine (the file browser's
   "send to session"). **Served**, see below.

### Host-path attachments, implemented and measured

`host-attachments.js` reads the path through the composed filesystem and builds the
prompt parts DSH accepts (`PromptContentPart` in dsh-api-session-controller):

- `{ type: 'image', mediaType, data: <base64> }` for the four media types DSH admits
  (`png|jpeg|webp|gif`) — the Host promotes the bytes to a durable reference itself,
  so no upload is needed;
- `{ type: 'file', receiptId }` for everything else, where the receipt comes from
  `ctx.fileUploads.upload(agent, { data, name }, signal)` → `{ receiptId, file }`.

The extension and the declared mime type each get a say: a declared type outside
DSH's closed union is not accepted as an image, and the extension decides when the
declaration is unhelpful. Anything unreadable, oversized (20 MB), a directory, or
unresolvable is **dropped per attachment with a reason** — the prompt and its text
still go, because refusing a message over one attachment would be worse than sending
it without.

THE ECHO MATTERS AS MUCH AS THE SEND. The phone reads an attachment from the
message's **content JSON** (`readFileAttachments`), and it retires its optimistic
bubble by `clientId` — so an attachment that is not restated on the authoritative row
disappears the moment that row lands. `cindy-message-row.js` now carries them as
`files: [{ name, size, mimeType? }]` on the message's text row (or on a row of its
own when the message was nothing but attachments). An **image is reported as a file
entry on purpose**: the phone renders an image from a `url` or inline `base64` it can
fetch, and this Host serves neither, so a file chip at least keeps the attachment's
existence and name visible instead of silently dropping it.

Measured live, both paths end to end:

```
ask=attachments=1 form=host-paths
[user] files={"name":"package.json","size":1050}      ← the bytes this Host actually read
[assistant] got it

[user] files={"name":"probe-image.png","size":75,"mimeType":"image/png"}
[assistant] ok                                         ← DSH admitted the image part
```

### Uploaded attachments are fetched with this Host's own account

The phone never sends image bytes. It uploads them to the account's staging area and
puts an opaque **transit reference** in the message, and resolving that is the
controlled end's job — `packages/device-link/src/attachmentOssRef.ts` in the Cindy repo
is the contract, and the reference implementation of the receiving half is the desktop
being controlled (`apps/desktop/src/main/maker-ipc/normalizeAttachments.ts:336`:
`parseAttachmentOssRef` → `presign-get` → download → verify → hand the agent a real
file, then remove the staging object).

This Host now does the same, with the credential it was already logged in with — the
media API is scoped to the account, which is exactly why the login exists
(`src/host-media.js`):

```
POST {apiBase}/media/presign-get  { key }   → { getUrl }
GET  getUrl                                 → bytes (never through the relay)
DELETE {apiBase}/media            { key }   → the staging object, after use
```

`{apiBase}` is derived from the relay URL rather than configured separately
(`…/api/device-link/ws` → `…/api/device-link`), because a second setting could only
ever disagree with the socket that is actually connected. The token is the live one the
relay authenticated with, read at fetch time — **not** a fresh `restoreSession()`,
which would refresh and rotate the same refresh token concurrently with the running
Host (the failure that once cost a real login).

Three details were measured rather than assumed, and each one had already caused a
wrong conclusion:

- **The phones send the LEGACY scheme.** `apps/mobile/src/session/attachments.ts:189`
  builds `xdt-oss-attach://m/…`, not `cindy-oss-attach://…`. A classifier that knew only
  the current scheme reported a live photo upload as `form=host-paths`, which is how the
  first diagnosis of this bug went wrong. Both schemes are now recognized, and
  recognition is broader than parsing on purpose: a malformed reference is reported as
  `malformed-ref` instead of being mistaken for a path.
- **A caption-less photo is a message.** The phone sends `text: ''` with the attachment
  (`inputProjection.ts` → `buildQueuedTextMessage` → `text: trimmed`), and this Host
  refused it as `carried no text` *before* looking at the attachments — the actual
  spinner. What is refused now is having **neither** text nor a serveable attachment,
  which is the only case with genuinely nothing to run.
- **`x-oss-object-acl: private` is signed into the PUT URL.** An upload without that
  header is a 403, not a default-ACL upload.

The failure vocabulary is closed and small (`no-credential`, `presign-failed`,
`download-failed`, `oversize`, `size-mismatch`, `sha256-mismatch`, `aborted`), a declared
`size`/`sha256` is verified when present, and an attachment-only prompt whose bytes
could not be fetched is **refused with the reason** rather than sent as an empty prompt —
sending it would deliver a photo the agent never saw.

`tools/attachment-probe.mjs` is the only check that covers "the bytes reached the
model", because that part cannot be unit-tested: it stages a synthetic image with this
Host's own credential, sends the reference the phones build, and asserts the agent
describes the picture. Measured, twice (10/10):

```
PASS  the account staged the bytes        — key=cindy/device-link/…/b869f05e-….png
PASS  the staging upload landed           — PUT 200
PASS  the reference is one a phone would send — xdt-oss-attach://m/eyJvc… len=335
PASS  a caption-less photo is accepted    — ok
PASS  the answer names the colour that is in the image — 红色 Image received … 16×16 px, PNG, 79
PASS  the staging object was released after the prompt landed — gone
PASS  the probe session is hidden from controllers — status=deleted
10/10 checks passed
```

and `npm run acceptance` carries the cheaper half of it on every pass, so the message
shape cannot regress silently:

```
PASS  a caption-less photo is a message, and its bytes are what can fail
      — ATTACHMENT_UNAVAILABLE: this Host could not fetch the attachment: presign-get answered 400
PASS  a prompt with neither text nor attachment is still refused — BAD_REQUEST
```

### The bubble showed 没有可展示的远程路径

Reported from the handset after the send path worked: 图片发送成功之后，图片信息就从手机端
消失了, and the row read 没有可展示的远程路径. That string is the phone's own fallback
(`i18n/locales/zh-CN/message.json:261`, `missingRemotePath`), and this is the whole chain:

```
we served:  content = { text: '', files: [{ name: '368492.jpg', size: 311456, mimeType: 'image/jpeg' }] }
phone:      readFileAttachments → path = record.path ?? record.url → undefined
            buildFilePayload(name, '') → body = missingRemotePath
```

The phone reads the two kinds from **two different fields** (`messageNormalize.ts`):

- `files[]` → `{ name, path?, url?, mimeType? }`, and a file with neither `path` nor
  `url` renders as that placeholder;
- `images[]` → `{ url?, base64?, mimeType?, originalName? }`, where
  `uri = url ?? (base64 ? 'data:'+mimeType+';base64,'+base64 : undefined)` and **an entry
  with neither is dropped outright**.

So an image must travel in `images[]`. Why it never did: DSH's durable reference for it is
content-addressed and states that it is "never a filesystem path or bearer URL"
(`dsh-attachment` `ImageAttachmentRef`), so there was nothing to put in `path` — and the
media channel was out of scope. The way out is that the phone accepts an inline
**`data:image/...`** URI (`isPreviewableUri` counts it), and DSH already **has** the bytes:
`ctx.attachments.readImage(ref)` returns them, verified against the stored digest.

So the fold now hydrates just the page it is about to serve:

```
user row → content.files[{ … imageRef: <the whole durable descriptor> }]
         → hydrateImageAttachments(page, { readImage })      ← one read per page image
         → content.images[{ base64, mimeType, originalName }]   and files[] emptied
```

Two details, both learned the hard way:

- **The whole descriptor must travel**, not a convenient subset. The store validates the
  reference it is asked to read, so a handle rebuilt from `{attachmentId, mimeType, bytes}`
  failed *every* read while still looking correct — measured: `attempted: 1, served: 0`.
  The counter now says so out loud (`diagnostics.attachmentReads`), because "the photo does
  not render" otherwise has three indistinguishable causes: no handle on the block, no
  attachment service on this profile, or a failed read.
- **Hydration runs after paging**, so only the rows actually being served pay for reading
  image bytes; and one unreadable or oversized image (4 MB inline budget) costs that image,
  never the page — the row keeps an honest file chip rather than a fabricated path.

Verified against the user's own photo, byte for byte:

```
row:      files = null
          images[0] = { mimeType: 'image/jpeg', originalName: '368492.jpg', base64 len 415276 }
decoded:  311456 bytes, FF D8 … FF D9, sha256 = f9307d9e878c7e096dd98c343830926f067ffdde3f8d5b3f24139bd2ca185cbe
DSH said: attachmentId = sha256:f9307d9e878c7e096dd98c343830926f067ffdde3f8d5b3f24139bd2ca185cbe
reads:    attachmentReads { attempted: 1, served: 1, failed: 0 }
```

and `tools/attachment-probe.mjs` (now 13/13) asserts the same shape on a synthetic image on
every run, including that the inlined bytes hash back to what was uploaded:

```
PASS  the user row carries the image inline instead of a path-less file entry  — files=null
PASS  the inlined bytes are exactly the bytes that were uploaded  — 79B sha=f4555c6dc13c…
PASS  the inlined entry carries what the phone needs to render it  — mimeType=image/png originalName=probe-red.png
```

What is still not served is the *other* direction: an image the agent produced, or a
thumbnail for a file, still needs `device-link:media:fetch` (or a URL the Host serves that a
remote phone could reach — an HTTP URL on this machine is not reachable from the handset).

A photo the *user* sends is now rendered from its own bytes, and that is **confirmed on the
handset in the real deployment** ("我发送的照片我已经可以看到了") — the whole loop, on the
profile that actually serves the phone: the phone's upload → this Host fetching it from the
staging area with the account credential → DSH admitting it as a durable attachment → the
transcript read inlining those bytes → the bubble rendering them.

## Real scale broke the list: subagents, and a title fold per poll

Moving this Host from the sandbox profile to the real one — 219 sessions instead of 5 —
produced 任务列表一直在转圈 / 电脑暂时没有回应请求. Measured on the live instance through its
own channel, before any change:

```
local-db:sessions:list     12 061 ms   (219 rows)   ← the handset's responsiveness probe
local-db:sessions:list     12 723 ms   (2nd call)
maker:list-active           8 364 ms                ← polled constantly, needs one boolean
local-db:sessions:get       8 400 ms   (one session — it read the whole list to find it)
```

Two independent defects, both ours:

**1. Subagent runs were listed as tasks.** `~/.dsh/sessions` held 219 logs; nearly all of
them were delegated runs, and their headers say so:

```
7543226e-…           cwd=G:\Projects\tiny-world  agentPreset=code  delegationDepth=1  origin=subagent
95fb7595-…           cwd=G:\Projects\tiny-world  agentPreset=code  delegationDepth=1  origin=subagent
session-b9e98377-…   cwd=G:\Projects\tiny-world  agentPreset=code  delegationDepth=0  origin=(none)
```

DSH's own Web list shows only user-facing sessions — which is why the user had never seen
them — while this Host listed every one, as "Untitled DSH task", because the source ignored
`origin`/`parentSessionId`. They are filtered now at the **single point both readers share**
(`listItems()`), and `api-session/added` is filtered too, so a subagent cannot even push a
row into the controller's list and then disappear on its next read.

**2. Every list read folded every title.** A title is a log-backed fold
(`sessionQuery.readTitleSnapshots`, ~50 ms each) and the read folded all of them *inside the
request*: 219 × 50 ms ≈ 12 s, in front of a handset that gives up at 15 s. Now:

- the read folds **one bounded batch** (`titleRefreshBudget = 16`) and answers, so the rows
  the controller is about to show arrive in one batch's time;
- the rest are folded **behind the answer**, one batch at a time, by a single in-flight
  warm-up — the next poll serves them from cache and folds nothing;
- a title this Host changed (a rename) drops its cache entry immediately, and a 60 s TTL
  heals one changed by DSH's own title regeneration;
- `maker:list-active` and `maker:session-in-turn` no longer read rows at all: they ask the
  source for turn states, which is the same listing minus titles and header reads. They only
  ever needed one boolean.

The lesson worth keeping: **the sandbox was five sessions and milliseconds.** A Host that
serves a controller has to be measured on the corpus that controller will actually see, and
"one fold per row" is invisible until the row count is 219.

**Until the fix is loaded, the noise can be stopped without a restart.** The subagent half is
data, not code: the Host's archive flags (this plugin's own settings section) hide a session
from every controller, and a running Host adopts an **external** edit of its settings file —
the settings provider reports it as a `provider` change and the runtime re-seeds the flags.
Measured on the real deployment: 176 subagent ids written as `{ status: archived }` under
`dsh-cindy-host.sessionFlags` turned the controller's list into 43 real tasks immediately,
with no restart (backup kept beside the file). The latency half is code, and only a restart
loads it.

## A lost relay connection is retried, not reported dead

Reported from the handset, twice: 没看到 dsh, then 打开设置，显示断线了. The Host had been
connected for hours, lost its relay heartbeat, and — by its own design — stopped:

```js
// before: host.js
async function recoverFromDeadSocket() {
  await disconnect({ keepSwitch: true });
  status.setState('failed', '与 Cindy relay 的心跳已丢失');
}
```

`failed` is where the story ended. The socket was gone, nothing was scheduled, and the
phone had no DSH in its device list until a person walked over to the desktop and pressed
重新连接. On a *phone-controlled* Host that is a silent outage, and it is exactly what the
settings card showed: 断线.

The reference is the Cindy device-link **client**, which the user pointed at with "我印象中
它从来没有掉线过" — and it is right:

```
packages/device-link/src/client.ts
  reconnectBaseMs: 1_000      reconnectMaxMs: 30_000      reconnectStableResetMs: 10_000
  // 应用层心跳: online 后每 20s 发 ping; 连续 N 个周期无 pong 视为僵死, 强制重连
  // 入站业务流量会把这组计数清零
  type DeviceLinkStatus = 'stopped' | 'connecting' | 'online'
```

Three things follow, and all three are now true here (`src/host-reconnect.js`):

- **A lost socket is retried forever**, 1s doubling to a 30s cap, with **downward jitter**
  (0.7×–1.0×) so many hosts that lost the same relay do not come back in lockstep. The
  ladder resets after 10s of stable connection, so a Host that flapped for a week still
  retries in a second once the link is healthy.
- **There is a state for it.** The card's vocabulary had five states and none meant
  "retrying", which is *why* the Host had to call itself `failed`. It now has `connecting`
  (正在重连, warn colour) — the same middle state the client has.
- **The socket is not killed by silence.** Any inbound frame clears the missed-pong
  counter, not just `pong`: the client states this rule for its own watchdog, and a relay
  that keeps delivering presence and invoke frames while answering pings late was being
  declared dead mid-conversation. The miss limit is the client's 3.

Every path that used to give up now retries — a socket `error`, a socket `close`, the
heartbeat watchdog, and a socket that cannot even be **created** (booting before the
network is up used to leave the Host `failed` until somebody noticed). Turning the phone
switch off still cancels a queued retry: an explicit off means off. The card's 重新连接
button survives as an escape hatch that skips the wait and resets the ladder.

`diagnostics.reconnect` reports `{ attempts, pending, lastReason }`, because "the Host
vanished" and "the Host came back on its own" are indistinguishable from the handset
without it. `test/host.test.js` pins all three behaviours with injected timers: a closed
socket re-opens itself (status `connecting`, one retry queued at 700–1000 ms, connection
restored with no call from a person), switching off cancels the retry, and a failing
`openSocket` is retried rather than reported dead.

## The file browser's op set, read from the caller

The reference host serves fourteen `file-browser:remote-op` ops; the **phone asks
for nine** (`mobileMakerTransport.ts`): `caps`, `listDir`, `readFile`, `listAllFiles`,
`searchCollect`, `thumbnail`, `exportFileStart`, `exportFileStatus`. The write ops it
supports (`createFile`, `createFolder`, `writeFile`, `renameEntry`, `deleteEntry`) are
**never sent by the phone** — reading the caller first is what stopped a
`writeText`-backed implementation of ops nothing would ever call, and `ctx.fs` has no
mkdir/delete/rename anyway.

`searchCollect` is now served: the controller's shape (`{ matches, truncated,
totalMatches, totalFiles }`, no `ok`) with its own bounds — 500 matches collected,
`totalMatches` still counted past the cap, files skipped under `node_modules`/`.git`
and friends. Two things were measured rather than assumed:

- **`totalMatches` must be the real total.** Stopping the scan at the cap reported
  "1 match" for a search that found two, because the reference host gets the total
  from ripgrep while it truncates the list.
- **Listing first and resolving each path was the whole cost.** The first
  implementation read `listAllFiles` (6.1 s on this repository — it walks up to
  `LIST_ALL_LIMIT` entries, `node_modules` included) and then re-resolved every file.
  Walking the tree directly, reusing each directory entry's handle and never entering
  the skipped directories, took the same search from **6280 ms to 379 ms** with
  identical results (16 matches over 117 files).

The three ops that need the media pipeline answer in **their own documented shape**
instead of `unknown op`, so the controller degrades deliberately:

```
thumbnail        → { ok: false, code: 'THUMB_UNSUPPORTED', message: … }
exportFileStart  → { ok: false, message: 'file export needs the Cindy media pipeline…' }
```

## The alignment is now a check, not a belief

`npm run audit:channels` reads the channel names out of the phone's own transport
(`call('…')` literals), compares them with what this Host serves, and **requires every
refusal to be classified**. The current state:

```
channels a controller may name: 192
  served:      48
  declined:    144
  unclassified: 0
```

`served` is the number of channels in `SUPPORTED_CHANNELS`, so it moves whenever one is
added; the number that must never move is `unclassified`.

The 192 is not the phone's vocabulary: it is `device-link`'s own **shared allowlist**
(`packages/device-link/src/allowlist.ts`), which is what actually decides whether a
frame may cross the wire. Auditing the phone's `call()` sites alone left whole families
(`maker:worker:*`, `maker:team:*`, `git-context:*`, `maker:agent:*`, …) unseen — and the
desktop app is a controller too, in practice the one driving this Host. Reading the
allowlist instead found **67 channels nobody had decided about**; each is now either
served or declined with a recorded reason, several of them for a specific reason worth
naming:

| channel | why it is not served |
|---|---|
| `maker:steer` / `maker:abort-session` | the same effects this Host serves as `maker:input:steer` / `maker:input:stop` — the names the phone calls; nothing calls these |
| `maker:generate-title` | the *new-draft* title path; the session title path (`maker:regenerate-title`, what the rename box calls) is served |
| `maker:agent:*` | the controlled desktop's CLI agent runtime (install/version/status); DSH runs its agent in-process |
| `fs:resolve-path` | the desktop's @-mention path resolution; the phone's @ palette resolves through `maker:scan-at-resources` |
| `maker:set-writable-dirs` | the file sandbox's writable roots are DSH-owned policy, not a remote setting |

One of them was worth **serving** rather than declining: `maker:session-in-turn`. The
desktop calls it as a **stall watchdog** — *"when Generating looks stuck and no push has
arrived, verify the host is really still running; only `false` is safe to finish on,
never kill a slow turn that is genuinely working"* (`isSessionTurnRunningFor`). It
answers a bare boolean, and it is read from the **source**, not from this Host's cached
turn state: a missed push is precisely what it is probing for, and the cache is fed by
those same pushes. Measured: `true` while a turn runs, `false` once it ends, and `false`
for an unknown session rather than an error frame.

### The shortlist that decides what to serve next

The same audit now counts **call sites** for each declined channel, across both the
phone's `call()` sites and the desktop renderer's `t('<channel>')` / `invokeRemote(…)`
sites, and prints them ranked:

```
declined, but a controller calls it (ranked — the shortlist for what to serve next):
    3x  local-db:messages:around-client-id  — the newer history view; …
    3x  maker:message:delete  — the session log is append-only; there is nothing to delete
    2x  local-db:conversations:search  — reads this Host does not implement
    2x  maker:compact-session  — blocked by the phone's own 15s budget, not by Host work
    …
```

This exists because the two failure modes are not symmetric. A refusal nobody reaches
costs nothing; a refusal a live controller reaches is a feature that visibly does not
work — which is exactly how the watchdog was found, by hand, one round earlier. Ranking
by call sites turns that into a scan instead of a hunch: everything above is either an
out-of-scope family with a recorded reason, or a candidate with the reason written next
to it.

### A refusal is only as good as the client's handling of it

Declining a channel is half a decision. The other half is what the controller does when
it hears no: a designed fallback is a feature degrading deliberately, while a raw error
is a blank panel. So where one exists, the reason names it — and it was checked in the
client's source rather than assumed:

| declined | the client's own answer to it |
|---|---|
| `local-db:messages:view` / `around*` / `history:*` | `isHistoryViewUnavailable()` matches exactly `CHANNEL_NOT_ALLOWED \| UNSUPPORTED_CAPABILITY \| not registered \| No handler`, and the paged transcript this Host serves takes over |
| `maker:provider:list` | `useDeviceProviders`: *"仅结构化确认旧端没有 provider:list 时允许 capabilities-only 回退"* — the refusal is what makes the capability-only list legitimate instead of a guess |
| `sidebar-settings:get-project-order` | `SyncedProjectOrderSnapshot.available === false` → *"被控端没有这个接口，控制端应回退到自己的混排"*, with `UNAVAILABLE_PROJECT_ORDER_SNAPSHOT` shipped for it |

This is also why `maker:provider:list` must *refuse* rather than answer an empty success
(defect #18): an empty catalog is indistinguishable from "there are no models", so
answering it would take the fallback away from the client that has one.

### The failed-turn affordance, characterised instead of hand-waved

`maker:input:retry-last-error` / `maker:input:clear-error` /
`local-db:messages:dismiss-error` are the retry-and-dismiss buttons on a failed turn, and
they were declined for a vague reason ("retry lives in the provider layer"). The audit
now carries the real one, because it was read out of the client:

```ts
// CCAgentSessionView.tsx — the banner's trigger
// error-tail-banner: 会话尾部停在未忽略的 role='error' 行 → 输入框上方显示…
```

The affordance appears only for a **trailing un-dismissed `role='error'` message row**,
and this Host's fold emits no such row. So the buttons cannot appear at all — which is
what makes the refusal harmless, and is a much better answer than "retry is elsewhere".
Whether it should stay that way is now a decision with a stated shape, recorded as a
*candidate* in the audit:

> would need two halves: map a failed turn to a trailing `role: 'error'` row, and serve
> retry as a re-send of the last user prompt (or the shared continue prompt when the
> failed turn already produced output)

The supporting measurement: across every session log in this deployment (879 zstd
frames) the `turn/end` reasons that actually occur are `completed`, `interrupted`,
`aborted`, and `blocked` — **no failure reason has been produced yet**, so there is
nothing to translate today.

That list — `decided for now, but serveable` — was printing empty until this round: the
`candidate:` note a rule records was not copied into the row it was attached to, so the
"pick one up next" section could never show anything. It now names three candidates
(`maker:compact-session`, and this retry pair).


It exists because "the phone shows nothing" and "we chose not to serve that" are
indistinguishable from the outside: the first audit found **21 channels nobody had
decided about**, hiding inside a long list of deliberate refusals. Each one now has a
recorded reason, and the ones that are merely *not done yet* are listed separately:

| channel | state |
|---|---|
| `maker:get-context-usage` | **served** — `ctx.tokenMeter.measure(session).totalTokens`, with the window from `ctx.llm.resolveModelInfo(provider, model).context.contextWindow` |
| `maker:regenerate-title` | **served** — `ctx.sessionTitle.refresh(session)`, generate-only as the controller's contract says |
| `maker:compact-session` | **blocked** — see below |
| `fs:mkdir-p` | **blocked, not pending** — `ctx.fs` exposes no create-directory API at all |

Two of these were only findable by reading DSH's own services rather than assuming:
`ctx.sessionTitle.refresh()` is the manual title trigger, and `ctx.tokenMeter` /
`ctx.llm` answer the context question. Both follow the same rule as the reads above —
**no resume**: a cold session answers the empty value (`{ title: null }`,
`null`), which the controller already renders, instead of waking an agent for a
decoration. Measured:

```
cold session  → { title: null }                              131 ms
live session  → { title: "Acceptance probe one-word reply" } 717 ms
```

The regenerate call is generate-only: the controller persists what it gets through
`local-db:sessions:patch-meta`, which is why "nothing to name it with" is a *value*
(`{ title: null }`) rather than an error frame.

### Coverage, not just classification

Classification answers "do we intend to serve this". It cannot answer "has anything
ever actually asked for it", and the two are easy to confuse: `maker:list-agent-skills`
was classified *served* while every call to it returned an empty list, and the whole
approval path was implemented, wired, and never once reached. So the Host now keeps
**monotonic per-channel invoke and refusal totals** (`diagnostics.invokeTotals`,
`diagnostics.refusalTotals`), and the acceptance run reports what a run exercises:

```
channel coverage: 34/47 served channels exercised     # before the queue phase existed
  never called (by this run or any controller since the Host started):
    maker:input:move
    maker:input:remove
    maker:send
    …
```

The ring (`recentInvokes`, forty entries) cannot answer this — a polling controller
churns it within seconds, which is the same reason `pushTotals` exists for the push
direction. The tally is deliberately reported rather than asserted: some channels are
only reachable from a handset tapping a specific control, and failing on those would
push toward deleting the report instead of reading it.

Adding the report immediately paid for itself. It showed the file browser was never
exercised by any automated run, and probing it exposed a contract detail that no unit
test had covered: its op argument is `workdir`, **not** the `workingDir` every other
channel uses. The controller sends it even for the `caps` probe —
`caps: (workdir) => call('file-browser:remote-op', [{ op: 'caps', workdir }])` in the
mobile transport — so `{ op: 'caps' }` alone answers "invalid remote-op args". The
acceptance run now drives one op per family and pins the deliberate refusals:

```
file-browser:remote-op (caps)        { ok: true }
file-browser:remote-op (listDir)     12 entries
file-browser:remote-op (searchCollect) 35 matches
file-browser:remote-op (readFile)    package.json
file-browser:remote-op (thumbnail)   { ok: false, code: 'THUMB_UNSUPPORTED' }
```

The same run also covers the composer palettes and all four session controls, restoring
what each setter changes — 62 checks, up from 35.

With `--with-prompts`, the run additionally builds a **real queue** (a slow turn, then two
items enqueued while it runs) and drives every queue mutation against it:
`set-expanded`, `set-edit-lock`, `set-interaction-lock`, `update-text`, `update-content`,
`move`, `remove`, `steer`, `resume` — the channels whose defects a handset found, and
which the earlier version of this script could only reach *by luck*, because an idle
agent admits a prompt instead of queueing it. It ends with the interaction round-trip:
`maker:send` asks a question, the card is read from `maker:get-pending-interactions`, and
answering it by question text clears it.

```
channel coverage: 48/48 served channels exercised
push coverage: 9/9 push channels sent
85/85 checks passed
```

Both directions of the wire now have coverage evidence, and both are the same claim:
**every channel this Host serves, and every push it can send, has been exercised end to
end by a repeatable run** — not classified as implemented, exercised. The push half is
read from `pushTotals` against the same list the audit classifies
(`src/host-push-channels.js`), which moved out of the audit script the moment a second
caller needed it: two copies of "what this Host sends" would drift, and the drift would
be silent — a channel added to the Host and forgotten in one tool just stops being
audited.

48/48 is the claim worth keeping. The queue phase prints the invariant it depends on
(`items enqueued during a turn stay pending — acc-slow…, acc-a…, acc-b…`), and if the
model declines to ask a question the interaction phase prints a loud `SKIP` rather than
passing silently, because a silent skip is exactly how that path stayed broken in the
first place.

### Manual compaction is blocked by the *phone's* budget, not by this Host

`ctx.compaction.compactNow(agent, signal)` exists, the phone has an entry point
(`maker:compact-session`, `{tokensBefore, estimatedTokensAfter, noop}`), and the
reference `/compact` command runs the same call — so the Host side is a dozen lines.

It is not served anyway, because the **phone would abandon it first**:
`maker:compact-session` is absent from
`MOBILE_INVOKE_TIMEOUT_OVERRIDES_MS` (`packages/device-link/src/invokePolicy.ts`), so
it gets the 15s mobile default — and that file's own comment says the default was
tightened to 15s precisely so slow channels must claim a longer window explicitly. A
compaction is one LLM summarization call over the whole history; the reference
command has no such bound. Serving it would produce the worst combination: the phone
reports a failure while the Host finishes compacting the history underneath it.

The honest move is to leave it refused until Cindy gives the channel a real budget —
a one-line change there, not work here.

### The other direction: does the phone give *our* channels enough time?

The same audit now reads the phone's timeout table and lists served channels whose
handlers can outlast the 15s default. Seven appear, all of them channels that resolve
(or resume) a session's agent. Measured on this Host, that fear is unfounded:

```
cold session, maker:goal:get-status (a read, no resume)  → 114 ms
cold session, maker:set-plan-mode  (resumes the agent)   → 124 ms
same channel once warm                                   →   6 ms
```

So the list is a **regression guard**, not a defect list: it will light up if the
phone tightens its default further, or if a Host channel starts doing something slow.

### The push half, checked the same way

The goal names invoke **and** push channels, so the audit answers the same question
in the other direction: every push channel the phone handles must be one this Host
sends, or one it does not send *for a reason*. Constants are resolved to their values
first (`SESSION_ACTIVITY_CHANNEL` → `local-db:sessions:activity`), because a report
that prints `<CONSTANT>` rows and calls itself complete is not checking them:

```
push channels the phone handles: 31
  this Host sends:        9
  not sent, with a reason: 22
  unclassified:            0
```

The nine are `maker:event`, `local-db:messages:created`, `maker:input:projection`,
`maker:goal:status-changed`, `maker:interaction-request`, `maker:interaction-dismissed`,
`local-db:sessions:created`, `local-db:sessions:patched`, `local-db:sessions:activity` —
and they cover every push the phone handles **that has a fact behind it here**. The
22 are "no fact to report", which is a stronger claim than "not implemented":

- the log is append-only, so `local-db:messages:deleted` has nothing to announce;
- DSH sessions are never `closed`, which is the only state `maker:status-changed` retires;
- the roster is exactly one harness (`pi`) and never changes, so `maker:agents:changed`
  carries no information — the phone re-reads capabilities when it attaches anyway;
- `maker:provider:changed` would announce a provider registry this Host does not have
  (the same reason `maker:provider:list` is refused);
- `maker:event:batch` is an optional transport optimization behind a capability this
  Host does not advertise, and `maker:session-sync` is a desktop bulk frame — this Host
  sends per-event pushes plus an authoritative snapshot on attach.

### The context read is a read

`maker:get-context-usage` is answered **without resuming anything**: `ctx.sessions`
holds live sessions only, and a cold session answers `null`, which the controller
renders as "暂无上下文数据". Waking a session to answer a number the user only glances
at would be a side effect nobody asked for — the same rule the goal read follows.

The window is reported only when the provider discloses one (`LlmResolvedModelInfo`
carries an optional `context`). The request header's `maxTokens` is deliberately **not**
used as a window: that is an output bound, and a percentage computed from it would be
a number that means nothing. Measured live:

```
cold session   → { ok: true, result: null }
warm session   → { totalTokens: 51191, maxTokens: 1000000, percent: 5.1191 }
```

Two of the 21 were worth reading twice: `local-db:messages:view`/`around` and
`local-db:history:*` are the phone's *newer* history view, and refusing them is what
makes it page the transcript this Host does serve — a refusal that improves the
result, not a missing feature.

## What the session controls cost, measured

The four composer controls the phone draws from `maker:get-capabilities` were exercised
through the same channels the controller calls, on one session, reading the row back
after each:

```
maker:set-model            deepseek-flash → deepseek-v4-pro   row.model updated
maker:set-effort           low / max / off / high             row.effort updated each time
maker:set-permission-mode  workspace-write → read-only        row.permissionMode updated
maker:set-plan-mode        on / off                           accepted (and idempotent:
                                                              "Plan mode is already inactive.")
```

and all four are accepted **while a turn is running** — the session row is the authority,
so the picker's new value survives the next read.

The capability payload the pickers are built from, verbatim: four `availableModels` (each
with `efforts`, `effortDisplayNames`, `defaultEffort`), top-level `effortLevels`
(off/low/high/max), `permissionModes` (read-only/workspace-write/danger-full-access),
`planMode: { supported: true }`, `hasFastMode: false`. The audit flags
`set-plan-mode`/`set-permission-mode` as "slow channels with no phone-side timeout
override" because their code path resolves (and may resume) the session agent; measured
on a session untouched since the Host started, that resolve is **135 ms** (29 ms warm) —
far inside the phone's 15 s budget, so the flag is a shape warning rather than a latency
one.

One note about reading these back: a row read taken ~700 ms after a setter can still show
the previous value. Two seconds is enough. That is a property of the read, not of the
write — the same setter immediately before it had already returned `true`.

## What the controller reads, and not what we assume it reads

Four real-handset reports, four assumptions that survived unit tests and produced
nothing visible on the phone. Every one was settled by reading the controller's own
branch, and the push log now carries a `said` digest so the frames themselves can
be read back (`diagnostics.recentPushes[].said`).

### System prompts arrived as ordinary messages

DSH logs its prompt injections as messages, and **two** shapes matter:

```jsonc
// the system prompt itself
{ "type": "system/message", "message": { "role": "system", "source": { "kind": "plugin", "plugin": "@deepseek-ai/dsh-system-prompt" }, ... } }
// the runtime-context snapshot, re-injected EVERY turn — as a USER message
{ "type": "user/message",   "data": { "role": "user", "source": { "kind": "plugin", "plugin": "@deepseek-ai/dsh-system-prompt", "form": "snapshot" }, ... } }
```

The fold decided role with `role === 'user' ? 'user' : 'assistant'`, so the whole
system prompt rendered as an assistant reply and the "Current runtime context. This
snapshot supersedes…" snapshot rendered as something the user had said, once per
turn. `dsh-llm`'s `MessageSourceMap` names the categories (`user`, `plugin`,
`model`, `tool`), and `plugin` is what every injection carries — so the filter is on
the **source**, not the role, and a `plugin` message renders no rows at all. Verified
on the real transcript: 151 rows → 150 (exactly the one injection), zero rows
containing either prompt.

`plugin` also carries a `form`: `notice` is a one-line account DSH itself shows as a
collapsed row, so mapping those onto the phone's system card is a deliberate
follow-up rather than a guess made here.

### "Load earlier" re-fetched the same page forever

`oldestMessageCursor(loaded)` returns the oldest loaded row's **`id`**, and
`mergeEarlierMessages` merges only when it can still find that id
(`current.find(row => row.id === options.before)`). The Host treated `before` as a
`createdAt`, and `'2026-…' < 'session-…'` is true for every row, so each pull
returned the newest page again.

Two more things had to line up before the entry point could even appear:
`hasOlderMessagesByServerCount` answers **false** for an unknown total (deliberately,
so an entry point that leads nowhere is never shown), and the session row reported
`_count: null`. The row now carries its real row count — computed on the
**single-session** read, not the list the controller polls, so paging was not fixed
by making polling expensive. Live: page 2 from a row id returned three different
older rows, zero repeats, `_count.messages=150`.

### The spinner: three separate lies in one signal

The phone clears "thinking" only on an explicit terminal event, and the sequence we
actually sent was:

```
02:36:41.922 done      ← 1 ms after the assistant message
```

and, in a cleaner run, a `done` **31 ms after a live turn began**, then another
116 ms *before* the assistant's message was appended. Causes, all measured:

1. `sessionRowCache` is refreshed by a **list read**, so a `running: true` captured
   when a turn began outlived the turn that ended it — which silenced both safety
   nets (`pushTurnIdle` on attach, `reconcileTurnState`). The cache is now fed by
   every authority: `turn/start`, `turn/end` and the lifecycle events.
2. `api-session/status` **flaps**: it reports `running: false` between a prompt being
   accepted and its turn really starting. Reading that as the end is what sent the
   31 ms `done`. `turn/start` and `turn/end` are the real boundaries and are now what
   the plugin announces; `idle` no longer ends a turn in `turnEventFor`.
3. `reconcileTurnState` was armed **once per appended event** — a single turn armed
   dozens of timers and produced **eighteen `done` pushes**, each of which makes the
   controller finalize its streaming rows again. One pending check per session now,
   and a real boundary cancels it instead of re-arming it.

The corrected, measured sequence for one turn:

```
02:43:13.844 done                    ← attach announcement (session idle)
02:43:15.653 status isRunning:true   ← turn/start
02:43:15.806 local-db:messages:created  user "say hi"
02:43:16.684 local-db:messages:created  assistant "hi"
02:43:16.685 done                    ← turn/end, 1 ms later
```

### A goal that exists, answered as "no goal"

`applyGoal` in the controller reads the difference exactly: **`undefined`** (a payload
with no `result` field) means "unknown, leave the card alone", while an explicit
**`null`** means "confirmed no goal" and wipes it. The Host answered `null` whenever
the projection read failed or the goal key was not registered — and because a goal
that has not changed never pushes again, nothing brought the card back. An
unanswerable read now returns no `result` at all.

Two more goal gaps closed: `GoalPhase` is `active | paused | blocked | complete`, all
inside the controller's vocabulary, and the card only refreshes from
`maker:goal:status-changed` — so the Host now pushes that when the **projection**
changes (`applyControlFrame`), not only when the user's own write changes it.

## A refresh failure used to sign the user out

`restoreSession` runs on every Host start, and its failure path was:

```js
const refreshed = await refreshStoredSession(saved);
if (!refreshed.ok) { await clearSession(); }   // any failure ⇒ delete the credential
```

`refreshStoredSession` collapsed **every** exception — timeout, DNS, 5xx — into
"Cindy 登录态已过期". So one network hiccup permanently deleted a working session and
forced a fresh login, and a second Host instance on the same credential (its own
refresh rotates the refresh token out from under the first) did the same.

Now the service's **refusal** (400/401/403) is separated from its **unavailability**
(network, 5xx, 429): an unreachable service keeps the credential and tries with what
is stored, and a refusal is *reported* rather than acted on. `cindyRequest` therefore
carries `status` (a refusal) or `transport: true` (never arrived); a stub that hides
the status tests neither.

**Nothing automatic deletes the credential any more.** The card's login form keys off
the restore *result* (`resolved.ok`), not off the credential's presence, so a rejected
session still shows the form while the credential survives — which is what makes a
merely-raced rotation or a brief outage recoverable on the next start instead of
demanding a new login. Deletion is an explicit act only: the logout route and
`logout.js`, both through `forgetSession`. `test/auth-session.test.js` pins that rule
with the credential store stubbed, because it is the one behaviour here that is
destructive.

**Operational note:** run one Host instance per Cindy credential. Two instances
sharing one credential race on refresh — the second one's rotation invalidates the
first one's token.

`npm run acceptance` also guards the two fixes above rather than trusting them
forever: `paging advances strictly older` now requires the second page to contain
**different** rows (re-serving the newest page with older timestamps would still have
looked "strictly older"), and `no prompt injection reaches the transcript` scans a
real transcript for the system prompt and the runtime-context snapshot.

## Skills are read for the session's scope, and the scope key is the agent

`maker:list-agent-skills` answered an empty list **successfully**, on a Host whose
skill roots plainly hold skills and whose `/` command list was full. The registry
documented the reason in one line: *"Viewing scope (the calling agent); omitted reads
the global layer alone."*

Skills live in a layered registry (`dsh-skill`), and the layer is decided where the
provider was **registered**: host rows and repository plugins land in the global
layer, while a plugin mounted by an agent preset's standing mount — which is where
`skill-filesystem` and `tool-skill` live, per `standard/agent.cordis.yml` — lands in
that preset's layer. Reading from the Host's own context therefore asks about the
global layer, and the honest answer there is zero.

So the channel now passes the session through (`maker:list-agent-skills` already
carried `sessionId`; the Host was dropping it) and the read is scoped:

```js
const scope = await agentScopeFor(sessionId);     // live agent → resume → standing key
skills.list({ ...(scope ? { scope } : {}), ...(cwd ? { cwd } : {}) });
```

**The scope key is the agent object itself.** The first attempt used
`scopeOf(agent.ctx)`, on the reasonable-sounding theory that an agent's context
carries its scope tag — and a temporary probe printed `live=true ... scope=false`:
that context carries no tag at all. DSH's own skill tool settles it:

```js
// @deepseek-ai/dsh-tool-skill, in both the catalog and the loader path
scope: agent
```

Measured with the fix in place, on this deployment:
`live=true scoped=6 global=0`, and with no session id `scoped=0 global=0`. The six are
real user skills discovered under the shared agents root; a temporary `SKILL.md` added
to `<dshHome>/skills` appeared as a seventh and vanished again when it was deleted.

### The same menu, three different requests

"Live agents only, never a resume" was the second thing this read got wrong, and the
phone showed it as *commands present, skills absent* — because the command list beside
it **does** resolve the agent. Measured on one cold session:

```
maker:list-agent-skills   → 0     (live-agent lookup only)
maker:list-agent-commands → 6     (resolves the agent; this is what made it live)
maker:list-agent-skills   → 6     (same session, now live)
```

Every Host restart makes every session cold, so this was not an edge case: it was the
normal state of a session the phone had just opened. The scope now follows the same
rule as the command list — live agent, then resume — because two different answers for
one session is not purity, it is a missing menu.

A request naming **no** session is the new-task composer, and there the answer is what a
new session would offer:

```js
await ctx.agentPresets.standingKeyFor()   // "for a host reader with no agent …
                                          //  starts no agent, no session, and no turn"
```

DSH documents that method for exactly this reader, and it composes the preset's plugins
without starting anything. A session that *is* named but cannot be resolved still answers
nothing: inventing the default composition's skills for an unknown session would be a
claim about a session this Host cannot see.

Final state of the three paths, measured: cold session `6`, no session `6`, unknown
session `0` with `ok: true` (an empty success, which the controller renders as "nothing
to offer" rather than as a broken composer).

Two rules this read keeps:

- **an unknown session is still an empty success, not a refusal.** A Host composing no
  skill registry answers the same way;
- **nothing here is a decoration that costs a session its state.** The resume only
  happens for a session the controller explicitly named while composing a message — the
  same session the command list already resumed for that same tap.

## A message is rendered for a participant, not for every role

The runtime-context snapshot and the system prompt were the first two injections to
reach the phone as conversation: `role` alone turned them into an assistant reply and a
`Current runtime context…` user bubble. The fix at the time was to drop
`source.kind === 'plugin'`.

That was a denylist, and the next injection walked around it. The skills catalog is
emitted by `@deepseek-ai/dsh-tool-skill` as a **user message**:

```js
createUserMessage({ content: [...], source: { kind: 'skill-catalog', form: 'catalog', entries } })
// …and form: 'catalog', update: true for a replacement
```

so `<system-reminder> … <available_skills> …` arrived as something the user had said —
one bubble, every time the catalog changed. DSH had already stated the rule: a
`user/message` event carries **three** producers (a human prompt, a plugin notification,
and an injected goal round) and "all three project their `content` verbatim; `source`
tells them apart".

The test is therefore inverted — an allowlist of what a participant produced:

```js
const RENDERABLE_SOURCE_KINDS = new Set(['user', 'model', 'tool']);
if (sourceKind !== null && !RENDERABLE_SOURCE_KINDS.has(sourceKind)) return rows;
```

The kinds found across DSH's own packages are exactly `user`, `model`, `tool`, `plugin`,
and `skill-catalog`; every future one is producer-supplied context by default, which is
the safe direction for a transcript. A source that is absent entirely is still rendered:
DSH requires one on every message, so its absence means a shape this Host cannot
classify, and hiding a user's own words is the worse failure.

Verified on a real session (`588c7fe7`, "哈喽问候对话"): the latest page went from
three rows — assistant reply, the `available_skills` injection, and `哈喽` — to two,
with a scan for `available_skills|system-reminder|Current runtime context` finding
nothing.

## The approval and question cards needed to go *first*, not just be registered

The Host has listened for `approval/request` and `user-questions/request` since the
beginning, and the phone still never saw a single card. The tool call simply hung: the
session stayed `running`, `maker:get-pending-interactions` stayed `[]`, and the model
was eventually told its own question had been "interrupted after it was recorded, but
no result was durably recorded".

Two independent reasons, both invisible from the Host's own diagnostics:

**1. The dispatch is agent-scoped.** DSH raises both waterfalls through
`scopeTarget(agent, agent)`, and Cordis admits a listener to a filtered dispatch only
when it is global, untagged, or tagged with the dispatch key or one of its ancestors:

```js
// cordis EventsService.dispatch
filter((hook) => hook.global || !filter || filter.call(thisArg, hook.ctx))
```

A host-plane observer is none of the latter, so the listener was filtered out before it
could run. `{ global: true }` — "receive the event regardless of context filter checks".

**2. The Web bundle parks the chain first.** `dsh-api-remotes` registers its own
listener on these same events and forwards them to a browser client:

```js
// @deepseek-ai/dsh-api-remotes
return ctx.on(event, function (request, next) {
  return forwardWaterfall(queue, event, request, { … }, next);   // holds a
});                                                              // Promise.withResolvers()
```

It does not call `next()` until that remote answers, and a waterfall is a chain: a
listener registered **after** it never gets a turn. So the Host's answerer is registered
`{ prepend: true, global: true }` — first say when a Cindy controller is watching, and
`next()` when none is, which hands the question back to the browser path unchanged.

Measured on this deployment, before and after, with a fresh session and a subscribed
controller:

```
before   ask_user_question → session running forever, pending [], no push
after    ask_user_question → card in 3s: { kind: 'ask_user_question', requestId: 'dsh-question-1', … }
         maker:resolve-interaction { kind: 'ask_user_question', answers: { 'Which colour?': 'blue' } }
         → accepted, pending 0, tool result {"answers":[{"id":"colour","selected":["blue"]}]},
           agent continues: "You picked **blue**."
```

and the approval seam on the same plumbing, by making the agent escalate out of its
sandbox:

```
card in 3s: { kind: 'permission', requestId: 'dsh-approval-2', toolName: 'write',
              reason: 'escalate sandbox to danger-full-access: …' }
deny → accepted, pending 0, tool result isError: 'the user rejected escalating this
       operation to "danger-full-access"', agent stops, and no file is written outside
       the workspace
```

`test/dsh-plugin.test.js` pins both options through the plugin's real `apply`, because
missing either one is silent: the Host's diagnostics show a healthy session and a
waiting tool call, and only the phone knows nothing arrived.

### …and then the frame itself was the wrong shape

Even with both answerers registered, the first real handset test produced **no card** —
and the Host logs said everything was fine:

```
04:59:29 maker:interaction-request watchers=1
         said={"kind":"permission","requestId":"dsh-approval-2","sessionId":"a15dacf0…",
               "toolName":"write","reason":"escalate sandbox to danger-full-access…"}
```

A card **was** created, and it **was** pushed to the one watching controller (the phone).
Both clients, though, read the payload as `payload.sessionId` plus a **nested**
`payload.request`, and drop anything else in silence:

```js
// apps/mobile/src/session/remoteSessionStore.ts
const sessionId = readString(payload, 'sessionId');
const request = isRecord(payload.request) ? payload.request : null;
if (sessionId && request) this.applyInteractionRequest(sessionId, { request, … });
// apps/desktop/src/renderer/lib/makerChatStore.ts
const payload = raw as { sessionId?: unknown; request?: { requestId?: unknown; kind?: unknown } };
```

The Host was sending the request **flat**. So the failure was invisible from every
direction except the screen: the registry held the card, `maker:get-pending-interactions`
returned it, the push went out with a watcher — and nothing rendered.

What made this hard to see is worth recording: **the list path answers this same nested
shape**. `maker:get-pending-interactions` returns `{ request: {…} }` entries, so a test
that goes through the list cannot tell a correct push from a broken one. The unit test
made the same mistake — it asserted `payload.kind === 'permission'` on a flat payload, so
it passed while clients dropped every frame. Both are fixed:

- the Host pushes `{ sessionId, request }` from both answerers;
- `test/host.test.js` asserts the nested shape (`payload.request.kind`, …);
- `tools/acceptance.mjs` asserts the **frame**: `recentPushes` for
  `maker:interaction-request` must have `watchers > 0` and a `said` digest containing the
  nested `"request"` and the request id.

Confirmed on a real handset after the fix (`ask_user_question` answered normally from the
phone). The lesson generalises past this channel: **a push is only verified when the
payload the client's handler reads has been asserted, not when the same data can be
fetched another way.**


### The card payloads, checked against the controller's own builders

The request side is this Host's, but the **decision** side is the controller's, and the
two vocabularies have to line up or the card is drawn and cannot be answered. From the
Cindy sources:

```ts
// packages/maker-shared/src/interaction.ts
export function buildAskUserQuestionDecision(answers: Record<string, string>) {
  return { kind: 'ask_user_question', answers };        // keyed by question TEXT
}
// permission decisions carry exactly: behavior: 'allow' | 'deny'
```

which matches this Host's `QUESTION_KIND = 'ask_user_question'` plus
`questionAnswerOf`'s text-keyed lookup, and `decisionOutcome`'s
`'allow' → 'allowed-once'` / everything else → `'rejected'` (fail-closed).

Two deliberate choices on the request side, both verified in the same pass:

- the permission card carries **no** `canAlwaysAllow`, so the controller never offers
  "always allow": DSH's approval vocabulary here is `allowed-once` / `rejected`, and
  advertising a persistence option this seam cannot honour would silently downgrade the
  user's intent;
- a question answered by **text** is matched back through the questions that were asked,
  and anything the controller returns that is not one of the offered labels is carried
  as DSH's `custom` rather than dropped.

A decision whose kind does not match the pending entry is refused (`{ accepted: false }`)
rather than acknowledged — the controller keeps the card open instead of believing it was
answered. Measured directly: sending `{ kind: 'question', … }` to a question card yields
`accepted: false`, and `{ kind: 'ask_user_question', answers: { 'Which colour?': 'blue' } }`
yields `accepted: true`.

### "Watching" is not "belongs to the phone"

The answerer originally claimed a card only while a controller was subscribed to that
session (`watchersFor(sessionId) > 0`), and passed everything else down the chain so the
desk could answer it. That guard is right in spirit and wrong in this case: leaving a
session unsubscribes its topic, so an agent that asks something **after the user looks
away** had its question handed to the Web bundle's remote forwarder — which parks it
waiting for a browser. Measured, on a real session:

```
attach session → unsubscribe → agent asks a question
  pending while unwatched        = 0
  pending after re-subscribing   = 0     ← the card is gone for the phone, permanently
  session                        = running (forever; no card anywhere the user is looking)
```

The distinction the fix makes is between *currently watching* and *belongs to the phone*:
a session this Host has served to a controller at least once in this process keeps
claiming its cards, and the card stays discoverable through
`maker:get-pending-interactions` even while nobody is subscribed. A session no controller
has ever attached to is still the desk's, unchanged. Re-measured after the fix:

```
attach session → unsubscribe → agent asks a question
  card in 3s: { kind: 'ask_user_question', requestId: 'dsh-question-1', … }
  maker:resolve-interaction { kind: 'ask_user_question', answers: { 'Pick one': 'A' } }
  → accepted, agent continues: "You picked **A**."
```

The card's own budget came with this: it was the registry default of **two minutes**,
which is the wrong shape for the surface being served. The card has no countdown, the
user may be away from the phone, and the path this replaces waits indefinitely — so a
short Host timeout is strictly worse than the reference. Half an hour, with
`maker:input:stop` settling a card immediately as the escape hatch, mirrors the reference
while still bounding a forgotten turn.

`test/host.test.js` pins both halves: an untouched session still defers (`null`), and a
session that was attached to and then looked away still lists its card and accepts the
answer.

## The list spinner reads the row, so the row had to be patched

The report was 思考中 outliving the turn — "agent 已经结束了，但我这边还是显示 思考中",
in an ordinary conversation and again when a goal round ended. The Host's own state was
settled every time it was inspected: `row.running=false`, `maker:list-active` empty,
`maker:session-in-turn` false, queue empty, and a `maker:event {type:'done'}` had gone
out with `watchers=1`.

The reason is that **two spinners read two different things**. A terminal `maker:event`
clears the composer and finalizes streaming rows; the **session list**'s running badge
reads the cached row it already holds, and that row only changes when something patches
it. This Host's list-level patch carried `updatedAt` and nothing else:

```js
// src/session-publisher.js — before
else if (item.kind === 'session-status') publish(ws, subscribers,
  'local-db:sessions:patched', { sessionId: item.sessionId, patch: { updatedAt: item.occurredAt } }, record);
```

so a row whose optimistic start had set `running: true` kept it, and the list went on
spinning after the answer had arrived. It is the same class as 缺陷15 and 缺陷19 and a
different surface: those were about *whether* a terminal event is sent, this is about
which reader is listening.

The fix is `publishRowTurnState(sessionId, running)`, published at exactly the two
moments the `maker:event` frame is (DSH's own `turn/start` / `turn/end`, which the plugin
drives) and never from the flapping `idle` phase — a row must not assert a turn state the
Host cannot stand behind:

```
local-db:sessions:patched { sessionId, patch: { running, updatedAt } }
```

Delivered **once per controller**, to the union of the `sessions` topic holders and that
session's watchers: a phone sitting inside one session holds both topics, and a row patch
is a state assertion rather than an event, so the same reader receiving it twice is pure
duplicate work. That dedupe is not cosmetic — it is what makes "one patch per turn
boundary" checkable from the frame log. The first version published down both paths, and
the existing frame-count assertion caught it immediately (`3 !== 1` on attach).

`test/host.test.js` pins both readers: a controller holding *only* the list topic gets
exactly one frame for a finished turn (the case that was broken), and a controller
holding both topics gets one `maker:event` plus one row patch, not two row patches.

## A subscription the relay cannot reach is not a subscription

The other half of the same report — 「我在这边一直盯着这个屏幕，但是他还是一直在转圈思考中…
我必须要返回上一页退出会话重新进才能看到你的回答」 — was measured with the frame log on
both sides of the relay, and the Host was the one at fault:

```
09:17:38  presence-changed  { deviceId: <phone>, online: false, lastSeenAt: 09:17:42 }
09:18:29  last request from the phone
09:18–09:2x  Host pushes: local-db:messages:created …, maker:event {type:'done'}, row patches
          → every frame dropped by a relay with no route to that device
```

The Host held a subscription set it had no way to check, and `online:false` was the only
moment the relay ever said so. Three changes follow from that one fact:

- **`presence-changed{online:false}` drops the device's subscriptions** — the `sessions`
  topic and every `session:*` topic it held. Pushing into a route the relay has already
  disowned is not delivery, and treating it as delivery is what kept the spinner alive.
- **The sessions it was inside are remembered** (`watchedSessionsByDevice`), so its next
  `link-open` can be answered with the turn state instead of silence. The announcement is
  sent only when the cached row positively says the turn is over: a cold row is never read
  as idle, so a live turn is never cleared by this path.
- **The unwatched fallback in `announceTurnIdle` skips unreachable devices.** It exists to
  repair a controller whose subscription died with the process, so it fans out to
  controllers with no watchers for the session; a device the relay has declared offline is
  not told and, crucially, **not counted as told** — the de-duplication entry that keeps one
  turn boundary to one `done` is a claim that the frame arrived, and the re-link repair
  depends on that claim being true.

The de-duplication itself is a `device × session` timestamp with a 30 s window, recorded by
every terminal announcement (the session watchers, the unwatched fallback) and consulted by
the `link-open` repair. It is needed because the two paths genuinely race: the
`device-link:subscribe` that attaches a controller announces the terminal state it finds,
and the re-link that follows immediately reaches the same device for the same turn — one
`done` too many makes the controller finalize its streaming rows again.

`test/host.test.js` pins both directions with an injected clock: a device declared offline
receives nothing (including a turn that ends while it is away) and is told the truth when
it links again after the window; a re-link inside the window repeats nothing.

## 一次未处理的 rejection 会结束整个 dsh web

手机报「DSH 掉线了」的那一次，原因不在中继也不在网络。证据链（时间为 UTC+8）：

```
17:30:10  用户从手机发来「我已经重启了。」（进程 17:29:04 启动）
17:30:12  本轮 turn 113 开始；同一时刻我启动了 tools/acceptance.mjs --with-prompts
17:30:23  turn/end {"reason":{"kind":"interrupted"}}   ← 回合中途进程消失
17:30:24  settings.yaml 与 acceptance-probe 会话日志的最后几笔写入（退出前的落盘）
17:32:35  用户手动重启，cordis.yml 重新生成
```

Windows 事件日志里**没有** node.exe 崩溃记录，`~/.dsh` 里也没有崩溃报告，说明不是原生
崩溃。原因在 DSH 自己的启动代码里：

```js
// node_modules/@deepseek-ai/dsh-app-boot/lib/index.js — installFailLoud
const handler = (err) => {
  …
  proc.stderr.write(`${binName}: fatal load failure: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  …
  proc.exit(1)
}
proc.on('unhandledRejection', handler)
```

即：**进程里任何一处未处理的 promise rejection，都会让 `dsh web` 把堆栈写到 stderr 并
`exit(1)`**。`exit(1)` 是正常退出，系统层面因此什么都没有；而本插件住在同一个进程里，中继
websocket 随之断开，手机看到的就是「掉线」，直到 2.5 分钟后手动重启才恢复。

Cordis 不会替插件兜底——它的监听器分发没有 `try`/`catch`：

```js
// @deepseek-ai/cordis/lib/index.js
emit(...args) { this.dispatch("emit", args).map((cb) => cb(...args)); }
```

所以一个插件抛出的异常不是「这个插件坏了」，而是「桌面的 DSH 没了」。据此把本插件所有边界
都封住：

- socket `'message'` 监听器不再裸调 `handleFrame`；
- invoke 应答路径（`fitReplyToFrame` + `send`）不再可能在 `.then(onOk)` 里抛；
- 心跳、重连、设备目录、活跃会话播报这些浮动 promise 全部挂上 rejection handler；
- Cordis 的 `session/event` 监听器整体包 `try`/`catch`——它跑在 DSH 自己的事件分发里，
  抛出去就没人接。

捕获到的东西统一进有界的 `handlerErrors` 环形缓冲，并通过 `/status` 的
`diagnostics.handlerErrors` 暴露（含 `where`、`message`、前 6 行 `stack`）。**这个数组非空
意味着刚刚挡住了一次会让整个 dsh web 退出的异常**，而不是「Host 扛住了」。
`test/host.test.js` 钉住这一点：某个通道抛错时，控制器仍然收到 `INTERNAL` 应答，错误被记录
而不是逃逸。

排查同类问题的最快证据是**启动 `dsh web` 那个终端的 stderr**：那一行 `dsh: fatal load
failure:` 后面就是完整的堆栈，它指向真正的抛出点。

## 删除 / 归档 / 置顶: one channel, and only one of its fields had a counterpart

The controller's session menu is four actions and **one** write. Desktop
(`apps/desktop/src/renderer/lib/sessionService.ts`) and mobile
(`apps/mobile/src/session/useSessionListActions.ts`) both send:

```ts
invoke(deviceId, 'local-db:sessions:patch-meta', [sessionId, patch])
type SessionMetaPatch = Partial<Pick<RemoteSession, 'status' | 'title' | 'pinnedAt'>>
// 归档 `{ status: 'archived', pinnedAt: null }`   删除 `{ status: 'deleted' }`
// 置顶 `{ pinnedAt: <ISO> }`                       重命名 `{ title }`
```

Only 重命名 has a DSH counterpart (`sessionController.rename`), and it works end to end —
renaming the probe and re-reading the list returns the new title from both the reply and
the next listing. The other three were answered with the *unchanged row*, which is not a
refusal at all: the controller applies only the fields it wrote, taken from this reply,

```ts
// apps/mobile/src/session/useSessionListActions.ts
const updated = await sessionMetaWriteQueue.enqueue(…);
remoteSessionStore.applySessionPatch(shardId, session.id, pickWriteFields(updated, fields, …));
```

so an unchanged row is an instruction to revert the user's edit. That is what "点了没反应"
was.

DSH sessions are a log-backed store with no archived, deleted or pinned state, so these
three are now this Host's own bookkeeping (`src/session-flags.js`), persisted in this
plugin's settings section as `sessionFlags` and folded onto the row at every read path
(list, get, and the row echoed back to a writer). Three decisions are deliberate:

- **删除 hides; it does not destroy.** The session leaves what this Host's controllers
  see; DSH's log and the desk's own DSH UI are untouched, and the archive view restores
  it. A Host that deleted DSH data on a phone tap would be a far worse failure than a
  hidden row.
- **A hidden session is out of `maker:list-active` too.** The phone does not show its row,
  so an entry for it would light the running badge from a session nobody can open.
- **The other controllers are told.** The write is echoed as a row patch to every device
  holding that row — the writer's own `sessionPendingWrites.consumeMaskedPush` exists for
  exactly that echo — instead of leaving them on a stale status until their next read.

### Why DSH's own session list will never show this

Reported from the handset, on both actions: "手机端归档了，DSH 没有归档 / 手机端已经删除了，
PC 还在". The Host half is complete and was verified on the live process — the phone's writes
persist and every controller is served the new status:

```
sessionFlags:
  e85dce4e-…: { status: archived }      ← 哈喽
  4afc2caf-…: { status: deleted }       ← 打招呼问候
local-db:sessions:list →
  id=4afc2caf-… status=[deleted]
  id=e85dce4e-… status=[archived]
```

What still lists them is **DSH itself**, and it is a boundary rather than a missing wire —
DSH has no writable field and no command for this state at all:

- `SessionSummary` is exactly `sessionId, updatedAt, running, blank, parentSessionId?,
  origin?, cwd?, projections?` (`dsh-api-session-controller/lib/types/types.d.ts:145`) —
  no status, no archived, no hidden, and `SessionListRequest` is `{ cursor? }`, so not even
  a filter to honour;
- the controller's whole command surface is `list / create / rename / fork / resolveAgent`
  — there is no delete, archive or hide;
- a full sweep of the installed packages for `'archived'` hits only the **workspace**
  controller (`archivedSessionIds` in `dsh-api-workspace-controller`) — a different concept
  that never touches a session row;
- the one list-hiding mechanism DSH does have, `blank`, is *derived* from an empty log
  ("lists hide blank sessions"), not a flag anybody can set.

Worth stating plainly, because it is the difference from a real controlled desktop: there,
归档/删除 write **the desk's own database**, so the desk's Cindy UI reflects them by
construction — the desk *is* the store. Here the store is DSH's, which has no such field, so
the flags are authoritative for every Cindy controller of this Host (phone and any desktop
client alike) and invisible to DSH's own UI. Chosen deliberately over the two alternatives
that would make it visible: rewriting the real session title (`[已归档] …`, dirty and
clobberable by title regeneration), or deleting the session's files outright (DSH exposes no
API for it either — filesystem surgery, and the log is gone for good).

A consequence to know when testing: a **deleted** row is gone from every client view, so the
phone offers no way to bring it back; clearing the flag on the Host is the only restore path.

### Where the durability actually lives: the Host is the authority, the clients are caches

Asked directly — "DSH has no such field, so how does Cindy know it was archived?" — the answer
is that Cindy does not *discover* it. Three layers:

1. **The controller said so.** 删除/归档 is a write the controller initiates
   (`local-db:sessions:patch-meta`), applied optimistically on the device before the round trip
   (`useSessionListActions` → `remoteSessionStore.applySessionPatch`). The phone rendering
   "已归档" is the phone's own write, not a read.
2. **This Host is now the durable authority for it** — the `sessionFlags` section. The status
   travels back on three paths: the reply row (which decides whether the writer keeps its edit),
   `local-db:sessions:list` / `get` (any later read, on any device), and the
   `local-db:sessions:patched` push (the other controllers). A second device can only have
   learned it from here, and a phone that lost its cache re-learns it on its next read. Before
   this existed the flag had no home at all outside the one device that made it.
3. **Both clients do keep a local copy of the list, status included** — and both deliberately
   refuse to cache a *deleted* row:
   - phone: `apps/mobile/src/session/mobileHomeListCache.ts` — AsyncStorage under
     `xdt.mobileHomeListCache.v2.<userId>`, painted on cold start and reconciled when the fresh
     list arrives; `coerceCachedSession` accepts only `'active'`/`'archived'` (anything else,
     `deleted` included, returns null) while `pinnedAt` is kept;
   - desktop: `apps/desktop/src/main/device-link/mirrorCacheStore.ts` — the list snapshot is
     written atomically to `session-list.json` beside per-(device, session) message pages, and
     its `coerceCachedSession` applies the same rule (`status !== 'active' && !== 'archived'`
     → null), with `'status'` in the field whitelist.

So a cached list is a *copy of what this Host answered*, not a second source of truth.

This also explains why 删除 has no phone-side undo while 归档 does. When the status patch reaches
the client store, `remoteSessionStore.applySessionPatch` drops the row from the shard for both
statuses, and for `deleted` it additionally clears the message cache and the on-disk history
(`clearSessionMessageCache`, `clearHistoryDisk`). An archived session can therefore be re-read
and shown in the archive view, while a deleted one has nothing left to render — a client-side
choice, not something the Host can serve around.

### The write that looked right and was not

The first implementation persisted with `scope.update({ sessionFlags })`, and the whole
round trip passed in unit tests. On the live Host it did this:

```
settings loaded:      probe status = archived     ← the flag did survive the restart, as designed
restore ({status: 'active'}):  reply status = active
pin     ({pinnedAt: …}):       reply status = archived   ← it came back
settings file:        { status: archived, pinnedAt: '2026-01-01T00:00:00.000Z' }
```

`update` **deep-merges** its patch into the namespace's user section, so writing "no flags
for this session" merged into nothing and left the archived flag on disk; the next
settings commit re-seeded the store from that value and the session stayed hidden however
often the user pressed 恢复. `replace` is the wholesale/removal path but would have to
restate the entire section (freezing composition defaults into the user layer), so the
write is now a single path-addressed op:

```js
ctx.settings.mutate(settingsNamespace(SETTINGS_NAMESPACE),
  [{ op: 'set', path: ['sessionFlags'], value: sessionFlags }])
```

`test/dsh-plugin.test.js` drives that writer over a merge-faithful section and asserts the
removal lands, so the deep-merge trap cannot come back silently. Re-measured live:
`archived → active → pin(active) → unpin → deleted → active`, ending at `sessionFlags: {}`
with no residue.

The same live pass produced the acceptance checks — a reply-row assertion for each action,
the pushed frame with `watchers=3`, the list and live-list agreement, and a 恢复 that
leaves the probe exactly as it was found:

```
PASS  归档 answers with the row the controller will store  — status=archived
PASS  the archive is pushed to the controllers holding the row  — watchers=3 said={"patch":{"status":"archived",…
PASS  an archived session is served as archived, not as active
PASS  an archived session cannot light the running badge
PASS  删除 answers with the row, and the list agrees  — reply=deleted list=deleted
PASS  置顶 answers with the pin the controller caches  — pinnedAt=2026-01-01T00:00:00.000Z
PASS  取消置顶 takes the pin back out of the row  — pinnedAt=undefined
PASS  恢复 leaves the session exactly as it was found  — status=active pinnedAt=undefined
channel coverage: 48/48 served channels exercised
push coverage: 9/9 push channels sent
95/95 checks passed
```

## 收尾：媒体取件补齐 + 历史视图通道

这一节记录最后补齐的两块能力，以及它们各自解决的手机端现象。

### 为什么手机打开会话只显示一两条、重进还会丢历史

两个原因都不在被控端，但只有一个能被被控端修好：

1. **页是客户端自己定的 20 行。** `apps/mobile/src/session/messagePaging.ts` 的
   `MESSAGE_FETCH_PAGE_SIZE = 20`，打开会话的请求永远走 `[20,10,5,1]`
   （`apps/mobile/app/sessions/[sessionId].tsx`）。而这里的一行 = 一个内容块，所以
   **一个 turn 就能占满一页**：实测「画一只小猫」最新一页 21 行，正好只有最后一个 turn，
   而整段是 81 行。被控端能做的是把**最新一页**加宽（`NEWEST_WINDOW_ROWS = 200` +
   256 KiB 文本预算），短会话因此一次到齐；带游标的翻页仍严格按 `limit` 答。
2. **客户端的连续性规则。** `setLatestMessageWindow` 在满页时丢弃「无法证明相接」的旧缓存段
   （`remoteSessionStore.ts` 的 `moreBeyondWindow` 分支），已证连续的段记在
   `sessionWindowCoverage`，而会话回收会清掉它。于是每次重进都要重新拉。
   参考被控端靠 `local-db:messages:view` 规避：它返回的是**带自己游标的 work 窗口**，
   客户端不必再从 20 行页里猜连续性。

### `local-db:messages:view` / `work-details` / `view-intent`

契约取自 `@cindy/maker-shared/message-window`、桌面参考
`apps/desktop/src/main/localDb/ipc/historyViewReader.ts` 与手机侧 transport：

```
local-db:messages:view         (sessionId, { before? })   → { version:1, items, nextCursor, hasMore }
local-db:messages:work-details (sessionId, ref, { after? }) → { version:1, messages, nextCursor, hasMore }
local-db:messages:view-intent  (sessionId, refs)          → true
```

- 一页 `items` **时间正序**，`nextCursor` 是该页**最旧**那条 id，回传为 `before` 继续往前翻；
  `hasMore` 决定「加载更早」入口。页预算 20 项 / 256 KiB（详情页同为 256 KiB）。
- 本 Host 的分组单元是**可读的行 + 折叠的活动段**，不是「一个 turn 一项」：
  `user` 提示与 `assistant` 答复保持为顶层 `messages` 项（人能读的必须可见），
  两者之间的 thinking / tool_use / tool_result 折叠成 `work` 项，并按
  `WORK_ITEM_MAX_ROWS = 40` 行切段，让每次展开约等于一页详情。
  **第一版按 turn 分组是错的，而且错得很显眼**：本会话里那个 329 行 / 138 工具的 turn
  变成了一个折叠项，整页 20 项全是折叠、**零行可读**——用户看到的就是
  「进入会话，只显示一号折叠的会话，然后每次展开十来分钟，又要继续展开，完全看不到最近记录」。
  换成分组后，同一会话读 1357 行得到 128 项（58 条可读 prose + 70 个活动段，
  最大 40 行 / 平均 18.6 行），最新一页就是最近读到的那些对话。
- 超出扫描预算（`HISTORY_SCAN_MAX_ROWS = 20000`）或没有会话 API 时回
  `UNSUPPORTED_CAPABILITY` / `NOT_AVAILABLE`——客户端把这两种都识别为「这里没有视图」，
  自动回退到原始 20 行窗口，也就是它今天的行为。
- **`link-accept` 必须广告 `history-view-v1`**：手机端
  `device-link/historyViewCapability.ts` 在读不到该能力时**根本不会调用**这三个通道
  （`HOST_CAPABILITIES` 在 `src/host-authorization.js`）。服务端实现了通道却没广告能力，
  等于没实现。

### `device-link:media:fetch` 的缩图与内联

对齐参考被控端 `apps/desktop/src/main/device-link/mediaFetch.ts` 的三层答案：

1. **降采样**（`thumbnail: true`，且是 png/jpeg/webp、输入 ≤ 48 MiB）：用 **harness 自带的
   sharp**（`dsh-attachment-local` 的依赖；本插件从 `process.argv[1]`——即 `dsh web` 入口——
   解析它，避免自带第二套原生图像栈）+ EXIF 转正 + 最长边 1024 + webp q80 + 5 s 软超时；
   产物 ≤ 700 KiB 时以 `{ ossKey:'', mimeType:'image/webp', size, inlineBase64 }` 内联回包
   （省掉 upload → presign → download 整往返）。实测 `kitten.png` 2 454 031 B → 102 350 B / 114 ms。
2. **小原图内联**：缩不动（无 codec、gif 这类不该重编码的格式、渲染失败或产物超限）但原图
   ≤ 512 KiB 且是 `image/*` 时，直接内联原图字节——客户端只接受 `image/*` 的内联包，
   非图片仍走 key。
3. **暂存 + 去重缓存**：其余情况上传 OSS 返回 key；同一文件（path|size|mtime 为键）30 分钟内
   复用同一个对象，`skipCache: true` 时绕过（对象被删而文件没变的情形）。

三层任一失败都只是「退回下一层」，不会让取件失败：契约一直要求控制器接受 `ossKey` 形式。

### 帧预算（超帧 = 丢历史）

relay 对超过 `MAX_FRAME_BYTES`（2 MiB）的帧是**拒收**，被控端抛 `PAYLOAD_TOO_LARGE` 后若不接住，
控制端只能干等 30 s 超时——手机端表现为「历史全消失、加载更早也没响应」。
`src/host-frame-budget.js` 因此按参考实现做三段降级（内容截断 128 KiB／工具输出 8 KiB →
丢内联图片 → 整行占位 → 按消息边界裁行并打 `agentMeta.remoteRowsTrimmed` /
`remoteOriginalRowCount`），其余 channel 回结构化 `PAYLOAD_TOO_LARGE`，`send()` 另有超帧硬拒绝
并计数（`/status` 的 `diagnostics.frameBudget`）。

### claw 的计划为什么在手机上变成一张 ToDo 卡

claw 工作流的任务清单**一直在同步进 DSH**：适配器每次结算 mutation 都会
`session.append('todo/write', { todos })`（`@veewo/dsh-claw-kit` 的 `index.js`，注释写的是
「Drive the DSH-native todo dock … so the UI shows the plan's step progress bar」），实测本会话日志里
有 **159 条** `todo/write` 快照，内容就是计划里的任务与状态。所以桌面端的 todo dock 是有的。

手机看不到，是因为两侧渲染的**来源不同**：

- DSH 把 `todo/write` 声明为 **log-only UI state**（「Log-only UI state; never derived
  history」），桌面端从 `todos` **投影**渲染 dock；
- 手机没有投影通道，它的计划卡只从转录里的 **`TodoWrite` 工具行**渲染
  （`extractTodosFromMessage` / `agentPlanSource`，`@cindy/maker-shared/message-render`）。

而转录折叠按定义丢掉非 surface 事件，所以 `todo/write` 从来没变成行。

处置：`src/dsh-message-fold.js` 的 `entryForTodoWrite` 把**每一条非空**的 `todo/write` 快照
翻译成一行 `todo_write` 工具调用（时间戳取快照自身，位置就在它发生的地方），名字映射成
`TodoWrite` 后即选中手机的计划卡；空快照刻意跳过——那是适配器清空 dock 的方式，
「没有卡」不等于「一张空卡」。同一翻译在**实时路径**上也生效，所以计划推进时卡片会随更新。

实测（`tools/probe-todo-rows.mjs`）：本会话 159 条快照 → 156 行手机可见的 `TodoWrite` 行
（3 条空快照被跳过），行内就是 `[completed] …` / `[in_progress] …` / `[pending] …` 的真实状态。

### 本轮真机复测清单

重启 `dsh web` 之后（新通道与新能力都只在重启后生效）：

1. 打开「画一只小猫」——整段短对话应一次显示，不需要再点「加载更早」。
2. 打开一个长会话并往上翻几页，退出再进入——已翻出来的历史应当保留
   （这条依赖手机端确实走了 `messages:view`：可在 `/status` 的 `invokeTotals` 里看到
   `local-db:messages:view` 出现过）。
3. 发一张照片，或让 agent 画一张图并打开——应显示图片（内联缩图路径），不再出现「取图失败」。
4. 「加载更早」应当即时返回（transcript 缓存 + 50 ms 级翻页）。
5. **转圈不再需要手动重进**：让 agent 答完一句话，然后息屏／切走让中继把手机标成离线，
   再回到会话——答案应当直接出现，思考中应当自己结束。可在 Host 日志里对照
   `presence-changed … online:false` 之后不再有指向该设备的 push。

