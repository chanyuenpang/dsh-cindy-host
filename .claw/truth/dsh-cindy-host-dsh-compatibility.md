# DSH host compatibility boundary

<!-- state: current -->
## Current behavior

The published `dsh-cindy-host` 0.1.31 package accepts the DSH session and settings peers at `0.2.1-rc.3`, `0.2.1-rc.4`, and `0.2.1-rc.5`; the release's isolated registry-install smoke test used DSH 0.2.1-rc.5. The current working tree additionally declares exact `0.2.2-alpha.2` peers for session/settings and `3.18.6-alpha.1` for Schemastery, while retaining the three rc peers and `^3.18.1`; this is not yet a published package claim (the package version remains `0.1.31`). `package.json` is the compatibility authority for peer ranges. Neither source-level support nor the isolated alpha smoke establishes activation in a normal profile or support for other prereleases.

For the reviewed `0.2.2-alpha.2` candidate, `test/dsh-alpha-compat.test.js` locks the exact peer list, lockfile synchronization, lease release on successful/failed reads, and legacy fallback behavior. `tools/dsh-compat-smoke.mjs` checks the actual DSH compatibility evaluator against accepted and rejected versions, then exercises alpha Loader activation, Session message/input identity, and preset-scoped skill lookup using an isolated npm SDK and unpacked plugin. The recorded run passed 7/7 core smoke checks. This is not Web rendering, settings persistence, relay, handset end-to-end, or live-profile activation; alpha API method presence checks are structural only. The candidate remains unpublished until the package version and release are advanced.

The live session projection uses the host services present in current DSH Web:

- `src/dsh-plugin.js` resolves the source through `SOURCE_SERVICES = ['sessionController', 'apiProxy']`: `ctx.inject([name], …)` waits for the service and re-runs on removal, so a service that activates after this plugin still wires up. `sessionController` is what current DSH Web mounts and is preferred.
- `src/dsh-session-source.js` adapts `sessionController.list()` and Cordis `api-session/*` events to the projection interface. It excludes delegated/subagent sessions and any session carrying a `parentSessionId`, and — when a title reader is available — hides rows that have never produced a real title, because an unknown title is not evidence of a task. Exact `getSession` stays available for a fresh draft.
- `src/dsh-plugin.js` retains an optional `apiProxy` adapter for environments that expose it; it is not the current DSH Web session source (0.2.1-rc.5 does not install `@deepseek-ai/dsh-host-apiproxy` at all). That adapter is `createRequire`d lazily and a failure degrades to "this seam serves nothing", because a static import made the whole profile fail to boot on a package the current DSH never uses. An optional capability must never be able to break mounting — see ADR 0010.

The release was installed from the registry in a clean DSH home and started successfully: the reported plugin version was 0.1.31, the status endpoint returned the session-controller data source with no handler errors, and the boot payload included the client bundle. This verifies startup/status integration on the tested DSH 0.2.1-rc.5 runtime; it does not by itself establish every projection behavior on every host configuration.

## Code anchors

- `package.json` (`version`, `peerDependencies`)
- `src/dsh-plugin.js` (optional service discovery and source selection; `withAgentScope` uses `acquireScope()`/async disposal for draft skills and keeps the legacy fallback)
- `src/dsh-session-source.js` (`createSessionControllerSource`, session visibility filtering)
- `test/dsh-plugin.test.js`, `test/dsh-session-source.test.js` (plugin/source contracts)
- `test/dsh-alpha-compat.test.js` and `tools/dsh-compat-smoke.mjs` (exact alpha compatibility and isolated alpha core-contract coverage)
- Release verification: the durable, user-facing statement is in `README.md` and `CHANGELOG.md` (0.1.31). The raw run logs for that gate live under the gitignored `.sandbox/` and `.release/` and are not part of the record.

## Verification rules

- Peer compatibility claims must match `package.json`; do not infer support for other DSH versions from one successful runtime.
- Unit tests establish adapter contracts; a clean-host runtime smoke establishes startup/status only. Keep those scopes distinct.
- The retained `apiProxy` adapter is optional legacy compatibility, not evidence that current DSH Web provides that service.
