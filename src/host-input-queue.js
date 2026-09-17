/**
 * Track DSH's input queue and answer `maker:input:get-projection`.
 *
 * DSH publishes queue and job state as an `AsyncIterable` of control frames from
 * `sessionController.control()` — a baseline followed by replacements — so the
 * answer is a fold over that stream, not a query. This module keeps the latest
 * state per session.
 *
 * The controller's shape is `InputProjection`
 * (`apps/mobile/src/session/types.ts`), and its reader is defensive: an entry is
 * kept only when it carries `clientId`, `text`, `persistedContent`, `model`,
 * `workingDir`, `createOpts`, and `chatMessage.role === 'user'`
 * (`apps/mobile/src/session/inputProjection.ts`). Anything less is dropped, so a
 * partially-known queue degrades to a shorter queue rather than to a broken
 * composer — which is why this Host emits only entries it can fill honestly.
 */

/** The one agent kind this Host presents; the controller's union is closed. */
const DSH_AGENT_KIND = 'pi';
const DSH_MODEL = 'pi';
const DSH_EFFORT = 'default';
const DSH_PERMISSION_MODE = 'default';

/**
 * The session's working directory, from whichever row shape was handed in.
 *
 * The queue tracker is given a **source** row, whose field is `cwd`
 * (`dsh-session-source.js`), while the row the controller sees on the wire
 * calls the same value `workingDir` (`cindy-session-row.js`). Reading only one
 * name silently emptied every projection: `toQueuedRemoteMessage` dropped DSH's
 * real queue entries, and `queuedRowFromController` returned null, so the item a
 * controller had just sent was missing from its own `maker:input:enqueue`
 * answer. The composer therefore never settled — the draft stayed put and the
 * next send repeated the same text — and the queue panel showed nothing.
 * @param session - a session row in either shape.
 * @returns the working directory, or null when neither name carries one.
 */
function workingDirOf(session) {
  if (typeof session?.workingDir === 'string' && session.workingDir !== '') return session.workingDir;
  if (typeof session?.cwd === 'string' && session.cwd !== '') return session.cwd;
  return null;
}

/** Flatten a DSH queued message's content blocks into display text. */
function textOf(content) {
  const parts = [];
  for (const part of Array.isArray(content) ? content : []) {
    if (part === null || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
  }
  return parts.join('\n');
}

/**
 * Build the controller's queued-message row for one DSH queue entry.
 *
 * Every field below is read by the controller's validator, so an entry is only
 * emitted when the session supplies the working directory it needs.
 * @param item - a DSH `SessionQueuedItem`.
 * @param session - the owning session row (`{ id, title, workingDir }`).
 * @returns the row, or null when it cannot be filled honestly.
 */
export function toQueuedRemoteMessage(item, session) {
  const workingDir = workingDirOf(session);
  const id = item?.id === undefined || item?.id === null ? null : String(item.id);
  // `rpcId` is the identity the **controller** minted for this prompt, and it is
  // the field its own submission echo retires on. Reporting DSH's `MessageId`
  // instead made the optimistic row and the confirmed row look like two
  // different messages: the composer kept the draft, so the next thing the user
  // typed was appended to the unsent text, and both went out as one message.
  const clientId = typeof item?.rpcId === 'string' && item.rpcId !== '' ? item.rpcId : id;
  if (clientId === null || workingDir === null) return null;

  const content = Array.isArray(item?.message?.content) ? item.message.content : [];
  const text = textOf(content);
  const createOpts = {
    agentKind: DSH_AGENT_KIND,
    workingDir,
    model: DSH_MODEL,
    effort: DSH_EFFORT,
    permissionMode: DSH_PERMISSION_MODE,
    fastMode: false,
  };

  return {
    clientId,
    text,
    persistedContent: JSON.stringify(content),
    files: [],
    agentReferences: [],
    model: DSH_MODEL,
    effort: DSH_EFFORT,
    permissionMode: DSH_PERMISSION_MODE,
    workingDir,
    createOpts,
    // The controller's validator requires a user-role chat message.
    chatMessage: { role: 'user', clientId, content },
  };
}

/**
 * Build the controller's queued row for a message this Host just accepted.
 *
 * `maker:input:enqueue` hands the controller's own row in and expects the new
 * projection back with it present. DSH's queue frame arrives over the control
 * stream asynchronously, so the freshly accepted item is folded in here: the
 * `prompt` call already returned `accepted`, which is what makes showing it
 * accurate rather than optimistic guesswork.
 * @param input - the controller's clientId and text, plus the owning session.
 * @returns the row, or null when it cannot be filled.
 */
export function queuedRowFromController({ clientId, text, session }) {
  const workingDir = workingDirOf(session);
  if (typeof clientId !== 'string' || clientId === '' || workingDir === null) return null;
  const value = typeof text === 'string' ? text : '';
  const createOpts = {
    agentKind: DSH_AGENT_KIND,
    workingDir,
    model: DSH_MODEL,
    effort: DSH_EFFORT,
    permissionMode: DSH_PERMISSION_MODE,
    fastMode: false,
  };
  return {
    clientId,
    text: value,
    persistedContent: JSON.stringify([{ type: 'text', text: value }]),
    files: [],
    agentReferences: [],
    model: DSH_MODEL,
    effort: DSH_EFFORT,
    permissionMode: DSH_PERMISSION_MODE,
    workingDir,
    createOpts,
    chatMessage: { role: 'user', clientId, content: [{ type: 'text', text: value }] },
  };
}

/**
 * Fold the control stream into per-session queue state.
 * @returns the tracker the runtime feeds and the channel reads.
 */
export function createInputQueueTracker() {
  /** sessionId -> SessionQueuedItem[] */
  const queues = new Map();
  /** sessionId -> SessionJob[] */
  const jobs = new Map();
  /**
   * sessionId -> controller-owned queue UI state.
   *
   * The controller sends `set-expanded` / `set-edit-lock` / `set-interaction-lock`
   * as real invokes and then reads them back out of the projection, so this Host
   * is their source of truth: they are queue state, not renderer state. They live
   * in memory only, which is honest — a lock is held by a screen that is open now.
   */
  const ui = new Map();

  function uiFor(sessionId) {
    let state = ui.get(sessionId);
    if (state === undefined) {
      state = { expanded: false, editLocks: new Set(), interactionLocks: new Set() };
      ui.set(sessionId, state);
    }
    return state;
  }

  /**
   * The queued item a **controller** is addressing.
   *
   * The controller knows a queued row by the `clientId` it minted (which DSH
   * persists as the item's `rpcId`), while `updateQueue` is keyed on the durable
   * `MessageId`. They are different values — passing the controller's id
   * straight to the service looks up an item that does not exist, and matching
   * only on `id` here made every removal and promotion silently miss.
   */
  function itemOf(sessionId, controllerId) {
    const wanted = String(controllerId);
    return (queues.get(sessionId) ?? []).find((item) => {
      const id = item?.id === undefined || item?.id === null ? null : String(item.id);
      const rpcId = typeof item?.rpcId === 'string' && item.rpcId !== '' ? item.rpcId : id;
      return rpcId === wanted || id === wanted;
    });
  }

  /**
   * Apply a committed queue mutation to the fold.
   *
   * DSH's own `queue` frame follows the commit, but the controller is answered
   * from this fold **immediately**: answering with the pre-mutation queue would
   * show a row the user just deleted, and the composer would put it back.
   */
  function mirror(sessionId, controllerId, action) {
    const items = queues.get(sessionId);
    if (items === undefined) return;
    const target = itemOf(sessionId, controllerId);
    if (target === undefined) return;
    const id = String(target.id);
    if (action?.kind === 'remove') {
      const next = items.filter((item) => String(item?.id) !== id);
      if (next.length > 0) queues.set(sessionId, next);
      else queues.delete(sessionId);
      return;
    }
    if (action?.kind === 'steer') {
      queues.set(sessionId, items.map((item) => (String(item?.id) === id ? { ...item, placement: 'steering' } : item)));
      return;
    }
    if (action?.kind === 'edit') {
      queues.set(sessionId, items.map((item) => (String(item?.id) === id
        ? { ...item, message: { ...item.message, content: action.content } }
        : item)));
    }
  }

  /**
   * Upsert one prompt into the fold with a placement, preserving everything else.
   *
   * `mirror` can only re-place an item the fold already holds, and a *fresh* prompt is in
   * no frame we have seen yet: DSH splices it into the inbox a moment after `prompt()`
   * returns, so an authoritative read taken right then can legitimately come back empty —
   * measured, that is exactly how a promoted 插话 left the projection saying nothing about
   * the message the user was looking at ("we still lost it": 08:54:29 enqueued, 08:54:40
   * promoted, 08:55:22 durable, with `steeringQueueClientIds` empty the whole time).
   * Anything the controller is showing therefore has to be insertable by id.
   *
   * @param sessionId - the session.
   * @param item - `{ id, rpcId?, message? }` for the prompt.
   * @param placement - `'queued'` or `'steering'`.
   */
  function markItem(sessionId, item, placement) {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const id = item?.id === undefined || item?.id === null ? null : String(item.id);
    if (id === null) return;
    const items = queues.get(sessionId) ?? [];
    const others = items.filter((entry) => String(entry?.id) !== id);
    queues.set(sessionId, [...others, { ...item, id, placement }]);
  }

  /**
   * Record a prompt this Host has just accepted as a **steering** item.
   *
   * Without this the projection says nothing about the message the user just sent, so the
   * controller retires its own bubble and nothing replaces it — reported as
   * 「在我的手机端它直接转圈转圈然后就消失了」. The entry is stored under the controller's own
   * id and is removed by `retireQueuedItem` the moment the durable row lands.
   *
   * @param sessionId - the session the prompt went to.
   * @param item - `{ id, rpcId, message }` for the accepted prompt.
   */
  function markSteering(sessionId, item) {
    markItem(sessionId, item, 'steering');
  }

  /** Record a prompt this Host has just accepted as **queued** (a running turn holds it). */
  function markQueued(sessionId, item) {
    markItem(sessionId, item, 'queued');
  }

  /** Reorder one queued item, as `maker:input:move` asks. */
  function moveItem(sessionId, controllerId, targetIndex) {
    const items = queues.get(sessionId);
    if (items === undefined) return;
    const target = itemOf(sessionId, controllerId);
    if (target === undefined) return;
    const id = String(target.id);
    const from = items.findIndex((item) => String(item?.id) === id);
    if (from === -1) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    const to = Math.max(0, Math.min(Number.isInteger(targetIndex) ? targetIndex : from, next.length));
    next.splice(to, 0, moved);
    queues.set(sessionId, next);
  }

  /** Rebuild one session's queue state. */
  function setItems(sessionId, items) {
    if (Array.isArray(items) && items.length > 0) queues.set(sessionId, items);
    else queues.delete(sessionId);
  }

  /**
   * Apply one `SessionControlFrame`.
   *
   * `baseline` replaces everything (it is the stream's starting point);
   * `queue`/`jobs` replace one session's slice. `projection` frames carry model
   * projections, which this Host does not serve, and are ignored.
   */
  function apply(frame) {
    if (frame === null || typeof frame !== 'object') return;
    if (frame.type === 'baseline') {
      queues.clear();
      jobs.clear();
      for (const [sessionId, items] of Object.entries(frame.value?.queues ?? {})) {
        if (Array.isArray(items)) queues.set(sessionId, items);
      }
      for (const [sessionId, entries] of Object.entries(frame.value?.jobs ?? {})) {
        if (Array.isArray(entries)) jobs.set(sessionId, entries);
      }
      return;
    }
    if (frame.type === 'queue' && typeof frame.sessionId === 'string') {
      setItems(frame.sessionId, frame.items);
      return;
    }
    if (frame.type === 'jobs' && typeof frame.sessionId === 'string') {
      if (Array.isArray(frame.jobs) && frame.jobs.length > 0) jobs.set(frame.sessionId, frame.jobs);
      else jobs.delete(frame.sessionId);
    }
  }

  /** The queued entries DSH is holding for one session. */
  function queueFor(sessionId) {
    return queues.get(sessionId) ?? [];
  }

  /** The background jobs DSH is running for one session. */
  function jobsFor(sessionId) {
    return jobs.get(sessionId) ?? [];
  }

  /**
   * Build the controller's `InputProjection` for one session.
   *
   * Only the queue is projected. The error/recovery fields describe a turn that
   * failed inside the controller's own agent; DSH reports those as session
   * events instead, so claiming them here would be invention. They are emitted
   * as the controller's own empty values.
   * @param sessionId - the session to project.
   * @param session - the owning session row, for `workingDir`.
   * @param pending - a row to fold in as queued when DSH's own frame has not
   *   arrived yet (the just-accepted `enqueue`).
   * @returns the projection the controller normalizes.
   */
  function projectionFor(sessionId, session, pending = null, items = null) {
    // `items` lets a caller project a queue DSH actually reported, instead of the
    // fold — the two disagree exactly when the fold never heard a frame.
    const source = Array.isArray(items) ? items : queueFor(sessionId);
    const pendingQueue = [];
    const steeringQueueClientIds = [];
    const seen = new Set();
    for (const item of source) {
      const row = toQueuedRemoteMessage(item, session);
      if (row === null) continue;
      seen.add(row.clientId);
      if (item?.placement === 'steering') steeringQueueClientIds.push(row.clientId);
      else if (item?.placement === 'queued') pendingQueue.push(row);
    }
    if (pending !== null && !seen.has(pending.clientId)) pendingQueue.push(pending);

    const state = uiFor(sessionId);
    return {
      sessionId,
      pendingQueue,
      steeringQueueClientIds,
      queuePaused: false,
      queueExpanded: state.expanded,
      queueInteractionLocks: [...state.interactionLocks],
      queueEditLocks: [...state.editLocks],
      queueAbortPending: false,
      error: null,
      errorReason: null,
      toolLoop: null,
      recovery: null,
      errorRetryText: null,
      credentialSwitchWait: null,
      autoResumePending: null,
      continuationTurnClientId: null,
    };
  }

  function clear() {
    queues.clear();
    jobs.clear();
    ui.clear();
  }

  return {
    apply,
    queueFor,
    jobsFor,
    projectionFor,
    clear,
    /** Whether DSH is holding this item; decides steer-promotion vs a new send. */
    hasItem: (sessionId, itemId) => itemOf(sessionId, itemId) !== undefined,
    /**
     * The durable `MessageId` behind the controller's id.
     *
     * `updateQueue` is keyed on this, while the controller addresses a row by the
     * `clientId` it minted — so every mutation has to be translated or DSH looks
     * up an item that does not exist (and answers "queued item is no longer
     * pending", which reads like a race rather than a wrong id).
     */
    dshItemId: (sessionId, controllerId) => {
      const found = itemOf(sessionId, controllerId);
      return found === undefined ? null : String(found.id);
    },
    /** Fold a queue mutation this Host already committed to DSH. */
    mirror,
    moveItem,
    setExpanded: (sessionId, expanded) => { uiFor(sessionId).expanded = expanded === true; },
    setEditLock: (sessionId, clientId, locked) => {
      const locks = uiFor(sessionId).editLocks;
      if (locked === true) locks.add(String(clientId));
      else locks.delete(String(clientId));
    },
    setInteractionLock: (sessionId, lockId, locked) => {
      const locks = uiFor(sessionId).interactionLocks;
      if (locked === true) locks.add(String(lockId));
      else locks.delete(String(lockId));
    },
    /** Drop every queued item for one session, as `maker:input:clear-session` asks. */
    clearSession: (sessionId) => { setItems(sessionId, []); },
    /**
     * Replace one session's queue with items an authoritative read returned.
     *
     * This is how a durable id becomes known without waiting for a `queue` frame:
     * the read already carries it, so a cancel or edit issued moments later
     * resolves instead of reporting NOT_FOUND.
     */
    adopt: (sessionId, items) => { setItems(sessionId, items); },
    /** Record one just-accepted steering prompt, preserving the rest of the queue. */
    markSteering: (sessionId, item) => { markSteering(sessionId, item); },
    /** Record one just-accepted queued prompt, preserving the rest of the queue. */
    markQueued: (sessionId, item) => { markQueued(sessionId, item); },
    /** Every queued item id, newest fold first — used to clear a queue honestly. */
    itemIds: (sessionId) => (queues.get(sessionId) ?? []).map((item) => String(item?.id)),
  };
}

/**
 * Read the pending queue out of DSH's `inbox` projection value.
 *
 * A faithful port of the controller's own `queueItemsFromInbox`
 * (`dsh-api-session-controller/lib/index.js`), because this is the **only**
 * reliable source: the control stream pushes a `queue` frame when the inbox
 * changes, but that frame is not guaranteed to reach us, and a fold cannot tell
 * "the queue is empty" from "I never heard". Answering the controller from a
 * stale fold left a phantom 队列中 row — the message had been answered, and the
 * row describing it never went away.
 *
 * The value is `{ 'next-turn': Message[], 'next-step': Message[] }`, where each
 * message carries its own id and, for a browser-submitted prompt, an `rpcId` —
 * the controller's own id for it.
 *
 * @param inbox - the projection value, or anything else.
 * @returns the controller's queued rows, in DSH's own order.
 */
export function queueItemsFromInbox(inbox) {
  if (inbox === null || typeof inbox !== 'object') return [];
  const items = [];
  for (const message of Array.isArray(inbox['next-turn']) ? inbox['next-turn'] : []) {
    items.push(queueItemOf(message, 'queued'));
  }
  for (const message of Array.isArray(inbox['next-step']) ? inbox['next-step'] : []) {
    const placement = message?.source?.kind === 'user' ? 'steering' : 'context';
    items.push(queueItemOf(message, placement));
  }
  return items.filter((item) => item !== null);
}

/** One queued row, or null when the message cannot be addressed. */
function queueItemOf(message, placement) {
  const id = message?.id === undefined || message?.id === null ? null : String(message.id);
  if (id === null) return null;
  const source = message?.source;
  const rpcId = source?.kind === 'user' && typeof source.rpcId === 'string' && source.rpcId !== ''
    ? source.rpcId
    : undefined;
  return {
    id,
    placement,
    ...(rpcId === undefined ? {} : { rpcId }),
    message: { id, content: Array.isArray(message?.content) ? message.content : [] },
  };
}

/**
 * Read the goal projection value out of an `observeSession` snapshot.
 *
 * Same reasoning as the queue: the projection stream is a convenience that may
 * never speak, while this read is authoritative — a goal existed, the status
 * channel answered `null` for twenty seconds straight.
 * @param projections - a `ProjectionSnapshot`, or anything else.
 * @returns the goal projection value, or undefined when the snapshot has none.
 */
export function goalFromProjections(projections) {
  const values = projections?.values;
  if (values === null || typeof values !== 'object') return undefined;
  if (!Object.prototype.hasOwnProperty.call(values, 'goal')) return undefined;
  return values.goal ?? null;
}
