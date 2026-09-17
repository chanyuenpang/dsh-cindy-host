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
pre-existing behaviour (a staged key over the original bytes); the path is also refused when it
is outside a directory root the controller named (`FORBIDDEN`) or is on the never-serve list.

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
- `doc/cindy-phone-link.md` (the four questions with their Cindy source anchors)
- Cindy checkout cited above: `packages/device-link-protocol/src/protocol.ts`,
  `packages/device-link/src/protocol.ts`, `.../src/client.ts`,
  `apps/desktop/src/renderer/components/sidebar/MobileDownloadDialog.tsx`,
  `apps/desktop/src/i18n/locales/zh-CN/common.json`

Verification rules:

- `test/host.test.js` asserts `hello` declares `remoteControlEnabled` (including
  revoked/disabled variants) and that `presence-changed` alone leaves the state at
  `waiting`.
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
