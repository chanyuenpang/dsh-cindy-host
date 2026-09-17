# Research: DSH Cindy Host

## Objective
Build a read-only host-side demo that projects a DSH conversation list and safe activity summaries. A future Cindy transport may consume the projection, but this demo does not connect to Cindy.

## Verified findings
- DSH host plugins receive `ctx.apiProxy` through `@deepseek-ai/dsh-host-apiproxy`.
- The same package exports `InProcessApiClient` and `toFetchHandler`, so a host bundle can read sessions without browser scraping or a network carrier.
- The DSH events API exposes host and mux streams. Mux may include raw session events, messages, tool views, approvals, and questions.
- Cindy uses a host-as-source-of-truth model; controller clients consume projected list/activity views.

## Scope for this demo
Included: session snapshot, session lifecycle/running-state summaries, stale/rebaseline handling, console presentation, deterministic fixtures and tests.

Excluded: Cindy relay/authentication, Android integration, remote commands, approval responses, file access, settings, tokens, raw message content, tool payloads, error text, and any DSH/Cindy source modification.

## Evidence anchors
- `@deepseek-ai/dsh-host-apiproxy/lib/types/index.d.ts` lines 2-8 and 24-27: host `ctx.apiProxy` and transport-neutral gateway.
- `@deepseek-ai/dsh-host-apiproxy/lib/types/api/events.d.ts`: host/mux frame contracts and answerable interaction frames.
- `@deepseek-ai/dsh-host-apiproxy/lib/types/fetch/client.d.ts`: in-process client.
- `G:/Projects/Cindy/packages/device-link/src/topics.ts`: controlled host projection/topic model.

## Decision
Use an internal `ProjectionSink` rather than Cindy device-link. It keeps this demo executable without credentials and makes the later transport integration an explicit security-reviewed change.
