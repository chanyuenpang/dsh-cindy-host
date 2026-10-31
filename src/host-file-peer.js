import { constants, promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createFilePeerConnection, sendFilePeerBinary } from './file-peer-rtc.js';
import { FILE_PEER_VERSION, FILE_PEER_MAX_BYTES, FILE_PEER_CHUNK_BYTES, FILE_PEER_CREDIT } from './file-peer-protocol.js';

const UUID = /^[a-f0-9-]{36}$/;
const MAX_BUFFERED = 1024 * 1024;
const fail = (code) => Object.assign(new Error(code), { code });

function parseRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('INVALID_FILE_PEER_REQUEST');
  if (value.action === 'caps') return value;
  if (value.action === 'offer' && typeof value.sdp === 'string' && value.sdp.length && value.sdp.length <= 128 * 1024) return value;
  if (typeof value.connection !== 'string' || !UUID.test(value.connection)) throw fail('INVALID_FILE_PEER_REQUEST');
  if (value.action === 'close') return value;
  if (value.action === 'open' && typeof value.url === 'string' && value.url.length && value.url.length <= 16 * 1024) return value;
  throw fail('INVALID_FILE_PEER_REQUEST');
}

function sameFile(a, b) {
  // Metadata consistency, not a cryptographic snapshot of hostile storage.
  return a?.isFile() && b?.isFile() && ['size', 'mtimeMs', 'dev', 'ino'].every((key) => a[key] !== undefined && a[key] === b[key]) && (a.ctimeMs === undefined || a.ctimeMs === b.ctimeMs);
}

// Closing a werift connection or a FileHandle can itself reject. Never leak an
// unhandled rejection from an event callback or synchronous invalidation API.
function safelyClose(resource) {
  try { return Promise.resolve(resource?.close()).catch(() => {}); }
  catch { return Promise.resolve(); }
}

/** Authorized, download-only Cindy files-v1 source. No whole-file buffering. */
export function createFilePeerManager({
  resolveFile, isAllowed, loadIceServers,
  createPeerConnection = createFilePeerConnection,
  sendBinary = sendFilePeerBinary,
  openFile = fs.open, idleMs = 60_000, maxConnections = 4, onEvent, identify,
}) {
  if (![resolveFile, isAllowed, loadIceServers, createPeerConnection, sendBinary, openFile].every((fn) => typeof fn === 'function')) throw new TypeError('File peer dependencies must be functions');
  if (!Number.isFinite(idleMs) || idleMs <= 0 || !Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 4) throw new TypeError('Invalid file peer limits');
  const tags = (facts) => {
    try {
      const value = identify?.(facts);
      if (value?.then) { void Promise.resolve(value).catch(() => {}); return {}; }
      return Object.fromEntries(['actorId', 'ownerId', 'sourceId']
        .filter(key => typeof value?.[key] === 'string' && /^[a-f0-9]{64}$/.test(value[key]))
        .map(key => [key, value[key]]));
    } catch { return {}; }
  };
  const observe = (c, event, fields = {}) => {
    try {
      c.tags ??= tags({ actor: c.peer });
      const result = onEvent?.({ ...c.tags, ...c.source?.tags, transport: 'peer', event, connection: c.id, ...fields });
      if (result?.then) void Promise.resolve(result).catch(() => {});
    } catch { /* Observation never changes the peer contract. */ }
  };
  const connections = new Map();
  let epoch = 0;
  const allowed = (peer) => { try { return typeof peer === 'string' && peer.length > 0 && isAllowed(peer) === true; } catch { return false; } };

  function release(source) {
    if (!source) return Promise.resolve();
    return source.closing ??= safelyClose(source.file);
  }
  function close(c, code = 'FILE_PEER_CLOSED') {
    if (connections.get(c.id) !== c) return;
    connections.delete(c.id); // Invalidate before calling external code.
    observe(c, 'closed', { code });
    clearTimeout(c.timer);
    clearTimeout(c.offerTimer);
    for (const cancel of c.waiters) cancel(fail(code));
    c.waiters.clear();
    c.finishIce?.();
    const source = c.source;
    c.source = null;
    void release(source);
    void safelyClose(c.dc);
    void safelyClose(c.pc);
  }
  function current(c) {
    if (connections.get(c.id) !== c || c.epoch !== epoch) throw fail('FILE_PEER_CLOSED');
    if (!allowed(c.peer)) { close(c, 'FILE_PEER_REVOKED'); throw fail('FILE_PEER_REVOKED'); }
    return c;
  }
  // Race invalidation as well as checking after every await. A factory/open
  // that completes after cancellation must dispose its newly acquired resource.
  function step(c, operation, dispose, adopt) {
    // Remove each cancellation listener when settled: a single lifetime promise
    // would retain one reaction per block until the entire 2 GiB stream closes.
    return new Promise((resolve, reject) => {
      const cancel = (error) => { c.waiters.delete(cancel); reject(error); };
      c.waiters.add(cancel);
      Promise.resolve(operation).then((value) => {
        try {
          current(c);
          adopt?.(value); // Register acquired resources before yielding again.
          c.waiters.delete(cancel);
          resolve(value);
        } catch (error) { dispose?.(value); cancel(error); }
      }, cancel);
      // An injected RTC/sender may synchronously emit close before returning.
      try { current(c); } catch (error) { cancel(error); }
    });
  }
  function progress(c) {
    current(c);
    clearTimeout(c.timer);
    c.timer = setTimeout(() => close(c, 'FILE_PEER_TIMEOUT'), idleMs);
    c.timer.unref?.();
  }
  function assertSource(c, source) {
    current(c);
    if (c.source !== source) throw fail('FILE_PEER_CLOSED');
  }
  async function checkStat(c, source) {
    assertSource(c, source);
    const stat = await step(c, source.file.stat());
    assertSource(c, source);
    if (!sameFile(source.info, stat)) throw fail('FILE_PEER_CHANGED');
  }
  async function serve(c, channel, data) {
    current(c);
    if (c.dc !== channel || channel.readyState !== 'open' || c.busy || c.opening || !c.ready || typeof data !== 'string' || data.length > 256) throw fail('FILE_PEER_BLOCK');
    const request = JSON.parse(data);
    const source = c.source;
    if (!request || !source || typeof request.ticket !== 'string' || !UUID.test(request.ticket) || request.ticket !== source.ticket || !Number.isSafeInteger(request.offset) || request.offset !== source.offset || request.credit !== FILE_PEER_CREDIT) throw fail('FILE_PEER_BLOCK');
    const batch = Symbol('file-peer-batch');
    c.busy = batch;
    try {
      for (let i = 0; i < FILE_PEER_CREDIT; i++) {
        await checkStat(c, source);
        assertSource(c, source);
        const length = Math.min(FILE_PEER_CHUNK_BYTES, source.info.size - source.offset);
        const buffer = Buffer.alloc(length);
        let filled = 0;
        while (filled < length) {
          const { bytesRead } = await step(c, source.file.read(buffer, filled, length - filled, source.offset + filled));
          assertSource(c, source);
          if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > length - filled) throw fail('FILE_PEER_CHANGED');
          filled += bytesRead;
          // Regular files may short-read without changing. Fill only this bounded
          // block, rechecking identity after every read (also before the next).
          await checkStat(c, source);
          assertSource(c, source);
        }
        if (!length) {
          // Finish disk cleanup before exposing EOF. Cindy may issue its next
          // open as soon as EOF arrives, even before the RTC send promise settles.
          await step(c, release(source));
          assertSource(c, source);
          c.source = null;
          c.busy = false;
        }
        if (channel.readyState !== 'open' || !Number.isFinite(channel.bufferedAmount) || channel.bufferedAmount < 0 || channel.bufferedAmount + Math.max(1, length) > MAX_BUFFERED) throw fail('FILE_PEER_BLOCK');
        await step(c, sendBinary(channel, buffer)); // Includes mandatory zero-byte binary EOF.
        current(c);
        if (channel.bufferedAmount > MAX_BUFFERED) throw fail('FILE_PEER_BLOCK');
        progress(c); // Requests, failed opens and credit spam never refresh TTL.
        if (!length) { observe(c, 'eof-queued', { ...source.tags, queuedBytes: source.offset }); return; }
        assertSource(c, source);
        source.offset += length;
        observe(c, 'bytes-queued', { queuedBytes: source.offset });
      }
    } finally { if (c.busy === batch) c.busy = false; }
  }
  function dataChannel(c, channel) {
    try {
      current(c);
      if (!channel || c.dc || channel.label !== 'files-v1' || channel.ordered !== true || channel.maxRetransmits != null || channel.maxPacketLifeTime != null) throw fail('FILE_PEER_BLOCK');
      c.dc = channel;
      channel.binaryType = 'arraybuffer';
      const opened = () => {
        if (connections.get(c.id) === c && !c.openObserved && channel.readyState === 'open') {
          c.openObserved = true; observe(c, 'dc-open');
        }
      };
      channel.onopen = opened;
      opened();
      channel.onmessage = ({ data }) => serve(c, channel, data).catch(() => close(c));
      channel.onclose = () => close(c);
      channel.onerror = () => close(c);
    } catch {
      void safelyClose(channel);
      close(c);
    }
  }
  function gatherIce(c) {
    const pc = c.pc;
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        pc.onicegatheringstatechange = null;
        c.finishIce = null;
        resolve();
      };
      const timer = setTimeout(done, 4000);
      timer.unref?.();
      c.finishIce = done;
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') done(); };
      if (pc.iceGatheringState === 'complete') done();
    });
  }
  async function offer(peer, sdp) {
    if (connections.size >= maxConnections) throw fail('FILE_PEER_BUSY');
    const c = { id: randomUUID(), peer, epoch, source: null, pc: null, dc: null, ready: false, busy: false, opening: false };
    c.waiters = new Set();
    connections.set(c.id, c); // Reserve the slot before any asynchronous work.
    progress(c);
    // Cindy reserves 30s for file-peer RPC. werift awaits gathering inside
    // setLocalDescription: a <3s config fetch plus UDP -> TCP TURN retries
    // can exceed 15s even when usable local candidates already exist. Keep
    // 5s for RPC delivery; the later gatherIce(4s) cannot bound that await.
    c.offerTimer = setTimeout(() => close(c, 'FILE_PEER_TIMEOUT'), 25_000);
    c.offerTimer.unref?.();
    try {
      const iceServers = await step(c, loadIceServers());
      current(c);
      await step(c, createPeerConnection({ iceServers }), safelyClose, (pc) => { c.pc = pc; });
      current(c);
      c.pc.ondatachannel = ({ channel }) => dataChannel(c, channel);
      c.pc.onconnectionstatechange = () => {
        try {
          current(c);
          if (['failed', 'closed', 'disconnected'].includes(c.pc.connectionState)) close(c);
        } catch { close(c); }
      };
      await step(c, c.pc.setRemoteDescription({ type: 'offer', sdp }));
      current(c);
      const answer = await step(c, c.pc.createAnswer());
      current(c);
      await step(c, c.pc.setLocalDescription(answer));
      current(c);
      await step(c, gatherIce(c));
      current(c);
      if (!c.pc.localDescription?.sdp || c.pc.signalingState === 'closed') throw fail('FILE_PEER_CLOSED');
      c.ready = true;
      observe(c, 'offer-answer');
      progress(c);
      return { connection: c.id, sdp: c.pc.localDescription.sdp };
    } catch (error) { close(c); throw error; }
    finally { clearTimeout(c.offerTimer); }
  }
  async function open(c, url) {
    current(c);
    if (!c.ready || c.opening || c.source || c.busy) throw fail('FILE_PEER_BUSY');
    c.opening = true;
    let source;
    try {
      const resolved = await step(c, resolveFile(url));
      current(c);
      if (!resolved?.ok) throw fail(resolved?.code || 'FILE_PEER_DENIED');
      const cap = Math.min(resolved.cap ?? FILE_PEER_MAX_BYTES, FILE_PEER_MAX_BYTES);
      if (!resolved.info?.isFile() || !Number.isSafeInteger(resolved.info.size) || resolved.info.size < 0 || !Number.isFinite(cap) || resolved.info.size > cap) throw fail('FILE_PEER_SIZE');
      await step(c, openFile(resolved.real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)), safelyClose, (file) => {
        source = { file, info: resolved.info, offset: 0, ticket: randomUUID(), tags: tags({ actor: c.peer, real: resolved.real, info: resolved.info }) };
        c.source = source; // Track even while the initial stat is pending.
      });
      current(c);
      await checkStat(c, source);
      assertSource(c, source);
      progress(c);
      const mimeType = typeof resolved.mimeType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(resolved.mimeType) ? resolved.mimeType : 'application/octet-stream';
      observe(c, 'file-open', { size: source.info.size });
      return { ticket: source.ticket, size: source.info.size, mimeType };
    } catch (error) {
      if (source) {
        if (c.source === source) c.source = null;
        void release(source);
      }
      throw error;
    } finally { c.opening = false; }
  }
  async function handle(peer, payload) {
    if (!allowed(peer)) { closePeer(peer); throw fail('FILE_PEER_DENIED'); }
    const request = parseRequest(payload);
    if (request.action === 'caps') return { version: FILE_PEER_VERSION, maxBytes: FILE_PEER_MAX_BYTES };
    if (request.action === 'offer') return offer(peer, request.sdp);
    const c = connections.get(request.connection);
    if (!c || c.peer !== peer) throw fail('FILE_PEER_DENIED');
    current(c);
    if (request.action === 'close') { close(c); return { ok: true }; }
    return open(c, request.url);
  }
  function closePeer(peer) { for (const c of connections.values()) if (c.peer === peer) close(c); }
  function closeAll() { epoch++; for (const c of connections.values()) close(c); }
  function pruneUnauthorized() { for (const c of connections.values()) if (!allowed(c.peer)) close(c, 'FILE_PEER_REVOKED'); }
  return { handle, closePeer, closeAll, pruneUnauthorized };
}
