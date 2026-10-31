# DeviceLink protocol boundary for this Host

<!-- state: current -->
## Current behavior

The Cindy DeviceLink protocol decides what this Host may claim. Four questions were
answered from Cindy's own source before any UI was written, because the first answer
removed a feature the original request assumed existed. The relay server source
(`apps/server`) is **not** in the Cindy checkout, so relay behaviour is taken from the
shared protocol package both sides compile against, not from the server
implementation. The Host speaks envelope version `PROTOCOL_VERSION = 1`.

The four answers:

1. **No pairing token or pairing URL.** There is no pairing concept in DeviceLink.
   The relay authenticates the WebSocket from the bearer token, binds the connection
   to a Cindy account, and fills `Envelope.src` itself. The only identity it ever
   hands back is `hello-ack`:
   `HelloAckPayload = { serverProtocolVersion, deviceId, userId, capabilities? }`.
   Evidence: `Cindy/packages/device-link-protocol/src/protocol.ts:28-121` (the
   `EnvelopeKind` union has no pairing kind) and `:110-121` (the `hello-ack`
   payload). A repository-wide search for `配对`/`pairing`/`pairingCode`/`deviceCode`
   across `apps/desktop/src`, `apps/mobile/src`, `packages/` and `cindy-protocol/`
   returns only unrelated request/tool-call pairing.
2. **The Android QR is the regional download page URL, not a DeviceLink payload.**
   `Cindy/apps/desktop/src/renderer/components/sidebar/MobileDownloadDialog.tsx:119-127`
   builds the code from `websiteUrl` (`resolveMobileDownloadUrl`), canonicalizing
   `cindy.com.cn → cindy.cn`; `.../i18n/locales/zh-CN/common.json:7241` says
   `"scanToOpen": "扫码打开 Cindy App，并登录同一账号"`. The phone is therefore linked by
   **account**, not by the code: scan → install → sign in.
3. **No relay frame reports a successful pairing, because association is
   account-scoped.** Observable evidence instead: `presence-changed` carries a
   `PresenceSnapshot` for every same-account device
   (`Cindy/packages/device-link/src/protocol.ts`, `.../src/client.ts:2202-2212`);
   `GET /api/device-link/devices` returns `DeviceView[]` for the whole account
   (`Cindy/packages/device-link/src/protocol.ts:203-219`); a phone that actually uses
   this Host sends `link-open` (dropped for listing-only controllers) or `invoke`.
   This bundle therefore defines `connected` as *a device opened a link to, or
   invoked, this Host* — an observed event, not a guess. Presence alone shows the
   device row but leaves the state at `waiting`.
4. **No pairing API and no ready-made QR component to reuse.** Cindy renders its
   download QR with the `qrcode` package's `toDataURL`
   (`MobileDownloadDialog.tsx:129-152`). Unused here, because this bundle renders no
   QR at all rather than inventing a payload Cindy does not understand.

What the relay requires:

- The relay only routes `link-open`/`invoke` to a target that advertised
  `remoteControlEnabled: true` in `hello` (`CONTROL_KINDS` in
  `device-link-protocol/src/protocol.ts:75`). A Host silent about it is invisible to
  the phone.
- The Host's `hello` payload therefore carries `remoteControlEnabled: policy.isEnabled()`
  (exactly the user's own opt-in) plus `deviceName`, `platform`, `appVersion`, and
  `busy: false`. A policy change is re-announced with `presence-set`.

Media fetch (`device-link:media:fetch`) answers a controller that asks this machine for one of
its files, taking `{ url, thumbnail?, skipCache? }` and answering in three layers that mirror
the desktop reference `apps/desktop/src/main/device-link/mediaFetch.ts`:

1. **Downsample** when `thumbnail: true` and the file is png/jpeg/webp within
   `THUMBNAIL_INPUT_MAX_BYTES = 48 MiB`: EXIF rotate, resize to `THUMBNAIL_MAX_EDGE = 1024`
   longest edge, webp `THUMBNAIL_WEBP_QUALITY = 80`, under a 5 s soft timeout. A product within
   `THUMBNAIL_INLINE_MAX_BYTES = 700 KiB` comes back inline as
   `{ ossKey: '', mimeType: 'image/webp', size, inlineBase64 }`, which skips the whole
   upload → presign → download round trip. The codec is the harness's own `sharp`, resolved from
   `process.argv[1]` (the `dsh web` entry) and then from this module, so this Host carries no
   second native image stack.
2. **Inline the original** when the downsample cannot happen (no codec, a non-downsamplable
   format, a render failure, or an over-budget product) but the original is `image/*` and at
   most `INLINE_ORIGINAL_MAX_BYTES = 512 KiB`: `ossKey: ''` plus the original `mimeType` and
   `inlineBase64`. The controller accepts inline bytes only for `image/*`.
3. **Stage and return a key** otherwise: upload, return `{ ossKey, mimeType, size }`, and reuse
   one object per unchanged file for `STAGING_CACHE_TTL_MS = 30 min` (`STAGING_CACHE_MAX = 512`
   entries, keyed by path|size|mtime). `skipCache: true` bypasses the cache, which is how a
   controller reports that the object its key named is gone while the file itself did not
   change.

Layers degrade downward and never fail the fetch: the controller always accepts the `ossKey`
form, so an unavailable codec or a failed render is not an error. The whole fetch is bounded by
`MEDIA_FETCH_MAX_BYTES = 25 MiB` (a controller-supplied `maxBytes` is clamped by
`Math.min(request.maxBytes, maxBytes)`), which means the 48 MiB downsample ceiling is normally
unreachable — a request that large is refused before any render. `thumbnail: false` keeps the
pre-existing behaviour (a staged key over the original bytes). Directory constraints are optional, matching Cindy's native media-fetch contract: an absolute path is accepted without `baseDir`/`workdir`; when either is supplied, realpath containment is enforced and malformed constraints are rejected. This optionality does not replace the separate authenticated-controller policy; never-serve paths, regular-file checks, and the 25 MiB media-fetch limit still apply. `test/host-media-fetch.test.js` covers rootless PNG bytes and constrained/unconstrained resolution.

## Desktop/mobile session compatibility

- `local-db:sessions:list(limit, status, { includePinned })` returns only the requested active/archived bucket, applies the limit, appends pinned rows outside the recent window, and excludes deleted rows. Sessions without a real non-empty title are absent from discovery, while exact `sessions:get` still addresses an untitled draft before its first prompt.
- `local-db:sessions:patch-meta` treats deletion of a missing source session as successful only for a pure deletion metadata patch (`status: 'deleted'`, optionally with `pinnedAt`): after flags persist and the session-row read succeeds, an absent row is acknowledged with `{ id, ...writtenFields }`. This makes repeated deletion idempotent without fabricating a complete session. Persistence/read failures still fail; absent-session archive, restore, pin, rename, or mixed edits remain `NOT_FOUND`.
- Project grouping evidence is exact transcript-derived `_count.messages` plus first durable `userSendAt`, warmed in bounded batches and invalidated by live events. Unknown evidence remains null; the Host never fabricates activity to force grouping.
- Ordinary assistant/user/reasoning text crosses as a string; objects are reserved for attachments and tool structures. This keeps Cindy desktop from rendering `{"text":…}` literally while mobile continues to normalize both shapes.
- **Queued UI rows separate display text from persisted SDK content.** In `src/host-input-queue.js`, both `toQueuedRemoteMessage` and `queuedRowFromController` put the already-flattened string in `chatMessage.content`, while `persistedContent` retains the serialized content blocks. Cindy desktop promotes the queue's `chatMessage` directly into the transcript; its quote/navigation text helper calls `.split` on the content string, so an array here causes a renderer `TypeError`. This is a confirmed contract failure and renderer error path, not proof by itself of an Electron main-process crash. `test/host-input-queue.test.js` covers the builders and queue projection contract.
- **Retire consumed queue entries within the runtime fold.** DSH's formal user-message event can prove a queued prompt was consumed before the enqueue/steer request returns. A remove-only retirement loses that proof if the queue row has not arrived yet; a later ACK or stale baseline/inbox can then re-create the same client ID as pending/steering. The tracker now records consumed `(sessionId, clientId)` keys in a bounded 2,048-entry in-memory map, retaining the most recently retired keys; it filters them from mark, baseline/queue/adopt, authoritative inbox and pending-ACK projections. This is not a persistent queue or cross-restart deduplication ledger. Cancellation/UI deletion is not consumption; real unconsumed queue items remain visible. `src/host.js` wires formal-message retirement and clears the tracker on runtime teardown.
- **Current durable input delivery and queue confirmation support the latest Cindy flow.** Host 0.1.27 added a transactional per-input delivery owner: complete replayable payload is persisted before ACK; `inputDeliveryVersion: 1`, per-`clientId` receipts, clear boundaries, cancellation and real persisted-history lookup are emitted from durable evidence, not inferred from DSH prompt admission. Same-session admission/cancel/clear serialize, recovery uses DSH inbox/history evidence, and the implementation does not claim exactly-once external side effects. Host 0.1.28 fixed the subsequent busy-queue confirmation defect: an actually pending DSH inbox occurrence remains in `pendingQueue` across enqueue ACK, pushes and polling until claim/consumption evidence changes it; a stale/empty mirror must not hide it. Real DSH busy-session and actual Android projection/ACK-epoch tests passed, with no duplicate user rows. After 0.1.28 activation the user confirmed phone and desktop queue behavior was normal. 0.1.29 is the current published source/test synchronization release with business logic unchanged from 0.1.28; it was not restarted into production, so the currently verified production runtime remains 0.1.28. Physical weak-network reconnect was not separately tested. See `.release/ack-0.1.28/package/src/host-input-delivery.js`, `.release/ack-0.1.28/package/src/host-input-queue.js`, `.release/ack-0.1.28/package/src/cindy-channels.js`, tests `latest-mobile-outbox`, `host-delivery-runtime`, `host-delivery-crash`, and `native-busy-queue-ack`, and [0.1.28 release evidence](<.release/ack-0.1.28/release-evidence.json>).
- Every live `maker:event` status has both `isRunning:true` and a non-empty Cindy status string (`running` or `waiting on input`); a missing string is a protocol violation because the desktop status bar normalizes it with `.trim()`.
- Approval and `ask_user_question` use one Host pending registry but fan out to Cindy and the local DSH UI. The first valid answer settles atomically, the losing surface is aborted/dismissed, and a late answer is rejected. A bare `Promise.race` without loser cancellation is forbidden.

Pitfalls:

- Because any same-account Cindy client is a valid controller, `connected` means "a
  Cindy client reached this Host", not "a phone reached this Host". Device rows
  always name the platform so the card can distinguish a linked desktop.
- Do not infer a pairing handshake or synthesize QR content: neither exists in the
  protocol.
- Do not treat presence as connection: presence only lists a same-account device.

Code anchors:

- `src/host.js` (`PROTOCOL_VERSION`, `hello` payload, `presence-set`)
- `src/host-status.js` (ledger-based `connected`/`waiting` derivation)
- `src/host-media-fetch.js` (`THUMBNAILABLE_MIMES`, `resolveThumbnailCodec`,
  `MEDIA_FETCH_MAX_BYTES`, `THUMBNAIL_*`, `INLINE_ORIGINAL_MAX_BYTES`, `STAGING_CACHE_*`)
- `src/cindy-channels.js` (`device-link:media:fetch` branch, `skipCache` passthrough)
- `src/host-input-queue.js` (`createInputQueueTracker`, retirement key/cap, queue filtering and projection)
- `src/host.js` (`retireQueuedItem` on formal durable-message evidence; tracker teardown)
- `.release/ack-0.1.28/package/src/host-input-delivery.js` (durable delivery coordinator)
- `.release/ack-0.1.28/package/src/host-input-queue.js` (actual inbox projection)
- `.release/ack-0.1.28/package/src/cindy-channels.js` (`around-client-id` and delivery protocol channels)
- `test/host-input-queue.test.js` (string content, late ACK/snapshot filtering, session isolation, cleanup and capacity boundaries)
- `test/host.test.js` (runtime enqueue/steer delivery ordering and stale-ACK integration regression)
- `.release/ack-0.1.28/package/test/latest-mobile-outbox.test.js`, `host-delivery-runtime.test.js`, `host-delivery-crash.test.js`, and `native-busy-queue-ack.test.js` (latest outbox, persistence/recovery and busy queue caller-driven evidence)
- `doc/cindy-phone-link.md` (the four questions with their Cindy source anchors)
- Cindy checkout cited above: `packages/device-link-protocol/src/protocol.ts`,
  `packages/device-link/src/protocol.ts`, `.../src/client.ts`,
  `apps/desktop/src/renderer/components/sidebar/MobileDownloadDialog.tsx`,
  `apps/desktop/src/i18n/locales/zh-CN/common.json`

Verification rules:

- `test/host.test.js` asserts `hello` declares `remoteControlEnabled` (including
  revoked/disabled variants) and that `presence-changed` alone leaves the state at
  `waiting`.
- `test/host-input-queue.test.js` asserts both queue-row builders emit string
  `chatMessage.content` and that baseline/re-entry projections remain renderable,
  including empty text. It also covers consumed-key filtering across late ACKs and
  stale snapshots, session isolation, cleanup, and the 2,048-entry bound.
- `test/host.test.js` exercises real Host runtime ordering for enqueue and steering,
  including durable consumption before ACK and verifies that the late ACK does not
  restore the delivered row.
- The immutable 0.1.28 release suite covers latest mobile outbox semantics, durable
  owner/crash recovery, and the native busy-queue ACK race; a real DSH busy agent
  retained the pending inbox item through ACK, pushes, and polling. The user then
  confirmed phone and desktop behavior after 0.1.28 activation. This does not claim
  physical weak-network reconnection was tested or that this proves every past
  incident had a single cause; 0.1.29 source/repository publication did not restart
  production, so runtime activation evidence is for 0.1.28.
- Live check used for this Host: `hello-ack` returned a real `deviceId` and `userId`,
  and the account's device directory resolved real names/platforms
  (`<phone>`/android, `YOP`/win32).

<!-- state: history -->
## Evolution history

<!-- dated: 2026-09-17 -->
### QR pairing was a requested surface and was dropped

The original request assumed a QR pairing step, and this Host was to have no QR only
as a scope choice. Once answer 2 above showed that Cindy's only QR is the regional
download page and answer 1 showed there is no pairing token to encode, the user
dropped the QR requirement explicitly, and the bundle was built to render no QR at
all rather than inventing a payload Cindy cannot consume. The reversal is retained
because reader-facing docs and earlier plans still describe the QR as an open feature;
the current bundle has no QR surface.

<!-- dated: 2026-10-28 -->
### Durable mobile delivery and busy-queue confirmation

The 0.1.26 release rejected the latest Cindy durable-outbox history-confirmation call.
0.1.27 added transactional durable delivery and real clientId history lookup. User
acceptance then exposed a separate busy-queue projection race in which an empty mirror
could erase a still-pending DSH inbox item. 0.1.28 corrected that projection using the
real inbox occurrence and native Android ACK epoch behavior; a real busy DSH session and
automated mobile/desktop paths passed, and the user confirmed both phone and desktop
queue behavior after 0.1.28 activation. 0.1.29 published the synchronized source/tests
without changing the 0.1.28 business logic; production remained loaded on 0.1.28. Physical
weak-network reconnect remains unverified.

<!-- dated: 2026-10-29 -->
### Make media-fetch directory constraints optional

The Host previously rejected an absolute media path unless the request also named
`baseDir` or `workdir`, returning `no-root`. That Host-added requirement was removed
to match Cindy's native contract: a rootless absolute path is accepted; a supplied
root still receives realpath containment checks, and malformed constraint values are
refused. The change addresses the project-folder PNG export compatibility failure
without changing the separate authenticated-controller policy or other file checks.
Regression coverage in `test/host-media-fetch.test.js` includes rootless PNG byte
preservation and both rootless and constrained resolver paths. Deployment and Linux
phone end-to-end acceptance remain unverified.
