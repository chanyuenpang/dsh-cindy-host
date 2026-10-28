# Changelog

## 0.1.29 — 2026-10-29

- Publish from a clean, committed Git source tree; preserve the accepted 0.1.28 runtime behavior.
- Make native Android queue/ACK and durable-outbox regression tests offline and repository-contained.
- Pin upstream Cindy test sources with Apache-2.0 LICENSE and NOTICE; exclude all fixtures from the npm package.
- Synchronize the dependency lock and version-aware isolated smoke helper; retain current DSH SDK peers without forced upgrades.

## 0.1.28 — 2026-10-28

- Fix busy input confirmation on both controllers: DSH admission no longer removes an actual pending inbox row from later projections.
- Reconcile queued, next-step steering, claimed and accepted states using real inbox/user evidence; never infer consumption from a lagging mirror.
- Preserve pendingQueue across an Android push overtaking its enqueue ACK; remove it only on genuine claim/consumption/cancellation.
- Test current Android projection parsing and authority epochs, alongside the existing durable delivery regressions.

## 0.1.27 — 2026-10-28

- Implements current input-delivery v1 in Host: transactional complete-payload ownership before ACK, receipts, cancellation seals, authoritative clear boundaries, immutable logical identity and recoverable edits.
- Adds real persistent around/around-client-id history with content bounds and confirmation-anchor-preserving frame degradation.
- Uses public DSH flush and storage read checkpoints; a live claim/admission gap never authorizes replay. Verified dead-process/cold-owned-queue recovery is distinct from same-process reload.
- Captures attachment bytes before handoff; no temporary file receipt or staging URL is treated as durable ownership.
- Requires the verified DSH 0.2.1-rc.3 carrier and Node >=22.16; exact DSH peers prevent mixed-prerelease dependency graphs. Unsupported optional operations remain explicit refusals.
- Retains editable names, desktop string queue content, production model/active-session features and optional keytar.
- Upstream mobile outbox execution tests cover FIFO, lost ACK, cancellation and history-cache completion. Live handset acceptance remains a separate gate.

## 0.1.26 — 2026-10-28

Host-only patch based on 0.1.25; retains its DSH 0.2 adapter, model catalog, active-session listing, optional keytar and bundle identity.

### Fixed
- Queue UI echoes use string content, preventing desktop text parsers from receiving SDK block arrays.
- Early durable consumption cannot be undone by a later enqueue/steer ACK or stale queue/inbox snapshot. Evidence is session-scoped, capped at 2,048 recent entries and cleared on teardown.

### Added
- Persistent editable Host display name with separate local-save/cloud-sync feedback.
- Host status pluginVersion for loaded-release verification.

### Boundaries
- No Cindy desktop or mobile modifications. DSH 0.2.1-rc.3 desktop runtime; Node >=22.
- Automated regressions cover protocol shape and queue ordering; live incident-specific phone/desktop verification is still required.
- Optional advanced client features remain unavailable; this is not a full new-client feature release.
