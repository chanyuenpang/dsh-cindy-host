# Settings card to Host HTTP contract

<!-- state: current -->
## Current behavior

The settings card uses one same-origin prefix registered by [plugin composition](<src/dsh-plugin.js#L2070-L2096>): `API_PREFIX = '/api/dsh-cindy-host'`. [Host routes](<src/host-routes.js>) own the HTTP boundary. `GET /status` remains the connection-state authority; a settings write controls the transport switch. Authentication progress is a separate controller-owned view returned by `POST /login/flow`, not a client-side credential state machine.

| Method + suffix | Purpose |
|---|---|
| `GET /status` | Connection snapshot and optional diagnostics; `status: null` before runtime exists |
| `POST /reconnect` | Skip automatic reconnect backoff |
| `POST /login/flow` | Start/read/continue/cancel controller-backed regional login |
| `POST /login/request-code` | Legacy direct phone/email code request, not the settings flow |
| `POST /login/verify-code` | Legacy direct code verification |
| `POST /login/select-account` | Legacy direct account-choice continuation |
| `POST /logout` | Fence pending login, drain identity commit, clear vault and disconnect |
| `POST /devices/delete` | Explicit device deletion with runtime result/status |
| `POST /selftest` | Diagnostic invoke of a named channel; it performs that channel's effects |

### Admission and responses

- [Loopback admission](<src/host-routes.js#L27-L49>) accepts `127.0.0.1`, `::1`, `::ffff:127.0.0.1`; missing/null peer addresses are an injected-test-double accommodation. Other peers receive `403`.
- Every registered POST requires JSON content type, a local Host (`127.0.0.1`, `localhost`, `[::1]`), matching Origin when supplied, and `Sec-Fetch-Site` of `same-origin`/`none` when supplied. Cross-site/form/rebinding requests are rejected before body parsing or side effects. Missing Origin alone is not rejected. The no-headers exemption is for injected test doubles, not a browser integration contract.
- Unknown method/path returns `404`. Accepted JSON bodies are bounded to 64 KiB: malformed → `400`, oversized → `413`, both with generic `请求体无效`. Handler exceptions produce generic `500` when headers are unsent, otherwise end the response. [Dispatch](<src/host-routes.js#L265-L320>).
- JSON responses carry content type, content length and `cache-control: no-store`. [Serializer](<src/host-routes.js#L51-L54>).
- `GET /status` returns `200 { ok: true, installed: true, status, diagnostics? }`; no runtime yields `status: null`. Operations needing a runtime, such as reconnect/selftest/delete, can return `503`. Do not invent a `503` status-read branch.
- Flow responses are `{ ok, view? }`, with fixed `code`/HTTP status on failure; the whitelisted view is not a vault record. Legacy successful verify/select replies contain `deviceId` and connection `status`; reconnect/logout include refreshed status. Legacy non-success code responses may include a login ticket for old account-choice clients. The settings page no longer uses those tickets. Tokens never cross either surface.

### Flow and identity ownership

[Controller commands](<src/cindy-auth-controller.js#L226-L265>) use `action: start` with explicit `region` and optional explicit takeover. Subsequent commands carry `attemptId`; step mutations also carry the current revision. Refused starts do not reveal the active attempt. Read/cancel and the sealed commit have distinct rules; see [login Truth](<.claw/truth/dsh-cindy-host-login.md>) for protocol outcomes, secrets, CAPTCHA and credential lifecycle.

[Client flow](<lib/client.js#L478-L532>) polls browser/commit steps, rejects stale generation/revision responses, and attempts cancellation on unmount. A successful flow triggers a fresh connection-status read. Login never implicitly turns the user's transport switch on. [Route commit](<src/host-routes.js#L83-L115>) persists under a lease before runtime replacement/reconnect; [logout](<src/host-routes.js#L211-L219>) increments the identity epoch, stops login, drains writes, revokes old runtime identity, clears credentials and disconnects. Legacy verification is fenced by the same route epoch. Disposal prevents late reconnects.

Optional `webServer` injection means a headless composition has no HTTP surface while settings/runtime remain available. Regression anchors: [general routes](<test/host-routes.test.js>), [mutation admission and commit/logout races](<test/host-auth-routes.test.js>), [settings interactions](<test/client-card.test.js>). Authentication deployment and human-acceptance limits are owned by [login Truth](<.claw/truth/dsh-cindy-host-login.md>), not inferred from an HTTP `ok`.

<!-- state: history -->
## Evolution history

<!-- dated: 2026-11-03 -->
### Direct-code page contract superseded

The original page called request-code/verify-code/select-account directly and its API documentation described only loopback plus body-size guards. Those compatibility endpoints remain, but controller-backed login and same-origin/local-Host JSON admission now define browser integration. The old isolated smoke checks (`GET /status` → 200, unknown route → 404) remain evidence only for that earlier surface, not real Apple/enterprise-SSO acceptance.
