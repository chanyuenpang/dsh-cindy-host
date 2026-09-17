/**
 * Prove the thumbnail path with the harness's own image codec, outside a live Host.
 *
 * The codec is resolved exactly the way a running Host resolves it — from the harness
 * entry point — and then used to render a real image, so the numbers below are the ones
 * a `device-link:media:fetch { thumbnail: true }` request would produce.
 *
 * Usage: node tools/probe-thumbnail.mjs [imagePath] [dshEntryPoint]
 */
import { stat } from 'node:fs/promises';
import { resolveThumbnailCodec, renderThumbnailWithSharp, THUMBNAIL_INLINE_MAX_BYTES } from '../src/host-media-fetch.js';

const imagePath = process.argv[2] ?? 'G:\\Projects\\DSH-cindy-host\\kitten.png';
const dshEntry = process.argv[3] ?? 'C:\\Users\\chany\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';

const codec = resolveThumbnailCodec([dshEntry, import.meta.url]);
console.log(`codec via ${dshEntry}: ${codec === null ? 'MISSING' : 'resolved'}`);
if (codec === null) process.exit(1);

const before = await stat(imagePath);
const started = Date.now();
const thumbnail = await renderThumbnailWithSharp(imagePath, codec);
const elapsed = Date.now() - started;
if (thumbnail === null) {
  console.log('render failed');
  process.exit(1);
}
console.log(`input  ${imagePath}  ${before.size} bytes`);
console.log(`output webp ${thumbnail.length} bytes in ${elapsed}ms  inline=${thumbnail.length <= THUMBNAIL_INLINE_MAX_BYTES}`);
console.log(`ossKey='' mimeType='image/webp' size=${thumbnail.length} inlineBase64=${thumbnail.toString('base64').length} chars`);
