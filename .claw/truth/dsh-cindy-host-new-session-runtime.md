# New-conversation runtime: what maker:create-session installs

<!-- state: current -->
## Current behavior

A Cindy controller (handset or desktop remote panel) submits a new conversation's whole
runtime in the `maker:create-session` argument: `{ id?, workingDir?, agentKind, workspaceKind,
model, permissionMode, fastMode, effort?, providerId?, extraDirs?, writableDirs? }`. It has
nowhere else to put it — the handset pipeline is create → getSession → enqueue and never calls
`maker:set-model` (`Cindy/apps/mobile/src/session/newSessionCreation.ts`; the transport declares
`setModel`, and the only callers in that tree are tests). What this Host installs, after the
create and through the same seams the explicit channels use:

- **model / providerId / effort** → `applyModelSelection` → `sessionController.selectModel`,
  exactly what `maker:set-model` calls. No `model` in the argument installs nothing. A model no
  catalog group serves, or a route DSH refuses (`session/model-unavailable`), answers
  `NOT_AVAILABLE` instead of `THREW`; the session that already exists is left in place for the
  controller's idempotent retry to adopt.
- **permissionMode** → `installPermissionMode`, the write `maker:set-permission-mode` also uses —
  but **only when the name is one this Host advertises** (`capabilities.permissionModes`, read
  from DSH's preset table). The handset builds its permission picker from that same list and
  coerces a draft value outside it onto the list's first entry
  (`Cindy/packages/maker-shared/src/agentCapabilities.ts`), so an advertised name is the ordinary
  case. An unadvertised name — the handset's legacy vocabulary (`ask`, `default`, `acceptEdits`,
  `plan`, `auto`, `bypassPermissions`), sent when its capability read failed — is **not
  translated and not refused**: the session keeps the profile preset, `ctx.logger` records the
  request with the advertised list, and the reply never claims it. Translating would pick a
  privilege level for the user; refusing would leave that phone unable to create any
  conversation at all.
- **`providerId` on the session row.** `dsh-session-source.js` folds it out of the same
  `modelSelection` projection that answers `model` and `effort` (`next ?? lastUsed`), and
  `cindy-session-row.js` carries it. A session that never chose one has **no** `providerId`
  field on the wire: the controller reads a missing field as "follow the Host's default route",
  which is what such a session runs. `pickRecentSessionRuntime` derives the next new-conversation
  draft from `{ model, providerId }`, so dropping it lost the source while the model looked right.

Deliberately not honoured, and why:

- **agentKind** — this Host offers one harness (`pi`), and the roster answers the same.
- **fastMode** — every model in the catalog declares `supportsFastMode: false` and the capability
  says `hasFastMode: false`, so no controller draws the control.
- **workspaceKind** — derived from `workingDir` on both sides, so the two cannot disagree.
- **extraDirs / writableDirs** — DSH has no extra-directory concept at all (no `@deepseek-ai/*`
  package mentions one) and this Host serves no `maker:set-extra-dirs` channel. That is an
  unimplemented feature, not a dropped field.

One inherited side effect: `sessionController.selectModel` also writes the profile's
`agent-default-model`, exactly as the desk's own model picker does. A conversation created on
gpt therefore becomes the default for sessions no picker has touched. Measured — the sandbox's
own `settings.yaml` read `deepseek-v4-pro / low` immediately after a create that asked for it.

Code anchors:

- `src/cindy-channels.js` (`maker:create-session`: parsing, forwarding, honest echo)
- `src/dsh-plugin.js` (`createSession`, `applyModelSelection`, `applyPermissionMode`,
  `installPermissionMode`, `advertisedPermissionNames`)
- `src/dsh-session-source.js` (the `modelSelection` fold), `src/cindy-session-row.js` (the wire row)

Verification rules:

- Unit: `test/cindy-channels.test.js` (forwarding, and the reply not claiming an uninstalled
  preset), `test/dsh-plugin.test.js` (installs / resolves the provider / refuses an unroutable
  model / logs-and-keeps an unadvertised preset / the explicit channel still writes what it is
  given), `test/cindy-session-row.test.js` and `test/dsh-session-source.test.js` (`providerId`
  present, and absent when the session never chose).
- Live, on the sandbox (`.sandbox`, whose plugin entry links this repository): create with
  `deepseek-v4-pro` + `low` → the row reports both; `permissionMode=read-only` → reply and row
  both `read-only`; `permissionMode=auto` → created, reply claims no preset, row keeps the
  profile preset; no model → no `providerId` on the row. `node tools/acceptance.mjs --base
  http://127.0.0.1:3081 --with-prompts` → 105/105, 52/52 served, 10/10 push.