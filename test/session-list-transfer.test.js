import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createSessionListEncoder } from '../src/session-list-transfer.js';
import { frameFits } from '../src/host-frame-budget.js';
const result = () => ({ v: 1, kind: 'invoke-result', id: 'r', dst: 'phone', payload: { ok: true,
  result: Array.from({ length: 80 }, (_, i) => ({ id: String(i), title: '中文 😀 '.repeat(20) })) } });
const request = transfer => ({ payload: { channel: 'local-db:sessions:list', ...(transfer ? { transfer } : {}) } });

test('old caller is byte-shape compatible and errors are never encoded', async () => {
  const codec = createSessionListEncoder(); const reply = result();
  assert.equal(await codec.encode(reply, request()), reply);
  const bad = { ...reply, payload: { ok: false, error: { code: 'FORBIDDEN' } } };
  assert.equal(await codec.encode(bad, request({ gzip: 1, ifNoneMatch: 'cached' })), bad);
});
test('gzip and SHA256 tag round trip exactly, and unchanged results use notModified', async () => {
  const codec = createSessionListEncoder(); const reply = result();
  const zipped = await codec.encode(reply, request({ gzip: 1 }));
  assert.equal(zipped.payload.result, null); assert.match(zipped.payload.transfer.tag, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(zipped.payload.transfer.gzipBase64, 'base64'))), reply.payload.result);
  const unchanged = await codec.encode(reply, request({ gzip: 1, ifNoneMatch: zipped.payload.transfer.tag }));
  assert.deepEqual(unchanged.payload, { ok: true, result: null, transfer: { tag: zipped.payload.transfer.tag, notModified: true } });
  reply.payload.result[0].title = 'changed';
  const changed = await codec.encode(reply, request({ ifNoneMatch: zipped.payload.transfer.tag }));
  assert.notEqual(changed.payload.transfer.tag, zipped.payload.transfer.tag); assert.ok(Array.isArray(changed.payload.result));
});
test('delta declarations receive supported full-content fallback, never a claimed delta', async () => {
  const reply = await createSessionListEncoder().encode(result(), request({ delta: 1 }));
  assert.ok(Array.isArray(reply.payload.result)); assert.equal(reply.payload.transfer.delta, undefined);
});
test('small, malformed and unprofitable transfer requests keep plain results', async () => {
  const codec = createSessionListEncoder({ compress: async data => data });
  const reply = result();
  const plain = await codec.encode(reply, request({ gzip: 1 })); assert.ok(Array.isArray(plain.payload.result));
  const small = { ...reply, payload: { ok: true, result: [] } };
  assert.equal(await codec.encode(small, request({ gzip: 1 })), small);
  assert.equal(await codec.encode(reply, request({ gzip: true, ifNoneMatch: 'x'.repeat(129) })), reply);
});
test('compression slots are bounded; failed compression cannot suppress valid plain data', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const codec = createSessionListEncoder({ maxConcurrent: 1, compress: async data => { await gate; return gzipSync(data); } });
  const first = codec.encode(result(), request({ gzip: 1 }));
  const second = await codec.encode(result(), request({ gzip: 1 })); assert.ok(Array.isArray(second.payload.result));
  assert.equal(codec.diagnostics().active, 1); release(); await first; assert.equal(codec.diagnostics().active, 0);
  const failed = await createSessionListEncoder({ compress: async () => { throw Error('codec failed'); } }).encode(result(), request({ gzip: 1 }));
  assert.ok(Array.isArray(failed.payload.result));
});
test('encoding is before final frame budget; it never truncates the logical list', async () => {
  const reply = { ...result(), payload: { ok: true, result: [{ id: 'one', title: '中文'.repeat(400_000) }] } };
  assert.equal(frameFits(reply), false);
  const zipped = await createSessionListEncoder().encode(reply, request({ gzip: 1 })); assert.equal(frameFits(zipped), true);
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(zipped.payload.transfer.gzipBase64, 'base64'))), reply.payload.result);
});
