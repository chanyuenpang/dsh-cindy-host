/** Local-only real Chromium <-> werift smoke. No Cindy login or real user files.
 * Run: node tools/file-peer-rtc-smoke.mjs (uses the production RTC adapter)
 * --native-empty reproduces the unpatched werift 0.24.4 EOF failure.
 * --manager checks the real manager/resolver with temporary files up to 32 MiB.
 * No public STUN/TURN: an explicit localhost URL avoids werift's [] fallback.
 * Optional: CINDY_SOURCE_ROOT (default: sibling ../Cindy), PLAYWRIGHT_CORE_PATH,
 * CINDY_RUNTIME_PATH, CHROMIUM_EXECUTABLE. Relative source overrides use this repo.
 * Hard stop: 60 seconds.
 */
import assert from 'node:assert/strict';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { existsSync, readFileSync, createReadStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createFilePeerConnection, sendFilePeerBinary } from '../src/file-peer-rtc.js';

const useEmptyShim = !process.argv.includes('--native-empty');
const useManager = process.argv.includes('--manager');
// Explicit localhost STUN prevents werift's implicit public STUN fallback for [].
const localIceServers = [{ urls: 'stun:127.0.0.1:9' }];
const require = createRequire(import.meta.url);
const weriftVersion = JSON.parse(readFileSync(join(dirname(require.resolve('werift')), '../../../package.json'), 'utf8')).version;
assert.equal(weriftVersion, '0.24.4', 'RTC private EOF shim upgrade requires review');
async function sendBinary(channel, data) {
  if (!useEmptyShim) return channel.send(data);
  await sendFilePeerBinary(channel, data);
}
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const cindySourceRoot = resolve(repositoryRoot, process.env.CINDY_SOURCE_ROOT || '../Cindy');
const playwrightPath = resolve(repositoryRoot, process.env.PLAYWRIGHT_CORE_PATH || join(cindySourceRoot, 'node_modules', 'playwright-core'));
const runtimePath = resolve(repositoryRoot, process.env.CINDY_RUNTIME_PATH || join(cindySourceRoot, 'packages', 'device-link', 'src', 'filePeerRuntime.ts'));
const { chromium } = require(playwrightPath);
const candidates = [process.env.CHROMIUM_EXECUTABLE, chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'];
const executablePath = candidates.find(p => p && existsSync(p));
assert.ok(executablePath, 'Set CHROMIUM_EXECUTABLE to a real Chromium executable');
let server, browser, page, pc, protocolPc, manager, tempDir;
const sinkHandles = new Map();
const started = Date.now();
const report = { node: process.version, werift: weriftVersion, playwright: require(join(playwrightPath, 'package.json')).version,
  executablePath, useEmptyShim, results: [], ice: { stun: 'localhost-only (no public STUN/TURN)' } };
const log = (event, data) => console.log(JSON.stringify({ event, elapsedMs: Date.now() - started, ...data }));
const hardDeadline = setTimeout(() => {
  console.error('HARD_DEADLINE_60_SECONDS');
  const pid = server?.process()?.pid;
  if (pid) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 2000, stdio: 'ignore' });
      else process.kill(pid, 'SIGKILL');
    } catch {}
  }
  process.exit(2);
}, 60000);
function bounded(promise, name, ms = 10000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(name + ' timed out')), ms);
  })]).finally(() => clearTimeout(timer));
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function checkManagerProtocol() {
  const { createFilePeerManager } = await import('../src/host-file-peer.js');
  const { createLocalFileResolver } = await import('../src/host-media-fetch.js');
  tempDir = await mkdtemp(join(tmpdir(), 'cindy-rtc-smoke-'));
  const runtimeJs = stripTypeScriptTypes(readFileSync(runtimePath, 'utf8')).replace('export function', 'function');
  await page.addScriptTag({ content: runtimeJs + '\nwindow.createFilePeerRuntime = createFilePeerRuntime;' });
  await page.exposeFunction('smokeSinkWrite', async (sink, offset, base64) => {
    const state = sinkHandles.get(sink);
    assert.ok(state, 'known synthetic sink');
    assert.equal(offset, state.bytes, 'strict sink write order');
    const bytes = Buffer.from(base64, 'base64');
    assert.ok(bytes.length > 0 && bytes.length <= 16384);
    const written = await state.handle.write(bytes, 0, bytes.length, offset);
    assert.equal(written.bytesWritten, bytes.length);
    state.bytes += bytes.length;
  });
  let sentBlocks = [], peerCount = 0;
  const peer = 'local-smoke-owner';
  manager = createFilePeerManager({
    resolveFile: createLocalFileResolver({ maxBytes: 2 * 1024 ** 3 }),
    isAllowed: candidate => candidate === peer,
    loadIceServers: async () => localIceServers,
    createPeerConnection: async config => { peerCount++; return createFilePeerConnection(config); },
    sendBinary: async (channel, bytes) => {
      assert.ok(bytes.length <= 16384);
      sentBlocks.push(bytes.length);
      await sendFilePeerBinary(channel, bytes);
    },
  });
  const caps = await manager.handle(peer, { action: 'caps' });
  assert.equal(caps.version, 1);
  assert.equal(caps.maxBytes, 2 * 1024 ** 3);
  const offerSdp = await bounded(page.evaluate(async () => {
    window.runtime = window.createFilePeerRuntime({
      read: async () => { throw new Error('receiver must not read source'); },
      write: (sink, offset, base64) => window.smokeSinkWrite(sink, offset, base64),
    });
    return window.runtime.offer('manager-smoke', []);
  }), 'manager browser offer');
  const answer = await bounded(manager.handle(peer, { action: 'offer', sdp: offerSdp }), 'manager answer');
  await bounded(page.evaluate(sdp => window.runtime.answer('manager-smoke', sdp), answer.sdp), 'manager browser answer');
  const sources = new Map();
  const transfers = [];
  for (const size of [0, 1, 16384, 262144, 524325, 32 * 1024 ** 2 + 37, 0, 32 * 1024 ** 2 + 37]) {
    const start = Date.now();
    let source = sources.get(size);
    if (!source) {
      const path = join(tempDir, 'source-' + size + '.bin');
      const handle = await open(path, 'wx');
      try {
        for (let offset = 0; offset < size; offset += 65536) {
          const chunk = Buffer.alloc(Math.min(65536, size - offset));
          for (let i = 0; i < chunk.length; i++) chunk[i] = ((offset + i) * 31 + 17) % 251;
          assert.equal((await handle.write(chunk)).bytesWritten, chunk.length);
        }
      } finally { await handle.close(); }
      source = { path, sha256: await hashFile(path) };
      sources.set(size, source);
    }
    const url = new URL('xdt-file://open');
    url.searchParams.set('path', source.path);
    url.searchParams.set('workdir', tempDir);
    const opened = await manager.handle(peer, { action: 'open', connection: answer.connection, url: url.href });
    assert.equal(opened.size, size);
    const sink = 'sink-' + transfers.length;
    const sinkPath = join(tempDir, sink + '.bin');
    const state = { handle: await open(sinkPath, 'wx'), bytes: 0 };
    sinkHandles.set(sink, state);
    sentBlocks = [];
    await bounded(page.evaluate(({ opened, sink }) => window.runtime.receive('manager-smoke', opened.ticket, opened.size, sink),
      { opened, sink }), 'manager receive ' + size, 35000);
    await state.handle.close();
    sinkHandles.delete(sink);
    assert.equal(state.bytes, size);
    assert.equal(sentBlocks.filter(length => length === 0).length, 1);
    assert.equal(sentBlocks.at(-1), 0);
    assert.equal(sentBlocks.length - 1, Math.ceil(size / 16384));
    const sha256 = await hashFile(sinkPath);
    assert.equal(sha256, source.sha256);
    const transfer = { size, sha256, dataBlocks: sentBlocks.length - 1, eof: true, ms: Date.now() - start };
    transfers.push(transfer);
    log('manager.transfer', transfer);
  }
  assert.equal(peerCount, 1, 'all files reuse the same actual peer');
  assert.deepEqual(await manager.handle(peer, { action: 'close', connection: answer.connection }), { ok: true });
  report.managerProtocol = { actualManager: true, actualResolver: true, actualCindyRuntime: true, peerCount, transfers };
}

async function checkCindyProtocol() {
  const runtimeJs = stripTypeScriptTypes(readFileSync(runtimePath, 'utf8')).replace('export function', 'function');
  await page.addScriptTag({ content: runtimeJs + '\nwindow.createFilePeerRuntime = createFilePeerRuntime;' });
  protocolPc = await createFilePeerConnection({ iceServers: localIceServers });
  let activeSize = 0, requests = [], sent = [], protocolError;
  const ticket = '00000000-0000-4000-8000-000000000001';
  protocolPc.onDataChannel.subscribe(dc => {
    assert.equal(dc.label, 'files-v1');
    assert.equal(dc.ordered, true);
    dc.onMessage.subscribe(async data => {
      try {
        assert.equal(typeof data, 'string');
        const request = JSON.parse(data);
        assert.equal(request.ticket, ticket);
        assert.equal(request.credit, 16);
        assert.ok(Number.isSafeInteger(request.offset) && request.offset >= 0 && request.offset <= activeSize);
        requests.push(request.offset);
        let offset = request.offset;
        for (let i = 0; i < 16; i++) {
          const length = Math.min(16384, activeSize - offset);
          const bytes = Buffer.alloc(length);
          for (let j = 0; j < length; j++) bytes[j] = ((offset + j) * 31 + 17) % 251;
          await sendBinary(dc, bytes);
          sent.push(length);
          offset += length;
          if (!length) break;
        }
      } catch (error) { protocolError = error; dc.close(); }
    });
  });
  const sdp = await bounded(page.evaluate(async () => {
    window.sinks = {};
    window.runtime = window.createFilePeerRuntime({
      read: async () => { throw new Error('receiver must not read source'); },
      write: async (sink, offset, base64) => {
        const state = window.sinks[sink];
        if (offset !== state.bytes) throw new Error('sink offset mismatch');
        const decoded = atob(base64);
        for (let i = 0; i < decoded.length; i++) {
          if (decoded.charCodeAt(i) !== ((offset + i) * 31 + 17) % 251) throw new Error('payload byte mismatch');
        }
        // Async sink completion must happen before the receiver grants another batch.
        await new Promise(resolve => setTimeout(resolve, 1));
        state.bytes += decoded.length;
        state.blocks++;
      },
    });
    return window.runtime.offer('smoke', []);
  }), 'Cindy offer');
  await protocolPc.setRemoteDescription({ type: 'offer', sdp });
  await bounded(protocolPc.setLocalDescription(await protocolPc.createAnswer()), 'Cindy Node answer');
  await bounded(page.evaluate(sdp => window.runtime.answer('smoke', sdp), protocolPc.localDescription.sdp), 'Cindy channel');
  const transfers = [];
  for (const size of [0, 1, 16384, 262144, 524325, 0, 524325]) {
    activeSize = size;
    requests = [];
    sent = [];
    const sink = 'synthetic-' + transfers.length;
    const result = await bounded(page.evaluate(async ({ size, sink, ticket }) => {
      window.sinks[sink] = { bytes: 0, blocks: 0 };
      await window.runtime.receive('smoke', ticket, size, sink);
      return window.sinks[sink];
    }, { size, sink, ticket }), 'Cindy transfer ' + size);
    if (protocolError) throw protocolError;
    assert.equal(result.bytes, size);
    assert.equal(result.blocks, Math.ceil(size / 16384));
    assert.equal(sent.filter(length => length === 0).length, 1, 'exactly one EOF');
    assert.equal(sent.at(-1), 0);
    const expectedRequests = Array.from({ length: Math.floor(size / 262144) + 1 }, (_, i) => i * 262144);
    assert.deepEqual(requests, expectedRequests);
    const transfer = { size, requests, dataBlocks: result.blocks, eof: true, exactBytes: true };
    transfers.push(transfer);
    log('Cindy.transfer', transfer);
  }
  report.cindyProtocol = { runtimePath, actualBrowserRuntime: true, chunkBytes: 16384, credit: 16, repeatedSameTicket: true, transfers };
}

try {
  server = await chromium.launchServer({ executablePath, headless: true, timeout: 10000 });
  browser = await chromium.connect(server.wsEndpoint());
  report.chromium = browser.version();
  page = await browser.newPage();
  pc = await createFilePeerConnection({ iceServers: localIceServers });
  pc.connectionStateChange.subscribe(state => log('node.connection', { state }));
  let channel;
  const received = [];
  let gotMarker;
  const marker = new Promise(resolve => { gotMarker = resolve; });
  pc.onDataChannel.subscribe(dc => {
    channel = dc;
    log('node.channel', { label: dc.label, ordered: dc.ordered, maxRetransmits: dc.maxRetransmits, maxPacketLifeTime: dc.maxPacketLifeTime });
    dc.onMessage.subscribe(data => {
      received.push(data);
      log('node.message', { type: typeof data === 'string' ? 'string' : 'Buffer', bytes: data.length });
      if (data === 'browser-marker') gotMarker();
    });
  });
  const offer = await bounded(page.evaluate(async () => {
    const pc = window.pc = new RTCPeerConnection({ iceServers: [] });
    const dc = window.dc = pc.createDataChannel('files-v1', { ordered: true });
    dc.binaryType = 'arraybuffer';
    window.messages = [];
    dc.onmessage = ({ data }) => {
      window.messages.push(typeof data === 'string' ? data : Array.from(new Uint8Array(data)));
      if (data === 'node-marker') window.resolveMarker?.();
    };
    await pc.setLocalDescription(await pc.createOffer());
    if (pc.iceGatheringState !== 'complete') await new Promise(resolve => {
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') resolve();
      });
      if (pc.iceGatheringState === 'complete') resolve();
    });
    return { type: pc.localDescription.type, sdp: pc.localDescription.sdp };
  }), 'browser offer');
  report.ice.browserCandidates = offer.sdp.split('\r\n').filter(line => line.startsWith('a=candidate:'));
  log('browser.offer', report.ice);
  await pc.setRemoteDescription(offer);
  await bounded(pc.setLocalDescription(await pc.createAnswer()), 'node answer');
  const answer = { type: pc.localDescription.type, sdp: pc.localDescription.sdp };
  report.ice.nodeCandidates = answer.sdp.split('\r\n').filter(line => line.startsWith('a=candidate:'));
  log('node.answer', { candidates: report.ice.nodeCandidates });
  await bounded(page.evaluate(async answer => {
    await window.pc.setRemoteDescription(answer);
    if (window.dc.readyState !== 'open') await new Promise((resolve, reject) => {
      window.dc.addEventListener('open', resolve, { once: true });
      window.dc.addEventListener('error', () => reject(new Error('DataChannel error')), { once: true });
    });
    const bytes = Uint8Array.from({ length: 16384 }, (_, i) => i % 251);
    window.dc.send(bytes.buffer);
    window.dc.send(new ArrayBuffer(0));
    window.dc.send('browser-marker');
  }, answer), 'channel open');
  await bounded(marker, 'browser binary and EOF');
  assert.equal(channel.label, 'files-v1');
  assert.equal(channel.ordered, true);
  assert.equal(channel.maxRetransmits, null);
  assert.equal(channel.maxPacketLifeTime, null);
  const expected = Buffer.from(Array.from({ length: 16384 }, (_, i) => i % 251));
  assert.equal(received.length, 3);
  assert.deepEqual(received[0], expected);
  assert.ok(Buffer.isBuffer(received[1]));
  assert.equal(received[1].length, 0);
  report.results.push({ direction: 'Chromium -> Node', binary16384: true, emptyBinaryEOF: true });
  await page.evaluate(() => { window.markerPromise = new Promise(resolve => { window.resolveMarker = resolve; }); });
  channel.send(expected);
  await sendBinary(channel, Buffer.alloc(0));
  channel.send('node-marker');
  const messages = await bounded(page.evaluate(async () => {
    await window.markerPromise;
    return window.messages;
  }), 'Node binary and EOF');
  const binary16384 = Array.isArray(messages[0]) && Buffer.from(messages[0]).equals(expected);
  const emptyBinaryEOF = messages.length === 3 && Array.isArray(messages[1]) && messages[1].length === 0;
  report.results.push({ direction: 'Node -> Chromium', binary16384, emptyBinaryEOF,
    received: messages.map(value => typeof value === 'string' ? value : { binaryBytes: value.length }) });
  log('result', report);
  assert.ok(binary16384, 'Node binary payload must round trip exactly');
  assert.ok(emptyBinaryEOF, 'werift send(Buffer.alloc(0)) must deliver a zero-byte binary message');
  if (useEmptyShim) {
    if (useManager) await checkManagerProtocol();
    else await checkCindyProtocol();
  }
  log('PASS', { report });
} catch (error) {
  if (page && !page.isClosed()) report.browserMessages = await page.evaluate(() =>
    window.messages?.map(value => typeof value === 'string' ? value : { binaryBytes: value.length })).catch(() => null);
  log('FAIL', { error: String(error), report });
  process.exitCode = 1;
} finally {
  await bounded(Promise.allSettled([
    page?.evaluate(() => { window.runtime?.dispose(); window.dc?.close(); window.pc?.close(); }),
    pc?.close(), protocolPc?.close(), manager?.closeAll(),
  ]), 'peer cleanup', 3000).catch(error => console.error(String(error)));
  await bounded(Promise.allSettled([browser?.close(), server?.close()]), 'browser cleanup', 3000).catch(error => console.error(String(error)));
  for (const state of sinkHandles.values()) await state.handle.close().catch(() => {});
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  clearTimeout(hardDeadline);
}
