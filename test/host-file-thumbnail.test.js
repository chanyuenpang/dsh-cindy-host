import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createThumbnailRenderer, createFileThumbnail, IMAGE_INPUT_PIXELS, IMAGE_INPUT_BYTES, GRID_THUMBNAIL_LIMITS } from '../src/host-file-thumbnail.js';
import { createFileBrowser } from '../src/host-file-browser.js';

function codecWith(work, seen = {}) {
  return () => (bytes, options) => {
    seen.bytes = bytes; seen.options = options;
    const pipeline = { rotate() { return this; }, resize(o) { seen.resize = o; return this; }, webp(o) { seen.webp = o; return this; }, toBuffer: work };
    return pipeline;
  };
}
const output = () => ({ data: Buffer.from('webp'), info: { width: 256, height: 144 } });

test('grid thumbnails use bounded codec options and the Cindy result shape for PNG and JPG', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-grid-thumb-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['a.png', 'b.JPG']) {
    const seen = {};
    const source = Buffer.from(name);
    await writeFile(join(root, name), source);
    const thumbnail = createFileThumbnail({ render: createThumbnailRenderer({ codec: codecWith(output, seen) }) });
    const browser = createFileBrowser({ fileSystem: {}, thumbnail });
    const result = await browser({ op: 'thumbnail', workdir: root, relPath: name });
    assert.deepEqual(result, { ok: true, dataBase64: Buffer.from('webp').toString('base64'), mimeType: 'image/webp', width: 256, height: 144 });
    assert.deepEqual(seen.bytes, source);
    assert.equal(seen.options.limitInputPixels, IMAGE_INPUT_PIXELS);
    assert.equal(seen.resize.width, 256);
    assert.equal(seen.webp.quality, 70);
  }
});

test('decoder unavailable, corrupt, oversized and invalid output fail explicitly', async () => {
  const input = Buffer.from('image');
  assert.equal((await createThumbnailRenderer({ codec: () => null })(input)).code, 'THUMB_UNSUPPORTED');
  assert.equal((await createThumbnailRenderer({ codec: codecWith(() => { throw Error('bad image'); }) })(input)).code, 'THUMB_FAILED');
  assert.equal((await createThumbnailRenderer({ codec: codecWith(() => ({ ...output(), data: Buffer.alloc(GRID_THUMBNAIL_LIMITS.outputBytes + 1) })) })(input, GRID_THUMBNAIL_LIMITS)).code, 'THUMB_TOO_LARGE');
  assert.equal((await createThumbnailRenderer({ codec: codecWith(() => ({ ...output(), info: { width: 99999, height: 1 } })) })(input)).code, 'THUMB_FAILED');
  assert.equal((await createThumbnailRenderer()(Buffer.alloc(IMAGE_INPUT_BYTES + 1))).code, 'THUMB_TOO_LARGE');
});

test('timeout keeps the native concurrency slot occupied until actual settlement', async () => {
  let finish;
  const render = createThumbnailRenderer({ timeoutMs: 5, concurrency: 1, codec: codecWith(() => new Promise(resolve => { finish = resolve; })) });
  assert.match((await render(Buffer.from('x'))).message, /timeout/);
  assert.match((await render(Buffer.from('x'))).message, /busy/);
  finish(output());
  await new Promise(resolve => setImmediate(resolve));
  const next = render(Buffer.from('x'));
  await new Promise(resolve => setImmediate(resolve));
  finish(output());
  assert.equal((await next).ok, true);
});

test('thumbnail authorization rejects traversal, absolute paths, secrets and directories before decoding', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-grid-security-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.ssh'));
  await writeFile(join(root, '.ssh', 'secret.png'), 'secret');
  let decoded = 0;
  const thumbnail = createFileThumbnail({ render: async () => { decoded++; return output(); } });
  for (const relPath of ['../outside.png', join(root, 'a.png'), '.ssh/secret.png', '.ssh', 'missing.png']) {
    assert.equal((await thumbnail({ workdir: root, relPath })).ok, false);
  }
  const outside = await mkdtemp(join(tmpdir(), 'dsh-grid-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'image.png'), 'outside');
  await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await thumbnail({ workdir: root, relPath: 'escape/image.png' })).ok, false);
  assert.equal(decoded, 0);
});

test('oversized authorized input is rejected without reading; changed files do not reach the codec', async () => {
  let reads = 0;
  const resolveFile = async () => ({ ok: true, real: '/work/a.png', info: { size: IMAGE_INPUT_BYTES + 1 } });
  assert.equal((await createFileThumbnail({ resolveFile, readBytes: async () => { reads++; } })({ workdir: process.cwd(), relPath: 'a.png' })).code, 'THUMB_TOO_LARGE');
  const changed = createFileThumbnail({ resolveFile: async () => ({ ok: true, real: '/work/a.png', info: { size: 2 } }), readBytes: async () => { throw Error('changed'); }, render: () => assert.fail('must not decode') });
  assert.equal((await changed({ workdir: process.cwd(), relPath: 'a.png' })).code, 'THUMB_FAILED');
  assert.equal(reads, 0);
});
