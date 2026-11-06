import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { attachmentImageUrl, parseAttachmentImageUrl, nativeMessageImages } from '../src/host-attachment-reference.js';
import { createNativeAttachmentSourceReader, createAttachmentMediaFetcher } from '../src/host-attachment-media.js';
import { toCindyMessageRows } from '../src/cindy-message-row.js';
import { foldSessionEvent, createMessageReader } from '../src/dsh-message-fold.js';
import { createHistoryViewController } from '../src/host-history-view.js';
import { createChannelRouter } from '../src/cindy-channels.js';
import { compactRowText, fitInvokeResultToFrame, frameFits } from '../src/host-frame-budget.js';
import { buildDshSource, capabilityProvider } from '../src/dsh-plugin.js';
import { startHost } from '../src/host.js';

const AT = '2026-11-07T00:00:00.000Z';
function fixture({ size = 1775256, mime = 'image/png', role = 'tool' } = {}) {
  const bytes = Buffer.alloc(size, 42);
  const ref = { attachmentId: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), mediaType: mime, bytes: size, width: 1672, height: 941, name: 'generated-original' };
  const message = { id: 'm1', role, source: { kind: role === 'tool' ? 'tool' : 'model' }, toolCallId: 'call1', content: [
    { type: 'text', text: JSON.stringify({ image: ref, localPath: 'C:/not-a-public-image/original' }) },
    { type: 'image', attachment: ref },
  ] };
  const event = { type: role === 'tool' ? 'tool/result' : 'assistant/message', seq: 0, time: Date.parse(AT), surfaceOp: 'append', data: { turn: 1, step: 1, message } };
  const url = attachmentImageUrl('s1', message.id, '1', ref);
  return { bytes, ref, message, event, url };
}
function sourceFor(f, overrides = {}) {
  return createNativeAttachmentSourceReader({ getSession: async id => id === 's1' ? { id } : null,
    readSessionLog: async () => ({ events: [f.event] }),
    readImage: async ref => { assert.deepEqual(ref, f.ref); return { base64: f.bytes.toString('base64') }; }, ...overrides });
}
const project = message => toCindyMessageRows(message, { sessionId: 's1', createdAt: AT });

test('canonical tool image becomes the existing Cindy managed-media contract, without changing identity or original text', () => {
  const f = fixture();
  const [row] = project(f.message);
  assert.equal(row.id, 's1:m1:0'); assert.equal(row.clientId, row.id); assert.equal(row.toolUseId, 'call1');
  const media = JSON.parse(row.content.text);
  assert.equal(media.text, f.message.content[0].text);
  assert.deepEqual(media.xdt_image_urls, [f.url]);
  assert.equal(parseAttachmentImageUrl(f.url).mediaType, 'image/png');
  assert.equal(Buffer.byteLength(JSON.stringify(row)) < 4096, true, '1.7MiB source bytes never ride history');
  assert.equal(JSON.stringify(f.message).includes('xdt_image_urls'), false, 'source log is never rewritten');
});

test('native descriptors may omit the optional display name without losing projected or fetched images', async () => {
  for (const role of ['tool', 'assistant']) {
    const f = fixture({ size: 64, role });
    delete f.ref.name;
    assert.equal(nativeMessageImages(f.message).length, 1);
    assert.equal(attachmentImageUrl('s1', f.message.id, '1', f.ref), f.url);
    assert.equal(attachmentImageUrl('s1', f.message.id, '1', { ...f.ref, name: 7 }), null);
    const fetch = createAttachmentMediaFetcher({ readSource: sourceFor(f), render: async () => ({ ok: false }) });
    const reply = await fetch({ url: f.url, thumbnail: true });
    assert.equal(reply.ok, true);
    assert.equal(reply.result.inlineBase64, f.bytes.toString('base64'));
    assert.equal(reply.result.mimeType, f.ref.mediaType);
    assert.equal(JSON.stringify(project(f.message)).includes(f.url), true);
  }
});

test('legacy nested results attach each image to its own tool call and assistant native images stay assistant', () => {
  const f = fixture();
  const legacy = { id: 'old', role: 'user', source: { kind: 'tool' }, content: [
    { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'image', attachment: f.ref }] },
    { type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'plain' }] },
  ] };
  const rows = project(legacy);
  const urls = JSON.parse(rows[0].content.text).xdt_image_urls;
  assert.equal(urls.length, 1); assert.equal(parseAttachmentImageUrl(urls[0]).blockPath, '0.0');
  assert.equal(rows[1].content.text, 'plain'); assert.equal(rows[0].toolUseId, 'c1');
  const assistant = project({ ...f.message, role: 'assistant', source: { kind: 'model' } });
  assert.equal(assistant.length, 2); assert.equal(assistant[1].role, 'assistant');
  assert.ok(assistant[1].content.includes(f.url));
  assert.deepEqual(nativeMessageImages({ ...f.message, source: { kind: 'plugin' } }), []);
});

test('text containing generator metadata or local paths never acquires native image authority', () => {
  const f = fixture();
  const [row] = project({ ...f.message, content: [f.message.content[0]] });
  assert.equal(row.content.text, f.message.content[0].text);
  assert.equal(attachmentImageUrl('s1', 'm1', '1', { ...f.ref, width: undefined }), null);
});

test('locators are deterministic and strictly reject arbitrary paths, namespaces, query parameters and noncanonical encodings', () => {
  const f = fixture();
  const parsed = parseAttachmentImageUrl(f.url);
  assert.deepEqual({ sessionId: parsed.sessionId, messageId: parsed.messageId, blockPath: parsed.blockPath }, { sessionId: 's1', messageId: 'm1', blockPath: '1' });
  for (const bad of [f.url + '?path=/secret', f.url + '#x', f.url.replace('dsh-attachment', 'desktop-cache'), f.url.replace('/1/', '/../'), f.url.replace('.png', '.jpg?x'), 'xdt-file://open?path=/secret', 'xdt-image://dsh-attachment/v1/!!!!/bQ/1/a.png']) {
    assert.equal(parseAttachmentImageUrl(bad), null);
  }
});

test('native source lookup validates session, message, block, hash and full descriptor; missing images never use localPath', async () => {
  const f = fixture(); const read = sourceFor(f); const locator = parseAttachmentImageUrl(f.url);
  assert.deepEqual((await read(locator)).bytes, f.bytes);
  assert.equal((await read({ ...locator, sessionId: 'denied' })).code, 'FORBIDDEN');
  for (const changed of [{ messageId: 'other' }, { blockPath: '0' }, { attachmentId: 'sha256:' + 'a'.repeat(64) }, { mediaType: 'image/jpeg' }]) {
    assert.equal((await read({ ...locator, ...changed })).code, 'MEDIA_SOURCE_MISSING');
  }
  assert.equal((await sourceFor(f, { readImage: async () => null })(locator)).code, 'MEDIA_SOURCE_MISSING');
  assert.equal((await sourceFor(f, { readSessionLog: async () => ({ events: [] }) })(locator)).code, 'MEDIA_SOURCE_MISSING');
});

test('native source reconstruction also serves legacy nested images', async () => {
  const f = fixture();
  f.event = { type: 'user/message', surfaceOp: 'append', seq: 0, time: Date.parse(AT), data: { id: 'legacy', role: 'user', source: { kind: 'tool' }, content: [{ type: 'tool-result', toolCallId: 'call1', content: [{ type: 'image', attachment: f.ref }] }] } };
  const [row] = project(f.event.data);
  const url = JSON.parse(row.content.text).xdt_image_urls[0];
  assert.equal((await sourceFor(f)(parseAttachmentImageUrl(url))).ok, true);
});

test('attachment fetch uses native MIME even without an extension, thumbnail bytes stay bounded and original is staged on demand', async () => {
  for (const mime of ['image/png', 'image/jpeg']) {
    const f = fixture({ mime }); const uploads = [];
    const fetch = createAttachmentMediaFetcher({ readSource: sourceFor(f), render: async bytes => { assert.deepEqual(bytes, f.bytes); return { ok: true, data: Buffer.from('webp') }; }, uploader: async (bytes, options) => { uploads.push({ bytes, options }); return { ok: true, key: 'account/image' }; } });
    const thumb = await fetch({ url: f.url, thumbnail: true });
    assert.equal(thumb.result.mimeType, 'image/webp'); assert.equal(uploads.length, 0);
    assert.equal(thumb.result.inlineBase64, Buffer.from('webp').toString('base64'));
    const original = await fetch({ url: f.url });
    assert.equal(original.result.mimeType, mime); assert.equal(original.result.size, f.bytes.length);
    assert.equal(uploads[0].options.contentType, mime); assert.equal(uploads[0].options.ext, mime === 'image/png' ? 'png' : 'jpg');
    assert.deepEqual(uploads[0].bytes, f.bytes);
  }
});

test('no codec degrades to small original or staging, never to an empty successful picture', async () => {
  const small = fixture({ size: 512 }); const large = fixture();
  for (const f of [small, large]) {
    let uploads = 0;
    const fetch = createAttachmentMediaFetcher({ readSource: sourceFor(f), render: async () => ({ ok: false }), uploader: async () => { uploads++; return { ok: true, key: 'fallback' }; } });
    const reply = await fetch({ url: f.url, thumbnail: true });
    assert.equal(reply.ok, true); assert.equal(uploads, f === small ? 0 : 1);
    assert.equal(reply.result.mimeType, f.ref.mediaType);
  }
});

test('source mismatch and oversize fail without staging; source is reauthorized even after a successful upload', async () => {
  const f = fixture(); let allowed = true; let uploads = 0;
  const read = sourceFor(f, { getSession: async () => allowed ? { id: 's1' } : null });
  const fetch = createAttachmentMediaFetcher({ readSource: read, uploader: async () => { uploads++; return { ok: true, key: 'key' }; } });
  assert.equal((await fetch({ url: f.url })).ok, true); allowed = false;
  assert.equal((await fetch({ url: f.url })).code, 'FORBIDDEN'); assert.equal(uploads, 1);
  const mismatch = createAttachmentMediaFetcher({ readSource: async () => ({ ok: true, ref: f.ref, bytes: Buffer.alloc(f.ref.bytes) }), uploader: () => assert.fail('must not upload') });
  assert.equal((await mismatch({ url: f.url })).code, 'MEDIA_SOURCE_MISSING');
  const oversized = createAttachmentMediaFetcher({ readSource: sourceFor(f), maxBytes: 32, uploader: () => assert.fail('must not upload') });
  assert.equal((await oversized({ url: f.url })).code, 'BAD_REQUEST');
});

test('staging is single-flight, failures are retryable and skipCache refreshes expired objects', async () => {
  const f = fixture(); let attempts = 0;
  const fetch = createAttachmentMediaFetcher({ readSource: sourceFor(f), uploader: async () => { attempts++; await new Promise(resolve => setImmediate(resolve)); return attempts === 1 ? { ok: false } : { ok: true, key: 'key-' + attempts }; } });
  const first = await Promise.all([fetch({ url: f.url }), fetch({ url: f.url })]);
  assert.equal(first.every(result => result.ok === false), true); assert.equal(attempts, 1);
  assert.equal((await fetch({ url: f.url })).result.ossKey, 'key-2');
  assert.equal((await fetch({ url: f.url })).result.ossKey, 'key-2'); assert.equal(attempts, 2);
  assert.equal((await fetch({ url: f.url, skipCache: true })).result.ossKey, 'key-3');
  assert.equal((await fetch({ url: f.url + '?path=/etc/passwd' })).code, 'BAD_REQUEST');
});

test('initial history, live fold, work details, reload and restart produce identical media identity', async () => {
  const f = fixture(); const log = { events: [f.event] };
  const reader = createMessageReader({ readSessionLog: async () => log });
  const live = foldSessionEvent(f.event, { sessionId: 's1' });
  const first = await reader('s1');
  assert.deepEqual(first, live);
  const snapshot = await reader.historySnapshot('s1');
  assert.deepEqual(snapshot.rows[0], live[0]);
  const view = createHistoryViewController({ rows: async () => first });
  const page = await view.page('s1');
  const work = page.result.items.find(item => item.type === 'work');
  assert.ok(work);
  const details = await view.details('s1', work.summary);
  assert.equal(details.ok, true);
  assert.ok(JSON.stringify(details).includes(f.url));
  reader.invalidate('s1'); assert.deepEqual(await reader('s1'), live);
  const restarted = createMessageReader({ readSessionLog: async () => log });
  assert.deepEqual(await restarted('s1'), live);
  assert.equal((await sourceFor(f)(parseAttachmentImageUrl(f.url))).ok, true);
});

test('long tool text compaction retains parseable image fields and complete frame budgets', () => {
  const f = fixture(); f.message.content[0].text = '中文\\\"😀'.repeat(200_000);
  const row = project(f.message)[0];
  const compacted = compactRowText([row]).rows[0];
  const parsed = JSON.parse(compacted.content.text);
  assert.deepEqual(parsed.xdt_image_urls, [f.url]);
  assert.ok(parsed.text.includes('remote content truncated'));
  assert.ok(Buffer.byteLength(compacted.content.text) <= 8192);
  const reply = { v: 1, kind: 'invoke-result', id: 'many', dst: 'phone', payload: { ok: true, result: Array.from({ length: 20 }, () => row) } };
  const fitted = fitInvokeResultToFrame({ reply, request: { id: 'many', src: 'phone' }, channel: 'local-db:messages:list' });
  assert.ok(frameFits(fitted.reply));
  assert.ok(fitted.reply.payload.result.some(result => JSON.parse(result.content.text).xdt_image_urls.includes(f.url)));
});

test('identity/source changes during lookup, decoding or staging cannot publish stale results or poison a new scope cache', async () => {
  const f = fixture();
  for (const step of ['read', 'render', 'upload']) {
    let scope = 1; let uploads = 0;
    const source = sourceFor(f);
    const fetch = createAttachmentMediaFetcher({ getScope: () => scope,
      readSource: async locator => { const result = await source(locator); if (step === 'read') scope++; return result; },
      render: async () => { if (step === 'render') scope++; return { ok: true, data: Buffer.from('webp') }; },
      uploader: async () => { uploads++; if (step === 'upload') scope++; return { ok: true, key: 'stale' }; },
    });
    assert.equal((await fetch({ url: f.url, thumbnail: step !== 'upload' })).code, 'FORBIDDEN');
    if (step !== 'upload') assert.equal(uploads, 0);
  }
  let scope = 'account-a'; let uploads = 0;
  const fetch = createAttachmentMediaFetcher({ getScope: () => scope, readSource: sourceFor(f), uploader: async () => ({ ok: true, key: 'key-' + ++uploads }) });
  assert.equal((await fetch({ url: f.url })).result.ossKey, 'key-1');
  scope = 'account-b'; assert.equal((await fetch({ url: f.url })).result.ossKey, 'key-2');
});

test('GIF thumbnail requests preserve the original animation rather than re-encode a still', async () => {
  const f = fixture({ size: 512, mime: 'image/gif' });
  const fetch = createAttachmentMediaFetcher({ readSource: sourceFor(f), render: () => assert.fail('must not flatten GIF') });
  const reply = await fetch({ url: f.url, thumbnail: true });
  assert.equal(reply.result.mimeType, 'image/gif'); assert.equal(reply.result.inlineBase64, f.bytes.toString('base64'));
});

test('production plugin and Host composition serve generated image references and preserve live/history identity', async () => {
  const f = fixture({ size: 512 }); let reads = 0;
  const services = {
    sessionController: { list: async () => ({ items: [{ sessionId: 's1', createdAt: 1000, updatedAt: 2000, cwd: '/project' }] }) },
    sessionQuery: { readSession: async () => ({ header: { id: 's1', cwd: '/project', createdAt: 1000 }, events: [f.event] }) },
    attachments: { readImage: async ref => { reads++; assert.deepEqual(ref, f.ref); return { ref, data: f.bytes }; } },
  };
  const ctx = { get: key => services[key], on: () => () => {}, inject: (keys, callback) => { if (keys.every(key => services[key])) callback(ctx); return () => {}; }, effect: run => run() };
  const built = buildDshSource(ctx, 'sessionController');
  assert.equal(capabilityProvider(built).readAttachmentSource, built.readAttachmentSource);
  assert.equal((await built.readAttachmentSource(parseAttachmentImageUrl(f.url))).ok, true);
  const sent = []; const handlers = new Map();
  const socket = { readyState: 1, on: (name, listener) => { handlers.set(name, listener); return socket; }, send: value => sent.push(JSON.parse(value)), close: () => {} };
  const runtime = await startHost({ listSessions: async () => [{ id: 's1', title: 'image', running: false }], onEvent: () => () => {} }, { transportEnabled: true, remoteControlEnabled: true, controllers: {} }, {
    resolveSession: async () => ({ ok: true, session: { deviceId: 'fake-host' } }),
    openSocket: () => socket, listDevices: async () => [], heartbeatMs: 0,
    resolveCapabilities: () => capabilityProvider(built),
    fetch: () => assert.fail('small thumbnail must not require network staging'),
  });
  try {
    handlers.get('open')();
    handlers.get('message')(Buffer.from(JSON.stringify({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'fake-host', userId: 'fake-user' } })));
    handlers.get('message')(Buffer.from(JSON.stringify({ v: 1, kind: 'invoke', id: 'sub', src: 'phone', payload: { channel: 'device-link:subscribe', args: [{ topics: ['session:s1'] }] } })));
    await new Promise(resolve => setImmediate(resolve));
    const result = await runtime.invokeForTest('device-link:media:fetch', [{ url: f.url, thumbnail: true }]);
    assert.equal(result.ok, true); assert.equal(result.reply.payload.ok, true);
    assert.equal(result.reply.payload.result.mimeType, 'image/png');
    assert.equal(result.reply.payload.result.inlineBase64, f.bytes.toString('base64'));
    const row = (await built.readMessages('s1'))[0];
    await runtime.pushSessionMessage('s1', row);
    const push = sent.findLast(frame => frame.kind === 'push' && frame.payload.channel === 'local-db:messages:created');
    assert.ok(push); assert.equal(push.payload.payload.message.content.text, row.content.text);
    assert.ok(reads >= 2);
    const bad = await runtime.invokeForTest('device-link:media:fetch', [{ url: f.url.replace('dsh-attachment', 'desktop-cache'), thumbnail: true }]);
    assert.equal(bad.reply.payload.ok, false);
    await runtime.stop();
    const stopped = await runtime.invokeForTest('device-link:media:fetch', [{ url: f.url, thumbnail: true }]);
    assert.equal(stopped.reply.payload.ok, false);
  } finally { await runtime.stop(); }
});

test('attachment source I/O is bounded before reading large image bytes', async () => {
  const f = fixture({ size: 512 }); const waiting = [];
  const fetch = createAttachmentMediaFetcher({ readSource: () => new Promise(resolve => waiting.push(resolve)), render: async () => ({ ok: false }), maxConcurrent: 2 });
  const first = fetch({ url: f.url, thumbnail: true });
  const second = fetch({ url: f.url, thumbnail: true });
  assert.match((await fetch({ url: f.url, thumbnail: true })).message, /busy/);
  const source = { ok: true, ref: f.ref, bytes: f.bytes };
  waiting.forEach(resolve => resolve(source));
  assert.equal((await first).ok, true); assert.equal((await second).ok, true);
});

test('router forwards managed-media thumbnail and cache options without rewriting the locator', async () => {
  const f = fixture(); let received;
  const route = createChannelRouter({ listSessions: async () => [], subscribers: new Set(), resolveCapabilities: () => ({ fetchLocalMedia: async input => { received = input; return { ok: true, result: { ossKey: '', mimeType: 'image/webp', size: 3, inlineBase64: 'YWJj' } }; } }) });
  const reply = await route({ v: 1, kind: 'invoke', id: 'media', src: 'phone', payload: { channel: 'device-link:media:fetch', args: [{ url: f.url, thumbnail: true, skipCache: true }] } });
  assert.equal(reply.payload.ok, true);
  assert.deepEqual(received, { url: f.url, thumbnail: true, skipCache: true });
});
