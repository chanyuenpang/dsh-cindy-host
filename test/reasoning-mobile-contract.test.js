import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { toCindyMessageRows } from '../src/cindy-message-row.js';
import { createReasoningStream } from '../src/reasoning-stream.js';

// Execute the pinned real mobile normalizer, not an imitation of its payload rules.
const source = readFileSync(new URL('../fixtures/cindy-source/thinking-normalize.ts', import.meta.url), 'utf8');
const code = stripTypeScriptTypes(source, { mode: 'transform' });
const { normalizeThinking } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

test('historical Host thinking survives the actual mobile normalizer; old prose format is filtered', () => {
  const [row] = toCindyMessageRows({ id: 'm', role: 'assistant', content: [{ type: 'reasoning', text: '公开摘要' }] },
    { sessionId: 's', createdAt: '2026-11-03T00:00:00.000Z' });
  assert.equal(normalizeThinking({ ...row, content: '公开摘要' }), null, 'reproduce old Host payload loss');
  const normalized = normalizeThinking(JSON.parse(JSON.stringify(row)));
  assert.ok(normalized, 'actual mobile thinking normalizer must accept the Host payload');
  assert.equal(normalized.body, '公开摘要');
});

test('streamed Host thinking carries both public text and the mobile-recognized streaming flag', () => {
  const stream = createReasoningStream('s');
  stream.consume({ type: 'assistant/chunk', seq: 1, time: 1000, data: { turn: 1, step: 1,
    chunk: { type: 'reasoning-delta', index: 0, text: '实时摘要' } } });
  const normalized = normalizeThinking(JSON.parse(JSON.stringify(stream.rows()[0])));
  assert.ok(normalized);
  assert.equal(normalized.body, '实时摘要');
  assert.equal(normalized.isStreaming, true);
});
