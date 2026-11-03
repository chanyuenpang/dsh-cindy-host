# ADR: Adapt only native capabilities expressible in existing Cindy channels

## Context

The phone-facing Host bridges Cindy DeviceLink onto DSH. Native API availability alone does not imply that an existing Cindy request can faithfully express an operation. The [capability mapping](<../../../doc/native-capability-adaptation-20261103.md>) distinguishes native ownership, runtime service gates, official phone schemas, supported variants and explicit refusals across nine groups. In particular, native job kill/output exists without an official remote entry, while current-surface history cannot provide frozen/anchored target snapshot admission. Earlier Host audit strings were insufficient protocol evidence.

## Decision

Keep the existing Cindy protocol and DSH core/profile unchanged. DSH remains the single business-state and authorization owner; the Host translates only proven native subsets, with authorized reads, actual runtime service checks and native completion/error semantics. Do not simulate state, add unsupported channels, silently discard accepted fields or return empty success to hide a capability gap.

Support membership pin, scoped no-extra-instructions compact, ordinary exact-boundary fork, literal keyword search, owner-fenced jobs reads, parent-catalog subagent reads, existing-session recurring reminders, registered Workspace custom order and source-side current-history reads. Explicitly refuse non-equivalent variants, including job kill/output-tail over nonexistent remote channels, subagent controls, complete scheduler/run accounting, activity/cross-device ordering and frozen reference target consumption. A source-readable reference does not authorize target admission; retain the false probe and guards at admission/edit/durable replay boundaries. The detailed current behavior has one owner in [protocol Truth](<../dsh-cindy-host-device-link-protocol.md>).

For phone/protocol adaptation, Cindy source is read-only reference, not code to modify/copy/execute as a test dependency. Use directly affected Host-owned tests and read-only audits; whole-suite verification requires explicit user authorization. Publication, plugin reload and real-session/phone acceptance are separate from source delivery and are not implicitly authorized.

## Alternatives

- Extend Cindy channels or change DSH core/profile to fill every product-level gap: not selected; the accepted scope forbids those changes.
- Add Host-owned reminder/order/job state or turn unsupported requests into approximate success: rejected because ownership, permissions, persistence and completion semantics would diverge from DSH.
- Enable capability flags from installed SDK packages or from source history access alone: rejected; mounted native services and equivalent operation semantics are required.
- Continue executing Cindy consumers or running the full suite after every slice: rejected for this adaptation; read-only contract reference and targeted Host tests preserve the clarified verification boundary.

## Consequences

The nine groups are delivered as explicit native subsets, not full Cindy feature parity. Missing services, unsupported variants, native refusals and partial persistence remain visible; transport receipts do not create durable exactly-once guarantees. No native business-state replica or new remote control authority is introduced. [Pin registry adapter](<../../../src/dsh-session-archive.js>), [plugin composition](<../../../src/dsh-plugin.js#L753-L808>), [job reader](<../../../src/dsh-background-jobs.js>), [subagent authorization](<../../../src/dsh-subagent-reads.js>), [reminder adapter](<../../../src/dsh-reminders.js>), [Workspace order](<../../../src/dsh-project-order.js>) and [reference guard](<../../../src/session-reference-boundary.js>) anchor the implemented boundary.

The [verification owner](<../dsh-cindy-host-verification.md>) separates targeted source evidence from historical full-suite outcomes, deployment activation and handset acceptance. The native-subset work has not been published/reloaded or certified on a real phone/profile; those checks require separate authorization. Future scope expansion must establish both an official channel and equivalent native semantics before changing refusal/capability claims. This decision complements, rather than replaces, the narrower [native archive authority ADR](<0017-native-session-archive-authority.md>).
