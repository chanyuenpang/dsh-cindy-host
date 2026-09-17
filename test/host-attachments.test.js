/**
 * Attachment materialization: which forms this Host can serve, and what it says
 * about the ones it cannot.
 *
 * Both forms are serveable: a controller sends host paths (a file already on this
 * machine) and **upload transit references** to the account's OSS staging area, whose
 * bytes this Host fetches with its own Cindy credential. A reference is never handed
 * to a filesystem as if it were a path, and one that cannot be fetched is reported
 * with the reason the fetch gave rather than vanishing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hostAttachmentsOf,
  imageMediaTypeOf,
  extensionOf,
  createAttachmentMaterializer,
  MAX_ATTACHMENT_BYTES,
} from '../src/host-attachments.js';
import { buildOssRef } from './support/oss-ref.js';

const buildRef = buildOssRef;

test('a host path and an upload reference are both serveable; nothing else is', () => {
  const hostPath = { path: 'G:\\Projects\\DSH-cindy-host\\package.json', name: 'package.json' };
  // The ref the phones actually send: the legacy scheme, whose bytes this Host
  // fetches with its own account credential.
  const uploaded = { path: 'xdt-oss-attach://m/eyJvc3NLZXkiOiJrIn0', name: 'photo.png', category: 'image' };
  const relative = { path: 'src/index.js', name: 'index.js' };
  const otherScheme = { path: 'vscode-remote://host/file.txt', name: 'file.txt' };

  assert.deepEqual(hostAttachmentsOf({ files: [hostPath, uploaded, relative, otherScheme] }).map((file) => file.name), ['package.json', 'photo.png']);
  // A reference under a known scheme but with a malformed payload is still kept:
  // the materializer reports it as `malformed-ref` rather than pretending it was
  // never attached.
  assert.deepEqual(hostAttachmentsOf({ files: [{ path: 'cindy-oss-attach://bucket/key.png' }] }).map((file) => file.path), ['cindy-oss-attach://bucket/key.png']);
  // A POSIX absolute path is a host path too.
  assert.equal(hostAttachmentsOf({ files: [{ path: '/home/me/a.txt' }] })[0].name, 'a.txt');
  // A file with no name takes the path's leaf, never the whole path.
  assert.equal(hostAttachmentsOf({ files: [{ path: 'G:\\a\\b\\c.md' }] })[0].name, 'c.md');
  // Nothing to attach is not an error.
  assert.deepEqual(hostAttachmentsOf({}), []);
  assert.deepEqual(hostAttachmentsOf(null), []);
});

test('an image is recognized by media type or extension, and nothing else', () => {
  assert.equal(imageMediaTypeOf({ path: 'a.png', mimeType: 'image/png' }), 'image/png');
  // A declared type outside DSH's closed union is not accepted as an image.
  assert.equal(imageMediaTypeOf({ path: 'a.bmp', mimeType: 'image/bmp' }), null);
  // The extension decides when the declaration is unhelpful.
  assert.equal(imageMediaTypeOf({ path: 'photo.JPEG', mimeType: 'application/octet-stream' }), 'image/jpeg');
  assert.equal(imageMediaTypeOf({ path: 'archive.zip', mimeType: 'application/zip' }), null);
  assert.equal(extensionOf('G:\\a\\b\\note.md'), '.md');
  assert.equal(extensionOf('no-extension'), '');
  assert.equal(extensionOf('.gitignore'), '');
});

/** A filesystem double over an in-memory file table. */
function fakeFs(files) {
  return {
    resolve: async (path) => (Object.prototype.hasOwnProperty.call(files, path) ? { path } : undefined),
    stat: async (target) => {
      const entry = files[target.path];
      if (entry === undefined) throw new Error('missing');
      return entry.directory === true ? { type: 'directory' } : { type: 'file', size: entry.bytes.length };
    },
    readByteRange: async (target, { length }) => new Uint8Array(files[target.path].bytes.slice(0, length)),
  };
}

test('a host image becomes an image part with its bytes inline', async () => {
  const bytes = Buffer.from('PNGDATA');
  const materializer = createAttachmentMaterializer({
    fileSystem: fakeFs({ 'G:\\a\\shot.png': { bytes } }),
    fileUploads: { upload: async () => { throw new Error('images must not be uploaded'); } },
  });

  const { parts, dropped } = await materializer.materialize({
    agent: { id: 's1' },
    attachments: [{ path: 'G:\\a\\shot.png', name: 'shot.png', mimeType: 'image/png' }],
  });

  assert.deepEqual(dropped, []);
  assert.equal(parts[0].type, 'image');
  assert.equal(parts[0].mediaType, 'image/png');
  assert.equal(parts[0].data, bytes.toString('base64'));
  assert.equal(parts[0].name, 'shot.png');
});

test('a host file becomes a receipt-backed file part', async () => {
  const uploads = [];
  const materializer = createAttachmentMaterializer({
    fileSystem: fakeFs({ 'G:\\a\\spec.pdf': { bytes: Buffer.from('PDF') } }),
    fileUploads: {
      upload: async (agent, request, signal) => {
        uploads.push({ agent, request, signal });
        return { receiptId: 'receipt-1', file: { attachmentId: 'a1', name: request.name, bytes: 3 } };
      },
    },
  });

  const { parts, dropped } = await materializer.materialize({
    agent: { id: 's1' },
    attachments: [{ path: 'G:\\a\\spec.pdf', name: 'spec.pdf' }],
    signal: new AbortController().signal,
  });

  assert.deepEqual(dropped, []);
  assert.deepEqual(parts[0], { type: 'file', receiptId: 'receipt-1' });
  assert.equal(uploads[0].request.data, Buffer.from('PDF').toString('base64'));
  assert.equal(uploads[0].request.name, 'spec.pdf');
  assert.equal(uploads[0].agent.id, 's1');
});

test('an attachment that cannot be served is dropped with its reason, not thrown', async () => {
  const bytes = Buffer.alloc(8);
  const materializer = createAttachmentMaterializer({
    fileSystem: fakeFs({
      'G:\\a\\big.bin': { bytes: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1) },
      'G:\\a\\dir': { bytes, directory: true },
      'G:\\a\\spec.pdf': { bytes: Buffer.from('PDF') },
    }),
    fileUploads: { upload: async () => { throw new Error('storage offline'); } },
    maxBytes: MAX_ATTACHMENT_BYTES,
  });

  const { parts, dropped } = await materializer.materialize({
    agent: { id: 's1' },
    attachments: [
      { path: 'G:\\a\\missing.txt', name: 'missing.txt' },
      { path: 'G:\\a\\big.bin', name: 'big.bin' },
      { path: 'G:\\a\\dir', name: 'dir' },
      { path: 'G:\\a\\spec.pdf', name: 'spec.pdf' },
      { name: 'no-path' },
    ],
  });

  assert.deepEqual(parts, []);
  assert.deepEqual(dropped, [
    { name: 'missing.txt', reason: 'unreadable' },
    { name: 'big.bin', reason: 'oversize' },
    { name: 'dir', reason: 'directory' },
    { name: 'spec.pdf', reason: 'upload-failed: storage offline' },
    { name: 'no-path', reason: 'no-path' },
  ]);
});

test('a profile with no filesystem or upload service reports that per attachment', async () => {
  const noFs = createAttachmentMaterializer({});
  const { parts, dropped } = await noFs.materialize({ agent: {}, attachments: [{ path: 'G:\\a.txt', name: 'a.txt' }] });
  assert.deepEqual(parts, []);
  assert.deepEqual(dropped, [{ name: 'a.txt', reason: 'no-filesystem' }]);

  const noUpload = createAttachmentMaterializer({ fileSystem: fakeFs({ 'G:\\a.txt': { bytes: Buffer.from('x') } }) });
  const second = await noUpload.materialize({ agent: {}, attachments: [{ path: 'G:\\a.txt', name: 'a.txt' }] });
  assert.deepEqual(second.parts, []);
  assert.deepEqual(second.dropped, [{ name: 'a.txt', reason: 'no-upload-service' }]);
});

test('an uploaded image is fetched by its transit ref and becomes an image part', async () => {
  // The whole point of the feature: a phone sends a ref, not bytes, and the agent
  // still receives the picture.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const asked = [];
  const materializer = createAttachmentMaterializer({
    // No filesystem at all: a transit ref must never be handed to one as a path.
    resolveAttachmentRef: async (ref, { signal }) => {
      asked.push({ ref, hasSignal: signal !== undefined });
      return { ok: true, buffer: png, mimeType: 'image/png', name: 'IMG_0001.png' };
    },
  });
  const ref = buildRef({ ossKey: 'media/u/abc', mimeType: 'image/png' });

  const { parts, dropped, consumed } = await materializer.materialize({
    agent: { id: 's1' },
    attachments: [{ path: ref, name: 'photo.png' }],
  });

  assert.deepEqual(dropped, []);
  // `name` comes from the reference's own `originalName`, which is the name the
  // phone had for the file; the attachment's display name is only a fallback.
  assert.deepEqual(parts, [{ type: 'image', mediaType: 'image/png', data: png.toString('base64'), name: 'IMG_0001.png' }]);
  assert.deepEqual(asked.map((entry) => entry.ref.ossKey), ['media/u/abc']);
  // The staging key is reported so the caller can release it once the prompt lands.
  assert.deepEqual(consumed, ['media/u/abc']);
});

test('a transit ref that cannot be fetched is dropped with the reason the fetch gave', async () => {
  const materializer = createAttachmentMaterializer({ resolveAttachmentRef: async () => ({ ok: false, reason: 'sha256-mismatch' }) });
  const { parts, dropped, consumed } = await materializer.materialize({
    agent: {},
    attachments: [{ path: buildRef({ ossKey: 'k', sha256: 'a'.repeat(64), size: 4 }), name: 'photo.png' }],
  });
  assert.deepEqual(parts, []);
  assert.deepEqual(dropped, [{ name: 'photo.png', reason: 'sha256-mismatch' }]);
  assert.deepEqual(consumed, [], 'a failed fetch consumes nothing');

  // A malformed ref under a known scheme is reported as such, never as a path.
  const malformed = createAttachmentMaterializer({});
  const report = await malformed.materialize({ agent: {}, attachments: [{ path: 'cindy-oss-attach://m/!!!notbase64!!!', name: 'broken.png' }] });
  assert.deepEqual(report.dropped, [{ name: 'broken.png', reason: 'malformed-ref' }]);

  // No resolver (a profile without the media seam) says so instead of reading a URL
  // through the filesystem.
  const noResolver = createAttachmentMaterializer({});
  const unsupported = await noResolver.materialize({ agent: {}, attachments: [{ path: buildRef({ ossKey: 'k' }), name: 'photo.png' }] });
  assert.deepEqual(unsupported.dropped, [{ name: 'photo.png', reason: 'oss-ref-unsupported' }]);
});
