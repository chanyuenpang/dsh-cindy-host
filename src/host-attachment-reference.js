/** Deterministic, non-bearer locators. No path or caller-supplied descriptor is admitted. */
const EXT = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' });
const token = value => Buffer.from(value, 'utf8').toString('base64url');
export function isImageDescriptor(ref) {
  return ref && /^sha256:[a-f0-9]{64}$/.test(ref.attachmentId) && Object.hasOwn(EXT, ref.mediaType)
    && Number.isSafeInteger(ref.bytes) && ref.bytes > 0
    && Number.isSafeInteger(ref.width) && ref.width > 0 && Number.isSafeInteger(ref.height) && ref.height > 0
    && (ref.name === undefined || typeof ref.name === 'string');
}
export function attachmentImageUrl(sessionId, messageId, blockPath, ref) {
  if (![sessionId, messageId].every(v => typeof v === 'string' && v.length > 0 && v.length <= 256)
    || !/^(0|[1-9][0-9]{0,5})(\.(0|[1-9][0-9]{0,5}))?$/.test(blockPath) || !isImageDescriptor(ref)) return null;
  return `xdt-image://dsh-attachment/v1/${token(sessionId)}/${token(messageId)}/${blockPath}/${ref.attachmentId.slice(7)}.${EXT[ref.mediaType]}`;
}
export function parseAttachmentImageUrl(url) {
  if (typeof url !== 'string' || url.length > 2048) return null;
  const match = /^xdt-image:\/\/dsh-attachment\/v1\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/((?:0|[1-9][0-9]{0,5})(?:\.(?:0|[1-9][0-9]{0,5}))?)\/([a-f0-9]{64})\.(png|jpg|webp|gif)$/.exec(url);
  if (!match) return null;
  const [, sid, mid, blockPath, hash, ext] = match;
  const sessionId = Buffer.from(sid, 'base64url').toString('utf8');
  const messageId = Buffer.from(mid, 'base64url').toString('utf8');
  if (!sessionId || !messageId || sessionId.length > 256 || messageId.length > 256 || token(sessionId) !== sid || token(messageId) !== mid) return null;
  return { sessionId, messageId, blockPath, attachmentId: `sha256:${hash}`, mediaType: Object.keys(EXT).find(mime => EXT[mime] === ext), ext };
}

/** Only native image blocks in renderable model/tool messages, never JSON text. */
export function nativeMessageImages(message) {
  const source = message?.source?.kind;
  const direct = message?.role === 'tool' && (!source || source === 'tool')
    || message?.role === 'assistant' && (!source || source === 'model');
  const legacy = message?.role === 'user' && (!source || source === 'tool');
  const found = [];
  for (const [index, block] of (Array.isArray(message?.content) ? message.content : []).entries()) {
    if (direct && block?.type === 'image' && isImageDescriptor(block.attachment)) found.push({ blockPath: String(index), ref: block.attachment });
    if (legacy && block?.type === 'tool-result' && Array.isArray(block.content)) {
      for (const [child, nested] of block.content.entries())
        if (nested?.type === 'image' && isImageDescriptor(nested.attachment)) found.push({ blockPath: `${index}.${child}`, ref: nested.attachment });
    }
  }
  return found;
}
export function toolResultWithImages(text, message, sessionId, resultIndex = null) {
  const urls = nativeMessageImages(message).filter(image => resultIndex === null || image.blockPath.startsWith(`${resultIndex}.`))
    .map(image => attachmentImageUrl(sessionId, message.id, image.blockPath, image.ref)).filter(Boolean);
  return urls.length ? JSON.stringify({ text, xdt_image_urls: urls }) : text;
}
