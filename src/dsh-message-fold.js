/**
 * Read one DSH session's transcript as the message rows the Cindy phone renders.
 *
 * `sessionController.page()` would need a `throughSeq` the Host has no cheap way
 * to learn, while `sessionQuery.readSession()` returns the whole log directly —
 * so the fold is: log events → append-origin surface events → model messages →
 * the phone's per-block rows.
 *
 * Why *append-origin* events rather than the model-visible surface: the surface
 * deliberately shadows replaced ranges, so a landed replacement would erase
 * conversation the user already saw. The transcript's durable source material is
 * the append-origin events (`@deepseek-ai/dsh-session/surface`).
 *
 * The per-event projection is DSH's own pure `deriveEventMessage`, not a
 * reimplementation: it is documented as THE per-node rule that delivery, durable
 * history, and model requests all share, so a second copy here would drift.
 */
import { deriveEventMessage, isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface';
import { toCindyMessageRows, toCindyMessages, hydrateImageAttachments } from './cindy-message-row.js';

/** Default page size when the controller does not ask for one. */
export const DEFAULT_MESSAGE_PAGE = 60;

/**
 * Rows the **newest** page is filled to when the controller asks for fewer.
 *
 * The controller's request that opens a session asks for **20** rows on purpose
 * (`MESSAGE_PAGE_RETRY_LIMITS`, `apps/mobile/app/sessions/[sessionId].tsx`), because
 * "On a slow mobile link an 80-row page can occupy the reliable stream past the
 * request deadline" (`apps/mobile/src/session/messagePaging.ts`). That reasoning is
 * about a page's **bytes**, and its measurement is recorded in the controller's
 * invoke policy: 「the Android weak-link regression took ~18s to deliver 200KB」
 * (`@cindy/device-link`'s `invokePolicy.ts`, which is also why
 * `local-db:messages:list` gets a 30 s timeout there).
 *
 * A row here is one content block, so one agent turn — thinking, tool call, tool
 * result, answer — can be twenty rows by itself. Measured on the conversation the
 * user reported (画一只小猫): the newest page was 21 rows and covered exactly **one**
 * turn of five, so opening the session showed 「只显示最后一个回复」; filling it to the
 * controller's own 80-row cache window still missed 「我的第一条信息」, because that
 * transcript is 81 rows.
 *
 * So the newest page is filled by **both** bounds: at most this many rows, and at
 * most {@link NEWEST_WINDOW_TEXT_BYTES} of row JSON. Cursor-paged requests that
 * follow still honour the requested limit exactly, and the controller compares a
 * full page against its requested limit, so its "there is older history" affordance
 * is unchanged.
 */
export const NEWEST_WINDOW_ROWS = 200;

/**
 * Text budget for the newest page, before any image is inlined.
 *
 * 256 KiB is a quarter of the 1 MiB measured as a workable page on the worst link
 * the controller has recorded (~18 s per 200 KB), which keeps the open request
 * inside its 30 s deadline even when the page is all text, and leaves room for a
 * picture from {@link MAX_INLINE_IMAGE_BYTES} on top.
 */
export const NEWEST_WINDOW_TEXT_BYTES = 256 * 1024;

/**
 * How many sessions' folded transcripts are kept at once.
 *
 * The controller pages one session at a time (20 rows a request, `MESSAGE_FETCH_PAGE_SIZE`)
 * and switches between a handful, so a small window covers the real access pattern.
 * Each entry holds the rows of one whole transcript, which is why this is a handful
 * rather than a directory.
 */
export const TRANSCRIPT_CACHE_SESSIONS = 3;

/**
 * Fold ONE live session event into the rows the controller appends.
 *
 * Used by the push path: the controller's `local-db:messages:created` handler
 * takes `{ sessionId, message }` and appends it, so a live event becomes the same
 * rows the transcript read produces — one fold, two callers.
 * @param event - a `session/event` payload from the DSH session service.
 * @param context - the session id and an injectable clock.
 * @returns the rows to push, or an empty array when the event renders nothing.
 */
export function foldSessionEvent(event, { sessionId, now = () => new Date() }) {
  if (event === null || typeof event !== 'object') return [];
  if (!isAppendSurfaceEvent(event)) return [];
  let message;
  try {
    message = deriveEventMessage(event);
  } catch {
    return [];
  }
  if (message === null || message === undefined) return [];
  const createdAt = Number.isFinite(event.time) ? new Date(event.time).toISOString() : now().toISOString();
  // The controller's own id for a submitted prompt travels with the row so it
  // can retire the copy it showed optimistically.
  return toCindyMessageRows(message, { sessionId, createdAt, now, promptClientId: promptRpcIdOf(event) });
}

/**
 * The controller's own id for a prompt that just became a durable message.
 *
 * This Host sets each prompt's `requestId` to the controller's `clientId`, and
 * DSH stores that as the message source's `rpcId`. The moment this message lands,
 * the inbox entry is gone — so this is exactly when the controller's optimistic
 * "队列中" row must be retired. It is also the only moment we can name that row
 * without reading DSH's inbox projection, which the control stream does not push
 * for us.
 *
 * @param event - one `session/event` payload.
 * @returns the controller's id, or null when this event is not a submitted prompt.
 */
export function promptRpcIdOf(event) {
  // The source rides inside `data` on a durable event, but a delivery-shaped
  // event carries it at the top level; both are read rather than guessing.
  const source = event?.data?.source ?? event?.source;
  if (source === null || typeof source !== 'object') return null;
  if (source.kind !== 'user') return null;
  return typeof source.rpcId === 'string' && source.rpcId !== '' ? source.rpcId : null;
}

/**
 * Cut one page out of a newest-first transcript.
 *
 * Extracted from the reader so the paging rule can be tested directly: the
 * interesting part is the cursor, not the log read.
 *
 * **The cursor is a row id, not a timestamp.** The controller walks back with
 * `oldestMessageCursor(loaded)` — literally the oldest loaded row's `id`
 * (`apps/mobile/src/session/messagePaging.ts`) — and merges the answer only when
 * that exact id is still in its window (`mergeEarlierMessages` looks the anchor
 * up with `row.id === before` and returns false otherwise). Treating the cursor
 * as a `createdAt` made every request return the newest page again: the string
 * comparison `'2026-…' < 'session-…'` is true for every row, so a "load earlier"
 * fetched nothing new, forever.
 *
 * An ISO-timestamp cursor is still honoured, because that is what this Host
 * itself sent before the contract was read correctly and a controller can hold
 * one across an upgrade.
 *
 * @param rows - the whole transcript, newest first.
 * @param options - the controller's `before` cursor (a row id) and `limit`.
 * @returns the page.
 */
export function pageRows(rows, options = {}) {
  const before = typeof options?.before === 'string' && options.before !== '' ? options.before : null;
  let candidates = rows;
  let resumeAt = 0;
  if (before !== null) {
    const anchor = rows.findIndex((row) => row.id === before);
    if (anchor >= 0) {
      // Everything strictly older than the row the controller named.
      resumeAt = anchor + 1;
    } else if (rows.some((row) => row.createdAt === before)) {
      // A timestamp cursor: the row that carried it is itself part of the next
      // page, since the controller has not shown it yet.
      const firstAtOrBelow = rows.findIndex((row) => row.createdAt < before);
      resumeAt = firstAtOrBelow < 0 ? rows.length : firstAtOrBelow;
    } else {
      // An id this Host does not know: a retained row from another device, or a
      // cursor minted before an id scheme change. The honest answer is the
      // oldest page we have rather than the newest one again.
      resumeAt = Math.max(0, rows.length - countForLimit(rows, options));
    }
    candidates = rows.slice(resumeAt);
  }
  const limit = Number.isFinite(options?.limit) && options.limit > 0 ? Math.floor(options.limit) : DEFAULT_MESSAGE_PAGE;
  const page = candidates.slice(0, limit);
  // Never split one message across two pages.
  //
  // A message's rows (thought, tool call, answer) all share one timestamp, so
  // cutting a group in half would leave the rest of that group behind a cursor
  // the controller computes from the page tail — those rows become unreachable
  // and the transcript shows a hole the user cannot page past. Finishing the
  // group is cheap, and the extra rows only ever make the page fuller than the
  // controller asked for.
  const boundary = page.length > 0 ? page[page.length - 1].createdAt : null;
  if (boundary !== null) {
    for (let index = page.length; index < candidates.length; index += 1) {
      if (candidates[index].createdAt !== boundary) break;
      page.push(candidates[index]);
    }
  }
  return page;
}

/** How many rows a limit asks for, for the unknown-cursor fallback. */
function countForLimit(rows, options) {
  return Number.isFinite(options?.limit) && options.limit > 0 ? Math.floor(options.limit) : DEFAULT_MESSAGE_PAGE;
}

/** Whether this request is the "what is in this session" page rather than a cursor step. */
function isNewestRequest(options) {
  return !(typeof options?.before === 'string' && options.before !== '');
}

/** UTF-8 size of one row's JSON, which is what the controller has to carry. */
function rowByteLength(row) {
  try {
    const text = JSON.stringify(row);
    return typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : 0;
  } catch {
    return 0;
  }
}

/**
 * Cut the newest page down to {@link NEWEST_WINDOW_TEXT_BYTES}, without splitting a
 * message's rows across the cut.
 *
 * The rows are newest first, so the cut keeps the newest ones — which is the end of
 * the conversation the user is looking at — and the controller's "load earlier"
 * affordance still reaches the rest, because the page is far longer than the twenty
 * rows it asked for.
 * @param rows - the newest-first page.
 * @returns the page, possibly shorter.
 */
function fitNewestPageBytes(rows, maxBytes = NEWEST_WINDOW_TEXT_BYTES) {
  let bytes = 0;
  let keep = 0;
  for (const row of rows) {
    const size = rowByteLength(row);
    // One row always travels: a page the controller cannot use is worse than a
    // slightly oversized one, and the frame budget still guards the hard ceiling.
    if (keep > 0 && bytes + size > maxBytes) break;
    bytes += size;
    keep += 1;
  }
  if (keep >= rows.length) return rows;
  // Rows of one message share `createdAt`; cutting inside the group would leave the
  // rest behind a cursor the controller computes from the page tail.
  while (keep > 1 && rows[keep - 1]?.createdAt === rows[keep]?.createdAt) keep -= 1;
  return rows.slice(0, keep);
}

/**
 * The page options for one request, with the newest page widened.
 *
 * Only a request with **no cursor** is the "what is in this session" page; a request
 * that names a `before` row is the controller walking backwards, one deliberate step
 * at a time, and is answered with exactly the limit it asked for.
 * @param options - the controller's `{ before, limit }`.
 * @returns options for `pageRows`.
 */
function widenNewestPage(options) {
  const before = typeof options?.before === 'string' && options.before !== '' ? options.before : null;
  if (before !== null) return options;
  const limit = Number.isFinite(options?.limit) && options.limit > 0 ? Math.floor(options.limit) : DEFAULT_MESSAGE_PAGE;
  if (limit >= NEWEST_WINDOW_ROWS) return options;
  return { ...options, limit: NEWEST_WINDOW_ROWS };
}

/**
 * Render one DSH `todo/write` snapshot as the row the phone draws its plan card from.
 *
 * DSH's todo tool declares its payload as **log-only** state — 「Log-only UI state; never
 * derived history」 — so the transcript fold deliberately drops it, and the desk renders it
 * from the `todos` projection instead. The phone has no such projection surface: its card
 * comes from a **`TodoWrite` tool row** in the transcript (`extractTodosFromMessage` /
 * `agentPlanSource`, `@cindy/maker-shared/message-render`). So a plan that only ever
 * reached DSH as `todo/write` — which is exactly how the claw workflow mirrors its plan
 * onto the native todo dock (`session.append('todo/write', { todos })` in
 * `@veewo/dsh-claw-kit`) — was invisible on the handset: 你走 claw 流程是有 ToDo 同步的，
 * 但手机上只有一句也看不到.
 *
 * The translation invents nothing: the same `{ content, status }` items DSH folded are
 * handed over in the tool-call shape the phone already knows (`todo_write` is mapped to
 * `TodoWrite` by name in `cindy-message-row.js`), stamped with the snapshot's own time so
 * the card sits where the write happened and updates as the plan progresses.
 *
 * An **empty** snapshot is skipped on purpose: the adapter clears the dock by writing an
 * empty list, and an empty *card* is not the same thing as no card.
 *
 * @param event - one session event.
 * @returns the transcript entry, or null when this is not a renderable todo snapshot.
 */
export function entryForTodoWrite(event) {
  if (event?.type !== 'todo/write') return null;
  const todos = Array.isArray(event?.data?.todos) ? event.data.todos : null;
  if (todos === null || todos.length === 0) return null;
  const items = todos
    .filter((todo) => todo !== null && typeof todo === 'object' && typeof todo.content === 'string' && typeof todo.status === 'string')
    .map((todo) => ({ content: todo.content, status: todo.status }));
  if (items.length === 0) return null;
  const id = `todo-${Number.isFinite(event.seq) ? event.seq : 'snapshot'}`;
  return {
    message: {
      id,
      role: 'assistant',
      content: [{ type: 'tool-call', id, name: 'todo_write', arguments: JSON.stringify({ todos: items }) }],
    },
    createdAt: Number.isFinite(event.time) ? new Date(event.time).toISOString() : new Date().toISOString(),
    promptClientId: null,
  };
}

/**
 * Build a reader over one DSH session.
 *
 * **Why there is a cache in here.** `sessionQuery.readSession()` reads and
 * replay-validates the *whole* log, and the fold then projects every event, so a
 * transcript read costs the same whether the controller asked for 1 row or 500 —
 * measured on the 17 MB conversation this Host was reported slow on: 216 ms warm,
 * 2.3 s while the session is live. The controller does not ask once either: its
 * "load earlier" page is 20 rows (`MESSAGE_FETCH_PAGE_SIZE`), so scrolling back
 * through a long conversation is a dozen reads, each one repaying that full cost —
 * which is exactly what the user reported as 加载更早消息，每次只加载一点点，会导致需要频繁加载.
 *
 * So one full read *seeds* a per-session cache of finished rows, and the live
 * `session/event` stream keeps it current (`noteEvent`). A page then costs O(page).
 *
 * The cache is only trusted while it is provably contiguous with the log: every
 * appended event carries a monotonic `seq`, so a gap, a reused seq (rewind/clear),
 * or an event arriving while the seed read was in flight all drop the entry and the
 * next read re-seeds from the log. A stale cache is therefore never served — the
 * worst case is one extra full read.
 *
 * @param options - the raw-log reader, an injectable clock, and the attachment store's
 *   image reader (absent on a profile that composes no attachment service, in which
 *   case images stay file chips).
 * @returns `(sessionId, { before, limit }) => Promise<CindyMessageRow[]>`, with
 *   `noteEvent`, `invalidate`, and `stats` hung off it.
 */
export function createMessageReader({
  readSessionLog,
  now = () => new Date(),
  readImageAttachment,
  maxInlineImageBytes,
  maxInlineImageTotalBytes,
  cacheSessions = TRANSCRIPT_CACHE_SESSIONS,
}) {
  if (typeof readSessionLog !== 'function') throw new Error('createMessageReader requires readSessionLog');
  /** `sessionId -> { rows, seq, at }`, in least-recently-used order. */
  const transcripts = new Map();
  /** Sessions whose seed read is in flight; an event during one invalidates the seed. */
  const seeding = new Set();
  /** Sessions that received an event while seeding: that seed cannot be trusted. */
  const dirty = new Set();
  let clock = 0;

  /** Fold one session's log into message entries, in log order. */
  async function entriesFor(sessionId) {
    const snapshot = await readSessionLog(sessionId);
    const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
    const entries = [];
    let lastSeq = null;
    for (const event of events) {
      if (event === null || typeof event !== 'object') continue;
      // Every event's seq counts, not only the ones that render: contiguity is a
      // property of the log, and a caller comparing against renders would read a
      // gap as "nothing happened here".
      if (Number.isFinite(event.seq)) lastSeq = event.seq;
      const todo = entryForTodoWrite(event);
      if (todo !== null) {
        entries.push(todo);
        continue;
      }
      if (!isAppendSurfaceEvent(event)) continue;
      let message;
      try {
        message = deriveEventMessage(event);
      } catch {
        // One unprojectable event must not cost the whole transcript; the same
        // rule the surface fold applies per node.
        continue;
      }
      if (message === null || message === undefined) continue;
      entries.push({
        message,
        createdAt: Number.isFinite(event.time) ? new Date(event.time).toISOString() : now().toISOString(),
        // Same reason as the live fold: the durable read has to identify a user
        // turn by the id the controller minted, or its optimistic copy survives.
        promptClientId: promptRpcIdOf(event),
      });
    }
    return { entries, lastSeq };
  }

  /** Drop the least recently used transcripts, keeping the window bounded. */
  function evict() {
    while (transcripts.size > Math.max(1, cacheSessions)) {
      const oldest = transcripts.keys().next();
      if (oldest.done === true) break;
      transcripts.delete(oldest.value);
    }
  }

  /** Note one transcript as most recently used. */
  function touch(sessionId, entry) {
    transcripts.delete(sessionId);
    entry.at = ++clock;
    transcripts.set(sessionId, entry);
    evict();
  }

  async function readMessages(sessionId, options = {}) {
    const all = await ensureTranscript(sessionId);
    const page = isNewestRequest(options)
      ? fitNewestPageBytes(pageRows(all, widenNewestPage(options)))
      : pageRows(all, options);
    // Hydrate **after** paging: only the rows actually being served pay for reading
    // image bytes, and nothing is materialized for a page nobody asked for.
    //
    // The pictures carry their own budget (`MAX_INLINE_IMAGE_TOTAL_BYTES`) instead of
    // sharing one with the rows: the row side is bounded here already
    // ({@link NEWEST_WINDOW_TEXT_BYTES} for the newest page, the controller's own
    // limit for a cursor page), so the two caps simply add up — text ≤ 256 KiB plus
    // pictures ≤ 1 MiB stays inside both the relay's 2 MiB frame ceiling and this
    // channel's 30 s deadline, and a text-heavy page never costs the user a picture.
    return hydrateImageAttachments(page, {
      readImage: readImageAttachment,
      maxBytes: maxInlineImageBytes,
      maxTotalBytes: maxInlineImageTotalBytes,
    });
  }

  /**
   * The cached (or freshly seeded) transcript rows for one session.
   * @param sessionId - the session.
   * @returns the whole transcript, newest first.
   */
  async function ensureTranscript(sessionId) {
    const entry = transcripts.get(sessionId);
    if (entry !== undefined) {
      touch(sessionId, entry);
      return entry.rows;
    }
    seeding.add(sessionId);
    let rows = [];
    let lastSeq = null;
    try {
      const read = await entriesFor(sessionId);
      rows = toCindyMessages(read.entries, { sessionId, now });
      lastSeq = read.lastSeq;
    } finally {
      seeding.delete(sessionId);
      const raced = dirty.delete(sessionId);
      // An event that arrived mid-read may or may not be inside the snapshot, and
      // there is no way to tell from here — so the seed is thrown away rather than
      // risking a transcript that is silently missing one row.
      if (raced !== true) touch(sessionId, { rows, seq: lastSeq, at: clock });
    }
    return transcripts.get(sessionId)?.rows ?? rows;
  }

  /**
   * How many rows one session's transcript holds, without materializing a page.
   *
   * The controller's `_count.messages` is this number, and it is asked for on the
   * same screen that asks for the first page — so this must not hydrate images
   * (the bytes would be read and thrown away) and must not fold the log twice.
   * @param sessionId - the session.
   * @returns the row count.
   */
  async function countRows(sessionId) {
    const rows = await ensureTranscript(sessionId);
    return rows.length;
  }

  /**
   * Fold one live session event into the cached transcript.
   *
   * Called for **every** appended event, watchers or not: the cache's whole value is
   * that it is complete without re-reading the log, and that only holds if nothing
   * was allowed to pass unobserved.
   * @param sessionId - the session the event belongs to.
   * @param event - the DSH session event.
   * @returns whether the cache was updated (false when there is nothing cached yet,
   *   or when the event proved the cache stale and it was dropped instead).
   */
  function noteEvent(sessionId, event) {
    if (typeof sessionId !== 'string' || sessionId === '') return false;
    const entry = transcripts.get(sessionId);
    if (entry === undefined) {
      if (seeding.has(sessionId)) dirty.add(sessionId);
      return false;
    }
    const seq = Number.isFinite(event?.seq) ? event.seq : null;
    const last = Number.isFinite(entry.seq) ? entry.seq : null;
    // A missing, repeated, or skipped seq means this cache and the log have parted
    // ways (a rewind, a clear, a session restored from elsewhere). Re-seeding is
    // cheap; serving a transcript with a hole is not.
    if (seq === null || last === null || seq <= last || seq !== last + 1) {
      transcripts.delete(sessionId);
      return false;
    }
    entry.seq = seq;
    entry.at = ++clock;
    // A live todo snapshot becomes the same `TodoWrite` row the durable read produces, so
    // the phone's plan card updates while the plan is being worked rather than only when
    // the transcript is re-read.
    const todoEntry = entryForTodoWrite(event);
    const rows = todoEntry === null
      ? foldSessionEvent(event, { sessionId, now })
      : toCindyMessageRows(todoEntry.message, { sessionId, createdAt: todoEntry.createdAt, now });
    // Newest first: this event is the newest thing in the log, so its rows are the
    // new head of the array, in block order.
    if (rows.length > 0) entry.rows = [...rows, ...entry.rows];
    return true;
  }

  /** Forget one session's cached transcript (a rename, a rewind, a settings change). */
  function invalidate(sessionId) {
    return transcripts.delete(sessionId);
  }

  /** What the cache is doing, for the status route. */
  function stats() {
    let rows = 0;
    for (const entry of transcripts.values()) rows += entry.rows.length;
    return { sessions: transcripts.size, rows, seeding: seeding.size };
  }

  readMessages.noteEvent = noteEvent;
  readMessages.invalidate = invalidate;
  readMessages.count = countRows;
  /**
   * The whole cached transcript, newest first.
   *
   * For a reader that has to *group* the transcript rather than page it
   * (`local-db:messages:view`), and therefore cannot go through the newest-page budget.
   * The array is the cache's own, so callers treat it as read-only.
   */
  readMessages.all = (sessionId) => ensureTranscript(sessionId);
  readMessages.stats = stats;
  return readMessages;
}

/**
 * Count the rows one session's transcript folds to.
 *
 * The controller only lights its "load earlier" entry point when it knows the
 * total and the total exceeds what it has loaded
 * (`hasOlderMessagesByServerCount`: an unknown total is deliberately treated
 * as "no"), and it reads that total from the session row's `_count.messages`.
 * This Host used to answer `_count: null`, so the entry point never lit up.
 *
 * It counts **rows**, not events, so it must fold the same way the transcript read
 * does or the two sides compare different units — which is why it borrows the
 * reader's fold (and its cache) instead of folding the log a second time.
 *
 * @param reader - a `createMessageReader` result.
 * @returns `(sessionId) => Promise<number>`.
 */
export function createMessageCounter({ reader } = {}) {
  if (typeof reader !== 'function') throw new Error('createMessageCounter requires a message reader');
  if (typeof reader.count !== 'function') throw new Error('createMessageCounter requires a reader built by createMessageReader');
  return (sessionId) => reader.count(sessionId);
}
