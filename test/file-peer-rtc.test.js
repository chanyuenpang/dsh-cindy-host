import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { createFilePeerConnection, sendFilePeerBinary } from '../src/file-peer-rtc.js';

function fakeChannel() {
  const wire = [];
  const channel = {
    readyState: 'open', bufferedAmount: 0, messagesSent: 0, bytesSent: 0,
    addBufferedAmount(amount) { this.bufferedAmount += amount; },
    send(bytes) { wire.push(bytes); this.messagesSent++; this.bytesSent += bytes.length; },
    sctp: { dataChannelQueue: [], async dataChannelFlush() {
      for (const [dc, ppid, bytes] of this.dataChannelQueue.splice(0)) {
        wire.push({ ppid, bytes });
        dc.addBufferedAmount(-bytes.length);
      }
    } },
  };
  return { channel, wire };
}

test('werift private EOF shim is pinned: upgrades require the real Chromium smoke', () => {
  const require = createRequire(import.meta.url);
  const installed = JSON.parse(readFileSync(resolve(dirname(require.resolve('werift')), '../../../package.json'), 'utf8'));
  const project = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(installed.version, '0.24.4');
  assert.equal(project.dependencies.werift, '0.24.4');
});

test('factory returns a real peer and preserves supplied ICE server configuration', async () => {
  const iceServers = [{ urls: 'stun:127.0.0.1:3478' }];
  const pc = await createFilePeerConnection({ iceServers });
  try {
    assert.equal(typeof pc.createAnswer, 'function');
    assert.equal(typeof pc.onDataChannel.subscribe, 'function');
    assert.deepEqual(pc.getConfiguration().iceServers, iceServers);
  } finally { await pc.close(); }
});

test('nonempty Buffer is forwarded without copying or altering payload bytes', async () => {
  const { channel, wire } = fakeChannel();
  const bytes = Buffer.from([0, 1, 254, 255]);
  await sendFilePeerBinary(channel, bytes);
  assert.equal(wire[0], bytes);
  assert.equal(channel.bytesSent, 4);
  assert.equal(channel.messagesSent, 1);
});

test('empty EOF uses queued PPID57 + one ignored octet, including repeated transfers', async () => {
  const { channel, wire } = fakeChannel();
  for (let i = 0; i < 2; i++) {
    await sendFilePeerBinary(channel, Buffer.from([i]));
    await sendFilePeerBinary(channel, Buffer.alloc(0));
  }
  assert.deepEqual(wire, [Buffer.from([0]), { ppid: 57, bytes: Buffer.from([0]) },
    Buffer.from([1]), { ppid: 57, bytes: Buffer.from([0]) }]);
  assert.equal(channel.bufferedAmount, 0);
  assert.equal(channel.messagesSent, 4);
  assert.equal(channel.bytesSent, 2);
});

test('EOF shares the existing transport queue and its accounting', async () => {
  const { channel, wire } = fakeChannel();
  channel.addBufferedAmount(3);
  channel.sctp.dataChannelQueue.push([channel, 53, Buffer.from([1, 2, 3])]);
  await sendFilePeerBinary(channel, Buffer.alloc(0));
  assert.deepEqual(wire.map(value => value.ppid), [53, 57]);
  assert.equal(channel.bufferedAmount, 0);
});

test('rejects non-Buffer and closed/connecting channels without mutation', async () => {
  for (const bytes of ['', new Uint8Array(0), new ArrayBuffer(0), null]) {
    await assert.rejects(sendFilePeerBinary(fakeChannel().channel, bytes), /FILE_PEER_BINARY_REQUIRED/);
  }
  for (const readyState of ['connecting', 'closing', 'closed']) {
    const { channel, wire } = fakeChannel();
    channel.readyState = readyState;
    await assert.rejects(sendFilePeerBinary(channel, Buffer.alloc(0)), /FILE_PEER_CLOSED/);
    await assert.rejects(sendFilePeerBinary(channel, Buffer.from([1])), /FILE_PEER_CLOSED/);
    assert.equal(wire.length, 0);
    assert.equal(channel.bufferedAmount, 0);
  }
});

test('fails closed when pinned private EOF APIs are unavailable', async () => {
  for (const mutate of [c => { delete c.sctp; }, c => { c.sctp.dataChannelQueue = null; },
    c => { delete c.sctp.dataChannelFlush; }, c => { delete c.addBufferedAmount; },
    c => { delete c.messagesSent; }]) {
    const { channel } = fakeChannel();
    mutate(channel);
    await assert.rejects(sendFilePeerBinary(channel, Buffer.alloc(0)), /FILE_PEER_RTC_UNSUPPORTED/);
    assert.equal(channel.bufferedAmount, 0);
  }
});

test('synchronous send and asynchronous EOF flush failures reach the owner', async () => {
  const { channel } = fakeChannel();
  channel.send = () => { throw new Error('send failed'); };
  await assert.rejects(sendFilePeerBinary(channel, Buffer.from([1])), /send failed/);
  channel.sctp.dataChannelFlush = async () => { throw new Error('flush failed'); };
  await assert.rejects(sendFilePeerBinary(channel, Buffer.alloc(0)), /flush failed/);
});
