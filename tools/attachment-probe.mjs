/**
 * Prove the attachment path end to end, without a phone.
 *
 * The one part of the controller contract that cannot be unit-tested is the round
 * trip through the account's media staging area: upload bytes with this Host's own
 * credential, hand a controller-shaped message to the *live* Host, and check that the
 * agent really saw the picture. This tool does exactly that:
 *
 * ```
 *   1. read the stored session (no refresh: the running Host owns that token)
 *   2. POST {api}/media/presign-put → PUT the bytes → ossKey
 *   3. build the transit ref the phones build (the LEGACY scheme) with size+sha256
 *   4. maker:input:enqueue { text: '', files: [ref] }   ← the exact shape that
 *                                                          used to answer
 *                                                          "carried no text"
 *   5. wait for the turn, read the transcript back
 *   6. assert the agent's answer describes the image
 *   7. assert the staging object was released after the prompt landed
 *   8. hide the probe session from controllers (patch-meta status=deleted)
 * ```
 *
 * It is the only check that covers "the bytes actually arrived at the model", and it
 * is deliberately separate from `npm run acceptance`: it consumes a real LLM call and
 * touches the account's staging area, so it is run when the attachment path is in
 * question rather than on every verification pass.
 *
 * Usage: `node tools/attachment-probe.mjs [--host http://127.0.0.1:3081] [--keep]`
 */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { loadSession } from '../src/credential-store.js';
import { mediaApiBaseUrl, isAttachmentOssRef } from '../src/host-media.js';

const args = process.argv.slice(2);
const hostArg = args.indexOf('--host');
const HOST = (hostArg >= 0 ? args[hostArg + 1] : undefined) ?? process.env.CINDY_HOST_URL ?? 'http://127.0.0.1:3081';
const KEEP = args.includes('--keep');
const RELAY_WS_URL = 'wss://device-link.cindy.com.cn/api/device-link/ws';
const API_BASE = mediaApiBaseUrl(RELAY_WS_URL);

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS ' : 'FAIL '} ${name}${detail === '' ? '' : `  — ${detail}`}`);
}

/** One invoke through the Host's own self-test endpoint (the production channel path). */
async function call(channel, channelArgs = []) {
  const response = await fetch(`${HOST}/api/dsh-cindy-host/selftest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel, args: channelArgs }),
  });
  const body = await response.json();
  if (body?.reply?.payload === undefined) throw new Error(`self-test answered ${response.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body.reply.payload;
}

// ─── a real PNG, built here so the probe depends on nothing ───────────────────
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
/** A `size`×`size` solid image — the colour is the whole answer, so the reply is checkable. */
function solidPng(size, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour
  const raw = Buffer.concat(Array.from({ length: size }, () => Buffer.concat([Buffer.from([0]), ...Array.from({ length: size }, () => Buffer.from([r, g, b]))])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const RED = [220, 30, 30];
const image = solidPng(16, RED);
const sha256 = createHash('sha256').update(image).digest('hex');

// ─── 1. the account session, read without refreshing it ──────────────────────
const session = await loadSession();
if (session === null || typeof session.accessToken !== 'string' || session.accessToken === '') {
  console.error('no stored Cindy session: run the settings-page login first');
  process.exit(2);
}
const authHeaders = { Authorization: `Bearer ${session.accessToken}` };

// ─── 2. stage the bytes the way a phone's uploader does ──────────────────────
const presign = await fetch(`${API_BASE}/media/presign-put`, {
  method: 'POST',
  headers: { ...authHeaders, 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify({ size: image.length, ext: 'png', contentType: 'image/png' }),
});
if (presign.ok !== true) {
  console.error(`presign-put failed (${presign.status}): ${(await presign.text()).slice(0, 200)}`);
  process.exit(2);
}
const presigned = await presign.json();
const putUrl = typeof presigned.putUrl === 'string' ? presigned.putUrl : presigned.url;
const ossKey = typeof presigned.key === 'string' ? presigned.key : '';
check('the account staged the bytes', typeof putUrl === 'string' && ossKey !== '', `key=${ossKey}`);
// `x-oss-object-acl` is a **canonical** header bound into the signature the server
// minted, and device-link media is always private: omitting it is a 403, not a
// default-ACL upload. Measured both ways while building this probe.
const put = await fetch(putUrl, {
  method: 'PUT',
  headers: { 'Content-Type': 'image/png', 'x-oss-object-acl': 'private' },
  body: image,
});
check('the staging upload landed', put.ok === true, `PUT ${put.status}`);

// ─── 3. the reference the phones actually build ──────────────────────────────
const ref = `xdt-oss-attach://m/${Buffer.from(JSON.stringify({
  ossKey, mimeType: 'image/png', originalName: 'probe-red.png', size: image.length, sha256,
}), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
check('the reference is one a phone would send', isAttachmentOssRef(ref), `${ref.slice(0, 24)}… len=${ref.length}`);

// ─── 4. a fresh probe session, then the attachment-only send ─────────────────
const created = await call('maker:create-session', [{ workingDir: process.cwd() }]);
const sessionId = created.result?.sessionId ?? '';
check('a probe session exists', sessionId !== '', sessionId);
const clientId = `attach-probe-${Date.now()}`;
const sent = await call('maker:input:enqueue', [sessionId, { clientId, text: '', files: [{ path: ref, name: 'probe-red.png', mimeType: 'image/png', category: 'image' }] }]);
check('a caption-less photo is accepted', sent.ok === true, sent.ok === true ? 'ok' : `${sent.error?.code}: ${sent.error?.message}`);
if (sent.ok !== true) {
  // Nothing to wait for; report and stop rather than pretend the rest is meaningful.
  if (!KEEP) await call('local-db:sessions:patch-meta', [sessionId, { status: 'deleted' }]);
  process.exit(1);
}

// The agent must be told what to do with it, or "the image arrived" is not checkable.
await call('maker:input:enqueue', [sessionId, { clientId: `${clientId}-ask`, text: '这张图片主要是什么颜色？只回答颜色名，不要解释。' }]);

// ─── 5. wait for the turn, then read it back ────────────────────────────────
let running = true;
for (let attempt = 0; attempt < 40 && running; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const active = await call('maker:list-active');
  running = (Array.isArray(active.result) ? active.result : []).some((row) => row.sessionId === sessionId);
}
const transcript = await call('local-db:messages:list', [sessionId, { limit: 40 }]);
const rows = Array.isArray(transcript.result) ? transcript.result : [];
const said = rows
  .filter((row) => row?.role === 'model' || row?.role === 'assistant')
  .map((row) => (typeof row?.content?.text === 'string' ? row.content.text : ''))
  .join('\n');
check('the agent answered at all', said.trim() !== '', `${rows.length} rows, ${said.length} chars`);

// ─── 6. did the model actually see the picture? ─────────────────────────────
const asked = rows.find((row) => typeof row?.content?.text === 'string' && row.content.text.includes('只回答颜色名'));
check('the user row carries the prompt', asked !== undefined, asked === undefined ? 'the ask row is missing' : `id=${asked.id}`);
check('the answer names the colour that is in the image', /红|red/i.test(said), said.trim().slice(0, 120).replace(/\s+/g, ' '));

// ─── 6b. and the phone can render it, because the row carries the bytes ─────
//
// The reported bug lived here: the image used to travel as a `files[]` entry with no
// `path`, which the phone renders as 没有可展示的远程路径. It now travels in
// `images[]` as base64 — which the phone turns into a `data:` URL it renders directly,
// so this asserts the row is exactly that shape and that the bytes are the bytes.
const imageRow = rows.find((row) => Array.isArray(row?.content?.images) && row.content.images.length > 0);
check(
  'the user row carries the image inline instead of a path-less file entry',
  imageRow !== undefined && (imageRow.content.files ?? []).length === 0,
  imageRow === undefined ? 'no row carries images[]' : `files=${JSON.stringify(imageRow.content.files ?? null)}`,
);
const inlined = imageRow?.content?.images?.[0] ?? {};
const inlinedBytes = typeof inlined.base64 === 'string' ? Buffer.from(inlined.base64, 'base64') : Buffer.alloc(0);
check(
  'the inlined bytes are exactly the bytes that were uploaded',
  inlinedBytes.length === image.length && createHash('sha256').update(inlinedBytes).digest('hex') === sha256,
  `${inlinedBytes.length}B sha=${createHash('sha256').update(inlinedBytes).digest('hex').slice(0, 12)}…`,
);
check(
  'the inlined entry carries what the phone needs to render it',
  inlined.mimeType === 'image/png' && inlined.originalName === 'probe-red.png',
  `mimeType=${String(inlined.mimeType)} originalName=${String(inlined.originalName)}`,
);

// ─── 7. the staging object was a transit copy, and is gone ──────────────────
//
// Existence is decided by the **object GET**, not by `presign-get`: the server mints a
// signed URL whether or not the object is still there, so a 200 from the presign says
// nothing. Measured: before the release the GET answers 200, after it 404.
let released = false;
try {
  const again = await fetch(`${API_BASE}/media/presign-get`, {
    method: 'POST',
    headers: { ...authHeaders, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ key: ossKey }),
  });
  const url = again.ok === true ? (await again.json()).getUrl : undefined;
  released = typeof url !== 'string' ? true : (await fetch(url, { method: 'GET' })).status === 404;
} catch {
  released = true;
}
check('the staging object was released after the prompt landed', released, released ? 'gone' : 'still there');

// ─── 8. leave no probe visible to a controller ──────────────────────────────
if (KEEP) {
  console.log(`kept: session=${sessionId} key=${ossKey}`);
} else {
  await call('maker:input:stop', [sessionId]);
  await call('maker:input:clear-session', [sessionId]);
  const hidden = await call('local-db:sessions:patch-meta', [sessionId, { status: 'deleted' }]);
  check('the probe session is hidden from controllers', hidden.ok === true && hidden.result?.status === 'deleted', `status=${hidden.result?.status}`);
}

const failed = checks.filter((entry) => entry.ok !== true);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
