# Model and turn errors on Cindy

The Host projects a native `turn/end` with `data.reason.kind === 'error'` into a Cindy `role: error` row and terminal `maker:event`. DSH is the only owner of failure, retries and durable history. No second error store or model-visible assistant message is created.

## Wire and safety contract

- Stable `id = clientId = sessionId + ':turn-error:' + event.seq`; the terminal envelope has the same top-level `persistId`. Native event time is retained; invalid sequence/time never gets a random or wall-clock identity.
- Row content: `{ message, reason: 'dsh-turn-error', code?, status? }`. The terminal event adds `isTerminal: true, willRetry: false`.
- Display messages come from a fixed known-code map and validated numeric HTTP status. Unknown codes get a generic failed-turn message. Provider prose, stack/cause, request IDs, credentials, URLs/headers/bodies and raw streams are never copied. Phone details are safe diagnostic summaries, not full provider error bodies.
- Failed attempts are not failed turns. Request-error hooks, `assistant/attempt` and tool-result errors do not create terminal rows. The Host never retries models. Other native endings retain normal `done` behavior.
- Cold history, incremental cache and live rows share the same pure projection. Error rows remain top-level history messages, not folded activity. Durable delivery reads also use this fold.

## Delivery and recovery

Only accepted, authorized devices holding the relevant session subscription receive error content. List-only and unwatched devices receive no error detail. Native failures emit `error`, not an additional `done`. Summary API errors only invalidate state, never independently terminate a turn.

Reconnect repair reads the latest native boundary without the transcript cache, then checks current source running state. Source/service generation, relay generation, subscription leases and live turn versions guard awaited reads. Old errors can return in history but cannot stop newer turns. Terminal delivery is coalesced by native identity per device/session/connection lease, not a time window. Offline sends are not treated as receipt evidence; this is not an exactly-once network guarantee.

Unavailable recovery reads do not manufacture success or expose exception prose. The next synchronization can retry; history invalidation remains available. Sources without the native turn-reader seam retain legacy status-only behavior.

## Verification

Run `node --test`, or target `test/turn-error.test.js`, `test/host-turn-error.test.js`, `test/dsh-message-fold.test.js` and `test/host-history-view.test.js`. Run `node tools/channel-audit.mjs` for channel classification.

Opt-in actual mobile verification: set `CINDY_SOURCE_ROOT` to a Cindy checkout with installed test dependencies, then run that checkout's `node_modules/vitest/vitest.mjs` via Node with `run --config tools/contracts/mobile-error.config.mjs` from this project. No Cindy files are changed. This executes actual mobile store/normalizer code against JSON-round-tripped Host rows and envelopes, including live/history deduplication.

Source/contract tests are not installed-version, phone hardware, weak-network or deployment acceptance. No release or process restart is implied.
