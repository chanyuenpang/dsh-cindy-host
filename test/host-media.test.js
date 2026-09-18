/**
 * The media staging client: parsing the reference, and fetching the bytes behind it.
 *
 * The contract these tests pin is Cindy's own
 * (`packages/device-link/src/attachmentOssRef.ts` and
 * `apps/desktop/src/main/device-link/mediaTransfer.ts`): two schemes, optional
 * size/sha256 claimed by the sender, `presign-get` for the URL, and a release call
 * for the staging object afterwards.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  ATTACH_OSS_SCHEMES,
  isAttachmentOssRef,
  parseAttachmentOssRef,
  mediaApiBaseUrl,
  createMediaRefResolver,
  createMediaReleaser,
  createMediaUploader,
  stageableStaging,
} from '../src/host-media.js';
import { buildOssRef } from './support/oss-ref.js';

/** A `fetch` double: records every call and answers from a scripted table. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers, body: init.body });
    const route = routes[url];
    if (route === undefined) return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    return route(calls.length);
  };
  impl.calls = calls;
  return impl;
}

/** An OSS GET answer carrying bytes. */
function bytesResponse(buffer, { contentLength } = {}) {
  const length = contentLength ?? String(buffer.length);
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === 'content-length' ? length : null) },
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}

const BASE = 'https://device-link.cindy.com.cn/api/device-link';

test('a transit reference parses under both schemes, and claims are all-or-nothing', () => {
  assert.deepEqual(ATTACH_OSS_SCHEMES, ['cindy-oss-attach', 'xdt-oss-attach']);
  const full = { ossKey: 'media/u/k.png', mimeType: 'image/png', originalName: 'IMG.png', size: 4, sha256: 'a'.repeat(64) };

  // The legacy scheme is what the phones send today; the current one must keep
  // working forever, and both must parse to the same thing.
  for (const scheme of ATTACH_OSS_SCHEMES) {
    const ref = buildOssRef(full, { scheme });
    assert.equal(isAttachmentOssRef(ref), true);
    assert.deepEqual(parseAttachmentOssRef(ref), full);
  }

  // A reference without integrity metadata is a valid old-sender reference.
  const old = buildOssRef({ ossKey: 'k' });
  assert.deepEqual(parseAttachmentOssRef(old), { ossKey: 'k' });
  // Half a claim is no claim.
  assert.equal(parseAttachmentOssRef(buildOssRef({ ossKey: 'k', size: 4 })), null);
  assert.equal(parseAttachmentOssRef(buildOssRef({ ossKey: 'k', sha256: 'a'.repeat(64) })), null);
  assert.equal(parseAttachmentOssRef(buildOssRef({ ossKey: 'k', size: 0, sha256: 'a'.repeat(64) })), null);
  assert.equal(parseAttachmentOssRef(buildOssRef({ ossKey: '', size: 4, sha256: 'a'.repeat(64) })), null);
  assert.equal(parseAttachmentOssRef(buildOssRef({ ossKey: 'k', size: 4, sha256: 'nope' })), null);

  // Recognition is broader than parsing, exactly like the client's: anything under
  // the scheme is accounted for, and a malformed one is reported rather than
  // mistaken for a path.
  assert.equal(isAttachmentOssRef('cindy-oss-attach://bucket/key.png'), true);
  assert.equal(parseAttachmentOssRef('cindy-oss-attach://bucket/key.png'), null, 'no /m/ segment to parse');
  assert.equal(parseAttachmentOssRef('cindy-oss-attach://m/!!!not-base64!!!'), null);
  assert.equal(isAttachmentOssRef('xdt-image://s/a.png'), false);
  assert.equal(isAttachmentOssRef('/abs/path.png'), false);
  assert.equal(isAttachmentOssRef(42), false);
  assert.equal(parseAttachmentOssRef(null), null);
});

test('the media base is derived from the relay URL the Host is actually connected to', () => {
  assert.equal(mediaApiBaseUrl('wss://device-link.cindy.com.cn/api/device-link/ws'), BASE);
  assert.equal(mediaApiBaseUrl('ws://127.0.0.1:3335/api/device-link/ws'), 'http://127.0.0.1:3335/api/device-link');
});

test('an uploaded attachment is fetched with the account session and verified', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]);
  const sha256 = createHash('sha256').update(png).digest('hex');
  const fetchImpl = fakeFetch({
    [`${BASE}/media/presign-get`]: () => ({
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => ({ getUrl: 'https://oss.example/signed?x=1', expiresAt: '2026-09-17T06:00:00.000Z' }),
    }),
    'https://oss.example/signed?x=1': () => bytesResponse(png),
  });
  const resolve = createMediaRefResolver({ apiBaseUrl: BASE, getSession: () => ({ accessToken: 'tok-1' }), fetchImpl });

  const ref = parseAttachmentOssRef(buildOssRef({ ossKey: 'media/u/k.png', mimeType: 'image/png', originalName: 'IMG.png', size: png.length, sha256 }));
  const fetched = await resolve(ref, {});

  assert.equal(fetched.ok, true);
  assert.deepEqual(fetched.buffer, png);
  assert.equal(fetched.mimeType, 'image/png');
  assert.equal(fetched.name, 'IMG.png');
  // The presign call is what the reference implementation makes: POST the key, with
  // the account bearer, and the OSS GET carries no Host credential of its own.
  assert.deepEqual(fetchImpl.calls[0], {
    url: `${BASE}/media/presign-get`,
    method: 'POST',
    headers: { Authorization: 'Bearer tok-1', 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ key: 'media/u/k.png' }),
  });
  assert.deepEqual(fetchImpl.calls[1], { url: 'https://oss.example/signed?x=1', method: 'GET', headers: undefined, body: undefined });
});

test('verification failures are named, and nothing is downloaded that cannot be served', async () => {
  const png = Buffer.from([1, 2, 3, 4]);
  const routes = (sha256) => fakeFetch({
    [`${BASE}/media/presign-get`]: () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ getUrl: 'https://oss.example/s' }) }),
    'https://oss.example/s': () => bytesResponse(png),
  });
  const session = () => ({ accessToken: 'tok-1' });

  // A declared size that disagrees with the bytes means the object is not the one
  // the sender described.
  const sizeMismatch = createMediaRefResolver({ apiBaseUrl: BASE, getSession: session, fetchImpl: routes() });
  assert.deepEqual(await sizeMismatch(parseAttachmentOssRef(buildOssRef({ ossKey: 'k', size: 99, sha256: 'a'.repeat(64) })), {}), { ok: false, reason: 'size-mismatch' });

  const shaMismatch = createMediaRefResolver({ apiBaseUrl: BASE, getSession: session, fetchImpl: routes() });
  assert.deepEqual(await shaMismatch(parseAttachmentOssRef(buildOssRef({ ossKey: 'k', size: png.length, sha256: 'b'.repeat(64) })), {}), { ok: false, reason: 'sha256-mismatch' });

  // A declared oversize is refused before any request is made.
  const declared = fakeFetch({});
  const oversize = createMediaRefResolver({ apiBaseUrl: BASE, getSession: session, fetchImpl: declared, maxBytes: 2 });
  assert.deepEqual(await oversize(parseAttachmentOssRef(buildOssRef({ ossKey: 'k', size: 3, sha256: 'a'.repeat(64) })), {}), { ok: false, reason: 'oversize' });
  assert.deepEqual(declared.calls, [], 'nothing is fetched for an attachment already known to be too large');

  // An object store that states a length is trusted before the bytes are read.
  const stated = fakeFetch({
    [`${BASE}/media/presign-get`]: () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ getUrl: 'https://oss.example/s' }) }),
    'https://oss.example/s': () => bytesResponse(png, { contentLength: '4096' }),
  });
  const byHeader = createMediaRefResolver({ apiBaseUrl: BASE, getSession: session, fetchImpl: stated, maxBytes: 16 });
  assert.deepEqual(await byHeader(parseAttachmentOssRef(buildOssRef({ ossKey: 'k' })), {}), { ok: false, reason: 'oversize' });

  // A failed presign or a failed GET is one bounded reason, not a crash.
  const presignDown = createMediaRefResolver({ apiBaseUrl: BASE, getSession: session, fetchImpl: fakeFetch({}) });
  const failed = await presignDown(parseAttachmentOssRef(buildOssRef({ ossKey: 'k' })), {});
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /^media-request-failed: presign-get answered 404$/);
});

test('no account session means no media, and the ref is not attempted', async () => {
  const fetchImpl = fakeFetch({});
  const resolve = createMediaRefResolver({ apiBaseUrl: BASE, getSession: () => null, fetchImpl });
  const ref = parseAttachmentOssRef(buildOssRef({ ossKey: 'k' }));
  assert.deepEqual(await resolve(ref, {}), { ok: false, reason: 'no-credential' });
  const withoutToken = createMediaRefResolver({ apiBaseUrl: BASE, getSession: () => ({ accessToken: '' }), fetchImpl });
  assert.deepEqual(await withoutToken(ref, {}), { ok: false, reason: 'no-credential' });
  assert.deepEqual(fetchImpl.calls, []);
});

test('an app package is staged as opaque bytes, because the object store refuses the alternative', () => {
  // Measured against the live bucket (`tools/probe-oss-ext.mjs`): either the `.apk`/`.ipa`
  // suffix or the `application/vnd.android.package-archive` Content-Type makes the object
  // undownloadable by anyone, while the PUT itself succeeds. An exported `.apk` was
  // therefore unreachable while every host-side check passed.
  assert.deepEqual(stageableStaging('apk', 'application/vnd.android.package-archive'), { ext: 'bin', contentType: 'application/octet-stream' });
  assert.deepEqual(stageableStaging('.apk', 'application/vnd.android.package-archive'), { ext: 'bin', contentType: 'application/octet-stream' });
  assert.deepEqual(stageableStaging('APK', ''), { ext: 'bin', contentType: 'application/octet-stream' });
  assert.deepEqual(stageableStaging('ipa', 'application/octet-stream'), { ext: 'bin', contentType: 'application/octet-stream' });
  // The mime alone is enough to poison an otherwise fine key.
  assert.deepEqual(stageableStaging('zip', 'application/vnd.android.package-archive'), { ext: 'zip', contentType: 'application/octet-stream' });
  // Everything else keeps what it was given, with a mime always declared.
  assert.deepEqual(stageableStaging('png', 'image/png'), { ext: 'png', contentType: 'image/png' });
  assert.deepEqual(stageableStaging('.PNG', 'image/png'), { ext: 'png', contentType: 'image/png' });
  assert.deepEqual(stageableStaging('', ''), { ext: '', contentType: 'application/octet-stream' });
  assert.deepEqual(stageableStaging(undefined, undefined), { ext: '', contentType: 'application/octet-stream' });
});

test('the uploader declares the staged extension and mime on both hops', async () => {
  const fetchImpl = fakeFetch({
    [`${BASE}/media/presign-put`]: () => ({
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => ({ putUrl: 'https://oss.example/put', key: 'media/u/k.bin' }),
      text: async () => '',
    }),
    'https://oss.example/put': () => ({ ok: true, status: 200, headers: { get: () => null } }),
  });
  const upload = createMediaUploader({ apiBaseUrl: BASE, getSession: () => ({ accessToken: 'tok-1' }), fetchImpl });
  const staged = await upload(Buffer.from('apk bytes'), { ext: 'apk', contentType: 'application/vnd.android.package-archive' });

  assert.deepEqual(staged, { ok: true, key: 'media/u/k.bin', size: 9 });
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].body), { size: 9, ext: 'bin', contentType: 'application/octet-stream' });
  // The PUT header is what the store keeps, so it carries the same neutralization.
  assert.equal(fetchImpl.calls[1].headers['Content-Type'], 'application/octet-stream');
  assert.equal(fetchImpl.calls[1].headers['x-oss-object-acl'], 'private');
  // The bytes are untouched: only the label changes.
  assert.deepEqual(fetchImpl.calls[1].body, Buffer.from('apk bytes'));
});

test('a refused credential is refreshed once and the call retried with the new session', async () => {
  // Measured 2026-09-18: after the stored session had been refreshed, the in-app 导出 path still
  // answered `presign-put answered 401` while the same stored token worked from a fresh process —
  // this runtime reads the session once at startup. So a 401 refreshes the session and retries
  // exactly once; a refusal that survives the refresh is reported as-is.
  let credentials = 'stale-token';
  let refreshes = 0;
  const recording = async (url, init = {}) => {
    if (url.endsWith('/media/presign-put')) {
      const auth = String(init.headers?.Authorization ?? '');
      if (auth === 'Bearer stale-token') {
        return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}), text: async () => '{"message":"unauthorized"}' };
      }
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ putUrl: 'https://oss.example/put', key: 'media/u/k.bin' }),
        text: async () => '',
      };
    }
    return { ok: true, status: 200, headers: { get: () => null } };
  };
  const upload = createMediaUploader({
    apiBaseUrl: BASE,
    getSession: () => ({ accessToken: credentials }),
    fetchImpl: recording,
    onUnauthorized: async () => { refreshes += 1; credentials = 'fresh-token'; return true; },
  });
  assert.deepEqual(await upload(Buffer.from('bytes'), { ext: 'bin', contentType: 'application/octet-stream' }), { ok: true, key: 'media/u/k.bin', size: 5 });
  assert.equal(refreshes, 1, 'exactly one refresh for one 401');

  // Two attempts at most: a second 401 after a successful refresh is reported, not retried again.
  let refreshes2 = 0;
  const never = createMediaUploader({
    apiBaseUrl: BASE,
    getSession: () => ({ accessToken: 'stale-token' }),
    fetchImpl: async () => ({ ok: false, status: 401, headers: { get: () => null }, json: async () => ({}), text: async () => '' }),
    onUnauthorized: async () => { refreshes2 += 1; return true; },
  });
  assert.deepEqual(await never(Buffer.from('x'), { ext: 'bin' }), { ok: false, reason: 'presign-put answered 401' });
  assert.equal(refreshes2, 1, 'one refresh total: the second 401 is reported, not refreshed again');

  // A refresh that declines (cooldown, or no credential left) also ends the call after one retry.
  let refreshes3 = 0;
  const declined = createMediaUploader({
    apiBaseUrl: BASE,
    getSession: () => ({ accessToken: 'stale-token' }),
    fetchImpl: async () => ({ ok: false, status: 401, headers: { get: () => null }, json: async () => ({}), text: async () => '' }),
    onUnauthorized: async () => { refreshes3 += 1; return false; },
  });
  assert.deepEqual(await declined(Buffer.from('x'), { ext: 'bin' }), { ok: false, reason: 'presign-put answered 401' });
  assert.equal(refreshes3, 1, 'a declined refresh is not attempted again');
});

test('the download half retries once after a 401 presign, with the refreshed session', async () => {
  const png = Buffer.from([9, 9, 9]);
  let credentials = 'stale-token';
  let refreshes = 0;
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/media/presign-get')) {
      const auth = String(init.headers?.Authorization ?? '');
      if (auth === 'Bearer stale-token') {
        return { ok: false, status: 401, headers: { get: () => null }, text: async () => '{"message":"unauthorized"}' };
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ getUrl: 'https://oss.example/signed' }) };
    }
    return {
      ok: true, status: 200,
      headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(png.length) : null) },
      arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    };
  };
  const resolve = createMediaRefResolver({
    apiBaseUrl: BASE,
    getSession: () => ({ accessToken: credentials }),
    fetchImpl,
    onUnauthorized: async () => { refreshes += 1; credentials = 'fresh-token'; return true; },
  });
  const fetched = await resolve(parseAttachmentOssRef(buildOssRef({ ossKey: 'media/u/k.png' })), {});
  assert.equal(fetched.ok, true);
  assert.deepEqual(fetched.buffer, png);
  assert.equal(refreshes, 1);
});

test('a refused download carries the object store code that explains it', async () => {
  const fetchImpl = fakeFetch({
    [`${BASE}/media/presign-get`]: () => ({
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => ({ getUrl: 'https://oss.example/signed' }),
    }),
    'https://oss.example/signed': () => ({
      ok: false, status: 400,
      headers: { get: () => null },
      text: async () => '<?xml version="1.0" encoding="UTF-8"?><Error><Code>ApkDownloadForbidden</Code><Message>The APK file is not allowed…</Message></Error>',
    }),
  });
  const resolve = createMediaRefResolver({ apiBaseUrl: BASE, getSession: () => ({ accessToken: 'tok-1' }), fetchImpl });
  const refused = await resolve(parseAttachmentOssRef(buildOssRef({ ossKey: 'media/u/k.apk' })), {});
  assert.deepEqual(refused, { ok: false, reason: 'download-failed: ApkDownloadForbidden' });

  // A refusal with no readable body is still a named failure, just less detailed.
  const opaque = createMediaRefResolver({
    apiBaseUrl: BASE,
    getSession: () => ({ accessToken: 'tok-1' }),
    fetchImpl: fakeFetch({
      [`${BASE}/media/presign-get`]: () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ getUrl: 'https://oss.example/signed' }) }),
      'https://oss.example/signed': () => ({ ok: false, status: 403, headers: { get: () => null } }),
    }),
  });
  assert.deepEqual(await opaque(parseAttachmentOssRef(buildOssRef({ ossKey: 'media/u/k.png' })), {}), { ok: false, reason: 'download-failed' });
});

test('the staging object is released with the same credential, best-effort', async () => {
  const fetchImpl = fakeFetch({
    [`${BASE}/media`]: () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ deleted: true }) }),
  });
  const remove = createMediaReleaser({ apiBaseUrl: BASE, getSession: () => ({ accessToken: 'tok-1' }), fetchImpl });
  assert.equal(await remove('media/u/k.png'), true);
  assert.deepEqual(fetchImpl.calls[0], {
    url: `${BASE}/media`,
    method: 'DELETE',
    headers: { Authorization: 'Bearer tok-1', 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ key: 'media/u/k.png' }),
  });

  // A release that cannot happen is a `false`, never a throw: the prompt it belongs
  // to has already landed.
  const broken = createMediaReleaser({ apiBaseUrl: BASE, getSession: () => ({ accessToken: 't' }), fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(await broken('media/u/k.png'), false);
  const anonymous = createMediaReleaser({ apiBaseUrl: BASE, getSession: () => null, fetchImpl });
  assert.equal(await anonymous('media/u/k.png'), false);
  assert.equal(await remove(''), false);
});
