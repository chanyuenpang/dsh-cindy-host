# DSH Cindy Host: runtime and settings card contract

<!-- state: current -->
## Current behavior

`dsh-cindy-host-demo` (package name `dsh-cindy-host-demo`, version `0.1.1`) is a DSH
plugin bundle that mounts the 「Cindy 手机连接」 card in **Settings → Plugins** and
lets this Host be reached from the Cindy mobile client. The Host is the only truth
for connection state: the card writes settings and renders whatever the Host's
`status` answer contains.

Composition and mounting:

- `package.json` declares `"main": "./src/dsh-plugin.js"` plus
  `exports["."] = "./src/dsh-plugin.js"` and `exports["./client"] = "./lib/client.js"`.
  Both halves must stay declared: DSH client-module discovery throws when a package
  declares `dsh.client` but exports no `./client` bundle.
- `dsh: { bundle: { patch: "./cordis.patch.yml" }, client: { platform: "web" } }`
  carries the bundle patch and the web client platform.
- `src/dsh-plugin.js` exports `name = 'dsh-cindy-host'`, `inject = ['settings']`, and
  `apply(ctx)`. It registers the settings namespace `dsh-cindy-host` with schema
  `{ transportEnabled, remoteControlEnabled, controllers }` and
  `applies: 'live'`, then starts `startHost(source, scope.get())` inside
  `ctx.effect` so plugin teardown stops the runtime.
- `webServer` is injected optionally (`ctx.inject(['webServer'], …)`), so headless
  compositions still get the runtime and settings, minus the browser surface.

Card surface:

- `lib/client.js` registers through `window.__ModuleLoader__.load({ id: "dsh-cindy-host-demo", factory })`,
  the same handwritten CommonJS-factory pattern the platform itself uses; there is
  no build step and the only platform dependency is the seeded `react`.
- The card injects `['slots', 'settingsScope']`, binds
  `ctx.settingsScope.bind({ namespace: 'dsh-cindy-host' })`, and injects the slot
  `settings.plugin.item` with key `dsh-cindy-host`. Injecting the slot (rather than
  calling `slots.register` directly) is required: the Plugins tab declares that
  slot, and a bare register fails with `slot "settings.plugin.item" is not declared`.
- The switch writes `transportEnabled` through the bound settings scope and polls
  `GET /api/dsh-cindy-host/status` every 1500 ms. `switchOn` is true when
  `transportEnabled === true` or `remoteControlEnabled === true`.
- The card shows exactly the five Host states with their labels: `disconnected`
  未连接 / Not connected, `authenticating` 登录中 / Signing in, `waiting`
  等待手机连接 / Waiting for phone, `connected` 已连接 / Connected, `failed`
  连接失败 / Connection failed. Device rows render `name || deviceId`, platform,
  and `deviceId`.

Constraints and pitfalls:

- Do not add this bundle to the daily DSH profile. The smoke test uses a disposable
  `DSH_HOME` (`.sandbox/dsh-home`) and a separate port, so the shipped presets, the
  DSH Web shell, and the user's main profile stay untouched.
- The external package must use only version-pinned public DSH packages and must
  never resolve DSH's nested `node_modules`.
- `transportEnabled` is false by default, so a freshly mounted profile cannot log
  in or connect until the switch is turned on.

Code anchors:

- `package.json` (exports, `dsh.bundle`, `dsh.client`)
- `src/dsh-plugin.js` (`apply`, settings namespace, optional `webServer` row)
- `lib/client.js` (`__ModuleLoader__.load`, `settings.plugin.item`, poll loop)
- `src/host-status.js` (`CONNECTION_STATES`, `STATE_LABELS`, `STATE_LABELS_EN`)
- `cordis.patch.yml`

Verification rules:

- `npm test` (`node --test`) is the entry gate; a clean run must pass every test.
- Gate 1: with `DSH_HOME` pointed at `.sandbox/dsh-home`,
  `dsh --profile cindy-smoke --dump-config` must compose the bundle.
- Gate 2: `dsh --profile cindy-smoke --no-open --port 3081` must show a running
  host with no Cindy authentication prompt; the card bundle is served as the
  `dsh-cindy-host-demo` entry of `window.__DSH_BOOT__`.
- `npm test` renders the card with React, so card markup and state rules are
  covered without a browser.
- The sandbox is a second, independently restartable instance (`tools/sandbox.mjs`,
  `npm run sandbox` / `sandbox:stop`) whose plugin entry is a link to this repository, so
  it loads new source without touching the instance that hosts a conversation. It has its
  own credential (`session-v1@<digest>`) and therefore its own relay device, which is what
  makes two installations on one machine coexist rather than fight over one device id.
- `tools/restart-host.mjs` restarts an instance — including the one hosting the session —
  by starting a supervisor through **WMI** (`Win32_Process.Create`), because a process
  spawned from an agent command stays inside that command's Windows job object and is
  reaped when the command ends. The relaunched instance must be spawned **detached**: with
  `detached: false` it dies with the supervisor, and its output must go to a **file**, not a
  pipe (a destroyed pipe is an EPIPE that DSH's fail-loud handler turns into `exit(1)`).

Turn state and live ordering (the facts behind 「看不到进度」「插入跑到前面」「工作卡在我上面」):

- **The turn state's authority is DSH's own boundaries, not the row cache.** `turn/start`
  and `turn/end` write `liveTurnState`; `isSessionRunning` consults it first and falls back
  to a read row only when no boundary has ever been seen. The row cache is filled by *list
  reads*, so a Host that has just restarted has no row to write to — and the earlier version
  dropped the fact on the floor, which made a live turn report `isSessionRunning: false` and
  the history view mark the running group `isStreaming: false`.
- **The history view is wired to that state.** `createHistoryViewController`'s
  `sessionRunning` defaults to `() => false`, so `buildDshSource` takes it as an option and
  the plugin passes `runtime.isSessionRunning` lazily. Without the wiring the running card is
  never marked streaming: no live card on the phone, and nothing for the pin below to detect.
- **A running work group is pinned last.** A streaming group is the present tense; anything
  that sorts after it by time (a prompt still queued for the next turn, a row that arrives
  while the turn runs) is placed above it. A finished group keeps its place in history.
- **Pending prompts are placed where the user typed them**, merged into the page by
  acceptance time (`mergePendingByTime`), on both the view and `local-db:messages:list`
  (which is newest-first). This is a prediction: a queued prompt is delivered at the next
  turn boundary, so it can move once, when it becomes durable.
- **The poisoning codes are reserved for capability absence.** `UNSUPPORTED_CAPABILITY` and
  `CHANNEL_NOT_ALLOWED` answer "this Host has no such projection at all" and never a property
  of one session; the controller's `historyViewController.refresh()` returns early forever
  once its error matches that family, and only a reset clears it.
- **A steer that DSH refuses is retried as a normal prompt.** The mode follows the session
  (`maker:input:steer` with no live turn becomes a prompt), and a refusal whose text is about
  steering (`current turn no longer accepts steering`) is retried once as `queue`, because
  the gap between our check and DSH's decision is a race and the user's words must not be
  what loses it. Every other failure still travels to the controller unchanged.

Failure containment and observability:

- **Every listener this plugin hands the host goes through `guarded(label, listener)`.** Cordis
  dispatches with no `try`/`catch` and its `waterfall` returns a listener's promise to DSH, where
  a rejection reaches the boot's fail-loud handler (`fatal load failure` → `process.exit(1)`).
  A source-level test fails on a bare `ctx.on(` registration.
- **`diagnostics` is a contract**: the block must exist and every key must be present, each
  volatile field read through a try/catch accessor, because the status route answers a throwing
  producer by omitting the whole block. `diagnostics.boundaries` carries a verdict —
  `recovered` (it contained something that would have exited the process), `starting`, or
  `silent` (up past `BOUNDARY_SILENCE_MS` with nothing contained, which is a finding, not a
  clean bill of health) — with the installed listener labels beside it.
- **`handlerErrors[].where` names the channel** (`invoke:<channel>`): seven identical
  `TimeoutError`s are unattributable without it, and "which read is missing its budget" is the
  only question that field has to answer.

## Distribution

- **0.1.1 ships as a GitHub Release tarball, not to a registry**: tag `v0.1.1` +
  asset `dsh-cindy-host-demo-0.1.1.tgz` on
  `https://github.com/chanyuenpang/dsh-cindy-host/releases`. `package.json` therefore
  keeps `private: true` and `license: UNLICENSED`; `private` here is the
  accidental-publish switch, not a "not ready" marker (`doc/publishing.md` §5.5).
- **Optional capabilities may never block mounting.** `@deepseek-ai/dsh-host-apiproxy`
  (only used on the older DSH `apiProxy` path) and `keytar` (native, and not built by
  default under pnpm 10) are both loaded **lazily, inside a try/catch, with a
  degradation path**; the proxy dependency also lives in `optionalDependencies`. A
  top-level `import` of either one turns an optional capability into a hard
  requirement that fails the whole profile at boot — that is exactly what 0.1.0 did.
- **`keytar` is the one install-time compilation requirement** (`keytar.node`), because
  the Cindy login session belongs in the OS credential store rather than on disk.
  Since 0.1.1 a failed build still mounts the plugin, with credential abilities
  answering `CREDENTIAL_STORE_UNAVAILABLE`.

<!-- state: history -->
## Evolution history

<!-- dated: 2026-09-17 -->
### Optional capabilities became hard requirements

0.1.0 was the first version installed from a tarball into a brand-new `DSH_HOME`
instead of the sandbox's `link:` profile, and that install failed: the top-level
`import` of `@deepseek-ai/dsh-host-apiproxy` resolved a transitive copy of
`@deepseek-ai/dsh-agent-presets` without `InvalidPresetIdError`, and the top-level
`import keytar` resolved an unbuilt native module (pnpm 10 does not run dependency
build scripts). Either one aborted the profile's boot. 0.1.1 makes both lazy and gives
each a degradation path; the retained lesson is the rule above, not the two incidents.

<!-- dated: 2026-09-17 -->
### Card mounted without the client bundle

The first mounted form of the card carried only a `./src/dsh-plugin.js` main entry.
It was replaced because DSH client-module discovery throws when a package declares
`dsh.client` but exports no `./client` bundle, so the card could not be served until
`exports["./client"] = "./lib/client.js"` existed beside `exports["."]`. Both exports
are now part of the mounting contract; the failure mode is retained here because a
future package or entry rename can reintroduce it.
