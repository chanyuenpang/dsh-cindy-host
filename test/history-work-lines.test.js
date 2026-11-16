import test from 'node:test';
import assert from 'node:assert/strict';
import { projectHistoryWorkLines, HISTORY_WORK_LINES_MAX_BYTES } from '../src/history-work-lines.js';

const thought = (id, text, extra = {}) => ({ id, clientId: id, role: 'thinking', content: { text }, ...extra });
const call = (id, toolName, input = {}) => ({ id, clientId: id, role: 'tool_use', toolUseId: id, content: { toolName, input } });

test('thinking uses the whitespace-collapsed opening, 160 UTF-16 chars and explicit truncation', () => {
  assert.deepEqual(projectHistoryWorkLines([thought('t', ' \n 中文  思考\t开头  ')], true), [{ kind: 'thinking', key: 't', text: '中文 思考 开头' }]);
  const [line] = projectHistoryWorkLines([thought('t', '中'.repeat(1_000_000))], true);
  assert.equal(line.text.length, 160);
  assert.equal(line.text, `${'中'.repeat(159)}…`);
  assert.equal(line.truncated, true);
  assert.equal(projectHistoryWorkLines([thought('a', 'a'.repeat(160))], true)[0].truncated, undefined);
});

test('latest five direct activities omit redacted/child thinking and result-only lines', () => {
  const rows = Array.from({ length: 9 }, (_, i) => thought(`t${i}`, `thinking ${i}`));
  rows.push(thought('secret', 'private', { content: { text: 'private', isRedacted: true } }));
  rows.push(thought('child', 'child-only', { agentMeta: { parentUuid: 'parent' } }));
  rows.push({ id: 'result', role: 'tool_result', content: { text: 'not a line' } });
  assert.deepEqual(projectHistoryWorkLines(rows, true).map(line => line.key), ['t4', 't5', 't6', 't7', 't8']);
  assert.deepEqual(projectHistoryWorkLines(rows, true, 0), []);
});

test('direct official descriptor facts and completed/error status are preserved', () => {
  const rows = [call('read', 'Read', { file_path: 'G:\\project\\file.js' }), call('search', 'Grep', { pattern: 'foo', path: 'src', glob: '*.js' }), call('web', 'WebFetch', { url: 'https://example.com' })];
  rows.push({ id: 'r', role: 'tool_result', toolUseId: 'read', content: { isError: true, text: 'failed' } });
  const lines = projectHistoryWorkLines(rows, true);
  assert.deepEqual(lines[0].descriptor, { kind: 'file', toolName: 'Read', action: 'read', filePath: 'G:\\project\\file.js', fileName: 'file.js' });
  assert.equal(lines[0].status, 'done');
  assert.equal(lines[0].hasError, true);
  assert.deepEqual(lines[1].descriptor, { kind: 'search', toolName: 'Grep', mode: 'grep', pattern: 'foo', path: 'src', glob: '*.js' });
  assert.deepEqual(lines[2].descriptor, { kind: 'web', toolName: 'WebFetch', mode: 'fetch', target: 'https://example.com' });
  assert.equal(lines[2].status, 'running');
  assert.equal(projectHistoryWorkLines(rows, false).at(-1).status, 'done');
});

test('complex/unrecognized commands use honest generic descriptors, never guessed intents or arbitrary input', () => {
  const lines = projectHistoryWorkLines([call('exec', 'exec', { command: 'cat a | tee b', secret: 'TOKEN', commandActions: [{ type: 'read' }] }), call('ghost', 'mcp:server:ghost_call', { ghost_id: 'g1', tool: 'inspect', secret: 'TOKEN' })], true);
  assert.deepEqual(lines[0].descriptor, { kind: 'generic', toolName: 'exec' });
  assert.deepEqual(lines[1].ghost, { id: 'g1', tool: 'inspect' });
  assert.doesNotMatch(JSON.stringify(lines), /TOKEN|commandActions|tee b/);
});

test('adversarial Unicode names, paths and identities remain inside 6 KiB without corrupting IDs', () => {
  const rows = Array.from({ length: 5 }, (_, i) => call(`c${i}`, 'Read', { path: '文'.repeat(10000) }));
  const lines = projectHistoryWorkLines(rows, true);
  assert.equal(lines.length, 5);
  assert.ok(Buffer.byteLength(JSON.stringify(lines)) <= HISTORY_WORK_LINES_MAX_BYTES);
  for (const line of lines) {
    for (const field of Object.values(line.descriptor)) if (typeof field === 'string') assert.ok(field.length <= 160);
  }
  assert.deepEqual(projectHistoryWorkLines([call('id'.repeat(10000), 'unknown')], true), []);
});
