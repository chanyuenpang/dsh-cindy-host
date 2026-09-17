# ADR: One status truth over a loopback-only HTTP route

## Context

The settings card is a web surface; the runtime lives in the DSH host process. The
card must not decide whether the Host is connected, and the switch is not a
connectivity indicator but a settings write. DSH already offers plugin surfaces for
this (`ctx.webServer.register` with a prefix route, `ctx.settingsScope` for settings),
and the card can only reach same-origin endpoints.

## Decision

Expose the runtime through one same-origin prefix route `/api/dsh-cindy-host`
(`GET /status`, `POST /reconnect`, `/login/request-code`, `/login/verify-code`,
`/login/select-account`, `/logout`) and make `GET /status` the card's only source of
truth. The switch writes `transportEnabled` through `ctx.settingsScope`; everything
drawn on the card comes from the last `status` answer. The route is loopback-only
(`403` otherwise) and rejects oversized or non-JSON bodies (`413`/`400`); the route row
is injected optionally so headless compositions keep the runtime and settings without
the browser surface. Tokens never cross this route.

## Alternatives

- Let the card infer state from the switch and its own fetch results: rejected — the
  card would then be a second, competing truth and could show connected while the
  runtime is down.
- Push state over a long-lived socket: rejected — a 1500 ms poll of one small snapshot
  is sufficient and keeps the surface stateless.
- Register the route without a loopback check: rejected — the API drives login and
  logout and must not be reachable from other hosts.
- Expose tokens or the raw session to the page: rejected — the card only ever sees
  booleans and a masked identifier.

## Consequences

- When the runtime is absent the card has no data source, so `/status` answers
  `200 { ok: true, installed: true, status: null }` rather than fabricating a state.
- Every failure mode has one shape: JSON `{ ok: false, message }` with a specific
  status code (`403`, `404`, `413`, `400`, `500`, `503`).
- Login and logout answers include the refreshed status, so the card needs no second
  round trip.
