# ADR: No QR pairing surface; phone association is account-scoped

## Context

The original request assumed a QR pairing step. Cindy's DeviceLink protocol has no
pairing concept: the relay authenticates the bearer token, binds the socket to a
Cindy account, and fills `Envelope.src` itself. The only identity returned is
`hello-ack` (`serverProtocolVersion`, `deviceId`, `userId`, optional `capabilities`).
Cindy's own "connect your phone" QR is the regional app-download page
(`MobileDownloadDialog.tsx:119-127` with `resolveMobileDownloadUrl`, i18n key
`scanToOpen`), and there is no frame reporting a successful pairing because
association is account-scoped. There is no pairing API either; that dialog renders its
QR with the `qrcode` package's `toDataURL`.

## Decision

Do not build any QR surface, pairing-code flow, or device-enrollment step. Link the
phone by **account**: the user signs in to the same Cindy account on the device, and
this Host reports a device as connected only when that device actually opened a link
to it or invoked it (`link-open` / `invoke`), never from presence alone. The feature
surface stays the settings card: switch, connection state, verification-code login,
and the connected-device list. Device management and revocation UI are out of scope
for this slice.

## Alternatives

- Render a QR that encodes a Cindy URL or a synthesized payload: rejected — Cindy has
  no pairing protocol to consume it, so the code would be an invented contract.
- Treat `presence-changed` as connected: rejected — presence only lists same-account
  devices and would report a green dot for a phone that has not reached this Host.
- Add per-device enrollment up front: rejected — the relay only routes frames between
  devices of one account, so a `link-open` arriving here is already same-account; an
  enrollment UI can be added later without reworking admission.

## Consequences

- The card can honestly stay at 「等待手机连接」 while a phone is merely online.
- `connected` means "a Cindy client reached this Host", not specifically "a phone", so
  device rows must always name the platform.
- Revoked devices stay revoked, keeping the door open for a later enrollment UI.
- Device management, revocation UI, remote-control configuration, and any QR surface
  are explicitly out of scope for this slice.

<!-- state: history -->
## Decision evolution

<!-- dated: 2026-09-17 -->
### First decision: "no QR" was a scope choice, not a protocol conclusion

The decision was first recorded as "the request excludes a QR surface", which left the
option open to add one later as a feature. It was replaced once answer 1 and answer 2
showed there is no pairing token to encode and Cindy's only QR is the download page,
and the user then dropped the QR requirement explicitly. The earlier framing is kept
because a reader could otherwise still treat a QR as a deferred feature rather than an
impossible one.
