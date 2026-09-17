/**
 * Reproduce the export channel's refusals in isolation: the socket path is not
 * involved, so whatever answers here is exactly what the channel produced.
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixtureDshSource } from '../src/fixture-source.js';
import { startHost } from '../src/host.js';

const ON = { transportEnabled: true, remoteControlEnabled: true, controllers: {} };
class FakeSocket {
  constructor() { this.sent = []; this.handlers = new Map(); this.readyState = 1; }
  on(event, handler) { const list = this.handlers.get(event) ?? []; list.push(handler); this.handlers.set(event, list); return this; }
  emit(event, ...args) { for (const handler of this.handlers.get(event) ?? []) handler(...args); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() {}
  frame(data) { this.emit('message', Buffer.from(JSON.stringify(data))); }
}

const workdir = await mkdtemp(join(tmpdir(), 'dsh-export-probe-'));
await writeFile(join(workdir, 'cat.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
const runtime = await startHost(new FixtureDshSource(), ON, {
  resolveSession: async () => ({ ok: true, session: { deviceId: 'host-handle', kind: 'phone', identifier: '13800000000', accessToken: 'tok' } }),
  openSocket: () => new FakeSocket(),
  heartbeatMs: 0,
});
const cases = [
  ['start ok', [{ op: 'exportFileStart', workdir, relPath: 'cat.png' }]],
  ['escape ..', [{ op: 'exportFileStart', workdir, relPath: '../secret.png' }]],
  ['absolute', [{ op: 'exportFileStart', workdir, relPath: 'C:\\Windows\\win.ini' }]],
  ['unknown id', [{ op: 'exportFileStatus', workdir, transferId: 'exp_nope' }]],
];
for (const [label, args] of cases) {
  const started = Date.now();
  try {
    const reply = await runtime.invokeForTest('file-browser:remote-op', args);
    console.log(`${label}: ${Date.now() - started}ms ${JSON.stringify(reply?.reply?.payload ?? reply)}`);
  } catch (error) {
    console.log(`${label}: THREW after ${Date.now() - started}ms ${String(error?.message ?? error)}`);
  }
}
await runtime.stop();
await rm(workdir, { recursive: true, force: true });
