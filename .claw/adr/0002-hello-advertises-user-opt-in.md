# ADR: `hello` advertises the user's own remote-control opt-in

## Context

The relay only routes `link-open`/`invoke` to a target that advertised
`remoteControlEnabled: true` in `hello` (`CONTROL_KINDS` in
`device-link-protocol/src/protocol.ts:75`). A Host that stays silent about it is
invisible to the phone, so the user's switch cannot work without that declaration.
The switch itself is a settings value (`transportEnabled`) owned by the user.

## Decision

The runtime's `hello` payload carries exactly the user's own opt-in:
`remoteControlEnabled: policy.isEnabled()`, together with `deviceName`, `platform`,
`appVersion`, and `busy: false`. A later policy change is re-announced with
`presence-set`. Admission of an incoming controller requires two facts — the switch is
on and the device is not explicitly revoked — and there is deliberately no per-device
enrollment step.

## Alternatives

- Advertise `remoteControlEnabled: true` unconditionally so the phone can always find
  the Host: rejected — it would advertise remote control the user never granted.
- Keep the Host silent and rely on presence to be discovered: rejected — the relay
  then never routes control frames to it.
- Require a per-device grant before accepting `link-open`: rejected — redundant for a
  same-account relay and it would block the first link without an enrollment UI.

## Consequences

- Turning the switch on is what makes the Host discoverable and controllable; turning
  it off removes it from routing.
- Revoked devices remain revoked, so a future enrollment UI can build on
  `authorization-policy` without changing the handshake.
- A policy bug that flips this field would silently expose remote control, so the
  handshake is pinned by `test/host.test.js`: the switch-off case connects nothing, and
  the enabled case asserts `hello.payload.remoteControlEnabled === true` with the
  comment that the relay only routes `link-open` to a target that advertised it.
