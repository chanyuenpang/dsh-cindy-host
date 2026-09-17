# Verification and projection exclusion rules

<!-- state: current -->
## Current behavior

The whole suite runs with `node --test` (`npm test`) on Node 22 or newer, with no
test dependencies beyond the dev-only React pair. The suite is **403/403 passing**
across 38 test files (the runner also reports `test/support/oss-ref.js` as a support
entry). The parent plan recorded 82/82 and an earlier pass recorded 84/84; the tree has
grown far past both, so the number in this document is the one to verify against. The
channel surface is 52 served channels with 0 unclassified
(`npm run audit:channels`).

What each layer must prove:

- Projection and privacy: the projection deliberately excludes message bodies, prompt
  input, tool calls and results, approval/question payloads, file paths and content,
  credentials, and command sending. Only the conversation list (opaque session ID,
  title, phase, update time) and activity summaries (added / removed / status) cross
  it, and the Cindy transport consumes only what the projection already produced.
- Stream recovery: a stream failure emits a generic stale marker (never raw error
  text) and refreshes the conversation baseline, with no duplicate rebaseline while
  one is in flight.
- Runtime: relay frames, the 20 s heartbeat, state derivation, revoke handling, and
  the switch-off teardown in `test/host.test.js`, `test/host-status.test.js`, and
  `test/authorization-policy.test.js`.
- Login: identifier validation and the `ok` / nested-token / `select_account` /
  `binding_required` / `sso_verification_required` outcome mapping in
  `test/cindy-login-flow.test.js`.
- HTTP surface: loopback-only `403`, status shapes, unknown-route `404`,
  runtime-not-ready `503`, body limits (`413`/`400`), and the handler-failure `500` in
  `test/host-routes.test.js`.
- Card: `test/client-card.test.js` renders the card with React (settings plug-in item
  key `dsh-cindy-host`, switch, the five labels, login form, device rows), so card
  markup and state rules are covered without a browser.
- Bundle and composition: `test/dsh-plugin.test.js` and `test/host-settings.test.js`
  cover mounting and settings validation; the isolated smoke test covers composition
  and lifecycle only, and is not a projection test.
- Media fetch: `test/host-media-fetch.test.js` covers downsample success, the
  input/product-over-limit fallbacks, non-downsamplable mime types, the small-original
  inline fallback, and the staging cache; `tools/acceptance.mjs` checks live that a
  `thumbnail: true` fetch answers either inline bytes or a key with a well-formed shape
  (including the base64 length and the 700 KiB ceiling).
- History view: `test/host-history-view.test.js` covers work grouping and the
  page/detail cursor semantics (`hasMore`/`nextCursor`); `test/cindy-channels.test.js`
  and `test/cindy-channels-fail-closed.test.js` cover channel-layer forwarding and
  fail-closed refusals; `tools/acceptance.mjs` checks a live view page, a
  `work-details` range, and `view-intent` accepting an expanded set. Both are only
  meaningful on a process restarted after the channels landed.

Verification rules:

- Run `npm test` before the smoke gates; a clean run is the entry gate.
- Gate 1: `dsh --profile cindy-smoke --dump-config` with a disposable `DSH_HOME`
  must compose the bundle.
- Gate 2: `dsh --profile cindy-smoke --no-open --port 3081` must show a running host
  with no Cindy authentication prompt; the card bundle is the `dsh-cindy-host-demo`
  entry of `window.__DSH_BOOT__`.
- Live endpoint check on that port: `GET /api/dsh-cindy-host/status` → `200`, an
  unknown route → `404`, `POST …/login/request-code` with an empty identifier → `400`.
- Switch-off proof: after turning the switch off, status returns `disconnected`,
  device ledger and host identity are cleared, and the process holds 0 established
  sockets.
- Browser automation of the card's polling/login interaction is not available in this
  checkout; that interaction is covered by the React render tests plus the live
  `status` endpoint.
- Restart rule: a change that adds a channel or a `link-accept` capability is only
  verifiable after `dsh web` is restarted. Until then the old process answers
  `CHANNEL_NOT_ALLOWED` for the new channel and advertises no new capability, so an
  acceptance run against the old process proves nothing about the change.

Code anchors:

- `test/*.test.js` (38 files; the media-fetch and history-view suites are named above)
- `src/projection.js`, `src/contracts.js`, `src/projection-read-model-sink.js`,
  `src/session-publisher.js`, `src/session-read-model.js`
- `README.md` ("Safe isolated DSH smoke test")
- `tools/acceptance.mjs`, `tools/channel-audit.mjs` (`npm run audit:channels`)
- `doc/cindy-phone-link.md` ("Verifying by hand"; 「收尾：媒体取件补齐 + 历史视图通道」)
