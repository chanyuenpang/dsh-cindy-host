/** Targeted, local-only probe: production mobile HTML + SCTP SSN wrap. No account/APK/build. */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFilePeerConnection, sendFilePeerBinary } from '../src/file-peer-rtc.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const cindy = resolve(root, process.env.CINDY_SOURCE_ROOT || '../Cindy');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || join(cindy, 'node_modules/playwright-core'));
const exe = [process.env.CHROMIUM_EXECUTABLE, chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => p && existsSync(p));
const asset = readFileSync(join(cindy, 'packages/device-link/src/filePeerRuntimeSource.ts'), 'utf8');
const { FILE_PEER_RUNTIME_SOURCE } = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(asset)).toString('base64'));
const component = readFileSync(join(cindy, 'apps/mobile/src/device-link/peerFileTransport.tsx'), 'utf8');
const htmlBody = component.split('const html = `')[1].split('`;')[0];
const html = Function('FILE_PEER_RUNTIME_SOURCE', 'return `' + htmlBody + '`;')(FILE_PEER_RUNTIME_SOURCE);
let browser, pc;
const count = 65540; // 1,073,741,824-byte boundary with 16KiB blocks, using only 65,540 bytes here.
let timer;
const main = async () => {
  browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.evaluate(() => {
    window.probe = { ready: false, count: 0, error: null, writes: 0, bytes: 0 };
    const RTC = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends RTC {
      createDataChannel(...args) {
        const dc = super.createDataChannel(...args);
        window.probeChannel = dc;
        window.countMessage = e => {
          const bytes = new Uint8Array(e.data);
          if (bytes.length !== 1 || bytes[0] !== (window.probe.count & 255)) window.probe.error = 'order-or-byte-mismatch';
          window.probe.count++;
        };
        dc.addEventListener('message', window.countMessage);
        return dc;
      }
    };
    window.ReactNativeWebView = { postMessage: text => {
      const m = JSON.parse(text);
      if (m.type === 'ready') window.probe.ready = true;
      if (m.type === 'write') {
        window.probe.writes++; window.probe.bytes += atob(m.args[2]).length;
        queueMicrotask(() => window.filePeerMessage({ type: 'writeReply', id: m.id, ok: true }));
      }
    } };
  });
  await page.setContent(html);
  assert.equal(await page.evaluate(() => window.probe.ready), true, 'generated HTML reached ready');
  const offer = await page.evaluate(() => runtime.offer('probe', []));
  pc = await createFilePeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:9' }] });
  let channel;
  pc.ondatachannel = e => { channel = e.channel; };
  await pc.setRemoteDescription({ type: 'offer', sdp: offer });
  await pc.setLocalDescription(await pc.createAnswer());
  await page.evaluate(sdp => runtime.answer('probe', sdp), pc.localDescription.sdp);
  for (let i = 0; i < count; i++) {
    await sendFilePeerBinary(channel, Buffer.from([i & 255]));
    if ((i & 127) === 127) await new Promise(resolve => setImmediate(resolve));
    while (channel.bufferedAmount > 64 * 1024) await new Promise(resolve => setTimeout(resolve, 1));
  }
  await page.waitForFunction(n => window.probe.count >= n, count, { timeout: 30000 });
  const wrapped = await page.evaluate(() => window.probe);
  assert.equal(wrapped.count, count); assert.equal(wrapped.error, null);
  await page.evaluate(() => window.probeChannel.removeEventListener('message', window.countMessage));
  channel.onmessage = async () => {
    await sendFilePeerBinary(channel, Buffer.alloc(16384, 7));
    await sendFilePeerBinary(channel, Buffer.alloc(0));
  };
  await page.evaluate(() => runtime.receive('probe', '00000000-0000-4000-8000-000000000001', 16384, 'synthetic-sink'));
  const result = await page.evaluate(() => window.probe);
  assert.equal(result.writes, 1); assert.equal(result.bytes, 16384); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', productionMobileHtml: true, generatedRuntime: true, cspApplied: true, orderedMessages: count, syntheticBytes: count + 16384, sequenceWrap: true, receiveAfterWrap: true, nativeAndroid: false, credentials: false }));
};
try {
  await Promise.race([main(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DEADLINE_45_SECONDS')), 45000); })]);
} finally {
  clearTimeout(timer);
  await pc?.close();
  await browser?.close();
}
