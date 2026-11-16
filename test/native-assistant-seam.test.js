import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDshSource, capabilityProvider } from '../src/dsh-plugin.js';
import { createHistoryProjection } from '../src/history-snapshot.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const user = { type: 'user/message', seq: 0, time: 1000, surfaceOp: 'append', data: {
  id: 'prompt', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '开始' }] } };
function context(services) {
  const ctx = { get: key => services[key], on: () => () => {}, effect: fn => fn(),
    inject(names, fn) { if (names.every(name => services[name] !== undefined)) fn(ctx); return () => {}; } };
  return ctx;
}

test('real seam requests official passive baseline and updates history tail without repeated durability flush/log seed', async () => {
  const requests = []; let reads = 0; let flushes = 0; let projections = 0; let preference = 0; let push; let wake; const queue = [];
  const follow = async function* (request, signal) {
    requests.push(request);
    yield { type: 'snapshot', assistantStream: { revision: 0 } };
    while (!signal.aborted) {
      if (!queue.length) await new Promise(resolve => {
        const done = () => { signal.removeEventListener('abort', done); resolve(); };
        wake = done; signal.addEventListener('abort', done, { once: true });
      });
      if (signal.aborted) return;
      yield queue.shift();
    }
  };
  push = frame => { queue.push({ type: 'assistant-stream', frame }); wake?.(); wake = null; };
  const services = { sessionController: { follow }, sessionQuery: { readSession: async () => { reads++; return { events: [user] }; } },
    sessions: { get: () => ({}), flush: async () => { flushes++; return true; } },
    agents: { get: () => ({ status: 'running' }) },
    sessionPersistence: { open: async () => ({ read: async () => ({ events: [user] }), close: async () => {} }) } };
  const seam = buildDshSource(context(services), 'sessionController', { isSessionRunning: () => true,
    projectMessagesVersion: () => preference,
    projectMessages: rows => { projections++; return rows.map(row => preference && row.role === 'user' ? { ...row, content: '新偏好' } : row); },
  });
  const abort = new AbortController(); const changes = [];
  try {
    assert.equal(capabilityProvider(seam).liveAssistant, seam.liveAssistant);
    seam.liveAssistant.watch('s', change => changes.push(change), abort.signal);
    await tick();
    assert.deepEqual(requests, [{ address: { kind: 'session', sessionId: 's' }, activate: false, assistantStream: true, maxMessages: 1 }]);
    await seam.historyView.page('s', undefined, { workLines: true });
    push({ type: 'start', attemptId: 'a', revision: 1, startedAfterSeq: 0, turn: 1, step: 1 }); await tick();
    for (let index = 0; index < 50; index++) {
      push({ type: 'chunk', attemptId: 'a', revision: index + 2, index, time: 1100 + index,
        chunk: { type: 'reasoning-delta', index: 0, text: index ? '续' : '中文进度' } });
      await tick();
      const page = await seam.historyView.page('s', undefined, { workLines: true });
      assert.equal(page.result.items.at(-1).summary.lines[0].text.startsWith('中文进度'), true);
    }
    assert.equal(reads, 1, 'the native warm path seeds once rather than reading the log for each chunk');
    assert.equal(flushes, 0, 'presentation updates do not flush input receipt evidence');
    assert.equal(seam.historyView.metrics().rebuilds, 1);
    assert.equal(seam.historyView.metrics().fullHashRows, 0);
    assert.equal(changes.length, 50);
    assert.equal(projections, 1, 'presentation mapping of the sealed prefix is cached too');
    preference++;
    const projected = await seam.historyView.page('s', undefined, { workLines: true });
    assert.equal(projections, 2);
    assert.equal(projected.result.items[0].messages[0].content, '新偏好', 'changed preferences invalidate the prefix promise');
  } finally { abort.abort(); seam.liveAssistant.stop(); }
});

test('snapshot caching keeps immutable older snapshots and resets identity on duplicate stored ID', () => {
  const projection = createHistoryProjection('s');
  const row = { id: 'u', clientId: 'u', role: 'user', content: 'before' };
  projection.consume(user, [row]);
  const first = projection.snapshot();
  assert.equal(projection.snapshot(), first);
  projection.consume({ type: 'tool/call', seq: 1 }, []);
  assert.equal(projection.snapshot(), first, 'non-display events do not regroup history');
  projection.consume({ type: 'tool/result', seq: 2 }, [{ ...row, content: 'after' }]);
  const next = projection.snapshot();
  assert.notEqual(next.projection.identity, first.projection.identity);
  assert.equal(first.rows[0].content, 'before');
  assert.equal(next.rows[0].content, 'after');
});
