import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INLINE_ORIGINAL_MAX_BYTES,
  MEDIA_FETCH_MAX_BYTES,
  THUMBNAIL_INLINE_MAX_BYTES,
  createLocalMediaFetcher,
  isBlockedMediaPath,
  isInsideDirectory,
  isThumbnailableMime,
  mimeForMediaPath,
  parseMediaFetchRequest,
  resetThumbnailCodec,
} from '../src/host-media-fetch.js';

// `device-link:media:fetch` is how a controller sees a picture that lives on this machine
// (an image the agent drew). The reference controlled end resolves the path, uploads to the
// shared staging area and answers with the key; this Host is deliberately stricter about
// *which* paths, because it is a process on somebody's desktop rather than an app with its
// own cache directory.

/** A filesystem double: canonical paths in, contents out. */
function fakeFs(files) {
  return {
    realpath: async (path) => {
      if (!Object.prototype.hasOwnProperty.call(files, path)) throw new Error('ENOENT');
      return files[path].real ?? path;
    },
    stat: async (path) => {
      const entry = files[path];
      if (entry === undefined) throw new Error('ENOENT');
      return { size: entry.bytes.length, isDirectory: () => entry.directory === true };
    },
    readFile: async (path) => {
      const entry = files[path];
      if (entry === undefined) throw new Error('ENOENT');
      return entry.bytes;
    },
  };
}

test('parses the url a chat image carries, and refuses what it cannot honour', () => {
  const good = parseMediaFetchRequest(`xdt-file://open?path=${encodeURIComponent('G:\\work\\cat.png')}&workdir=${encodeURIComponent('G:\\work')}`);
  assert.equal(good.ok, true);
  assert.equal(good.path, 'G:\\work\\cat.png');
  assert.deepEqual(good.roots, ['G:\\work']);
  assert.equal(good.maxBytes, null);

  // The desktop's own constraint name is honoured too, and `maxBytes` is read.
  const constrained = parseMediaFetchRequest(`xdt-file://open?path=${encodeURIComponent('/w/a.png')}&baseDir=${encodeURIComponent('/w')}&maxBytes=1024`);
  assert.deepEqual(constrained, { ok: true, path: '/w/a.png', roots: ['/w'], maxBytes: 1024 });

  // A *missing* root is refused here, unlike the desktop's "old controller" allowance:
  // without one, any absolute path on this machine would be servable.
  assert.deepEqual(parseMediaFetchRequest('xdt-file://open?path=%2Fetc%2Fpasswd'), { ok: false, reason: 'no-root' });
  // Malformed constraints are refused, never silently dropped: a constraint that a typo can
  // remove is not a constraint.
  assert.deepEqual(parseMediaFetchRequest('xdt-file://open?path=%2Fw%2Fa&baseDir=relative'), { ok: false, reason: 'invalid-baseDir' });
  assert.deepEqual(parseMediaFetchRequest('xdt-file://open?path=%2Fw%2Fa&workdir='), { ok: false, reason: 'invalid-workdir' });
  assert.deepEqual(parseMediaFetchRequest('xdt-file://open?path=%2Fw%2Fa&workdir=%2Fw&maxBytes=0'), { ok: false, reason: 'invalid-maxBytes' });
  assert.deepEqual(parseMediaFetchRequest('xdt-file://open?path=%2Fw%2Fa&workdir=%2Fw&maxBytes=1.5'), { ok: false, reason: 'invalid-maxBytes' });
  // Only fully qualified paths.
  assert.deepEqual(parseMediaFetchRequest('xdt-file://open?path=cat.png&workdir=%2Fw'), { ok: false, reason: 'path-not-absolute' });
  assert.deepEqual(parseMediaFetchRequest('xdt-file://open?workdir=%2Fw'), { ok: false, reason: 'missing-path' });
  assert.deepEqual(parseMediaFetchRequest(''), { ok: false, reason: 'missing-url' });
  assert.deepEqual(parseMediaFetchRequest(42), { ok: false, reason: 'missing-url' });
  // The *desktop's* media caches name this Host has none of: said plainly, not guessed at.
  assert.deepEqual(parseMediaFetchRequest('xdt-image://abc'), { ok: false, reason: 'unsupported-scheme' });
  assert.deepEqual(parseMediaFetchRequest('cindy-media://abc'), { ok: false, reason: 'unsupported-scheme' });
});

test('containment and the never-serve list are the security boundary', () => {
  assert.equal(isInsideDirectory('G:\\work\\a.png', 'G:\\work'), true);
  assert.equal(isInsideDirectory('G:\\work', 'G:\\work'), true, 'the directory itself counts as inside');
  assert.equal(isInsideDirectory('G:\\work2\\a.png', 'G:\\work'), false, 'a sibling whose name starts the same is not inside');
  assert.equal(isInsideDirectory('G:\\elsewhere\\a.png', 'G:\\work'), false);

  assert.equal(isBlockedMediaPath('C:\\Users\\me\\.ssh\\id_rsa'), true);
  assert.equal(isBlockedMediaPath('/home/me/.aws/credentials'), true);
  assert.equal(isBlockedMediaPath('G:\\work\\.env'), true);
  assert.equal(isBlockedMediaPath('G:\\work\\.credentials.yaml'), true);
  assert.equal(isBlockedMediaPath('G:\\work\\cat.png'), false);
  assert.equal(isBlockedMediaPath('G:\\work\\notes.md'), false);
  // A directory that merely contains the word is not the directory.
  assert.equal(isBlockedMediaPath('G:\\work\\ssh-notes.md'), false);

  assert.equal(mimeForMediaPath('G:\\work\\CAT.PNG'), 'image/png', 'extension matching is case-insensitive');
  assert.equal(mimeForMediaPath('G:\\work\\clip.mp4'), 'video/mp4');
  assert.equal(mimeForMediaPath('G:\\work\\thing.zzz'), 'application/octet-stream', 'unknown extensions are not guessed at');
});

test('a fetch stages the file and answers the key the controller downloads', async () => {
  const staged = [];
  const fs = fakeFs({ 'G:\\work': { bytes: Buffer.alloc(0), directory: true }, 'G:\\work\\cat.png': { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) } });
  const fetchLocalMedia = createLocalMediaFetcher({
    ...fs,
    uploader: async (bytes, options) => {
      staged.push({ size: bytes.length, ...options });
      return { ok: true, key: 'cindy/device-link/u/cat.png', size: bytes.length };
    },
  });

  const answered = await fetchLocalMedia({ url: `xdt-file://open?path=${encodeURIComponent('G:\\work\\cat.png')}&workdir=${encodeURIComponent('G:\\work')}` });
  assert.deepEqual(answered, { ok: true, result: { ossKey: 'cindy/device-link/u/cat.png', mimeType: 'image/png', size: 4 } });
  assert.deepEqual(staged, [{ size: 4, ext: 'png', contentType: 'image/png' }]);
});

test('a fetch refuses what is outside the named root, over the cap, or unreadable', async () => {
  const files = {
    'G:\\work': { bytes: Buffer.alloc(0), directory: true },
    'G:\\work\\ok.png': { bytes: Buffer.from('x') },
    'G:\\work\\big.png': { bytes: Buffer.alloc(MEDIA_FETCH_MAX_BYTES + 1) },
    'G:\\work\\dir': { bytes: Buffer.alloc(0), directory: true },
    'G:\\work\\.env': { bytes: Buffer.from('SECRET=1') },
    // A symlink inside the workspace that points out of it: realpath is what catches it.
    'G:\\work\\link.png': { bytes: Buffer.from('x'), real: 'G:\\elsewhere\\secret.png' },
    'G:\\elsewhere\\secret.png': { bytes: Buffer.from('x') },
  };
  const uploader = async () => ({ ok: true, key: 'k' });
  const ask = (path, root = 'G:\\work') => ({ url: `xdt-file://open?path=${encodeURIComponent(path)}&workdir=${encodeURIComponent(root)}` });

  const fetcher = createLocalMediaFetcher({ ...fakeFs(files), uploader });
  assert.equal((await fetcher(ask('G:\\work\\missing.png'))).code, 'NOT_FOUND');
  assert.equal((await fetcher(ask('G:\\work\\dir'))).code, 'BAD_REQUEST', 'a directory is not a file');
  assert.equal((await fetcher(ask('G:\\work\\big.png'))).code, 'BAD_REQUEST', 'over the cap');
  assert.equal((await fetcher(ask('G:\\work\\.env'))).code, 'FORBIDDEN', 'the never-serve list wins even inside the root');
  assert.equal((await fetcher(ask('G:\\work\\link.png'))).code, 'FORBIDDEN', 'a symlink out of the workspace is caught by realpath');
  assert.equal((await fetcher(ask('G:\\work\\big.png', 'G:\\somewhere-else'))).code, 'FORBIDDEN', 'a root that cannot resolve authorises nothing');
  assert.equal((await fetcher({ url: 'xdt-file://open?path=%2Fetc%2Fpasswd' })).code, 'BAD_REQUEST', 'no root at all');

  // The requested cap is honoured when it is the smaller of the two.
  const capped = createLocalMediaFetcher({ ...fakeFs({ 'G:\\work': files['G:\\work'], 'G:\\work\\a.png': { bytes: Buffer.alloc(10) } }), uploader });
  const refused = await capped({ url: `xdt-file://open?path=${encodeURIComponent('G:\\work\\a.png')}&workdir=${encodeURIComponent('G:\\work')}&maxBytes=4` });
  assert.equal(refused.code, 'BAD_REQUEST');

  // A profile with no staging client says so instead of failing obscurely.
  const noUploader = createLocalMediaFetcher(fakeFs(files));
  assert.equal((await noUploader(ask('G:\\work\\ok.png'))).code, 'NOT_AVAILABLE');
  // And a staging failure travels back as the reason the controller shows.
  const failing = createLocalMediaFetcher({ ...fakeFs(files), uploader: async () => ({ ok: false, reason: 'staging upload answered 403' }) });
  const failed = await failing(ask('G:\\work\\ok.png'));
  assert.equal(failed.code, 'INTERNAL');
  assert.match(failed.message, /403/);
});

test('a chat thumbnail rides the reply instead of the staging area', async () => {
  // The reference controlled end downscales and answers `{ossKey:'', mimeType, size,
  // inlineBase64}` so the controller skips upload → presign → download entirely; the
  // phone reads exactly that shape (`remoteMedia.ts` requires inlineBase64 + an image
  // mime + a positive size, then renders `data:<mime>;base64,…`).
  const files = {
    'G:\\work': { bytes: Buffer.alloc(0), directory: true },
    'G:\\work\\cat.png': { bytes: Buffer.alloc(4096, 7) },
  };
  const uploads = [];
  const rendered = [];
  const fetcher = createLocalMediaFetcher({
    ...fakeFs(files),
    uploader: async (bytes, options) => { uploads.push({ size: bytes.length, ...options }); return { ok: true, key: 'k' }; },
    renderThumbnail: async (path) => { rendered.push(path); return Buffer.from([1, 2, 3]); },
  });
  const url = `xdt-file://open?path=${encodeURIComponent('G:\\work\\cat.png')}&workdir=${encodeURIComponent('G:\\work')}`;

  const answered = await fetcher({ url, thumbnail: true });
  assert.deepEqual(rendered, ['G:\\work\\cat.png']);
  assert.deepEqual(uploads, [], 'nothing is staged when the bytes fit the reply');
  assert.equal(answered.ok, true);
  assert.equal(answered.result.ossKey, '', 'no object exists, so there is no key to presign');
  assert.equal(answered.result.mimeType, 'image/webp');
  assert.equal(answered.result.size, 3);
  assert.equal(answered.result.inlineBase64, Buffer.from([1, 2, 3]).toString('base64'));

  // Without `thumbnail: true` the original path is untouched.
  const plain = await fetcher({ url });
  assert.equal(plain.result.ossKey, 'k');
  assert.equal(plain.result.mimeType, 'image/png');
  assert.deepEqual(uploads, [{ size: 4096, ext: 'png', contentType: 'image/png' }]);
});

test('a thumbnail that cannot be rendered degrades to inline original, then to a key', async () => {
  // Three layers, in this order: downscale → inline the original → stage it. Each step is
  // only skipped when it cannot answer, and the controller accepts all three shapes.
  const small = Buffer.alloc(64, 1);
  const files = {
    'G:\\work': { bytes: Buffer.alloc(0), directory: true },
    'G:\\work\\cat.png': { bytes: small },
    'G:\\work\\clip.gif': { bytes: small },
    'G:\\work\\photo.png': { bytes: Buffer.alloc(INLINE_ORIGINAL_MAX_BYTES + 1, 1) },
  };
  const uploads = [];
  const fetcher = (renderThumbnail, limits) => createLocalMediaFetcher({
    ...fakeFs(files),
    uploader: async (bytes, options) => { uploads.push({ contentType: options.contentType, size: bytes.length }); return { ok: true, key: 'key-original' }; },
    renderThumbnail,
    ...(limits === undefined ? {} : { thumbnailLimits: limits }),
  });
  const url = (name) => `xdt-file://open?path=${encodeURIComponent(`G:\\work\\${name}`)}&workdir=${encodeURIComponent('G:\\work')}`;

  // No codec on this installation: `renderThumbnailWithSharp` answers null, and a small
  // original still skips the staging round trip.
  const noCodec = await fetcher(async () => null)({ url: url('cat.png'), thumbnail: true });
  assert.equal(noCodec.result.ossKey, '', 'the bytes ride the reply');
  assert.equal(noCodec.result.mimeType, 'image/png', 'an un-downscaled original keeps its own type');
  assert.equal(noCodec.result.size, 64);
  assert.equal(noCodec.result.inlineBase64, small.toString('base64'));
  assert.deepEqual(uploads, [], 'and nothing is staged');

  // A renderer that throws costs the thumbnail, never the fetch.
  const throwing = await fetcher(async () => { throw new Error('codec exploded'); })({ url: url('cat.png'), thumbnail: true });
  assert.equal(throwing.ok, true);
  assert.equal(throwing.result.ossKey, '');
  assert.deepEqual(uploads, []);

  // A gif is not downscaled (a still frame would be a semantic loss), but it is still an
  // image, so the small original travels inline.
  let gifRendered = false;
  const gif = await fetcher(async () => { gifRendered = true; return Buffer.from([1]); })({ url: url('clip.gif'), thumbnail: true });
  assert.equal(gifRendered, false);
  assert.equal(gif.result.ossKey, '');
  assert.equal(gif.result.mimeType, 'image/gif');

  // Above the inline-original ceiling there is no shape left but the key.
  const big = await fetcher(async () => null)({ url: url('photo.png'), thumbnail: true });
  assert.equal(big.result.ossKey, 'key-original');
  assert.equal(big.result.mimeType, 'image/png');
  assert.deepEqual(uploads, [{ contentType: 'image/png', size: INLINE_ORIGINAL_MAX_BYTES + 1 }]);

  // The soft timeout gives up rather than holding the invoke open (and still inlines).
  const slow = await fetcher(() => new Promise((resolve) => setTimeout(() => resolve(Buffer.from([1])), 50)), { timeoutMs: 5 })({ url: url('cat.png'), thumbnail: true });
  assert.equal(slow.result.ossKey, '');
  assert.equal(slow.result.mimeType, 'image/png');

  // A non-image is never inlined: the controller drops an inline payload that is not
  // `image/*`, so answering one would lose the file entirely.
  const audio = createLocalMediaFetcher({
    ...fakeFs({ 'G:\\work': files['G:\\work'], 'G:\\work\\note.txt': { bytes: Buffer.from('hello') } }),
    uploader: async () => ({ ok: true, key: 'key-txt' }),
  });
  const text = await audio({ url: url('note.txt'), thumbnail: true });
  assert.equal(text.result.ossKey, 'key-txt');

  assert.equal(isThumbnailableMime('image/png'), true);
  assert.equal(isThumbnailableMime('image/gif'), false);
  assert.equal(isThumbnailableMime('application/pdf'), false);
  // The codec probe is cached per process; nothing in these tests depends on the outcome.
  resetThumbnailCodec();
});

test('the same file is staged once, until it changes or the controller says otherwise', async () => {
  // Chat media is resolved from the same path repeatedly, and staging it again is a wasted
  // upload plus a fresh object every time. The key carries size and mtime, so a rewritten
  // file is a different entry rather than a stale object.
  let mtimeMs = 1_000;
  const uploads = [];
  const fetchLocalMedia = createLocalMediaFetcher({
    realpath: async (path) => path,
    stat: async () => ({ size: 4, mtimeMs, isDirectory: () => false }),
    readFile: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    uploader: async () => { uploads.push(uploads.length); return { ok: true, key: `key-${uploads.length}` }; },
  });
  const ask = (extra = {}) => ({ url: `xdt-file://open?path=${encodeURIComponent('G:\\work\\cat.png')}&workdir=${encodeURIComponent('G:\\work')}`, ...extra });

  assert.equal((await fetchLocalMedia(ask())).result.ossKey, 'key-1');
  assert.equal((await fetchLocalMedia(ask())).result.ossKey, 'key-1', 'the second read reuses the object');
  assert.equal(uploads.length, 1);

  // `skipCache` is the controller saying the object is gone: stage it again.
  assert.equal((await fetchLocalMedia(ask({ skipCache: true }))).result.ossKey, 'key-2');
  assert.equal(uploads.length, 2);

  // A rewritten file is a different entry, not a stale key.
  mtimeMs = 2_000;
  assert.equal((await fetchLocalMedia(ask())).result.ossKey, 'key-3');
  assert.equal(uploads.length, 3);

  // And an entry that has aged out is re-staged.
  const aging = createLocalMediaFetcher({
    realpath: async (path) => path,
    stat: async () => ({ size: 4, mtimeMs: 5, isDirectory: () => false }),
    readFile: async () => Buffer.from([1, 2, 3, 4]),
    uploader: async () => ({ ok: true, key: `aged-${++uploads.length}` }),
    cacheTtlMs: 0,
  });
  const aged = { url: `xdt-file://open?path=${encodeURIComponent('G:\\work\\old.png')}&workdir=${encodeURIComponent('G:\\work')}` };
  const first = await aging(aged);
  const second = await aging(aged);
  assert.notEqual(first.result.ossKey, second.result.ossKey, 'a zero ttl means no reuse');
});
