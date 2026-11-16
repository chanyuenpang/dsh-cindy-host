import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const moduleUrl = name => process.env.CINDY_LIVE_LINES_HOST_ROOT
  ? pathToFileURL(join(process.env.CINDY_LIVE_LINES_HOST_ROOT, 'src', name)).href
  : new URL('../src/' + name, import.meta.url).href;
const { createHistoryViewController } = await import(moduleUrl('host-history-view.js'));
const { createChannelRouter } = await import(moduleUrl('cindy-channels.js'));

const thought = (id, text, extra = {}) => ({ id, clientId: id, sessionId: 's', role: 'thinking', content: { text }, createdAt: '2026-11-15T12:00:00Z', ...extra });
const rows = [
  thought('a', 'Earlier thought'),
  thought('hidden', 'REDACTED_BODY', { content: { text: 'REDACTED_BODY', isRedacted: true } }),
  thought('child', 'CHILD_BODY', { agentMeta: { parentUuid: 'parent' } }),
  { id: 'call', clientId: 'call', sessionId: 's', role: 'tool_use', toolUseId: 'call', content: { toolName: 'Read', input: { file_path: 'src/example.js', secret: 'ARBITRARY_INPUT' } }, createdAt: '2026-11-15T12:00:01Z' },
  { id: 'result', clientId: 'result', sessionId: 's', role: 'tool_result', toolUseId: 'call', content: { text: 'RESULT_BODY' }, createdAt: '2026-11-15T12:00:02Z' },
  thought('live', 'Active thought '.repeat(100)),
];
const snapshot = async () => ({ rows, resolve: id => rows.findIndex(row => row.id === id) });
const summary = reply => { assert.equal(reply.ok, true); return reply.result.items.find(item => item.type === 'work').summary; };

test('requested active work lines replace automatic raw-body preview without dropping manual details', async () => {
  const view = createHistoryViewController({ snapshot, sessionRunning: () => true });
  const active = summary(await view.page('s', undefined, { workLines: true }));
  assert.ok(Array.isArray(active.lines), 'ignoring workLines keeps the running-only preview/detail feedback path active');
  assert.equal(active.preview, undefined);
  assert.ok(active.lines.length > 0 && active.lines.length <= 5);
  assert.ok(Buffer.byteLength(JSON.stringify(active.lines)) <= 6 * 1024);
  const serialized = JSON.stringify(active.lines);
  assert.doesNotMatch(serialized, /REDACTED_BODY|CHILD_BODY|RESULT_BODY|ARBITRARY_INPUT/);
  assert.equal(active.lines.find(line => line.key === 'call').status, 'done');
  const details = await view.details('s', active);
  assert.equal(details.ok, true);
  assert.deepEqual(details.result.messages.map(row => row.id), rows.map(row => row.id), 'explicit expansion still owns original details');
});

test('idle sessions and clients that did not negotiate lines retain the original contract', async () => {
  const live = createHistoryViewController({ snapshot, sessionRunning: () => true });
  const oldClient = summary(await live.page('s'));
  assert.equal(oldClient.lines, undefined);
  assert.ok(oldClient.preview);
  const notBoolean = summary(await live.page('s', undefined, { workLines: 'true' }));
  assert.equal(notBoolean.lines, undefined);
  const idle = createHistoryViewController({ snapshot, sessionRunning: () => false });
  const stopped = summary(await idle.page('s', undefined, { workLines: true }));
  assert.equal(stopped.isStreaming, false);
  assert.equal(stopped.lines, undefined);
  assert.equal(stopped.preview, undefined);
});

test('actual history RPC forwards explicit workLines negotiation to the history owner', async () => {
  const calls = [];
  const historyView = { page: async (...args) => { calls.push(args); return { ok: true, result: { version: 1, items: [], hasMore: false, nextCursor: null } }; } };
  const router = createChannelRouter({ listSessions: async () => [], subscribers: new Set(), getDevice: () => ({ deviceId: 'host' }), resolveCapabilities: () => ({ historyView }) });
  for (const value of [true, undefined, 'true']) {
    const reply = await router({ v: 1, kind: 'invoke', id: 'r', src: 'phone', payload: { channel: 'local-db:messages:view', args: ['s', { before: 'cursor', workLines: value }] } });
    assert.equal(reply.payload.ok, true);
  }
  assert.deepEqual(calls, [['s', 'cursor', { workLines: true }], ['s', 'cursor', { workLines: false }], ['s', 'cursor', { workLines: false }]]);
});
