# DSH Cindy Host

A Host-side adapter connecting current Cindy clients to DeepSeek Harness.

## Requirements and installation

Version **0.1.32** additionally supports **DSH 0.2.2-alpha.2**, while retaining `0.2.1-rc.3`, `0.2.1-rc.4` and `0.2.1-rc.5`. Alpha requires **Node.js >=24.9** (tested with 24.12); the older carriers retain this plugin's Node.js >=22.16 minimum. Session/settings peers and alpha Schemastery are explicitly allowed, not a blanket promise for future prereleases. Install through the Desktop DSH plugin manager. CLI-managed profiles can use:

```sh
dsh plugin --profile <profile> add dsh-cindy-host@0.1.32
```

Reload the Host plugin after installation. A full DSH restart is separate. Keep existing Cindy sign-in, device identity and settings; do not run two Host processes with the same identity.

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

## Model switching follows DSH

When native `sessionController.selectModel` is composed, the Host tells Cindy to delegate model-window decisions to DSH. Users may select another model during a running turn and select the original model again. DSH validates the provider/model/effort and records the selection for the **next model request**; an already-issued request is not interrupted. DSH owns context preparation and compaction, not Cindy's legacy 90%-window precheck or a Host-side summary/rebuild implementation.

Missing capacity metadata is not a Host-side veto. Native DSH refusals still propagate (an unavailable route is reported as `NOT_AVAILABLE`), and no switch capability is advertised when the native selection API is absent. This is not a guarantee that every model request will succeed or that compaction is lossless. Re-selecting the original model does not undo any compaction already performed by DSH.

## Native DSH session archive

Controller archive/restore metadata now calls the same durable `workspaceRegistry.archiveSession` / `unarchiveSession` operations as DSH itself. Lists, exact reads and activity badges fold the native archive set; committed desktop changes invalidate controller lists and publish row patches. Archiving drops the pin without deleting history or changing workspace membership.

The existing archive gesture does not request `stopActivity`, so DSH refuses sessions with running work; stop the work explicitly before archiving. Missing native archive services and storage failures are not downgraded to local-only success. Old controller-only archive flags remain visible until an explicit archive/restore retires that session's flag; upgrades do not bulk-archive native sessions. Delete remains a controller-only hide, and pin timestamps remain Host metadata.

## Previous release and rollback

0.1.26 added editable, locally persistent Host names and desktop-safe plain-text queue content. Reinstalling 0.1.26 is possible, but pause input first and preserve the 0.1.27 ledger: downgrading disables durable-input recovery until 0.1.27 is restored.
