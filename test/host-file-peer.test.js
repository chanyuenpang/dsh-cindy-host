import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate as immediate } from 'node:timers/promises';
import { createFilePeerManager } from '../src/host-file-peer.js';

const CHUNK = 16384;
const BATCH = CHUNK * 16;
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class Channel {
  label = 'files-v1'; ordered = true; maxRetransmits = null; maxPacketLifeTime = null;
  readyState = 'open'; bufferedAmount = 0; sent = []; closes = 0;
  close() { this.closes++; this.readyState = 'closed'; this.onclose?.(); }
  request(ticket, offset = 0, credit = 16) { return this.onmessage({ data: JSON.stringify({ ticket, offset, credit }) }); }
}
class RTC {
  iceGatheringState = 'complete'; connectionState = 'connected'; signalingState = 'stable'; closes = 0;
  async setRemoteDescription(value) { this.remoteDescription = value; }
  async createAnswer() { return { type: 'answer', sdp: 'answer-sdp' }; }
  async setLocalDescription(value) { this.localDescription = value; }
  close() { this.closes++; this.connectionState = this.signalingState = 'closed'; this.onconnectionstatechange?.(); }
  channel(overrides = {}) { const dc = Object.assign(new Channel(), overrides); this.ondatachannel({ channel: dc }); return dc; }
}
async function fixture(t, bytes = Buffer.from('hello'), overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'host-file-peer-'));
  const file = path.join(dir, 'source.bin');
  await fs.writeFile(file, bytes);
  const state = { dir, file, pcs: [], handles: [], reads: [], allowed: new Set(['alice', 'bob']) };
  state.resolve = async () => ({ ok: true, real: file, info: await fs.stat(file), mimeType: 'application/octet-stream', cap: 2147483648 });
  state.openFile = async (...args) => {
    const fd = await fs.open(...args);
    const handle = {
      closes: 0,
      stat: () => fd.stat(),
      read: (...readArgs) => { state.reads.push(readArgs[2]); return fd.read(...readArgs); },
      close() { this.closes++; return fd.close(); },
    };
    state.handles.push(handle);
    return handle;
  };
  state.options = {
    resolveFile: (url) => state.resolve(url), isAllowed: (peer) => state.allowed.has(peer), loadIceServers: async () => [{ urls: 'stun:example.test' }],
    createPeerConnection: async (config) => { const pc = new RTC(); pc.config = config; state.pcs.push(pc); return pc; },
    sendBinary: async (dc, bytes) => { assert.ok(Buffer.isBuffer(bytes)); dc.sent.push(Buffer.from(bytes)); },
    openFile: (...args) => state.openFile(...args), ...overrides,
  };
  state.manager = createFilePeerManager(state.options);
  t.after(async () => { state.manager.closeAll(); await immediate(); await fs.rm(dir, { recursive: true, force: true }); });
  state.connect = async (peer = 'alice') => {
    const reply = await state.manager.handle(peer, { action: 'offer', sdp: 'offer-sdp' });
    const pc = state.pcs.at(-1);
    return { ...reply, pc, dc: pc.channel(), peer };
  };
  state.open = (c, url = 'authorized-url') => state.manager.handle(c.peer, { action: 'open', connection: c.connection, url });
  return state;
}

test('caps, signaling and close match Cindy wire and enforce owner binding', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(Object.keys(f.manager).sort(), ['closeAll', 'closePeer', 'handle', 'pruneUnauthorized']);
  assert.deepEqual(await f.manager.handle('alice', { action: 'caps' }), { version: 1, maxBytes: 2147483648 });
  await assert.rejects(f.manager.handle('mallory', { action: 'caps' }), /DENIED/);
  for (const request of [null, [], {}, { action: 'offer', sdp: '' }, { action: 'offer', sdp: 'x'.repeat(131073) }, { action: 'open', connection: 'spoof', url: 'a' }]) await assert.rejects(f.manager.handle('alice', request), /INVALID/);
  const c = await f.connect();
  assert.match(c.connection, /^[a-f0-9-]{36}$/);
  assert.equal(c.sdp, 'answer-sdp');
  assert.deepEqual(c.pc.remoteDescription, { type: 'offer', sdp: 'offer-sdp' });
  assert.deepEqual(c.pc.config, { iceServers: [{ urls: 'stun:example.test' }] });
  for (const action of ['open', 'close']) await assert.rejects(f.manager.handle('bob', { action, connection: c.connection, url: 'x' }), /DENIED/);
  assert.equal(c.pc.closes, 0);
  assert.deepEqual(await f.manager.handle('alice', { action: 'close', connection: c.connection }), { ok: true });
  assert.equal(c.pc.closes, 1);
  await assert.rejects(f.open(c), /DENIED/);
});

for (const size of [0, 1, CHUNK, BATCH, BATCH + 1]) test('bounded binary stream, EOF and reusable connection: ' + size, async (t) => {
  const bytes = Buffer.alloc(size, 0x7d);
  const f = await fixture(t, bytes);
  const c = await f.connect();
  const opened = await f.open(c);
  assert.deepEqual(Object.keys(opened).sort(), ['mimeType', 'size', 'ticket']);
  assert.equal(opened.size, size);
  assert.equal(opened.mimeType, 'application/octet-stream');
  assert.match(opened.ticket, /^[a-f0-9-]{36}$/);
  await assert.rejects(f.open(c), /BUSY/);
  let offset = 0;
  do {
    const start = c.dc.sent.length;
    await c.dc.request(opened.ticket, offset);
    const batch = c.dc.sent.slice(start);
    assert.ok(batch.length > 0 && batch.length <= 16);
    assert.ok(batch.every((block) => block.length <= CHUNK));
    offset += batch.reduce((sum, block) => sum + block.length, 0);
  } while (c.dc.sent.at(-1).length !== 0);
  assert.equal(offset, size);
  assert.deepEqual(Buffer.concat(c.dc.sent), bytes);
  assert.equal(f.handles[0].closes, 1);
  assert.ok(f.reads.every((length) => length > 0 && length <= CHUNK));
  const again = await f.open(c);
  assert.notEqual(again.ticket, opened.ticket);
  const secondStart = c.dc.sent.length;
  offset = 0;
  do {
    const start = c.dc.sent.length;
    await c.dc.request(again.ticket, offset);
    offset += c.dc.sent.slice(start).reduce((sum, block) => sum + block.length, 0);
  } while (c.dc.sent.at(-1).length !== 0);
  assert.deepEqual(Buffer.concat(c.dc.sent.slice(secondStart)), bytes);
  assert.equal(f.handles[1].closes, 1);
  assert.equal(c.pc.closes, 0);
});

test('reject malformed, oversized, non-string, wrong ticket, offset and credit requests', async (t) => {
  const invalid = [null, 'x'.repeat(257), '{', Buffer.from('{}'), JSON.stringify(null), JSON.stringify({ ticket: randomUUID(), offset: 0, credit: 16 }), { offset: -1 }, { offset: 1 }, { offset: 0.5 }, { credit: 15 }, { credit: 17 }];
  for (const input of invalid) await t.test(String(input), async (t) => {
    const f = await fixture(t); const c = await f.connect(); const file = await f.open(c);
    const data = input && !Buffer.isBuffer(input) && typeof input === 'object' ? JSON.stringify({ ticket: file.ticket, offset: 0, credit: 16, ...input }) : input;
    await c.dc.onmessage({ data });
    assert.equal(c.pc.closes, 1);
    assert.equal(c.dc.sent.length, 0);
    assert.equal(f.handles[0].closes, 1);
  });
});

test('reject replayed batches and tickets borrowed from another connection', async (t) => {
  const f = await fixture(t, Buffer.alloc(BATCH + 1));
  const a = await f.connect(); const b = await f.connect('bob');
  const first = await f.open(a); const second = await f.open(b);
  await a.dc.request(first.ticket);
  assert.equal(a.dc.sent.length, 16);
  await a.dc.request(first.ticket);
  assert.equal(a.pc.closes, 1);
  await b.dc.request(first.ticket);
  assert.equal(b.pc.closes, 1);
  assert.notEqual(first.ticket, second.ticket);
});

test('reject wrong labels, unordered, partially reliable, and duplicate channels', async (t) => {
  for (const options of [{ label: 'other' }, { ordered: false }, { maxRetransmits: 0 }, { maxPacketLifeTime: 100 }]) await t.test(JSON.stringify(options), async (t) => {
    const f = await fixture(t);
    await f.manager.handle('alice', { action: 'offer', sdp: 'sdp' });
    const dc = f.pcs[0].channel(options);
    assert.equal(dc.closes, 1); assert.equal(f.pcs[0].closes, 1);
  });
  const f = await fixture(t); const c = await f.connect();
  const duplicate = c.pc.channel(); assert.equal(duplicate.closes, 1); assert.equal(c.pc.closes, 1);
});

test('reserve four slots during offers; closeAll invalidates pending work', async (t) => {
  const gate = deferred(); const f = await fixture(t, undefined, { loadIceServers: () => gate.promise });
  const offers = Array.from({ length: 4 }, () => f.manager.handle('alice', { action: 'offer', sdp: 'sdp' }));
  const settled = Promise.all(offers.map((p) => assert.rejects(p, /CLOSED/)));
  await assert.rejects(f.manager.handle('bob', { action: 'offer', sdp: 'sdp' }), /BUSY/);
  f.manager.closeAll(); await settled;
  gate.resolve([]); await immediate(); assert.equal(f.pcs.length, 0);
  await f.connect();
});

test('late async RTC factory result closes after closePeer without resurrection', async (t) => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t, undefined, { createPeerConnection: () => { entered.resolve(); return gate.promise; } });
  const offer = f.manager.handle('alice', { action: 'offer', sdp: 'sdp' });
  const rejected = assert.rejects(offer, /CLOSED/);
  await entered.promise; f.manager.closePeer('alice'); await rejected;
  const pc = new RTC(); gate.resolve(pc); await immediate();
  assert.equal(pc.closes, 1); assert.equal(pc.ondatachannel, undefined);
});

test('single in-flight open, revocation during resolver and no late file open', async (t) => {
  const f = await fixture(t); const c = await f.connect(); const gate = deferred(); let opens = 0;
  f.resolve = () => gate.promise; f.openFile = () => { opens++; throw new Error('should not open'); };
  const opening = f.open(c); const rejected = assert.rejects(opening, /REVOKED/);
  await assert.rejects(f.open(c), /BUSY/);
  f.allowed.delete('alice'); f.manager.pruneUnauthorized(); await rejected;
  gate.resolve({ ok: true }); await immediate(); assert.equal(opens, 0); assert.equal(c.pc.closes, 1);
});

test('late openFile handle is closed after closeAll', async (t) => {
  const f = await fixture(t); const c = await f.connect(); const gate = deferred(), entered = deferred(); const original = f.openFile;
  f.openFile = (...args) => { entered.resolve(args); return gate.promise; };
  const opening = f.open(c); const rejected = assert.rejects(opening, /CLOSED/);
  const args = await entered.promise; f.manager.closeAll(); await rejected;
  const handle = await original(...args); gate.resolve(handle); await immediate(); assert.equal(handle.closes, 1);
});

test('revocation is checked on every read even without explicit pruning', async (t) => {
  const f = await fixture(t); const c = await f.connect(); const file = await f.open(c);
  f.allowed.delete('alice'); await c.dc.request(file.ticket);
  assert.equal(c.pc.closes, 1); assert.equal(c.dc.sent.length, 0);
  f.allowed.add('alice'); const late = c.pc.channel(); assert.equal(late.closes, 1);
});

test('parallel requests close the connection instead of overlapping reads', async (t) => {
  const f = await fixture(t, Buffer.alloc(BATCH)); const c = await f.connect(); const file = await f.open(c);
  const first = c.dc.request(file.ticket), second = c.dc.request(file.ticket);
  await Promise.all([first, second]); assert.equal(c.pc.closes, 1); assert.equal(c.dc.sent.length, 0);
});

test('await asynchronous sender, retain one active batch, and stop after close', async (t) => {
  const gate = deferred(), entered = deferred(); let sends = 0;
  const f = await fixture(t, Buffer.alloc(BATCH), { sendBinary: () => { sends++; entered.resolve(); return gate.promise; } });
  const c = await f.connect(); const file = await f.open(c); const sending = c.dc.request(file.ticket);
  await entered.promise; assert.equal(sends, 1); assert.equal(f.reads.length, 1);
  await assert.rejects(f.open(c), /BUSY/);
  f.manager.closePeer('alice'); await sending; gate.resolve(); await immediate();
  assert.equal(sends, 1); assert.equal(f.handles[0].closes, 1);
});

test('bounded sender queue cannot grow past 1 MiB with repeated legal credits', async (t) => {
  const f = await fixture(t, Buffer.alloc(2 * 1024 * 1024), { sendBinary: (dc, bytes) => { dc.bufferedAmount += bytes.length; dc.sent.push(Buffer.from(bytes)); } });
  const c = await f.connect(); const file = await f.open(c);
  for (let offset = 0; offset <= 1024 * 1024; offset += BATCH) await c.dc.request(file.ticket, offset);
  assert.equal(c.dc.bufferedAmount, 1024 * 1024); assert.equal(c.pc.closes, 1);
});

test('resolver failures, nonregular files, over-limit and capability limits fail before opening', async (t) => {
  const f = await fixture(t); const c = await f.connect(); const resolved = await f.resolve();
  f.resolve = async () => ({ ok: false, code: 'NO_ACCESS', message: 'private path' });
  await assert.rejects(f.open(c), /^Error: NO_ACCESS$/);
  for (const value of [{ ...resolved, info: await fs.stat(f.dir) }, { ...resolved, cap: 1 }, { ...resolved, info: Object.assign(Object.create(Object.getPrototypeOf(resolved.info)), resolved.info, { size: 2147483649 }) }]) {
    f.resolve = async () => value; await assert.rejects(f.open(c), /SIZE/);
  }
  assert.equal(f.handles.length, 0);
});

test('opened fd identity must match authorized initial stat (replacement race)', async (t) => {
  const f = await fixture(t); const c = await f.connect(); const resolved = await f.resolve();
  const other = path.join(f.dir, 'other.bin'); await fs.writeFile(other, 'hello');
  const info = await fs.stat(other); await fs.utimes(other, info.atime, resolved.info.mtime);
  f.resolve = async () => ({ ...resolved, real: other });
  await assert.rejects(f.open(c), /CHANGED/); assert.equal(f.handles[0].closes, 1);
});

for (const mutation of ['size', 'mtime']) test('source ' + mutation + ' mutation aborts before sending', async (t) => {
  const f = await fixture(t); const c = await f.connect(); const file = await f.open(c);
  if (mutation === 'size') await fs.appendFile(f.file, 'more');
  else await fs.utimes(f.file, new Date(), new Date(Date.now() + 5000));
  await c.dc.request(file.ticket); assert.equal(c.pc.closes, 1); assert.equal(c.dc.sent.length, 0); assert.equal(f.handles[0].closes, 1);
});

test('post-read stat rejects mutation before sending the affected block', async (t) => {
  const f = await fixture(t); const c = await f.connect(); const file = await f.open(c);
  const original = f.handles[0].read;
  f.handles[0].read = async (...args) => { const result = await original(...args); await fs.appendFile(f.file, 'x'); return result; };
  await c.dc.request(file.ticket); assert.equal(c.pc.closes, 1); assert.equal(c.dc.sent.length, 0);
});

test('close/revoke while file read is pending never sends a late block', async (t) => {
  const f = await fixture(t); const c = await f.connect(); const file = await f.open(c);
  const gate = deferred(), entered = deferred(); const original = f.handles[0].read;
  f.handles[0].read = async (...args) => { const value = await original(...args); entered.resolve(); await gate.promise; return value; };
  const request = c.dc.request(file.ticket); await entered.promise;
  f.allowed.delete('alice'); f.manager.pruneUnauthorized(); await request;
  gate.resolve(); await immediate(); assert.equal(c.dc.sent.length, 0); assert.equal(f.handles[0].closes, 1);
});

test('actual-progress idle TTL is not extended by busy open requests', async (t) => {
  const f = await fixture(t); t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = await f.connect(); await f.open(c);
  t.mock.timers.tick(59000);
  await assert.rejects(f.open(c), /BUSY/);
  t.mock.timers.tick(1000); assert.equal(c.pc.closes, 1); assert.equal(f.handles[0].closes, 1);
});

test('successful batch progress refreshes idle TTL', async (t) => {
  const f = await fixture(t, Buffer.alloc(BATCH + 1)); t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = await f.connect(); const file = await f.open(c);
  t.mock.timers.tick(59000); await c.dc.request(file.ticket);
  t.mock.timers.tick(1000); assert.equal(c.pc.closes, 0);
  t.mock.timers.tick(59000); assert.equal(c.pc.closes, 1);
});

test('legal short reads fill a bounded block without truncating the wire', async (t) => {
  const bytes = Buffer.alloc(CHUNK + 7, 0x42);
  const f = await fixture(t, bytes); const c = await f.connect(); const file = await f.open(c);
  const read = f.handles[0].read;
  f.handles[0].read = (buffer, offset, length, position) => read(buffer, offset, Math.min(length, 997), position);
  await c.dc.request(file.ticket);
  assert.deepEqual(c.dc.sent.map((block) => block.length), [CHUNK, 7, 0]);
  assert.deepEqual(Buffer.concat(c.dc.sent), bytes); assert.equal(c.pc.closes, 0);
  assert.ok(f.reads.length > 3); assert.ok(f.reads.every((length) => length <= 997));
});

test('zero-byte early read is mutation, not successful EOF', async (t) => {
  const f = await fixture(t); const c = await f.connect(); const file = await f.open(c);
  f.handles[0].read = async () => ({ bytesRead: 0 });
  await c.dc.request(file.ticket); assert.equal(c.pc.closes, 1); assert.equal(c.dc.sent.length, 0);
});

test('EOF closes descriptor and allows immediate next open before sender settles', async (t) => {
  const gate = deferred(), eof = deferred(); let firstEof = true;
  const f = await fixture(t, undefined, { sendBinary: async (dc, bytes) => {
    dc.sent.push(Buffer.from(bytes));
    if (!bytes.length && firstEof) { firstEof = false; eof.resolve(); await gate.promise; }
  } });
  const c = await f.connect(); const file = await f.open(c); const first = c.dc.request(file.ticket);
  await eof.promise; assert.equal(f.handles[0].closes, 1);
  const next = await f.open(c); await c.dc.request(next.ticket);
  gate.resolve(); await first;
  assert.deepEqual(c.dc.sent.map((block) => block.length), [5, 0, 5, 0]);
  assert.equal(c.pc.closes, 0); assert.equal(f.handles[1].closes, 1);
});

test('settling old EOF does not unlock a newer active batch', async (t) => {
  const firstGate = deferred(), secondGate = deferred(), eof = deferred(), secondSend = deferred(); let sends = 0;
  const f = await fixture(t, undefined, { sendBinary: async () => {
    const sent = ++sends;
    if (sent === 2) { eof.resolve(); await firstGate.promise; }
    if (sent === 3) { secondSend.resolve(); await secondGate.promise; }
  } });
  const c = await f.connect(); const file = await f.open(c); const first = c.dc.request(file.ticket);
  await eof.promise; const next = await f.open(c); const second = c.dc.request(next.ticket);
  await secondSend.promise; firstGate.resolve(); await first;
  await c.dc.request(next.ticket); assert.equal(c.pc.closes, 1);
  secondGate.resolve(); await second; assert.equal(sends, 3);
});

test('EOF rechecks mutation at an exact 16-block batch boundary', async (t) => {
  const f = await fixture(t, Buffer.alloc(BATCH)); const c = await f.connect(); const file = await f.open(c);
  await c.dc.request(file.ticket); assert.equal(c.dc.sent.length, 16);
  await fs.utimes(f.file, new Date(), new Date(Date.now() + 5000));
  await c.dc.request(file.ticket, BATCH);
  assert.equal(c.dc.sent.length, 16); assert.equal(c.pc.closes, 1);
});

test('synchronous transport close with a never-settling sender cancels immediately', async (t) => {
  const f = await fixture(t, undefined, { sendBinary: (dc) => { dc.onclose(); return new Promise(() => {}); } });
  const c = await f.connect(); const file = await f.open(c);
  await c.dc.request(file.ticket); assert.equal(c.pc.closes, 1); assert.equal(f.handles[0].closes, 1);
});

test('cleanup and sender rejections are safely contained by event callbacks', async (t) => {
  const f = await fixture(t, undefined, { sendBinary: async () => { throw new Error('send failure'); } });
  const c = await f.connect(); const file = await f.open(c);
  const close = f.handles[0].close.bind(f.handles[0]);
  f.handles[0].close = async () => { await close(); throw new Error('close failure'); };
  c.pc.close = async () => { c.pc.closes++; throw new Error('RTC close failure'); };
  await c.dc.request(file.ticket); await immediate();
  assert.equal(c.pc.closes, 1); assert.equal(f.handles[0].closes, 1);
});

for (const identity of ['dev', 'ino']) test('opened descriptor rejects mismatched ' + identity, async (t) => {
  const f = await fixture(t); const c = await f.connect(); const resolved = await f.resolve();
  resolved.info[identity] += 4096; // Windows inode numbers can exceed safe-integer precision.
  f.resolve = async () => resolved;
  await assert.rejects(f.open(c), /CHANGED/); assert.equal(f.handles[0].closes, 1);
});

test('idle timeout cancels a stuck open and closes the late fd', async (t) => {
  const f = await fixture(t); t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = await f.connect(); const entered = deferred(), gate = deferred(); const original = f.openFile;
  f.openFile = (...args) => { entered.resolve(args); return gate.promise; };
  const opening = f.open(c); const rejected = assert.rejects(opening, /TIMEOUT/);
  const args = await entered.promise; t.mock.timers.tick(60000); await rejected;
  const handle = await original(...args); gate.resolve(handle); await immediate();
  assert.equal(handle.closes, 1); assert.equal(c.pc.closes, 1);
});

test('closePeer leaves other peers active and ignores late RTC state callbacks', async (t) => {
  const f = await fixture(t); const a = await f.connect(); const b = await f.connect('bob');
  f.manager.closePeer('alice'); a.pc.onconnectionstatechange();
  const file = await f.open(b); await b.dc.request(file.ticket);
  assert.equal(a.pc.closes, 1); assert.equal(b.pc.closes, 0);
});

test('completed ICE gathering at 16 seconds is not killed before the 30s RPC deadline', async (t) => {
  const gate = deferred(), entered = deferred();
  const pc = new RTC();
  pc.setLocalDescription = async value => { entered.resolve(); await gate.promise; pc.localDescription = value; };
  const f = await fixture(t, undefined, { createPeerConnection: async () => pc });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const offer = f.manager.handle('alice', { action: 'offer', sdp: 'sdp' });
  void offer.catch(() => {});
  t.after(() => gate.resolve());
  await entered.promise; t.mock.timers.tick(16000);
  assert.equal(pc.closes, 0, 'slow config plus TURN retry must not kill usable local ICE');
  gate.resolve();
  assert.equal((await offer).sdp, 'answer-sdp');
});

test('offer deadline is 25 seconds including stalled async factory', async (t) => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t, undefined, { createPeerConnection: () => { entered.resolve(); return gate.promise; } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const offer = f.manager.handle('alice', { action: 'offer', sdp: 'sdp' }); const rejected = assert.rejects(offer, /TIMEOUT/);
  let timedOut = false; void rejected.then(() => { timedOut = true; });
  await entered.promise; t.mock.timers.tick(24999); await immediate();
  assert.equal(timedOut, false);
  t.mock.timers.tick(1); await rejected;
  const pc = new RTC(); gate.resolve(pc); await immediate(); assert.equal(pc.closes, 1);
});
