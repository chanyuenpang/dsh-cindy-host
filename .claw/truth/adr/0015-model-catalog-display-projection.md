# ADR: Preserve model availability through a minimal cross-client display projection

## Context

The desktop provider-list integration switched controllers away from capabilities-only discovery. Its response was not sufficient for the mobile shared registry: missing runtime presence markers removed providers, while a positive-context-window filter removed models from the actual DSH catalog, which omitted that display field. A first repair passed synthetic tests but failed on the phone because its fixture supplied metadata the producer never emitted.

## Decision

DSH modelCatalog remains the sole owner of routable providers and models. The Host owns only the Cindy wire projection, shared by desktop and mobile; it must preserve required non-sensitive eligibility evidence without duplicating execution routing or inventing a second model table. For compatibility with the measured older desktop decoder, enrich missing context capacity only from DSH exact-route metadata (`llm.resolveModelInfo`); never invent a positive value. Capacity remains display metadata, not route membership: failed/unknown lookups retain the catalog model at 0, with the explicit consequence that the older desktop decoder can still filter it. The accepted incident scope was the seven measured real-capacity models, not unknown-capacity models. The precise current contract and code anchors belong to [runtime Truth](<.claw/truth/dsh-cindy-host-new-session-runtime.md>).

Acceptance must follow real producer output through actual consumer selection logic and a running installed Host, with phone confirmation kept distinct from source and package checks. [Verification Truth](<.claw/truth/dsh-cindy-host-verification.md>) owns the evidence ladder and release observations.

## Alternatives

- Remove provider:list and force legacy fallback: rejected because it removes the desktop provider-aware behavior instead of satisfying both consumers.
- Copy full DSH routing configuration: rejected because endpoint/auth/header data are not display facts and must not cross this boundary.
- Invent a positive context capacity or drop models whose capacity is unknown: rejected because either fabricates limits or hides a route DSH actually offers.
- Maintain a mobile-specific model registry or weaken Cindy's runtime eligibility checks: rejected because that duplicates availability truth or masks incomplete wire data.
- Treat fixture-based passing tests as final acceptance: rejected by the observed first-patch failure.

## Consequences

The projection preserves model membership even when capacity lookup is unknown, but an older desktop consumer may reject that row; mobile and shared-selector acceptance alone do not establish desktop compatibility. Exact-route enrichment is bounded and failure-isolated, and never grants connectivity, changes selected provider/model/effort, or exposes routing secrets. A future contract change must exercise both clients' real consumers and the installed response; successful model tests are not whole-product skills/commands compatibility evidence.

<!-- state: history -->
## Decision evolution

<!-- dated: 2026-10-03 -->
### Exact-route capacity enrichment is bounded to measured desktop compatibility

The completed compatibility pass used `llm.resolveModelInfo` to supply authentic context windows for the seven measured routes, with bounded concurrency and deadline; the installed dual-client UI was confirmed by the user. Unknown capacity remains 0 and is still excluded by the older desktop decoder. The change was not a Cindy decoder upgrade or a release. Preserve this scope so a successful known-model sample is not generalized to unknown models or all resource surfaces.

<!-- dated: 2026-10-02 -->
### Producer shape invalidated the first repair's fixture

Release 0.1.21 retained the runtime-marker repair and removed the missing-capacity exclusion after live evidence contradicted the first synthetic fixture. The phone was confirmed working before publication. This decision captures that established model-boundary correction, not a diagnosis of the later desktop skill-list report.