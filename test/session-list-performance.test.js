import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createSessionControllerSource } from '../src/dsh-session-source.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const record = id => ({ sessionId: String(id), createdAt: 1, updatedAt: 10 + Number(id), cwd: '/project',
  projections: { values: { title: `Task ${id}`, sessionListMetadata: { blank: false, lastPromptAt: 10 + Number(id) } } } });
for (const count of [20, 200, 2000]) test(`synthetic ${count}-row cold/warm catalog keeps exact repair and body reads bounded`, async t => {
  const items = Array.from({ length: count }, (_, i) => record(i)); let exact = 0, headers = 0, evidence = 0;
  const source = createSessionControllerSource({ sessionController: { list: async () => ({ items }) },
    readSessionSummary: async id => { exact++; return items[Number(id)]; },
    readSessionMeta: async () => { headers++; throw Error('duplicate corpus scan'); },
    readActivityEvidence: async () => { evidence++; return { messageCount: 0, userSendAt: null }; },
  }); t.after(() => source.dispose());
  const start = performance.now(); const first = await source.listSessions({ limit: 200, evidence: false, fresh: true });
  const coldMs = performance.now() - start; assert.equal(first.length, Math.min(count, 200));
  const initial = exact; const samples = [];
  for (let i = 0; i < 20; i++) {
    const before = performance.now(); await source.listSessions({ limit: 200, evidence: false, fresh: true }); samples.push(performance.now() - before);
  }
  assert.equal(exact, initial, 'known core is reused via the continuously observed view, not replayed per fresh request');
  assert.equal(headers, 0); assert.equal(evidence, 0, 'ordinary core reads do not load transcript bodies');
  samples.sort((a, b) => a - b); t.diagnostic(JSON.stringify({ synthetic: true, count, coldMs, warmP95Ms: samples[18], exact, headers, bodyReads: evidence }));
});

test('one core semaphore bounds concurrent exact callers and disposal drains the queue', async () => {
  let release; const hold = new Promise(resolve => { release = resolve; }); let active = 0, peak = 0;
  const source = createSessionControllerSource({ sessionController: { list: async () => ({ items: [] }) },
    readSessionSummary: async id => { peak = Math.max(peak, ++active); await hold; active--; return record(id); } });
  const requests = Array.from({ length: 20 }, (_, i) => source.getSession(String(i)));
  await tick(); assert.equal(peak, 2); release(); await Promise.all(requests); assert.equal(peak, 2); source.dispose();
});
test('malformed catalogs are not interpreted as a successful empty list', async () => {
  const source = createSessionControllerSource({ sessionController: { list: async () => ({}) } });
  await assert.rejects(source.listSessions(), /catalog is unavailable/); source.dispose();
});
test('evidence cannot overwrite core fields, and explicit invalidation repairs without another list read', async () => {
  let count = 1; const events = [];
  const source = createSessionControllerSource({ sessionController: { list: async () => ({ items: [record(0)] }) },
    readSessionSummary: async () => record(0), readActivityEvidence: async () => ({ messageCount: count, userSendAt: null,
      title: 'must not override', updatedAt: '2099-01-01', privateBody: 'do not retain' }) });
  source.onListChange(event => events.push(event)); await source.listSessions(); await source.evidenceSettled();
  assert.equal(source.peekSession('0').title, 'Task 0'); assert.equal(source.peekSession('0').privateBody, undefined);
  count = 2; source.invalidateActivityEvidence('0'); await source.evidenceSettled();
  assert.equal(source.peekSession('0').messageCount, 2); assert.equal(events.at(-1).kind, 'evidence'); source.dispose();
});
test('catalog disappearance is confirmed by exact identity and retires the old row', async () => {
  let present = true; const events = [];
  const source = createSessionControllerSource({ sessionController: { list: async () => ({ items: present ? [record(0)] : [] }) },
    readSessionSummary: async () => present ? record(0) : undefined });
  source.onListChange(event => events.push(event)); await source.listSessions({ evidence: false }); present = false;
  assert.deepEqual(await source.listSessions({ fresh: true }), []);
  assert.ok(events.some(event => event.kind === 'row' && event.sessionId === '0' && event.row === undefined)); source.dispose();
});
