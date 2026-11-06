import { createHash } from 'node:crypto';
import { deriveEventMessage, isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface';
import { nativeMessageImages, attachmentImageUrl, parseAttachmentImageUrl, isImageDescriptor } from './host-attachment-reference.js';
import { renderBoundedThumbnail } from './host-file-thumbnail.js';
import { MEDIA_FETCH_MAX_BYTES, INLINE_ORIGINAL_MAX_BYTES, STAGING_CACHE_MAX, STAGING_CACHE_TTL_MS, isThumbnailableMime } from './host-media-fetch.js';

const failure = (code, message) => ({ ok: false, code, message });

/** Reconstruct from the authorized source log on every request, including after restart. */
export function createNativeAttachmentSourceReader({ getSession, readSessionLog, readImage }) {
  return async locator => {
    if (typeof getSession !== 'function' || typeof readSessionLog !== 'function' || typeof readImage !== 'function')
      return failure('NOT_AVAILABLE', 'native attachment services unavailable');
    try {
      if (!await getSession(locator.sessionId)) return failure('FORBIDDEN', 'source session unavailable');
      const log = await readSessionLog(locator.sessionId);
      let ref;
      for (const event of Array.isArray(log?.events) ? log.events : []) {
        if (!event || !isAppendSurfaceEvent(event)) continue;
        const message = deriveEventMessage(event);
        if (message?.id !== locator.messageId) continue;
        const image = nativeMessageImages(message).find(image => image.blockPath === locator.blockPath);
        if (image?.ref.attachmentId === locator.attachmentId && image.ref.mediaType === locator.mediaType) ref = image.ref;
        break;
      }
      if (!ref) return failure('MEDIA_SOURCE_MISSING', 'source image no longer available');
      if (ref.bytes > MEDIA_FETCH_MAX_BYTES) return failure('BAD_REQUEST', 'source image exceeds media budget');
      const stored = await readImage(ref);
      if (!stored || typeof stored.base64 !== 'string') return failure('MEDIA_SOURCE_MISSING', 'source image no longer readable');
      return { ok: true, ref, bytes: Buffer.from(stored.base64, 'base64') };
    } catch { return failure('MEDIA_SOURCE_MISSING', 'source image no longer readable'); }
  };
}

/** These URLs do not name paths, so they never enter the arbitrary local-file resolver. */
export function createAttachmentMediaFetcher({ readSource, uploader, render = renderBoundedThumbnail, now = Date.now, maxBytes = MEDIA_FETCH_MAX_BYTES, getScope = () => 0, isAllowed = () => true, maxConcurrent = 4 } = {}) {
  const staged = new Map();
  const flights = new Map();
  const inline = (mimeType, bytes) => ({ ok: true, result: { ossKey: '', mimeType, size: bytes.length, inlineBase64: bytes.toString('base64') } });
  let active = 0;
  async function fetchImage(input) {
    const locator = parseAttachmentImageUrl(input?.url);
    if (!locator) return failure('BAD_REQUEST', 'invalid DSH attachment image locator');
    const scope = getScope();
    const current = () => scope !== null && getScope() === scope && isAllowed(locator);
    const superseded = () => failure('FORBIDDEN', 'image request authorization changed');
    if (!current()) return superseded();
    if (typeof readSource !== 'function') return failure('NOT_AVAILABLE', 'native attachment reader unavailable');
    // Authorization and current source existence are checked even on a staging-cache hit.
    let source;
    try { source = await readSource(locator); } catch { return failure('MEDIA_SOURCE_MISSING', 'source image unreadable'); }
    if (!current()) return superseded();
    if (!source?.ok) return source ?? failure('MEDIA_SOURCE_MISSING', 'source image unavailable');
    const { ref, bytes } = source;
    if (!isImageDescriptor(ref) || attachmentImageUrl(locator.sessionId, locator.messageId, locator.blockPath, ref) !== input.url
      || !Buffer.isBuffer(bytes) || bytes.length !== ref.bytes
      || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== ref.attachmentId)
      return failure('MEDIA_SOURCE_MISSING', 'source image descriptor mismatch');
    if (bytes.length > maxBytes) return failure('BAD_REQUEST', 'source image exceeds media budget');
    if (input?.prepareOnly === true && input?.thumbnail !== true)
      return failure('NOT_AVAILABLE', 'native attachment images use media fetch, not file-peer');
    const cacheKey = `${scope}:${ref.attachmentId}`;
    const key = `${cacheKey}:${input?.thumbnail === true ? 'thumbnail' : 'original'}:${input?.skipCache === true ? 'refresh' : 'cached'}`;
    if (flights.has(key)) {
      const result = await flights.get(key);
      return current() ? result : superseded();
    }
    const work = Promise.resolve().then(async () => {
      if (!current()) return superseded();
      if (input?.thumbnail === true) {
        let thumb;
        try { thumb = isThumbnailableMime(ref.mediaType) ? await render(bytes) : null; } catch { thumb = null; }
        if (!current()) return superseded();
        if (thumb?.ok && Buffer.isBuffer(thumb.data) && thumb.data.length > 0 && thumb.data.length <= 700 * 1024) return inline('image/webp', thumb.data);
        if (bytes.length <= INLINE_ORIGINAL_MAX_BYTES) return inline(ref.mediaType, bytes);
      }
      if (typeof uploader !== 'function') return failure('NOT_AVAILABLE', 'media staging unavailable');
      const cached = staged.get(cacheKey);
      if (input?.skipCache !== true && cached && cached.at + STAGING_CACHE_TTL_MS > now()) return { ok: true, result: { ...cached.result } };
      if (!current()) return superseded();
      const result = await uploader(bytes, { ext: locator.ext, contentType: ref.mediaType });
      if (!current()) return superseded();
      if (!result?.ok || typeof result.key !== 'string' || !result.key) return failure('INTERNAL', 'image staging failed; retry later');
      const answer = { ossKey: result.key, mimeType: ref.mediaType, size: bytes.length };
      staged.set(cacheKey, { at: now(), result: answer });
      while (staged.size > STAGING_CACHE_MAX) staged.delete(staged.keys().next().value);
      return { ok: true, result: answer };
    }).catch(() => failure('INTERNAL', 'image staging failed; retry later')).finally(() => flights.delete(key));
    flights.set(key, work);
    return work;
  }
  return async input => {
    if (active >= maxConcurrent) return failure('INTERNAL', 'image reader busy; retry later');
    active++;
    try { return await fetchImage(input); } finally { active--; }
  };
}
