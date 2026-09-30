/** Real werift/Host negotiation against a local blackhole TURN. No APK/account/public server. */
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';
import { createFilePeerManager } from '../src/host-file-peer.js';
import { createFilePeerConnection } from '../src/file-peer-rtc.js';
const sockets = new Set();
const tcp = createServer(socket => { sockets.add(socket); socket.on('data', () => {}); socket.on('close', () => sockets.delete(socket)); });
await new Promise((resolve, reject) => { tcp.once('error', reject); tcp.listen(0, '127.0.0.1', resolve); });
const blackhole = createSocket('udp4');
await new Promise((resolve, reject) => { blackhole.once('error', reject); blackhole.bind(tcp.address().port, '127.0.0.1', resolve); });
let packets = 0;
blackhole.on('message', () => packets++);
const stun = { urls: 'stun:127.0.0.1:9' };
// --legacy-budget injects the old deadline only in this disposable test worker.
const legacyBudget = process.argv.includes('--legacy-budget');
const extendedBudget = !legacyBudget;
const nativeTimeout = globalThis.setTimeout;
if (legacyBudget) globalThis.setTimeout = (callback, delay, ...args) => nativeTimeout(callback, delay === 25000 ? 15000 : delay, ...args);
let client, manager, pc;
const deadline = setTimeout(() => { console.error('PROBE_HARD_DEADLINE'); process.exit(2); }, 45000);
let exitCode = 1;
try {
  client = await createFilePeerConnection({ iceServers: [stun] });
  client.createDataChannel('files-v1', { ordered: true });
  await client.setLocalDescription(await client.createOffer());
  for (const withTurn of [false, true]) {
    let hostCandidates = 0;
    const servers = withTurn ? [stun, { urls: `turn:127.0.0.1:${blackhole.address().port}?transport=udp`, username: 'synthetic-test', credential: 'synthetic-test' }] : [stun];
    manager = createFilePeerManager({
      resolveFile: async () => { throw new Error('NO_FILE_OPERATION_ALLOWED'); },
      isAllowed: id => id === 'probe',
      loadIceServers: async () => { if (withTurn) await new Promise(resolve => setTimeout(resolve, 2750)); return servers; },
      createPeerConnection: async options => {
        pc = await createFilePeerConnection(options);
        pc.onicecandidate = event => { if (event.candidate?.candidate?.includes(' typ host ')) hostCandidates++; };
        return pc;
      },
    });
    const started = Date.now();
    let answer, error;
    try { answer = await manager.handle('probe', { action: 'offer', sdp: client.localDescription.sdp }); }
    catch (e) { error = e.message; }
    const result = { case: withTurn ? 'unresponsive-local-TURN' : 'STUN-only-control', elapsedMs: Date.now() - started, answered: Boolean(answer?.sdp), error: error ?? null, hostCandidates, turnPackets: packets, gatheringState: pc.iceGatheringState };
    console.log(JSON.stringify(result));
    if (withTurn) {
      assert.ok(hostCandidates > 0, 'local candidates existed');
      assert.ok(packets > 0, 'actual TURN allocation traffic reached the blackhole');
      if (extendedBudget) {
        assert.ok(answer?.sdp, '25-second budget permits the provider retry chain');
        await client.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
        await new Promise((resolve, reject) => {
          const timeout = nativeTimeout(() => reject(new Error('LOCAL_CONNECT_TIMEOUT')), 8000);
          const check = () => { if (client.connectionState === 'connected') { clearTimeout(timeout); resolve(); } };
          client.onconnectionstatechange = check; check();
        });
        console.log(JSON.stringify({ extendedBudget, localConnectionEstablished: true }));
      } else assert.equal(error, 'FILE_PEER_TIMEOUT');
    } else assert.ok(answer?.sdp);
    manager.closeAll();
    await pc.close();
  }
  console.log(extendedBudget ? 'PASS: same synthetic ICE conditions connect with 25s offer budget; no file bytes transferred.' : 'CONFIRMED: 15s offer deadline expires despite local candidates; no file bytes transferred.');
  exitCode = 0;
} finally {
  manager?.closeAll();
  await pc?.close();
  await client?.close();
  for (const socket of sockets) socket.destroy();
  tcp.close();
  blackhole.close();
  clearTimeout(deadline);
}
// The pinned provider can retain an unfinished TURN allocation until its own retransmission deadline.
// This isolated diagnostic worker must not leave it alive in the user's environment.
process.exit(exitCode);
