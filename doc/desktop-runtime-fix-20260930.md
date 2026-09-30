# Desktop 0.2 Cindy connection hotfix — 2026-09-30

## Scope and authoritative copies

- Desktop: DSH 0.2.0-rc.2, profile `C:\Users\chany\.dsh\profiles\desktop`, URL `http://127.0.0.1:19387`.
- Installed package: `node_modules/dsh-cindy-host-demo`, version 0.1.16 with this local hotfix (not a published release).
- Migration source: `G:\Projects\DSH-cindy-host-020`, Git worktree branch `feat/dsh-0.2.0-rc.2`.
- `G:\Projects\DSH-cindy-host` is the older main worktree, NOT the source to overwrite the desktop installation from. Existing unrelated dirty work in both worktrees was preserved.

## Observed causes

1. Profile patch already stored `transportEnabled: true` and `remoteControlEnabled: true`, but live Host remained disconnected with `login.authenticated=false`, `login.required=false`, no host/device identity and no relay attempts. The 0.1.16 compatibility scope copied `apply(ctx, config)` once and assumed future settings changes would remount the plugin. DSH 0.2 volatile Config edits deliberately do not remount it. Settings service source and live Inspect confirm `settings/document-updated(ns, revision)` and `settings.describe()` are the re-read contract.
2. Installed keytar 7.9.0 JavaScript package existed, but `build/Release/keytar.node` was absent. Its lazy require failure was cached as null and `loadSession` returned null, conflating inaccessible credentials with absent credentials. The existing OS credential remained readable through the development installation. No credentials were cleared, printed, or refreshed during diagnosis.
3. Client ConfigFormController returns false for rejected writes. The switch ignored that result; it also wrote the two flags separately. A successful authenticated state did not display account information/logout except when the connection failed.

The settings namespace remains `dsh-cindy-host`, NOT `include:dsh-cindy-host`: the latter is the Loader inspection id. Runtime SettingsForms describe/write use `entry.options.id`. ConfigForms was not present in the Client Inspect catalog; its exact methods were inspected in the packaged desktop implementation instead of guessed.

## Implemented changes

- Host settings scope re-reads resolved settings after document updates, detaches nested snapshots, suppresses duplicates and catches sync/async watcher errors.
- Runtime reconciles latest settings after asynchronous startup; early boundary error reporting handles an undefined runtime safely.
- Missing credential storage reports `CREDENTIAL_STORE_UNAVAILABLE` and a failed connection, not a request for another login.
- Client writes both flags atomically through `mutate` when available; legacy `set` remains supported and explicit false is rejected.
- Status read errors are displayed rather than silently becoming disconnected; authenticated UI shows a masked identifier and logout in waiting/connected states too.

## Local deployment

Four files were backed up and copied from migration source to the desktop installed package, with SHA256 equality checks:

- `src/dsh-plugin.js`
- `src/auth-session.js`
- `src/host.js`
- `lib/client.js` (handwritten served bundle; no build step in this package)

Backup: `C:\Users\chany\.dsh\profiles\desktop\cindy-fix-backup-20260930` (source files only, no credential values).

The missing installed keytar binary was restored from the same-version local development installation:

- Source: `G:\Projects\DSH-cindy-host-020\node_modules\keytar\build\Release\keytar.node`
- Destination: `C:\Users\chany\.dsh\profiles\desktop\node_modules\keytar\build\Release\keytar.node`
- Windows x64, N-API v3, 707584 bytes.
- SHA256: `90e35de89ab5e5f9290e4ff1bbadcf221a82b2aa0d9b922187dc980adff3c831`.
- A fresh Node process anchored to the installed plugin successfully loaded the store and confirmed only presence booleans for saved credentials. This is NOT an Electron-in-process or authentication-server verification.

No install/build scripts were run. A future reinstall may overwrite the hotfix or omit keytar's binary again; release packaging still needs a supported prebuild/build installation path with explicit build-script permission.

## Verification and remaining boundary

- Focused host settings/plugin/boundary tests: 46 passed.
- Focused auth/runtime tests: 48 passed.
- Focused client tests: 23 passed.
- Full initial regression: 695 passed, 1 skipped, 0 failed. Final all-changes regression: **702 passed, 1 skipped, 0 failed** (703 total, approximately 30 seconds).
- Channel audit: 196 named invoke channels, 52 served, 144 deliberately declined, 0 unclassified; push classification also 0 unclassified. This is coverage accounting, not proof every DSH 0.2 session API works live.
- Test logs: `G:\Projects\DSH-cindy-host\artifacts\desktop-runtime-inspect\migration-tests.log` and `migration-tests-final.log`.

After file deployment, the existing live process still reports disconnected and its diagnostic boundary list lacks `settings-document-updated`, proving that it is still executing the old Host module. No whole-desktop restart or plugin enable/disable was performed. Do not claim the desktop connection is restored until the following are verified:

1. User fully exits and restarts Desktop (not just closes a window to tray), then reopens this conversation.
2. Read the same URL's Cindy status. New boundary list should include `settings-document-updated`; enabled settings should trigger credential restore and relay connection.
3. Check whether normal stored-session refresh succeeds. Stored access-token expiry metadata was past; refresh-token validity was deliberately not tested independently. Do not request fresh login unless the real restored runtime reports it necessary.
4. Open Settings → Cindy Phone Link and confirm account/status rendering, switch on/off behavior, then attach the phone and verify device listing and session reads.

No client automatic reload is promised, and a separate replacement server would not update this desktop.

## Post-restart observation (2026-09-30 13:20 UTC)

Live status now reports `connected`, authenticated=true, login.required=false, 7 known devices and 149 projected sessions. Diagnostic boundaries include `settings-document-updated`; the repaired Host module is active. The user confirms phone synchronization with existing running sessions works. Device count includes discovered devices, not seven simultaneous controlling phones.

The user separately reports unstable newly created sessions, including `No DSH session 02df58ff-6ec6-43fd-bb74-b3c79e5d0efa`. The ID has a real local projection-cache record; refusals include `local-db:sessions:get` and `local-db:messages:view`. This is a new-session lookup/visibility investigation, not evidence that credential or relay repair failed. Do not clear credentials or phone data.
