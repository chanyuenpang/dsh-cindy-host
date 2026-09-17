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
 * Build the resolver the attachment materializer calls for a transit reference.
 *
 * The failure vocabulary is closed and small (`no-credential`, `presign-failed`,
 * `download-failed`, `oversize`, `size-mismatch`, `sha256-mismatch`, `aborted`): the
 * controller is told *why* an attachment did not arrive, and the Host never guesses.
 *
 * @param options - `apiBaseUrl`, `getSession` (the live account session), plus
 *   injectable `fetchImpl`, `maxBytes`, and `timeoutMs`.
 * @returns `resolve(ref, { signal })` → `{ ok: true, buffer, mimeType, name }` or `{ ok: false, reason }`.
 */
export function createMediaRefResolver({ apiBaseUrl, getSession, fetchImpl = fetch, maxBytes = 20 * 1024 * 1024, timeoutMs = 30_000 } = {}) {
  async function presignGet(key, session, signal) {
    const response = await fetchImpl(`${apiBaseUrl}/media/presign-get`, {
      method: 'POST',
      headers: mediaHeaders(session),
      body: JSON.stringify({ key }),
      signal,
    });
    if (response.ok !== true) throw new Error(`presign-get answered ${response.status}`);
    const body = await response.json();
    const url = typeof body?.getUrl === 'string' ? body.getUrl : '';
    if (url === '') throw new Error('presign-get answered no getUrl');
    return url;
  }

  return async function resolveAttachmentRef(ref, { signal } = {}) {
    const session = usableSession(getSession);
    // No credential means no media: said plainly rather than attempted and failed.
    if (session === null) return { ok: false, reason: 'no-credential' };
    const declared = Number.isFinite(ref?.size) ? ref.size : null;
    // A declared size above the cap is refused before anything is downloaded.
    if (declared !== null && declared > maxBytes) return { ok: false, reason: 'oversize' };
    const bound = signal ?? (typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined);
    try {
      const url = await presignGet(ref.ossKey, session, bound);
      const response = await fetchImpl(url, { method: 'GET', signal: bound });
      if (response.ok !== true) return { ok: false, reason: 'download-failed' };
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
      return { ok: false, reason: bound?.aborted === true ? 'aborted' : `media-request-failed: ${String(error?.message ?? error)}` };
    }
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
export function createMediaUploader({ apiBaseUrl, getSession, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  return async function uploadMedia(bytes, { ext, contentType } = {}) {
    const session = usableSession(getSession);
    if (session === null) return { ok: false, reason: 'no-credential' };
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) return { ok: false, reason: 'empty' };
    const bound = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
    try {
      const presign = await fetchImpl(`${apiBaseUrl}/media/presign-put`, {
        method: 'POST',
        headers: mediaHeaders(session),
        body: JSON.stringify({ size: bytes.length, ext: typeof ext === 'string' ? ext : '', contentType }),
        signal: bound,
      });
      if (presign.ok !== true) return { ok: false, reason: `presign-put answered ${presign.status}` };
      const body = await presign.json();
      const putUrl = typeof body?.putUrl === 'string' ? body.putUrl : typeof body?.url === 'string' ? body.url : '';
      const key = typeof body?.key === 'string' ? body.key : '';
      if (putUrl === '' || key === '') return { ok: false, reason: 'presign-put answered no putUrl/key' };
      const put = await fetchImpl(putUrl, {
        method: 'PUT',
        headers: { 'Content-Type': contentType, 'x-oss-object-acl': 'private' },
        body: bytes,
        signal: bound,
      });
      if (put.ok !== true) return { ok: false, reason: `staging upload answered ${put.status}` };
      return { ok: true, key, size: bytes.length };
    } catch (error) {
      return { ok: false, reason: bound?.aborted === true ? 'aborted' : `media-upload-failed: ${String(error?.message ?? error)}` };
    }
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
