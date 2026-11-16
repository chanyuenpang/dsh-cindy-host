import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionControllerSource } from '../src/dsh-session-source.js';
const item = id => ({ sessionId: id, createdAt: 1, updatedAt: 10, cwd: '/work', formatStatus: 'current',
  projections: { kind: 'sequenced', asOfSeq: 2, values: { title: id, sessionListMetadata: { blank: false, lastPromptAt: 10 } } } });

test('native migration-required history cannot poison the current-format list or become fake absence', async t => {
  const old = { sessionId: 'old-v0', cwd: '/work', formatStatus: 'migration-required', blank: false, updatedAt: 1 };
  let migrated = false, legacyReads = 0;
  const source = createSessionControllerSource({
    sessionController: { list: async () => ({ items: [item('new'), migrated ? item('old-v0') : old] }) },
    readSessionSummary: async id => { if (id === 'old-v0' && !migrated) { legacyReads++; throw new Error('Native migration refuses unresolved tool call; source artifact unchanged'); } return item(id); },
  }); t.after(() => source.dispose());
  assert.deepEqual((await source.listSessions()).map(row => row.id), ['new']);
  assert.equal(legacyReads, 0, 'listing must not try to migrate unsupported source artifacts');
  assert.equal(source.listDiagnostics().migrationRequired, 1);
  await assert.rejects(source.getSession('old-v0'), /migration refuses/, 'an explicit exact read is an operational refusal, never NOT_FOUND');
  migrated = true;
  assert.deepEqual((await source.listSessions({ fresh: true })).map(row => row.id).sort(), ['new', 'old-v0']);
  assert.equal(source.listDiagnostics().migrationRequired, 0, 'the native owner can restore supported membership; no permanent absent cache');
});

test('migration scope changes fence an older exact observation before readmission', async t => {
  let status = 'current', title = 'initial', hold = false, release, reads = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const current = () => { const value = item('a'); value.formatStatus = status; value.projections.values.title = title; return value; };
  const source = createSessionControllerSource({ sessionController: { list: async () => ({ items: [current()] }) },
    readSessionSummary: async () => { reads++; const cut = current(); if (hold) { hold = false; await gate; } return cut; } });
  t.after(() => { release(); source.dispose(); });
  await source.listSessions(); hold = true; const old = source.getSession('a');
  await new Promise(resolve => setImmediate(resolve));
  status = 'migration-required'; assert.deepEqual(await source.listSessions({ fresh: true }), []);
  status = 'current'; title = 'readmitted'; const next = source.listSessions({ fresh: true });
  await new Promise(resolve => setImmediate(resolve)); release();
  assert.equal((await next)[0].title, 'readmitted'); assert.equal((await old).title, 'readmitted');
  assert.ok(reads >= 3);
});

test('a real error in a current-format session still rejects rather than silently publishing a partial list', async t => {
  const source = createSessionControllerSource({ sessionController: { list: async () => ({ items: [item('unreadable')] }) },
    readSessionSummary: async () => { throw Error('current-format I/O failed'); } }); t.after(() => source.dispose());
  await assert.rejects(source.listSessions(), /I\/O failed/);
});

test('a row dirtied after its catalog slot is repaired before the snapshot cut without enumeration', async t => {
  let data = [item('a'), item('b')], source, calls = 0, holdB = false, holdA = false, releaseB, releaseA;
  const gateB = new Promise(resolve => { releaseB = resolve; });
  const gateA = new Promise(resolve => { releaseA = resolve; });
  source = createSessionControllerSource({ sessionController: { list: async () => { calls++; return { items: structuredClone(data) }; } },
    readSessionSummary: async id => { const cut = structuredClone(data.find(row => row.sessionId === id)); if (id === 'b' && holdB) await gateB; if (id === 'a' && holdA) await gateA; return cut; } });
  t.after(() => { releaseA(); releaseB(); source.dispose(); });
  await source.listSessions({ evidence: false }); const before = calls;
  holdB = true; source.invalidateSession('b'); await new Promise(resolve => setImmediate(resolve));
  let completed = false; const reading = source.listSessions({ fresh: true, evidence: false }).then(rows => { completed = true; return rows; });
  await new Promise(resolve => setImmediate(resolve));
  data[0] = item('a'); data[0].projections.values.title = 'Verified rename'; holdA = true; source.invalidateTitle('a');
  releaseB(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false, 'a dirty supported row is not an authoritative old success');
  releaseA(); const rows = await reading;
  assert.equal(rows.find(row => row.id === 'a').title, 'Verified rename'); assert.equal(calls - before, 1);
});

test('an unrelated event during cold coverage does not discard a verified row signature', async t => {
  let source, changed = false; const reads = new Map();
  source = createSessionControllerSource({ sessionController: { list: async () => ({ items: [item('a'), item('b'), item('c')] }) },
    readSessionSummary: async id => {
      reads.set(id, (reads.get(id) ?? 0) + 1);
      if (id === 'b' && !changed) { changed = true; source.invalidateTitle('b'); }
      return item(id);
    } }); t.after(() => source.dispose());
  assert.equal((await source.listSessions()).length, 3);
  assert.equal(reads.get('a'), 1, 'retain unrelated validated progress even if the baseline must re-enumerate');
  assert.equal(source.listDiagnostics().coverage, 'ready');
});
