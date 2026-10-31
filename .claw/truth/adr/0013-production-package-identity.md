# ADR: Use one production package identity for DSH Cindy Host

## Context

The project began as `dsh-cindy-host-demo`, while its Cordis row, plugin name, settings namespace, and HTTP prefix were already `dsh-cindy-host`. Keeping two active identities leaked “demo” into npm, Profile dependencies, bundle composition, and the Web module loader, and made duplicate loading possible during migration.

## Decision

The canonical npm package, DSH bundle name, and client ModuleLoader id are `dsh-cindy-host`. The version line continued at `0.1.20`; it did not restart at 0.1.0. Cordis row id, server plugin name, settings namespace, and HTTP API prefix remain `dsh-cindy-host`, so persisted settings and Cindy credentials do not move.

Profile migration is publish-first and exactly-once: verify the new registry artifact, then replace dependency, bundle list, lockfile, node_modules, Cordis patch, and composed row as one offline transaction, preserve the old tarball for rollback, and restart only after all active layers name the new package. The old npm package is deprecated rather than unpublished or shimmed.

## Alternatives

- Keep `dsh-cindy-host-demo`: rejected because it presents a production bridge as an experiment and perpetuates dual identity.
- Publish a shim package under the old name: rejected because both bundles can be composed and register the same row/settings/API owners.
- Unpublish old versions: rejected because exact-version rollback and historical installs remain useful.
- Restart versioning at 0.1.0: rejected because the new name is a continuation of the same product and compatibility history.

## Consequences

- Active package/bundle/client identities must always move together; exactly-one checks are a release gate.
- Historical documentation may retain the old name only when it explicitly describes an old artifact.
- `dsh-cindy-host-demo` remains installable by exact version but carries a deprecation message pointing to `dsh-cindy-host`.
- A failed Profile migration restores the saved package/lock/Cordis snapshot and the retained 0.1.19 tarball.

<!-- state: history -->
## Decision evolution

<!-- dated: 2026-10-01 -->
### Production rename

`dsh-cindy-host@0.1.20` was published, tagged, installed into the desktop Profile, and verified after restart as the sole active package; the old installed directory was absent and the Host was connected.
