import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startHost, deviceListUrl } from '../src/host.js';
import { parseAuthEndpoints } from '../src/cindy-auth-endpoints.js';

const ON = { transportEnabled: true, remoteControlEnabled: true, controllers: {} };
class Socket extends EventEmitter { readyState = 1; sent = []; send(value) { this.sent.push(JSON.parse(value)); } close() {} }
class Peer {
  iceGatheringState = 'complete'; connectionState = 'connected'; signalingState = 'stable';
  async setRemoteDescription(value) { this.remoteDescription = value; }
  async createAnswer() { return { type: 'answer', sdp: 'answer-sdp' }; }
  async setLocalDescription(value) { this.localDescription = value; }
  close() { this.connectionState = 'closed'; }
}
const epFor = region => parseAuthEndpoints({ schemaVersion: 1, authApiBaseUrl: region === 'cn' ? 'https://auth.cindy.com.cn' : 'https://auth.cindy.app',
  deviceLinkApiBaseUrl: region === 'cn' ? 'https://device-link.cindy.com.cn' : 'https://device-link.cindy.app' }, region);
const storedFor = region => ({ sessionVersion: 2, realm: region, endpointSnapshot: epFor(region), authBaseUrl: epFor(region).authApiBaseUrl,
  deviceId: 'host', kind: 'apple', identifier: 'User', accessToken: 'TOKEN-' + region, refreshToken: 'REFRESH-' + region });

for (const region of ['cn', 'global']) test(`${region}: real runtime socket, device directory, media staging and ICE use the same region`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'host-auth-region-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'document.txt'); await writeFile(path, Buffer.alloc(1024 * 1024, 42));
  let stored = storedFor(region); const calls = []; const directories = []; const sockets = [];
  const runtime = await startHost(undefined, ON, {
    credentialPorts: { loadSession: async () => stored, saveSession: async session => { stored = session; }, refreshStoredSession: async session => ({ ok: true, session }) },
    openSocket: (session, url) => { const socket = new Socket(); sockets.push({ socket, session, url }); return socket; },
    listDevices: async (session, relay) => { directories.push(deviceListUrl(relay)); return { devices: [] }; }, heartbeatMs: 0,
    filePeerOptions: { createPeerConnection: async () => new Peer() },
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/media/presign-put')) return new Response(JSON.stringify({ key: 'test-key', putUrl: 'https://storage.example/test' }));
      if (String(url).endsWith('/ice-servers')) return new Response(JSON.stringify({ iceServers: [{ urls: 'stun:example.test' }] }));
      return new Response('{}');
    },
  });
  t.after(() => runtime.stop());
  const { socket, url } = sockets[0]; const root = epFor(region).deviceLinkApiBaseUrl;
  assert.equal(url, root.replace('https:', 'wss:') + '/api/device-link/ws');
  socket.emit('open'); socket.emit('message', Buffer.from(JSON.stringify({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'host', userId: 'account' } })));
  await new Promise(resolve => setImmediate(resolve));
  const media = await runtime.invokeForTest('device-link:media:fetch', [{ url: 'xdt-file://open?path=' + encodeURIComponent(path), thumbnail: false }]);
  assert.equal(media.reply.payload.ok, true, JSON.stringify(media));
  const peer = await runtime.invokeForTest('device-link:file-peer', [{ action: 'offer', sdp: 'offer-sdp' }]);
  assert.equal(peer.reply.payload.ok, true, JSON.stringify(peer));
  assert.ok(directories.includes(root + '/api/device-link/devices'));
  assert.ok(calls.some(call => call.url === root + '/api/device-link/media/presign-put'), JSON.stringify({ media, urls: calls.map(call => call.url) }));
  assert.ok(calls.some(call => call.url === root + '/api/device-link/ice-servers'));
  for (const call of calls.filter(call => call.url.startsWith(root))) {
    const headers = new Headers(call.init.headers); assert.equal(headers.get('authorization'), 'Bearer TOKEN-' + region);
  }
});

test('a credential realm changed outside this runtime cannot be sent to its old relay on reconnect', async t => {
  let stored = storedFor('cn'); const sockets = [];
  const runtime = await startHost(undefined, ON, {
    credentialPorts: { loadSession: async () => stored, saveSession: async session => { stored = session; }, refreshStoredSession: async session => ({ ok: true, session }) },
    openSocket: (session, url) => { sockets.push({ session, url }); return new Socket(); }, heartbeatMs: 0,
  });
  t.after(() => runtime.stop()); assert.equal(sockets.length, 1);
  stored = storedFor('global'); await runtime.reconnectNow();
  assert.equal(sockets.length, 1, 'global credentials must not reach the old mainland network');
});
