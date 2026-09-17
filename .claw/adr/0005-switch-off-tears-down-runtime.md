# ADR: Switch off tears the relay runtime down

## Context

The Host projection exists to feed the phone. If the switch only stopped the relay
socket while leaving the projection, subscribers, and device ledger alive, the process
would keep working on behalf of a feature the user turned off, and the next status
read could still report stale devices. The switch is the user's single control for the
whole feature.

## Decision

The switch is a lifecycle boundary: turning it off closes the WebSocket, stops the DSH
session projection, and clears the in-process subscriber set, the accepted-controller
set, and the device ledger. An unanswered socket is dropped while the switch stays on,
so the next attempt can reconnect instead of parking at `failed`; plugin teardown
(`stop()`) uses the same `disconnect()` path and returns the status to `disconnected`.

## Alternatives

- Keep the projection warm so re-enabling is instant: rejected — it leaves
  session-derived activity flowing after the user turned the feature off.
- Keep the device ledger for display: rejected — after a switch-off the card must not
  show devices that are no longer admitted.
- Mark `failed` permanently on a dropped socket: rejected — a transient relay failure
  would require the user to toggle twice.

## Consequences

- Switch-off has an observable proof: status returns `disconnected`, ledger and host
  identity are cleared, and the process holds 0 established sockets.
- Every async continuation carries a generation guard, so a late frame from a torn-down
  socket cannot resurrect state.
- Re-enabling always starts from a fresh session read, which costs one refresh but
  keeps the state honest.
