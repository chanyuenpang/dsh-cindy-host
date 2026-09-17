/**
 * The frame budget: a reply that cannot fit one device-link frame must be degraded
 * into something the controller can still use, never handed to the relay.
 *
 * The relay rejects a frame over `MAX_FRAME_BYTES` (2 MiB) outright, and the
 * reference controlled end documents the consequence — 「若不接住,异常会冒泡到
 * handleFrame 的 .catch(只 log),控制端收不到任何 invoke-result,只能干等 30s
 * 超时」 (`apps/desktop/src/main/device-link/dispatch.ts`). From the handset that
 * looked like 历史消息全部消失、重新加载更早消息也没有响应.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAME_BUDGET_BYTES,
  MAX_FRAME_BYTES,
  cutToBytes,
  fitInvokeResultToFrame,
  frameByteLength,
  frameFits,
  sliceRowsAtMessageBoundary,
} from '../src/host-frame-budget.js';

/** One row shaped the way this Host serves a transcript page. */
function row(id, text, extra = {}) {
  return {
    id: `s1:${id}:0`,
    clientId: `s1:${id}:0`,
    sessionId: 's1',
    role: 'assistant',
    toolUseId: null,
    agentMeta: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    content: { text },
    ...extra,
  };
}

function replyFor(rows) {
  return { v: 1, kind: 'invoke-result', id: 'req-1', dst: 'phone-2', payload: { ok: true, result: rows } };
}

const REQUEST = { id: 'req-1', src: 'phone-2' };

test('the frame ceiling mirrors the Cindy protocol constant', () => {
  // Duplicated on purpose: this Host composes the protocol over the wire, not the
  // package, so the number is asserted here rather than imported silently.
  assert.equal(MAX_FRAME_BYTES, 2 * 1024 * 1024);
  assert.equal(FRAME_BUDGET_BYTES, MAX_FRAME_BYTES - 1024, 'the reference reserves 1 KiB of headroom');
});

test('a page that already fits is sent untouched', () => {
  const rows = [row('a', 'hello'), row('b', 'world')];
  const fitted = fitInvokeResultToFrame({ reply: replyFor(rows), request: REQUEST, channel: 'local-db:messages:list' });
  assert.equal(fitted.level, 'fits');
  assert.equal(fitted.reply.payload.result, rows, 'the same array, not a copy');
});

test('long text is cut before anything else is given up', () => {
  // The budget sits above one row's text limit (128 KiB) and below the fixture, so
  // stage 1 alone is enough — the stage order is what is under test, not the byte.
  const rows = [row('a', 'x'.repeat(400 * 1024)), row('b', 'small')];
  const budget = 200 * 1024;
  const fitted = fitInvokeResultToFrame({
    reply: replyFor(rows),
    request: REQUEST,
    channel: 'local-db:messages:list',
    budgetBytes: budget,
  });
  assert.equal(fitted.level, 'text');
  assert.equal(fitted.reply.payload.ok, true);
  assert.equal(fitted.reply.payload.result.length, 2, 'no row was dropped for a text problem');
  assert.ok(fitted.reply.payload.result[0].content.text.length < 400 * 1024);
  assert.match(fitted.reply.payload.result[0].content.text, /remote content truncated/);
  assert.equal(fitted.reply.payload.result[0].agentMeta.remoteContentTruncated, true);
  assert.equal(frameByteLength(fitted.reply) <= budget, true);
});

test('inlined image bytes are given up before the conversation is', () => {
  const base64 = 'A'.repeat(1_500_000);
  const rows = [
    row('a', '', { content: { text: '', images: [{ base64, mimeType: 'image/png' }] } }),
    row('b', 'after the picture'),
  ];
  const budget = 256 * 1024;
  assert.ok(frameByteLength(replyFor(rows)) > budget, 'the fixture really is oversized');
  const fitted = fitInvokeResultToFrame({
    reply: replyFor(rows),
    request: REQUEST,
    channel: 'local-db:messages:list',
    budgetBytes: budget,
  });
  assert.equal(fitted.level, 'images');
  assert.equal(fitted.reply.payload.result.length, 2);
  assert.equal(fitted.reply.payload.result[0].content.images, undefined);
  assert.equal(fitted.reply.payload.result[1].content.text, 'after the picture', 'the text survived');
  assert.equal(frameByteLength(fitted.reply) <= budget, true);
});

test('a page of huge rows is trimmed, and the trim is marked for the controller', () => {
  // The controller keeps its "load earlier" affordance on a short page only when the
  // rows say they were trimmed: `hasMoreOlderMessages` reads
  // `agentMeta.remoteRowsTrimmed` (`apps/mobile/src/session/messagePaging.ts`).
  const rows = Array.from({ length: 20 }, (_, index) => row(`m${index}`, 'y'.repeat(120 * 1024), {
    createdAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
  }));
  // Small enough that even the placeholder rows do not all fit: that is the stage
  // that trades rows for the frame.
  const budget = 2 * 1024;
  const fitted = fitInvokeResultToFrame({
    reply: replyFor(rows),
    request: REQUEST,
    channel: 'local-db:messages:list',
    budgetBytes: budget,
  });
  assert.equal(fitted.level, 'trimmed');
  const kept = fitted.reply.payload.result;
  assert.ok(kept.length > 0 && kept.length < rows.length, `kept ${kept.length} of ${rows.length}`);
  assert.equal(kept[0].id, rows[0].id, 'the newest rows are the ones kept');
  assert.equal(kept[0].agentMeta.remoteRowsTrimmed, true);
  assert.equal(kept[0].agentMeta.remoteOriginalRowCount, rows.length);
  assert.equal(frameByteLength(fitted.reply) <= budget, true);
});

test('a one-row page that cannot be made to fit is refused, not sent', () => {
  // A single row's text is bounded above, so in practice this means the page is
  // pathological. Refusing compactly is still better than a frame the relay drops.
  const rows = [row('a', 'z'.repeat(4096))];
  const fitted = fitInvokeResultToFrame({
    reply: replyFor(rows),
    request: REQUEST,
    channel: 'local-db:messages:list',
    budgetBytes: 64,
  });
  assert.equal(fitted.level, 'refused');
  assert.equal(fitted.reply.payload.error.code, 'PAYLOAD_TOO_LARGE');
});

test('a non-message channel gets a compact refusal instead of a dropped frame', () => {
  const result = { blob: 'z'.repeat(FRAME_BUDGET_BYTES) };
  const fitted = fitInvokeResultToFrame({
    reply: { v: 1, kind: 'invoke-result', id: 'req-1', dst: 'phone-2', payload: { ok: true, result } },
    request: REQUEST,
    channel: 'local-db:sessions:get',
  });
  assert.equal(fitted.level, 'refused');
  assert.equal(fitted.reply.payload.ok, false);
  assert.equal(fitted.reply.payload.error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(frameFits(fitted.reply), true, 'the refusal itself is small');
});

test('a text cut never splits a multi-byte character', () => {
  const text = '猫'.repeat(1000);
  const { text: cut, cut: didCut } = cutToBytes(text, 100);
  assert.equal(didCut, true);
  assert.equal(Buffer.byteLength(cut, 'utf8') <= 100, true);
  assert.equal(cut.includes('\uFFFD'), false, 'no replacement character');
  assert.equal(cut.startsWith('猫猫'), true);
});

test('a trim keeps one message’s rows together', () => {
  const rows = [
    row('a', '1', { createdAt: '2026-01-01T00:00:03.000Z' }),
    row('b', '2', { createdAt: '2026-01-01T00:00:02.000Z' }),
    row('c', '3', { createdAt: '2026-01-01T00:00:02.000Z' }),
    row('d', '4', { createdAt: '2026-01-01T00:00:01.000Z' }),
  ];
  // Keeping 2 would split the 00:00:02 message; the cut walks back to its start.
  assert.deepEqual(sliceRowsAtMessageBoundary(rows, 2).map((entry) => entry.content.text), ['1']);
  assert.deepEqual(sliceRowsAtMessageBoundary(rows, 3).map((entry) => entry.content.text), ['1', '2', '3']);
  // One row always survives, even if the caller asks for none.
  assert.deepEqual(sliceRowsAtMessageBoundary(rows, 0).map((entry) => entry.content.text), ['1']);
});
