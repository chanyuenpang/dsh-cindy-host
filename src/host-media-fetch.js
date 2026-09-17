/**
 * Serve one file from this machine to a controller: `device-link:media:fetch`.
 *
 * The missing half of attachments. A photo the *phone* sends arrives as a transit
 * reference this Host fetches; an image the **agent** produced goes the other way — it is
 * a file on this machine, and the controller cannot read this machine's disk. The
 * reference implementation is the desktop being controlled
 * (`apps/desktop/src/main/device-link/mediaFetch.ts`: 解析本机媒体 → 上传 OSS → 返回引用):
 *
 * ```
 * request   { url: 'xdt-file://open?path=<abs>&workdir=<abs>&maxBytes=<n>', thumbnail?, skipCache? }
 * response  { ossKey, mimeType, size }            // the controller presign-gets the key
 * ```
 *
 * Two things are deliberately **stricter** than the reference, because this Host is a
 * process on somebody's desktop rather than an app with its own cache directory:
 *
 * 1. **A containment root is mandatory.** The desktop treats a missing `baseDir` as "no
 *    constraint" for old controllers; here a request that names no root (neither `baseDir`
 *    nor the `workdir` a chat image carries) is refused. Without that, any absolute path
 *    on this machine would be servable by anyone who can reach the Host.
 * 2. **Realpath on both sides.** A symlink inside the workspace must not become a way out
 *    of it, and `/tmp` vs `/private/tmp` must not make a legitimate file look outside.
 *
 * Malformed constraint parameters are refused rather than ignored: silently degrading to
 * "unconstrained" is how a constraint gets removed by a typo.
 *
 * `thumbnail: true` is honoured when this Host can render one. The reference controlled
 * end downscales with `sharp` and returns the bytes **inline** (`inlineBase64`, with an
 * empty `ossKey`) so the controller skips the whole upload → presign → download round
 * trip; the limits here are copied from it (`mediaFetch.ts`: png/jpeg/webp, input below
 * 48 MiB, 1024 px longest edge, webp q80, 5 s soft timeout, and only results up to
 * 700 KiB are inlined). Rendering is best-effort by design: an unavailable codec, an
 * unrenderable image, or an oversized result all fall back to the plain `ossKey` answer,
 * which the contract has always required the controller to accept.
 *
 * @module dsh-cindy-host/host-media-fetch
 */
import { createRequire } from 'node:module';
import { extname, isAbsolute, relative, resolve as resolvePath } from 'node:path';
import { readFile as readFileImpl, realpath as realpathImpl, stat as statImpl } from 'node:fs/promises';

/** Longest file this Host will stage for a controller. */
export const MEDIA_FETCH_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Thumbnail limits, mirrored from the reference controlled end.
 *
 * `1024` because the phone's chat bubble is at most ~1080 px wide at 3x; q80 webp
 * because that is what the reference sends; `700 KiB` because above it the inline form
 * would eat the device-link frame budget the controller's 30 s deadline rides on.
 */
export const THUMBNAIL_MAX_EDGE = 1024;
export const THUMBNAIL_WEBP_QUALITY = 80;
export const THUMBNAIL_INLINE_MAX_BYTES = 700 * 1024;
export const THUMBNAIL_INPUT_MAX_BYTES = 48 * 1024 * 1024;
export const THUMBNAIL_RENDER_TIMEOUT_MS = 5_000;
/** What a rendered thumbnail is served as. */
export const THUMBNAIL_MIME = 'image/webp';

/**
 * Longest *original* image this Host will inline when it cannot downscale one.
 *
 * The controller asks for a thumbnail to avoid a whole upload → presign → download round
 * trip; when this Host has no codec for the picture (or the picture is one it must not
 * re-encode), sending small originals inline still removes that round trip. 512 KiB of
 * bytes becomes ≈683 KiB of base64, which is inside the relay's 2 MiB frame ceiling with
 * room to spare and comparable to the reference's 700 KiB inline allowance.
 */
export const INLINE_ORIGINAL_MAX_BYTES = 512 * 1024;

/**
 * How long a staged object is reused, and how many are remembered.
 *
 * Chat media is resolved from the same path over and over (every time a bubble is rendered
 * after the phone's cache evicts it), and staging is the expensive half. The key carries the
 * file's size and mtime, so a rewritten file is a different entry; `skipCache` bypasses the
 * lookup for the case where the *object* is gone rather than the file changed.
 */
export const STAGING_CACHE_TTL_MS = 30 * 60_000;
export const STAGING_CACHE_MAX = 512;

/**
 * Images worth downscaling.
 *
 * A GIF thumbnail would be a still frame (a semantic loss) and an SVG is already tiny,
 * so neither is rendered — the reference draws the same line.
 */
const THUMBNAILABLE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** Whether an image of this content type can be downscaled. */
export function isThumbnailableMime(mimeType) {
  return THUMBNAILABLE_MIMES.has(String(mimeType));
}

let sharpModule;
let sharpResolved = false;

/**
 * Resolve an image codec from the first anchor that has one.
 *
 * Exported with an explicit anchor list so the resolution can be exercised without
 * running inside the harness (the default anchors are what a live Host uses).
 * @param anchors - module specifiers or file URLs to resolve `sharp` from.
 * @returns the codec's callable export, or null when none of them has it.
 */
export function resolveThumbnailCodec(anchors = defaultThumbnailAnchors()) {
  for (const anchor of anchors) {
    try {
      const loaded = createRequire(anchor)('sharp');
      const factory = typeof loaded === 'function' ? loaded : loaded?.default;
      if (typeof factory === 'function') return factory;
    } catch {
      // No codec on this anchor: the next one, or no thumbnails at all.
    }
  }
  return null;
}

/**
 * Where to look for the harness's image codec.
 *
 * `sharp` is not a dependency of this plugin — it is a dependency of the harness
 * (`@deepseek-ai/dsh-attachment-local`), which is also what normalizes every image a
 * session stores. Loading the copy the harness already installed is what keeps this Host
 * free of a second native image pipeline.
 *
 * The first anchor is what makes it findable: resolution starts at `process.argv[1]`, the
 * harness entry point when this Host runs inside `dsh web`, and walks up through the
 * installation that actually contains `sharp`. Resolving from this module's own path would
 * look inside *this plugin's* tree, where the codec legitimately does not exist.
 * @returns anchors, best first.
 */
function defaultThumbnailAnchors() {
  const anchors = [];
  if (typeof process?.argv?.[1] === 'string' && process.argv[1] !== '') anchors.push(process.argv[1]);
  anchors.push(import.meta.url);
  return anchors;
}

/** The memoized codec this process will use, or null when this installation has none. */
function loadSharp() {
  if (sharpResolved) return sharpModule;
  sharpResolved = true;
  sharpModule = resolveThumbnailCodec();
  return sharpModule;
}

/** Forget the cached codec resolution (tests re-probe with a different environment). */
export function resetThumbnailCodec() {
  sharpModule = undefined;
  sharpResolved = false;
}

/** Run one render under a soft deadline, so a pathological image cannot hold the invoke. */
async function withRenderTimeout(work, ms) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('thumbnail render timeout')), ms);
        if (typeof timer?.unref === 'function') timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The default renderer: EXIF-rotate → fit inside → webp.
 *
 * @param absPath - the resolved path of the image.
 * @param codec - the codec to render with; defaults to this process's resolved one.
 * @returns the thumbnail bytes, or null when no codec is available or rendering failed.
 */
export async function renderThumbnailWithSharp(absPath, codec = loadSharp()) {
  if (typeof codec !== 'function') return null;
  try {
    const buffer = await codec(absPath)
      .rotate()
      .resize({ width: THUMBNAIL_MAX_EDGE, height: THUMBNAIL_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: THUMBNAIL_WEBP_QUALITY })
      .toBuffer();
    return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  } catch {
    return null;
  }
}

/**
 * Content types by extension.
 *
 * The controller decides how to render from this, so an unknown extension is served as
 * `application/octet-stream` rather than guessed at.
 */
const MIME_BY_EXT = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
});

/** The content type one path is served with. */
export function mimeForMediaPath(path) {
  return MIME_BY_EXT[extname(String(path)).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Names this Host refuses to serve to *any* controller, whatever root it is inside.
 *
 * A workspace is chosen by the user and can be as broad as their home directory, so
 * containment alone is not a secret boundary. These are the credential-shaped paths a
 * remote "show me this file" request must never be able to read.
 */
const DEFAULT_BLOCKED = Object.freeze([
  '.ssh', '.aws', '.gnupg', '.docker/config.json',
  '.credentials.yaml', '.openai-codex-auth.json', '.netrc', 'id_rsa', 'id_ed25519', '.env',
]);

/** Whether a resolved path is inside a resolved directory (equal counts as inside). */
export function isInsideDirectory(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Whether a request path is fully qualified (drive-absolute or root-absolute). */
function isAbsoluteMediaPath(value) {
  return value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * Parse one `device-link:media:fetch` url.
 *
 * @param url - the controller's url.
 * @returns `{ ok: true, path, roots, maxBytes }` or `{ ok: false, reason }` — the reason
 *   is a bounded token, because it travels back to the controller.
 */
export function parseMediaFetchRequest(url) {
  if (typeof url !== 'string' || url === '') return { ok: false, reason: 'missing-url' };
  if (!url.startsWith('xdt-file://') && !url.startsWith('xdt-audio://')) {
    // `xdt-image://` / `xdt-video://` / `cindy-media://` name a *desktop* media cache; this
    // Host has none, so the honest answer is that the scheme is not served here.
    return { ok: false, reason: 'unsupported-scheme' };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'malformed-url' };
  }
  const path = parsed.searchParams.get('path');
  if (path === null || path.trim() === '') return { ok: false, reason: 'missing-path' };
  if (!isAbsoluteMediaPath(path)) return { ok: false, reason: 'path-not-absolute' };

  const roots = [];
  for (const key of ['baseDir', 'workdir']) {
    const value = parsed.searchParams.get(key);
    if (value === null) continue;
    // Present but malformed is refused, never dropped: a constraint that can be disabled
    // by a typo is not a constraint.
    if (value.trim() === '' || !isAbsoluteMediaPath(value)) return { ok: false, reason: `invalid-${key}` };
    roots.push(value);
  }
  if (roots.length === 0) return { ok: false, reason: 'no-root' };

  let maxBytes = null;
  const rawMaxBytes = parsed.searchParams.get('maxBytes');
  if (rawMaxBytes !== null) {
    const parsedMax = Number(rawMaxBytes);
    if (!Number.isInteger(parsedMax) || parsedMax <= 0) return { ok: false, reason: 'invalid-maxBytes' };
    maxBytes = parsedMax;
  }
  return { ok: true, path, roots, maxBytes };
}

/** Whether a resolved path, or any of its segments, is on the never-serve list. */
export function isBlockedMediaPath(path, blocked = DEFAULT_BLOCKED) {
  const normalized = String(path).replace(/\\/g, '/').toLowerCase();
  const segments = normalized.split('/');
  return blocked.some((entry) => {
    const needle = entry.toLowerCase();
    return needle.includes('/') ? normalized.endsWith(needle) : segments.includes(needle);
  });
}

/**
 * Build the fetcher behind the channel.
 *
 * @param options - `uploader` (from `host-media.js`), plus injectable filesystem calls,
 *   the size cap, the never-serve list, and the thumbnail renderer (injectable so tests
 *   never touch a native codec).
 * @returns `fetchLocalMedia({ url, thumbnail })` → `{ ok: true, result }` or
 *   `{ ok: false, code, message }`.
 */
export function createLocalMediaFetcher({
  uploader,
  readFile = readFileImpl,
  realpath = realpathImpl,
  stat = statImpl,
  maxBytes = MEDIA_FETCH_MAX_BYTES,
  blocked = DEFAULT_BLOCKED,
  renderThumbnail = renderThumbnailWithSharp,
  thumbnailLimits = {},
  inlineOriginalMaxBytes = INLINE_ORIGINAL_MAX_BYTES,
  cacheTtlMs = STAGING_CACHE_TTL_MS,
  cacheMax = STAGING_CACHE_MAX,
  now = () => Date.now(),
} = {}) {
  const inlineMaxBytes = Number.isFinite(thumbnailLimits.inlineMaxBytes) ? thumbnailLimits.inlineMaxBytes : THUMBNAIL_INLINE_MAX_BYTES;
  const inputMaxBytes = Number.isFinite(thumbnailLimits.inputMaxBytes) ? thumbnailLimits.inputMaxBytes : THUMBNAIL_INPUT_MAX_BYTES;
  const renderTimeoutMs = Number.isFinite(thumbnailLimits.timeoutMs) ? thumbnailLimits.timeoutMs : THUMBNAIL_RENDER_TIMEOUT_MS;
  /** `path|size|mtime` → the object this Host already staged for it. */
  const staged = new Map();

  /** The object already staged for this exact file version, if it is still fresh. */
  function lookupStaged(key) {
    const hit = staged.get(key);
    if (hit === undefined) return undefined;
    if (hit.at + cacheTtlMs <= now()) {
      staged.delete(key);
      return undefined;
    }
    return hit;
  }

  /** Remember one staged object, evicting the oldest entries past the bound. */
  function rememberStaged(key, entry) {
    staged.set(key, entry);
    while (staged.size > cacheMax) {
      const oldest = staged.keys().next();
      if (oldest.done === true) break;
      staged.delete(oldest.value);
    }
  }

  return async function fetchLocalMedia(input) {
    const request = parseMediaFetchRequest(input?.url);
    if (request.ok !== true) return { ok: false, code: 'BAD_REQUEST', message: `media fetch refused: ${request.reason}` };
    if (typeof uploader !== 'function') return { ok: false, code: 'NOT_AVAILABLE', message: 'this Host cannot stage media for a controller' };

    let real;
    try {
      real = await realpath(request.path);
    } catch {
      return { ok: false, code: 'NOT_FOUND', message: 'the requested file does not exist' };
    }
    const allowedRoots = [];
    for (const root of request.roots) {
      try {
        allowedRoots.push(await realpath(root));
      } catch {
        // A root that does not resolve cannot authorise anything; the others still can.
      }
    }
    if (allowedRoots.length === 0 || !allowedRoots.some((root) => isInsideDirectory(real, root))) {
      return { ok: false, code: 'FORBIDDEN', message: 'the requested file is outside the directory the controller named' };
    }
    if (isBlockedMediaPath(real, blocked)) {
      return { ok: false, code: 'FORBIDDEN', message: 'the requested file is not served to controllers' };
    }

    let info;
    try {
      info = await stat(real);
    } catch {
      return { ok: false, code: 'NOT_FOUND', message: 'the requested file could not be read' };
    }
    if (typeof info?.isDirectory === 'function' && info.isDirectory()) {
      return { ok: false, code: 'BAD_REQUEST', message: 'the requested path is a directory' };
    }
    const cap = request.maxBytes === null ? maxBytes : Math.min(request.maxBytes, maxBytes);
    if (Number.isFinite(info?.size) && info.size > cap) {
      return { ok: false, code: 'BAD_REQUEST', message: `the file is ${info.size} bytes, over the ${cap} byte limit` };
    }

    let bytes;
    try {
      bytes = await readFile(real);
    } catch {
      return { ok: false, code: 'INTERNAL', message: 'the requested file could not be read' };
    }
    if (bytes.length > cap) {
      return { ok: false, code: 'BAD_REQUEST', message: `the file is ${bytes.length} bytes, over the ${cap} byte limit` };
    }

    const mimeType = mimeForMediaPath(real);
    const wantsInline = input?.thumbnail === true;
    // The chat-thumbnail path: the controller asked for a smaller picture, so give it the
    // bytes directly when this Host can produce them inside the frame it has to fit.
    if (wantsInline && isThumbnailableMime(mimeType) && bytes.length <= inputMaxBytes && typeof renderThumbnail === 'function') {
      const thumb = await withRenderTimeout(
        Promise.resolve().then(() => renderThumbnail(real)).catch(() => null),
        renderTimeoutMs,
      ).catch(() => null);
      const thumbnail = Buffer.isBuffer(thumb) ? thumb : null;
      if (thumbnail !== null && thumbnail.length > 0 && thumbnail.length <= inlineMaxBytes) {
        return { ok: true, result: inlineResult(THUMBNAIL_MIME, thumbnail) };
      }
    }
    // No downscale available (no codec, a format this Host must not re-encode, a failed or
    // oversized render) — but the controller still wanted bytes rather than a key, and a
    // small original inlined beats a full staging round trip. The controller only accepts
    // an `image/*` inline payload (`isValidInlineResult` in `remoteMedia.ts`), so anything
    // else keeps the key path.
    if (wantsInline && mimeType.startsWith('image/') && bytes.length > 0 && bytes.length <= inlineOriginalMaxBytes) {
      return { ok: true, result: inlineResult(mimeType, bytes) };
    }

    const cacheKey = `${real}|${info.size}|${Number.isFinite(info.mtimeMs) ? Math.round(info.mtimeMs) : 'x'}`;
    if (input?.skipCache !== true) {
      const remembered = lookupStaged(cacheKey);
      if (remembered !== undefined) {
        return { ok: true, result: { ossKey: remembered.key, mimeType, size: remembered.size } };
      }
    }

    const stagedResult = await uploader(bytes, { ext: extname(real).slice(1), contentType: mimeType });
    if (stagedResult?.ok !== true) {
      return { ok: false, code: 'INTERNAL', message: `the file could not be staged for the controller: ${String(stagedResult?.reason ?? 'unknown reason')}` };
    }
    rememberStaged(cacheKey, { key: stagedResult.key, size: bytes.length, at: now() });
    return { ok: true, result: { ossKey: stagedResult.key, mimeType, size: bytes.length } };
  };
}

/** The inline answer shape: no object exists, so `ossKey` is empty on purpose. */
function inlineResult(mimeType, bytes) {
  return { ossKey: '', mimeType, size: bytes.length, inlineBase64: bytes.toString('base64') };
}
