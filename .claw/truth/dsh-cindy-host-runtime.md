# DSH Cindy Host: runtime and settings card contract

<!-- state: current -->
## Current behavior

`dsh-cindy-host-demo` (package name `dsh-cindy-host-demo`, version `0.1.0`) is a DSH
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

<!-- state: history -->
## Evolution history

<!-- dated: 2026-09-17 -->
### Card mounted without the client bundle

The first mounted form of the card carried only a `./src/dsh-plugin.js` main entry.
It was replaced because DSH client-module discovery throws when a package declares
`dsh.client` but exports no `./client` bundle, so the card could not be served until
`exports["./client"] = "./lib/client.js"` existed beside `exports["."]`. Both exports
are now part of the mounting contract; the failure mode is retained here because a
future package or entry rename can reintroduce it.
