import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChannelRouter } from '../src/cindy-channels.js';
import { FILE_INLINE_MAX_BYTES } from '../src/file-peer-protocol.js';
import { createLocalMediaFetcher, parseMediaFetchRequest } from '../src/host-media-fetch.js';

const TYPES = [
  ['PNG', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'], ['gif', 'image/gif'], ['svg', 'image/svg+xml'],
  ['mp4', 'video/mp4'], ['webm', 'video/webm'],
  ['mp3', 'audio/mpeg'], ['wav', 'audio/wav'],
  ['pdf', 'application/pdf'], ['txt', 'text/plain'],
  ['docx', 'application/octet-stream'], ['xlsx', 'application/octet-stream'],
  ['unknown', 'application/octet-stream'],
];

function mediaRequest(input) {
  return { v: 1, kind: 'invoke', id: 'native-media', src: 'phone-1',
    payload: { channel: 'device-link:media:fetch', args: [input] } };
}

for (const [platform, root] of [['posix', '/home/user/project'], ['windows', 'C:/project']]) {
  test(`native rootless media contract across types and entry points: ${platform}`, async (t) => {
    for (const [ext, mimeType] of TYPES) await t.test(ext, async () => {
      const path = `${root}/资料 (1).${ext}`;
      const bytes = Buffer.alloc(FILE_INLINE_MAX_BYTES + 1, 42);
      let reads = 0;
      const fetcher = createLocalMediaFetcher({
        realpath: async (value) => value,
        stat: async () => ({ size: bytes.length, isFile: () => true }),
        readFile: async () => { reads++; return bytes; },
        open: async () => assert.fail('large prepareOnly must not open the file'),
        renderThumbnail: async () => null,
        uploader: async (uploaded, options) => {
          assert.deepEqual(uploaded, bytes, 'original bytes are preserved');
          assert.equal(options.contentType, mimeType);
          return { ok: true, key: `test/${ext}`, size: uploaded.length };
        },
      });
      const router = createChannelRouter({
        listSessions: async () => [], subscribers: new Set(),
        resolveCapabilities: () => ({ fetchLocalMedia: fetcher }),
      });
      for (const scheme of ext === 'mp3' || ext === 'wav' ? ['xdt-file', 'xdt-audio'] : ['xdt-file']) {
        const url = `${scheme}://open?path=${encodeURIComponent(path)}&v=123`;
        assert.deepEqual(parseMediaFetchRequest(url), { ok: true, path, roots: [], maxBytes: null });
        for (const options of [{}, { thumbnail: true }, { prepareOnly: true }]) {
          const beforeReads = reads;
          const reply = (await router(mediaRequest({ url, ...options }))).payload;
          assert.equal(reply.ok, true, JSON.stringify(reply));
          assert.equal(reply.result.mimeType, mimeType);
          assert.equal(reply.result.size, bytes.length);
          if (options.prepareOnly) {
            assert.equal(reply.result.transferRequired, true);
            assert.equal(reads, beforeReads, 'prepareOnly does not read file contents');
          } else if (options.thumbnail && mimeType.startsWith('image/')) {
            assert.equal(reply.result.inlineBase64, bytes.toString('base64'));
          } else {
            assert.equal(reply.result.ossKey, `test/${ext}`);
          }
        }
      }
    });
  });
}

test('rootless prepareOnly inlines each file type through the real filesystem and channel', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'host-native-media-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from('native file bytes');
  const fetcher = createLocalMediaFetcher();
  const router = createChannelRouter({
    listSessions: async () => [], subscribers: new Set(),
    resolveCapabilities: () => ({ fetchLocalMedia: fetcher }),
  });
  for (const [ext, mimeType] of TYPES) {
    const path = join(dir, `资料 (1).${ext}`);
    await writeFile(path, bytes);
    const url = `xdt-file://open?path=${encodeURIComponent(path)}`;
    const reply = (await router(mediaRequest({ url, prepareOnly: true }))).payload;
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.deepEqual(reply.result, { ossKey: '', mimeType, size: bytes.length, inlineBase64: bytes.toString('base64') });
  }
});
