# ADR: Read the account device directory once per connection

## Context

`presence-changed` only reaches a connected Host for devices that come online while it
is connected, so a device that linked earlier would appear as a bare hex prefix in the
card. The account's device directory is available as
`GET /api/device-link/devices` (derived from the relay URL by swapping `ws`→`http` and
dropping `/ws`), returning `DeviceView[]` for the whole account
(`Cindy/packages/device-link/src/protocol.ts:203-219`). The device list is display
data; it must not become a second source of connection truth.

## Decision

After `hello-ack`, perform one read-only device-directory read to name the rows, and
at most one more lookup for a controller whose platform is still unknown. Never poll
the directory per link-open, and treat presence as display data only: `connected`
still requires an observed `link-open`/`invoke`.

## Alternatives

- Poll the device directory continuously: rejected — it spends account-wide requests
  to repaint names that rarely change.
- Look up a name on every `link-open`: rejected — a controller that opens several
  links would trigger a request per link for data already known.
- Skip naming and show raw device ids: rejected — the card must let the user
  distinguish a linked desktop from a phone, which needs platform and name.

## Consequences

- The card shows real names/platforms (`<phone>`/android, `YOP`/win32, …) instead of a
  hex prefix, without a poll loop.
- A device the directory cannot name costs no repeat request per link-open.
- The lookup is display-only; a failed directory read must not fabricate or upgrade the
  connection state.
