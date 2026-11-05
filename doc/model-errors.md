# Model and turn errors on Cindy

The Host projects a native `turn/end` with `data.reason.kind === 'error'` into a Cindy `role: error` row and terminal `maker:event`. DSH is the only owner of failure, retries and durable history. No second error store or model-visible assistant message is created.

## Wire and safety contract

- Stable `id = clientId = sessionId + ':turn-error:' + event.seq`; the terminal envelope has the same top-level `persistId`. Native event time is retained; invalid sequence/time never gets a random or wall-clock identity.
- Row content: `{ message, reason: 'dsh-turn-error', code?, status? }`. The terminal event adds `isTerminal: true, willRetry: false`.
- Display messages come from a fixed known-code map and validated numeric HTTP status. Unknown codes get a generic failed-turn message. Provider prose, stack/cause, request IDs, credentials, URLs/headers/bodies and raw streams are never copied. Phone details are safe diagnostic summaries, not full provider error bodies.
- Failed attempts are not failed turns. Request-error hooks, `assistant/attempt` and tool-result errors do not create terminal failure rows. Only explicit native `llm/retry`/`llm/retry-started` events produce ongoing retry notices/status. The Host never retries models. Other native endings use `done` plus the distinct system notices described below.
- Cold history, incremental cache and live rows share the same pure projection. Error rows remain top-level history messages, not folded activity. Durable delivery reads also use this fold.

## Delivery and recovery

Only accepted, authorized devices holding the relevant session subscription receive error content. List-only and unwatched devices receive no error detail. Undismissed native failures emit `error`, not an additional `done`. An explicitly dismissed error retains its historical error row with a presentation-only `content.dismissed` flag; reconnect closes running state without re-opening that error banner. Summary API errors only invalidate state, never independently terminate a turn.

Reconnect repair reads the latest native boundary without the transcript cache, then checks current source running state. Source/service generation, relay generation, subscription leases and live turn versions guard awaited reads. Old errors can return in history but cannot stop newer turns. Terminal delivery is coalesced by native identity per device/session/connection lease, not a time window. Offline sends are not treated as receipt evidence; this is not an exactly-once network guarantee.

Unavailable recovery reads do not manufacture success or expose exception prose. The next synchronization can retry; history invalidation remains available. Sources without the native turn-reader seam retain legacy status-only behavior.

## Diagnostic parity review (2026-11-05)

The installed desktop chat renderer and native retry/query producers were inspected read-only. The screenshot maps to `turn/end.reason.kind = interrupted`, not `error` or ordinary `aborted`. A second gap was that durable phone history read the raw stored prefix, while native cold session-query appends `interruptedTurnClosers`. A third gap was omission of canonical tool-role result messages (only legacy nested result blocks were recognized).

| Native fact | Phone projection and behavior |
| --- | --- |
| `turn/end: error` | Existing safe error row + terminal error, with code/status details. Account sign-in codes have safe guidance. |
| `turn/end: interrupted` | Visible system notice includes the desktop process-exit explanation and **unknown tool outcomes**. Terminal done ends the spinner, without pretending this was a model failure. The native interruption tuple below also enables the current Cindy banner and homepage red indicator. |
| `aborted` | A distinct cancellation notice; user/parent/disposal causes are not called process crashes. Native `reason.reason = { kind: 'hook', reason: 'deepseek-account/signed-out' }` retains the desktop sign-out explanation. |
| `max-tokens` / `blocked` | Visible truncation/blocked notice; no invented recovery action or hidden model failure. |
| `llm/retry` / `llm/retry-started` | Visible safe scheduled/start retry notices with count/delay where native data supplies them; status remains running, never terminal failure. This is not a synchronized countdown widget. |
| Tool result failure / native recovered unknown outcome | Canonical tool-role and legacy nested results retain call pairing, output and `isError`. Native recovery distinguishes a tool that never started from an outcome that is unknown. |
| Unknown future end reason | Generic unsupported-detail notice, without reflecting arbitrary reason text. Ordinary completed/forked endings do not become failure notices. |

Non-model notices use stable `sessionId:turn-notice:seq` identities and ordinary system text so the phone displays the actual explanation, not just a generic failed-reply summary. Live, replay, cache, paging and grouped history share [the same projection](<../src/turn-error.js>). Reconnect sends the actual diagnostic row before its terminal envelope, subject to the existing authorization and generation/turn guards.

[Durable display history](<../src/dsh-input-delivery.js>) now applies native `interruptedTurnClosers` **only when both the native session and agent are absent**. It does not modify storage, execute tools, or alter the raw prefix used by `evidence()`/input receipts. Active writers are never diagnosed as crashed. No interruption is inferred from elapsed time, missing responses or a connection loss.

Model/transport prose remains safety-filtered; exact visual layouts and native-only settings/trace panels are not mirrored. RPC refusals keep their existing error-envelope path. This review covers the session diagnostics above, not a claim that every desktop UI toast or arbitrary plugin event is mirrored.

Focused parity regressions are in [session diagnostics](<../test/session-diagnostics.test.js>) and [Host terminal/recovery tests](<../test/host-turn-error.test.js>); [actual mobile contracts](<../tools/contracts/error-mobile.contract.ts>) check visible notice text, retry nonterminal state, replay deduplication and unknown-tool-result pairing.

## Native interruption and presentation protocol (2026-11-06)

**Hard implementation boundary:** only the Host repository may be changed. Cindy code, configuration, dependency manifests and build outputs must not be modified; its checkout is a read-only protocol/test dependency. All contract tests and their configuration live in this Host repository. Existing client limitations remain limitations under this constraint, not permission to patch Cindy.

[Diagnostic presentation](<../src/diagnostic-presentation.js>) owns only derivable view tuples and explicit display preferences. It does not own failures or business completion.

- Only the latest proven native `interrupted` with a matching `turn/start` is pending. The identity is `sessionId + startSeq + startTime + turn`, not a synthetic closer sequence. A cold query and the later persisted closer therefore acknowledge the same interruption. Connection loss and timeouts are not interruption evidence.
- Pending session rows carry native `activeTurnStartedAt`, equal `interruptedTurnStartedAt`, and the previous verified non-interrupted `lastTurnEndedAt` (or null). The detail banner uses the first/end comparison; homepage status uses the explicit interrupted marker too (its native `error` right-slot renders a red dot). Non-pending, ignored, hidden or running states explicitly clear all three fields to null. Impossible timestamp ordering is not repaired with invented wall-clock values.
- `clearedAt` stays null because no native transcript-clear seam is proven. Durable input `clearBoundaryMs` fences input intents only; it is not a transcript-clear fact.
- `local-db:sessions:ack-interrupted([sessionId])` captures the current candidate before settings I/O. `local-db:messages:dismiss-error([sessionId, clientId])` accepts only a real committed Host error-row identity. Acknowledgement is not completion, cancellation or model recovery.
- Both narrow writes require the current authenticated account/realm/Host owner and controller grant. `diagnosticPresentationV1` stores hashed owner/session/identity keys and boolean display dispositions only, under the native profile settings namespace. Revisioned leaf mutation, conflict retry and authoritative readback precede success/publish. There is no optimistic Host mirror and no second error log. Another authorized controller of this owner sees the same preference; another account/profile does not inherit it.
- Interruption state is projected consistently through list/get, native boundaries and reconnect patches. Fresh metadata reads use source/service, connection, native-boundary watermark and turn-version guards. Settings completion re-reads the current native candidate, so an old write cannot clear a later interruption. Error dismissal overlays live, paged/located and grouped history without rewriting stored source events, message counts, raw receipt evidence or tool outcomes.

[Manual continuation](<../src/continuation-protocol.js>) remains a new human-triggered `maker:input:enqueue` input: the actual Cindy shared prompt, a new clientId and explicit `createOpts.planMode:false`. Pinned shared literals are checked against actual Cindy exports. This is not a replay of an old model request, goal round or tool call.

- The reliable input ledger captures the original native tail identity. The native backend checks that identity before and after switching plan mode. It uses the real scoped setter or `/plan off` plus an authoritative native getter/projection; merely accepting a command or parsing human prose is not proof. A known exact agent composition without plan mode is allowed; unavailable/queued/unverifiable switching does not send the prompt.
- Repeated envelopes with the same clientId reconcile the same intent; distinct clientIds cannot create two continuations for the same captured tail. Superseded or positively non-admitted plan refusals become durable `removed` receipts, never `accepted` and never endless automatic resend. Safe removal reasons are exposed for reconciliation; current mobile may only show removal, not the specific reason. Native user receipts and unknown admission windows retain their existing authority and safety behavior.
- Merely queueing or cancelling a continuation does not acknowledge interruption. Until a real newer native turn starts, the underlying interruption remains available when the in-flight queue mask disappears. Ordinary cancellation and model failure do not become native process-exit interruptions. Legacy non-durable sender fallback refuses this manual continuation rather than silently dropping its control contract.

Current wire limitations are explicit: ack carries only sessionId, not the candidate seen on the screen, so a click arriving after the native tail changes cannot be bound to that old screen generation. Host guards prevent an already captured old acknowledgement from clearing a newer candidate. The native prompt API does not offer an atomic cross-writer tail compare-and-enqueue; Host serializes its own intents and performs fresh checks, but does not claim atomic CAS against unrelated native desktop writes. Mobile also catches ignore failures after hiding locally; a failed durable write remains pending on authoritative re-sync, but immediate local rollback/error feedback is not provided by the existing protocol and is not implemented under the no-Cindy-modification constraint. No automatic unknown-tool replay is added.

The [actual mobile interruption contract](<../tools/contracts/interruption-mobile.contract.ts>) executes the real banner resolver, homepage status, session store and transport methods with JSON wire values. [Native input tests](<../test/dsh-input-delivery.test.js>), [ledger tests](<../test/host-input-delivery.test.js>) and [confirmation races](<../test/host-turn-error.test.js>) cover admission, plan-off proof, deduplication, removed receipts, source/revoke/stop races and newer-interruption preservation.

## Verification

Run `node --test`, or target `test/turn-error.test.js`, `test/host-turn-error.test.js`, `test/dsh-message-fold.test.js` and `test/host-history-view.test.js`. Run `node tools/channel-audit.mjs` for channel classification.

Opt-in actual mobile verification: set `CINDY_SOURCE_ROOT` to a Cindy checkout with installed test dependencies, then run that checkout's `node_modules/vitest/vitest.mjs` via Node with `run --config tools/contracts/mobile-error.config.mjs` from this project. No Cindy files are changed. This executes actual mobile store/normalizer code against JSON-round-tripped Host rows and envelopes, including live/history deduplication.

Source/contract tests are not installed-version, phone hardware, weak-network or deployment acceptance. No release or process restart is implied.
