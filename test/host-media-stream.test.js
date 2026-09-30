import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createFileMediaUploader } from '../src/host-media.js';

const CHUNK = 64 * 1024;
const LIMIT = 2 * 1024 * 1024 * 1024;
const owner = Object.freeze({ runtimeId: 'test', epoch: 1, realm: 'test', userId: 'original' });
const credential = { session: { accessToken: 'synthetic-original' }, lease: {} };
const signed = { key: 'synthetic-key', putUrl: 'https://oss.invalid/object?signed=synthetic' };
const never = () => new Promise(() => {});
const turn = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function source(size, { actualSize = size, maxRead = CHUNK, failRead = -1, failVerify = -1 } = {}) {
  const state = { reads: 0, verifies: 0, closes: 0, maxBuffer: 0, positions: [] };
  return {
    size, state,
    async read(buffer, position) {
      state.reads += 1;
      state.maxBuffer = Math.max(state.maxBuffer, buffer.length);
      // Keep test bookkeeping bounded even for a full synthetic 2GiB upload.
      if (state.positions.length < 12) state.positions.push(position);
      if (state.reads === failRead) throw new Error('SECRET path/token/read error');
      const count = Math.max(0, Math.min(buffer.length, maxRead, actualSize - position));
      buffer.fill(0x61, 0, count);
      return count;
    },
    async verify() {
      state.verifies += 1;
      if (state.verifies === failVerify) throw new Error('SECRET source identity');
    },
    close() { state.closes += 1; throw new Error('Manager alone owns fd'); },
  };
}
async function consume(body) {
  const hash = createHash('sha256');
  let size = 0;
  let chunks = 0;
  for await (const chunk of body) {
    assert.ok(Buffer.isBuffer(chunk));
    assert.ok(chunk.length > 0 && chunk.length <= CHUNK);
    hash.update(chunk);
    size += chunk.length;
    chunks += 1;
  }
  return { size, chunks, sha256: hash.digest('hex') };
}
function harness(overrides = {}) {
  const state = { fetches: [], puts: [], owners: [], refreshes: [], events: [], progress: [], consumed: null };
  const options = {
    apiBaseUrl: 'https://api.invalid/device-link',
    getCredential(wanted) { state.owners.push(wanted); return credential; },
    async refreshCredential(old) { state.refreshes.push(old); return credential; },
    async fetchImpl(url, init) {
      state.fetches.push({ url, ...init });
      return { ok: true, status: 200, json: async () => signed };
    },
    async putImpl(url, init) {
      state.puts.push({ url, ...init });
      state.consumed = await consume(init.body);
      return { ok: true, status: 200 };
    },
    ...overrides,
  };
  const upload = createFileMediaUploader(options);
  const run = (file, opts = {}) => upload(file, {
    owner, onEvent: (event) => state.events.push(event), onProgress: (bytes) => state.progress.push(bytes), ...opts,
  });
  return { state, run, options };
}
function clock() {
  let now = 0;
  let next = 1;
  const timers = new Map();
  return {
    timers,
    setTimeoutImpl(callback, delay) { const id = next++; timers.set(id, { at: now + delay, callback, delay }); return id; },
    clearTimeoutImpl(id) { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].callback();
      }
      now = end;
    },
    get now() { return now; },
  };
}
const timerOptions = (c) => ({ setTimeoutImpl: c.setTimeoutImpl, clearTimeoutImpl: c.clearTimeoutImpl });
function failed(result, code, stage) {
  assert.equal(result.ok, false);
  assert.equal(result.code, code);
  if (stage) assert.equal(result.stage, stage);
  assert.deepEqual(Object.keys(result).sort(), ['code', 'ok', 'reason', 'stage']);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|synthetic-key|synthetic-original|signed=/);
}

for (const size of [0, 1, CHUNK - 1, CHUNK, CHUNK + 7]) {
  test('incrementally uploads and hashes exact size ' + size, async () => {
    const h = harness();
    const file = source(size);
    const result = await h.run(file);
    const { discard, ...published } = result;
    assert.equal(typeof discard, 'function');
    assert.deepEqual(published, { ok: true, key: signed.key, size, sha256: h.state.consumed.sha256 });
    assert.equal(result.sha256, createHash('sha256').update(Buffer.alloc(size, 0x61)).digest('hex'));
    assert.equal(h.state.consumed.size, size);
    assert.equal(file.state.verifies, 3);
    assert.equal(file.state.closes, 0);
    assert.ok(file.state.maxBuffer <= CHUNK);
    assert.equal(h.state.fetches.length, 1);
    assert.equal(h.state.puts.length, 1);
    assert.deepEqual(h.state.owners, [owner]);
    if (size) assert.equal(h.state.progress.at(-1), size);
    assert.deepEqual(h.state.events.map((event) => event.type), ['presign', 'put', 'complete']);
    assert.equal(h.state.puts[0].headers['Content-Length'], String(size));
  });
}

test('2GiB inclusive streams all bytes without whole-file allocation', async () => {
  const h = harness();
  const file = source(LIMIT);
  const result = await h.run(file);
  assert.equal(result.ok, true);
  assert.equal(result.size, LIMIT);
  assert.equal(h.state.consumed.size, LIMIT);
  assert.equal(h.state.consumed.chunks, LIMIT / CHUNK);
  assert.equal(result.sha256, h.state.consumed.sha256);
  assert.equal(file.state.maxBuffer, CHUNK);
  assert.equal(file.state.reads, LIMIT / CHUNK + 1);
  assert.equal(file.state.closes, 0);
});

test('sizing and caller validation reject before any verification or network', async () => {
  for (const size of [-1, 1.5, NaN, Infinity, '1', LIMIT + 1, Number.MAX_SAFE_INTEGER + 1]) {
    const h = harness();
    const file = source(size);
    failed(await h.run(file), Number.isSafeInteger(size) && size > LIMIT ? 'OVERSIZE' : 'INVALID_ARGUMENT');
    assert.equal(file.state.verifies, 0);
    assert.equal(h.state.fetches.length, 0);
  }
  for (const opts of [{ owner: null }, { signal: {} }, { ext: '../secret' }, { contentType: 'text/plain\r\nInjected: true' }]) {
    const h = harness();
    failed(await h.run(source(1), opts), 'INVALID_ARGUMENT');
    assert.equal(h.state.fetches.length, 0);
  }
  for (const duration of [0, -1, Infinity, 2 ** 31]) {
    const h = harness({ idleTimeoutMs: duration });
    failed(await h.run(source(1)), 'INVALID_ARGUMENT');
  }
  const h = harness();
  failed(await h.run({ size: 1, read: async () => 0 }), 'INVALID_ARGUMENT');
});

for (const [ext, contentType, expectedExt, expectedType] of [
  ['.APK', 'application/vnd.android.package-archive', 'bin', 'application/octet-stream'],
  ['ipa', 'application/x-itunes-ipa', 'bin', 'application/octet-stream'],
  ['zip', 'application/vnd.android.package-archive; charset=binary', 'zip', 'application/octet-stream'],
  ['txt', 'text/plain', 'txt', 'text/plain'],
]) {
  test('preserves staging and private signed headers for ' + ext, async () => {
    const h = harness();
    assert.equal((await h.run(source(3), { ext, contentType })).ok, true);
    assert.deepEqual(JSON.parse(h.state.fetches[0].body), { size: 3, ext: expectedExt, contentType: expectedType });
    assert.equal(h.state.fetches[0].url, 'https://api.invalid/device-link/media/presign-put');
    assert.equal(h.state.fetches[0].headers.Authorization, 'Bearer synthetic-original');
    assert.deepEqual(h.state.puts[0].headers, { 'Content-Type': expectedType, 'Content-Length': '3', 'x-oss-object-acl': 'private' });
    assert.equal(h.state.puts[0].url, signed.putUrl);
  });
}

test('partial reads advance exact positions and preserve hash', async () => {
  const h = harness();
  const file = source(19, { maxRead: 3 });
  const result = await h.run(file);
  assert.equal(result.ok, true);
  assert.deepEqual(file.state.positions, [0, 3, 6, 9, 12, 15, 18, 19]);
  assert.equal(result.sha256, createHash('sha256').update('a'.repeat(19)).digest('hex'));
});

for (const [name, settings, code] of [
  ['truncated', { actualSize: 4 }, 'SIZE_MISMATCH'],
  ['grown', { actualSize: 12 }, 'SIZE_MISMATCH'],
  ['read throws', { failRead: 1 }, 'SOURCE_READ_FAILED'],
  ['post-read verify fails', { failVerify: 2 }, 'SOURCE_CHANGED'],
]) {
  test(name + ' invalidates source and cleans unpublished key exactly once', async () => {
    const h = harness();
    const file = source(8, settings);
    failed(await h.run(file), code, 'put');
    assert.equal(h.state.fetches.length, 2);
    assert.equal(h.state.fetches[1].method, 'DELETE');
    assert.deepEqual(JSON.parse(h.state.fetches[1].body), { key: signed.key });
    assert.deepEqual(h.state.owners, [owner, owner]);
    assert.equal(h.state.puts.length, 1);
    assert.equal(h.state.puts[0].signal.aborted, true);
    assert.equal(file.state.closes, 0);
  });
}

test('invalid read counts are sanitized failures', async () => {
  for (const count of [-1, 0.5, 9, undefined]) {
    const h = harness();
    const file = source(8);
    file.read = async () => count;
    failed(await h.run(file), 'SOURCE_READ_FAILED');
  }
});

test('initial snapshot failure never signs', async () => {
  const h = harness();
  failed(await h.run(source(1, { failVerify: 1 })), 'SOURCE_CHANGED', 'verify');
  assert.equal(h.state.fetches.length, 0);
});

test('early HTTP200 does not publish, including unconsumed zero-byte body', async () => {
  for (const size of [0, 1, CHUNK * 3]) {
    let body;
    let signal;
    const h = harness({ putImpl: async (_url, init) => {
      ({ body, signal } = init);
      if (size) await body.next();
      return { ok: true, status: 200 };
    } });
    const file = source(size);
    failed(await h.run(file), 'INCOMPLETE_UPLOAD', 'put');
    assert.equal(signal.aborted, true);
    assert.equal((await body.next()).done, true);
    assert.equal(h.state.fetches.filter((call) => call.method === 'DELETE').length, 1);
    assert.ok(file.state.reads <= 1);
  }
});

test('transport swallowing source failure and returning 200 cannot revive upload', async () => {
  const h = harness({ putImpl: async (_url, { body }) => {
    try { await consume(body); } catch { /* malicious early success double */ }
    return { ok: true, status: 200 };
  } });
  failed(await h.run(source(1, { failRead: 1 })), 'SOURCE_READ_FAILED');
});

for (const status of [401, 403, 500, 302]) {
  test('PUT ' + status + ' is never retried or refreshed', async () => {
    let puts = 0;
    const h = harness({ putImpl: async (_url, { body }) => {
      puts += 1;
      await consume(body);
      return { ok: false, status };
    } });
    failed(await h.run(source(7)), 'PUT_FAILED', 'put');
    assert.equal(puts, 1);
    assert.equal(h.state.refreshes.length, 0);
    assert.equal(h.state.fetches.filter((call) => call.method === 'POST').length, 1);
    assert.equal(h.state.fetches.filter((call) => call.method === 'DELETE').length, 1);
  });
}

test('PUT network rejection sanitized; cleanup rejection cannot replace it', async () => {
  let fetches = 0;
  let puts = 0;
  const h = harness({
    fetchImpl: async () => { if (++fetches > 1) throw new Error('SECRET cleanup URL'); return { ok: true, json: async () => signed }; },
    putImpl: async () => { puts += 1; throw new Error('SECRET signed URL token'); },
  });
  failed(await h.run(source(1)), 'NETWORK_ERROR', 'put');
  assert.equal(puts, 1);
  assert.equal(fetches, 2);
  assert.ok(h.state.events.some((event) => event.type === 'cleanup_failed'));
  assert.doesNotMatch(JSON.stringify(h.state.events), /SECRET|synthetic/);
});

test('presign401 refreshes captured credential once then signs with returned lease', async () => {
  const renewed = { session: { accessToken: 'synthetic-renewed' }, lease: {} };
  let signs = 0;
  let refreshes = 0;
  const h = harness({
    fetchImpl: async (_url, init) => {
      signs += 1;
      assert.equal(init.headers.Authorization, signs === 1 ? 'Bearer synthetic-original' : 'Bearer synthetic-renewed');
      return signs === 1 ? { ok: false, status: 401 } : { ok: true, json: async () => signed };
    },
    refreshCredential: async (captured) => { refreshes += 1; assert.equal(captured, credential); return renewed; },
  });
  assert.equal((await h.run(source(1))).ok, true);
  assert.equal(signs, 2);
  assert.equal(refreshes, 1);
  assert.deepEqual(h.state.owners, [owner]);
});

test('second presign401 terminates; non401 never refreshes', async () => {
  for (const status of [401, 403, 500]) {
    let signs = 0;
    const h = harness({ fetchImpl: async () => { signs += 1; return { ok: false, status }; } });
    failed(await h.run(source(1)), status === 401 ? 'AUTH_FAILED' : 'PRESIGN_FAILED', 'presign');
    assert.equal(signs, status === 401 ? 2 : 1);
    assert.equal(h.state.refreshes.length, status === 401 ? 1 : 0);
    assert.equal(h.state.puts.length, 0);
  }
});

test('unknown owner and refused refresh cannot proceed or borrow live session', async () => {
  const h = harness({ getCredential: () => null, getSession: () => { throw new Error('must not use'); } });
  failed(await h.run(source(1)), 'OWNER_UNVERIFIED', 'credential');
  assert.equal(h.state.fetches.length, 0);
  for (const refreshCredential of [async () => null, async () => { throw new Error('SECRET'); }]) {
    const rejected = harness({ fetchImpl: async () => ({ ok: false, status: 401 }), refreshCredential });
    failed(await rejected.run(source(1)), 'OWNER_UNVERIFIED', 'refresh');
    assert.equal(rejected.state.puts.length, 0);
  }
});

test('owner replacement during failure skips cleanup rather than using new owner', async () => {
  let calls = 0;
  const h = harness({
    getCredential(wanted) { assert.equal(wanted, owner); return ++calls === 1 ? credential : null; },
    putImpl: async () => { throw new Error('failure'); },
  });
  failed(await h.run(source(1)), 'NETWORK_ERROR');
  assert.equal(h.state.fetches.length, 1);
  assert.ok(h.state.events.some((event) => event.type === 'cleanup_skipped_owner'));
});

test('cleanup may reacquire refreshed lease only under captured original owner', async () => {
  let calls = 0;
  const h = harness({
    getCredential(wanted) { assert.equal(wanted, owner); return ++calls === 1 ? credential : { session: { accessToken: 'same-owner-renewed' }, lease: {} }; },
    putImpl: async () => { throw new Error('failure'); },
  });
  failed(await h.run(source(1)), 'NETWORK_ERROR');
  assert.equal(h.state.fetches[1].headers.Authorization, 'Bearer same-owner-renewed');
  assert.equal(h.state.refreshes.length, 0);
});

test('already aborted caller never verifies or sends network calls', async () => {
  const aborter = new AbortController();
  aborter.abort(new Error('SECRET caller reason'));
  const h = harness();
  const file = source(1);
  failed(await h.run(file, { signal: aborter.signal }), 'ABORTED');
  assert.equal(file.state.verifies, 0);
  assert.equal(h.state.fetches.length, 0);
});

test('abort during pending source read stops body; late data cannot publish progress', async () => {
  const read = deferred();
  const entered = deferred();
  const aborter = new AbortController();
  const h = harness();
  const file = source(8);
  file.read = async (buffer) => { entered.resolve(); await read.promise; buffer.fill(0x61); return 8; };
  const result = h.run(file, { signal: aborter.signal });
  await entered.promise;
  aborter.abort(new Error('SECRET cancellation'));
  failed(await result, 'ABORTED');
  read.resolve();
  await turn();
  assert.deepEqual(h.state.progress, []);
  assert.equal(file.state.closes, 0);
  assert.equal(h.state.fetches.length, 2);
});

test('abort synchronously at final progress wins over later HTTP200', async () => {
  const aborter = new AbortController();
  const h = harness();
  failed(await h.run(source(8), { signal: aborter.signal, onProgress: () => aborter.abort() }), 'ABORTED');
  assert.equal(h.state.events.some((event) => event.type === 'complete'), false);
});

test('callback exceptions do not alter transfer or reveal data', async () => {
  const h = harness();
  const fail = () => { throw new Error('observer failed'); };
  assert.equal((await h.run(source(8), { onProgress: fail, onEvent: fail })).ok, true);
});

test('backpressure reads exactly one chunk per consumer pull', async () => {
  const gate = deferred();
  const entered = deferred();
  const file = source(CHUNK * 4);
  const h = harness({ putImpl: async (_url, { body }) => {
    const first = await body.next();
    assert.equal(first.value.length, CHUNK);
    entered.resolve();
    await gate.promise;
    assert.equal(file.state.reads, 1);
    await consume(body);
    return { ok: true, status: 200 };
  } });
  const upload = h.run(file);
  await entered.promise;
  await turn();
  assert.equal(file.state.reads, 1);
  gate.resolve();
  assert.equal((await upload).ok, true);
});

test('stage timeout bounds stalled verify/presign/refresh including JSON body', async () => {
  for (const stage of ['verify', 'presign', 'json', 'refresh']) {
    const c = clock();
    const entered = deferred();
    const stall = () => { entered.resolve(); return never(); };
    const h = harness({ ...timerOptions(c),
      ...(stage === 'presign' ? { fetchImpl: stall } : {}),
      ...(stage === 'json' ? { fetchImpl: async () => ({ ok: true, json: stall }) } : {}),
      ...(stage === 'refresh' ? { fetchImpl: async () => ({ ok: false, status: 401 }), refreshCredential: stall } : {}),
    });
    const file = source(1);
    if (stage === 'verify') file.verify = stall;
    const upload = h.run(file);
    await entered.promise;
    c.advance(30_000);
    failed(await upload, 'STAGE_TIMEOUT', stage === 'json' ? 'presign' : stage);
    assert.equal(c.timers.size, 0);
  }
});

test('idle timeout bounds stalled source, consumer and final HTTP response', async () => {
  for (const stage of ['source', 'consumer', 'response']) {
    const c = clock();
    const entered = deferred();
    const h = harness({ ...timerOptions(c), putImpl: async (_url, { body }) => {
      if (stage === 'response') await consume(body);
      if (stage === 'source') { await body.next(); return { ok: true }; }
      entered.resolve();
      return never();
    } });
    const file = source(8);
    if (stage === 'source') file.read = () => { entered.resolve(); return never(); };
    const upload = h.run(file);
    await entered.promise;
    c.advance(60_000);
    failed(await upload, 'IDLE_TIMEOUT', 'put');
    assert.equal(c.timers.size, 0);
    assert.equal(h.state.fetches.length, 2);
  }
});

test('cleanup including credential lookup has one capped 5s budget and no retry', async () => {
  for (const where of ['credential', 'delete']) {
    const c = clock();
    const entered = deferred();
    let credentials = 0;
    let deletes = 0;
    let cleanupSignal;
    const h = harness({ ...timerOptions(c), cleanupTimeoutMs: 60_000,
      getCredential: () => {
        credentials += 1;
        if (where === 'credential' && credentials > 1) { entered.resolve(); return never(); }
        return credential;
      },
      fetchImpl: async (_url, init) => {
        if (init.method === 'DELETE') { deletes += 1; cleanupSignal = init.signal; entered.resolve(); return never(); }
        return { ok: true, json: async () => signed };
      },
      putImpl: async () => { throw new Error('SECRET original'); },
    });
    const upload = h.run(source(1));
    await entered.promise;
    assert.deepEqual([...c.timers.values()].map((timer) => timer.delay), [5000]);
    c.advance(5000);
    failed(await upload, 'NETWORK_ERROR', 'put');
    assert.equal(credentials, 2);
    assert.equal(deletes, where === 'delete' ? 1 : 0);
    if (cleanupSignal) assert.equal(cleanupSignal.aborted, true);
    assert.equal(c.timers.size, 0);
  }
});

test('invalid presign URL cleans known key; refusal body is discarded', async () => {
  let deletes = 0;
  const h = harness({ fetchImpl: async (_url, init) => {
    if (init.method === 'DELETE') { deletes += 1; return { ok: true }; }
    return { ok: true, json: async () => ({ key: signed.key, putUrl: 'file:///secret' }) };
  } });
  failed(await h.run(source(1)), 'PRESIGN_FAILED');
  assert.equal(deletes, 1);
  let canceled = 0;
  const refusal = harness({ fetchImpl: async () => ({ ok: false, status: 403, body: { cancel() { canceled += 1; } } }) });
  failed(await refusal.run(source(1)), 'PRESIGN_FAILED');
  assert.equal(canceled, 1);
});

// No socket/server or real network: exercise the actual native transport using
// Node's request shape, independently controlled writes and response callbacks.
function nativeRequestFake({ beforeWrite = async () => {}, respond = true, early = false } = {}) {
  const state = { request: null, options: null, writes: 0, queued: 0, peak: 0, bytes: 0, responseDestroyed: false };
  const requestImpl = (_url, options, onResponse) => {
    state.options = options;
    const request = new EventEmitter();
    state.request = request;
    const response = () => onResponse({ statusCode: 200, destroy() { state.responseDestroyed = true; } });
    request.destroyed = false;
    request.destroy = () => { if (!request.destroyed) { request.destroyed = true; queueMicrotask(() => request.emit('close')); } };
    request.write = (chunk, callback) => {
      state.writes += 1;
      state.queued += chunk.length;
      state.peak = Math.max(state.peak, state.queued);
      const length = chunk.length;
      Promise.resolve().then(() => beforeWrite(chunk)).then(() => {
        state.queued -= length;
        state.bytes += length;
        callback();
      }, callback);
      return false; // All writes exert backpressure.
    };
    request.end = () => { if (respond) queueMicrotask(response); };
    if (early) queueMicrotask(response);
    return request;
  };
  return { state, requestImpl };
}

test('native PUT has bounded write queue and no fixed header/total deadline past ten minutes', async () => {
  const c = clock();
  const native = nativeRequestFake({ beforeWrite: async () => { c.advance(31_000); } });
  const h = harness({ ...timerOptions(c), putImpl: undefined, requestImpl: native.requestImpl });
  const file = source(CHUNK * 21);
  const result = await h.run(file);
  assert.equal(result.ok, true);
  assert.equal(c.now, 651_000);
  assert.equal(native.state.options.timeout, 0);
  assert.equal(native.state.options.agent, false);
  assert.equal(native.state.options.method, 'PUT');
  assert.equal(native.state.options.headers['Content-Length'], String(file.size));
  assert.equal(native.state.bytes, file.size);
  assert.equal(native.state.peak, CHUNK);
  assert.equal(native.state.request.destroyed, true);
  assert.equal(native.state.responseDestroyed, true);
  assert.equal(c.timers.size, 0);
});

test('native stalled write abort destroys request and does not read ahead', async () => {
  const c = clock();
  const entered = deferred();
  const native = nativeRequestFake({ beforeWrite: () => { entered.resolve(); return never(); } });
  const h = harness({ ...timerOptions(c), putImpl: undefined, requestImpl: native.requestImpl });
  const file = source(CHUNK * 4);
  const upload = h.run(file);
  await entered.promise;
  assert.equal(file.state.reads, 1);
  c.advance(60_000);
  failed(await upload, 'IDLE_TIMEOUT');
  assert.equal(native.state.request.destroyed, true);
  assert.equal(file.state.reads, 1);
  assert.equal(c.timers.size, 0);
});

test('native early200 destroys response/socket and does not publish', async () => {
  const native = nativeRequestFake({ early: true });
  const h = harness({ putImpl: undefined, requestImpl: native.requestImpl });
  failed(await h.run(source(CHUNK * 4)), 'INCOMPLETE_UPLOAD');
  assert.equal(native.state.request.destroyed, true);
  assert.equal(native.state.responseDestroyed, true);
});

test('unpublished success discard is bounded, idempotent and still owner-bound', async () => {
  const h = harness();
  const result = await h.run(source(17));
  assert.equal(result.ok, true);
  await Promise.all([result.discard(), result.discard()]);
  assert.equal(h.state.fetches.filter(call => call.method === 'DELETE').length, 1);
  assert.deepEqual(h.state.owners, [owner, owner]);
});

test('source mutation while awaiting HTTP success cleans the unpublished object', async () => {
  const h = harness();
  const result = await h.run(source(17, { failVerify: 3 }));
  failed(result, 'SOURCE_CHANGED', 'put');
  assert.equal(h.state.fetches.filter(call => call.method === 'DELETE').length, 1);
});


test('signing metadata is bounded and legacy url alias remains compatible', async () => {
  const good = harness({ fetchImpl: async () => new Response(JSON.stringify({ key: signed.key, url: signed.putUrl })) });
  assert.equal((await good.run(source(3))).ok, true);
  const huge = harness({ fetchImpl: async () => new Response(JSON.stringify({ ...signed, padding: 'x'.repeat(65536) })) });
  const result = await huge.run(source(3));
  failed(result, 'PRESIGN_FAILED', 'presign');
  assert.equal(huge.state.puts.length, 0);
});

