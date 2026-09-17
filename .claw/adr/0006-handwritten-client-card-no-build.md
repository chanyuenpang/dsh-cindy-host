# ADR: Handwritten CommonJS client card with no build step

## Context

The card must mount in the DSH Web settings surface as a plugin client bundle. The
DSH client loader accepts a `window.__ModuleLoader__.load({ id, factory })`
registration whose factory returns a CommonJS-shaped module exporting `apply` and
`inject`; the platform seeds `react`, and the Plugins tab declares the
`settings.plugin.item` slot as a keyed child of its own tab. The repository has no
client build pipeline, and adding one would introduce a toolchain, a bundle artifact,
and a version-skew surface for a single card.

## Decision

Write the client half by hand as `lib/client.js`: a `__ModuleLoader__.load`
registration exposing `apply`/`inject`, deriving elements with `h()` instead of a
build-time JSX transform, injecting `['slots', 'settingsScope']`, registering into
`settings.plugin.item` with key `dsh-cindy-host` through `slots.inject`, and polling
`GET /api/dsh-cindy-host/status` every 1500 ms. Keep `exports["./client"]` and
`dsh.client` declared so DSH client-module discovery resolves the bundle.

## Alternatives

- Bundle the card with a build step: rejected — it adds a toolchain and a generated
  artifact for one file with no transpliation needs.
- Register the slot with a bare `slots.register`: rejected — the Plugins tab owns that
  slot, and a bare register fails with
  `slot "settings.plugin.item" is not declared`; `slots.inject` defers until it exists.
- Poll faster to feel live: rejected — 1500 ms already reads as immediate for a switch
  and a device list, without hammering the host.

## Consequences

- `npm test` renders the card with React, so markup and state rules are covered
  without a browser or a bundle step.
- Changing the card means editing the served file directly; there is no compiled
  copy that can drift from the source.
- The card depends only on the platform-seeded `react` and the Host's own HTTP route,
  so the `./client` export and `dsh.client` declaration remain load-bearing contract.
