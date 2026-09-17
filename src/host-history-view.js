/**
 * `local-db:messages:view` — the work-grouped history window the controller prefers.
 *
 * Why this channel exists at all: the phone's raw transcript path pages **20 rows at a
 * time** (`MESSAGE_FETCH_PAGE_SIZE`) and, on a full-page sync, deliberately drops the
 * older history it cannot prove is contiguous (`setLatestMessageWindow` +
 * `sessionWindowCoverage` in `apps/mobile/src/session/remoteSessionStore.ts`). The result
 * is 「每次重新进入会话都重新拉取、丢掉之前翻出来的历史」 — the client's own rule, and the
 * reason the reference controlled end serves a *history view* instead: it returns
 * **work items** with their own cursor, so the controller keeps a projection it can trust
 * across re-entries rather than guessing at raw row continuity.
 *
 * Contract (read off `@cindy/maker-shared/message-window`, the desktop reader
 * `apps/desktop/src/main/localDb/ipc/historyViewReader.ts`, and the phone's transport):
 *
 * ```
 * page(sessionId, before?)          → { version: 1, items, nextCursor, hasMore }
 * details(sessionId, ref, after?)   → { version: 1, messages, nextCursor, hasMore }
 * intent(sessionId, refs)           → true
 * ```
 *
 *  - **A page's `items` are chronological** (oldest → newest); `nextCursor` is the
 *    **oldest** id of that page (`firstId(items[0])`) and is passed back as `before` to
 *    walk further back. `hasMore` is what lights the controller's "load older".
 *  - A `work` item carries a `HistoryWorkSummary`; a `messages` item is a plain row the
 *    controller renders on its own.
 *  - `details` reads the inclusive range `firstMessageId…lastMessageId`, one
 *    `HISTORY_DETAIL_PAGE_BYTES` page at a time, with `after` = the last row already sent.
 *  - `intent` replaces the set of expanded work keys wholesale; it is advisory.
 *  - An error whose text matches `isHistoryViewUnavailable` sends the controller back to
 *    the raw window. `UNSUPPORTED_CAPABILITY` is therefore how this Host *deliberately*
 *    declines a session it cannot project (a transcript past the scan budget) — the same
 *    lever the reference uses.
 *
 * Grouping here is by **DSH turn boundary as the controller can see it**: a row whose role
 * is `user` starts a work group, and everything up to the next one belongs to it. The
 * desktop groups more finely (sealed answers and their own activity runs, from row shapes
 * this Host does not have), but the contract is about the *page*, not the grouping: a
 * coarser work item is still a work item, and `preview`/`children` are optional.
 *
 * @module dsh-cindy-host/host-history-view
 */
import {
  HISTORY_DETAIL_PAGE_BYTES,
  HISTORY_PAGE_BYTES,
  HISTORY_PAGE_ITEMS,
  HISTORY_VIEW_VERSION,
} from './host-history-view-limits.js';

/** One history page's byte ceiling is the contract's, not this Host's choice. */
export { HISTORY_DETAIL_PAGE_BYTES, HISTORY_PAGE_BYTES, HISTORY_PAGE_ITEMS, HISTORY_VIEW_VERSION };

/**
 * Longest transcript this Host will project — **no longer a ceiling**.
 *
 * Kept only so the removed refusal is visible where it used to be: the budget did not save the
 * read (it had already happened and been cached) and refusing poisoned the controller's view
 * permanently. See the comment in `transcriptFor` and ADR-0007's decision evolution. Nothing
 * reads this constant; a future "this is too big" rule must find a retryable answer instead.
 */
export const HISTORY_SCAN_MAX_ROWS = 20_000;

/** FNV-1a over the group's rows: the revision changes whenever the group's body does. */
function revisionOf(rows) {
  let hash = 2166136261;
  for (const row of rows) {
    const text = JSON.stringify(row);
    for (let index = 0; index < text.length; index += 1) {
      hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
    }
  }
  return hash >>> 0;
}

/** A row's own key in the controller's vocabulary. */
function keyOf(row) {
  return row.clientId || row.id;
}

/** The id a page's cursor is built from: a work item's first row, or a row itself. */
export function firstIdOf(item) {
  return item.type === 'work' ? item.summary.firstMessageId : item.messages[0]?.id ?? '';
}

/**
 * Rows one work item may carry before the run is split.
 *
 * A work item is *collapsed* until the controller expands it, so an item that swallows a
 * whole turn hides the conversation: measured on this session, grouping a turn as one item
 * produced a page of twenty collapsed items with **zero** readable rows, one of them
 * carrying 329 rows — 「进入会话，只显示一号折叠的会话，然后每次展开十来分钟，又要继续展开」.
 * The cap keeps every expansion to roughly one detail page.
 */
export const WORK_ITEM_MAX_ROWS = 40;

/**
 * Whether a row is the plan card rather than agent activity.
 *
 * A `TodoWrite` row is a **card**, not a step: the controller lifts those rows into their
 * own top-level item (the desktop projection's own tests list them as
 * `['message', 'work_group', 'todo', 'message']`). Leaving one inside an activity run hides
 * it behind an expansion — which is what happened as soon as the phone switched to this
 * view: 「我没有看到你刚刚这个小任务的 to do」, because the plan rows only ever arrived
 * inside collapsed segments.
 */
function isTodoRow(row) {
  return row?.role === 'tool_use' && row?.content?.toolName === 'TodoWrite';
}

/** Whether a row is agent *activity* (folded into a work item) rather than prose or a card. */
function isActivityRow(row) {
  if (isTodoRow(row)) return false;
  return row?.role === 'thinking' || row?.role === 'tool_use' || row?.role === 'tool_result';
}

/**
 * Group one transcript (in either order) into work items and readable rows.
 *
 * The split follows the renderer contract, not a turn's extent:
 *
 *  - a **user prompt** and an **assistant answer** stay top-level `messages` items, because
 *    those are what a person reads — the desktop's projection keeps them visible too
 *    (`['message', 'work_group', 'todo', 'message']` in its own tests);
 *  - the **activity in between** (thinking, tool calls, tool results) collapses into `work`
 *    items, split every {@link WORK_ITEM_MAX_ROWS} rows so one expansion is one page.
 *
 * @param rows - the transcript rows, **newest first** (the reader's order).
 * @param options - `running` says whether the session is in a turn right now; `null` (the
 *   default) derives it: a transcript that does not end in an answer is still being written.
 * @returns items in **chronological** order, oldest first.
 */
export function groupHistoryItems(rows, { running = null, maxWorkRows = WORK_ITEM_MAX_ROWS } = {}) {
  const chronological = [...rows].reverse();
  const items = [];
  let run = [];

  /** Emit the buffered activity run as work items, newest one marked when it is live. */
  const flushRun = (streaming) => {
    while (run.length > 0) {
      const chunk = maxWorkRows > 0 ? run.slice(0, maxWorkRows) : run;
      run = run.slice(chunk.length);
      items.push(workItem(chunk, streaming && run.length === 0));
    }
  };

  for (const row of chronological) {
    if (isActivityRow(row)) {
      run.push(row);
      continue;
    }
    // Prose ends the run before it, and stays readable itself.
    flushRun(false);
    items.push({ type: 'messages', key: keyOf(row), messages: [row] });
  }
  const derivedRunning = running === null ? chronological[chronological.length - 1]?.role !== 'assistant' : running === true;
  flushRun(derivedRunning);
  return items;
}

/** Rows of the live tail a streaming work item shows without being expanded. */
export const WORK_PREVIEW_ROWS = 5;

/**
 * One work item for a run of activity rows.
 *
 * @param run - the run's rows, in log order.
 * @param streaming - whether this run is the one still being written.
 * @returns the item the controller renders.
 */
function workItem(run, streaming) {
  const first = run[0];
  const last = run[run.length - 1];
  const summary = {
    key: `work-${keyOf(first)}`,
    anchorClientId: keyOf(first),
    firstMessageId: first.id,
    lastMessageId: last.id,
    startedAtMs: Date.parse(first.createdAt) || 0,
    endedAtMs: Date.parse(last.createdAt) || 0,
    isStreaming: streaming,
    messageCount: run.length,
    toolCount: run.filter((row) => row.role === 'tool_use').length,
    revision: `${last.id}:${run.length}:${revisionOf(run)}`,
  };
  // A running group gets a **preview**: the tail the controller can show inside the
  // collapsed row, which is the difference between 「正在干活」 and 「卡住了」.
  //
  // This is the contract's own field (`HistoryWorkSummary.preview`, "Existing detail
  // endpoint can read just the visible desktop tail") and the reference sets it for every
  // streaming group. Without it, folding activity into work items meant a long turn showed
  // nothing but a spinner: measured, the phone sat on 「一直在思考中转圈」 for minutes while
  // this Host pushed 100+ rows that were all inside a collapsed group.
  if (streaming && run.length > 0) {
    const tail = run.slice(Math.max(0, run.length - WORK_PREVIEW_ROWS));
    const previewFirst = tail[0];
    const previewLast = tail[tail.length - 1];
    summary.preview = {
      key: `preview-${summary.key}`,
      anchorClientId: keyOf(previewFirst),
      firstMessageId: previewFirst.id,
      lastMessageId: previewLast.id,
      startedAtMs: Date.parse(previewFirst.createdAt) || 0,
      endedAtMs: Date.parse(previewLast.createdAt) || 0,
      isStreaming: true,
      messageCount: tail.length,
      toolCount: tail.filter((row) => row.role === 'tool_use').length,
      revision: `${previewLast.id}:${tail.length}:${revisionOf(tail)}`,
    };
  }
  return { type: 'work', key: summary.key, summary };
}

/** UTF-8 size of one item, which is what the page budgets count. */
function itemBytes(item) {
  try {
    return Buffer.byteLength(JSON.stringify(item), 'utf8');
  } catch {
    return 0;
  }
}

/**
 * Build the reader behind the three view channels.
 *
 * @param options - `rows` (the transcript reader's whole-transcript accessor),
 *   `sessionRunning` (whether the session is in a turn right now, for `isStreaming`),
 *   and the page/scan limits.
 * @returns `{ page, details, intent, expandedFor }`.
 */
export function createHistoryViewController({
  rows,
  sessionRunning = () => false,
  pageItems = HISTORY_PAGE_ITEMS,
  pageBytes = HISTORY_PAGE_BYTES,
  detailBytes = HISTORY_DETAIL_PAGE_BYTES,
} = {}) {
  /** `sessionId` → the work keys the controller currently has expanded. */
  const expanded = new Map();

  /** The transcript for one session, or a refusal the controller understands. */
  async function transcriptFor(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      return { ok: false, code: 'BAD_REQUEST', message: 'history view needs a session' };
    }
    if (typeof rows !== 'function') {
      return { ok: false, code: 'NOT_AVAILABLE', message: 'this DSH Host cannot project session history' };
    }
    let all;
    try {
      all = await rows(sessionId);
    } catch {
      return { ok: false, code: 'NOT_FOUND', message: 'this session has no readable transcript' };
    }
    if (!Array.isArray(all)) return { ok: false, code: 'INTERNAL', message: 'the transcript could not be read' };
    // Long transcripts are **served**, not refused.
    //
    // This was `all.length > scanMaxRows → UNSUPPORTED_CAPABILITY`, on the reasoning that the
    // scan would time out on the phone and the controller recognises that code as "no view
    // here". Both halves are wrong, and the cost is permanent:
    //
    // - it saves no scan. `rows` is the reader's transcript (`readMessages.all`, i.e.
    //   `ensureTranscript`), so the full read has **already happened and been cached** before
    //   this function is entered; `page()` below only windows that array in O(page).
    // - it does not degrade, it kills. The controller's `historyViewController.refresh()`
    //   returns immediately **forever** once its error matches `UNSUPPORTED_CAPABILITY`
    //   (`packages/maker-shared/src/historyViewController.ts:95`), and only `reset()` clears
    //   that error — while re-entry does not reliably reset, and the row count is a permanent
    //   property of the session, so a long session's view is dead for the life of the screen.
    //   `maker:history-view-changed` is the controller's only refresh trigger, so every push
    //   we send lands on that dead path.
    //
    // `UNSUPPORTED_CAPABILITY` and `CHANNEL_NOT_ALLOWED` are therefore reserved for "this Host
    // has no projection capability at all" — a deployment fact — and never for a property of
    // one session. See ADR-0007's decision evolution.
    return { ok: true, rows: all };
  }

  /**
   * One page of work items, newest window by default.
   * @param sessionId - the session.
   * @param before - a cursor from a previous page: the oldest id that page returned.
   */
  async function page(sessionId, before = undefined) {
    const read = await transcriptFor(sessionId);
    if (read.ok !== true) return read;
    const items = groupHistoryItems(read.rows, {
      running: typeof sessionRunning === 'function' ? sessionRunning(sessionId) === true : null,
    });

    // `before` names a row inside the older part of the transcript: everything at or after
    // it has already been sent, so the next page starts strictly older than that item.
    let end = items.length;
    if (typeof before === 'string' && before !== '') {
      const index = items.findIndex((item) => firstIdOf(item) === before
        || (item.type === 'work' && item.summary.lastMessageId === before));
      if (index >= 0) end = index;
      else {
        // A cursor this Host cannot place: answer the oldest page we have rather than the
        // newest one again, which is what re-serving the same rows would amount to.
        end = Math.min(items.length, pageItems);
      }
    }
    const selected = [];
    let bytes = 1024;
    for (let index = end - 1; index >= 0; index -= 1) {
      const size = itemBytes(items[index]);
      if (selected.length > 0 && (selected.length >= pageItems || bytes + size > pageBytes)) break;
      selected.unshift(items[index]);
      bytes += size;
    }
    const hasMore = selected.length > 0 && end - selected.length > 0;
    return {
      ok: true,
      result: {
        version: HISTORY_VIEW_VERSION,
        items: selected,
        hasMore,
        nextCursor: hasMore && selected.length > 0 ? firstIdOf(selected[0]) : null,
      },
    };
  }

  /**
   * The rows of one work range, one page at a time.
   * @param sessionId - the session.
   * @param ref - the controller's `HistoryWorkReference` (its `firstMessageId`/`lastMessageId`).
   * @param after - the last row id already sent, for the next page.
   */
  async function details(sessionId, ref, after = undefined) {
    const read = await transcriptFor(sessionId);
    if (read.ok !== true) return read;
    const firstId = typeof ref?.firstMessageId === 'string' ? ref.firstMessageId : '';
    const lastId = typeof ref?.lastMessageId === 'string' ? ref.lastMessageId : '';
    if (firstId === '' || lastId === '') return { ok: false, code: 'BAD_REQUEST', message: 'a work range needs both endpoints' };
    // The transcript is newest first; the range is inclusive in log order.
    const chronological = [...read.rows].reverse();
    const from = chronological.findIndex((row) => row.id === firstId);
    const to = chronological.findIndex((row) => row.id === lastId);
    if (from < 0 || to < 0 || to < from) return { ok: false, code: 'NOT_FOUND', message: 'this work range is no longer in the transcript' };
    const range = chronological.slice(from, to + 1);
    let start = 0;
    if (typeof after === 'string' && after !== '') {
      const index = range.findIndex((row) => row.id === after);
      if (index < 0) return { ok: false, code: 'BAD_REQUEST', message: 'the detail cursor is outside this work range' };
      start = index + 1;
    }
    const messages = [];
    let bytes = 1024;
    for (let index = start; index < range.length; index += 1) {
      const row = range[index];
      const size = itemBytes(row);
      if (messages.length > 0 && bytes + size > detailBytes) break;
      messages.push(row);
      bytes += size;
    }
    const lastSent = messages[messages.length - 1];
    const hasMore = messages.length > 0 && start + messages.length < range.length;
    return {
      ok: true,
      result: {
        version: HISTORY_VIEW_VERSION,
        messages,
        hasMore,
        nextCursor: hasMore && lastSent !== undefined ? lastSent.id : null,
      },
    };
  }

  /**
   * Replace the controller's expanded work set.
   * @param sessionId - the session.
   * @param refs - the expanded summaries, as the controller sends them.
   */
  async function intent(sessionId, refs) {
    if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, code: 'BAD_REQUEST', message: 'history intent needs a session' };
    if (!Array.isArray(refs) || refs.length > 100) return { ok: false, code: 'BAD_REQUEST', message: 'invalid expanded work groups' };
    const keys = [];
    for (const ref of refs) {
      const key = typeof ref?.key === 'string' ? ref.key.replace(/^preview-/, '') : '';
      if (key === '') return { ok: false, code: 'BAD_REQUEST', message: 'an expanded work group needs a key' };
      keys.push(key);
    }
    if (keys.length === 0) expanded.delete(sessionId);
    else expanded.set(sessionId, new Set(keys));
    return { ok: true, result: true };
  }

  /** What the controller has expanded for one session (advisory; used by the status route). */
  function expandedFor(sessionId) {
    return [...(expanded.get(sessionId) ?? new Set())];
  }

  return { page, details, intent, expandedFor };
}
