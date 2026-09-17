/**
 * The Cindy invoke channel router.
 *
 * This is the Host's half of the DeviceLink tunnel: the phone sends
 * `invoke { channel, args }` and gets one `invoke-result` back. The channel set
 * is a contract — `Cindy/packages/device-link/src/allowlist.ts` — and this Host
 * implements a deliberate subset of it (file-browser, the agent information
 * flow, approvals, todo, goal).
 *
 * Everything outside that subset answers `CHANNEL_NOT_ALLOWED`, which is exactly
 * what a Cindy controlled device answers for a channel it does not serve. That
 * is a feature of the protocol: the controller treats it as "this device has no
 * such capability" and degrades, rather than waiting for a reply that never
 * comes. A channel we silently accepted and then failed would be worse — the
 * phone would show a broken feature instead of an absent one.
 */
import { toCindyActiveSessions, toCindySessionList } from './cindy-session-row.js';
import { toAgentCapabilities } from './host-models.js';
import { queueItemsFromInbox } from './host-input-queue.js';
import { toAgentSkills, toAgentCommands, toAtResources } from './host-palette.js';
import { toGoalStatusPayload } from './host-goals.js';
import { hostAttachmentsOf } from './host-attachments.js';

/** The phone's own unsubscribe channel, paired with subscribe. */
const SUBSCRIBE = 'device-link:subscribe';
const UNSUBSCRIBE = 'device-link:unsubscribe';

/** Topic carrying list-level changes; one of only two this Host serves. */
export const TOPIC_SESSIONS = 'sessions';
/** Topic carrying one session's live stream. */
export const TOPIC_SESSION_PREFIX = 'session:';

/**
 * The controller's goal write commands.
 *
 * The status read is deliberately not here: it is answered from the projection
 * stream and must never resume a session.
 */
export const GOAL_WRITE_CHANNELS = new Set([
  'maker:goal:set',
  'maker:goal:update',
  'maker:goal:pause',
  'maker:goal:resume',
  'maker:goal:clear',
]);

/**
 * The controller's pending-queue commands.
 *
 * These are what the queue panel's buttons send — 插话 (promote), 取消 (remove),
 * 编辑 (update), 停止 (stop). Without them the controller shows
 * `CHANNEL_NOT_ALLOWED` and the user cannot clear a stuck queue, which blocks
 * sending anything at all.
 */
export const QUEUE_COMMAND_CHANNELS = new Set([
  'maker:input:update-text',
  'maker:input:update-content',
  'maker:input:remove',
  'maker:input:stop',
  'maker:input:clear-session',
  'maker:input:set-expanded',
  'maker:input:set-edit-lock',
  'maker:input:set-interaction-lock',
  'maker:input:resume',
]);

/** The controller's current `InputProjection` for one session. */
function projectionNow(capabilities, sessionId) {
  const project = capabilities.inputProjection;
  return typeof project === 'function'
    ? project(sessionId, null)
    : { sessionId, pendingQueue: [], steeringQueueClientIds: [] };
}

/**
 * Answer a queue command, and tell the session's other watchers.
 *
 * The reply settles the controller that asked. A second screen watching the same
 * session has no reason to ask again, so without this push it keeps rendering a
 * row the user just deleted — the same shape of staleness the queue fold already
 * caused once.
 * @param request - the invoke being answered.
 * @param capabilities - the per-request capabilities.
 * @param sessionId - the session whose queue changed.
 * @returns the reply frame.
 */
function answerQueueCommand(request, capabilities, sessionId) {
  const push = capabilities?.pushInputProjection;
  if (typeof push === 'function') push(sessionId);
  return invokeResult(request, projectionNow(capabilities, sessionId));
}

/**
 * When one controller-facing entry happened, for ordering.
 *
 * Three shapes reach this: a view `work` item (which spans a range, so it is placed by its end),
 * a view `messages` item (placed by its last message), and a raw transcript row (its own
 * `createdAt`).
 * @param entry - a view item or a transcript row.
 * @returns epoch ms, or 0 when the shape carries no time.
 */
export function occurredAtMs(entry) {
  if (entry?.type === 'work') return Number(entry.summary?.endedAtMs) || 0;
  if (Array.isArray(entry?.messages)) {
    const last = entry.messages[entry.messages.length - 1];
    return Date.parse(last?.createdAt ?? '') || 0;
  }
  return Date.parse(entry?.createdAt ?? '') || 0;
}

/**
 * Place accepted-but-not-durable prompts **where the user typed them**, not at the end.
 *
 * The reported symptom: 「插入之后顺序会变，它会插入到我前面说的两行话前面」. Two of the user's
 * messages were queued for the next turn (10:45:11, 10:45:24) and a third was **inserted** — a
 * steer, which jumps the queue and became durable at 10:46:11, before either of them. So the
 * transcript order is genuinely insert-first, and this Host was making it worse: pending rows were
 * appended after the whole page, which put two rows the user typed *earlier* visually below a row
 * they typed later.
 *
 * Ordering them by acceptance time restores the user's own order while they wait. It is a
 * **prediction**, and the prediction is not always right: a queued message is delivered at the
 * next turn boundary, so it may still end up after the insert that overtook it — the rows move
 * once, when they become durable. Delivery order is the transcript's; typing order is what the
 * user is looking at while nothing has been delivered yet.
 *
 * **The streaming work item is pinned last.** 「你一直在我的对话之上在工作…最好是我发完对话之后
 * 无论如何你都把正在工作这个信息调到最后」 — a running group is the present tense, so it belongs
 * under everything the user has said, including a message still queued for the next turn (which
 * sorts after the group's own rows by time). Without the pin, a prompt accepted a moment ago lands
 * below the running card and the user's own words look pushed up into the middle of their
 * conversation.
 *
 * @param items - the page's own entries, already in the page's order.
 * @param pending - the pending entries, oldest acceptance first.
 * @param options - `newestFirst` for a descending page (`local-db:messages:list`).
 * @returns the merged sequence.
 */
export function mergePendingByTime(items, pending, { newestFirst = false } = {}) {
  const merged = [...items];
  const last = merged[merged.length - 1];
  const runsNow = !newestFirst && last?.type === 'work' && last.summary?.isStreaming === true;
  for (const entry of pending) {
    const at = occurredAtMs(entry);
    const index = newestFirst
      ? merged.findIndex((candidate) => occurredAtMs(candidate) < at)
      : merged.findIndex((candidate) => occurredAtMs(candidate) > at);
    if (index === -1) merged.push(entry);
    else merged.splice(index, 0, entry);
  }
  if (!runsNow) return merged;
  // Whatever sorted after the running group goes above it: the running card is the last thing shown.
  const runningAt = merged.indexOf(last);
  const running = merged.splice(runningAt, 1)[0];
  return [...merged, running];
}

/**
 * Commit one queue mutation to DSH.
 *
 * `control.update` is **async** — it resolves the session's agent before asking DSH to change
 * the inbox — so it reports a refusal by *rejecting*, not by throwing. A `try`/`catch` around
 * a call that is not awaited therefore catches nothing and the rejection floats: measured, it
 * reached DSH's fail-loud unhandled-rejection handler and ended the whole `dsh web` process
 * (`fatal load failure: RemoteError: queued item is no longer pending`, thrown from
 * `SessionCommandController.updateQueue`) while an acceptance probe edited a queue whose item
 * DSH had already admitted. The same bug also reported every refused mutation as a success,
 * because `null` (the "no failure" answer) was returned unconditionally.
 *
 * @returns null on success, or `{ code, message }` to report.
 */
async function commitQueueAction(control, sessionId, itemId, action) {
  try {
    await control.update({ sessionId, itemId, action });
    return null;
  } catch (error) {
    // DSH's own code travels: `session/steer-unavailable` and
    // `session/queue-item-not-found` describe the refusal precisely, and a
    // generic THREW would hide the difference between "there is no such item"
    // and "there is no turn to steer into".
    const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'THREW';
    return { code, message: String(error?.message ?? error) };
  }
}

/**
 * Commit one queue mutation and keep the controller's view honest either way.
 *
 * On **failure** the projection is still pushed. The controller promotes the row
 * optimistically before asking, so a refusal it only learns about from the error
 * leaves it showing a queued item as if it had been taken — and, for a steer,
 * spinning on a turn that never started. The push is what tells it otherwise.
 * @returns null on success, or `{ code, message }` to report.
 */
async function commitQueueActionAndReconcile(capabilities, sessionId, itemId, action) {
  const failure = await commitQueueAction(capabilities.queueControl, sessionId, itemId, action);
  if (failure !== null) {
    const push = capabilities?.pushInputProjection;
    if (typeof push === 'function') push(sessionId);
  }
  return failure;
}

/** How long to wait for DSH's `MessageId` before answering NOT_FOUND. */
const QUEUE_ITEM_ID_WAIT_MS = 1500;
const QUEUE_ITEM_ID_POLL_MS = 50;

/**
 * The durable id behind the controller's item id, waiting briefly if needed.
 *
 * `maker:input:enqueue` is answered from a row this Host synthesises, because
 * DSH's own `queue` frame trails the commit. For that moment the item is
 * addressable by the controller — it can see the row and press 取消 on it — but
 * its durable `MessageId` is not yet known, and `updateQueue` is keyed on that id.
 * Answering NOT_FOUND straight away made 取消 and 编辑 fail on a message the user
 * had just sent, which reads as "the button is broken" rather than "try again in
 * a moment". The frame is only milliseconds behind, so this waits for it.
 *
 * The wait is bounded and every iteration re-reads the fold, so a genuinely
 * absent item still fails fast enough to keep the button responsive.
 *
 * @param capabilities - the per-request capabilities.
 * @param sessionId - the session owning the item.
 * @param controllerId - the `clientId` the controller addressed it by.
 * @param waitMs - the bound, injectable so tests do not sleep.
 * @returns the DSH `MessageId`, or null if it never appeared.
 */
export async function resolveDshItemId(capabilities, sessionId, controllerId, waitMs = QUEUE_ITEM_ID_WAIT_MS) {
  const mirror = capabilities?.queueMirror;
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const folded = typeof mirror?.dshItemId === 'function' ? mirror.dshItemId(sessionId, controllerId) : null;
    if (folded !== null && folded !== undefined) return folded;
    // The fold learns items only from pushed `queue` frames, and those are not
    // guaranteed to arrive — so a fold-only answer reported NOT_FOUND for an item
    // the Host itself had just accepted. The session's inbox is the authority.
    const read = capabilities?.readSessionState;
    if (typeof read === 'function') {
      let state = null;
      try {
        state = await read(sessionId);
      } catch {
        state = null;
      }
      if (state !== null && state !== undefined) {
        const wanted = String(controllerId);
        const found = queueItemsFromInbox(state.inbox)
          .find((entry) => entry.rpcId === wanted || entry.id === wanted);
        if (found !== undefined) return found.id;
      }
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => { setTimeout(resolve, QUEUE_ITEM_ID_POLL_MS); });
  }
}

/**
 * Split the topics a controller asked for into the ones this Host serves.
 *
 * `session:<id>` used to be dropped here, which silently denied every live
 * per-session push: the subscription succeeded, the reply looked right, and no
 * stream ever arrived.
 * @param value - the raw `topics` argument.
 * @returns the accepted topics.
 */
export function acceptTopics(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((topic) => typeof topic === 'string'
    && (topic === TOPIC_SESSIONS || (topic.startsWith(TOPIC_SESSION_PREFIX) && topic.length > TOPIC_SESSION_PREFIX.length)));
}

/** Channels this round implements; everything else is refused by omission. */
export const SUPPORTED_CHANNELS = Object.freeze([
  SUBSCRIBE,
  UNSUBSCRIBE,
  'local-db:sessions:list',
  'local-db:sessions:get',
  'local-db:messages:list',
  'local-db:sessions:patch-meta',
  'maker:create-session',
  'maker:send',
  'maker:input:enqueue',
  'maker:input:steer',
  'maker:list-active',
  'maker:session-in-turn',
  'maker:git-safety:get',
  'maker:goal:get-status',
  ...GOAL_WRITE_CHANNELS,
  ...QUEUE_COMMAND_CHANNELS,
  'maker:input:move',
  'maker:set-model',
  'maker:set-effort',
  'fs:list-dir',
  'fs:stat-path',
  'text-file:read-preview',
  'maker:get-pending-interactions',
  'maker:regenerate-title',
  'maker:get-context-usage',
  'maker:resolve-interaction',
  'maker:input:get-projection',
  'maker:list-available-agents',
  'maker:get-capabilities',
  'maker:list-agent-skills',
  'maker:list-agent-commands',
  'maker:set-plan-mode',
  'file-browser:remote-op',
  'device-link:media:fetch',
  // The work-grouped history window. Gated on the controller's side by the
  // `history-view-v1` capability this Host advertises in `link-accept`
  // (`host-authorization.js`), so serving them is only half of turning them on.
  'local-db:messages:view',
  'local-db:messages:work-details',
  'local-db:messages:view-intent',
  'maker:set-permission-mode',
  'maker:list-desktop-commands',
  'maker:scan-at-resources',
]);

/**
 * The one harness this Host offers.
 *
 * DSH's own agent drives every session, so there is nothing to choose and
 * nothing to keep book straight: the roster names a single kind, the phone's
 * picker shows a single entry, and every session row reports the same value.
 * The kind is `pi` because the controller's `MobileAgentKind` is a closed union
 * and only a kind it knows can be labelled.
 */
export const DSH_AGENT_KINDS = Object.freeze(['pi']);

/** The kind stamped on session rows; the only member of {@link DSH_AGENT_KINDS}. */
export const DSH_AGENT_KIND = 'pi';

/**
 * What this Host can do for `pi`.
 *
 * The phone asks for capabilities once per agent kind whenever it opens a
 * device, and a refused answer leaves it without the shape it validates
 * against. The lists are empty because this Host exposes no model catalog yet —
 * that is a missing feature, not a broken one, and it must not cost the session
 * list.
 */
export const DSH_AGENT_CAPABILITIES = Object.freeze({
  availableModels: [],
  effortLevels: [],
  permissionModes: [],
  hasFastMode: false,
  planModeSupported: false,
  supportsSessionAgentSwitch: false,
  supportsModelWindowSwitchGuard: false,
});

/** A relay result frame. `dst` is the requesting device, as the relay filled it. */
export function invokeResult(request, result) {
  return { v: 1, kind: 'invoke-result', id: request.id, dst: request.src, payload: { ok: true, result } };
}

/** A refusal the controller knows how to read. */
export function invokeError(request, code = 'CHANNEL_NOT_ALLOWED', message = 'Channel is not available on DSH Host') {
  return { v: 1, kind: 'invoke-result', id: request.id, dst: request.src, payload: { ok: false, error: { code, message } } };
}

/**
 * The refusal codes a seam may name for an ordinary refusal.
 *
 * A seam knows *why* something it was asked for cannot be done — a model that offers
 * no such effort, a path outside the workspace — and the controller reads those codes
 * to choose its fallback. Without this, every one of them arrived as `THREW`, which
 * the controller (rightly) treats as the Host crashing: the acceptance run reported
 * `maker:set-effort restores effort — THREW: provider "openai-codex" model
 * "gpt-5.6-sol" does not support reasoning effort "default"` for a request the Host
 * had *correctly* declined.
 */
export const REFUSAL_CODES = new Set(['BAD_REQUEST', 'NOT_AVAILABLE', 'NOT_FOUND', 'FORBIDDEN', 'OVERSIZE', 'CHANNEL_NOT_ALLOWED', 'PAYLOAD_TOO_LARGE', 'INTERNAL']);

/**
 * An error that carries the refusal the controller should read.
 * @param code - one of {@link REFUSAL_CODES}.
 * @param message - what the controller shows or logs.
 * @returns the error to throw from a seam.
 */
export function refusalError(code, message) {
  const error = new Error(message);
  error.refusalCode = REFUSAL_CODES.has(code) ? code : 'INTERNAL';
  return error;
}

/**
 * The code to answer an error with: the refusal it names, or `THREW` for a genuine
 * failure, which is the difference the controller's error handling keys on.
 * @param error - whatever a seam threw.
 * @returns a refusal code.
 */
export function refusalCodeOf(error) {
  return typeof error?.refusalCode === 'string' ? error.refusalCode : 'THREW';
}

/**
 * Pull the prompt text out of a send argument.
 *
 * The two send paths carry different shapes:
 *  - `maker:send` sends a bare string or `{ type: 'user', content }`, where
 *    `content` is the controller's persisted message — an object carrying
 *    `text`, or a plain string on older paths;
 *  - `maker:input:enqueue` / `:steer` send the controller's own
 *    `QueuedRemoteMessage`, whose `text` is top level.
 *
 * Anything else yields nothing, and the caller refuses rather than sending an
 * empty prompt.
 * @param message - the raw argument.
 * @returns the text to send, or null when there is none.
 */
export function extractSendText(message) {
  if (typeof message === 'string') return message.trim() === '' ? null : message;
  if (message === null || typeof message !== 'object') return null;
  // The queued-message shape, which is the composer's normal path.
  if (typeof message.text === 'string') return message.text.trim() === '' ? null : message.text;
  const content = message.content;
  if (typeof content === 'string') return content.trim() === '' ? null : content;
  if (content !== null && typeof content === 'object' && typeof content.text === 'string') {
    return content.text.trim() === '' ? null : content.text;
  }
  return null;
}

/**
 * The attachments this Host can actually serve, out of the ones the controller sent.
 *
 * Both forms are serveable: an absolute path on this machine, and an upload transit
 * reference (`cindy-oss-attach://…`, or the legacy `xdt-oss-attach://…` the phones
 * build) whose bytes this Host fetches with its own account credential. A reference is
 * fetched, never handed to a filesystem as if it were a path; anything else with a
 * scheme is left behind, and the send paths log what they carried.
 * @param message - the controller's send argument.
 * @returns the serveable attachments.
 */
export function extractSendAttachments(message) {
  return hostAttachmentsOf(message);
}


/**
 * Build the router.
 * @param options - the DSH read capabilities, the per-connection subscriber set,
 *   and a reader for this Host's own relay identity.
 * @returns a function turning one invoke request into one result frame.
 */
export function createChannelRouter({
  listSessions,
  listSessionStates,
  readMessages,
  createSession,
  sendMessage,
  resolveCapabilities,
  subscribers,
  onSubscribe,
  onUnsubscribe,
  now = () => new Date(),
  getDevice,
}) {
  /**
   * Turn states for the two polled channels, without paying for a row fold.
   *
   * A router built without the cheap read (tests, and any caller that only has the full
   * listing) falls back to it rather than failing: the difference is cost, not answer.
   */
  const listStates = typeof listSessionStates === 'function' ? listSessionStates : listSessions;
  /**
   * Resolve the Host's write/read capabilities *per request*.
   *
   * They arrive from another plugin and can land after this router is built, so
   * capturing them at construction would freeze an empty set — which shows up as
   * `NOT_AVAILABLE` on a Host that is in fact perfectly able to serve the call.
   */
  const capabilitiesNow = typeof resolveCapabilities === 'function'
    ? resolveCapabilities
    : () => ({ readMessages, createSession, sendMessage });

  /**
   * The model every session falls back to, as of the last capability read.
   *
   * The controller asks for capabilities when it opens a device and again when a
   * provider revision changes, so this is warm by the time it lists sessions —
   * without the list call itself paying for a catalog read.
   */
  let catalogDefaultModel = null;

  /** This Host's relay identity, as the phone's device filter needs it. */
  function deviceIdentity() {
    if (typeof getDevice !== 'function') return undefined;
    try {
      return getDevice();
    } catch {
      return undefined;
    }
  }

  /**
   * Read the session rows the phone renders.
   *
   * `local-db:sessions:list` is also the phone's device-responsiveness probe, so
   * it has to stay a single cheap read — which is why the row is folded from the
   * source's one listing rather than from a per-session fetch.
   */
  async function sessionRows() {
    const items = await listSessions();
    // `local-db:sessions:list` is the controller's responsiveness probe, so this
    // must not await a catalog read. The default is only a fallback for rows
    // whose own selection is unknown, and the last read is good enough for it.
    return toCindySessionList(items, { now, device: deviceIdentity(), defaultModel: catalogDefaultModel });
  }

  return async function handleInvoke(request) {
    // A reply is addressed by `id` + `src`; without both there is nothing the
    // relay could route, so this answers nothing rather than fabricating a frame.
    if (request === null || typeof request !== 'object') return null;
    if (typeof request.id !== 'string' || typeof request.src !== 'string') return null;

    const channel = request?.payload?.channel;
    const args = Array.isArray(request?.payload?.args) ? request.payload.args : [];

    if (channel === SUBSCRIBE) {
      const topics = acceptTopics(args?.[0]?.topics);
      // A controller that subscribes is a controller that wants pushes; the
      // subscription set is per-connection and cleared with the socket.
      if (request.src && typeof onSubscribe === 'function') onSubscribe(request.src, topics);
      else if (request.src) subscribers.add(request.src);
      // A controller that has just attached knows nothing about the turn state,
      // and its spinner clears only on an explicit terminal event — a session
      // merely absent from `maker:list-active` is deliberately not read as idle.
      // So the state is announced rather than left to be inferred from silence:
      // without this, a refused steer or a failed prompt left the phone spinning
      // with nothing on the Host to correct it.
      //
      // The answer is read from the **source**, not from the runtime's row cache:
      // that cache is refreshed by list reads, so a controller attaching
      // mid-session can be looking at a `running: true` captured before the turn
      // that ended it. Announce only what the source says now, and fall back to
      // the cache only when the source cannot be read at all.
      const subscribing = capabilitiesNow();
      if (typeof subscribing.isSessionRunning === 'function'
        && typeof subscribing.pushTurnIdle === 'function'
        && typeof subscribing.pushTurnRunning === 'function') {
        let live = null;
        try {
          const rows = await listSessions();
          live = Array.isArray(rows) ? rows : null;
        } catch {
          // No corpus read available: the cached answer is the best there is.
          live = null;
        }
        for (const topic of topics) {
          if (!topic.startsWith(TOPIC_SESSION_PREFIX)) continue;
          const sessionId = topic.slice(TOPIC_SESSION_PREFIX.length);
          const row = live === null ? null : live.find((candidate) => String(candidate?.id) === sessionId) ?? null;
          const running = row === null ? subscribing.isSessionRunning(sessionId) === true : row.running === true;
          if (running) subscribing.pushTurnRunning(sessionId);
          else subscribing.pushTurnIdle(sessionId);
        }
      }
      return invokeResult(request, { subscribed: topics });
    }

    if (channel === UNSUBSCRIBE) {
      const topics = acceptTopics(args?.[0]?.topics);
      if (request.src && typeof onUnsubscribe === 'function') onUnsubscribe(request.src, topics);
      else if (request.src) subscribers.delete(request.src);
      return invokeResult(request, { unsubscribed: topics });
    }

    if (channel === 'local-db:sessions:list') {
      return invokeResult(request, await sessionRows());
    }

    if (channel === 'local-db:sessions:get') {
      const sessionId = String(args[0] ?? '');
      const rows = await sessionRows();
      // Same flat row as the list: the controller stores whatever it is handed,
      // so a second shape here would be a second source of silent emptiness.
      const row = rows.find((candidate) => candidate.id === sessionId);
      // Cindy answers an unknown id with an error the controller already handles.
      if (row === undefined) return invokeError(request, 'NOT_FOUND', `No DSH session ${sessionId}`);
      // The row's message total is what lets the controller light its "load
      // earlier" entry point at all: `hasOlderMessagesByServerCount` answers
      // false for an unknown total, deliberately, so that an entry point which
      // leads nowhere is never shown. Answered only here, not in the list: the
      // controller polls the list, and folding every transcript per poll would
      // trade a paging bug for a latency one.
      const count = capabilitiesNow().countMessages;
      if (typeof count === 'function') {
        try {
          const total = await count(sessionId);
          if (Number.isFinite(total)) row._count = { messages: total };
        } catch {
          // An unreadable transcript leaves `_count` as the honest null it was.
        }
      }
      return invokeResult(request, row);
    }

    if (channel === 'local-db:messages:list') {
      const sessionId = String(args[0] ?? '');
      const read = capabilitiesNow().readMessages;
      if (typeof read !== 'function') return invokeError(request, 'NOT_AVAILABLE', 'This DSH Host cannot read message history yet');
      const options = args[1] !== null && typeof args[1] === 'object' ? args[1] : {};
      const rows = await read(sessionId, options);
      // The newest window also carries what this Host has **accepted but not yet made
      // durable** — the prompt waiting in DSH's inbox. Only on the newest page: a cursor
      // names a durable row, and inventing rows behind a cursor would corrupt paging.
      const before = typeof options?.before === 'string' && options.before !== '' ? options.before : null;
      const pending = before === null ? (capabilitiesNow().queueMirror?.pendingRows?.(sessionId) ?? []) : [];
      // Newest first, and the pending prompts are the newest thing that exists.
      return invokeResult(request, pending.length === 0 ? rows : mergePendingByTime(rows, pending, { newestFirst: true }));
    }

    if (channel === 'maker:list-active') {
      // Its own shape: `[{ sessionId, isTurnRunning }]`. Answering with session
      // rows makes the controller skip every entry, which surfaces only as a
      // running badge that never lights up.
      //
      // An archived or deleted session is left out: the controller does not show its
      // row, so an entry for it would light the device's running badge from a session
      // the user cannot open.
      //
      // The **cheap** read on purpose. This is the most frequently polled channel on
      // this Host and it needs one boolean per session, so it must not pay for titles:
      // measured 8.4s through the full row fold on a 219-session profile, against a
      // handset that gives up at 15s.
      const rows = await listStates();
      const hidden = capabilitiesNow().sessionHidden;
      const visible = typeof hidden === 'function' ? rows.filter((row) => hidden(row.id) !== true) : rows;
      return invokeResult(request, toCindyActiveSessions(visible));
    }

    if (channel === 'maker:session-in-turn') {
      // The controller's **stall watchdog** — "controlling side uses this when a
      // Generating state seems stuck and no push has arrived: verify the host is
      // really still running; only `false` is safe to finish on, never kill a slow
      // turn that is genuinely working" (`isSessionTurnRunningFor` in the desktop
      // renderer). It answers a bare boolean.
      //
      // Read from the **source**, not from the runtime's cached row: a missed push is
      // exactly the condition being probed, and the cache is fed by those same
      // pushes. This is the read the subscribe path already trusts, and the cache is
      // only the fallback for when the source cannot be read at all.
      const sessionId = String(args[0] ?? '');
      if (sessionId === '') return invokeError(request, 'BAD_REQUEST', 'maker:session-in-turn needs a session id');
      let running = null;
      try {
        const rows = await listStates();
        const row = Array.isArray(rows) ? rows.find((candidate) => String(candidate?.id) === sessionId) ?? null : null;
        running = row === null ? null : row.running === true;
      } catch {
        running = null;
      }
      if (running === null) running = capabilitiesNow().isSessionRunning?.(sessionId) === true;
      return invokeResult(request, running === true);
    }

    // The agent roster. This Host offers one harness, so the roster, the picker,
    // and every session row all say the same thing.
    if (channel === 'maker:list-available-agents') {
      return invokeResult(request, [...DSH_AGENT_KINDS]);
    }

    if (channel === 'maker:get-capabilities') {
      const requested = typeof args[0] === 'string' ? args[0] : null;
      if (requested !== null && requested !== DSH_AGENT_KIND) {
        return invokeError(request, 'NOT_AVAILABLE', `DSH Host does not offer the ${requested} harness`);
      }
      // The catalog is a live read, not a constant: it is what the picker lists,
      // and answering from a frozen copy would keep offering models that this
      // Host can no longer route to.
      const readCatalog = capabilitiesNow().modelCatalog;
      if (typeof readCatalog !== 'function') return invokeResult(request, DSH_AGENT_CAPABILITIES);
      let catalog;
      try {
        catalog = await readCatalog();
      } catch (error) {
        // A failed catalog read costs the picker, never the session list.
        return invokeResult(request, DSH_AGENT_CAPABILITIES);
      }
      const defaultModel = catalog?.default?.model;
      catalogDefaultModel = typeof defaultModel === 'string' && defaultModel !== '' ? defaultModel : null;
      const capabilities = toAgentCapabilities(catalog);
      // These two fields are what make the controls appear at all: the controller
      // draws the permission picker only when presets are advertised, and the
      // plan-mode switch only when support is — and DSH documents a missing
      // `permissions` projection as "clients hide the control".
      const controls = capabilitiesNow().sessionControls;
      if (typeof controls?.permissionNames === 'function') {
        try {
          capabilities.permissionModes = controls.permissionNames()
            .filter((name) => typeof name === 'string' && name !== '')
            .map((name) => ({ id: name, displayName: name }));
        } catch {
          capabilities.permissionModes = [];
        }
      }
      if (typeof controls?.planModeSupported === 'function') {
        try {
          const supported = await controls.planModeSupported();
          capabilities.planMode = { supported: supported === true };
        } catch {
          capabilities.planMode = { supported: false };
        }
      }
      return invokeResult(request, capabilities);
    }

    if (channel === 'maker:set-plan-mode') {
      const controls = capabilitiesNow().sessionControls;
      if (typeof controls?.setPlanMode !== 'function') return invokeError(request, 'NOT_AVAILABLE', 'This DSH Host composes no plan mode');
      const sessionId = String(args[0] ?? '');
      if (sessionId === '') return invokeError(request, 'BAD_REQUEST', 'maker:set-plan-mode needs a session id');
      try {
        const outcome = await controls.setPlanMode({ sessionId, enabled: args[1] === true });
        // `queued` means the switch lands at the next step rather than now. The
        // controller treats a resolved call as applied, so the outcome travels
        // as the answer instead of being flattened into a bare success. A seam
        // that can only report "the switch was accepted" says exactly that.
        if (outcome !== null && typeof outcome === 'object') {
          return invokeResult(request, {
            outcome: typeof outcome.outcome === 'string' ? outcome.outcome : 'accepted',
            ...(typeof outcome.message === 'string' ? { message: outcome.message } : {}),
          });
        }
        return invokeResult(request, { outcome: typeof outcome === 'string' ? outcome : 'committed' });
      } catch (error) {
        return invokeError(request, refusalCodeOf(error), String(error?.message ?? error));
      }
    }

    if (channel === 'maker:set-permission-mode') {
      const controls = capabilitiesNow().sessionControls;
      if (typeof controls?.setPermissionMode !== 'function') return invokeError(request, 'NOT_AVAILABLE', 'This DSH Host composes no permission presets');
      const sessionId = String(args[0] ?? '');
      const mode = typeof args[1] === 'string' ? args[1] : '';
      if (sessionId === '' || mode === '') return invokeError(request, 'BAD_REQUEST', 'maker:set-permission-mode needs a session and a mode');
      try {
        await controls.setPermissionMode({ sessionId, mode });
        // The preset writes the session's knobs, so the row the controller holds
        // is now stale; a fresh read is pushed for the same reason a queue
        // command pushes one.
        const push = capabilitiesNow().pushInputProjection;
        if (typeof push === 'function') push(sessionId);
        return invokeResult(request, true);
      } catch (error) {
        return invokeError(request, refusalCodeOf(error), String(error?.message ?? error));
      }
    }

    if (channel === 'maker:set-model') {
      const select = capabilitiesNow().selectModel;
      if (typeof select !== 'function') return invokeError(request, 'NOT_AVAILABLE', 'This DSH Host cannot change the model');
      const sessionId = String(args[0] ?? '');
      const model = typeof args[1] === 'string' ? args[1] : '';
      if (sessionId === '' || model === '') return invokeError(request, 'BAD_REQUEST', 'maker:set-model needs a session and a model');
      // The controller sends `[sessionId, model, providerId?]`, and a richer
      // `[…, providerId, null, selection]` form when it has a full selection.
      const selection = args[4] !== null && typeof args[4] === 'object' ? args[4] : null;
      const provider = typeof args[2] === 'string' && args[2] !== ''
        ? args[2]
        : (typeof selection?.provider === 'string' && selection.provider !== '' ? selection.provider : null);
      const effort = typeof selection?.reasoningEffort === 'string' && selection.reasoningEffort !== ''
        ? selection.reasoningEffort
        : (typeof args[3] === 'string' && args[3] !== '' ? args[3] : undefined);
      // A provider is passed through when the controller has one, but it is not
      // required: `MobileModelOption` carries no provider id, so the Host
      // resolves it from its own catalog rather than refusing the choice.
      try {
        const selected = await select({
          sessionId,
          provider: provider ?? undefined,
          model,
          reasoningEffort: effort,
        });
        // The controller applies this to the row it is showing. A second screen
        // watching the same session learns the change from its next list read:
        // the row-level channel that would push it belongs to the `sessions`
        // topic, which a controller viewing one session does not hold.
        return invokeResult(request, {
          selected: selected?.selected ?? { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) },
        });
      } catch (error) {
        return invokeError(request, refusalCodeOf(error), String(error?.message ?? error));
      }
    }

    // `maker:provider:list` is deliberately NOT served, and that is the whole
    // point: the controller only falls back to `capabilities.availableModels`
    // when that channel is explicitly unsupported
    // (`canUseFlatModelFallback` requires `providersUnsupported === true`, which
    // only `CHANNEL_NOT_ALLOWED` sets). Answering `{ providers: [] }` claims a
    // provider catalog that is merely empty, so the picker renders "no models"
    // even though the capability list is full. Refusing is also the honest
    // answer: this Host exposes a model catalog, not a provider registry.
    // The composer's `/` and `@` palettes.
    //
    // Refusing these is what the user sees as "channel is not available on DSH
    // Host" while typing — the palette is part of the agent's own information
    // flow, not an extra, so it answers even when a source is missing: an empty
    // palette reads as "nothing to offer", which is true, while a refusal reads
    // as a broken composer.
    if (channel === 'maker:set-effort') {
      // Effort is advertised in the capabilities (`effortLevels`, read from the
      // model catalog), so the controller draws the picker and will call this.
      // A Host that lists effort levels but cannot apply one is the same class of
      // lie as a model catalog that cannot route.
      const setEffort = capabilitiesNow().setEffort;
      if (typeof setEffort !== 'function') return invokeError(request, 'NOT_AVAILABLE', 'This DSH Host cannot change the reasoning effort');
      const sessionId = String(args[0] ?? '');
      const effort = typeof args[1] === 'string' ? args[1] : '';
      if (sessionId === '' || effort === '') return invokeError(request, 'BAD_REQUEST', 'maker:set-effort needs a session and an effort');
      try {
        await setEffort({ sessionId, effort });
        // The row the controller holds is now stale, exactly as after a model or
        // permission change.
        const push = capabilitiesNow().pushInputProjection;
        if (typeof push === 'function') push(sessionId);
        return invokeResult(request, true);
      } catch (error) {
        return invokeError(request, refusalCodeOf(error), String(error?.message ?? error));
      }
    }

    if (channel === 'maker:list-agent-skills') {
      const palette = capabilitiesNow().palette;
      if (typeof palette?.skills !== 'function') return invokeResult(request, { success: true, skills: [] });
      const cwd = typeof args[1]?.workingDir === 'string' && args[1].workingDir !== '' ? args[1].workingDir : undefined;
      // The session is what names the viewing scope: a preset's skills are
      // registered into its own layer, so without it the registry answers for
      // the global layer alone and this menu is empty on a profile that has
      // skills. The controller sends the same field for its command list.
      const sessionId = typeof args[1]?.sessionId === 'string' ? args[1].sessionId : '';
      let summaries = [];
      try {
        summaries = await palette.skills({ cwd, sessionId });
      } catch {
        summaries = [];
      }
      return invokeResult(request, toAgentSkills(summaries));
    }

    if (channel === 'maker:list-agent-commands') {
      const palette = capabilitiesNow().palette;
      if (typeof palette?.commands !== 'function') return invokeResult(request, { success: true, commands: [] });
      const sessionId = typeof args[1]?.sessionId === 'string' ? args[1].sessionId : '';
      let descriptors = [];
      try {
        descriptors = await palette.commands({ sessionId });
      } catch {
        descriptors = [];
      }
      return invokeResult(request, toAgentCommands(descriptors, 'agent-builtin'));
    }

    if (channel === 'maker:list-desktop-commands') {
      // Commands only the controlling desktop can run. This Host owns none, and
      // an empty success is the right answer here — unlike the provider catalog,
      // nothing downstream branches on this channel being *unsupported*.
      return invokeResult(request, { success: true, commands: [] });
    }

    if (channel === 'maker:scan-at-resources') {
      const palette = capabilitiesNow().palette;
      const workingDir = typeof args[1]?.workingDir === 'string' ? args[1].workingDir : '';
      if (typeof palette?.resources !== 'function' || workingDir === '') {
        return invokeResult(request, { success: true, items: [] });
      }
      let entries = [];
      try {
        entries = await palette.resources({
          workingDir,
          query: typeof args[1]?.query === 'string' ? args[1].query : '',
          cap: Number.isFinite(args[1]?.cap) ? args[1].cap : undefined,
        });
      } catch {
        entries = [];
      }
      return invokeResult(request, toAtResources(entries, {
        workingDir,
        cap: Number.isFinite(args[1]?.cap) ? args[1].cap : undefined,
        query: typeof args[1]?.query === 'string' ? args[1].query : '',
      }));
    }

    if (channel === 'maker:create-session') {
      const create = capabilitiesNow().createSession;
      if (typeof create !== 'function') return invokeError(request, 'NOT_AVAILABLE', 'This DSH Host cannot create sessions yet');
      const options = args[0] !== null && typeof args[0] === 'object' ? args[0] : {};
      // The controller may pre-allocate the session id so its optimistic row and
      // route use the final id from the start; DSH's create is idempotent on a
      // supplied id, so passing it through is safe and avoids a rekey.
      const created = await create({
        sessionId: typeof options.id === 'string' && options.id !== '' ? options.id : undefined,
        cwd: typeof options.workingDir === 'string' && options.workingDir !== '' ? options.workingDir : undefined,
      });
      return invokeResult(request, {
        sessionId: String(created?.sessionId ?? options.id ?? ''),
        // One harness, whatever the picker offered.
        agentKind: DSH_AGENT_KIND,
        workDir: options.workingDir ?? null,
        usedProjectContext: false,
      });
    }

    if (channel === 'local-db:sessions:patch-meta') {
      const sessionId = String(args[0] ?? '');
      const patch = args[1] !== null && typeof args[1] === 'object' ? args[1] : {};
      if (sessionId === '') return invokeError(request, 'BAD_REQUEST', 'local-db:sessions:patch-meta needs a session id');

      // The controller's whole 删除 / 归档 / 置顶 / 重命名 menu arrives here, and it
      // reads the **returned row** as the truth: `useSessionListActions` applies only
      // the fields it wrote, taken from this reply. Answering with an unchanged row is
      // therefore not a refusal — it is an instruction to revert the user's edit,
      // which is how these three actions used to look like dead buttons.
      //
      // Only the title has a DSH counterpart; the other three are this Host's own
      // bookkeeping (`session-flags.js`), so the reply is built from the source row
      // with the flags folded back on — the same fold every read path uses.
      const capabilities = capabilitiesNow();
      const rename = capabilities.renameSession;
      if (typeof rename === 'function' && typeof patch.title === 'string' && patch.title.trim() !== '') {
        await rename({ sessionId, title: patch.title.trim() });
      }

      const writesMeta = patch.status !== undefined || patch.pinnedAt !== undefined;
      if (writesMeta) {
        const applyFlags = capabilities.applySessionFlags;
        if (typeof applyFlags !== 'function') return invokeError(request, 'NOT_AVAILABLE', 'This DSH Host cannot archive, delete or pin sessions');
        const applied = await applyFlags(sessionId, { status: patch.status, pinnedAt: patch.pinnedAt });
        // Echo only what was written, with this Host's effective value: that is the
        // same patch the controller applied optimistically, so other devices converge
        // on it too.
        const echoed = {};
        if (patch.status !== undefined) echoed.status = applied.status;
        if (patch.pinnedAt !== undefined) echoed.pinnedAt = applied.pinnedAt;
        if (typeof capabilities.publishSessionMeta === 'function') capabilities.publishSessionMeta(sessionId, echoed);
      }

      const rows = await sessionRows();
      const row = rows.find((candidate) => candidate.id === sessionId);
      return row === undefined ? invokeError(request, 'NOT_FOUND', `No DSH session ${sessionId}`) : invokeResult(request, row);
    }

    // The composer's send paths. `maker:send` is the direct one; an idle turn
    // uses `maker:input:enqueue` and a running turn uses `maker:input:steer`,
    // and BOTH must answer or the composer spins in one of the two states.
    if (channel === 'maker:input:enqueue' || channel === 'maker:input:steer') {
      const capabilities = capabilitiesNow();
      const sessionId = String(args[0] ?? '');
      if (sessionId === '') return invokeError(request, 'BAD_REQUEST', `${channel} needs a session id`);

      // A `steer` naming an item DSH already holds is a **promotion** of that
      // queued item, not a new message: the controller sends the queued row back
      // with `removeFromQueue`. Re-sending its text would duplicate it, which is
      // exactly what a queued item's 插话 button must not do.
      const namedId = typeof args[1]?.clientId === 'string' && args[1].clientId !== '' ? args[1].clientId : null;
      if (channel === 'maker:input:steer' && namedId !== null) {
        // Attach the session first: the inbox belongs to the live agent, so
        // without this the lookup reports the item missing on a cold session and
        // the steer degrades into a second send.
        if (typeof capabilities.ensureAgent === 'function') await capabilities.ensureAgent(sessionId);
        // One shot, no wait: steering a brand-new message is the common case and
        // must not pay for a queue lookup. Only an item the Host can already
        // address is treated as a promotion.
        const dshId = await resolveDshItemId(capabilities, sessionId, namedId, 0);
        if (dshId !== null) {
          const control = capabilities.queueControl;
          if (typeof control !== 'object' || control === null) {
            return invokeError(request, 'NOT_AVAILABLE', 'This DSH Host cannot change the pending queue');
          }
          const failure = await commitQueueActionAndReconcile(capabilities, sessionId, dshId, { kind: 'steer' });
          if (failure !== null) return invokeError(request, failure.code, failure.message);
          // `mirror` only re-places an item the fold already holds, and this one may not be
          // there: the authoritative read that follows an enqueue can race DSH's splice and
          // come back empty. That is exactly how a promoted 插话 left the projection saying
          // nothing — measured as a 42-second gap (08:54:40 promoted → 08:55:22 durable)
          // with the phone's bubble abandoned in between. The upsert makes the steering id
          // true from this moment; the durable row's `retireQueuedItem` clears it again.
          //
          // The record has to carry the message **content**, because that is what the
          // controller renders: the first version restated the id with `content: []`, and the
          // bubble appeared with no text in it (「插入之后里面的文字被清空了」) while the same
          // empty item produced an empty transcript row. The fold's own record is the
          // authority when it has one; otherwise the text the controller sent with the row.
          const mirror = capabilities.queueMirror;
          const known = typeof mirror?.itemFor === 'function' ? mirror.itemFor(sessionId, namedId) : null;
          const knownContent = Array.isArray(known?.message?.content) && known.message.content.length > 0
            ? known.message.content
            : null;
          const carried = extractSendText(args[1]);
          const content = knownContent
            ?? (typeof carried === 'string' && carried !== '' ? [{ type: 'text', text: carried }] : []);
          // Keyed on DSH's own id, not the controller's: the fold is keyed that way, and an
          // upsert under the `clientId` left the original queued row in the fold beside the new
          // steering one — a duplicate the projection then reported as both `queued` and
          // `steering`. The controller's id travels as `rpcId`, which is what the projection
          // names the row by.
          const itemId = known?.id !== undefined && known?.id !== null ? String(known.id) : String(dshId);
          if (typeof mirror?.markSteering === 'function') {
            mirror.markSteering(sessionId, {
              ...(known ?? {}),
              id: itemId,
              rpcId: namedId,
              message: { ...(known?.message ?? {}), id: itemId, content },
            });
          } else {
            mirror?.mirror(sessionId, namedId, { kind: 'steer' });
          }
          // The promotion moved the row from "queued" to "steering": tell the controller
          // that, or the row it is showing disappears in the hand-off.
          capabilities.pushInputProjection?.(sessionId);
          // The controller answers a steer with a boolean and then refetches.
          return invokeResult(request, true);
        }
      }

      const text = extractSendText(args[1]);
      const attachments = extractSendAttachments(args[1]);
      // A prompt with neither text nor a serveable attachment is nothing to run, and
      // accepting it would show the user a delivered message DSH has no counterpart
      // for. **Attachment-only is legitimate** — the phone's composer sends a photo
      // with `text: ''` — so the refusal is about having nothing at all, not about
      // having no words.
      if (text === null && attachments.length === 0) {
        return invokeError(request, 'BAD_REQUEST', `${channel} carried no text and no attachment this Host can serve`);
      }

      const steer = channel === 'maker:input:steer';
      if (typeof capabilities.sendMessage !== 'function') return invokeError(request, 'NOT_AVAILABLE', 'This DSH Host cannot send prompts yet');
      // The controller's own `clientId` is the prompt identity, and DSH persists
      // it as the queued item's `rpcId` — the field the controller retires its
      // local echo on, and the field DSH dedupes a retried prompt against.
      // Sending the relay's envelope id instead left the draft in the composer
      // (so the next thing the user typed was appended to it) and made a retry
      // indistinguishable from a new message.
      const sent = await capabilities.sendMessage({
        sessionId,
        text: text ?? '',
        requestId: namedId ?? request.id,
        mode: steer ? 'steer' : 'queue',
        // A message with no serveable attachment keeps the exact shape it always
        // had: an empty list is not information, and every seam test pins it.
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      // An attachment-only prompt whose bytes could not be fetched is refused with
      // the reason: sending it would deliver a photo the agent never saw.
      if (sent !== undefined && sent !== null && sent.ok === false) {
        return invokeError(request, sent.code ?? 'ATTACHMENT_UNAVAILABLE', sent.message ?? 'the attachment could not be fetched');
      }

      if (steer) {
        // A **new** steering prompt (not a promotion) has to be made visible before it is
        // durable.
        //
        // DSH splices it into the running turn's next step a moment after `prompt()`
        // returns, so a projection read taken right now may legitimately say nothing about
        // it. The controller's bubble would then have nothing to hold on to and vanish —
        // 手机上「转圈转圈然后就消失了」 while the message did reach the desktop. Recording
        // it as a steering item keeps `steeringQueueClientIds` truthful from this moment,
        // and `retireQueuedItem` clears it the instant the durable row arrives.
        const controllerId = namedId ?? request.id;
        if (typeof capabilities.queueMirror?.markSteering === 'function') {
          capabilities.queueMirror.markSteering(sessionId, {
            id: controllerId,
            rpcId: controllerId,
            message: { id: controllerId, content: text === null || text === '' ? [] : [{ type: 'text', text }] },
          });
        }
        capabilities.pushInputProjection?.(sessionId);
        return invokeResult(request, true);
      }

      // Answer with the queue DSH actually holds.
      //
      // This Host used to synthesise a `pendingQueue` row for every accepted
      // prompt. When the session was idle DSH admitted the prompt immediately and
      // never put it in the inbox, so that row described a queue entry that did
      // not exist — and nothing would ever clear it, because no queue frame is
      // emitted for an item that was never queued. The phone showed 队列中 for a
      // message the agent had already answered.
      //
      // The authoritative read is the honest answer: a row appears only if DSH is
      // really holding one. A prompt that was admitted instead shows up as a
      // durable message, which is what the controller renders anyway.
      if (typeof capabilities.readSessionState === 'function' && typeof capabilities.projectionFromItems === 'function') {
        const state = await capabilities.readSessionState(sessionId);
        if (state !== null && state !== undefined) {
          const items = queueItemsFromInbox(state.inbox);
          // Teach the fold the durable ids, so a later cancel or edit resolves
          // without waiting for a queue frame that may never come.
          capabilities.queueMirror?.adopt?.(sessionId, items);
          const held = namedId !== null
            && items.some((entry) => entry.rpcId === namedId || entry.id === namedId);
          // A prompt accepted **while a turn is running** belongs in the queue,
          // and DSH's durable splice can land a moment after `prompt` returns —
          // so that one row is shown from the acceptance itself. A prompt
          // accepted by an idle session is admitted immediately, and showing it
          // as queued is what left the phone spinning on a 队列中 row for a
          // message the agent had already answered.
          const pending = !held && namedId !== null && capabilities.isSessionRunning?.(sessionId) === true
            ? (capabilities.queuedRow?.({ clientId: namedId, text, sessionId }) ?? null)
            : null;
          // A synthesised row has to exist in the fold too, not just in this answer: the
          // controller will keep showing it, and the next thing that happens to it (插话 →
          // promotion, 编辑, 删除) resolves against the fold by that id.
          if (pending !== null && typeof capabilities.queueMirror?.markQueued === 'function') {
            capabilities.queueMirror.markQueued(sessionId, {
              id: namedId,
              rpcId: namedId,
              message: { id: namedId, content: text === null || text === '' ? [] : [{ type: 'text', text }] },
            });
          }
          return invokeResult(request, capabilities.projectionFromItems(sessionId, items, pending));
        }
      }

      const project = capabilities.inputProjection;
      const pending = namedId === null ? null : capabilities.queuedRow?.({ clientId: namedId, text, sessionId });
      const projection = typeof project === 'function'
        ? project(sessionId, pending ?? null)
        : { sessionId, pendingQueue: pending === null ? [] : [pending], steeringQueueClientIds: [] };
      return invokeResult(request, projection);
    }

    // Queue commands. The queue lives in DSH's durable inbox, so every mutation
    // goes to `sessionController.updateQueue` (or `cancel`) and is mirrored into
    // this Host's fold: DSH's own queue frame trails the commit, and answering a
    // removal with the pre-removal queue would put the row straight back.
    if (QUEUE_COMMAND_CHANNELS.has(channel)) {
      const capabilities = capabilitiesNow();
      const sessionId = String(args[0]?.sessionId ?? args[0] ?? '');
      if (sessionId === '') return invokeError(request, 'BAD_REQUEST', `${channel} needs a session id`);
      const mirror = capabilities.queueMirror;
      const control = capabilities.queueControl;
      const clientId = typeof args[1] === 'string' ? args[1] : (typeof args[1]?.clientId === 'string' ? args[1].clientId : null);

      // Controller-owned queue UI state. The controller sets it here and reads it
      // back out of the projection, so it must be recorded rather than ignored.
      if (channel === 'maker:input:set-expanded') {
        mirror?.setExpanded(sessionId, args[1] === true);
        return answerQueueCommand(request, capabilities, sessionId);
      }
      if (channel === 'maker:input:set-edit-lock') {
        mirror?.setEditLock(sessionId, clientId, args[2] === true);
        return answerQueueCommand(request, capabilities, sessionId);
      }
      if (channel === 'maker:input:set-interaction-lock') {
        mirror?.setInteractionLock(sessionId, clientId, args[2] === true);
        return answerQueueCommand(request, capabilities, sessionId);
      }
      // `resume` reopens a paused queue. DSH's inbox is never paused — this Host
      // reports `queuePaused: false` always — so there is nothing to resume and
      // the current projection is the whole truth.
      if (channel === 'maker:input:resume') {
        return answerQueueCommand(request, capabilities, sessionId);
      }

      if (typeof control !== 'object' || control === null) {
        return invokeError(request, 'NOT_AVAILABLE', 'This DSH Host cannot change the pending queue');
      }

      if (channel === 'maker:input:stop') {
        // DSH cancels the active turn without dropping the pending inbox, which
        // is exactly what the controller asks for: it only ever sends
        // `keepQueue: true` (see `stopOptionsForProjection`).
        try {
          control.cancel({ sessionId });
        } catch (error) {
          return invokeError(request, 'THREW', String(error?.message ?? error));
        }
        return answerQueueCommand(request, capabilities, sessionId);
      }

      if (channel === 'maker:input:clear-session') {
        // Emptying the queue means removing DSH's items one by one: the inbox is
        // the only owner, and `updateQueue` is the only supported mutation.
        //
        // An item DSH has already admitted is **not a failure here**, and two measured
        // behaviours depended on saying so. `updateQueue` answers such an item with
        // `session/queue-item-not-found` ("queued item is no longer pending"), which is the
        // outcome this channel exists to produce — the queue is what it should be. Returning
        // it as an error also aborted the loop, so everything after the first already-admitted
        // item stayed queued while the controller was told the clear had failed. Both showed
        // up as the acceptance suite's only two failures once refusals stopped being swallowed.
        // A genuine refusal is still reported, after the rest has been attempted.
        const ids = mirror?.itemIds(sessionId) ?? [];
        let failure = null;
        for (const itemId of ids) {
          const outcome = await commitQueueActionAndReconcile(capabilities, sessionId, itemId, { kind: 'remove' });
          if (outcome === null) continue;
          if (outcome.code === 'session/queue-item-not-found') continue;
          if (failure === null) failure = outcome;
        }
        // Only claim the queue is empty when it is: a real failure leaves the fold alone, so
        // the rows DSH still holds stay visible instead of vanishing on a false promise.
        if (failure === null) mirror?.clearSession(sessionId);
        if (failure !== null) return invokeError(request, failure.code, failure.message);
        return answerQueueCommand(request, capabilities, sessionId);
      }

      let action;
      if (channel === 'maker:input:remove') {
        action = { kind: 'remove' };
      } else if (channel === 'maker:input:update-text' || channel === 'maker:input:update-content') {
        // `update-text` passes the new text directly; `update-content` passes a
        // whole queued row (text plus attachments). Only text is durable here.
        const text = channel === 'maker:input:update-text' ? args[2] : extractSendText(args[2]);
        if (typeof text !== 'string' || text.trim() === '') {
          return invokeError(request, 'BAD_REQUEST', `${channel} carried no text`);
        }
        action = { kind: 'edit', content: [{ type: 'text', text }] };
      } else {
        return invokeError(request, 'BAD_REQUEST', `${channel} is not a queue command`);
      }

      if (clientId === null || clientId === '') return invokeError(request, 'BAD_REQUEST', `${channel} needs an item id`);
      // `updateQueue` is keyed on DSH's durable `MessageId`, not the `clientId`
      // the controller minted, so the id is translated — and the session is
      // attached first, because the inbox only exists on a live agent: without
      // that, a queued item on a cold session is invisible and the mutation is
      // refused as if the item had vanished.
      if (typeof capabilities.ensureAgent === 'function') await capabilities.ensureAgent(sessionId);
      const dshId = await resolveDshItemId(capabilities, sessionId, clientId);
      if (dshId === null) return invokeError(request, 'NOT_FOUND', `No queued item ${clientId}`);
      const failure = await commitQueueActionAndReconcile(capabilities, sessionId, dshId, action);
      if (failure !== null) return invokeError(request, failure.code, failure.message);
      mirror?.mirror(sessionId, clientId, action);
      return answerQueueCommand(request, capabilities, sessionId);
    }

    if (channel === 'maker:input:move') {
      const capabilities = capabilitiesNow();
      const sessionId = String(args[0] ?? '');
      const clientId = typeof args[1] === 'string' ? args[1] : null;
      if (sessionId === '' || clientId === null) return invokeError(request, 'BAD_REQUEST', 'maker:input:move needs a session and an item id');
      // Reordering is presentation: DSH's inbox keeps its own order and a
      // reordered row would snap back on the next frame, so this Host records
      // the new order locally and says nothing it cannot keep.
      capabilities.queueMirror?.moveItem(sessionId, clientId, args[2]);
      return answerQueueCommand(request, capabilities, sessionId);
    }

    if (channel === 'maker:send') {
      const send = capabilitiesNow().sendMessage;
      if (typeof send !== 'function') return invokeError(request, 'NOT_AVAILABLE', 'This DSH Host cannot send prompts yet');
      const sessionId = String(args[0] ?? '');
      const text = extractSendText(args[1]);
      if (sessionId === '') return invokeError(request, 'BAD_REQUEST', 'maker:send needs a session id');
      const sendAttachments = extractSendAttachments(args[1]);
      // Refusing beats sending an empty prompt: the controller would show the
      // message as sent while DSH had nothing to run. A photo with no caption is
      // still something to run, so only "nothing at all" is refused.
      if (text === null && sendAttachments.length === 0) {
        return invokeError(request, 'BAD_REQUEST', 'maker:send carried no text and no attachment this Host can serve');
      }
      // The controller's own `clientId` is the prompt identity on this path too.
      // DSH persists it as the message's `rpcId`, which is what the controller
      // retires its local submission echo on — send the relay's envelope id and
      // the echo never clears, so the message sits "sending" and then vanishes.
      const clientId = typeof args[1]?.clientId === 'string' && args[1].clientId !== ''
        ? args[1].clientId
        : (typeof args[2]?.clientId === 'string' && args[2].clientId !== '' ? args[2].clientId : null);
      const sent = await send({
        sessionId,
        text: text ?? '',
        requestId: clientId ?? request.id,
        ...(sendAttachments.length > 0 ? { attachments: sendAttachments } : {}),
      });
      if (sent !== undefined && sent !== null && sent.ok === false) {
        return invokeError(request, sent.code ?? 'ATTACHMENT_UNAVAILABLE', sent.message ?? 'the attachment could not be fetched');
      }
      return invokeResult(request, { accepted: true });
    }

    // Approvals. The questions are DSH's own pending `approval/request`s, routed
    // here only while a controller is watching the asking session.
    if (channel === 'maker:get-context-usage') {
      // How full the session's context is. The controller reads the answer
      // leniently (`totalTokens`/`contextTokens`, `maxTokens`/`contextWindow`,
      // `percent`) and renders "暂无上下文数据" for anything unusable — so an unknown
      // measurement is reported as `null` rather than as a zero, which would read
      // as "empty context".
      const usage = capabilitiesNow().contextUsage;
      if (typeof usage !== 'function') return invokeResult(request, null);
      const sessionId = String(args[0] ?? '');
      if (sessionId === '') return invokeError(request, 'BAD_REQUEST', 'maker:get-context-usage needs a session id');
      try {
        return invokeResult(request, (await usage({ sessionId })) ?? null);
      } catch {
        // A measurement that fails costs the panel, never the session.
        return invokeResult(request, null);
      }
    }

    if (channel === 'maker:regenerate-title') {
      // The controller sends `[{ sessionId }]` here — an object, unlike the bare
      // session-id string every other channel uses — and it reads the answer as
      // `{ title: string | null }`: this call only produces a title, and the
      // controller persists it through `local-db:sessions:patch-meta`. So "no title"
      // is a value, not an error frame.
      const sessionId = typeof args[0]?.sessionId === 'string' ? args[0].sessionId : '';
      if (sessionId === '') return invokeError(request, 'BAD_REQUEST', 'maker:regenerate-title needs a session id');
      const regenerate = capabilitiesNow().regenerateTitle;
      if (typeof regenerate !== 'function') return invokeResult(request, { title: null });
      try {
        return invokeResult(request, (await regenerate({ sessionId })) ?? { title: null });
      } catch {
        // A failed generation is the controller's documented "no title" outcome.
        return invokeResult(request, { title: null });
      }
    }

    if (channel === 'maker:get-pending-interactions') {
      const list = capabilitiesNow().listPendingInteractions;
      if (typeof list !== 'function') return invokeResult(request, []);
      const sessionId = typeof args[0] === 'string' && args[0] !== '' ? args[0] : undefined;
      return invokeResult(request, list(sessionId));
    }

    if (channel === 'maker:resolve-interaction') {
      const resolve = capabilitiesNow().resolveInteraction;
      if (typeof resolve !== 'function') return invokeError(request, 'NOT_AVAILABLE', 'This DSH Host cannot answer interactions');
      const requestId = typeof args[0] === 'string' ? args[0] : '';
      const decision = args[1] !== null && typeof args[1] === 'object' ? args[1] : {};
      if (requestId === '') return invokeError(request, 'BAD_REQUEST', 'maker:resolve-interaction needs a request id');
      // An unknown id or a decision this Host cannot map is refused rather than
      // acknowledged: the controller keeps the card open instead of believing it
      // was answered.
      return invokeResult(request, resolve(requestId, decision));
    }

    if (channel === 'maker:goal:get-status') {
      // Answered from the session projection stream, so a status read never
      // resumes a cold session to look at it.
      const sessionId = String(args[0] ?? '');
      if (sessionId === '') return invokeError(request, 'BAD_REQUEST', 'maker:goal:get-status needs a session id');
      const capabilities = capabilitiesNow();
      // Read the projection itself before trusting the stream: the pushed frames
      // are not guaranteed to arrive, and a goal that exists while every status
      // read answers `null` is a card that never appears.
      if (typeof capabilities.readSessionState === 'function') {
        const state = await capabilities.readSessionState(sessionId);
        // A registered key answers authoritatively, `null` value included.
        if (state !== null && state !== undefined && state.hasGoalKey === true) {
          return invokeResult(request, toGoalStatusPayload(sessionId, state.goal ?? null) ?? null);
        }
      }
      const goalStatus = capabilities.goalStatus;
      const folded = typeof goalStatus === 'function' ? goalStatus(sessionId) : undefined;
      if (folded !== undefined) return invokeResult(request, folded ?? null);
      // Nothing could answer, and the controller reads that difference exactly:
      // `undefined` (a payload with no `result` field) means "unknown, leave the
      // card alone", while an explicit `null` means "confirmed no goal" and wipes
      // it. Answering `null` here is how a live goal disappeared from the phone:
      // the projection read times out or the key is not registered, and because a
      // goal that has not changed never pushes again, nothing brought it back.
      return invokeResult(request, undefined);
    }

    // Goal writes. Unlike the status read above these cannot be answered from
    // the projection: DSH applies them as compare-and-set mutations on a live
    // `Agent`, so each one resolves the session. That is acceptable for an
    // action the user just took and is why the read path stays separate.
    if (GOAL_WRITE_CHANNELS.has(channel)) {
      const capabilities = capabilitiesNow();
      const write = capabilities.goalWrite;
      if (typeof write !== 'object' || write === null) {
        return invokeError(request, 'NOT_AVAILABLE', 'This DSH Host composes no goal service');
      }
      const sessionId = String(args[0]?.sessionId ?? args[0] ?? '');
      if (sessionId === '') return invokeError(request, 'BAD_REQUEST', `${channel} needs a session id`);

      let outcome;
      if (channel === 'maker:goal:set') {
        outcome = await write.set({ sessionId, objective: args[0]?.objective, limits: args[0]?.limits });
      } else if (channel === 'maker:goal:update') {
        outcome = await write.update({ sessionId, patch: args[0]?.patch });
      } else {
        // `pause` / `resume` / `clear` take the bare session id.
        outcome = await write[channel.slice('maker:goal:'.length)](sessionId);
      }

      if (outcome?.ok !== true) {
        // The service's own code is passed through: `GOAL_ALREADY_EXISTS` and
        // `GOAL_INVALID_TRANSITION` say exactly what went wrong, and the
        // controller shows the message it is given.
        return invokeError(request, outcome?.code ?? 'THREW', outcome?.message ?? 'the goal write failed');
      }
      // The controller refetches status after a write, but a second screen
      // watching this session has no reason to — this is its signal.
      const push = capabilities.pushGoalStatus;
      if (typeof push === 'function') push(sessionId, outcome.status ?? null);
      return invokeResult(request, outcome.status ?? null);
    }

    if (channel === 'maker:git-safety:get') {
      // Git auto-snapshot is a Cindy desktop feature that guards its Rewind
      // entry. This Host has no such feature, so the honest answer is "off" —
      // refusing instead would look like a broken setting rather than an absent
      // one, and the controller reads these three booleans positionally.
      return invokeResult(request, { autoSnapshotEnabled: false, isCustomized: false, defaultAutoSnapshotEnabled: false });
    }

    if (channel === 'maker:input:get-projection') {
      const capabilities = capabilitiesNow();
      const sessionId = String(args[0] ?? '');
      // Read what DSH actually holds before falling back to the fold: a fold that
      // never heard a `queue` frame reports an empty queue, which is how the
      // controller came to keep a 队列中 row for a message the agent had answered.
      if (sessionId !== '' && typeof capabilities.readSessionState === 'function' && typeof capabilities.projectionFromItems === 'function') {
        const state = await capabilities.readSessionState(sessionId);
        if (state !== null && state !== undefined) {
          return invokeResult(request, capabilities.projectionFromItems(sessionId, queueItemsFromInbox(state.inbox)));
        }
      }
      const project = capabilities.inputProjection;
      // The controller requests this on every session open, so it must answer
      // even when the queue is empty: an empty projection is the honest answer,
      // and refusing it would look like a broken composer.
      if (typeof project !== 'function' || sessionId === '') {
        return invokeResult(request, { sessionId, pendingQueue: [], steeringQueueClientIds: [] });
      }
      return invokeResult(request, project(sessionId));
    }

    // The aggregated remote file browser. One channel, dispatched by `op`; the
    // ops this Host does not serve answer `{ok:false, message}` the way the
    // reference host answers an op it does not know, rather than looking empty.
    if (channel === 'file-browser:remote-op') {
      const capabilities = capabilitiesNow();
      const op = args[0]?.op;
      // The two export ops are the controller's only way to *see* a picture that lives on
      // this machine — a file the agent drew, or any image in the file browser. The
      // reference controlled end answers `exportFileStart` immediately with a transfer id
      // and uploads to the shared staging area in the background, then `exportFileStatus`
      // reports `{state, key}`; the controller presign-gets the key itself. They are
      // Host-owned rather than browser-owned because the upload needs this runtime's
      // account session — the same reason attachment fetching lives there.
      if (op === 'exportFileStart' || op === 'exportFileStatus') {
        const start = capabilities.exportFileStart;
        const status = capabilities.exportFileStatus;
        if (op === 'exportFileStart') {
          if (typeof start !== 'function') return invokeError(request, 'NOT_AVAILABLE', 'This DSH Host cannot export files yet');
          const answered = await start({ workdir: args[0]?.workdir, relPath: args[0]?.relPath });
          return answered?.ok === true ? invokeResult(request, answered) : invokeError(request, answered?.code ?? 'INTERNAL', answered?.message ?? 'file export failed');
        }
        if (typeof status !== 'function') return invokeError(request, 'NOT_AVAILABLE', 'This DSH Host cannot export files yet');
        const answered = status({ transferId: args[0]?.transferId });
        return answered?.ok === true ? invokeResult(request, answered) : invokeError(request, answered?.code ?? 'INTERNAL', answered?.message ?? 'unknown transfer');
      }
      const makeBrowser = capabilities.fileBrowser;
      const browser = typeof makeBrowser === 'function' ? makeBrowser() : undefined;
      if (browser === undefined || browser === null) {
        return invokeError(request, 'NOT_AVAILABLE', 'This DSH Host composes no filesystem');
      }
      try {
        return invokeResult(request, await browser(args[0]));
      } catch (error) {
        return invokeError(request, 'THREW', String(error?.message ?? error));
      }
    }

    // The work-grouped history window. The controller only asks for these after seeing
    // `history-view-v1` in this Host's `link-accept`, and it falls back to the raw
    // `local-db:messages:list` window on any error it recognises as "no view here"
    // (`isHistoryViewUnavailable`), which is what `NOT_AVAILABLE` and
    // `UNSUPPORTED_CAPABILITY` both are.
    if (channel === 'local-db:messages:view' || channel === 'local-db:messages:work-details' || channel === 'local-db:messages:view-intent') {
      const view = capabilitiesNow().historyView;
      if (view === undefined || view === null) return invokeError(request, 'NOT_AVAILABLE', 'This DSH Host projects no session history view');
      const sessionId = typeof args[0] === 'string' ? args[0] : '';
      const answered = channel === 'local-db:messages:view'
        ? await view.page(sessionId, args[1]?.before)
        : channel === 'local-db:messages:work-details'
          ? await view.details(sessionId, args[1], args[2]?.after)
          : await view.intent(sessionId, args[1]);
      if (answered?.ok === true && channel === 'local-db:messages:view'
        && typeof args[1]?.before !== 'string' && Array.isArray(answered.result?.items)) {
        // The newest view page also shows the prompts waiting in DSH's inbox: without them a
        // message sent while a turn is running is absent from the projection the controller
        // renders, and a reload looks like the message was lost (「退出去再进来，它不见了」)
        // even though it is queued and will arrive.
        const pending = capabilitiesNow().queueMirror?.pendingRows?.(sessionId) ?? [];
        if (pending.length > 0) {
          return invokeResult(request, {
            ...answered.result,
            items: mergePendingByTime(answered.result.items, pending.map((row) => ({ type: 'messages', key: row.clientId, messages: [row] }))),
          });
        }
      }
      return answered?.ok === true
        ? invokeResult(request, answered.result)
        : invokeError(request, answered?.code ?? 'INTERNAL', answered?.message ?? 'history view failed');
    }

    // A controller asking this machine for one of its files: an image the agent produced,
    // referenced by path in the transcript. The answer is a staged `ossKey` the controller
    // presign-gets itself, exactly as this Host does for a photo the phone uploaded.
    if (channel === 'device-link:media:fetch') {
      const fetchMedia = capabilitiesNow().fetchLocalMedia;
      if (typeof fetchMedia !== 'function') return invokeError(request, 'NOT_AVAILABLE', 'This DSH Host cannot serve local media');
      // `skipCache` is the controller saying "the object this key named is gone, stage it
      // again": it must bypass the staging cache rather than be dropped on the floor, or a
      // deleted object would stay unmaterializable for the cache's whole lifetime.
      const answered = await fetchMedia({
        url: args[0]?.url,
        thumbnail: args[0]?.thumbnail === true,
        skipCache: args[0]?.skipCache === true,
      });
      return answered?.ok === true
        ? invokeResult(request, answered.result)
        : invokeError(request, answered?.code ?? 'INTERNAL', answered?.message ?? 'media fetch failed');
    }

    // File reads. Both families the controller uses take an absolute path and
    // answer in its own vocabulary; the translation lives in `host-files.js`.
    if (channel === 'fs:stat-path' || channel === 'fs:list-dir' || channel === 'text-file:read-preview') {
      const files = capabilitiesNow().files;
      if (typeof files !== 'function') return invokeError(request, 'NOT_AVAILABLE', 'This DSH Host cannot read files yet');
      const reader = files();
      const path = channel === 'text-file:read-preview'
        ? (args[0]?.filePath ?? args[0]?.path)
        : args[0]?.path;
      if (typeof path !== 'string' || path.trim() === '') return invokeError(request, 'BAD_REQUEST', `${channel} needs a path`);
      if (channel === 'fs:stat-path') return invokeResult(request, await reader.statPath(path));
      if (channel === 'fs:list-dir') return invokeResult(request, await reader.listDir(path));
      return invokeResult(request, await reader.readTextPreview(path));
    }

    // Fail closed and say so. The controller degrades on CHANNEL_NOT_ALLOWED.
    return invokeError(request);
  };
}
