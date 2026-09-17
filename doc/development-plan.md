# Development Plan

## Slice 0 — documentation and contracts
Create this research record, architecture contract, repository guide, and a project plan before code.

## Slice 1 — pure projection core
Implement DTOs, allowlisted activity projector, in-memory model, fixture source, console sink, and unit tests. No DSH package import is needed for this slice.

## Slice 2 — DSH host mount
Create the profile-bundle adapter that receives `ctx.apiProxy`, uses `InProcessApiClient`, opens events streams, and supplies the pure projection core. Pin public `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2` (and any other imported public DSH packages) in the host bundle; never resolve DSH's nested dependency directory. Add a live-host smoke test only in an authenticated DSH process.

## Slice 3 — separately approved Cindy transport
Only after the demo is validated, design the Cindy device registration, authentication, topic schema, and Android compatibility integration. It is intentionally not part of the current demo.

## Quality gates
- Node test suite passes.
- Demo has no write/command/file/credential imports.
- Fixtures and console output are free of sensitive DSH payload fields.
- Stream failure produces a generic stale state and rebaseline; it never logs raw error or frame payload.
