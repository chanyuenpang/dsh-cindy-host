import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { buildHistoryWorkPatch, createHistoryViewController } from '../src/host-history-view.js';

const root = process.env.CINDY_HISTORY_SOURCE_ROOT;
const moduleUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');

test('actual official Cindy controller applies safe Host patch immediately and rejects a missed base', { skip: !root && 'Set CINDY_HISTORY_SOURCE_ROOT to execute the actual official history controller' }, async () => {
  const dir = join(root, 'packages/maker-shared/src');
  const history = moduleUrl(stripTypeScriptTypes(readFileSync(join(dir, 'historyView.ts'), 'utf8'), { mode: 'transform' }));
  const source = stripTypeScriptTypes(readFileSync(join(dir, 'historyViewController.ts'), 'utf8'), { mode: 'transform' })
    .replace("'./historyView.js'", JSON.stringify(history));
  const { HistoryViewController } = await import(moduleUrl(source));
  let text = '中文'; let version = 1;
  const identity = {};
  const view = createHistoryViewController({ sessionRunning: () => true, snapshot: async () => ({
    rows: [{ id: 'thinking', clientId: 'thinking', role: 'thinking', content: { text }, createdAt: '2026-11-15T00:00:00Z', historyContentStamp: String(version) }],
    projection: { identity, version, sealedPrefixLength: 0 }, resolve: id => id === 'thinking' ? 0 : -1,
  }) });
  const first = (await view.page('s', undefined, { workLines: true })).result;
  const client = new HistoryViewController({ page: async () => first, expanded: async () => {}, details: async () => { throw Error('collapsed lines must not load details'); } });
  try {
    await client.refresh();
    text += '实时进度'; version++;
    const next = (await view.page('s', undefined, { workLines: true })).result;
    const patch = buildHistoryWorkPatch('s', first, next);
    assert.equal(patch.kind, 'patch');
    client.applyWorkPatch(patch.patch);
    assert.equal(client.getSnapshot().items[0].summary.lines[0].text, text);
    text += '后续'; version++;
    const third = (await view.page('s', undefined, { workLines: true })).result;
    const missed = buildHistoryWorkPatch('s', first, third);
    client.applyWorkPatch(missed.patch);
    assert.equal(client.getSnapshot().items[0].summary.revision, next.items[0].summary.revision,
      'a base mismatch never applies an unsafe patch; official controller schedules ordinary refresh instead');
  } finally { client.setActive(false); }
});
