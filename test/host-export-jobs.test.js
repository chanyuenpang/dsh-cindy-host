import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setImmediate as immediate } from 'node:timers/promises';
import { createExportJobs } from '../src/host-export-jobs.js';

const LIMIT = 2 * 1024 * 1024 * 1024;
const INPUT = { workdir: '/safe', relPath: 'file.bin' };
const REQUEST = { src: 'alice', id: 'rpc-1' };
const info = (size = 5) => ({ size, mtimeMs: 123, dev: 1, ino: 2, isFile: () => true });
const resolved = (size = 5) => ({ ok: true, real: '/safe/file.bin', info: info(size) });
const success = (size = 5) => ({ ok: true, key: 'private-object-key', size, sha256: 'a'.repeat(64) });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fakeSource(size = 5, overrides = {}) {
  const source = {
    size, closes: 0, verifies: 0,
    async read(buffer, position) { const bytes = Math.min(buffer.length, size - position); buffer.fill(1, 0, bytes); return bytes; },
    async verify() { source.verifies++; },
    async close() { source.closes++; },
    ...overrides,
  };
  return source;
}
function fixture(overrides = {}) {
  const f = { owner: {}, allowed: new Set(['alice', 'bob']), at: 0, sources: [], uploads: [], resolutions: [], events: [] };
  f.manager = createExportJobs({
    captureOwner: () => f.owner,
    isOwnerCurrent: (owner) => owner === f.owner,
    isControllerAllowed: (src) => f.allowed.has(src),
    now: () => f.at,
    emit: (event) => f.events.push(event),
    resolveSource: async (...args) => { f.resolutions.push(args); return resolved(); },
    openSource: async (_real, meta) => { const source = fakeSource(meta.size); f.sources.push(source); return source; },
    upload: async (source, options) => { const pending = deferred(); f.uploads.push({ source, options, pending }); return pending.promise; },
    ...overrides,
  });
  f.start = (input = INPUT, request = REQUEST) => f.manager.start(input, request);
  f.status = (reply, src = 'alice') => f.manager.status({ transferId: reply.transferId }, { src, id: 'status' });
  return f;
}
async function idle(manager) {
  for (let i = 0; i < 1000 && manager.getStats().active; i++) await immediate();
  assert.equal(manager.getStats().active, 0, 'resource lifetime settled');
}

test('legacy start is prompt, progress bounded and terminal status idempotent', async () => {
  const f = fixture();
  const reply = await f.start();
  assert.deepEqual(Object.keys(f.manager).sort(), ['getStats', 'invalidateOwner', 'pruneUnauthorized', 'start', 'status', 'stop']);
  assert.deepEqual(reply, { ok: true, transferId: reply.transferId, size: 5, mtimeMs: 123 });
  assert.match(reply.transferId, /^exp_/);
  const { options } = f.uploads[0];
  assert.equal(options.owner, f.owner);
  assert.equal(options.ext, 'bin');
  assert.equal(options.contentType, 'application/octet-stream');
  assert.equal(f.resolutions[0][2].maxBytes, LIMIT);
  assert.ok(f.resolutions[0][2].signal instanceof AbortSignal);
  for (const value of [3, 2, NaN, -1, 'secret', 4.5]) options.onProgress(value);
  assert.equal(f.status(reply).uploaded, 3);
  options.onProgress({ uploaded: 20 });
  assert.deepEqual(f.status(reply), { ok: true, state: 'uploading', size: 5, uploaded: 5 });
  f.uploads[0].pending.resolve(success());
  await idle(f.manager);
  const done = { ok: true, state: 'done', size: 5, uploaded: 5, key: 'private-object-key' };
  assert.deepEqual(f.status(reply), done);
  assert.deepEqual(f.status(reply), done);
  options.onProgress(0);
  assert.deepEqual(f.status(reply), done);
  assert.equal(f.sources[0].closes, 1);
  assert.equal(f.manager.getStats().records, 1);
});

test('same owner/controller/RPC id shares pending start and accepted result; conflicts reject', async () => {
  const validation = deferred();
  const f = fixture({ resolveSource: () => validation.promise });
  const first = f.start();
  assert.strictEqual(f.start({ ...INPUT }, { ...REQUEST }), first);
  assert.equal(f.manager.getStats().active, 1);
  assert.equal((await f.start({ ...INPUT, relPath: 'other' })).code, 'BAD_REQUEST');
  assert.equal((await f.start({ ...INPUT, maxBytes: LIMIT })).code, 'BAD_REQUEST');
  validation.resolve(resolved());
  const reply = await first;
  assert.strictEqual(f.start(), first);
  assert.deepEqual(await f.start(), reply);
  f.uploads[0].pending.resolve(success());
  await idle(f.manager);
  assert.strictEqual(f.start(), first);
  assert.equal(f.uploads.length, 1);
});

test('both slots are reserved before asynchronous validation; no implicit queue', async () => {
  const validation = deferred();
  const f = fixture({ resolveSource: () => validation.promise });
  const a = f.start();
  const b = f.start(INPUT, { ...REQUEST, id: 'rpc-2' });
  assert.deepEqual(f.manager.getStats(), { active: 2, records: 2, uploading: 2, done: 0, error: 0 });
  assert.equal((await f.start(INPUT, { ...REQUEST, id: 'rpc-3' })).code, 'NOT_AVAILABLE');
  validation.resolve({ ok: false, code: 'FORBIDDEN', message: 'secret' });
  assert.equal((await a).code, 'FORBIDDEN');
  assert.equal((await b).code, 'FORBIDDEN');
  await idle(f.manager);
  assert.equal(f.manager.getStats().records, 0);
  assert.equal(f.sources.length, 0);
});

test('terminal TTL starts at completion, is lazy, and status does not renew it', async () => {
  const f = fixture({ ttlMs: 10 });
  const startPromise = f.start();
  const reply = await startPromise;
  f.at = 10000;
  assert.equal(f.status(reply).state, 'uploading');
  f.uploads[0].pending.resolve(success());
  await idle(f.manager);
  f.at = 10009;
  assert.equal(f.status(reply).state, 'done');
  assert.strictEqual(f.start(), startPromise);
  f.at = 10010;
  assert.equal(f.status(reply).code, 'NOT_FOUND');
  const again = await f.start();
  assert.notEqual(again.transferId, reply.transferId);
  f.uploads[1].pending.resolve(success());
  await idle(f.manager);
});

test('64 records include reservations and terminal jobs; none is prematurely evicted', async () => {
  const f = fixture({ upload: async () => success() });
  let first;
  for (let i = 0; i < 64; i++) {
    const reply = await f.start(INPUT, { ...REQUEST, id: i });
    assert.equal(reply.ok, true);
    first ??= reply;
    await idle(f.manager);
  }
  assert.equal(f.manager.getStats().records, 64);
  assert.equal((await f.start(INPUT, { ...REQUEST, id: 64 })).code, 'NOT_AVAILABLE');
  assert.equal(f.status(first).state, 'done');
  assert.equal((await f.start(INPUT, { ...REQUEST, id: 0 })).transferId, first.transferId);
  f.at = 600000;
  assert.equal((await f.start(INPUT, { ...REQUEST, id: 64 })).ok, true);
  await idle(f.manager);
  assert.equal(f.manager.getStats().records, 1);
});

test('record quota is reserved during validation independently of active quota', async () => {
  const validation = deferred();
  const f = fixture({ maxJobs: 1, resolveSource: () => validation.promise });
  const pending = f.start();
  assert.equal((await f.start(INPUT, { ...REQUEST, id: 'two' })).code, 'NOT_AVAILABLE');
  validation.resolve({ ok: false, code: 'NOT_FOUND' });
  assert.equal((await pending).code, 'NOT_FOUND');
  await idle(f.manager);
  assert.equal(f.manager.getStats().records, 0);
});

for (const size of [0, LIMIT - 1, LIMIT]) test('inclusive 2GiB and zero-byte support: ' + size, async () => {
  const f = fixture({ resolveSource: async () => resolved(size), upload: async () => success(size) });
  const reply = await f.start(size === 0 ? { ...INPUT, maxBytes: 0 } : INPUT);
  assert.equal(reply.ok, true);
  assert.equal(reply.size, size);
  await idle(f.manager);
  assert.equal(f.status(reply).state, 'done');
});

test('caller cap and strict stat shape reject before source open/upload', async () => {
  for (const [metadata, input, code] of [
    [info(LIMIT + 1), INPUT, 'OVERSIZE'],
    [info(6), { ...INPUT, maxBytes: 5 }, 'OVERSIZE'],
    [info(1), { ...INPUT, maxBytes: 0 }, 'OVERSIZE'],
    [info(-1), INPUT, 'BAD_REQUEST'],
    [info(0.5), INPUT, 'BAD_REQUEST'],
    [info(Infinity), INPUT, 'BAD_REQUEST'],
    [info(NaN), INPUT, 'BAD_REQUEST'],
    [info(Number.MAX_SAFE_INTEGER + 1), INPUT, 'BAD_REQUEST'],
    [{ ...info(), isFile: () => false }, INPUT, 'BAD_REQUEST'],
    [{ ...info(), isFile: undefined }, INPUT, 'BAD_REQUEST'],
    [{ ...info(), mtimeMs: NaN }, INPUT, 'BAD_REQUEST'],
  ]) {
    const f = fixture({ resolveSource: async () => ({ ...resolved(), info: metadata }) });
    assert.equal((await f.start(input)).code, code);
    await idle(f.manager);
    assert.equal(f.sources.length, 0);
    assert.equal(f.uploads.length, 0);
    assert.equal(f.manager.getStats().records, 0);
  }
  const f = fixture({ upload: async () => success() });
  assert.equal((await f.start({ ...INPUT, maxBytes: Number.MAX_SAFE_INTEGER })).ok, true);
  assert.equal(f.resolutions[0][2].maxBytes, LIMIT);
  await idle(f.manager);
});

test('bounded metadata, ids and invalid caller limits reject without admission', async () => {
  const f = fixture();
  for (const maxBytes of [-1, 0.1, null, NaN, Infinity, '5', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await f.start({ ...INPUT, maxBytes })).code, 'BAD_REQUEST');
  }
  for (const input of [null, {}, { ...INPUT, workdir: ' ' }, { ...INPUT, relPath: '' },
    { ...INPUT, relPath: '/absolute' }, { ...INPUT, relPath: 'C:relative' },
    { ...INPUT, relPath: '\\absolute' }, { ...INPUT, workdir: 'x'.repeat(4097) },
    { ...INPUT, relPath: 'x'.repeat(4097) }, { ...INPUT, relPath: 'bad\0file' }]) {
    assert.equal((await f.start(input)).code, 'BAD_REQUEST');
  }
  for (const request of [null, {}, { ...REQUEST, src: '' }, { ...REQUEST, id: '' },
    { ...REQUEST, id: 'x'.repeat(257) }, { ...REQUEST, src: 'x'.repeat(257) },
    { ...REQUEST, id: NaN }, { ...REQUEST, id: {} }]) assert.equal((await f.start(INPUT, request)).code, 'BAD_REQUEST');
  assert.equal(f.manager.getStats().records, 0);
  assert.equal(f.resolutions.length, 0);
});

test('owner and policy failures are fail-closed before validation', async () => {
  for (const [overrides, code] of [
    [{ captureOwner: () => null }, 'OWNER_UNVERIFIED'],
    [{ captureOwner: () => { throw new Error('credential'); } }, 'OWNER_UNVERIFIED'],
    [{ isOwnerCurrent: () => false }, 'OWNER_UNVERIFIED'],
    [{ isOwnerCurrent: () => { throw new Error('credential'); } }, 'OWNER_UNVERIFIED'],
    [{ isControllerAllowed: () => false }, 'FORBIDDEN'],
    [{ isControllerAllowed: () => { throw new Error('policy'); } }, 'FORBIDDEN'],
  ]) {
    const f = fixture(overrides);
    assert.equal((await f.start()).code, code);
    assert.equal(f.resolutions.length, 0);
    assert.equal(f.manager.getStats().records, 0);
  }
});

test('unknown transfer, other controller and other owner have identical non-disclosing status', async () => {
  const f = fixture();
  const reply = await f.start();
  const unknown = f.status({ transferId: 'not-a-job' });
  assert.deepEqual(f.status(reply, 'bob'), unknown);
  assert.deepEqual(f.status({ transferId: 'private-secret'.repeat(1000) }), unknown);
  f.owner = {};
  assert.deepEqual(f.status(reply), unknown);
  assert.equal(f.uploads[0].options.signal.aborted, true);
  f.uploads[0].pending.resolve(success());
  await idle(f.manager);
  assert.deepEqual(f.status(reply), unknown);
  assert.equal(f.events.some((event) => event.event === 'done'), false);
});

test('same-owner credential rotation and consumer/relay absence do not cancel', async () => {
  const f = fixture();
  const reply = await f.start();
  // The owner object remains stable; neither relay connectivity nor consumers are
  // manager inputs. Host must keep these separate from controller policy.
  f.credentialRevision = 2;
  f.relayConnected = false;
  f.consumers = 0;
  f.manager.pruneUnauthorized();
  assert.equal(f.uploads[0].options.signal.aborted, false);
  f.at = 40 * 60 * 1000;
  f.uploads[0].pending.resolve(success());
  await idle(f.manager);
  assert.equal(f.status(reply).state, 'done');
});

test('revocation is per controller, terminal before abort, and late success cannot publish key', async () => {
  const f = fixture();
  const alice = await f.start();
  const bob = await f.start(INPUT, { src: 'bob', id: REQUEST.id });
  f.uploads[0].options.signal.addEventListener('abort', () => {
    assert.equal(f.manager.getStats().error, 1);
    f.uploads[0].options.onProgress(5);
    f.uploads[0].pending.resolve(success());
  });
  f.allowed.delete('alice');
  f.manager.pruneUnauthorized();
  assert.equal(f.status(alice).code, 'NOT_FOUND');
  assert.equal(f.uploads[1].options.signal.aborted, false);
  f.uploads[1].pending.resolve(success());
  await idle(f.manager);
  f.allowed.add('alice');
  assert.equal(f.status(alice).code, 'NOT_FOUND');
  assert.equal(f.status(bob, 'bob').state, 'done');
  assert.equal(f.events.filter((event) => event.event === 'done').length, 1);
});

test('cancel during validation settles start but reserves resources until validation settles', async () => {
  const validation = deferred();
  const f = fixture({ maxActive: 1, resolveSource: () => validation.promise });
  const start = f.start();
  await immediate();
  const invalidated = f.manager.invalidateOwner();
  assert.equal((await start).code, 'OWNER_UNVERIFIED');
  f.owner = {};
  assert.equal((await f.start(INPUT, { ...REQUEST, id: 'two' })).code, 'NOT_AVAILABLE');
  assert.equal(f.manager.getStats().active, 1);
  validation.resolve(resolved());
  await invalidated;
  assert.equal(f.sources.length, 0);
  assert.equal(f.uploads.length, 0);
  assert.deepEqual(f.manager.getStats(), { active: 0, records: 0, uploading: 0, done: 0, error: 0 });
});

test('cancel during pending open closes late descriptor and keeps quotas through slow close', async () => {
  const opening = deferred(), closing = deferred();
  const source = fakeSource(5, { async close() { source.closes++; await closing.promise; } });
  const f = fixture({ maxActive: 1, maxJobs: 1, ttlMs: 1, openSource: () => opening.promise });
  const start = f.start();
  await immediate();
  const invalidated = f.manager.invalidateOwner();
  assert.equal((await start).code, 'OWNER_UNVERIFIED');
  f.owner = {};
  f.at = 1000;
  assert.equal(f.manager.getStats().records, 1);
  opening.resolve(source);
  await immediate();
  assert.equal(source.closes, 1);
  assert.equal(f.uploads.length, 0);
  assert.equal(f.manager.getStats().active, 1);
  assert.equal((await f.start(INPUT, { ...REQUEST, id: 'two' })).code, 'NOT_AVAILABLE');
  closing.resolve();
  await invalidated;
  assert.equal(source.closes, 1);
  assert.equal(f.manager.getStats().records, 0);
});

test('upload cleanup and fd close retain slots after error; no TTL eviction while settling', async () => {
  const cleanup = deferred(), closing = deferred();
  const source = fakeSource(5, {
    async read() { throw new Error('secret path and token'); },
    async close() { source.closes++; await closing.promise; },
  });
  const f = fixture({ maxActive: 1, ttlMs: 1, openSource: async () => source,
    upload: async (readable) => {
      await assert.rejects(readable.read(Buffer.alloc(1), 0), /could not be read/);
      await cleanup.promise;
      return success(); // Deliberately broken uploader must not revive the job.
    },
  });
  const reply = await f.start();
  await immediate();
  assert.equal(f.status(reply).state, 'error');
  assert.equal(f.status(reply).key, undefined);
  f.at = 10000;
  assert.equal(f.manager.getStats().records, 1);
  assert.equal((await f.start(INPUT, { ...REQUEST, id: 'two' })).code, 'NOT_AVAILABLE');
  cleanup.resolve();
  await immediate();
  assert.equal(source.closes, 1);
  assert.equal(f.manager.getStats().active, 1);
  closing.resolve();
  await idle(f.manager);
  assert.equal(f.manager.getStats().records, 0);
});

test('successful upload still holds active quota while descriptor close is pending', async () => {
  const closing = deferred();
  const source = fakeSource(5, { async close() { source.closes++; await closing.promise; } });
  const f = fixture({ maxActive: 1, openSource: async () => source, upload: async () => success() });
  const reply = await f.start();
  await immediate();
  assert.equal(f.status(reply).state, 'uploading');
  assert.equal(f.manager.getStats().active, 1);
  assert.equal((await f.start(INPUT, { ...REQUEST, id: 'two' })).code, 'NOT_AVAILABLE');
  closing.resolve();
  await idle(f.manager);
  assert.equal(f.status(reply).state, 'done');
});

test('stop aborts immediately, hides completed keys and permanently blocks starts', async () => {
  const f = fixture();
  const done = await f.start();
  f.uploads[0].pending.resolve(success());
  await idle(f.manager);
  const running = await f.start(INPUT, { ...REQUEST, id: 'two' });
  const stopped = f.manager.stop();
  assert.equal(f.status(done).code, 'NOT_FOUND');
  assert.equal(f.status(running).code, 'NOT_FOUND');
  assert.equal(f.uploads[1].options.signal.aborted, true);
  assert.equal((await f.start()).code, 'NOT_AVAILABLE');
  f.uploads[1].pending.resolve(success());
  await stopped;
  assert.equal(f.sources[1].closes, 1);
});

test('owner invalidation blocks old owner admission but permits fresh owner after settlement', async () => {
  const f = fixture({ upload: async () => success() });
  const old = await f.start();
  await idle(f.manager);
  await f.manager.invalidateOwner();
  assert.equal((await f.start()).code, 'OWNER_UNVERIFIED');
  f.owner = {};
  const fresh = await f.start();
  await idle(f.manager);
  assert.notEqual(fresh.transferId, old.transferId);
  assert.equal(f.status(old).code, 'NOT_FOUND');
  assert.equal(f.status(fresh).state, 'done');
});

test('all wire errors and diagnostics exclude raw reasons, paths, keys and credentials', async () => {
  const secret = 'PRIVATE_SECRET_TOKEN';
  const f = fixture({ upload: async (_source, options) => {
    options.onEvent({ event: 'put_start', stage: secret, key: secret, token: secret, reason: secret, code: secret });
    options.onEvent({ event: secret, stage: secret });
    return { ok: false, code: secret, reason: secret, stage: secret };
  } });
  const reply = await f.start();
  await idle(f.manager);
  assert.equal(f.status(reply).state, 'error');
  assert.equal(JSON.stringify({ status: f.status(reply), events: f.events }).includes(secret), false);
  assert.equal(JSON.stringify(f.events).includes(INPUT.workdir), false);
  assert.equal(JSON.stringify(f.events).includes('private-object-key'), false);
  for (const emit of [() => { throw new Error(secret); }, async () => { throw new Error(secret); }]) {
    const other = fixture({ emit, upload: async () => success() });
    const ok = await other.start();
    await idle(other.manager);
    assert.equal(other.status(ok).state, 'done');
  }
});

test('old-owner async producer events cannot repopulate diagnostics after account clear', async () => {
  const f = fixture();
  await f.start();
  const uploader = f.uploads[0];
  uploader.options.onEvent({ event: 'put_start', stage: 'put' });
  assert.equal(f.events.at(-1).event, 'put');
  const invalidated = f.manager.invalidateOwner();
  f.owner = {};
  f.events.length = 0;
  uploader.options.onEvent({ event: 'cleanup_done', stage: 'cleanup', key: 'private-key' });
  uploader.options.onProgress(5);
  uploader.pending.resolve(success());
  await invalidated;
  assert.deepEqual(f.events, []);
});

test('cancellation during close suppresses success and retains quota until close settles', async () => {
  const closing = deferred();
  const source = fakeSource(5, { async close() { source.closes++; await closing.promise; } });
  const f = fixture({ maxActive: 1, openSource: async () => source, upload: async () => success() });
  const reply = await f.start();
  await immediate();
  const invalidated = f.manager.invalidateOwner();
  assert.equal(f.manager.getStats().error, 1);
  assert.equal(f.manager.getStats().active, 1);
  f.owner = {};
  assert.equal((await f.start(INPUT, { ...REQUEST, id: 'new' })).code, 'NOT_AVAILABLE');
  assert.equal(f.status(reply).code, 'NOT_FOUND');
  closing.resolve();
  await invalidated;
  assert.equal(source.closes, 1);
  assert.equal(f.manager.getStats().done, 0);
});

test('late successful result is discarded once and holds quotas through cleanup', async () => {
  for (const cancel of ['owner', 'controller', 'stop']) {
    const cleanup = deferred();
    let discards = 0;
    const f = fixture({ maxActive: 1, maxJobs: 1, ttlMs: 1 });
    const reply = await f.start();
    if (cancel === 'owner') { void f.manager.invalidateOwner(); f.owner = {}; }
    else if (cancel === 'controller') { f.allowed.delete('alice'); f.manager.pruneUnauthorized(); }
    else void f.manager.stop();
    f.uploads[0].pending.resolve({ ...success(), async discard() { discards++; await cleanup.promise; } });
    await immediate();
    assert.equal(discards, 1);
    assert.equal(f.sources[0].closes, 1);
    assert.equal(f.manager.getStats().active, 1);
    f.at = 1000;
    assert.equal(f.manager.getStats().records, 1);
    assert.equal(f.status(reply).code, 'NOT_FOUND');
    if (cancel === 'owner') assert.equal((await f.start(INPUT, { ...REQUEST, id: 'new' })).code, 'NOT_AVAILABLE');
    cleanup.resolve();
    await idle(f.manager);
    assert.equal(discards, 1);
    assert.equal(f.manager.getStats().records, 0);
  }
});

test('fd-close failure discards successful unpublished key without replacing original error', async () => {
  let discards = 0;
  const f = fixture({
    openSource: async () => fakeSource(5, { async close() { throw new Error('disk close failure'); } }),
    upload: async () => ({ ...success(), async discard() { discards++; throw new Error('secret cleanup error'); } }),
  });
  const reply = await f.start();
  await idle(f.manager);
  assert.equal(discards, 1);
  assert.equal(f.status(reply).state, 'error');
  assert.equal(f.status(reply).message, 'the export source could not be read');
  assert.equal(f.status(reply).key, undefined);
});

test('uploader owns final verify; published successes and TTL expiration never discard', async () => {
  let returned = false, discards = 0;
  const source = fakeSource(5, { async verify() {
    assert.equal(returned, false, 'no manager re-verification after uploader cleanup boundary');
  } });
  const f = fixture({ ttlMs: 1, openSource: async () => source, upload: async (readable) => {
    await readable.verify();
    returned = true;
    return { ...success(), async discard() { discards++; } };
  } });
  const reply = await f.start();
  await idle(f.manager);
  assert.equal(f.status(reply).state, 'done');
  f.at = 1;
  assert.equal(f.status(reply).code, 'NOT_FOUND');
  assert.equal(discards, 0);
});

test('native uploader type events normalize to fixed diagnostics names with transfer id', async () => {
  const f = fixture();
  const reply = await f.start();
  const { onEvent } = f.uploads[0].options;
  for (const [type, expected] of [['presign', 'presign'], ['refresh', 'presign'], ['put', 'put'],
    ['complete', 'put'], ['error', 'error'], ['cleanup_done', 'cleanup'],
    ['cleanup_failed', 'cleanup'], ['cleanup_skipped_owner', 'cleanup']]) {
    onEvent({ type, stage: 'put', key: 'private-object-key', reason: 'private-reason' });
    const row = f.events.at(-1);
    assert.equal(row.event, expected);
    assert.equal(row.transferId, reply.transferId);
    assert.equal(row.key, undefined);
    assert.equal(row.reason, undefined);
  }
  onEvent({ get type() { throw new Error('producer exception'); } });
  f.uploads[0].pending.resolve(success());
  await idle(f.manager);
  assert.equal(f.status(reply).state, 'done');
});

test('validation/open exceptions release failed reservations and do not retain RPC rejection', async () => {
  for (const stage of ['resolveSource', 'openSource']) {
    let calls = 0;
    const f = fixture({ [stage]: async () => { calls++; throw new Error('sensitive raw error'); } });
    const a = await f.start();
    await idle(f.manager);
    assert.equal(a.ok, false);
    assert.equal(a.message.includes('sensitive'), false);
    assert.equal(f.manager.getStats().records, 0);
    const b = await f.start();
    await idle(f.manager);
    assert.equal(b.ok, false);
    assert.equal(calls, 2);
  }
});

test('invalid uploader successes, verify failures and close failures never publish done', async () => {
  for (const result of [{ ...success(), size: 6 }, { ...success(), key: 'x'.repeat(4097) },
    { ...success(), sha256: 'bad' }, null]) {
    const f = fixture({ upload: async () => result });
    const reply = await f.start();
    await idle(f.manager);
    assert.equal(f.status(reply).state, 'error');
    assert.equal(f.status(reply).key, undefined);
    assert.equal(f.sources[0].closes, 1);
  }
  for (const stage of ['verify', 'close']) {
    let checks = 0;
    const source = fakeSource(5, { [stage]: async () => {
      if (stage === 'close' || checks++ > 0) throw new Error('source changed');
    } });
    const f = fixture({ openSource: async () => source, upload: async (readable) => { await readable.verify(); return success(); } });
    const reply = await f.start();
    await idle(f.manager);
    assert.equal(f.status(reply).state, 'error');
    assert.equal(f.status(reply).key, undefined);
  }
});

async function realFixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'host-export-jobs-'));
  const real = path.join(root, 'source.bin');
  const bytes = Buffer.from('bounded disk source fixture');
  await fs.writeFile(real, bytes);
  const f = fixture({
    openSource: undefined,
    resolveSource: async () => ({ ok: true, real, info: await fs.stat(real) }),
    ...overrides,
  });
  t.after(async () => { await f.manager.stop(); await fs.rm(root, { recursive: true, force: true }); });
  return { ...f, root, real, bytes };
}

test('real safe fd source supports positional bounded reads, hash and successful verify', async (t) => {
  let actual;
  const f = await realFixture(t, { upload: async (source, { onProgress }) => {
    const hash = createHash('sha256');
    const blocks = [];
    let offset = 0;
    const buffer = Buffer.alloc(7);
    while (offset < source.size) {
      const count = await source.read(buffer, offset);
      hash.update(buffer.subarray(0, count));
      blocks.push(Buffer.from(buffer.subarray(0, count)));
      offset += count;
      onProgress(offset);
    }
    assert.equal(await source.read(buffer, offset), 0);
    await source.verify();
    actual = Buffer.concat(blocks); // tiny fixture only, never production upload.
    return { ok: true, key: 'safe-key', size: offset, sha256: hash.digest('hex') };
  } });
  const reply = await f.start();
  await idle(f.manager);
  assert.deepEqual(actual, f.bytes);
  assert.equal(f.status(reply).state, 'done');
});

test('real default open rejects replaced identity even with identical size and mtime', async (t) => {
  const f = await realFixture(t);
  const old = await fs.stat(f.real);
  await fs.rename(f.real, path.join(f.root, 'original.bin'));
  await fs.writeFile(f.real, f.bytes);
  await fs.utimes(f.real, old.atime, old.mtime);
  const other = fixture({ openSource: undefined, resolveSource: async () => ({ ok: true, real: f.real, info: old }) });
  assert.equal((await other.start()).code, 'SOURCE_CHANGED');
  await idle(other.manager);
  assert.equal(other.uploads.length, 0);
});

test('real default open rejects final symlink even to the authorized inode', async (t) => {
  const f = await realFixture(t);
  const link = path.join(f.root, 'link.bin');
  try { await fs.symlink(f.real, link, 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('file symlink privilege unavailable'); return; } throw error; }
  const other = fixture({ openSource: undefined, resolveSource: async () => ({ ok: true, real: link, info: await fs.stat(f.real) }) });
  assert.equal((await other.start()).code, 'SOURCE_CHANGED');
  await idle(other.manager);
  assert.equal(other.uploads.length, 0);
});

test('real default open rejects directory even if resolver claims regular file', async (t) => {
  const f = await realFixture(t);
  const stats = await fs.stat(f.root);
  const other = fixture({ openSource: undefined, resolveSource: async () => ({ ok: true, real: f.root, info: { ...stats, isFile: () => true } }) });
  assert.equal((await other.start()).code, 'SOURCE_CHANGED');
  await idle(other.manager);
});

test('real source growth/truncation after open fails verify and never publishes a key', async (t) => {
  for (const mutate of [async (file) => fs.appendFile(file, 'growth'), async (file) => fs.truncate(file, 0)]) {
    const f = await realFixture(t);
    const reply = await f.start();
    await mutate(f.real);
    const uploader = f.uploads[0];
    await assert.rejects(uploader.source.verify(), /source changed/);
    assert.equal(uploader.options.signal.aborted, true);
    uploader.pending.resolve(success(f.bytes.length));
    await idle(f.manager);
    assert.equal(f.status(reply).state, 'error');
    assert.equal(f.status(reply).key, undefined);
  }
});
