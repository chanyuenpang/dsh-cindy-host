# ADR: Delegate remote model-switch authority to DSH

<!-- document-state: accepted -->

## Context

Remote clients may apply a conservative context-window preflight before requesting a model change. That heuristic can prevent a selection from reaching DSH even though the host's native session controller is the authority for route availability and selection. The DSH-cindy-host exposes model selection through `sessionController.selectModel`; capacity metadata or a remote estimate is not equivalent to that native decision.

## Decision

Keep model switching—including switching back—on the existing native `selectModel` route. Advertise `supportsModelWindowSwitchGuard` only when that native operation exists, so a capable remote client delegates the capacity/switch decision to DSH instead of locally imposing its legacy window threshold. Do not synthesize a native route, swallow DSH refusals, or promise rollback of context compaction. A successful selection applies to the next model request and does not cancel a request already issued.

## Alternatives

- Keep the capability disabled despite a working native selection route: rejected because the client can block a switch before DSH decides.
- Treat missing capacity as over-capacity or bypass DSH's own route validation: rejected because unknown display estimates are not DSH's runtime decision and real refusals must still propagate.
- Add a separate Host-side switch implementation or undo context compaction on switch-back: rejected because the native controller remains the single selection authority and selection is not a lossless context rollback.

## Consequences

The capability is derived from runtime seam availability, not catalog-read success. The `maker:set-model` channel continues to propagate actual refusal/errors. This permits switching and returning through the same interface, but does not guarantee context restoration after compaction. Truth and implementation anchors are maintained in [new-conversation runtime](<../dsh-cindy-host-new-session-runtime.md>), `src/cindy-channels.js`, `src/dsh-plugin.js`, and `src/host-models.js`; regression coverage is in `test/cindy-channels.test.js`, `test/host-models.test.js`, and `test/host-models-cindy-contract.test.js`. The source plan records 927 passing tests, one skip, and no failures; no tests were rerun during this knowledge pass. It also records that publication, plugin reload, and phone hardware acceptance remain outstanding.