import test from 'node:test';
import assert from 'node:assert/strict';
import { toCindyMessageRows, toCindyMessages } from '../src/cindy-message-row.js';
import { foldSessionEvent } from '../src/dsh-message-fold.js';

const context = { sessionId: 's1', createdAt: '2026-11-06T17:00:00.000Z' };
function call(argumentsValue, name = 'run_code') {
  return { id: 'm1', role: 'assistant', content: [
    { type: 'tool-call', id: 'call-1', name, arguments: argumentsValue },
  ] };
}
function project(input, name) {
  return toCindyMessageRows(call(input, name), context)[0];
}

test('run_code exposes its work title in the Cindy tool name for object and JSON input', () => {
  const input = Object.freeze({ code: 'return 1;', description: '检查消息展示链路', timeoutMs: 1000 });
  for (const raw of [input, JSON.stringify(input)]) {
    const source = call(raw);
    const before = structuredClone(source);
    const row = toCindyMessageRows(source, context)[0];
    assert.equal(row.content.toolName, 'run_code · 检查消息展示链路');
    assert.deepEqual(row.content.input, input);
    assert.equal(row.id, 's1:m1:0');
    assert.equal(row.clientId, row.id);
    assert.equal(row.toolUseId, 'call-1');
    assert.equal(row.content.toolUseId, 'call-1');
    assert.deepEqual(source, before, 'the executable DSH message stays unchanged');
  }
});

test('run_code titles are one line without control or bidi spoofing characters', () => {
  const description = '  检查\n\t消息\r\n链路\u0000\u001b\u0085\u202e\u2066 完成\u2069  ';
  const row = project({ code: '', description });
  assert.equal(row.content.toolName, 'run_code · 检查 消息 链路 完成');
  assert.equal(row.content.input.description, description, 'full original title stays in details');
  assert.equal(project({ description: '检查 👩‍💻 消息' }).content.toolName, 'run_code · 检查 👩‍💻 消息');
});

test('long titles use a bounded Unicode-safe preview and preserve full details', () => {
  for (const length of [119, 120, 121, 2000]) {
    const description = '🧪'.repeat(length);
    const row = project({ code: '', description });
    const expected = length > 120 ? '🧪'.repeat(119) + '…' : description;
    assert.equal(row.content.toolName, 'run_code · ' + expected);
    assert.equal(row.content.input.description, description);
  }
});

test('missing, empty, invalid, partial, or non-string titles retain the exact tool name', () => {
  for (const input of [null, undefined, '', 'null', '{}', '{"description":', 'plain input',
    [], 1, true, { description: null }, { description: 12 }, { description: {} },
    { description: '' }, { description: ' \n\t\u202e\u2069 ' }, { title: 'not description' }]) {
    const row = project(input);
    assert.equal(row.content.toolName, 'run_code');
  }
});

test('other tools and exact-name special cards keep their existing vocabulary', () => {
  for (const name of ['pwsh', 'read', 'run_code_extra', 'functions.run_code', 'mcp:server:run_code', 'TodoWrite', 'todo_write']) {
    const input = { description: '检查消息', todos: [] };
    const row = project(input, name);
    assert.equal(row.content.toolName, name === 'todo_write' ? 'TodoWrite' : name);
    assert.deepEqual(row.content.input, input);
  }
});

test('live and history folds share the display alias and unchanged result identity', () => {
  const source = call(JSON.stringify({ description: '检查工具结果配对', code: 'return 1;' }));
  const event = { type: 'assistant/message', surfaceOp: 'append', seq: 1,
    time: Date.parse(context.createdAt), data: { message: source } };
  const live = foldSessionEvent(event, context);
  const result = { id: 'm2', role: 'tool', toolCallId: 'call-1', isError: true,
    source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: 'failed output' }] };
  const history = toCindyMessages([
    { message: source, createdAt: context.createdAt },
    { message: result, createdAt: '2026-11-06T17:00:01.000Z' },
  ], context);
  const use = history.find(row => row.role === 'tool_use');
  const output = history.find(row => row.role === 'tool_result');
  assert.deepEqual(live, [use]);
  assert.equal(use.content.toolName, 'run_code · 检查工具结果配对');
  assert.equal(output.toolUseId, use.toolUseId);
  assert.equal(output.content.isError, true);
  assert.equal(output.content.text, 'failed output');
});
