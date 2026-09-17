# DSH projection source compatibility boundary

<!-- state: current -->
## Current behavior

`src/dsh-host-source.js` `DshHostSource` is the host-only integration seam: it
consumes a public `InProcessApiClient` (from `@deepseek-ai/dsh-host-apiproxy`) and
exposes `listSessions()` plus `onEvent(listener)`. It unwraps the `session.list` RPC
success value (`{ ok: true, value: { items } }`), turns `host/session-added` /
`host/session-removed` / `host/session-status` and `session/subscribed` frames into
summaries, and converts a `stream/error` frame into a generic
`{ kind: 'stream-failed' }` signal with no raw error text.

The mounted boundary:

- `src/dsh-plugin.js` reads `apiProxy` with `ctx.get('apiProxy')` and only then
  constructs `new InProcessApiClient(toFetchHandler(apiProxy))` and a
  `DshHostSource`. The plugin's declared `inject` is `['settings']` only, so a host
  without `apiProxy` still mounts.
- The current DSH Web host installed here is `0.1.5-rc.2`. Its installation does
  **not** carry `@deepseek-ai/dsh-host-apiproxy`, and no installed composition
  provides an `apiProxy` service. The repo's own `node_modules` still contains a
  flattened `@deepseek-ai/dsh-host-apiproxy` (the declared dependency
  `^0.1.1-rc.2`), which is what makes the import resolvable at all. The
  `.claw/runtime/report-collectors/dsh.json` descriptor written at 2026-09-17
  00:52:53 belongs to that dsh-claw-kit report-capture machinery, not to this
  package's `apiProxy` seam.
- Consequence: on the current host `apiProxy` is `undefined`, so `client` and
  `source` are `null`, `startHost(null, …)` mounts with no projection, and the bundle
  mounts safely without a live DSH session source. The isolated smoke test validates
  composition and lifecycle only; it is not a projection test.

Constraints:

- Do not enable the Cindy transport in production against the daily profile on this
  boundary. A separate compatibility slice must adapt the projection source to the
  current Typert session/event remotes and then add a real-host read-only smoke test.
- The external package must use only version-pinned public DSH packages and must
  never resolve DSH's nested `node_modules`.
- Keep the seam dependency-injected (`DshHostSource(client)`), so the compatibility
  work replaces the client adapter rather than the runtime.

Code anchors:

- `src/dsh-host-source.js` (`DshHostSource`, frame mapping, `stream-failed`)
- `src/dsh-plugin.js` (`ctx.get('apiProxy')`, `new InProcessApiClient(toFetchHandler(apiProxy))`,
  `inject = ['settings']`)
- `README.md` section "DSH API compatibility boundary"
- `test/dsh-host-source.test.js` (contract tests for the older public adapter)

Verification rules:

- `test/dsh-host-source.test.js` pins the adapter contract: `session.list` success
  unwrapping, failure rejection, host/mux frame unwrapping, and the generic
  `stream-failed` signal.
- `test/dsh-plugin.test.js` and `test/host-settings.test.js` cover mounting and
  settings validation without a live source.
- Real-host projection verification is explicitly still outstanding; do not describe
  the projection as verified against the current DSH host.
