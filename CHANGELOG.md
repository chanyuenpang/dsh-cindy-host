# Changelog

## 0.1.31 — 2026-10-31

- Merge `main` into the DSH 0.2.1 carrier. `main` was a single working-tree snapshot that had diverged since the 0.2.1 peers landed; every conflict was resolved by keeping the newer, functionally wider side and re-taking `main`'s unique fixes rather than picking a whole file.
- **Behavioral change from `main`:** media and file-peer fetch accept Cindy's native URL shape — a project-folder export sends only `path` and an optional `v`, with no directory roots. Containment is now enforced only when the controller names roots; the never-serve denylist (`.ssh`, `.aws`, `.gnupg`, `.env`, `id_rsa`, …), the regular-file check, the 25 MiB cap and the authenticated-controller policy are unchanged.
- Add the native-contract fixture matrix (15 extensions × POSIX/Windows roots, offline) and a file-peer test that pins the rootless transfer and its EOF end to end.
- Keep DSH 0.2.1-rc.3/rc.4/rc.5 as the accepted peer set; the verified isolated runtime for this release is **DSH 0.2.1-rc.5** on Node.js 24.12.
- Device deletion keeps the bearer-renewal retry added on this carrier (401 → renew once through the Host owner, then re-validate the target before retrying); `doc/device-management.md` now states that exception instead of claiming deletion never renews anything.
- `doc/` stays out of the published package, as it has since 0.1.28; `doc/publishing.md` no longer documents the opposite.

## 0.1.30 — 2026-10-31

- Accept `@deepseek-ai/dsh-session` and `@deepseek-ai/dsh-settings` `0.2.1-rc.4` and `0.2.1-rc.5` in addition to `0.2.1-rc.3`. The pinned single-version peers made `dsh plugin add` reject the install on a host that had already moved to rc.5. No runtime behavior change.

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
