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
- **permissionMode** crosses an explicit vocabulary boundary. Cindy `ask / acceptEdits / bypassPermissions` map to DSH `read-only / workspace-write / danger-full-access`; list rows map back the same way. `maker:set-permission-mode` and create-session accept only mapped Cindy values, unknown values fail closed instead of leaking or guessing DSH preset names.
- **desktop/mobile provider discovery** is owned by the DSH catalog projection described below; it is not a second provider registry. `maker:get-new-maker-defaults` exposes only catalog default model/provider/effort and truthful `fastMode:false`. Cindy-owned draft preferences are not invented.
- **`providerId` on the session row.** `dsh-session-source.js` folds it out of the same
  `modelSelection` projection that answers `model` and `effort` (`next ?? lastUsed`), and
  `cindy-session-row.js` carries it. A session that never chose one has **no** `providerId`
  field on the wire: the controller reads a missing field as "follow the Host's default route",
  which is what such a session runs. `pickRecentSessionRuntime` derives the next new-conversation
  draft from `{ model, providerId }`, so dropping it lost the source while the model looked right.
- **`agentKind` is a display alias, not a route.** The Host advertises Cindy's three wire aliases
  (`claude-code`, `codex`, `pi`) for one DSH harness. `agentKindForModel` classifies the applied
  model/provider in both session rows and create replies: a confirmed DeepSeek provider gives
  `pi` even for an unknown model; a GPT/ChatGPT model with a confirmed non-DeepSeek provider
  gives `codex`; an unknown model without a confirmed DeepSeek source, unresolved or
  conflicting provider, or any other model gives `claude-code`. Missing catalog data only
  prevents classification when the session's own provider/model cannot establish it. When
  the session has no selection, the catalog default may
  supply both model and provider; when only the provider is missing, a model uniquely matched
  in the catalog (or matching its default route) may resolve it. A model shared across providers
  is not sufficient evidence. The chosen alias never changes DSH model routing.

### Provider discovery contract (current installed compatibility pass)

The current completed compatibility pass keeps DSH's catalog as the membership/default owner and enriches the Host's Cindy display projection using exact-route metadata. In maintained sibling worktree `../DSH-cindy-host-020`, this implementation is anchored at [host-model-catalog.js](<../DSH-cindy-host-020/src/host-model-catalog.js>) and the channel integration in that worktree's `toProviderList` path. The resolver is the DSH `llm.resolveModelInfo(provider, model)` service: exact provider/model identity and a positive safe integer context window are required before enrichment. Lookup is bounded to four concurrent routes and a 3-second total deadline; failures retain the model with unknown capacity (0) and do not fabricate metadata or remove catalog membership. Routing markers and selection remain unchanged.

The contract is intentionally scoped: an old desktop consumer whose actual decoder filters out contextWindow 0 will still discard models with genuinely unknown capacity. The completed installation was accepted for the seven measured real-capacity models only; it is not proof of unknown-capacity compatibility, a Cindy decoder upgrade, a release, or skill/command compatibility. The read-only real-ingress check is [check-model-picker-contract.mjs](<../DSH-cindy-host-020/tools/check-model-picker-contract.mjs>); it serializes one Host response, separately feeds it through desktop parsing and mobile cache ingress, then compares both against Host routes for draft and session scopes. The associated task recorded full tests as 768 pass/1 skip/0 fail and audit 54 served/142 declined/0 unclassified; the user confirmed the installed dual-client UI test passed. These are bounded incident results, not permanent expected counts. Verification ownership remains [verification rules](<.claw/truth/dsh-cindy-host-verification.md>); decision rationale is [ADR 0015](<.claw/truth/adr/0015-model-catalog-display-projection.md>).

### Earlier provider discovery contract (release 0.1.21)

This historical contract describes the published 0.1.21 behavior. Its maintained implementation was in sibling worktree `../DSH-cindy-host-020` (branch `feat/dsh-0.2.0-rc.2`, commit `8699b61`). The original workspace still contains older source; never assume its package or router is the installed release. Project-relative implementation anchors below refer to that maintained worktree.

- DSH `sessionController.modelCatalog` owns provider/model availability. The Host's `toProviderList` is a stateless display projection; selection still goes through `applyModelSelection` and `sessionController.selectModel`.
- `maker:provider:list` returns provider ID/name, advertised aliases, models, and `connected` derived from `catalog.routableProviders`. Each advertised alias has `routing[alias]: {}`: Cindy's shared registry requires runtime presence even though execution endpoints, credentials, headers, and an invented `wireProtocol` must never cross the boundary.
- The production DSH catalog observed in this incident provided model ID/name/description/reasoning, **not** `contextWindow`. Missing or invalid capacity is projected as `0` (unknown display metadata), not used to exclude a model. Positive capacities, when supplied, remain unchanged. An empty catalog remains empty; a failed catalog read remains `NOT_AVAILABLE`.
- A successful provider-list response disables Cindy's legacy capabilities-only fallback. Seeing the correct session/default model or a nonempty `availableModels` list does not prove the picker has any provider rows.
- Evidence anchors: [toProviderList](<../DSH-cindy-host-020/src/host-models.js#L162-L212>), [router](<../DSH-cindy-host-020/src/cindy-channels.js>), and [real Cindy consumer regression](<../DSH-cindy-host-020/test/host-models-cindy-contract.test.js>). Verification ownership is [verification rules](<.claw/truth/dsh-cindy-host-verification.md>); rationale is [ADR 0015](<.claw/truth/adr/0015-model-catalog-display-projection.md>).

This is a model-discovery contract, not proof that desktop/mobile skill lists or every other remote resource surface are compatible. The newly reported desktop skill-list failure is unverified here and must not inherit the model incident's root cause.

Deliberately not honoured, and why:

- **requested agentKind as a routing instruction** — the three advertised aliases are
  presentation-only; create applies the requested DSH model/provider, then echoes the alias
  derived from the applied route rather than trusting the controller's draft kind.
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
- `src/dsh-session-source.js` (the `modelSelection` fold), `src/cindy-session-row.js`
  (`agentKindForModel`, the wire row), `src/cindy-channels.js` (roster, catalog, create reply)

Verification rules:

- Unit: `test/cindy-channels.test.js` (forwarding, the reply not claiming an uninstalled
  preset, and create-reply aliases), `test/dsh-plugin.test.js` (installs / resolves the provider /
  refuses an unroutable model / logs-and-keeps an unadvertised preset / the explicit channel
  still writes what it is given), `test/cindy-session-row.test.js` (the provider-aware alias
  and wire row), and `test/dsh-session-source.test.js` (`providerId` present or absent).
  Check missing and conflicting source, DeepSeek unknown-model precedence, and non-DeepSeek GPT.
- Live, on the sandbox (`.sandbox`, whose plugin entry links this repository): create with
  `deepseek-v4-pro` + `low` → the row reports both; Cindy `permissionMode=ask` installs DSH `read-only` and the row reports `ask`; an unknown Cindy permission is rejected rather than silently installed; no model → no `providerId` on the row. `node tools/acceptance.mjs --base
  http://127.0.0.1:3081 --with-prompts` → 105/105, 52/52 served, 10/10 push.

<!-- state: history -->
## Evolution history

<!-- dated: 2026-10-02 -->
### Two independent filters caused the mobile empty picker

The desktop provider-list addition omitted runtime presence markers and discarded every model without a positive context window. The first repair added only runtime markers; tests supplied a fictional contextWindow field, so they passed while the real picker stayed empty. Runtime inspection then showed seven capability models but an empty provider list. Preserving unknown capacity fixed that second filter; the user subsequently confirmed the phone list recovered. Retain both causes when comparing older installed builds, rather than treating the initial patch as sufficient.

<!-- dated: 2026-09-23 -->
### Unknown session sources no longer masquerade as Pi

Earlier rows and create replies used `pi` for every DSH session because the controller's
kind vocabulary was treated as a single harness identifier. The 0.1.13 release changed that
presentation boundary to classify an evidenced provider/model and fall back to Claude when
its source cannot be established; keep the former rule here when diagnosing older installed
profiles. A restart without an actual profile upgrade did not install the changed mapping.