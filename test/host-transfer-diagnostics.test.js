import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransferDiagnostics } from '../src/host-transfer-diagnostics.js';
import { buildDiagnostics } from '../src/dsh-plugin.js';

test('transfer diagnostics have bounded cardinality, metadata and copies', () => {
  let now = 0;
  const d = createTransferDiagnostics({ now: () => now++, limit: Infinity });
  for (let i = 0; i < 10000; i++) d.record({ event: 'SECRET' + i, stage: 'SECRET', code: 'SECRET', token: 'SECRET', path: 'SECRET', key: 'SECRET', userId: 'SECRET', connection: 'SECRET', size: i });
  const snap = d.snapshot();
  assert.equal(snap.events.length, 128);
  assert.deepEqual(snap.counters, { 'oss:other': 10000 });
  assert.doesNotMatch(JSON.stringify(snap), /SECRET/);
  snap.events[0].size = -1;
  snap.counters['oss:other'] = -1;
  assert.ok(d.snapshot().events[0].size >= 0);
  assert.equal(d.snapshot().counters['oss:other'], 10000);
  d.clear();
  assert.deepEqual(d.snapshot(), { counters: {}, events: [] });
});

test('progress is throttled but safe terminal and error stages remain distinguishable', () => {
  const d = createTransferDiagnostics({ now: () => 1234 });
  for (let i = 0; i < 500; i++) d.record({ transport: 'peer', event: 'bytes-queued', queuedBytes: i });
  d.record({ transport: 'peer', event: 'eof-queued', queuedBytes: 500 });
  d.record({ event: 'error', stage: 'put', code: 'SOURCE_CHANGED' });
  const result = d.snapshot();
  assert.equal(result.events.length, 3);
  assert.equal(result.counters['peer:bytes-queued'], 500);
  assert.equal(result.events.at(-1).code, 'SOURCE_CHANGED');
  assert.ok(!('complete' in result.counters));
});

test('existing diagnostic projection is pure and isolates a faulty producer', () => {
  let reads = 0;
  const runtime = { getTransferDiagnostics() { reads++; return { events: [] }; } };
  assert.deepEqual(buildDiagnostics({ runtime }).transfers, { events: [] });
  assert.equal(reads, 1);
  runtime.getTransferDiagnostics = () => { throw new Error('unavailable'); };
  assert.equal(buildDiagnostics({ runtime }).transfers, null);
  assert.equal(buildDiagnostics({}).transfers, null);
});

test('actor/source aliases correlate within a scope and rotate on clear', () => {
  const d = createTransferDiagnostics();
  const facts = { actor: 'PRIVATE-controller', owner: { runtimeId: 'r', epoch: 1, realm: 'PRIVATE-realm', userId: 'PRIVATE-user' }, real: 'C:/PRIVATE/path.apk', info: { dev: 1, ino: 2, size: 3, mtimeMs: 4 } };
  const tags = d.identify(facts);
  assert.deepEqual(d.identify(facts), tags);
  d.record({ ...facts, ...tags, transport: 'peer', event: 'file-open' });
  d.record({ ...tags, event: 'accepted' });
  const events = d.snapshot().events;
  assert.equal(events[0].sourceId, events[1].sourceId);
  assert.equal(events[0].actorId, events[1].actorId);
  assert.notEqual(d.identify({ ...facts, actor: 'different' }).actorId, tags.actorId);
  assert.doesNotMatch(JSON.stringify(d.snapshot()), /PRIVATE/);
  d.clear();
  assert.notEqual(d.identify(facts).sourceId, tags.sourceId);
});

