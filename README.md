# DSH Cindy Host

A Host-side adapter connecting current Cindy clients to DeepSeek Harness.

## Requirements and installation

Version **0.1.41** adds DSH `0.2.2-rc.1` compatibility and keeps historical ordinary forks visible by classifying subagents through `origin`, not parent lineage. It retains 0.1.40's task provenance, system credential storage, image delivery, thumbnails, work titles, history stability and interruption controls. Handset re-entry, rendering and white-screen acceptance remain separate.

It supports the exact **DSH 0.2.2-rc.1** carrier, while retaining `0.2.2-alpha.2`, `0.2.1-rc.3`, `0.2.1-rc.4` and `0.2.1-rc.5`. DSH 0.2.2 requires **Node.js >=24.9** (RC tested with 24.18); the older carriers retain this plugin's Node.js >=22.16 minimum. Agent/session/settings peers and alpha Schemastery are explicitly allowed, not a blanket promise for future prereleases. RC validation covers isolated Web installation and runtime smoke; the prior alpha checks cover core contracts. Neither establishes relay or handset acceptance. Install through the Desktop DSH plugin manager. CLI-managed profiles can use:

```sh
dsh plugin --profile <profile> add dsh-cindy-host@0.1.41
```

Reload the Host plugin after installation. A full DSH restart is separate. Keep existing Cindy sign-in, device identity and settings; do not run two Host processes with the same identity.

## 0.1.41: DSH 0.2.2 RC compatibility

Accepts the exact RC Agent, Session and Settings SDKs, Cordis 4.1 and Schemastery 3.19. Historical ordinary forks can retain `parentSession`/`parentSessionId`; only `origin: 'subagent'` classifies delegated sessions. The correction covers discovery, active reads, direct lookup and creation pushes. Cindy's handshake identity remains unchanged. See [verification details](doc/dsh-0.2.2-rc.1-compatibility.md) for candidate checks and the earlier local prototype's limits.

## 0.1.36: interruption controls

The existing Cindy acknowledgement/dismissal actions update owner-scoped display preferences, not failure or completion facts. Manual continuation is a new human input; it verifies the current native tail and effective plan-mode off rather than retrying old tool calls. These changes are Host-only: Cindy is a read-only protocol/test dependency. See the [diagnostic protocol and limitations](<doc/model-errors.md>) for persistence, concurrency and current-client boundaries. Source contracts do not establish live-handset acceptance.

## 0.1.32: credentials without keytar

No native npm credential module or C++ build toolchain is required. Linux uses `secret-tool` with an unlocked Secret Service (headless sessions need their own DBus/keyring setup); macOS uses the system Keychain through `/usr/bin/security`. Both keep the existing `DSH Cindy Host` service and installation-specific account.

Windows uses built-in Windows PowerShell/.NET DPAPI (CurrentUser), then stores **only encrypted ciphertext** in DSH’s native `credentials` record service. DSH owns the private file, atomic writes and record removal; tokens never enter settings, child-process arguments or logs. No Cindy/Electron integration is required. DSH without the record API, blocked PowerShell, a locked keychain, missing `secret-tool`, or damaged ciphertext produces a storage error, not a missing login or a plaintext fallback.

Windows users upgrading from keytar may need to sign in once through the **DSH settings card**. Old Windows Credential Manager entries are not automatically read or deleted; rollback can still see them, and users can remove them manually after confirming the new login. Windows standalone `npm run login/logout/host` has no DSH credential context: use the settings card instead. Linux/macOS standalone commands keep using the same system keychain. Different DSH homes remain isolated. DPAPI ciphertext is not a portable backup: another OS user/machine generally cannot decrypt it.

Native Windows persistence smoke (fake credentials and an isolated temporary DSH document only):

```sh
node tools/credential-store-native-smoke.mjs --runtime <DSH-runtime-root>
```

The runtime root must contain compiled DSH SDK packages under node_modules. This checks real DPAPI encryption, native DSH atomic persistence, fresh-context restore, renewal and logout without accessing a daily profile. Linux/macOS command adapters have mock-contract tests; live keychain acceptance must run on those operating systems.

## 0.1.32: DSH 0.2.2-alpha.2 compatibility

- Accept the exact alpha session/settings carrier and `@deepseek-ai/schemastery@3.18.6-alpha.1` without installing another DSH runtime as a dependency.
- Draft skill discovery uses `agentPresets.acquireScope()` and releases the revision after success or failure. Live Agents prefer their isolated preset skill service; older standing-key carriers retain their fallback.
- Isolated alpha core-contract smoke exercises the real compatibility evaluator, Cordis Loader, Session message folding, and preset-scoped skill discovery. It also checks controller/settings/archive method presence. This is **not** full Web/profile-persistence/relay/handset acceptance; those remain unverified on alpha. No daily profile is modified or restarted.

Reproduce without installing into a DSH profile:

```sh
npm install --prefix <isolated-npm-project> --ignore-scripts \
  @deepseek-ai/dsh-sdk-minimal@0.2.2-alpha.2 \
  @deepseek-ai/dsh-api-session-controller@0.2.2-alpha.2 \
  @deepseek-ai/dsh-settings@0.2.2-alpha.2 \
  @deepseek-ai/dsh-agent-preset-registry@0.2.2-alpha.2 \
  @deepseek-ai/dsh-skill@0.2.2-alpha.2 \
  @deepseek-ai/dsh-workspace@0.2.2-alpha.2 \
  @deepseek-ai/dsh-home-paths@0.2.2-alpha.2 ws@8.21.3 werift@0.24.4
```

Unpack `npm pack` output beneath that npm project's directory, so its imports use the alpha peers, then run (the smoke asserts that resolution):

```sh
node tools/dsh-compat-smoke.mjs --runtime <isolated-npm-project> --plugin <unpacked-package>
```

For a full alpha-dependency regression, additionally copy the repository's test-only `test`, `tools`, `fixtures` directories and the root lockfile into that unpacked package and run `node --test` from it. These fixtures are intentionally not distributed in the npm tarball.

## 0.1.31: merged `main`, native rootless media fetch

Absorbs the `main` branch on top of the 0.2.1 carrier. The one behavioral change that came from it: media and file-peer fetch now accept Cindy's **native URL shape**, where a project-folder export sends only `path` plus an optional `v` and no directory roots. Directory containment is therefore enforced only when the controller actually names roots; the never-serve denylist, the regular-file check, the 25 MiB cap and the separate authenticated-controller policy are unchanged. Also carried over: the native-contract fixture matrix (15 extensions × POSIX/Windows), the repository/docs snapshot, and a test that pins the rootless file-peer transfer end to end.

## 0.1.29: reproducible repository release

Runtime behavior is unchanged from the phone- and desktop-accepted 0.1.28. This release synchronizes the verified source, dependency lock and offline native-client contract fixtures into Git. The pinned third-party fixtures are test-only and excluded from the npm package.

## 0.1.28: busy enqueue confirmation

A real DSH pending inbox occurrence remains in pendingQueue (or steeringQueueClientIds) in enqueue replies, pushes and polling until it is actually claimed or committed. Handing input to DSH is not delivery to the user turn. This fixes 0.1.27 empty follow-up projections overwriting the busy-queue acknowledgment on Android and desktop. Regression tests execute the current Android parser and stale-ACK authority handling, not just the durable outbox state machine.

## Current durable input delivery

- Implements input-delivery v1, not a legacy history-only fallback. Complete text and attachment bytes are held in a private, FULL-synchronous SQLite ledger **before enqueue acknowledgment**.
- Provides per-clientId pending/accepted/removed/unknown receipts and real chronological around/around-client-id history. Accepted means a real user event was flushed and verified through public persistent storage, not an empty inbox or an in-memory event.
- Serializes delivery and mutation, persists cancellation fences and clear boundaries, and keeps edited payloads recoverable. Existing editable Host names and the plain-text desktop queue fix remain.
- Lost acknowledgments and same-process reloads cannot blindly replay an uncertain admission. A verified dead-process recovery may rebuild missing input; cold inbox wake-up requires verified ownership and preserved FIFO. Mixed/uncertain recovery remains pending with diagnostics rather than fabricating success or duplicate input.
- The latest upstream mobile outbox implementation is exercised against Host RPC and SQLite, including same-session FIFO, ACK loss, cancellation, and its mandatory history-cache gate. This is not a claim of live handset acceptance.

The ledger lives under the active DSH profile state directory. Pending payloads and attachments are retained until persistent user-history verification or sealed cancellation; terminal identity fences do not expire silently. Do not delete state to repair an uncertain send. Back up that state before rollback: older Host releases cannot replay this ledger.

All changes are Host-only: no Cindy or DSH core patch is required. The handshake compatibility stamp is separate from the actual plugin version and explicit v1 capability. Unsupported optional features are refused; this is not a promise of all native Cindy features or exactly-once external tool effects.

## Apple, enterprise SSO and regional login (0.1.33)

In **Settings → Cindy 手机连接**, choose the same **Mainland China / Global** account region as the phone, then load sign-in options. The Host discovers enabled providers from that region: Apple/social browser authorization, phone/email codes and enterprise SSO follow Cindy's official protocol. Provider availability is server-controlled; the same Apple ID does not merge accounts across regions. The browser opens the official Cindy authorization page; return to DSH for membership selection, required contact binding or extra SSO verification. Secrets and tickets stay in the Host, not settings or browser storage.

Organization ID/slug/domain and email discovery check both regions. A found organization in the other region requires explicit confirmation; ambiguous or partly failed discovery never silently picks a region. Cancel/start-over fences late browser, code and vault-write results. Login while the phone-connection switch is off saves only; it does not enable transport. Account/region changes rebuild the whole runtime so relay, device directory, media staging and ICE remain in the credential's region. Existing encrypted credentials are preserved; failures never erase them.

**CAPTCHA browser limitation:** when a region requires it for code delivery, open the official verification page, solve it, then copy its complete successful URL (including `#cindy-captcha=ok.…`) into the DSH form. The standard browser cannot read the cross-origin result automatically. The verification proof is sensitive and short-lived: do not share it. The Host validates its official origin and forwards only the proof to the requested auth action; it does not bypass verification or proxy/inject the challenge page. Apple/SSO browser authorization does not use this manual code-delivery step.

This feature ships in 0.1.33; installation and runtime activation are verified separately. Tests cover protocol, real local callbacks, settings-panel state, credential races and both regions' actual runtime URL routing with fake credentials. Real Apple/enterprise identity providers and iOS discovery/file round trips still require an authorized test account after deployment. See [authentication flow notes](doc/auth-login.md). The new browser flow is exposed by the settings page; the older interactive CLI is not a replacement for that UI on Windows.

## Tool work titles on Cindy mobile (0.1.38)

The Host projects `run_code` calls with a non-empty string `description` as `run_code · <description>` in Cindy’s collapsed tool row. Titles are normalized to one line and limited to a 120-code-point preview; the original input, code and full description remain in expanded details. Calls without a valid title and all other tool names keep their existing mapping. Live events and history use the same projection, and results remain paired by `toolUseId`. This is a Host-only display alias, not a renamed DSH execution tool. Reload an updated Host to apply it; existing phone-cached history may need reloading. Handset rendering has not been acceptance-tested.

## Thinking content on Cindy mobile (0.1.33)

The Host sends DSH-provided public reasoning text/summaries as native structured `thinking` content (`{ text }`), not ordinary prose strings. Expand the work/activity group, then its thinking row, to read it. No Cindy or DSH core patch is needed. Models that expose no reasoning text still have nothing to show; signatures and provider-private replay metadata are never forwarded.

During generation, `assistant/chunk` reasoning deltas are displayed as temporary thinking rows. Pushes coalesce over 100 ms; the work-grouped history uses the existing coalesced view refresh. Opening a session mid-generation reconstructs the current prefix from the log. The final assistant message replaces the preview, including interrupted prefixes, without duplicating it. Temporary rows do not become durable message-count/grouping evidence, and timers are cleared on Host disconnect.

This ships in 0.1.33; handset acceptance is separate from package checks and local Host activation. Offline regressions execute the pinned real Cindy mobile thinking normalizer; live phone/network acceptance remains separate.

## Questions on DSH and Cindy

While the Host bridge is enabled, questions are registered before presentation, even if no phone has opened that session. DSH's native question UI and the existing Cindy card can both answer; the first accepted answer settles the shared pending entry and dismisses the other surface. Session open/reconnect replays pending cards with the same request IDs. Temporary relay loss does not cancel questions.

Questions have no extra Host timeout. The caller's stop/cancel and DSH's own timed-question lifecycle still apply; explicit Host switch-off/unload cancels outstanding bridge waits. Permission cards retain their existing ownership and deadline. No Cindy/DSH patch or phone protocol upgrade is needed. This does not add cross-process recovery or mobile late-answer support after DSH has continued a timed call.

Run the focused regressions with:

```sh
node --test test/user-question-bridge.test.js test/host-approvals.test.js test/dsh-plugin.test.js
```

The opt-in installed-runtime suite additionally exercises real Cordis, userQuestions and Gateway event delivery/replay/cancellation. Point `DSH_TEST_NATIVE_MODULES` at a built DSH node_modules directory, then run `node --test --test-isolation=none test/user-question-native.test.js`. For an Electron asar installation use the installed executable with `ELECTRON_RUN_AS_NODE=1`. These checks use isolated contexts and do not reload the running GUI; real-handset acceptance is separate.

## Model switching follows DSH

When native `sessionController.selectModel` is composed, the Host tells Cindy to delegate model-window decisions to DSH. Users may select another model during a running turn and select the original model again. DSH validates the provider/model/effort and records the selection for the **next model request**; an already-issued request is not interrupted. DSH owns context preparation and compaction, not Cindy's legacy 90%-window precheck or a Host-side summary/rebuild implementation.

Missing capacity metadata is not a Host-side veto. Native DSH refusals still propagate (an unavailable route is reported as `NOT_AVAILABLE`), and no switch capability is advertised when the native selection API is absent. This is not a guarantee that every model request will succeed or that compaction is lossless. Re-selecting the original model does not undo any compaction already performed by DSH.

## Native DSH session archive

Controller archive/restore metadata now calls the same durable `workspaceRegistry.archiveSession` / `unarchiveSession` operations as DSH itself. Lists, exact reads and activity badges fold the native archive set; committed desktop changes invalidate controller lists and publish row patches. Archiving drops the pin without deleting history or changing workspace membership.

The existing archive gesture does not request `stopActivity`, so DSH refuses sessions with running work; stop the work explicitly before archiving. Missing native archive services and storage failures are not downgraded to local-only success. Old controller-only archive flags remain visible until an explicit archive/restore retires that session's flag; upgrades do not bulk-archive native sessions. Delete remains a controller-only hide. Native pin membership is now projected separately as described below.

## Native DSH pin membership

Pin/unpin writes use native `workspaceRegistry.pinSession` / `unpinSession`; native desktop changes refresh controller lists and row patches. Repeating a pin does not reorder native pins. Archiving clears the native pin, and hidden/archived sessions cannot be newly pinned. Missing native pin APIs or persistence failures never become local-only success.

DSH exposes an ordered ID set, not pin timestamps. The existing Cindy wire field therefore uses the fixed `1970-01-01T00:00:00.000Z` membership sentinel, **not** a claimed native timestamp or exact manual pin order. Legacy local pin flags remain readable until an explicit operation or corresponding native commit retires them; no automatic bulk migration occurs. Mixed rename/status/pin writes that native APIs cannot commit atomically are rejected before any side effect.

## Native manual compaction subset

`maker:compact-session` executes the target ordinary Agent's verified native scoped `/compact` command through `commands.execute`, not a text prompt or a Host summary engine. Only omitted or whitespace-only instructions are supported; nonempty instructions and the separate Claude queue-compaction protocol remain explicitly unsupported. Missing services/preset commands, busy maintenance and native errors never become successful no-ops. Benign no-history success maps to `{ noop: true }`; no native token counts are invented.

The existing 11-minute Cindy timeout applies. The Host waits for the real command result, invalidates transcript/history reads after success or failure, and forwards source/link teardown or an accepted stop to the native cancellation signal. Cancellation is not a rollback guarantee. Repeated copies of the same envelope share an in-process bounded receipt, not a cross-restart exactly-once promise; new request identities are not automatically replayed.

## Ordinary native fork subset

`maker:fork(sourceSessionId, messageClientId)` locates the actual committed row using the shared message fold and one leased native observation. A human user point copies the prefix before that prompt; an assistant point includes its entire completed turn. DSH alone creates the child and selects its inherited cwd/preset/default model behavior. The source is not rewound or edited. The Host reads the real new row and emits the existing created notification.

Unknown, ambiguous, shadowed, incomplete/aborted-turn, first-user-without-prior-assistant and unsafe mid-tool steering cuts are refused. Native history is bounded at 100,000 events; encrypted-stripping forks, branch navigation and in-place rewind remain unsupported. A known created child ID is retained and reported if Workspace attachment, discovery or source teardown fails; such a failure must not automatically trigger another fork. Native fork has no caller cancellation or durable idempotency key: duplicate envelopes are deduped only in-process, and disconnection is not a rollback guarantee.

## Native literal keyword search

The existing conversation-search channel uses the mounted native `sessionQuery.filterEvents` literal-text/current-surface API, even when global FTS is disabled. It searches only Host-visible ordinary sessions without waking an Agent, preserves real message/client identities and counts, and applies every accepted status/archive, display-agent alias, activity, ID and grouped-working-directory filter. Title matching uses the same unnamed-label string as Cindy. Relevance is deterministic keyword ranking, not a claimed native FTS/vector score.

Keyword mode (also the Host default when omitted) returns `vectorUsed:false` with an explicit literal-only diagnostic; explicit hybrid requests are refused. Limits up to 200, including values over 20, are honored; larger limits and unknown fields refuse rather than silently narrowing. A scan has bounded candidates/events/text/time/concurrency/response size; exhausted budgets report `poolCapped:true`, while storage/read errors stay errors. Late cancelled reads are discarded and observation leases released. Up to three real message previews accompany a result. Host-only focused tests assert the request/response fields against the read-only official protocol reference.

## Native background jobs: read-only subset

The existing session-background-task list reads native `jobs.list(sessionId)`, the same public, owner-fenced registry operation used by DSH's job-controller roster stream. It includes that ordinary session's own and unowned active jobs, not other sessions' jobs, and never activates an Agent. Native `stopping` remains running (and is labelled stopping); terminal states are sent only from real native status evidence through existing `agent_task_update` events. Unknown/malformed/over-budget rosters refuse instead of becoming empty success.

Cindy roster snapshots contain active tasks only. The optional `pendingContinuations` is omitted as unknown, never fabricated as zero. Native IDs receive stable job namespaces; titles identify DSH. No vendor provider, originating tool-call, output file, model token use or completion is invented. Status pushes reuse the source-owned DSH control stream with visibility/generation checks and bounded transient deduplication; no extra per-phone job stream or consuming output cursor is opened.

Precise stop and output-tail channels are not in the verified official remote protocol and are not added. The native DSH kill/follow APIs remain DSH features, not newly exposed Cindy controls; ordinary input-stop retains its existing meaning. These are source/offline-contract changes, not a production reload or handset acceptance claim.

## Native durable children: read-only subset

The three existing subagent-run list/detail/transcript endpoints recheck an ordinary parent and its native durable child catalog on every request. Native descendant traversal is used when composed; disconnected/cyclic relations, external children and unknown/corrupt branches refuse explicitly rather than disappearing or becoming completed. No arbitrary session lookup or Agent resolution is used to grant access. Stable run IDs bind parent and native child IDs; the existing pi provider value is only a transport alias, with DSH clearly named in the title/description.

Run status uses the real live-Agent lookup, registered native inbox view and host-provided public `foldConsumedWork` reader. Inactive does not mean completed; queued/unknown/unaccounted work is not presented as terminal success. The SDK package is a peer, never a private installed dependency graph. Missing services/helpers refuse dynamically. Resume, steer and stop stay false; returned-result capability stays false because a last assistant message is not evidence of delivery to the parent.

History includes only the child-owned, committed public text and real tool-call/result pairs. Inherited parent history, constructor repair closers, injected/system/developer context, private request metadata and tool arguments are not exported. Long public text is split into stable ordered chunks, not silently clipped. Pages contain at most 25 entries with serialized-byte budgets and signed parent/child/catalog/source-bound continuation and tail cursors; teardown invalidates them and releases observations. The non-allowlisted subagent-runs-changed push is not emitted. Validation is focused Host tests only; Cindy source is read-only reference, not imported or executed. No deployment or handset acceptance is claimed.

## Native reminders: existing-dialogue subset

The five existing schedule CRUD calls use the mounted native schedule catalog/create/update/delete APIs. Writes accept an existing active ordinary dialogue, recurring native five-field cron or whole-second intervals of at least 60 seconds, the target's current agent alias, no model/workspace override and all notification switches off. Updates carry the complete observed native record as expected; conflicts are errors, never reread-and-overwrite retries. Explicit intervalMs:null clears an interval only with an expressible replacement cron rule.

Read/delete includes existing native one-time records. Native inactive maps to expired, not paused; delivery timestamps are not model execution completion, run history, costs or unread counts. Unrepresentable fractional calendar rules and oversized data fail explicitly. Pause/resume/run-now/templates/scripts/run reports remain unsupported; this is not an equivalent automation runner or a claim that every scheduler-page control works.

Committed native change notifications produce the existing ready list-invalidation event only for authorized linked peers. One shared observer closes on final unlink, revocation, source replacement or disconnect. Deleting a reminder does not stop an Agent or retract inbox input. Cancellation after persistence is not rollback; known created IDs survive readback/source failures. Write-envelope deduplication is bounded in-process, not durable exactly-once. Validation: 19 focused Host cases; no Cindy source execution, real reminder creation, publication or phone acceptance.

## Native registered Workspace order

Existing sidebar project-order get/apply calls project the native registered Workspace order as custom. Only unique local path keys are accepted; unknown paths, ambiguous worktree groups, duplicate keys, device/dialogue keys and activity mode refuse before any move. An account/device/source-bound owner stamp is available only after a verified relay handshake; it is authorization, not a fabricated order revision.

Native insertBefore moves are serialized and checked against the actual registry after each step. Unrequested Workspaces retain relative order. This is not an atomic replace: concurrent desktop edits or partial persistence failures stop the sequence and report the real same-owner snapshot, without rollback. Native order changes feed the existing sidebar changed event. Twelve focused Host tests cover mapping, ownership, partial/concurrent failures and real Host handshake/source rotation; no live workspaces were reordered.

## Session-reference source and consumption boundary

The existing source-history call reads one authorized ordinary session through a single native observation and current-surface fold, without resolving an Agent. It implements user/assistant role, workdir/agent/time filters, native-position cursor pagination, bounded content with explicit truncation metadata, and a safe terminal-error hint captured from that same prefix. Rewound/all-role history is explicitly unavailable.

Source readability does not imply target consumption. The existing target capability probe returns supported:false/version:1: native current-surface reference resolution cannot atomically admit Cindy frozen/anchored/cross-device snapshots. Nonempty structured references are refused before send/enqueue/steer/edit, durable preparation and replay, rather than silently dropping them or turning them into ordinary text. Empty carriers and literal text links retain ordinary behavior. Twelve focused source/boundary Host tests and 28 directly affected delivery cases passed; Cindy source remained read-only and unexecuted.

## Previous release and rollback

0.1.26 added editable, locally persistent Host names and desktop-safe plain-text queue content. Reinstalling 0.1.26 is possible, but pause input first and preserve the 0.1.27 ledger: downgrading disables durable-input recovery until 0.1.27 is restored.
