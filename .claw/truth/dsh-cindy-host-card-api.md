# Settings card to Host HTTP contract

<!-- state: current -->
## Current behavior

The settings card reads and drives the Host over one same-origin HTTP surface,
registered by `src/dsh-plugin.js` on `ctx.webServer.register({ kind: 'prefix', path: '/api/dsh-cindy-host', handler })`.
`API_PREFIX = '/api/dsh-cindy-host'`. The card's only source of truth is
`GET /api/dsh-cindy-host/status`; the switch itself is a settings write.

Route table (`src/host-routes.js`):

| Method + path | Purpose |
|---|---|
| `GET /status` | the card's only source of truth |
| `POST /reconnect` | ask the runtime to dial the relay again |
| `POST /login/request-code` | send a Cindy verification code |
| `POST /login/verify-code` | exchange the code for a session |
| `POST /login/select-account` | finish a `select_account` answer |
| `POST /logout` | drop the stored Cindy session |

Guard and failure behaviour, in order:

- Requests that did not arrive over loopback are refused with `403`
  `{ ok: false, message: 'Cindy Host API is loopback-only' }`. Accepted addresses are
  `127.0.0.1`, `::1`, and `::ffff:127.0.0.1`; an undefined peer address is treated as
  loopback.
- An unlisted method+path answers `404`
  `{ ok: false, message: 'Unknown Cindy Host route: <METHOD> <path>' }`.
- Every POST path parses a JSON body; a malformed body answers `400` and an
  oversized one answers `413`, both with `{ ok: false, message: '请求体无效' }`. The
  body limit is `MAX_BODY_BYTES = 64 * 1024` (four short scalars never come close).
- A thrown handler answers `500` `{ ok: false, message: 'Cindy Host 处理请求失败' }`
  when headers are still unsent; otherwise the response is ended.
- `GET /status` answers `200 { ok: true, installed: true, status: null }` before the
  runtime exists, `503 { ok: false, message: 'Cindy Host 运行时尚未就绪' }` when the
  runtime is in a not-ready state, and otherwise
  `200 { ok: true, installed: true, status: <snapshot> }`.
- Successful login and logout answers include the refreshed status, so the card does
  not need a second round trip: `{ ok: true, deviceId, status }` for
  verify-code/select-account and `{ ok: true, status }` for reconnect/logout.
- Every JSON answer carries `content-type: application/json; charset=utf-8`,
  `content-length`, and `cache-control: no-store`.

Pitfalls:

- The route row is injected optionally: in a headless composition `webServer` is
  absent, so there is no HTTP surface at all — the runtime and settings still work.
- Tokens never cross this surface. The card only ever sees booleans and a masked
  identifier; tokens live in the OS credential store.

Code anchors:

- `src/host-routes.js` (`API_PREFIX`, `MAX_BODY_BYTES`, `LOOPBACK`,
  `isLoopbackRequest`, `readJsonBody`, route table, `handle`)
- `src/dsh-plugin.js` (prefix registration inside `ctx.inject(['webServer'], …)`)
- `lib/client.js` (`API`, `POLL_MS`, status polling)

Verification rules:

- `test/host-routes.test.js` covers loopback-only `403`, `status`, unknown-route
  `404`, `503` when the runtime is missing, body limits (`413`/`400`), and the
  handler-failure `500`.
- Live check used for this Host: `GET /api/dsh-cindy-host/status` answered `200` and
  an unknown path answered `404` on the isolated profile's port.
