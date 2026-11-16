import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createSessionListEncoder } from '../src/session-list-transfer.js';
const root = process.env.CINDY_LIST_SOURCE_ROOT;
const skip = !root && 'Set CINDY_LIST_SOURCE_ROOT for official source contract tests (not APK acceptance)';
const url = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
const js = path => stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'transform' });

test('actual official InvokeResultCache decodes Host gzip, tags, notModified and full delta fallback', { skip }, async () => {
  const dir = join(root, 'packages/device-link/src');
  const delta = url(js(join(dir, 'invokeDelta.ts')));
  const transport = readFileSync(join(dir, 'transport.ts'), 'utf8');
  const start = transport.indexOf('export function byteLength(');
  const end = transport.indexOf('\n}', start) + 2;
  assert.ok(start > 0 && end > start);
  const length = url(stripTypeScriptTypes(transport.slice(start, end), { mode: 'transform' }));
  const source = js(join(dir, 'invokeTransfer.ts')).replace("'./transport.js'", JSON.stringify(length)).replace("'./invokeDelta.js'", JSON.stringify(delta));
  const { InvokeResultCache } = await import(url(source));
  const cache = new InvokeResultCache({
    gunzipBase64: (base64, maxChars) => { const text = gunzipSync(Buffer.from(base64, 'base64'), { maxOutputLength: 12 * 1024 * 1024 }).toString(); assert.ok(text.length <= maxChars); return text; },
    contentTag: text => createHash('sha256').update(text).digest('hex'),
  });
  const encoder = createSessionListEncoder();
  const body = Array.from({ length: 80 }, (_, i) => ({ id: String(i), title: '中文😀'.repeat(30) }));
  const payload = { channel: 'local-db:sessions:list', args: [200, 'active', { fresh: true, includePinned: true }] };
  const reply = { v: 1, kind: 'invoke-result', id: 'r', dst: 'mobile', payload: { ok: true, result: body } };
  const first = cache.prepare('host', payload);
  assert.equal(first.payload.transfer.delta, 1);
  const encoded = await encoder.encode(reply, { payload: first.payload });
  assert.ok(encoded.payload.transfer.gzipBase64); assert.equal(encoded.payload.transfer.delta, undefined);
  assert.deepEqual((await first.decode(encoded.payload)).result, body);
  const next = cache.prepare('host', payload);
  assert.ok(next.payload.transfer.ifNoneMatch);
  const unchanged = await encoder.encode(reply, { payload: next.payload }); assert.equal(unchanged.payload.transfer.notModified, true);
  assert.deepEqual((await next.decode(unchanged.payload)).result, body);
  const other = cache.prepare('other-peer', payload); assert.equal(other.payload.transfer.ifNoneMatch, undefined);
});

test('actual shared recency helper cannot let first-user evidence hide native activity', { skip }, async () => {
  const { getSessionListActivityAt } = await import(url(js(join(root, 'packages/maker-shared/src/sessionActivity.ts'))));
  assert.equal(getSessionListActivityAt({ updatedAt: '2026-11-16', userSendAt: '2026-01-01' }), '2026-01-01');
  assert.equal(getSessionListActivityAt({ updatedAt: '2026-11-16', lastActivityAt: '2026-11-16', userSendAt: '2026-01-01' }), '2026-11-16');
});

test('official created consumer branches request reseed for empty payload; this is only a source-level gate', { skip }, () => {
  const mobile = readFileSync(join(root, 'apps/mobile/src/session/remoteSessionStore.ts'), 'utf8');
  const start = mobile.indexOf("if (channel === 'local-db:sessions:created') {");
  const end = mobile.indexOf("if (channel === 'maker:session-model-pref:changed')", start);
  assert.ok(start > 0 && end > start);
  let epochs = 0, pulls = 0;
  const branch = new Function('channel', 'payload', 'deviceId', 'bumpDeviceSessionListMutationEpoch', 'reseedHandlers', mobile.slice(start, end));
  const handlers = new Map([['host', new Set([() => { pulls++; }])]]);
  branch('local-db:sessions:created', {}, 'host', () => { epochs++; }, handlers);
  branch('local-db:sessions:created', { sessionId: 'real' }, 'host', () => { epochs++; }, handlers);
  assert.equal(epochs, 2); assert.equal(pulls, 2);
  const desktop = readFileSync(join(root, 'apps/desktop/src/renderer/lib/makerChatStore.ts'), 'utf8');
  const key = "case 'local-db:sessions:created':";
  const ds = desktop.indexOf(key), de = desktop.indexOf('break;', ds);
  assert.ok(ds > 0 && de > ds);
  new Function('push', 'requestRemoteReseed', desktop.slice(ds + key.length, de))({ deviceId: 'host', payload: {} }, () => { pulls++; });
  assert.equal(pulls, 3);
  // No production validation record is created by snippet tests. Full target
  // transport/store/UI routing and real APK version remain release prerequisites.
});
