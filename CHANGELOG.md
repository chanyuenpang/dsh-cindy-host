# Changelog

## 0.1.34 — 2026-11-05

- Project durable native failed turns as stable, sanitized error rows and terminal maker events in both cold history and live delivery. Preserve native failure/retry ownership, expose only fixed known-code messages and validated HTTP status, and repair reconnect state without stopping newer turns or leaking provider diagnostics.

- Register user questions before either surface displays them, including sessions a phone has never visited. Replay the existing pending cards on session subscribe/reconnect; keep them through temporary relay recovery and remove the hidden Host question timeout, without changing permission ownership/deadlines.
- Settle local and phone answers through the same pending completion; preserve native cancellation/timeout errors and clear both cards on task stop instead of returning empty/undefined answers. Keep the existing Cindy protocol and DSH native UI. Add focused Host regressions and opt-in tests against installed Cordis/userQuestions/Gateway; these are not live-handset acceptance or a production deployment.

## 0.1.33 — 2026-11-04

- Add authorized current-surface reference-source history through native observations, real message identities, filters/cursors and explicit clipping metadata. Keep frozen target-reference capability false and reject structured contexts before every admission/edit/preparation/replay boundary; do not disguise source reads or plain links as target consumption.

- Adapt the existing sidebar custom-order calls to native registered Workspaces and insertBefore, with verified account/device/source stamps, all-key prevalidation, serial native moves and truthful partial/concurrent failure snapshots. Refuse activity and cross-device/unregistered/ambiguous variants; do not create another order store.

- Adapt existing-dialogue recurring reminder CRUD to the native schedule owner with complete-record update CAS, strict execution-field refusals, genuine one-time read/delete and known-created-ID recovery. Forward only committed ready notifications with authorized peer-lifetime cleanup; do not fabricate pause, run history, cost, completion or notifications. Cover the slice with focused Host tests only.

- Adapt the three existing subagent read endpoints to native parent/descendant catalogs, actual consumed-work/live-state evidence and private-context-safe child-owned transcripts. Keep all controls and unproved returned-result capability false; add signed 25-entry/byte-bounded continuation/tail paging and Host-only focused tests. Consume the SDK work reader as a host-provided peer, without installing core/profile packages.

- Add provider-backed Mainland/Global settings-page login: Apple/other enabled social providers, enterprise SSO, regional discovery/confirmation, code delivery, account selection, required binding and SSO verification. Use official endpoint manifests, hosted callback/PKCE/poll-secret or configured loopback fallback; keep all authentication tickets and tokens backend-only. CAPTCHA uses the official challenge page with an explicitly manual successful-URL return in a normal browser.
- Fence login, cancellation, logout and refresh on the serialized encrypted-credential owner; reject stale UI steps and cross-origin/non-JSON mutations. Rebuild an immutable regional connection context so device-link, media and ICE cannot receive another region's credentials. Include isolated protocol, HTTP, actual local callback, UI state and runtime URL regressions. These regressions do not establish real Apple/enterprise login or iOS acceptance.

- Adapt the official background-task roster to the native owner-fenced jobs registry and reuse native control frames for real task-status updates. Keep stopping nonterminal, omit unknown continuation claims, and never consume output, invent a file/provider/tool origin, or expose fictional stop/output channels. Cover Host owner/state mapping and stale-frame/source teardown fences with focused tests.

- Serve native literal keyword search with real current-message identities/counts, all accepted filters/sorts, genuine limits over 20, bounded scans and cancellation. Refuse explicit semantic/hybrid requests without an enabled native backend; do not pretend global FTS is mounted. Add focused Host protocol field-mapping tests using the official schema as a read-only reference.

- Adapt ordinary fork using committed message identities and exact native user-before/completed-assistant-turn cuts. Return the real child row, publish the existing created event, and retain child IDs across attachment/discovery/source failures without automatically creating another child. Unsupported branch/rewind/encrypted variants stay refused.

- Serve the existing compact-session channel using verified native scoped DSH commands, with strict instructions refusal, real no-op/error results, in-process duplicate-envelope protection, stop/disconnect cancellation, and history invalidation. The Claude queue-compaction protocol is not treated as an alias.

- Wire pin/unpin metadata to the native DSH workspace registry, with membership-only stable wire projection, committed desktop-to-controller refresh, idempotent retries, legacy-overlay retirement, and pre-write mixed-operation validation. No Cindy protocol extension or native timestamp/order claim.

- Fix mobile thinking visibility: send structured `{ text }` content instead of the prose string the mobile normalizer silently drops. Keep ordinary user/assistant prose unchanged.
- Forward public DSH reasoning chunks during generation, coalesce native thinking pushes, expose the active prefix through history/work details, and retire temporary rows when the durable or interrupted assistant message arrives. Do not transmit private replay metadata or count previews as durable activity.
- Add regression coverage for the real pinned mobile thinking normalizer, cold/live history, preview retirement, cancellation, routing and teardown. Package/runtime checks are not live-handset acceptance.
- Route native archive, reminder and project-order event subscriptions through the Host-owned guarded boundary, and pin native replacement fixtures to the real SDK `startSeq`/`endSeq` contract. Synchronize the development lock on the verified 0.2.1-rc.5 carrier while preserving the declared peer compatibility range.
- Improve the read-only channel audit for imported scalar constants, generic/double-quoted call sites and independent mobile consumers. Explicitly document actual refusals of optional controlled-model catalog, usage widget, machine status and unmapped migration/cloud/provider protocols; this does not enable those features or certify all new Cindy protocols.

## 0.1.32 — 2026-11-03

- Remove keytar and its native npm build chain. Linux/macOS keep system credential vaults through secret-tool/security; Windows encrypts with built-in DPAPI CurrentUser and persists ciphertext through the native DSH credential record service. Login, renewal and logout share one installation-scoped store; failures never fall back to plaintext or pretend a stored login is absent. Windows upgrades may require one explicit login; legacy vault entries are left untouched.

- Add exact DSH `0.2.2-alpha.2` session/settings peers and its Schemastery `3.18.6-alpha.1` peer, retaining the existing rc.3/rc.4/rc.5 carriers. Alpha's own Node.js >=24.9 requirement still applies.
- Replace removed `standingKeyFor` draft discovery with the current preset revision lease (`acquireScope`), released after successful or failed reads; prefer isolated live-Agent skill services and retain older-carrier fallback.
- Add lease-lifecycle regressions and a reproducible isolated-alpha core-contract smoke covering real compatibility admission, Loader activation, Session message/input identity and preset skill visibility. Controller/settings/archive method checks are structural only; alpha Web, persistent settings, relay and handset acceptance remain separate gates. The core-contract smoke does not modify or reload a production profile.

- Connect archive/restore metadata to native DSH workspace-registry durability, with native activity checks, cross-device committed archive updates, list-cache invalidation, and explicit unpin acknowledgements. Preserve legacy controller archive flags until an explicit operation retires them; deletion remains non-destructive and Host-local.

- Delegate remote model switching to native DSH when its selection API is composed. The Host now advertises model-window authority so Cindy does not reject DSH selections with its legacy Pi/unknown-capacity precheck. Running-turn selections and selecting the original model again use the same DSH next-request API; no Cindy or DSH core patch is required.
- Keep missing native selection unavailable and preserve native refusal propagation. Regression coverage includes capability/catalog degradation, all three client aliases, switching back, and the unmodified Cindy consumer guard.

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
