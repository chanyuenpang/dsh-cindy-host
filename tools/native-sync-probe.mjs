// Offline source -> actual plugin seam -> history projection probe. No account/network/model IO.
import { performance } from 'node:perf_hooks';
import { buildDshSource } from '../src/dsh-plugin.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function measure(durableRows, chunks = 1000) {
  let reads = 0; let wake; const queue = []; let revision = 1;
  const events = Array.from({ length: durableRows }, (_, seq) => ({ type: 'user/message', seq, time: 1000 + seq, surfaceOp: 'append', data: {
    id: 'u' + seq, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'u' + seq }] } }));
  const services = { sessionController: { follow: async function* (_request, signal) {
    yield { type: 'snapshot', assistantStream: { revision: 0 } };
    while (!signal.aborted) {
      if (!queue.length) await new Promise(resolve => {
        const done = () => { signal.removeEventListener('abort', done); resolve(); };
        wake = done; signal.addEventListener('abort', done, { once: true });
      });
      if (signal.aborted) return;
      yield { type: 'assistant-stream', frame: queue.shift() };
    }
  } }, sessionQuery: { readSession: async () => { reads++; return { events }; } } };
  const ctx = { get: key => services[key], on: () => () => {}, effect: fn => fn(),
    inject(names, fn) { if (names.every(key => services[key] !== undefined)) fn(ctx); return () => {}; } };
  const seam = buildDshSource(ctx, 'sessionController', { isSessionRunning: () => true });
  const controller = new AbortController();
  const push = async frame => { queue.push(frame); wake?.(); wake = null; await tick(); };
  try {
    seam.liveAssistant.watch('probe', () => {}, controller.signal); await tick();
    await push({ type: 'start', revision, attemptId: 'probe', startedAfterSeq: durableRows - 1, turn: 1, step: 1 });
    await push({ type: 'chunk', revision: ++revision, index: 0, attemptId: 'probe', time: 2000,
      chunk: { type: 'reasoning-delta', index: 0, text: '中文实时进度'.repeat(40) } });
    await seam.historyView.page('probe', undefined, { workLines: true });
    const before = seam.historyView.metrics(); const readsBefore = reads;
    const cpu = process.cpuUsage(); const memory = process.memoryUsage().heapUsed; const start = performance.now();
    for (let index = 1; index <= chunks; index++) {
      await push({ type: 'chunk', revision: ++revision, index, attemptId: 'probe', time: 2000 + index,
        chunk: { type: 'reasoning-delta', index: 0, text: '后续' } });
      await seam.historyView.page('probe', undefined, { workLines: true });
    }
    const elapsedMs = performance.now() - start; const usage = process.cpuUsage(cpu);
    const after = seam.historyView.metrics();
    return { durableRows, chunks, elapsedMs: Number(elapsedMs.toFixed(2)), cpuUserUs: usage.user, cpuSystemUs: usage.system,
      heapDeltaBytes: process.memoryUsage().heapUsed - memory,
      warmLogReads: reads - readsBefore, groupedRows: after.groupedRows - before.groupedRows,
      fullHashRows: after.fullHashRows - before.fullHashRows, stampedHashRows: after.stampedHashRows - before.stampedHashRows,
      source: seam.liveAssistant.stats(), scope: 'offline Host work counts/CPU only; not phone latency or total socket memory' };
  } finally { controller.abort(); seam.liveAssistant.stop(); }
}
for (const size of [10, 100000]) console.log(JSON.stringify(await measure(size)));
