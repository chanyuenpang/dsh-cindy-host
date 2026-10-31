# DSH Cindy Host: runtime and settings card contract

<!-- state: current -->
## Current behavior

`dsh-cindy-host` (npm package and DSH bundle name `dsh-cindy-host`, current published release `0.1.31`) is the production DSH
plugin bundle that mounts the 「Cindy 手机连接」 page in Settings and lets Cindy desktop and mobile clients reach this Host. The Host is the only truth
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
  `{ transportEnabled, remoteControlEnabled, controllers, deviceId, deviceName, sessionFlags }`;
  `deviceName` remains optional for older stored settings and defaults to the empty sentinel.
  `applies: 'live'`, then starts `startHost(source, scope.get())` inside
  `ctx.effect` so plugin teardown stops the runtime.
- `webServer` is injected optionally (`ctx.inject(['webServer'], …)`), so headless
  compositions still get the runtime and settings, minus the browser surface.

Card surface:

- `lib/client.js` registers through `window.__ModuleLoader__.load({ id: "dsh-cindy-host", factory })`,
  the same handwritten CommonJS-factory pattern the platform itself uses; there is
  no build step and the only platform dependency is the seeded `react`.
- The client module has only `slots` as a blocking dependency. It resolves settings non-blockingly through `configForms` on DSH 0.2 or `settingsScope` on 0.1.x, then contributes the `settings.section` page keyed by `dsh-cindy-host`. Missing settings services must not block client-module activation.
- The switch writes `transportEnabled` through the bound settings scope and polls
  `GET /api/dsh-cindy-host/status` every 1500 ms. `switchOn` is true when
  `transportEnabled === true` or `remoteControlEnabled === true`.
- The card renders Host states from the status snapshot; `src/host-status.js` defines
  `disconnected`, `authenticating`, `connecting`, `waiting`, `connected`, and `failed`
  with Chinese and English labels. Device rows render `name || deviceId`, platform, and
  `deviceId`.
- Settings also edits the Host's display name. `deviceName` is an optional compatible
  setting; absent or blank uses `DSH Host`. A saved name is trimmed for use, limited
  to 1–64 UTF-16 code units, and rejects control characters; the editor is disabled
  when settings are read-only. Saving is local and works offline. Runtime hello, status,
  and session device identity use the configured name. When authenticated, the runtime
  serializes `PATCH /api/device-link/devices/:id` name updates; a failed remote sync is
  reported separately from local save, and reconnect is not forced. See
  `src/host-settings.js`, `src/host-device-name.js`, `src/host.js` (settings watcher,
  hello and status), and `lib/client.js` (`HostNameForm`, `writeHostName`).

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
- `src/host-settings.js` (`deviceName` default and validation), `src/host-device-name.js` (serialized remote sync), `src/host.js` (runtime propagation)
- `test/host-settings.test.js`, `test/host.test.js`, and `test/client-card.test.js` (settings, runtime and editor coverage)
- `cordis.patch.yml`

Verification rules:

- `npm test` (`node --test`) is the entry gate; a clean run must pass every test.
- Gate 1: with `DSH_HOME` pointed at `.sandbox/dsh-home`,
  `dsh --profile cindy-smoke --dump-config` must compose the bundle.
- Gate 2: `dsh --profile cindy-smoke --no-open --port 3081` must show a running
  host with no Cindy authentication prompt; the card bundle is served as the
  `dsh-cindy-host` entry of `window.__DSH_BOOT__`.
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

- **0.1.31 is the current published registry version** of production package `dsh-cindy-host`
  (tag `v0.1.31` → commit `828d287`, release commit on top of the origin/main merge `4e8c867`;
  the docs follow-up `2d335c8` and everything after it stay outside the published `files`
  whitelist, so the tag was not moved). npm `latest` SHA-1 is
  `2177efc6cad76544cc70abc4c473980a2741e59f`, integrity
  `sha512-KjB0/ZB+mtympckPoBbDlTqjWmieyulx7DNBK9Xl8eontfdUbuvtFlK3OSzX8ICTYCveBkUGfQgL9MYzv/FRWA==`,
  67 files / 254.9 kB packed. It absorbs origin/main's rootless media-fetch containment and
  targets the verified DSH `0.2.1-rc.5` service contracts (peers also accept `0.2.1-rc.3` /
  `0.2.1-rc.4`). Release gates: 924 tests / 921 pass / 3 skipped / 0 fail, `audit:channels`
  `unclassified: 0`. Post-merge acceptance was 72/80, with the **same 8 failures before and
  after** the merge (both runs on the expired sandbox Cindy login plus stale expectations) —
  zero regression, and not a clean pass.
- **0.1.31 is installed in the production `desktop` profile but not yet activated.** The
  profile dependency moved from `file:G:/Projects/DSH-cindy-host/dsh-cindy-host-0.1.30.tgz` to
  registry `0.1.31` (lock integrity equals npm `latest` above). Installing does **not** reload
  a running process: the instance on port 21398 kept reporting `pluginVersion: 0.1.30`,
  `state: connected`, zero handler errors until the user restarts DeepSeek Harness by hand —
  they chose to defer that restart rather than drop the conversation it was hosting. Verify
  after restart with `GET http://127.0.0.1:21398/api/dsh-cindy-host/status` →
  `pluginVersion: 0.1.31`. Rollback is one command: `dsh plugin --profile desktop add
  dsh-cindy-host@0.1.30` (the tarball is still in the repo root), and the pre-install
  `package.json` / `pnpm-lock.yaml` are kept in
  `~/.dsh/profiles/desktop/_backup-before-0131-20261031-231829/`.
  A clean-registry install into a throwaway `DSH_HOME` had already proven the package itself
  (`/status` → `200 installed=true pluginVersion=0.1.31`, boot payload serving
  `dsh-cindy-host/client.js`); the sandbox on 3081 runs 0.1.31 too.
- **Installing a newer release is not activating it, and "installed" is the wrong word for the
  running instance.** Earlier releases recorded exactly this gap in the opposite direction: the
  running desktop profile stayed on 0.1.28 while 0.1.29 was published (`productionRestarted:
  false`), and the 0.1.26 state before that was only confirmed loaded after a manual restart.
  The 0.1.28 runtime reported `inputDeliveryReady: true`, delivery version 1, connected, zero
  handler errors, and no last delivery error; the user confirmed the phone and desktop queue
  behavior normal after that restart. See `.release/ack-0.1.28/release-evidence.json` and
  [DeviceLink protocol Truth](<.claw/truth/dsh-cindy-host-device-link-protocol.md>). The
  inherited DSH SDK Zod advisory remains unresolved; no forced SDK upgrade was made.
- Historical 0.1.26 state: after manual restart, the desktop profile loaded 0.1.26 and was connected with zero handler errors. A later compatibility review found the default mobile durable-outbox confirmation route was rejected; 0.1.27/0.1.28 subsequently addressed the history and busy-queue gaps. See the dated evolution in [DeviceLink protocol Truth](<.claw/truth/dsh-cindy-host-device-link-protocol.md>).
- The 2026-10-14 installation used `plugin_manager` to install the exact published 0.1.23 tarball while registry propagation was delayed. Follow-up inspection confirmed the plugin enabled and version 0.1.23 installed; installed router SHA-256 matched production source. The installer reported a timeout after pnpm completed, so this does **not** prove live activation. The user chose a later manual restart; desktop activation and Cindy mobile end-to-end verification remain pending until after that restart.
- Release validation was deliberately scoped and user-approved: production worktree commit `5effc18` / tag `v0.1.23`; 770 unit tests passed with 3 skipped, with two skipped real-client contract tests rerun successfully; channel audit 54 served / 142 declined / 0 unclassified; clean isolated DSH mount and repeated missing-delete success over authenticated HTTP. Legacy broad acceptance was 67/77 and is **not** a release-green result; mobile end-to-end remains pending. Registry readback matched the final tarball integrity `sha512-rFu1LnLEQPQWOcz3ToZ+zHLlpv0ncirtxc1tlSu84YU4KStdgoF70csJtwBuj+PHvyTJ5cvxIpSeojv98np2lA==`.
- The active npm package, Cordis bundle name, client ModuleLoader id, Profile dependency/bundle/lock/node_modules identity must change together; the Cordis row id, plugin name, settings namespace and HTTP prefix remain `dsh-cindy-host`, so user settings and login state do not migrate.
- Historical 0.1.x validation retained the same clean-install rule: install into a brand-new
  `DSH_HOME` → `profile-local @deepseek-ai == 0`, compose passes, `dsh web` starts,
  `/api/dsh-cindy-host/status` → `200`. Its change is the new-conversation runtime
  (`.claw/truth/dsh-cindy-host-new-session-runtime.md`, `.claw/adr/0011`).
- **0.1.2 ships through the npm registry** (`dsh plugin --profile <p> add
  dsh-cindy-host-demo@0.1.2`), MIT, `private: false`. 0.1.1 was a GitHub Release tarball
  instead, and **its asset is defective** (it drags an old DSH generation into the
  profile — see below); the 0.1.1 Release entry is kept as history rather than deleted.
  Verified from the registry: install into a brand-new home → `profile-local
  @deepseek-ai == 0`, `dsh web` starts, `/api/dsh-cindy-host/status` → `200
  installed=true`.
- **DSH's own packages are peers, never dependencies** — this is the rule 0.1.1 broke.
  Every `@deepseek-ai/*` the plugin uses is a `peerDependency`; `dependencies` holds only
  what the host does not provide (`keytar`, `ws`). A DSH package declared as a dependency
  (or as an **optional** dependency — pnpm installs those by default) drags a whole DSH
  generation into the profile, and the host then composes a mixture of two generations and
  dies at load. Measured on 0.1.1: 21 profile-local `@deepseek-ai` packages at
  `0.1.1-rc.2` next to a `0.1.5-rc.2` host → `registerFileReceiptResolver is not a
  function` / `dsh-llm does not provide CallId`. See `.claw/adr/0010`.
- **Import only names the current host exports.** `settingsNamespace` existed in
  `@deepseek-ai/dsh-settings@0.1.1-rc.2` and is gone in `0.1.5-rc.2` (whose surface is
  `SettingsProvider`, `SettingsConflictError`, `redactSecrets`, `default`); it was the
  reason the old generation had to be installed. It is a brand — validate
  `/^[a-z][a-z0-9-]*$/`, return the string — so it now lives in `src/dsh-plugin.js`.
- **Optional capabilities may never block mounting.** `@deepseek-ai/dsh-host-apiproxy`
  (only used on the older DSH `apiProxy` path) and `keytar` (native, and not built by
  default under pnpm 10) are both loaded **lazily, inside a try/catch, with a
  degradation path**; the proxy is an optional *peer* so it is never installed for us. A
  top-level `import` of either one turns an optional capability into a hard
  requirement that fails the whole profile at boot — that is exactly what 0.1.0 did.
- **`keytar` is the one install-time compilation requirement** (`keytar.node`), because
  the Cindy login session belongs in the OS credential store rather than on disk.
  Since 0.1.1 a failed build still mounts the plugin, with credential abilities
  answering `CREDENTIAL_STORE_UNAVAILABLE`.

<!-- state: history -->
## Evolution history

<!-- dated: 2026-10-14 -->
### 0.1.23 published; profile activation remains unverified

The scoped release shipped from the production worktree as `dsh-cindy-host@0.1.23`. Registry integrity matched the final tarball, and the authenticated isolated DSH mount acknowledged repeated missing-session deletion. The current profile received the same reviewed tarball through `plugin_manager` after registry propagation lag; installed version and router hash matched the release source. The installer timed out after pnpm completion, and the user deferred restart to later manual action, so installed bytes are not evidence of live activation. The legacy broad acceptance remained 67/77, explicitly not green; mobile end-to-end verification is pending after restart.

<!-- dated: 2026-09-17 -->
### The dependency declarations poisoned the profile that installed them

0.1.1's fix for "optional capabilities must not block mounting" was to load the proxy
lazily and move it to `optionalDependencies`. That fixed the *load*, and left the
*install* broken: pnpm installs optional dependencies by default, and
`dsh-host-apiproxy@0.1.1-rc.2` pulls 28 `@deepseek-ai/*@^0.1.1-rc.2` packages, so
installing the plugin wrote a whole old DSH generation into the profile. The host then
composed two generations and would not boot (`registerFileReceiptResolver is not a
function`; `dsh-llm` has no `CallId`). Its own `settingsNamespace` import is what had
made that generation necessary. 0.1.2 moves every DSH package to `peerDependencies`,
inlines the three-line brand, and the clean-install gate now asserts
`profile-local @deepseek-ai == 0` and reads a live `/status` instead of trusting
`--dump-config`. Full reasoning and the two diagnostics that hid it:
`.claw/adr/0010`.

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
