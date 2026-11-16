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
 * page(sessionId, before?, options) → { version: 1, items, nextCursor, hasMore }
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
 *    declines an unavailable projection capability, never a large or stale session.
 *    Per-session missing references use retryable NOT_FOUND/BAD_REQUEST instead.
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

import { projectHistoryWorkLines } from './history-work-lines.js';

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
function revisionOf(rows, metrics) {
  let hash = 2166136261;
  for (const row of rows) {
    // Source-owned stamps must change for EVERY content change. Unstamped legacy
    // rows pay the full hash; reference equality never implies immutable content.
    const stamped = typeof row.historyContentStamp === 'string';
    const text = JSON.stringify(stamped ? { ...row, content: undefined } : row);
    if (metrics) {
      metrics[stamped ? 'stampedHashRows' : 'fullHashRows'] += 1;
      metrics.hashChars += text.length;
    }
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
export function groupHistoryItems(rows, { running = null, maxWorkRows = WORK_ITEM_MAX_ROWS, chronological: inSourceOrder = false, workLines = false, metrics } = {}) {
  const chronological = inSourceOrder ? rows : [...rows].reverse();
  if (metrics) metrics.groupedRows += chronological.length;
  const items = [];
  let run = [];

  /** Emit the buffered activity run as work items, newest one marked when it is live. */
  const flushRun = (streaming) => {
    const size = maxWorkRows > 0 ? maxWorkRows : Math.max(1, run.length);
    for (let start = 0; start < run.length; start += size) {
      const chunk = run.slice(start, start + size);
      items.push(workItem(chunk, streaming && start + size >= run.length, { workLines, metrics }));
    }
    run = [];
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
export const WORK_PREVIEW_BYTES = 6 * 1024;

/**
 * One work item for a run of activity rows.
 *
 * @param run - the run's rows, in log order.
 * @param streaming - whether this run is the one still being written.
 * @returns the item the controller renders.
 */
function workItem(run, streaming, { workLines = false, metrics } = {}) {
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
    revision: `${last.id}:${run.length}:${revisionOf(run, metrics)}`,
  };
  if (workLines && streaming) {
    summary.lines = projectHistoryWorkLines(run, streaming);
    return { type: 'work', key: summary.key, summary };
  }
  // A running group gets a **preview**: the tail the controller can show inside the
  // collapsed row, which is the difference between 「正在干活」 and 「卡住了」.
  //
  // This is the contract's own field (`HistoryWorkSummary.preview`, "Existing detail
  // endpoint can read just the visible desktop tail") and the reference sets it for every
  // streaming group. Without it, folding activity into work items meant a long turn showed
  // nothing but a spinner: measured, the phone sat on 「一直在思考中转圈」 for minutes while
  // this Host pushed 100+ rows that were all inside a collapsed group.
  const tail = [];
  let previewBytes = 0;
  if (streaming) for (let index = run.length - 1; index >= 0 && tail.length < WORK_PREVIEW_ROWS; index -= 1) {
    const size = itemBytes(run[index]);
    if (previewBytes + size > WORK_PREVIEW_BYTES) break;
    tail.unshift(run[index]); previewBytes += size;
  }
  if (tail.length > 0) {
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
      revision: `${previewLast.id}:${tail.length}:${revisionOf(tail, metrics)}`,
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

export const HISTORY_WORK_PATCH_MAX_BYTES = 64 * 1024;

/**
 * Pure replacement comparison against the ACTUALLY delivered latest page. Delivery
 * lease/CAS, workLines negotiation and successful-send bookkeeping belong to host.
 * No append, JSON diff, child replacement or guessed revision repair is allowed.
 */
export function buildHistoryWorkPatch(sessionId, deliveredPage, nextPage) {
  const refresh = { kind: 'refresh' };
  try {
    if (typeof sessionId !== 'string' || !sessionId) return refresh;
    const valid = page => page?.version === HISTORY_VIEW_VERSION && Array.isArray(page.items)
      && typeof page.hasMore === 'boolean' && (page.nextCursor === null || typeof page.nextCursor === 'string');
    if (!valid(deliveredPage) || !valid(nextPage)) return refresh;
    if (deliveredPage.hasMore !== nextPage.hasMore || deliveredPage.nextCursor !== nextPage.nextCursor
      || deliveredPage.items.length !== nextPage.items.length) return refresh;
    const keys = new Set();
    let before;
    let after;
    for (let index = 0; index < nextPage.items.length; index += 1) {
      const old = deliveredPage.items[index];
      const item = nextPage.items[index];
      if (!item || !old || !item.key || keys.has(item.key) || old.key !== item.key || old.type !== item.type) return refresh;
      keys.add(item.key);
      if (item.type === 'work' && item.summary?.isStreaming === true) {
        if (after || old.summary?.isStreaming !== true || item.children !== undefined || old.children !== undefined) return refresh;
        before = old;
        after = item;
      } else {
        // This includes every non-running summary, prose, card and nested shape.
        if (JSON.stringify(old) !== JSON.stringify(item) || old.summary?.isStreaming === true) return refresh;
        const runningChild = value => value?.summary?.isStreaming === true || value?.children?.some(runningChild);
        if (item.children?.some(runningChild)) return refresh;
      }
    }
    if (!after) return refresh;
    const base = before.summary;
    const next = after.summary;
    if (base.key !== before.key || next.key !== after.key || !base.firstMessageId || base.firstMessageId !== next.firstMessageId
      || !base.lastMessageId || !next.lastMessageId || !Number.isSafeInteger(base.messageCount) || base.messageCount <= 0
      || !Number.isSafeInteger(next.messageCount) || next.messageCount < base.messageCount
      || (base.messageCount === next.messageCount && base.lastMessageId !== next.lastMessageId)
      || typeof base.revision !== 'string' || !base.revision || typeof next.revision !== 'string' || !next.revision
      || !Array.isArray(base.lines) || !Array.isArray(next.lines)) return refresh;
    if (JSON.stringify(base) === JSON.stringify(next)) return { kind: 'unchanged' };
    // A hidden-body stamp may advance after its opening line saturates. Expanded
    // details have a separate revision cadence; collapsed displays need no push.
    if (JSON.stringify({ ...base, revision: undefined }) === JSON.stringify({ ...next, revision: undefined })) return { kind: 'unchanged' };
    if (base.revision === next.revision) return refresh;
    const patch = { version: HISTORY_VIEW_VERSION, sessionId, baseRevision: base.revision,
      item: { type: 'work', key: after.key, summary: next } };
    return itemBytes(patch) <= HISTORY_WORK_PATCH_MAX_BYTES ? { kind: 'patch', patch } : refresh;
  } catch {
    return refresh;
  }
}

/**
 * Build the reader behind the three view channels.
 *
 * @param options - `snapshot` (explicit source-order rows and reference resolver),
 *   or `rows` for legacy callers with a strictly newest-first array,
 *   `sessionRunning` (whether the session is in a turn right now, for `isStreaming`),
 *   and the page/scan limits.
 * @returns `{ page, details, intent, expandedFor }`.
 */
export function createHistoryViewController({
  rows,
  snapshot,
  sessionRunning = () => false,
  pageItems = HISTORY_PAGE_ITEMS,
  pageBytes = HISTORY_PAGE_BYTES,
  detailBytes = HISTORY_DETAIL_PAGE_BYTES,
  hydrate,
} = {}) {
  /**
   * Turn the served rows' image handles into bytes, in place.
   *
   * A view page is a **second** read path, and the reason this hook exists: image hydration was
   * wired into `local-db:messages:list` alone, so when the controller moved onto this view
   * (`history-view-v1`) every user photo silently went back to a path-less file chip — the
   * 「发送的照片看不到」 regression, on a path nothing hydrated. Anything that serves rows to the
   * phone has to run this.
   *
   * Called **after** the page's items are chosen, so only the rows being served pay for reading
   * image bytes, and the page's own byte budget still counts text only (the pictures carry their
   * own budget inside the hydrator).
   *
   * @param servedRows - the rows of the page about to be returned.
   */
  async function hydrateServed(servedRows) {
    if (typeof hydrate !== 'function' || servedRows.length === 0) return;
    await hydrate(servedRows);
  }

  /** `sessionId` → the work keys the controller currently has expanded. */
  const expanded = new Map();
  const projections = new Map();
  const metrics = { groupedRows: 0, fullHashRows: 0, stampedHashRows: 0, hashChars: 0, sealedPrefixRowsReused: 0, cacheHits: 0, rebuilds: 0, suffixUpdates: 0 };

  /** Optional snapshot contract (never inferred from array/object identity):
   * projection:{identity,version,sealedPrefixLength}. Within one identity, sealed
   * prefix rows NEVER change/reorder/disappear, and its length only increases.
   * Version covers every row/content change; rewind/gap must change identity.
   * This permanent-prefix promise is safe even when page reads skip versions.
   * Source historyContentStamp, when present, covers every content change.
   */
  function projectedItems(sessionId, read, { running, workLines }) {
    const meta = read.projection;
    const versioned = meta && meta.identity != null && meta.version != null
      && Number.isSafeInteger(meta.sealedPrefixLength) && meta.sealedPrefixLength >= 0 && meta.sealedPrefixLength <= read.rows.length;
    if (!versioned) {
      projections.delete(sessionId);
      metrics.rebuilds += 1;
      return groupHistoryItems(read.rows, { chronological: true, running, workLines, metrics });
    }
    let modes = projections.get(sessionId);
    if (!modes) modes = new Map();
    // Small session LRU. These are disposable projections, not transcript owners.
    projections.delete(sessionId);
    projections.set(sessionId, modes);
    if (projections.size > 3) projections.delete(projections.keys().next().value);
    let cache = modes.get(workLines);
    if (cache && cache.identity === meta.identity && cache.sealed <= meta.sealedPrefixLength && cache.length <= read.rows.length) {
      if (cache.version === meta.version && cache.running === running && cache.length === read.rows.length) {
        metrics.cacheHits += 1;
        return cache.items;
      }
      // Retain only entries fully inside the PREVIOUS immutable prefix. A newly
      // sealed old live row still needs one last projection before it is cached.
      while (cache.entries.length && cache.entries.at(-1).end > cache.sealed) cache.entries.pop();
      const last = cache.entries.at(-1);
      if (last?.item.type === 'work' && (last.item.summary.messageCount < WORK_ITEM_MAX_ROWS || last.item.summary.isStreaming || last.end === read.rows.length)) cache.entries.pop();
      const start = cache.entries.at(-1)?.end ?? 0;
      cache.items.length = cache.entries.length;
      metrics.sealedPrefixRowsReused += start;
      metrics.suffixUpdates += 1;
      const suffix = groupHistoryItems(read.rows.slice(start), { chronological: true, running, workLines, metrics });
      let position = start;
      for (const item of suffix) {
        position += item.type === 'work' ? item.summary.messageCount : item.messages.length;
        cache.entries.push({ item, end: position });
        cache.items.push(item);
      }
    } else {
      metrics.rebuilds += 1;
      const items = groupHistoryItems(read.rows, { chronological: true, running, workLines, metrics });
      let position = 0;
      const entries = items.map(item => {
        position += item.type === 'work' ? item.summary.messageCount : item.messages.length;
        return { item, end: position };
      });
      cache = { items, entries };
      modes.set(workLines, cache);
    }
    Object.assign(cache, { identity: meta.identity, version: meta.version, sealed: meta.sealedPrefixLength, length: read.rows.length, running });
    return cache.items;
  }

  /** The transcript for one session, or a refusal the controller understands. */
  async function transcriptFor(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      return { ok: false, code: 'BAD_REQUEST', message: 'history view needs a session' };
    }
    if (typeof rows !== 'function' && typeof snapshot !== 'function') {
      return { ok: false, code: 'NOT_AVAILABLE', message: 'this DSH Host cannot project session history' };
    }
    let all;
    try {
      all = typeof snapshot === 'function' ? await snapshot(sessionId) : await rows(sessionId);
    } catch {
      return { ok: false, code: 'NOT_FOUND', message: 'this session has no readable transcript' };
    }
    if (Array.isArray(all)) {
      const chronological = [...all].reverse();
      all = { rows: chronological, resolve: id => chronological.findIndex(row => row.id === id) };
    }
    if (!Array.isArray(all?.rows) || typeof all.resolve !== 'function') return { ok: false, code: 'INTERNAL', message: 'the transcript could not be read' };
    // Long transcripts are **served**, not refused.
    //
    // This was `all.length > scanMaxRows → UNSUPPORTED_CAPABILITY`, on the reasoning that the
    // scan would time out on the phone and the controller recognises that code as "no view
    // here". Both halves are wrong, and the cost is permanent:
    //
    // - it saves no scan. `rows` is the reader's transcript (`readMessages.all`, i.e.
    //   `ensureTranscript`), so the full read has **already happened and been cached** before
    //   this function is entered; refusal cannot undo it. Versioned snapshots now
    //   reuse the sealed projection prefix; legacy sources are conservatively regrouped.
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
    return { ok: true, rows: all.rows, resolve: all.resolve, projection: all.projection };
  }

  /**
   * One page of work items, newest window by default.
   * @param sessionId - the session.
   * @param before - a cursor from a previous page: the oldest id that page returned.
   * @param options - workLines:true negotiates bounded running lines, not a body preview.
   */
  async function page(sessionId, before = undefined, options = {}) {
    const read = await transcriptFor(sessionId);
    if (read.ok !== true) return read;
    let endRow = read.rows.length;
    if (typeof before === 'string' && before !== '') {
      endRow = read.resolve(before, { cut: true });
      if (endRow < 0) return { ok: false, code: 'NOT_FOUND', message: 'history cursor is no longer in this session' };
    }
    // Cut by source position before grouping: an anchor may now lie inside a merged work.
    const workLines = options?.workLines === true;
    const running = !before && (typeof sessionRunning === 'function' ? sessionRunning(sessionId) === true : null);
    const items = !before ? projectedItems(sessionId, read, { running, workLines })
      : groupHistoryItems(read.rows.slice(0, endRow), { chronological: true, running, workLines, metrics });
    const end = items.length;
    const selected = [];
    let bytes = 1024;
    for (let index = end - 1; index >= 0; index -= 1) {
      const size = itemBytes(items[index]);
      if (selected.length > 0 && (selected.length >= pageItems || bytes + size > pageBytes)) break;
      selected.unshift(items[index]);
      bytes += size;
    }
    const hasMore = selected.length > 0 && end - selected.length > 0;
    await hydrateServed(selected.flatMap((item) => (item.type === 'messages' ? item.messages ?? [] : [])));
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
    // Both endpoints and the forward cursor resolve against one source-order snapshot.
    const chronological = read.rows;
    const from = read.resolve(firstId);
    const to = read.resolve(lastId);
    if (from < 0 || to < 0 || to < from) return { ok: false, code: 'NOT_FOUND', message: 'this work range is no longer in the transcript' };
    const range = chronological.slice(from, to + 1);
    let start = 0;
    if (typeof after === 'string' && after !== '') {
      const index = read.resolve(after) - from;
      if (index < 0 || index >= range.length) return { ok: false, code: 'BAD_REQUEST', message: 'the detail cursor is outside this work range' };
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
    await hydrateServed(messages);
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

  return { page, details, intent, expandedFor,
    metrics: () => ({ ...metrics }),
    invalidate: sessionId => { projections.delete(sessionId); return expanded.delete(sessionId); },
  };
}
