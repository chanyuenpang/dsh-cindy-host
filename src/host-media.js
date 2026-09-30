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
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

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

const FILE_UPLOAD_LIMIT = 2 * 1024 * 1024 * 1024;
const FILE_UPLOAD_CHUNK = 64 * 1024;

class FileUploadError extends Error {
  constructor(code, stage) {
    super(code.toLowerCase().replaceAll('_', '-'));
    this.code = code;
    this.stage = stage;
  }
}

// Race even uncooperative test transports/credential providers, and consume late
// rejections. A source fd remains exclusively owned by the Export job manager.
function fileUploadAwait(operation, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function discardMediaResponse(response) {
  try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch { /* best effort */ }
}

/**
 * Native PUT deliberately avoids fetch/undici's fixed response-header deadline:
 * a continuously progressing upload may take more than ten minutes. No global
 * dispatcher/agent mutation, redirects, retries, or total-upload timer. Each
 * request owns its socket; the uploader supplies the resettable idle deadline.
 * Awaiting each write callback bounds the writable queue to one <=64KiB chunk
 * (and naturally honors backpressure). Response bodies are not retained.
 */
function nativeFileMediaPut(url, { headers, body, signal }, requestImpl) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(response);
      request?.destroy();
    };
    const abort = () => finish(signal.reason);
    if (signal.aborted) { reject(signal.reason); return; }
    try {
      const send = requestImpl ?? (new URL(url).protocol === 'https:' ? httpsRequest : httpRequest);
      request = send(url, { method: 'PUT', headers, agent: false, timeout: 0 }, (response) => {
        const status = response.statusCode;
        response.destroy();
        finish(null, { ok: status >= 200 && status < 300, status });
      });
      request.on('error', (error) => finish(error));
      request.on('close', () => {
        if (!settled) finish(new Error('PUT closed before response'));
      });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      (async () => {
        for await (const chunk of body) {
          if (settled) break;
          await fileUploadAwait(() => new Promise((written, failed) => {
            request.write(chunk, (error) => error ? failed(error) : written());
          }), signal);
        }
        if (!settled) request.end();
      })().catch((error) => finish(error));
    } catch (error) {
      finish(error);
    }
  });
}

/**
 * Authorized-file uploader; independent of the legacy Buffer uploader above.
 * source = {size, read(buffer, position): Promise<number>, verify(): Promise<void>}
 * is an already-authorized, already-open source; this module NEVER closes it.
 * All sizes 0..2GiB stream. Caller maxBytes/path/owner admission belongs to jobs.
 *
 * getCredential(owner) MUST validate the captured owner and return {session,lease}
 * or null. refreshCredential(capturedCredential) MUST enforce same-owner lineage
 * and CAS itself; a new returned opaque lease is allowed. No live getSession.
 * The manager must abort signal when that owner/controller becomes invalid.
 * Only failure cleanup reacquires a credential, with that SAME captured owner.
 *
 * putImpl(url,{headers,body,signal}) is an optional controlled transport returning
 * {ok,status}; it must incrementally consume the one-shot async iterable body and
 * honor signal. Default native transport has no hidden fixed header deadline.
 * requestImpl optionally injects Node's request signature for transport tests.
 * setTimeoutImpl/clearTimeoutImpl inject timers (normal defaults otherwise).
 *
 * uploadFile(source,{owner,signal,ext,contentType,onProgress,onEvent}) returns
 * {ok:true,key,size,sha256}, or sanitized {ok:false,code,reason,stage}. Progress
 * counts bytes handed to the HTTP stack, NOT peer receipt/network confirmation.
 * Events contain only {type,stage,code?}; callbacks are advisory and isolated.
 */
export function createFileMediaUploader({
  apiBaseUrl, fetchImpl = fetch, getCredential, refreshCredential,
  stageTimeoutMs = 30_000, idleTimeoutMs = 60_000, cleanupTimeoutMs = 5_000,
  putImpl, requestImpl, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
} = {}) {
  const validDuration = (value) => Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
  const credentialUsable = (value) => value?.lease != null
    && typeof value?.session?.accessToken === 'string' && value.session.accessToken !== '';
  const put = putImpl ?? ((url, init) => nativeFileMediaPut(url, init, requestImpl));

  return async function uploadFile(source, opts = {}) {
    const invalid = (code = 'INVALID_ARGUMENT') => ({ ok: false, code, reason: code.toLowerCase().replaceAll('_', '-'), stage: 'validate' });
    if (!opts || typeof opts !== 'object' || !source || typeof source.read !== 'function' || typeof source.verify !== 'function') return invalid();
    const size = source.size;
    if (!Number.isSafeInteger(size) || size < 0) return invalid();
    if (size > FILE_UPLOAD_LIMIT) return invalid('OVERSIZE');
    const { owner, signal, ext, contentType, onProgress, onEvent } = opts;
    if (owner == null || typeof getCredential !== 'function' || typeof fetchImpl !== 'function'
      || typeof put !== 'function' || typeof apiBaseUrl !== 'string' || !apiBaseUrl
      || ![stageTimeoutMs, idleTimeoutMs, cleanupTimeoutMs].every(validDuration)
      || (signal != null && !(signal instanceof AbortSignal))
      || (ext !== undefined && (typeof ext !== 'string' || ext.length > 64 || !/^[.a-zA-Z0-9_-]*$/.test(ext)))
      || (contentType !== undefined && (typeof contentType !== 'string' || contentType.length > 256 || /[^\x20-\x7e]/.test(contentType)))) return invalid();
    const staging = stageableStaging(ext, contentType);
    const controller = new AbortController();
    const bound = controller.signal;
    let stage = 'verify';
    let timer;
    let key;
    let body;
    let complete = false;
    let sha256;
    const fault = (code) => new FileUploadError(code, stage);
    const emit = (type, code) => {
      try { onEvent?.({ type, stage, ...(code ? { code } : {}) }); } catch { /* diagnostics cannot change transfer */ }
    };
    const arm = (ms, code) => {
      clearTimeoutImpl(timer);
      timer = setTimeoutImpl(() => controller.abort(fault(code)), ms);
    };
    const abort = () => controller.abort(fault('ABORTED'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const wait = (operation) => fileUploadAwait(operation, bound);
    const verify = async () => {
      try { await wait(() => source.verify()); }
      catch { throw bound.aborted ? bound.reason : fault('SOURCE_CHANGED'); }
    };
    let cleanupPromise;
    const cleanup = () => cleanupPromise ??= (async () => {
      if (!key) return;
      const cleanupController = new AbortController();
      const cleanupTimer = setTimeoutImpl(() => cleanupController.abort(), Math.min(cleanupTimeoutMs, 5_000));
      const cleanupWait = (operation) => fileUploadAwait(operation, cleanupController.signal);
      try {
        // Never refresh here, nor use the new account's unbound live session.
        const credential = await cleanupWait(() => getCredential(owner));
        if (!credentialUsable(credential)) { emit('cleanup_skipped_owner'); return; }
        const response = await cleanupWait(() => fetchImpl(`${apiBaseUrl}/media`, {
          method: 'DELETE', headers: mediaHeaders(credential.session),
          body: JSON.stringify({ key }), signal: cleanupController.signal,
        }));
        discardMediaResponse(response);
        emit(response?.ok === true ? 'cleanup_done' : 'cleanup_failed');
      } catch { emit('cleanup_failed'); }
      finally { clearTimeoutImpl(cleanupTimer); cleanupController.abort(); }
    })();
    try {
      arm(stageTimeoutMs, 'STAGE_TIMEOUT');
      await verify();
      stage = 'credential';
      let credential;
      try { credential = await wait(() => getCredential(owner)); }
      catch { throw bound.aborted ? bound.reason : fault('OWNER_UNVERIFIED'); }
      if (!credentialUsable(credential)) throw fault('OWNER_UNVERIFIED');
      let signed;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        stage = 'presign';
        emit('presign');
        const response = await wait(() => fetchImpl(`${apiBaseUrl}/media/presign-put`, {
          method: 'POST', headers: mediaHeaders(credential.session),
          body: JSON.stringify({ size, ext: staging.ext, contentType: staging.contentType }), signal: bound,
        }));
        if (response?.ok === true) {
          if (typeof response.body?.getReader === 'function') {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let bytes = 0;
            let text = '';
            try {
              for (;;) {
                const chunk = await wait(() => reader.read());
                if (chunk.done) break;
                bytes += chunk.value.byteLength;
                if (bytes > 64 * 1024) throw fault('PRESIGN_FAILED');
                text += decoder.decode(chunk.value, { stream: true });
              }
              signed = JSON.parse(text + decoder.decode());
            } finally {
              try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
              try { reader.releaseLock(); } catch {}
            }
          } else {
            // Injected response doubles need no network reader.
            signed = await wait(() => response.json());
          }
          break;
        }
        discardMediaResponse(response);
        if (response?.status !== 401) throw fault('PRESIGN_FAILED');
        if (attempt !== 0 || typeof refreshCredential !== 'function') throw fault('AUTH_FAILED');
        stage = 'refresh';
        emit('refresh');
        try { credential = await wait(() => refreshCredential(credential)); }
        catch { throw bound.aborted ? bound.reason : fault('OWNER_UNVERIFIED'); }
        if (!credentialUsable(credential)) throw fault('OWNER_UNVERIFIED');
      }
      if (typeof signed?.key !== 'string' || !signed.key || signed.key.length > 4096 || /[\x00-\x1f\x7f]/.test(signed.key)) throw fault('PRESIGN_FAILED');
      key = signed.key; // Retain a known unpublished key even if the URL is invalid.
      const putUrl = typeof signed.putUrl === 'string' ? signed.putUrl : signed.url;
      if (typeof putUrl !== 'string' || putUrl.length > 16 * 1024) throw fault('PRESIGN_FAILED');
      let target;
      try { target = new URL(putUrl); } catch { throw fault('PRESIGN_FAILED'); }
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw fault('PRESIGN_FAILED');
      bound.throwIfAborted();
      stage = 'put';
      arm(idleTimeoutMs, 'IDLE_TIMEOUT');
      emit('put');
      const hash = createHash('sha256');
      const read = async (buffer, position) => {
        let count;
        try { count = await wait(() => source.read(buffer, position)); }
        catch { throw bound.aborted ? bound.reason : fault('SOURCE_READ_FAILED'); }
        bound.throwIfAborted();
        if (!Number.isInteger(count) || count < 0 || count > buffer.length) throw fault('SOURCE_READ_FAILED');
        return count;
      };
      body = (async function* () {
        try {
          let position = 0;
          while (position < size) {
            const buffer = Buffer.allocUnsafe(Math.min(FILE_UPLOAD_CHUNK, size - position));
            const count = await read(buffer, position);
            if (count === 0) throw fault('SIZE_MISMATCH');
            const chunk = buffer.subarray(0, count);
            hash.update(chunk);
            yield chunk;
            bound.throwIfAborted();
            position += count;
            arm(idleTimeoutMs, 'IDLE_TIMEOUT');
            try { onProgress?.(position); } catch { /* advisory only */ }
          }
          if (await read(Buffer.allocUnsafe(1), size) !== 0) throw fault('SIZE_MISMATCH');
          await verify();
          bound.throwIfAborted();
          sha256 = hash.digest('hex');
          complete = true;
        } catch (error) {
          // Invalidate BEFORE transport can race a successful HTTP response.
          controller.abort(error);
          throw error;
        }
      })();
      const response = await wait(() => put(putUrl, {
        headers: { 'Content-Type': staging.contentType, 'Content-Length': String(size), 'x-oss-object-acl': 'private' },
        body, signal: bound,
      }));
      discardMediaResponse(response);
      bound.throwIfAborted();
      if (response?.ok !== true) throw fault('PUT_FAILED');
      if (!complete) throw fault('INCOMPLETE_UPLOAD');
      await verify(); // Includes changes while awaiting the final HTTP response.
      emit('complete');
      bound.throwIfAborted();
      // The job publisher may still lose a cancellation race before exposing key.
      return { ok: true, key, size, sha256, discard: cleanup };
    } catch (error) {
      const failure = bound.aborted ? bound.reason : error;
      const safe = failure instanceof FileUploadError ? failure : fault('NETWORK_ERROR');
      controller.abort(safe);
      clearTimeoutImpl(timer);
      if (body) await body.return().catch(() => {});
      emit('error', safe.code);
      await cleanup();
      return { ok: false, code: safe.code, reason: safe.message, stage: safe.stage };
    } finally {
      clearTimeoutImpl(timer);
      signal?.removeEventListener('abort', abort);
      controller.abort();
      if (body) await body.return().catch(() => {});
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
