# ADR: One pending interaction, multiple answer surfaces

## Context

DSH approval and `user-questions/request` are waterfall interactions. A prepended Host listener that waits only for Cindy prevents the native DSH UI from ever seeing the question. Starting Cindy and local UI promises with an uncancelled `Promise.race` is also unsafe: the losing listener/card remains parked and can submit a second late answer.

## Decision

DSH request lifecycle owns whether an interaction exists. The Host ApprovalRegistry is the single cross-surface pending owner and fans the same request to Cindy plus the downstream DSH UI. The first valid answer settles atomically once; local-first settlement dismisses Cindy, Cindy-first settlement aborts the downstream DSH card, local forwarding failure leaves Cindy active, and late answers are idempotently rejected.

A second surface may be started only when it has a real cancellation/dismiss contract. A bare `Promise.race` is forbidden.

## Alternatives

- Cindy exclusively claims watched sessions: rejected because the user loses the local DSH prompt.
- Always delegate to the local UI: rejected because mobile/remote control can no longer unblock the turn.
- Race without cancelling the loser: rejected because it leaks waterfall listeners and permits stale second answers.
- Maintain separate registries per surface: rejected because there is no single request identity or atomic winner.

## Consequences

- Both paths share single settlement and dismissal. Structured questions are registered whenever the bridge is enabled, independently of watching; only permissions retain the existing watched/previously-watched ownership and Host deadline. Questions follow DSH's caller lifetime without another Host timer.
- Tests must cover local-first, Cindy-first, local failure, timeout/abort, reconnect replay, and late answers.
- If the downstream request cannot carry the private cancellation signal, delegate to the original native path without registering a phone-only card.
- Native and phone outcomes settle the same registry promise, so a late local callback cannot override an accepted phone answer. Native typed cancellation/timeout rejects the awaited question waterfall; it is not an empty answer.
- Temporary relay recovery preserves pending questions and session subscriptions replay them. Explicit Host shutdown cancels bridge waits. This remains a process-local bridge, not a second persistent DSH question domain.

<!-- state: history -->
## Decision evolution

<!-- dated: 2026-10-01 -->
### Dual-surface arbitration introduced

Release 0.1.18 added the cancellable arbiter and user acceptance confirmed that Cindy and DSH could both present the interaction while only one answer settled it.

<!-- dated: 2026-11-05 -->
### Register before presentation, not after the first phone visit

The Host-only repair removes the user-question watching gate and hidden 30-minute timer, retains questions across relay retries, and forwards native cancellation through the awaited boundary. Permissions keep their prior behavior. The existing registry promise is the single completion for both surfaces, without a new protocol or framework.
