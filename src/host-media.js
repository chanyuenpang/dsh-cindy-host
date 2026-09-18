/**
 * Fetch a controller's uploaded attachment out of the Cindy media staging area.
 *
 * A phone does not send image bytes over device-link. It uploads them to the
 * account's OSS staging area and puts an opaque **transit reference** in the
 * message; resolving it is the controlled end's job. The contract is
 * `packages/device-link/src/attachmentOssRef.ts` in the Cindy repo:
 *
 * ```
 * cindy-oss-attach://m/<base64url(JSON { ossKey, mimeType?, originalName?, size?, sha256? })>
 * xdt-oss-attach://m/…      // the pre-rebrand scheme: senders still use it, so the
 *                           // parsing face must accept both, permanently
 * ```
 *
 * and the reference implementation of the receiving half is the desktop being
 * controlled (`apps/desktop/src/main/maker-ipc/normalizeAttachments.ts:336`):
 * `parseAttachmentOssRef` → `presign-get` → download → verify → hand the agent a
 * real file, then remove the staging object. This module is the same flow for this
 * Host, over the same account API the device directory already uses
 * (`apps/desktop/src/main/device-link/mediaTransfer.ts:53,574`):
 *
 * ```
 * POST {apiBase}/media/presign-get  { key }   → { getUrl, expiresAt }
 * GET  getUrl                                 → bytes (never through the relay)
 * DELETE {apiBase}/media            { key }   → the staging object, after use
 * ```
 *
 * The account token is the one the relay socket already authenticated with, which
 * is exactly why this Host can serve attachments at all: a media object is scoped
 * to the account, and this Host is logged into that account.
 *
 * @module dsh-cindy-host/host-media
 */
import { createHash } from 'node:crypto';

/** Reference schemes a controlled end must accept. */
export const ATTACH_OSS_SCHEMES = Object.freeze(['cindy-oss-attach', 'xdt-oss-attach']);

const PREFIXES = ATTACH_OSS_SCHEMES.map((scheme) => `${scheme}://m/`);
const SCHEME_PREFIXES = ATTACH_OSS_SCHEMES.map((scheme) => `${scheme}://`);
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Whether a string is an attachment transit reference, either scheme.
 *
 * Recognition is deliberately **broader** than parsing, exactly as the client's own
 * `isAttachmentOssRef` is: anything under the scheme is "a reference this Host must
 * account for", and a malformed one is then reported as `malformed-ref` instead of
 * being mistaken for a path or silently discarded.
 */
export function isAttachmentOssRef(value) {
  return typeof value === 'string' && SCHEME_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/**
 * Parse an attachment transit reference.
 *
 * Mirrors the client's own rules exactly: an unknown scheme, a non-object payload, a
 * missing `ossKey`, or a **half** integrity claim (one of `size`/`sha256` without the
 * other) is not a usable reference. A reference with no integrity claim is still
 * accepted — old senders wrote one, and refusing them would break a mixed rollout.
 * @param value - the `path` the controller sent.
 * @returns the parsed reference, or null when it is not one.
 */
export function parseAttachmentOssRef(value) {
  if (typeof value !== 'string') return null;
  const prefix = PREFIXES.find((candidate) => value.startsWith(candidate));
  if (prefix === undefined) return null;
  const segment = value.slice(prefix.length).split('/')[0];
  if (segment === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (typeof parsed.ossKey !== 'string' || parsed.ossKey === '') return null;

  const hasSize = parsed.size !== undefined;
  const hasSha = parsed.sha256 !== undefined;
  // Half a claim is no claim: the pair is what makes verification possible.
  if (hasSize !== hasSha) return null;
  if (hasSize && !(Number.isSafeInteger(parsed.size) && parsed.size > 0 && typeof parsed.sha256 === 'string' && SHA256_HEX.test(parsed.sha256))) return null;

  return {
    ossKey: parsed.ossKey,
    ...(typeof parsed.mimeType === 'string' && parsed.mimeType !== '' ? { mimeType: parsed.mimeType } : {}),
    ...(typeof parsed.originalName === 'string' && parsed.originalName !== '' ? { originalName: parsed.originalName } : {}),
    ...(hasSize ? { size: parsed.size, sha256: parsed.sha256 } : {}),
  };
}

/**
 * The account API base this Host's media and directory calls live under.
 *
 * Derived from the relay URL rather than configured separately, because that is the
 * deployment fact the Host already has: `…/api/device-link/ws` → `…/api/device-link`,
 * whose siblings are `/devices` (already used) and `/media/*`. A second setting could
 * only ever disagree with the socket that is actually connected.
 * @param relayUrl - the relay WebSocket URL.
 * @returns the HTTP base, without a trailing slash.
 */
export function mediaApiBaseUrl(relayUrl) {
  return String(relayUrl).replace(/^ws/, 'http').replace(/\/ws$/, '');
}

/** Headers every media call needs: the account bearer, and JSON in/out. */
function mediaHeaders(session) {
  return {
    Authorization: `Bearer ${session.accessToken}`,
    'content-type': 'application/json',
    accept: 'application/json',
  };
}

/** A usable account session, or null. */
function usableSession(getSession) {
  const session = typeof getSession === 'function' ? getSession() : null;
  if (session === null || typeof session !== 'object') return null;
  return typeof session.accessToken === 'string' && session.accessToken !== '' ? session : null;
}

/**
 * The `<Code>` an object store put in its XML refusal, as `': Code'`, or `''`.
 *
 * Only the code is kept: the body can be a page of XML, and the code is the whole
 * diagnosis (`ApkDownloadForbidden`, `SignatureDoesNotMatch`, `NoSuchKey`, …). Best-effort
 * — a body that cannot be read costs nothing but the detail.
 */
async function ossRefusalCode(response) {
  if (typeof response?.text !== 'function') return '';
  try {
    const body = await response.text();
    const code = /<Code>([^<]{1,64})<\/Code>/.exec(String(body))?.[1];
    return typeof code === 'string' && code !== '' ? `: ${code}` : '';
  } catch {
    return '';
  }
}

/**
 * Build the resolver the attachment materializer calls for a transit reference.
 *
 * The failure vocabulary is closed and small (`no-credential`, `presign-failed`,
 * `download-failed[: <object-store code>]`, `oversize`, `size-mismatch`,
 * `sha256-mismatch`, `aborted`): the
 * controller is told *why* an attachment did not arrive, and the Host never guesses.
 *
 * @param options - `apiBaseUrl`, `getSession` (the live account session), plus
 *   injectable `fetchImpl`, `maxBytes`, and `timeoutMs`.
 * @returns `resolve(ref, { signal })` → `{ ok: true, buffer, mimeType, name }` or `{ ok: false, reason }`.
 */
export function createMediaRefResolver({ apiBaseUrl, getSession, fetchImpl = fetch, maxBytes = 20 * 1024 * 1024, timeoutMs = 30_000, onUnauthorized } = {}) {
  async function presignGet(key, session, signal) {
    const response = await fetchImpl(`${apiBaseUrl}/media/presign-get`, {
      method: 'POST',
      headers: mediaHeaders(session),
      body: JSON.stringify({ key }),
      signal,
    });
    if (response.ok !== true) {
      const error = new Error(`presign-get answered ${response.status}`);
      // The status is what distinguishes "this credential rotated" from every other refusal.
      error.status = response.status;
      throw error;
    }
    const body = await response.json();
    const url = typeof body?.getUrl === 'string' ? body.getUrl : '';
    if (url === '') throw new Error('presign-get answered no getUrl');
    return url;
  }

  return async function resolveAttachmentRef(ref, { signal } = {}) {
    const declared = Number.isFinite(ref?.size) ? ref.size : null;
    // A declared size above the cap is refused before anything is downloaded.
    if (declared !== null && declared > maxBytes) return { ok: false, reason: 'oversize' };
    const bound = signal ?? (typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined);
    let refreshed = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = usableSession(getSession);
      // No credential means no media: said plainly rather than attempted and failed.
      if (session === null) return { ok: false, reason: 'no-credential' };
      try {
        const url = await presignGet(ref.ossKey, session, bound);
        const response = await fetchImpl(url, { method: 'GET', signal: bound });
        // A refusal names itself: OSS answers XML with `<Code>ApkDownloadForbidden</Code>`
        // and nothing else on the wire carries that. A bare `download-failed` cost an
        // afternoon of probing; the code costs a glance.
        if (response.ok !== true) return { ok: false, reason: `download-failed${await ossRefusalCode(response)}` };
        // The staged length, when the object store states one, is checked before the
        // bytes are pulled into memory rather than after.
        const stated = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(stated) && stated > maxBytes) return { ok: false, reason: 'oversize' };
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > maxBytes) return { ok: false, reason: 'oversize' };
        if (declared !== null && buffer.length !== declared) return { ok: false, reason: 'size-mismatch' };
        if (typeof ref.sha256 === 'string') {
          const digest = createHash('sha256').update(buffer).digest('hex');
          if (digest !== ref.sha256) return { ok: false, reason: 'sha256-mismatch' };
        }
        return {
          ok: true,
          buffer,
          mimeType: typeof ref.mimeType === 'string' ? ref.mimeType : '',
          name: typeof ref.originalName === 'string' ? ref.originalName : '',
        };
      } catch (error) {
        // Same one-refusal-worth-retrying rule as the uploader: a rotated credential, refreshed
        // by the caller, gets exactly one retry with the new session.
        if (error?.status === 401 && refreshed === false && typeof onUnauthorized === 'function') {
          refreshed = true;
          if (await onUnauthorized() === true) continue;
        }
        return { ok: false, reason: bound?.aborted === true ? 'aborted' : `media-request-failed: ${String(error?.message ?? error)}` };
      }
    }
    return { ok: false, reason: 'media-request-failed: presign-get answered 401' };
  };
}

/**
 * Build the staging-object remover.
 *
 * The object is a **staging** copy: once its bytes are a durable DSH attachment the
 * phone's own thumbnail and DSH's own copy are what remain, and leaving it behind
 * accumulates orphans until the bucket's lifecycle rules run. Best-effort by
 * contract — a failed removal is never worth failing a prompt that already landed.
 *
 * @param options - `apiBaseUrl`, `getSession`, and an injectable `fetchImpl`.
 * @returns `remove(ossKey)` → `true` when the server confirmed it.
 */
/**
 * Extension and Content-Type the account's OSS endpoint refuses to serve over the public
 * `*.aliyuncs.com` host, whatever the signature or object ACL says.
 *
 * Measured against the live staging bucket (`tools/probe-oss-ext.mjs`,
 * `tools/probe-apk-export-roundtrip.mjs`): **either** trigger alone makes an object
 * undownloadable by anyone — the staging **PUT still succeeds**, `presign-get` still
 * answers 200 with a valid url, and then the controller's GET meets
 *
 *   400 <Code>ApkDownloadForbidden</Code>
 *   <Message>The APK file is not allowed to be distributed in a public network using
 *            the OSS endpoint, please use CNAME instead.</Message>
 *
 * within ~100 ms:
 *
 *   key suffix `.apk` / `.ipa` (any casing — the server lower-cases it)  → refused
 *   object Content-Type exactly `application/vnd.android.package-archive` → refused
 *   `application/octet-stream` / `zip` / `x-itunes-ipa` / the same mime with
 *   `; charset=binary`                                                   → served
 *
 * This is why an exported `.apk` arrived as 下载失败 in under five seconds while every
 * test looked green: the export really did finish, and only the last hop was refused.
 *
 * The staging descriptor is not user-visible. The controller names its own copy from the
 * name of the file it browsed (`apps/mobile/app/files/[sessionId].tsx`:
 * `downloadRemoteMediaShareTemp(url, mime, item.name)`), and mime for the share sheet
 * comes from that same name — so an app package staged as opaque bytes still arrives as
 * `Cindy-Verify-…apk` and installs normally.
 */
const UNSTAGEABLE_EXTS = new Set(['apk', 'ipa']);
const UNSTAGEABLE_CONTENT_TYPES = new Set(['application/vnd.android.package-archive']);

/**
 * What the staging PUT should declare for this object.
 *
 * An app package — by suffix or by declared mime — is staged as opaque bytes: a neutral
 * extension *and* `application/octet-stream`, because neutralizing only the suffix leaves
 * the Content-Type trigger armed (measured).
 *
 * @param ext - Caller-declared extension, with or without a leading dot.
 * @param contentType - Caller-declared mime, or empty.
 * @returns `{ ext, contentType }` the object store will serve, with the mime never empty.
 */
export function stageableStaging(ext, contentType) {
  const cleanedExt = typeof ext === 'string' ? ext.trim().replace(/^\.+/, '').toLowerCase() : '';
  const declared = typeof contentType === 'string' && contentType.trim() !== '' ? contentType : 'application/octet-stream';
  const bare = declared.split(';')[0].trim().toLowerCase();
  const blockedExt = UNSTAGEABLE_EXTS.has(cleanedExt);
  const appPackage = blockedExt || UNSTAGEABLE_CONTENT_TYPES.has(bare);
  return {
    ext: blockedExt ? 'bin' : cleanedExt,
    contentType: appPackage ? 'application/octet-stream' : declared,
  };
}

/**
 * Build the staging-object uploader.
 *
 * The other half of the same staging area: an image the **agent** produced lives on this
 * machine, the controller cannot reach this machine's disk, and the reference design is to
 * PUT it into the account's staging area and answer with the key
 * (`apps/desktop/src/main/device-link/mediaFetch.ts`: 解析本机媒体 → 上传 OSS → 返回引用).
 * The controller then presign-gets it itself, exactly as this Host does for a photo the
 * phone uploaded.
 *
 * `x-oss-object-acl: private` is **signed into** the presigned URL — omitting it is a 403,
 * not a default-ACL upload. Measured while building `tools/attachment-probe.mjs`.
 *
 * @param options - `apiBaseUrl`, `getSession`, and injectable `fetchImpl`/`timeoutMs`.
 * @returns `upload(bytes, { ext, contentType })` → `{ ok: true, key, size }` or `{ ok: false, reason }`.
 */
export function createMediaUploader({ apiBaseUrl, getSession, fetchImpl = fetch, timeoutMs = 30_000, onUnauthorized } = {}) {
  return async function uploadMedia(bytes, { ext, contentType } = {}) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) return { ok: false, reason: 'empty' };
    // What is declared here is what the object store stores and later judges; see
    // `stageableStaging` for why an app package must be staged as opaque bytes.
    const staging = stageableStaging(ext, contentType);
    let refreshed = false;
    // Two attempts at most: the second only happens after a 401 and a successful refresh.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Re-read every attempt: a refresh updates the caller's session, and the whole point of the
      // retry is to sign with the new one.
      const session = usableSession(getSession);
      if (session === null) return { ok: false, reason: 'no-credential' };
      const bound = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
      try {
        const presign = await fetchImpl(`${apiBaseUrl}/media/presign-put`, {
          method: 'POST',
          headers: mediaHeaders(session),
          body: JSON.stringify({ size: bytes.length, ext: staging.ext, contentType: staging.contentType }),
          signal: bound,
        });
        if (presign.ok !== true) {
          // A rotated credential is the one refusal worth retrying: this process reads the store
          // once, so a session refreshed elsewhere (the settings card, a tool, another process)
          // is invisible here — measured as an export that 401s until the Host is restarted.
          if (presign.status === 401 && refreshed === false && typeof onUnauthorized === 'function') {
            refreshed = true;
            if (await onUnauthorized() === true) continue;
          }
          return { ok: false, reason: `presign-put answered ${presign.status}` };
        }
        const body = await presign.json();
        const putUrl = typeof body?.putUrl === 'string' ? body.putUrl : typeof body?.url === 'string' ? body.url : '';
        const key = typeof body?.key === 'string' ? body.key : '';
        if (putUrl === '' || key === '') return { ok: false, reason: 'presign-put answered no putUrl/key' };
        const put = await fetchImpl(putUrl, {
          method: 'PUT',
          // The stored Content-Type comes from this header, and OSS judges it later.
          headers: { 'Content-Type': staging.contentType, 'x-oss-object-acl': 'private' },
          body: bytes,
          signal: bound,
        });
        if (put.ok !== true) {
          if (put.status === 401 && refreshed === false && typeof onUnauthorized === 'function') {
            refreshed = true;
            if (await onUnauthorized() === true) continue;
          }
          return { ok: false, reason: `staging upload answered ${put.status}` };
        }
        return { ok: true, key, size: bytes.length };
      } catch (error) {
        return { ok: false, reason: bound?.aborted === true ? 'aborted' : `media-upload-failed: ${String(error?.message ?? error)}` };
      }
    }
    return { ok: false, reason: 'presign-put answered 401' };
  };
}

export function createMediaReleaser({ apiBaseUrl, getSession, fetchImpl = fetch } = {}) {
  return async function removeRemoteMedia(ossKey) {
    if (typeof ossKey !== 'string' || ossKey === '') return false;
    const session = usableSession(getSession);
    if (session === null) return false;
    try {
      const response = await fetchImpl(`${apiBaseUrl}/media`, {
        method: 'DELETE',
        headers: mediaHeaders(session),
        body: JSON.stringify({ key: ossKey }),
      });
      return response.ok === true;
    } catch {
      return false;
    }
  };
}
