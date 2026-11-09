# Changelog

## 0.1.41 — 2026-11-08

- Accept the exact DSH `0.2.2-rc.1` Agent/Session/Settings carrier alongside the existing 0.2.1 RC and 0.2.2-alpha.2 peers. Keep DSH packages host-provided and preserve 0.1.40's complete feature set, including credentials without keytar.
- Keep historical ordinary forks visible when they retain parent lineage; identify delegated sessions by `origin: 'subagent'` across discovery, active reads, direct lookup and creation pushes.
- Update the development SDK lock to the reviewed RC; distinguish DSH 0.2.2's Node >=24.9 requirement from the plugin's older-carrier Node >=22.16 baseline. Keep Cindy handshake identity unchanged.
- Validate the actual release candidate separately from the earlier 0.1.31-based local prototype: 1,235 automated tests passed (8 skipped), native question/Gateway checks 4/4, RC core contracts 7/7, real Windows DPAPI persistence/restore/renewal/logout, channel audit with 0 unclassified channels, and clean tarball installation with Web runtime smoke 30/30. Live relay/handset and real OAuth/model requests remain outside this compatibility release's verification claim.

## 0.1.40 — 2026-11-07

- Declare `source: 'desktop'` consistently on ordinary DSH task rows in session lists and direct detail reads, independently of model/provider identity. Let Cindy recognize known ordinary-task provenance without requiring an extra source-confirmation lookup before mounting the chat.
- Preserve provenance when history counts are unavailable and keep missing tasks as explicit `NOT_FOUND` failures. Add projection/router regressions without changing authorization, source logs, provider selection, Cindy code or its cache implementation; handset re-entry/cache behavior remains separate acceptance.

## 0.1.39 — 2026-11-07

- Serve bounded, authorized project-grid WebP thumbnails through the existing file-browser contract; keep original-file reads independent of codec failures.
- Preserve native tool/assistant image blocks through deterministic Cindy managed-media references. Resolve only the DSH attachment namespace against visible source messages and full native descriptors (including omitted optional names), verify bytes/hash/MIME, and deliver bounded thumbnails or on-demand staged originals. Keep live/history identities, source/connection fences, retry/cache budgets and explicit missing-source failures; never infer upload authority from JSON localPath.
- Add Host regressions for generated PNG/JPEG media, legacy/canonical results, restart/history consistency, thumbnail resource/path boundaries and staging retries. No Cindy changes; publication, runtime activation and handset acceptance are separate verification steps.
- Classify newly observed companion-live/setup-snapshot/setup-transfer channels as unsupported with exact refusal regressions. This read-only audit maintenance enables no cloud-companion, configuration migration, secret transfer or SSH authorization capability.

## 0.1.38 — 2026-11-07

- Show a valid `run_code` description in Cindy's collapsed tool label as a Host-only display alias. Normalize the preview to one bounded line, remove control/bidi-spoofing characters, and cap it at 120 Unicode code points without changing original input or full details.
- Keep execution tool names, call/result identities, other tools and exact-name special cards unchanged. Share the projection between live and history reads; invalid/missing descriptions retain the original name. Add focused display/input-immutability/pairing regressions; handset rendering remains separate acceptance.

## 0.1.37 — 2026-11-06

- Use explicit source-order history snapshots for both validated persistence and the hot fallback reader. Preserve legacy raw order, reconcile live reasoning through native history-live client identities, and page by source cuts; unknown cursors now fail explicitly rather than silently skipping history.
- Fold raw thinking pushes only for the subscribed controller that successfully received a current history page. Reset this disposable state on read/send failure and lifecycle changes, preserve pending-read trailing refreshes, and fence replies against stale relay generations.
- Coalesce interim reasoning at 1s with latest-wins deduplication and serialized UTF-8 budgets (32 KiB/s, 64 KiB burst/snapshot). Bound automatic preview ranges to 5 rows/6 KiB without truncating full details or delaying terminal retirement. These are Host-side safeguards, not handset white-screen acceptance or proof that every device's failure is resolved.

## 0.1.36 — 2026-11-06

- Project proven native interruption identities and timestamp tuples consistently into session list/get, boundaries and reconnect updates. Clear non-pending/hidden/running presentation without fabricating transcript-clear or completion facts.
- Serve existing interruption acknowledgement and committed-error dismissal calls through authenticated owner-scoped, revisioned native settings. Store hashed display preferences only, verify authoritative readback, guard source/controller/tail races, and overlay history without rewriting source events or receipt evidence.
- Treat the pinned current Cindy continuation prompt as a new explicit durable human input with planMode:false. Capture and recheck the native tail around proven scoped plan-off, deduplicate continuations for that tail, and reconcile superseded/non-admitted refusals as removed receipts instead of retrying automatically. Legacy non-durable fallback refuses this control contract.
- Extend Host/ledger/native-input regressions and opt-in read-only Cindy consumer contracts. Existing wire limitations remain explicit: no atomic CAS against unrelated desktop writers, screen-generation token in acknowledgement, immediate client rollback of failed ignores, or automatic replay of unknown tool outcomes.

## 0.1.35 — 2026-11-05

- Show distinct native interruption, cancellation, sign-out, output-limit and blocked-turn notices without inventing model failures. Keep explicit native scheduled/started retries nonterminal, with safe known-code/count/delay details and stable live/history identities.
- Match native cold-query diagnostic recovery only when both the native session and Agent are absent. Apply display-only interrupted-turn closers without changing stored events, receipt evidence or live tool outcomes; restore notices before terminal envelopes under the existing authorization and generation guards.
- Render canonical tool-role results alongside legacy nested results, preserving call pairing, output and error/unknown-outcome markers. Extend Host diagnostic regressions and the opt-in actual mobile contract; source tests are not handset or arbitrary desktop-UI parity certification.

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
