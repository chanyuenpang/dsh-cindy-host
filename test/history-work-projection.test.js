import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryViewController, groupHistoryItems, buildHistoryWorkPatch, HISTORY_WORK_PATCH_MAX_BYTES } from '../src/host-history-view.js';

const row = (id, role = 'thinking', text = id) => ({ id, clientId: id, role, createdAt: '2026-01-01T00:00:00Z', content: { text } });
function source(initial, sealedPrefixLength = initial.length - 1) {
  const state = { rows: initial, projection: { identity: {}, version: 1, sealedPrefixLength }, running: true };
  state.view = createHistoryViewController({ snapshot: async () => ({ rows: state.rows, projection: { ...state.projection }, resolve: id => state.rows.findIndex(r => r.id === id) }), sessionRunning: () => state.running });
  state.page = async () => (await state.view.page('s1', undefined, { workLines: true })).result;
  return state;
}
const clone = value => structuredClone(value);

test('workLines opt-in carries lines instead of preview; legacy page/details remain complete', async () => {
  const live = row('live', 'thinking', '中文'.repeat(100000));
  const s = source([row('u', 'user'), live], 1);
  const modern = await s.page();
  assert.equal(modern.items.at(-1).summary.lines[0].text.length, 160);
  assert.equal(modern.items.at(-1).summary.lines[0].truncated, true);
  assert.equal(modern.items.at(-1).summary.preview, undefined);
  assert.equal((await s.view.details('s1', modern.items.at(-1).summary)).result.messages[0].content.text, live.content.text);
  s.rows[1] = row('live', 'thinking', 'short'); s.projection.version++;
  const legacy = (await s.view.page('s1')).result;
  assert.ok(legacy.items.at(-1).summary.preview);
  assert.equal(legacy.items.at(-1).summary.lines, undefined);
});

test('legacy arbitrary rows functions cannot pretend reference identity is a version', async () => {
  const rows = [row('t'), row('u', 'user')];
  const view = createHistoryViewController({ rows: async () => rows, sessionRunning: () => true });
  const first = (await view.page('s1', undefined, { workLines: true })).result;
  rows[0].content.text = 'rewritten in place';
  const next = (await view.page('s1', undefined, { workLines: true })).result;
  assert.notEqual(first.items.at(-1).summary.revision, next.items.at(-1).summary.revision);
  assert.equal(next.items.at(-1).summary.lines[0].text, 'rewritten in place');
  assert.equal(view.metrics().rebuilds, 2);
});

test('sealed cache crosses 40-row splits, cards, terminal and identity changes without stale grouping', async () => {
  const s = source([row('u', 'user'), ...Array.from({ length: 39 }, (_, i) => row(`t${i}`))], 39);
  const check = async () => {
    const result = await s.page();
    const expected = groupHistoryItems(s.rows, { chronological: true, running: s.running, workLines: true });
    assert.deepEqual(result.items, expected.slice(-20));
  };
  await check();
  s.projection.sealedPrefixLength = s.rows.length;
  for (let i = 39; i < 43; i++) { s.rows.push(row(`t${i}`)); s.projection.version += 7; await check(); s.projection.sealedPrefixLength = s.rows.length; }
  s.rows.push({ ...row('todo', 'tool_use'), content: { toolName: 'TodoWrite', input: { todos: [] } } }, row('tail'));
  s.projection.version++; await check();
  s.rows.at(-1).content.text = 'final tail'; s.projection.version++;
  s.running = false; await check();
  s.rows = [row('rewound', 'user'), row('new-tail')];
  s.projection = { identity: {}, version: 1, sealedPrefixLength: 1 }; await check();
  assert.equal(s.view.metrics().rebuilds, 2);
});

function fixture() {
  const s = source([row('u', 'user'), row('t', 'thinking', 'first')], 1);
  return s;
}

test('pure patch matches official shape and base revision; saturated hidden body produces unchanged', async () => {
  const s = fixture(); const first = await s.page();
  s.rows[1] = row('t', 'thinking', 'next'); s.projection.version++;
  const next = await s.page();
  const result = buildHistoryWorkPatch('s1', first, next);
  assert.deepEqual(result, { kind: 'patch', patch: { version: 1, sessionId: 's1', baseRevision: first.items[1].summary.revision, item: next.items[1] } });
  assert.equal(buildHistoryWorkPatch('s1', first, first).kind, 'unchanged');
  const hidden = clone(next); hidden.items[1].summary.revision += ':hidden';
  assert.equal(buildHistoryWorkPatch('s1', next, hidden).kind, 'unchanged');
  assert.deepEqual(first.items[1].summary.lines[0].text, 'first', 'comparison never mutates the delivered base');
});

test('patch rejects every unsafe shape/window/range/revision and legacy without lines', async () => {
  const s = fixture(); const first = await s.page();
  const changes = [
    p => p.items.push({ type: 'messages', key: 'answer', messages: [row('answer', 'assistant')] }),
    p => { p.items[0].messages[0].content.text = 'rewritten prose'; },
    p => { p.items[1].summary.firstMessageId = 'other'; },
    p => { p.items[1].summary.lastMessageId = 'other'; },
    p => { p.items[1].summary.messageCount = 0; },
    p => { p.items[1].summary.isStreaming = false; },
    p => { p.items[1].children = []; },
    p => { p.items.push({ ...clone(p.items[1]), key: 'second' }); },
    p => { p.hasMore = true; p.nextCursor = 'u'; },
    p => { p.items[1].summary.lines[0].text = 'unversioned changed'; },
    p => { p.items[1].summary.revision = ''; },
    p => { delete p.items[1].summary.lines; },
    p => { p.items[1].summary.key = 'wrong-key'; },
  ];
  for (const change of changes) {
    const next = clone(first); change(next);
    assert.equal(buildHistoryWorkPatch('s1', first, next).kind, 'refresh', change.toString());
  }
  assert.equal(buildHistoryWorkPatch('s1', null, first).kind, 'refresh');
  assert.equal(buildHistoryWorkPatch('', first, first).kind, 'refresh');
  const huge = clone(first); huge.items[1].summary.revision = 'large'; huge.items[1].summary.artifacts = [{ path: 'x'.repeat(HISTORY_WORK_PATCH_MAX_BYTES) }];
  assert.equal(buildHistoryWorkPatch('s1', first, huge).kind, 'refresh');
  const baseWithChildren = clone(first); baseWithChildren.items[1].children = [];
  assert.equal(buildHistoryWorkPatch('s1', baseWithChildren, first).kind, 'refresh');
});

test('a fully sealed 40-row tail still updates streaming state without a content revision', async () => {
  const s = source(Array.from({ length: 40 }, (_, i) => row(`t${i}`)), 40);
  s.running = false;
  assert.equal((await s.page()).items[0].summary.isStreaming, false);
  s.running = true;
  assert.equal((await s.page()).items[0].summary.isStreaming, true);
  s.running = false;
  assert.equal((await s.page()).items[0].summary.isStreaming, false);
});

test('patch UTF-8 cap accepts exactly 64 KiB and rejects one byte above', async () => {
  const s = fixture(); const first = await s.page();
  const next = clone(first); next.items[1].summary.revision = 'next';
  next.items[1].summary.artifacts = [{ path: '' }];
  const initial = buildHistoryWorkPatch('s1', first, next);
  assert.equal(initial.kind, 'patch');
  const available = HISTORY_WORK_PATCH_MAX_BYTES - Buffer.byteLength(JSON.stringify(initial.patch));
  next.items[1].summary.artifacts[0].path = 'x'.repeat(available);
  const exact = buildHistoryWorkPatch('s1', first, next);
  assert.equal(exact.kind, 'patch');
  assert.equal(Buffer.byteLength(JSON.stringify(exact.patch)), HISTORY_WORK_PATCH_MAX_BYTES);
  next.items[1].summary.artifacts[0].path += 'x';
  assert.equal(buildHistoryWorkPatch('s1', first, next).kind, 'refresh');
});

test('new activity within the same running range is a safe replacement, not append', async () => {
  const s = fixture(); const first = await s.page();
  s.rows.push(row('second')); s.projection.version++;
  const next = await s.page();
  assert.equal(buildHistoryWorkPatch('s1', first, next).kind, 'patch');
});

test('1000 warmed chunks group/hash only mutable suffix for short and 100k-row histories', async t => {
  for (const durableCount of [10, 100000]) {
    const old = Array.from({ length: durableCount }, (_, i) => row(`old-${i}`, i % 2 ? 'assistant' : 'thinking'));
    const live = { ...row('live', 'thinking', '中'.repeat(200000)), historyContentStamp: 'live:0' };
    const s = source([...old, live], durableCount);
    let delivered = await s.page();
    const before = s.view.metrics();
    const cpu = process.cpuUsage(); const heap = process.memoryUsage().heapUsed; const start = performance.now();
    let patchBytes = 0;
    for (let i = 1; i <= 1000; i++) {
      // Skip source versions intentionally: permanently sealed prefix remains valid.
      s.projection.version += 3;
      s.rows[durableCount] = { ...live, content: { text: `${live.content.text}${i}` }, historyContentStamp: `live:${i}` };
      const next = await s.page();
      const result = buildHistoryWorkPatch('s1', delivered, next);
      if (result.kind === 'patch') { patchBytes += Buffer.byteLength(JSON.stringify(result.patch)); delivered = next; }
    }
    const after = s.view.metrics();
    assert.equal(after.groupedRows - before.groupedRows, 1000);
    assert.equal(after.fullHashRows - before.fullHashRows, 0, 'sealed prefix and live body never fully hashed');
    assert.equal(after.stampedHashRows - before.stampedHashRows, 1000);
    assert.equal(after.rebuilds - before.rebuilds, 0);
    assert.equal(after.sealedPrefixRowsReused - before.sealedPrefixRowsReused, durableCount * 1000);
    assert.ok(after.hashChars - before.hashChars < 500000, 'stamped metadata only, not growing 200k-char body');
    assert.equal(patchBytes, 0, 'saturated opening does not repeatedly push unchanged display facts');
    const usage = process.cpuUsage(cpu);
    t.diagnostic(JSON.stringify({ durableCount, chunks: 1000, elapsedMs: +(performance.now() - start).toFixed(2), cpuUserUs: usage.user, cpuSystemUs: usage.system, heapDeltaBytes: process.memoryUsage().heapUsed - heap, groupedRows: after.groupedRows - before.groupedRows, fullHashRows: after.fullHashRows - before.fullHashRows, patchBytes }));
    const warmed = s.view.metrics(); await s.page();
    assert.equal(s.view.metrics().groupedRows, warmed.groupedRows, 'same version hits projection cache');
  }
});
