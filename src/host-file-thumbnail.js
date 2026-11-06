import { createLocalFileResolver, readPreparedInline, resolveThumbnailCodec } from './host-media-fetch.js';
import { createLocalFileUrl } from './host-file-reference.js';

export const GRID_THUMBNAIL_LIMITS = Object.freeze({ edge: 256, quality: 70, outputBytes: 128 * 1024 });
export const IMAGE_INPUT_BYTES = 48 * 1024 * 1024;
export const IMAGE_INPUT_PIXELS = 40_000_000;

const failed = (code, message) => ({ ok: false, code, message });

/** Soft deadlines do not release the concurrency slot until native work actually settles. */
export function createThumbnailRenderer({ codec = resolveThumbnailCodec, concurrency = 2, timeoutMs = 5000 } = {}) {
  let active = 0;
  let loaded;
  return async function render(bytes, { edge = 1024, quality = 80, outputBytes = 700 * 1024 } = {}) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > IMAGE_INPUT_BYTES)
      return failed('THUMB_TOO_LARGE', 'invalid or oversized input');
    if (active >= concurrency) return failed('THUMB_FAILED', 'thumbnail renderer busy; retry later');
    try { loaded ??= codec(); } catch { return failed('THUMB_UNSUPPORTED', 'image codec unavailable'); }
    if (typeof loaded !== 'function') return failed('THUMB_UNSUPPORTED', 'image codec unavailable');
    active++;
    let timer;
    const work = Promise.resolve().then(async () => {
      const out = await loaded(bytes, { limitInputPixels: IMAGE_INPUT_PIXELS, failOn: 'error', animated: false })
        .rotate().resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .webp({ quality }).toBuffer({ resolveWithObject: true });
      if (!Buffer.isBuffer(out?.data) || !out.data.length || out.data.length > outputBytes)
        return failed('THUMB_TOO_LARGE', 'thumbnail exceeds output budget');
      if (![out.info?.width, out.info?.height].every(n => Number.isInteger(n) && n > 0 && n <= edge))
        return failed('THUMB_FAILED', 'invalid thumbnail dimensions');
      return { ok: true, data: out.data, width: out.info.width, height: out.info.height, mimeType: 'image/webp' };
    }).catch(() => failed('THUMB_FAILED', 'image could not be decoded')).finally(() => { active--; });
    try {
      return await Promise.race([work, new Promise(resolve => {
        timer = setTimeout(() => resolve(failed('THUMB_FAILED', 'thumbnail render timeout')), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  };
}

export const renderBoundedThumbnail = createThumbnailRenderer();

/** Local-only file browser thumbnails reuse the exact authorization boundary of fileUrl. */
export function createFileThumbnail({
  resolveFile = createLocalFileResolver({ maxBytes: IMAGE_INPUT_BYTES }),
  readBytes = readPreparedInline, render = renderBoundedThumbnail,
} = {}) {
  const fileUrl = createLocalFileUrl({ resolveFile });
  let active = 0;
  return async function thumbnail({ workdir, relPath } = {}) {
    if (active >= 2) return failed('THUMB_FAILED', 'thumbnail reader busy; retry later');
    active++;
    try {
      const reference = await fileUrl({ workdir, relPath });
      if (!reference.ok) return failed(reference.code === 'BAD_REQUEST' && /byte limit/.test(reference.message) ? 'THUMB_TOO_LARGE' : 'THUMB_FAILED', 'image path is unavailable, not allowed or too large');
      const source = await resolveFile(reference.url);
      if (!source.ok) return failed('THUMB_FAILED', 'image path is unavailable or not allowed');
      if (source.info.size > IMAGE_INPUT_BYTES) return failed('THUMB_TOO_LARGE', 'image exceeds input budget');
      const bytes = await readBytes(source.real, source.info);
      const result = await render(bytes, GRID_THUMBNAIL_LIMITS);
      if (!result.ok) return result;
      return { ok: true, dataBase64: result.data.toString('base64'), mimeType: result.mimeType, width: result.width, height: result.height };
    } catch { return failed('THUMB_FAILED', 'image changed or could not be read'); }
    finally { active--; }
  };
}

export const fileThumbnail = createFileThumbnail();
