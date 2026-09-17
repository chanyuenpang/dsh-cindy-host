# ADR: A new conversation's runtime is applied at create, and permission presets are only installed by advertised name

## Context

Reported from the handset: 「新对话选择了 gpt 模型，一运行又变成了 deepseek」. The picker was not
the defect and neither was DSH: `maker:create-session` read `id` and `workingDir` out of the
controller's argument and dropped the rest of the runtime it was handed, and a **new**
conversation has nowhere else to put that runtime — the handset pipeline is create → getSession →
enqueue and never calls `setModel`.

The consequences were mechanical once the field was gone. DSH resolves a session's route in
`selectionFor`: a session with no `model/selection` event and no request header falls back to the
profile's `agent-default-model`, so the first prompt ran on deepseek-flash and the authoritative
row the handset read back agreed. The same drop hit two more fields with worse shapes:

- **`permissionMode`** — the handset's permission options *are* this Host's advertised list, so a
  user who picked `read-only` received the profile default of `danger-full-access` while
  believing the agent was restricted. A wrong answer here is not annoying; it is a privilege the
  user did not grant.
- **`providerId` on the session row** — never emitted, although the same `modelSelection`
  projection that answers `model`/`effort` carries `provider`. The controller derives its next
  new-conversation draft from `{ model, providerId }`, so "跟随最近会话" reproduced the model and
  lost the source.

The two vocabularies involved are not the same one, and that is the whole difficulty. This Host's
permission names come from DSH's preset table (`read-only` / `workspace-write` /
`danger-full-access`); the controller also has `ask` / `default` / `acceptEdits` / `plan` / `auto`
/ `bypassPermissions`, which it sends only when its capability read failed and it fell back to its
legacy list. A create that carries a name this Host cannot install has exactly three possible
answers, and two of them are wrong.

## Decision

1. **A create installs the runtime it was given, after the create, through the same seams the
   explicit channels use.** `createSession` applies the model selection via `applyModelSelection`
   (shared with `maker:set-model`, `maker:set-effort`) and the permission preset via
   `installPermissionMode` (shared with `maker:set-permission-mode`). One implementation per
   write, so create and the explicit channels cannot drift.
2. **A create installs a permission preset only by an advertised name.** Advertised names are
   installed verbatim; anything else keeps the profile preset. **No translation** between the two
   privilege vocabularies — mapping `auto` onto `workspace-write` or `bypassPermissions` onto
   `danger-full-access` would be this Host choosing a privilege level for the user out of a word
   that means something else on each side. **And no refusal** either, because refusing would leave
   a phone whose capability read failed unable to start any conversation — worse than running the
   profile preset, which the authoritative row then reports honestly.
3. **An unhonoured request is logged, not silent.** `ctx.logger` (cordis's built-in logging
   service) records the requested mode with the advertised list, and the reply never names a
   preset it did not install.
4. **A refusal the seam can name must reach the controller as a refusal.** A model no catalog
   group serves, and DSH's own `session/model-unavailable`, both answer `NOT_AVAILABLE`; `THREW`
   is what the controller reads as this Host crashing. A failure that is not a refusal travels
   unchanged.
5. **The session row carries the source beside the model**, folded from the same projection, and
   **omits** the field when the session never chose one — absent is what the controller reads as
   "follow the Host's default route".

## Alternatives

- **Translate the controller's legacy permission vocabulary onto DSH presets** — rejected: the
  mapping is a product decision about privilege levels, taken silently, on a value that only
  arrives when the controller could not read this Host's capabilities. It would also make the
  same draft create different presets on different Hosts.
- **Refuse a create whose `permissionMode` is not advertised** — rejected: the legacy list is sent
  precisely when the capability read failed, so this would turn a degraded read into "this phone
  can no longer create conversations". The session is created either way; the honest failure is
  the row, not the refusal.
- **Keep dropping `providerId` and let the controller fall back to the default route** — rejected:
  the model and its source are one selection in DSH, and the controller's next draft is built from
  that pair. Emitting half of it is the same class of loss this ADR is about.
- **Write the model selection before the create** — impossible: `session.selectModel` resolves the
  session's agent, so a selection needs a session to belong to. Create-then-install is the only
  order DSH allows.
- **Subscribe to DSH settings to apply the profile default instead** — rejected: it changes
  sessions nobody asked to change, and it would still not give a conversation its own selection.

## Consequences

- Creating a conversation from the handset now writes the profile's `agent-default-model` as well
  (`sessionController.selectModel` does both by design, as the desk's own picker does). This is
  inherited DSH semantics, not an invention here; only a future DSH API that separates "this
  session" from "the default" would change it.
- Every create with an `model` now pays one `sessionController.selectModel` round trip, and every
  create with an advertised `permissionMode` one preset write. Both are the writes the explicit
  channels already made.
- The compatibility surface grows: `createSession`'s options are now part of the seam contract and
  must stay in step with what the controllers send.
- The refusal codes are load-bearing for the controller's retry policy (`NOT_AVAILABLE` is a
  refusal it can read; `THREW` is a crash), so a new failure in this path must choose one
  deliberately.
- Verification: the unit tests pin each shape, and the sandbox probe pins the row the handset
  actually reads (see `.claw/truth/dsh-cindy-host-new-session-runtime.md`).

<!-- state: history -->
## Decision evolution

<!-- dated: 2026-09-18 -->
### The model half was fixed first, and the class was named before the rest was fixed

The first round only installed the model selection, and the reason to write the other two down
before touching them was that they answer differently: `permissionMode` cannot be passed through
(the vocabularies differ) and `providerId` is not a write at all (it is a fold). Retaining the
split matters because the tempting shortcut — translate the permission vocabulary so the field
always "works" — is the alternative this ADR rejects, and a reader who only sees the three fixes
will not see why the third one stayed unimplemented on purpose.