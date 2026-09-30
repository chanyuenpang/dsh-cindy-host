/**
 * Real loopback-only acceptance for native streamed PUT. No cloud credentials,
 * production calls, source files, or whole-payload buffers. Sender and receiver
 * share this test process, so reported memory INCLUDES both HTTP stacks.
 *
 * Normal: node --expose-gc --test test/host-media-http.test.js
 * Long: CINDY_STREAM_LONG_HTTP=1 node --expose-gc --test
 *       --test-name-pattern="long real-wall" test/host-media-http.test.js
 * The opt-in long test takes ~11 minutes of actual wall time, NOT fake time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createFileMediaUploader } from '../src/host-media.js';

const MiB = 1024 * 1024;
const CHUNK = 64 * 1024;
const owner = Object.freeze({ runtimeId: 'loopback-test', epoch: 1, realm: 'local-test', userId: 'synthetic' });
const credential = Object.freeze({ session: { accessToken: 'fake-local-test-only' }, lease: {} });
const fields = ['rss', 'external', 'arrayBuffers'];
const memory = () => Object.fromEntries(fields.map((name) => [name, process.memoryUsage()[name]]));
const mib = (values) => Object.fromEntries(fields.map((name) => [name, Math.round(values[name] / MiB * 100) / 100]));
function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
async function within(promise, ms = 5000) {
  const controller = new AbortController();
  try {
    return await Promise.race([promise, delay(ms, undefined, { signal: controller.signal }).then(() => { throw new Error('Local fixture timed out'); })]);
  } finally { controller.abort(); }
}

async function fixture({ bytesPerSecond = Infinity, hold = false } = {}) {
  const entered = deferred();
  const stopped = deferred();
  const sockets = new Set();
  const state = {
    received: 0, chunks: 0, headers: null, hash: null, request: null,
    errors: [], completed: false, startedAt: 0, maxIncomingChunk: 0,
  };
  const lifetime = new AbortController();
  const server = createServer((request, response) => {
    if (request.method !== 'PUT' || request.url !== '/synthetic-object?signature=local-only') {
      response.writeHead(404).end();
      return;
    }
    state.request = request;
    state.headers = request.headers;
    state.startedAt = performance.now();
    request.once('aborted', () => stopped.resolve());
    request.once('close', () => stopped.resolve());
    entered.resolve();
    if (hold) { request.pause(); return; }
    (async () => {
      const hash = createHash('sha256');
      for await (const chunk of request) {
        assert.ok(chunk.length <= CHUNK * 2, 'Incoming HTTP buffers remain bounded');
        state.maxIncomingChunk = Math.max(state.maxIncomingChunk, chunk.length);
        state.received += chunk.length;
        state.chunks += 1;
        hash.update(chunk);
        if (Number.isFinite(bytesPerSecond)) {
          // A byte-budget schedule avoids assuming a network chunk size. Only
          // sleep when >2ms behind the budget; queues remain truly socket-bound.
          const due = state.received / bytesPerSecond * 1000;
          const wait = due - (performance.now() - state.startedAt);
          if (wait >= 2) await delay(wait, undefined, { signal: lifetime.signal });
        }
      }
      state.hash = hash.digest('hex');
      state.completed = true;
      response.writeHead(200, { 'content-length': '0' }).end();
    })().catch((error) => {
      if (!lifetime.signal.aborted && !request.aborted) state.errors.push(String(error));
      response.destroy();
    });
  });
  // The server fixture must not impose Node's default total request timeout on
  // this deliberately long upload. It owns only an ephemeral loopback listener.
  server.requestTimeout = 0;
  server.timeout = 0;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  return {
    state, entered: entered.promise, stopped: stopped.promise,
    url: 'http://127.0.0.1:' + address.port + '/synthetic-object?signature=local-only',
    async close() {
      lifetime.abort();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function generatedSource(size) {
  const hash = createHash('sha256');
  const state = { bytes: 0, reads: 0, verifies: 0, maxBuffer: 0, hash: null, completedAt: 0, closed: false };
  return {
    size, state,
    async read(buffer, position) {
      assert.equal(position, state.bytes);
      assert.ok(buffer.length <= CHUNK);
      state.maxBuffer = Math.max(state.maxBuffer, buffer.length);
      state.reads += 1;
      const count = Math.min(buffer.length, size - position);
      // Different chunks differ: catches lost/reordered/chopped network data.
      buffer.fill(Math.floor(position / CHUNK) % 251, 0, count);
      if (count) hash.update(buffer.subarray(0, count));
      state.bytes += count;
      return count;
    },
    async verify() {
      state.verifies += 1;
      if (state.verifies === 2) {
        assert.equal(state.bytes, size);
        state.hash = hash.digest('hex');
        state.completedAt = performance.now();
      }
    },
    close() { state.closed = true; throw new Error('Uploader must not close job-owned source'); },
  };
}

function localUploader(http, state) {
  return createFileMediaUploader({
    apiBaseUrl: 'http://signing.invalid/local-only',
    getCredential(expectedOwner) { assert.equal(expectedOwner, owner); return credential; },
    // Signing/cleanup are isolated fakes: only the PUT opens a socket.
    async fetchImpl(url, init) {
      assert.ok(url.startsWith('http://signing.invalid/'));
      assert.equal(init.headers.Authorization, 'Bearer fake-local-test-only');
      if (init.method === 'DELETE') { state.deletes += 1; return { ok: true }; }
      assert.equal(init.method, 'POST');
      state.presigns += 1;
      state.signBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ key: 'local-synthetic-key', putUrl: http.url }) };
    },
    // Instrument ONLY the real request's bounded writable queue. Actual native
    // socket, write callbacks, backpressure and response timing stay unmocked.
    requestImpl(url, options, onResponse) {
      assert.equal(options.timeout, 0);
      assert.equal(options.agent, false);
      const request = httpRequest(url, options, onResponse);
      const write = request.write;
      request.write = function (chunk, ...args) {
        state.maxWriteChunk = Math.max(state.maxWriteChunk, chunk.length);
        const result = write.call(this, chunk, ...args);
        state.maxWritable = Math.max(state.maxWritable, this.writableLength);
        return result;
      };
      return request;
    },
  });
}

async function transfer(size, { bytesPerSecond = 96 * MiB, signal, ext = 'dat', contentType = 'application/octet-stream' } = {}) {
  global.gc?.();
  const baseline = memory();
  const peak = { ...baseline };
  const http = await fixture({ bytesPerSecond });
  const file = generatedSource(size);
  const state = { presigns: 0, deletes: 0, maxWriteChunk: 0, maxWritable: 0, maxLead: 0, progress: 0 };
  const startedAt = performance.now();
  const sample = () => {
    const current = memory();
    for (const name of fields) peak[name] = Math.max(peak[name], current[name]);
    state.maxLead = Math.max(state.maxLead, file.state.bytes - http.state.received);
  };
  const sampler = setInterval(sample, 20);
  try {
    const result = await localUploader(http, state)(file, {
      owner, signal, ext, contentType,
      onProgress(bytes) {
        assert.ok(bytes >= state.progress);
        state.progress = bytes;
        if (bytes % MiB === 0) sample();
      },
    });
    sample();
    const elapsedMs = performance.now() - startedAt;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.size, size);
    assert.equal(result.sha256, file.state.hash);
    assert.equal(result.sha256, http.state.hash);
    assert.equal(http.state.received, size);
    assert.equal(http.state.completed, true);
    assert.deepEqual(http.state.errors, []);
    assert.equal(http.state.headers['content-length'], String(size));
    assert.equal(http.state.headers['transfer-encoding'], undefined);
    assert.equal(http.state.headers['x-oss-object-acl'], 'private');
    assert.equal(http.state.headers['content-type'], state.signBody.contentType);
    assert.equal(http.state.headers.authorization, undefined);
    assert.equal(state.signBody.size, size);
    assert.equal(state.presigns, 1);
    assert.equal(state.deletes, 0);
    assert.equal(file.state.verifies, 3); // pre-sign, EOF, final HTTP completion
    assert.equal(file.state.closed, false);
    assert.ok(state.maxWriteChunk <= CHUNK);
    // First writableLength includes <1KiB of serialized request headers.
    assert.ok(state.maxWritable <= CHUNK + 1024, 'One chunk plus HTTP headers at most');
    assert.ok(state.maxLead < 32 * MiB, 'Socket backpressure prevents whole-payload read-ahead');
    return {
      sizeMiB: size / MiB, elapsedMs: Math.round(elapsedMs),
      sourceCompleteMs: Math.round(file.state.completedAt - startedAt),
      baselineMiB: mib(baseline), peakMiB: mib(peak), finalMiB: mib(memory()),
      peakDeltaMiB: mib(Object.fromEntries(fields.map((name) => [name, peak[name] - baseline[name]]))),
      maxWritable: state.maxWritable, maxSourceBuffer: file.state.maxBuffer,
      maxSocketLeadMiB: Math.round(state.maxLead / MiB * 100) / 100,
      receivedChunks: http.state.chunks, signBody: state.signBody,
    };
  } finally {
    clearInterval(sampler);
    await http.close();
  }
}

test('real native HTTP incrementally preserves size, hash, signed headers and APK staging', async (t) => {
  for (const size of [0, 1, CHUNK * 4 + 17]) {
    const report = await transfer(size, { ext: '.APK', contentType: 'application/vnd.android.package-archive' });
    assert.equal(report.signBody.ext, 'bin');
    assert.equal(report.signBody.contentType, 'application/octet-stream');
    t.diagnostic(JSON.stringify(report));
  }
});

test('real HTTP >512MiB and inclusive 2GiB maintain bounded combined process memory', { timeout: 180_000 }, async (t) => {
  const reports = [];
  for (const size of [64 * MiB, 576 * MiB, 2 * 1024 * MiB]) {
    const report = await transfer(size);
    reports.push(report);
    t.diagnostic(JSON.stringify(report));
    // These budgets deliberately INCLUDE V8, sender/receiver HTTP, GC slack and
    // native/kernel-facing buffers, not just the one-chunk application queue.
    assert.ok(report.peakDeltaMiB.rss < 192, 'Combined RSS overhead stays below 192MiB');
    assert.ok(report.peakDeltaMiB.external < 128, 'External buffers stay below 128MiB');
    assert.ok(report.peakDeltaMiB.arrayBuffers < 128, 'Array buffers stay below 128MiB');
  }
  const small = reports[1];
  const large = reports[2];
  assert.ok(large.peakMiB.rss - small.peakMiB.rss < 96, '3.56x payload does not cause proportional RSS growth');
  assert.ok(large.peakMiB.external - small.peakMiB.external < 48, 'External memory plateaus across lengths');
  assert.ok(large.peakMiB.arrayBuffers - small.peakMiB.arrayBuffers < 48, 'Array buffers plateau across lengths');
});

test('genuine paused receiver applies backpressure and cancellation destroys native PUT', { timeout: 15_000 }, async () => {
  const http = await fixture({ hold: true });
  const file = generatedSource(128 * MiB);
  const state = { presigns: 0, deletes: 0, maxWriteChunk: 0, maxWritable: 0 };
  const aborter = new AbortController();
  const pending = localUploader(http, state)(file, { owner, signal: aborter.signal });
  try {
    await within(http.entered);
    await delay(400);
    const produced = file.state.bytes;
    assert.ok(produced > 0 && produced < 32 * MiB, 'Actual socket prevents unbounded producer advance');
    await delay(200);
    assert.equal(file.state.bytes, produced, 'Producer is blocked, not merely artificially paced');
    assert.ok(state.maxWritable <= CHUNK + 1024);
    const abortedAt = performance.now();
    aborter.abort();
    const result = await within(pending);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ABORTED');
    assert.equal(state.deletes, 1);
    assert.equal(state.presigns, 1);
    assert.equal(file.state.closed, false);
    assert.ok(performance.now() - abortedAt < 2000);
    const reads = file.state.reads;
    http.state.request.resume();
    await within(http.stopped);
    await delay(25);
    assert.equal(file.state.reads, reads, 'No late source read after cancellation');
  } finally {
    aborter.abort();
    await http.close();
    await pending;
  }
});

test('long real-wall native HTTP upload survives eleven minutes of continuous slow consumption', {
  skip: process.env.CINDY_STREAM_LONG_HTTP !== '1', timeout: 750_000,
}, async (t) => {
  const durationMs = 660_000;
  const size = 128 * MiB;
  const started = new Date().toISOString();
  console.log('LONG_HTTP_STARTED ' + JSON.stringify({ started, targetDurationMs: durationMs, sizeMiB: size / MiB, node: process.version }));
  const report = await transfer(size, { bytesPerSecond: size / (durationMs / 1000) });
  assert.ok(report.elapsedMs >= 650_000, 'Uses real wall time, not a fake clock or instant consumer');
  assert.ok(report.sourceCompleteMs >= 600_000, 'Source itself keeps streaming beyond ten minutes');
  assert.ok(report.elapsedMs < 720_000);
  t.diagnostic('LONG_HTTP_COMPLETED ' + JSON.stringify({ started, ended: new Date().toISOString(), ...report }));
});
