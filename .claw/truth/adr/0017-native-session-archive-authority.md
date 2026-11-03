# ADR: Use DSH registry as session archive authority

<!-- document-state: accepted -->

## Context

The Host's session metadata protocol exposed archive/restore to Cindy clients, while a Host-only archive overlay could hide rows without changing DSH's durable workspace archive state. That split risks disagreement between clients, desktop DSH and later reads. DSH provides workspaceRegistry.archiveSession / unarchiveSession and archivedSessionIds.

## Decision

Use the injected DSH workspace registry as the sole authority for new archive and restore operations and for archive-aware list/get/activity projections. Do not downgrade missing native services or native/storage rejection to local-only success. Do not implicitly stop running work: let the native operation refuse it. Keep legacy Host archive overlays until that session is explicitly archived/restored, then clear only that session's overlay; do not bulk-migrate historical flags. Keep deletion as a separate controller-only hide.

## Alternatives

- Keep writing only Host-local archive flags: rejected because it does not update DSH's durable cross-client state.
- Bulk-migrate old local flags on upgrade: rejected because it silently changes historical sessions outside an explicit user operation.
- Stop active work automatically before archiving: rejected because the archive gesture does not grant that authority.

## Consequences

Archive state survives through DSH's registry and committed native workspace changes refresh Host list projections and publish existing row patches. Archive clears the pin while preserving history and workspace membership. Native capability and storage failures remain visible. Anchors: src/dsh-session-archive.js, src/dsh-plugin.js (registry injection), and test/dsh-session-archive.test.js. The source plan reports the full suite at 937 passed, 1 skipped, 0 failed; no tests were rerun during this knowledge pass. Publication, reload and phone hardware acceptance remain outstanding.
