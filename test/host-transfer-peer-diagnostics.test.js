import test from 'node:test';
import assert from 'node:assert/strict';
import { createFilePeerManager } from '../src/host-file-peer.js';
import { createTransferDiagnostics } from '../src/host-transfer-diagnostics.js';

for (const broken of [false, true]) test('peer observation is non-authoritative, including broken observer=' + broken, async () => {
  const info = { size: 0, mtimeMs: 1, dev: 1, ino: 2, isFile: () => true };
  const d = createTransferDiagnostics();
  let pc;
  let closes = 0;
  const chunks = [];
  const manager = createFilePeerManager({
    resolveFile: async () => ({ ok: true, real: 'C:/PRIVATE/file.apk', info }),
    isAllowed: () => true, loadIceServers: async () => [],
    createPeerConnection: async () => (pc = {
      iceGatheringState: 'complete', signalingState: 'stable',
      setRemoteDescription: async () => {}, createAnswer: async () => ({ type: 'answer', sdp: 'PRIVATE-SDP' }),
      async setLocalDescription(answer) { this.localDescription = answer; }, close() {},
    }),
    openFile: async () => ({ stat: async () => info, close: async () => { closes++; } }),
    sendBinary: async (_dc, bytes) => { chunks.push(bytes.length); },
    identify: facts => d.identify(facts),
    onEvent: broken ? async () => { throw new Error('observer failure'); } : event => d.record(event),
  });
  try {
    const offer = await manager.handle('PRIVATE-controller', { action: 'offer', sdp: 'PRIVATE-offer' });
    const dc = { label: 'files-v1', ordered: true, readyState: 'open', bufferedAmount: 0, close() {} };
    pc.ondatachannel({ channel: dc });
    const opened = await manager.handle('PRIVATE-controller', { action: 'open', connection: offer.connection, url: 'PRIVATE-url' });
    await dc.onmessage({ data: JSON.stringify({ ticket: opened.ticket, offset: 0, credit: 16 }) });
    assert.deepEqual(chunks, [0]);
    assert.equal(closes, 1);
    if (!broken) {
      const rows = d.snapshot().events;
      assert.deepEqual(rows.map(row => row.event), ['offer-answer', 'dc-open', 'file-open', 'eof-queued']);
      assert.equal(rows[2].sourceId, rows[3].sourceId);
      assert.equal(rows[1].actorId, rows[3].actorId);
      assert.doesNotMatch(JSON.stringify(d.snapshot()), /PRIVATE|received|download-complete/);
    }
  } finally { manager.closeAll(); }
});
