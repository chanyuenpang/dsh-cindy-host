/**
 * Turn a controller's attachment into a DSH prompt content part.
 *
 * The controller attaches files **inside the message**, not over a channel of
 * their own: `maker:send` / `maker:input:enqueue` carry
 * `files?: RemoteSerializedAttachment[]`. Two forms arrive, and both are serveable:
 *
 *  - **host path** — an absolute path on this machine (the file browser's "send to
 *    session"). Readable through `ctx.fs`, so it becomes a durable attachment.
 *  - **uploaded** — the bytes went to the Cindy account's OSS staging area and the
 *    reference is a transit ref (`cindy-oss-attach://…` or the pre-rebrand
 *    `xdt-oss-attach://…`). Fetching it is the controlled end's job and this Host
 *    does it with its own account credential (`host-media.js`). Phones use the
 *    **legacy** scheme, so both must be recognized; a reference this Host cannot
 *    fetch is reported per attachment rather than guessed at.
 *
 * DSH's prompt content accepts exactly two attachment shapes
 * (`PromptContentPart` in dsh-api-session-controller):
 *
 *  - `{ type: 'image', mediaType, data: <base64> }` — the Host promotes the bytes
 *    to a durable reference itself;
 *  - `{ type: 'file', receiptId }` — the receipt of a preceding `uploadFile`.
 *
 * So images are read and encoded here, and files go through
 * `ctx.fileUploads.upload(agent, { data, name }, signal)`.
 *
 * @module dsh-cindy-host/host-attachments
 */
import { isAttachmentOssRef, parseAttachmentOssRef } from './host-media.js';

/** Longest attachment this Host will read into memory. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * Image extensions DSH's attachment service admits, mapped to its media types.
 *
 * `ImageMediaType` is a closed union (`image/png | image/jpeg | image/webp |
 * image/gif`), so an extension outside it is sent as a file rather than being
 * forced into a media type the service would reject.
 */
export const IMAGE_MEDIA_TYPE_BY_EXT = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
});

/** The extension of a path, lowercase, including the dot. */
export function extensionOf(path) {
  const text = typeof path === 'string' ? path : '';
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  const leaf = cut < 0 ? text : text.slice(cut + 1);
  const dot = leaf.lastIndexOf('.');
  return dot <= 0 ? '' : leaf.slice(dot).toLowerCase();
}

/**
 * Which media type an attachment claims, if it claims an image one.
 *
 * The controller's `mimeType` is taken only when it agrees with a media type DSH
 * accepts; otherwise the extension decides, and a non-image extension means the
 * bytes travel as a file.
 * @param attachment - `{ path, name, mimeType }` from the controller.
 * @returns a DSH `ImageMediaType`, or null for a non-image.
 */
export function imageMediaTypeOf(attachment) {
  const declared = typeof attachment?.mimeType === 'string' ? attachment.mimeType.toLowerCase() : '';
  if (Object.values(IMAGE_MEDIA_TYPE_BY_EXT).includes(declared)) return declared;
  const byExtension = IMAGE_MEDIA_TYPE_BY_EXT[extensionOf(attachment?.path) ];
  return byExtension ?? null;
}

/**
 * Build the materializer over whatever filesystem and upload services exist.
 *
 * Either service may be absent when the profile does not compose it, which is
 * reported per attachment rather than as a failure of the whole message: a prompt
 * with an unresolvable attachment still carries its text, and the controller is
 * told what was dropped.
 *
 * @param options - `{ fileSystem, fileUploads, resolveAttachmentRef, maxBytes }`.
 *   `resolveAttachmentRef` fetches an uploaded attachment's bytes from the account's
 *   media staging area; without it a transit ref is reported as unsupported rather
 *   than passed to a filesystem as if it were a path.
 * @returns `{ materialize }`, which answers `{ parts, dropped, consumed }` —
 *   `consumed` being the staging keys whose bytes were taken, for the caller to
 *   release once the prompt has landed.
 */
export function createAttachmentMaterializer({ fileSystem, fileUploads, resolveAttachmentRef, maxBytes = MAX_ATTACHMENT_BYTES } = {}) {
  /** Read one whole file through the composed filesystem, or say why not. */
  async function readWholeFile(path) {
    if (fileSystem === undefined || fileSystem === null) return { ok: false, reason: 'no-filesystem' };
    let target;
    try {
      target = typeof fileSystem.resolve === 'function' ? await fileSystem.resolve(path) : undefined;
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
    if (target === undefined) return { ok: false, reason: 'unreadable' };
    let info;
    try {
      info = await fileSystem.stat(target);
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
    if (info?.type === 'directory') return { ok: false, reason: 'directory' };
    const size = Number.isFinite(info?.size) ? info.size : null;
    if (size !== null && size > maxBytes) return { ok: false, reason: 'oversize' };
    try {
      const bytes = await fileSystem.readByteRange(target, { offset: 0, length: size === null ? maxBytes : size });
      const buffer = Buffer.from(bytes);
      if (buffer.length > maxBytes) return { ok: false, reason: 'oversize' };
      return { ok: true, buffer };
    } catch {
      // A sandbox denial surfaces here; it is the policy's answer, not a crash.
      return { ok: false, reason: 'unreadable' };
    }
  }

  /**
   * Turn bytes this Host now holds into the prompt part the agent reads.
   *
   * One place for both sources, because the *shape* is DSH's contract and must not
   * depend on where the bytes came from.
   */
  async function partFor({ buffer, name, mediaType, agent, signal }) {
    if (mediaType !== null) return { part: { type: 'image', mediaType, data: buffer.toString('base64'), name } };
    if (typeof fileUploads?.upload !== 'function') return { dropped: 'no-upload-service' };
    try {
      const uploaded = await fileUploads.upload(agent, { data: buffer.toString('base64'), name }, signal);
      const receiptId = typeof uploaded?.receiptId === 'string' ? uploaded.receiptId : '';
      if (receiptId === '') return { dropped: 'no-receipt' };
      return { part: { type: 'file', receiptId } };
    } catch (error) {
      return { dropped: `upload-failed: ${String(error?.message ?? error)}` };
    }
  }

  /**
   * Materialize the controller's attachments for one prompt.
   * @param options - the receiving agent, the controller's attachments, and a signal.
   * @returns the content parts (text excluded), what was dropped and why, and the
   *   staging keys the bytes came out of.
   */
  async function materialize({ agent, attachments: incoming = [], signal } = {}) {
    const parts = [];
    const dropped = [];
    const consumed = [];
    for (const attachment of Array.isArray(incoming) ? incoming : []) {
      const path = typeof attachment?.path === 'string' ? attachment.path : '';
      const name = typeof attachment?.name === 'string' && attachment.name !== ''
        ? attachment.name
        : leafNameOf(path);
      if (path === '') {
        dropped.push({ name, reason: 'no-path' });
        continue;
      }

      let buffer;
      let mediaType;
      if (isAttachmentOssRef(path)) {
        const ref = parseAttachmentOssRef(path);
        if (ref === null) {
          dropped.push({ name, reason: 'malformed-ref' });
          continue;
        }
        if (typeof resolveAttachmentRef !== 'function') {
          dropped.push({ name, reason: 'oss-ref-unsupported' });
          continue;
        }
        const fetched = await resolveAttachmentRef(ref, { signal });
        if (fetched?.ok !== true) {
          dropped.push({ name, reason: String(fetched?.reason ?? 'fetch-failed') });
          continue;
        }
        buffer = fetched.buffer;
        // The reference's own claim about the type is the sender's, and it is the
        // one the phone wrote when it uploaded the bytes; the attachment's `mimeType`
        // is the fallback.
        mediaType = imageMediaTypeOf({ mimeType: fetched.mimeType || ref.mimeType || attachment.mimeType, path: ref.originalName || name });
        const built = await partFor({ buffer, name: fetched.name || name, mediaType, agent, signal });
        if (built.part === undefined) dropped.push({ name, reason: built.dropped });
        else {
          parts.push(built.part);
          consumed.push(ref.ossKey);
        }
        continue;
      }

      const read = await readWholeFile(path);
      if (!read.ok) {
        dropped.push({ name, reason: read.reason });
        continue;
      }
      mediaType = imageMediaTypeOf(attachment);
      const built = await partFor({ buffer: read.buffer, name, mediaType, agent, signal });
      if (built.part === undefined) dropped.push({ name, reason: built.dropped });
      else parts.push(built.part);
    }
    return { parts, dropped, consumed };
  }

  return { materialize };
}

/** The leaf name of a path, for a display name that never carries a directory. */
function leafNameOf(path) {
  const text = typeof path === 'string' ? path.replace(/[\\/]+$/, '') : '';
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  return cut < 0 ? text : text.slice(cut + 1);
}

/**
 * The controller's own attachments, split into what this Host can serve.
 *
 * Two forms are serveable and both are kept: an absolute host path, and an upload
 * transit reference (either scheme), whose bytes this Host fetches with its own
 * account credential. A path that is neither — a relative path, or some other
 * `scheme://` this Host has no way to resolve — is dropped here rather than handed
 * to a filesystem: the controller's claim about where a file lives is not evidence
 * that it lives there.
 *
 * @param message - the controller's `QueuedRemoteMessage` (or send argument).
 * @returns the serveable attachments, in submission order.
 */
export function hostAttachmentsOf(message) {
  if (message === null || typeof message !== 'object') return [];
  const files = Array.isArray(message.files) ? message.files : [];
  const out = [];
  for (const file of files) {
    if (file === null || typeof file !== 'object') continue;
    const path = typeof file.path === 'string' ? file.path.trim() : '';
    if (path === '') continue;
    const name = typeof file.name === 'string' && file.name !== '' ? file.name : leafNameOf(path);
    const mimeType = typeof file.mimeType === 'string' ? file.mimeType : '';
    const category = typeof file.category === 'string' ? file.category : '';
    if (isAttachmentOssRef(path)) {
      // A transit ref, not a path: the materializer fetches it. `name` is kept for
      // the drop report, because a ref carries its own `originalName`.
      out.push({ path, name, mimeType, category });
      continue;
    }
    if (path.includes('://')) continue;
    if (!/^[A-Za-z]:[\\/]/.test(path) && !path.startsWith('/')) continue;
    out.push({ path, name, mimeType, category });
  }
  return out;
}
