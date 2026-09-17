/**
 * Keep every reply this Host sends inside the device-link frame limit.
 *
 * Why this exists at all: the relay **rejects** any frame over `MAX_FRAME_BYTES`
 * (`@cindy/device-link-protocol`'s 2 MiB, enforced by the client's `sendEnvelope`
 * as `PAYLOAD_TOO_LARGE` and by the relay server on the same byte count), and the
 * failure is not a small error the controller can recover from:
 *
 *  - the reference controlled end documents the exact consequence — 「若不接住,
 *    异常会冒泡到 handleFrame 的 .catch(只 log),控制端收不到任何 invoke-result,
 *    只能干等 30s 超时」 (`apps/desktop/src/main/device-link/dispatch.ts`
 *    `sendInvokeResultSafe`);
 *  - the controller reports it as 手机偶尔只剩自己那一行、历史全部消失、重新加载更早
 *    也没有响应, because a page that never answers leaves its stored window without
 *    the rows it asked for.
 *
 * So the controlled end owes the controller two things, and this module is both:
 *
 *  1. **A ladder that degrades a message page instead of failing it.** The
 *     reference does content truncation → whole-row placeholder → row slicing,
 *     marking what it cut so the controller keeps its "load earlier" affordance
 *     (`compactInvokeResultForDeviceLink`). Copied here stage for stage, adapted to
 *     this Host's row shape (whose `content` is an object with `text` / `images[]`,
 *     not a string).
 *  2. **A last-resort refusal.** If even one row cannot be made to fit, answer a
 *     compact `PAYLOAD_TOO_LARGE` error — the reference does exactly this for every
 *     non-message channel — rather than handing the socket a frame the relay drops.
 *
 * The budget is measured on the **serialized frame**, in UTF-8 bytes, because that
 * is what the relay measures: a page of CJK characters is three bytes per
 * character, and a page of base64 images is 4/3 of their size.
 */

/**
 * The relay's hard frame ceiling, mirrored from `@cindy/device-link-protocol`.
 *
 * Duplicated rather than imported on purpose: this Host composes the protocol
 * over the wire, not the package, so the number is stated where it is applied —
 * and a change on the Cindy side shows up as a failing test in `test/host.test.js`
 * rather than as a silently dropped frame.
 */
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;

/**
 * Headroom under the ceiling.
 *
 * The reference reserves 1 KiB (`REMOTE_INVOKE_FRAME_SAFETY_BYTES`) so that the
 * measurement here and the relay's own `Buffer.byteLength` cannot disagree at the
 * boundary over escaping or normalization.
 */
export const FRAME_SAFETY_BYTES = 1024;

/** What a reply may occupy on the wire. */
export const FRAME_BUDGET_BYTES = MAX_FRAME_BYTES - FRAME_SAFETY_BYTES;

/** Longest text one ordinary row may carry, as the reference bounds it. */
export const ROW_TEXT_LIMIT = 128 * 1024;

/** Longest tool output one row may carry, as the reference bounds it. */
export const TOOL_RESULT_LIMIT = 8 * 1024;

/** Suffix appended where a text field was cut, so the controller can say so. */
export const TRUNCATION_SUFFIX = '\n\n[remote content truncated: payload too large]';

/** Whole-row replacement when even a truncated row does not fit. */
export const TRUNCATED_CONTENT = '[remote content truncated: payload too large]';

/**
 * Channels whose result is a page of message rows.
 *
 * Only these can be degraded into a *usable* answer; every other channel either
 * already answers something small or gets the compact error, which is the
 * reference's split too (`REMOTE_MESSAGE_CHANNELS`).
 */
export const MESSAGE_PAGE_CHANNELS = new Set([
  'local-db:messages:list',
  'local-db:messages:around',
  'local-db:messages:around-client-id',
]);

/** UTF-8 length of one frame, which is the unit the relay counts in. */
export function frameByteLength(frame) {
  try {
    const text = JSON.stringify(frame);
    return typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : 0;
  } catch {
    // A frame that cannot be serialized is not a frame; treating it as oversized
    // makes the caller refuse it instead of throwing inside the socket path.
    return Number.POSITIVE_INFINITY;
  }
}

/** Whether one frame may be sent as-is. */
export function frameFits(frame, budgetBytes = FRAME_BUDGET_BYTES) {
  return frameByteLength(frame) <= budgetBytes;
}

/** UTF-8 length of a string, for the per-field limits. */
function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Cut one string to a byte budget without splitting a multi-byte character.
 * @param text - the field's text.
 * @param limit - the budget in UTF-8 bytes.
 * @returns the text, or the text plus the truncation suffix when it was cut.
 */
export function cutToBytes(text, limit) {
  if (typeof text !== 'string' || byteLength(text) <= limit) return { text, cut: false };
  let cut = Math.max(0, limit - byteLength(TRUNCATION_SUFFIX));
  // Never cut inside a multi-byte sequence: the phone would render a replacement
  // character where the Host meant nothing.
  while (cut > 0) {
    const candidate = text.slice(0, cut);
    if (!candidate.endsWith('\uFFFD') && byteLength(candidate) <= limit - byteLength(TRUNCATION_SUFFIX)) break;
    cut -= 1;
  }
  return { text: `${text.slice(0, cut)}${TRUNCATION_SUFFIX}`, cut: true };
}

/** `agentMeta` with the truncation witness merged in, as the reference marks it. */
function markContentTruncated(agentMeta) {
  const base = agentMeta !== null && typeof agentMeta === 'object' && !Array.isArray(agentMeta) ? agentMeta : {};
  return { ...base, remoteContentTruncated: true };
}

/** `agentMeta` with the trimmed-window witness the controller's paging reads. */
function markRowsTrimmed(agentMeta, originalCount) {
  const base = agentMeta !== null && typeof agentMeta === 'object' && !Array.isArray(agentMeta) ? agentMeta : {};
  return { ...base, remoteRowsTrimmed: true, remoteOriginalRowCount: originalCount };
}

/**
 * Stage 1: shorten the long text a row carries.
 *
 * Bounds are the reference's (`REMOTE_MESSAGE_CONTENT_LIMIT` 128 KiB for a
 * message, `REMOTE_TOOL_RESULT_CONTENT_LIMIT` 8 KiB for tool output).
 * @param rows - the page's rows.
 * @returns `{ rows, changed }`.
 */
export function compactRowText(rows) {
  let changed = false;
  const next = rows.map((row) => {
    if (row === null || typeof row !== 'object') return row;
    const content = row.content;
    if (content === null || typeof content !== 'object' || Array.isArray(content)) return row;
    if (row.role === 'tool_result' || row.role === 'tool-use') {
      const result = cutToBytes(content.text, TOOL_RESULT_LIMIT);
      if (result.cut) {
        changed = true;
        return { ...row, content: { ...content, text: result.text }, agentMeta: markContentTruncated(row.agentMeta) };
      }
      return row;
    }
    const result = cutToBytes(content.text, ROW_TEXT_LIMIT);
    if (result.cut) {
      changed = true;
      return { ...row, content: { ...content, text: result.text }, agentMeta: markContentTruncated(row.agentMeta) };
    }
    return row;
  });
  return { rows: next, changed };
}

/**
 * Stage 2: give up the inlined image bytes, keeping the row itself.
 *
 * This Host inlines a picture as `content.images[].base64` (≈4/3 of the file), which
 * is the single largest thing a page can carry. When the page still does not fit,
 * the pictures go before the conversation does: the row keeps its text, and the
 * controller's own file chip path is unaffected because the chip was consumed when
 * the image was inlined.
 * @param rows - the page's rows.
 * @returns `{ rows, changed }`.
 */
export function dropInlinedImages(rows) {
  let changed = false;
  const next = rows.map((row) => {
    const content = row?.content;
    if (content === null || typeof content !== 'object' || Array.isArray(content)) return row;
    if (!Array.isArray(content.images) || content.images.length === 0) return row;
    changed = true;
    const { images: _images, ...rest } = content;
    return { ...row, content: rest, agentMeta: markContentTruncated(row.agentMeta) };
  });
  return { rows: next, changed };
}

/**
 * Stage 3: replace every row's content with one placeholder line.
 *
 * The row identities stay, so the controller's window keeps its shape and its
 * cursor still resolves — only the bodies are gone. Tool calls keep their name,
 * because "the agent ran a tool here" is the part that is still true.
 * @param rows - the page's rows.
 * @returns the placeholder rows.
 */
export function placeholderRows(rows) {
  return rows.map((row) => {
    if (row === null || typeof row !== 'object') return row;
    const content = row.content !== null && typeof row.content === 'object' && !Array.isArray(row.content) ? row.content : {};
    const nextContent = row.role === 'tool-use'
      ? { toolName: content.toolName ?? '', input: null, ...(content.toolUseId === undefined ? {} : { toolUseId: content.toolUseId }) }
      : { text: TRUNCATED_CONTENT };
    return { ...row, content: nextContent, agentMeta: markContentTruncated(row.agentMeta) };
  });
}

/**
 * Cut a newest-first page down to its newest `keep` rows, without splitting one
 * message's rows across the cut.
 *
 * Rows of one message share `createdAt` (this Host stamps every block of a message
 * with the message's time), so the cut walks back to a group boundary; the rest of
 * a split group would otherwise sit behind the next cursor and read as a hole.
 * @param rows - the newest-first page.
 * @param keep - how many rows to keep, at most.
 * @returns the prefix.
 */
export function sliceRowsAtMessageBoundary(rows, keep) {
  const end = Math.max(1, Math.min(keep, rows.length));
  let cut = end;
  while (cut > 1 && cut < rows.length && rows[cut - 1]?.createdAt === rows[cut]?.createdAt) cut -= 1;
  return rows.slice(0, cut);
}

/**
 * Fit one invoke-result reply inside the frame budget.
 *
 * @param input - `reply` (the frame `invokeResult` built), `request` (`{ id, src }`,
 *   used to rebuild the envelope while measuring), `channel`, and an optional
 *   `budgetBytes` for tests.
 * @returns `{ reply, level, rows, bytes }` — `reply` is what to send, and `level` is
 *   which stage produced it (`'fits' | 'text' | 'images' | 'placeholder' | 'trimmed' |
 *   'refused'`), which is what the invoke log reports.
 */
export function fitInvokeResultToFrame({ reply, request, channel, budgetBytes = FRAME_BUDGET_BYTES }) {
  const measure = (payload) => frameByteLength({
    v: reply?.v ?? 1,
    kind: 'invoke-result',
    id: request?.id,
    dst: request?.src,
    payload,
  });
  const original = reply?.payload;
  if (original?.ok !== true || !Array.isArray(original.result) || !MESSAGE_PAGE_CHANNELS.has(channel)) {
    // Not a page: nothing here can be degraded into a smaller *truthful* answer.
    const bytes = measure(original);
    if (bytes <= budgetBytes) return { reply, level: 'fits', rows: null, bytes };
    return { reply: oversizedReply(reply, request, bytes), level: 'refused', rows: null, bytes };
  }
  const rows = original.result;
  if (measure(original) <= budgetBytes) return { reply, level: 'fits', rows: rows.length, bytes: measure(original) };

  const stages = [
    ['text', () => compactRowText(rows)],
    ['images', () => dropInlinedImages(rows)],
    ['placeholder', () => ({ rows: placeholderRows(rows), changed: true })],
  ];
  let current = rows;
  for (const [level, produce] of stages) {
    const produced = produce();
    if (produced.changed !== true) continue;
    current = produced.rows;
    const payload = { ...original, result: current };
    const bytes = measure(payload);
    if (bytes <= budgetBytes) return { reply: withResult(reply, current), level, rows: current.length, bytes };
  }
  const placeholders = placeholderRows(rows);
  for (let keep = placeholders.length - 1; keep > 0; keep -= 1) {
    const sliced = sliceRowsAtMessageBoundary(placeholders, keep);
    const trimmed = sliced.map((row) => (row === null || typeof row !== 'object' ? row : { ...row, agentMeta: markRowsTrimmed(row.agentMeta, placeholders.length) }));
    const payload = { ...original, result: trimmed };
    const bytes = measure(payload);
    if (bytes <= budgetBytes) return { reply: withResult(reply, trimmed), level: 'trimmed', rows: trimmed.length, bytes };
  }
  // One row that still does not fit: a single row is always under the budget in
  // practice (its text is bounded above), so this is the "something is wrong with
  // this page" path. Refuse compactly instead of dropping the connection.
  return { reply: oversizedReply(rows.length === 0 ? reply : reply, request, measure({ ...original, result: placeholders })), level: 'refused', rows: 0, bytes: measure(original) };
}

/** The reply with a different result, leaving the original frame untouched. */
function withResult(reply, result) {
  return { ...reply, payload: { ...reply.payload, result } };
}

/** The compact refusal a controller reads as "this page is too large". */
function oversizedReply(reply, request, bytes) {
  return {
    v: reply?.v ?? 1,
    kind: 'invoke-result',
    id: request?.id ?? reply?.id,
    dst: request?.src ?? reply?.dst,
    payload: {
      ok: false,
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: `this reply cannot fit one device-link frame (${bytes} bytes over the ${FRAME_BUDGET_BYTES} byte budget)`,
      },
    },
  };
}
