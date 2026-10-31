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

- Approval and structured question paths share request IDs, settlement, timeout, abort, replay, and dismissal rules.
- Tests must cover local-first, Cindy-first, local failure, timeout/abort, reconnect replay, and late answers.
- If a downstream request object cannot carry the private cancellation signal, the Host keeps the existing single Cindy path rather than launching an uncloseable local branch.

<!-- state: history -->
## Decision evolution

<!-- dated: 2026-10-01 -->
### Dual-surface arbitration introduced

Release 0.1.18 added the cancellable arbiter and user acceptance confirmed that Cindy and DSH could both present the interaction while only one answer settled it.
