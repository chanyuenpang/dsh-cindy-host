# Architecture: Read-only DSH Projection

## Owners
- **DSH runtime** owns sessions and events.
- **DshReadClient** owns conversion from the DSH public host API to a narrow read interface.
- **ActivityProjector** owns allowlisting and conversion to safe activity summaries.
- **ProjectionSink** owns presentation only; it is not a second session store.

## Data flow
1. The adapter reads a session-list baseline.
2. It publishes a minimal `ConversationRow` snapshot to the sink.
3. It opens the host/mux streams.
4. Only allowlisted lifecycle/status frames become `ActivityItem` records.
5. An unknown frame or stream failure marks the projection stale, drops incremental state, and performs a fresh baseline read.

## DTO boundary
`ConversationRow = { sessionId, title, phase, updatedAt }`

`ActivityItem = { sessionId, sequence, kind, phase, occurredAt }`

No DTO contains message bodies, tool arguments/results, approval/question payloads, working-directory paths, file content, credentials, transport identities, or raw errors. Unknown event kinds are discarded.

## Mounting seam
The production mount will construct an `InProcessApiClient` over `ctx.apiProxy` and pass it into `DshReadClient`. The demo uses a fixture source with the same narrow interface. This keeps core projection tests independent of DSH process boot.

## Planned modules
- `src/contracts`: DTO validation and event allowlist.
- `src/projection`: baseline, incremental updates, stale/rebaseline state machine.
- `src/dsh-source`: live DSH host seam.
- `src/fixture-source`: deterministic executable demo input.
- `src/console-sink`: demo presentation.

## Acceptance
The executable demo displays two conversation rows and safe lifecycle summaries. Tests prove sensitive payload fields never enter the sink and a stream failure triggers rebaseline.
