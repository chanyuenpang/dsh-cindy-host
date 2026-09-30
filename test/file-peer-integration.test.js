import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChannelRouter, SUPPORTED_CHANNELS } from '../src/cindy-channels.js';
import { createLocalFileResolver } from '../src/host-media-fetch.js';
import { createLocalFileUrl } from '../src/host-file-reference.js';
import { FILE_PEER_CHANNEL, FILE_PEER_MAX_BYTES } from '../src/file-peer-protocol.js';
import { startHost } from '../src/host.js';

const request = (channel, args, src = 'phone') => ({ v: 1, kind: 'invoke', id: 'req', src, payload: { channel, args } });
const router = capabilities => createChannelRouter({ listSessions: async () => [], resolveCapabilities: () => capabilities });

test('file-peer routes relay identity, advertises allowlist, and hides internal error details', async () => {
  assert.ok(SUPPORTED_CHANNELS.includes(FILE_PEER_CHANNEL));
  let seen;
  const route = router({ filePeer: async (peer, payload) => { seen = { peer, payload }; return { version: 1 }; } });
  const payload = { action: 'caps', peer: 'spoofed' };
  assert.deepEqual((await route(request(FILE_PEER_CHANNEL, [payload]))).payload.result, { version: 1 });
  assert.deepEqual(seen, { peer: 'phone', payload });
  assert.equal((await router({})(request(FILE_PEER_CHANNEL, [{}]))).payload.error.code, 'NOT_AVAILABLE');
  const failed = await router({ filePeer: () => { throw new Error('credential/path must not leak'); } })(request(FILE_PEER_CHANNEL, [{}]));
  assert.deepEqual(failed.payload.error, { code: 'FILE_PEER_FAILED', message: 'FILE_PEER_FAILED' });
});

test('whole-file capability, fileUrl and prepareOnly reach the Host while old export jobs stay intact', async () => {
  let prepared;
  const route = router({
    fileUrl: async args => ({ ok: true, url: args.relPath }),
    fetchLocalMedia: async args => { prepared = args; return { ok: true, result: { size: 999, transferRequired: true } }; },
    exportFileStart: async () => ({ ok: true, transferId: 'legacy', size: 100 }),
    exportFileStatus: () => ({ ok: true, state: 'done', key: 'oss-key' }),
  });
  assert.equal((await route(request('file-browser:remote-op', [{ op: 'caps', workdir: '/w' }]))).payload.result.fileRead, true);
  assert.equal((await route(request('file-browser:remote-op', [{ op: 'fileUrl', workdir: '/w', relPath: 'a' }]))).payload.result.url, 'a');
  await route(request('device-link:media:fetch', [{ url: 'reference', prepareOnly: true }]));
  assert.equal(prepared.prepareOnly, true);
  assert.equal((await route(request('file-browser:remote-op', [{ op: 'exportFileStart' }]))).payload.result.transferId, 'legacy');
  assert.equal((await route(request('file-browser:remote-op', [{ op: 'exportFileStatus', transferId: 'legacy' }]))).payload.result.key, 'oss-key');
  const old = router({ fileBrowser: () => async () => ({ ok: true }) });
  assert.equal((await old(request('file-browser:remote-op', [{ op: 'caps', workdir: '/w' }]))).payload.result.fileRead, undefined);
});

test('fileUrl preserves shared local authorization and never guesses SSH as a local path', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'file-reference-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'a.bin'), 'hello');
  await writeFile(join(dir, '.env'), 'secret');
  const fileUrl = createLocalFileUrl({ resolveFile: createLocalFileResolver({ maxBytes: FILE_PEER_MAX_BYTES }) });
  const result = await fileUrl({ workdir: dir, relPath: 'a.bin' });
  assert.equal(result.ok, true);
  assert.equal(new URL(result.url).searchParams.get('path'), join(dir, 'a.bin'));
  for (const args of [{ workdir: 'ssh://remote/work', relPath: 'a' }, { workdir: dir, relPath: join(dir, 'a.bin') }, { workdir: dir, relPath: '../other' }, { workdir: dir, relPath: '.env' }]) {
    assert.equal((await fileUrl(args)).ok, false);
  }
});

class Socket extends EventEmitter {
  readyState = 1;
  waits = new Map();
  sequence = 0;
  send(text) {
    const frame = JSON.parse(text);
    if (frame.kind === 'invoke-result') this.waits.get(frame.id)?.(frame.payload);
  }
  close() { this.readyState = 3; }
  frame(data) { this.emit('message', Buffer.from(JSON.stringify(data))); }
  invoke(channel, args, src = 'phone') {
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waits.delete(id); reject(new Error('RPC timed out')); }, 2000);
      this.waits.set(id, value => { clearTimeout(timer); this.waits.delete(id); resolve(value); });
      this.frame({ ...request(channel, args, src), id });
    });
  }
}
class Peer {
  connectionState = 'connected';
  iceGatheringState = 'complete';
  closed = false;
  async setRemoteDescription() {
    this.ondatachannel?.({ channel: { label: 'files-v1', ordered: true, maxRetransmits: null, maxPacketLifeTime: null, readyState: 'open', bufferedAmount: 0, close() {}, send() {} } });
  }
  async createAnswer() { return { type: 'answer', sdp: 'answer' }; }
  async setLocalDescription(value) { this.localDescription = value; }
  async close() { this.closed = true; this.connectionState = 'closed'; }
}
const ON = { transportEnabled: true, remoteControlEnabled: true, controllers: {} };
async function fixture(t) {
  const socket = new Socket();
  const peers = [];
  const runtime = await startHost(null, ON, {
    resolveSession: async () => ({ ok: true, session: { accessToken: 'fake', deviceId: 'host' } }),
    openSocket: () => socket, heartbeatMs: 0, listDevices: async () => [],
    fetch: async () => { throw new Error('no external network permitted by this test'); },
    filePeerOptions: { loadIceServers: async () => [], createPeerConnection: async () => { const pc = new Peer(); peers.push(pc); return pc; } },
  });
  t.after(() => runtime.stop());
  return { socket, runtime, peers };
}

test('Host negotiates a large local download without reading/uploading it or changing legacy media cap', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'file-peer-host-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const handle = await open(join(dir, 'big.bin'), 'w');
  await handle.truncate(32 * 1024 * 1024 + 37);
  await handle.close();
  const { socket } = await fixture(t);
  assert.equal((await socket.invoke('file-browser:remote-op', [{ op: 'caps', workdir: dir }])).result.fileRead, true);
  const reference = await socket.invoke('file-browser:remote-op', [{ op: 'fileUrl', workdir: dir, relPath: 'big.bin' }]);
  assert.equal(reference.result.ok, true);
  const prepared = await socket.invoke('device-link:media:fetch', [{ url: reference.result.url, prepareOnly: true }]);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.result.transferRequired, true);
  assert.equal(prepared.result.size, 32 * 1024 * 1024 + 37);
  const legacy = await socket.invoke('device-link:media:fetch', [{ url: reference.result.url }]);
  assert.equal(legacy.ok, false);
  assert.equal(legacy.error.code, 'BAD_REQUEST');
});

for (const action of ['revoke', 'link-close', 'offline', 'relay-close', 'disable', 'stop']) {
  test(`Host invalidates file-peer connections on ${action}`, async t => {
    const { socket, runtime, peers } = await fixture(t);
    const offered = await socket.invoke(FILE_PEER_CHANNEL, [{ action: 'offer', sdp: 'offer' }]);
    assert.equal(offered.ok, true, JSON.stringify(offered));
    assert.equal(peers.length, 1);
    if (action === 'revoke') await runtime.updateSettings({ ...ON, controllers: { phone: { state: 'revoked' } } });
    if (action === 'link-close') socket.frame({ v: 1, kind: 'link-close', src: 'phone' });
    if (action === 'offline') socket.frame({ v: 1, kind: 'presence-changed', payload: { deviceId: 'phone', online: false } });
    if (action === 'relay-close') { socket.readyState = 3; socket.emit('close'); }
    if (action === 'disable') await runtime.updateSettings({ ...ON, transportEnabled: false, remoteControlEnabled: false });
    if (action === 'stop') await runtime.stop();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(peers[0].closed, true);
    if (action === 'revoke') {
      const denied = await socket.invoke(FILE_PEER_CHANNEL, [{ action: 'caps' }]);
      assert.equal(denied.error.code, 'CHANNEL_NOT_ALLOWED');
    }
  });
}
