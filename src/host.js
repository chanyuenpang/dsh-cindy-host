/**
 * The Cindy Host runtime: one Cindy session, one DeviceLink relay socket, one
 * projected DSH session list, and the status the settings card renders.
 *
 * Everything here is driven by the 连接手机 switch. When it is off there is no
 * socket, no projection, and no accepted controller — turning it off tears all
 * three down rather than idling them.
 *
 * Wire facts (all from Cindy's own protocol packages, none invented):
 *  - the relay authenticates the socket from the bearer token and fixes the
 *    account; `Envelope.src` is filled by the relay, so frames that reach us
 *    are already same-account;
 *  - `hello` must declare `remoteControlEnabled`, because the relay only routes
 *    `link-open`/`invoke` to a target that advertised it;
 *  - `hello-ack` carries the only identity the relay gives us: `deviceId` and
 *    `userId` (there is no pairing token anywhere in the protocol);
 *  - same-account devices arrive as `presence-changed` snapshots;
 *  - the client is expected to send `ping` every ~20s and treat consecutive
 *    missing `pong`s as a dead socket.
 */
import WebSocket from 'ws';
import { readFile as readFileImpl, realpath as realpathImpl, stat as statImpl } from 'node:fs/promises';
import { extname as extnameImpl, resolve as resolvePathImpl } from 'node:path';
import { restoreSession } from './auth-session.js';
import { createChannelRouter, invokeError } from './cindy-channels.js';
import { createApprovalRegistry } from './host-approvals.js';
import { createInputQueueTracker, queuedRowFromController } from './host-input-queue.js';
import { createProjectionTracker, toGoalStatusPayload } from './host-goals.js';
import { ReadOnlyProjection } from './projection.js';
import { SessionReadModel } from './session-read-model.js';
import { ProjectionReadModelSink } from './projection-read-model-sink.js';
import { publishLifecycle, turnEventFor } from './session-publisher.js';
import { acceptLink } from './host-authorization.js';
import { AuthorizationPolicy } from './authorization-policy.js';
import { HostStatus } from './host-status.js';
import { DEFAULT_HOST_SETTINGS } from './host-settings.js';
import { createSessionFlags } from './session-flags.js';
import { MAX_ATTACHMENT_BYTES } from './host-attachments.js';
import { createMediaRefResolver, createMediaReleaser, createMediaUploader, mediaApiBaseUrl, isAttachmentOssRef } from './host-media.js';
import { MEDIA_FETCH_MAX_BYTES, createLocalMediaFetcher, isBlockedMediaPath, isInsideDirectory, mimeForMediaPath } from './host-media-fetch.js';
import { RECONNECT_STABLE_RESET_MS, computeReconnectDelayMs } from './host-reconnect.js';
import { MAX_FRAME_BYTES, fitInvokeResultToFrame, frameByteLength } from './host-frame-budget.js';

/** Mainland DeviceLink relay. The settings card never guesses this value. */
export const RELAY_WS_URL = 'wss://device-link.cindy.com.cn/api/device-link/ws';

/** Relay envelope version this Host speaks (Cindy `PROTOCOL_VERSION`). */
export const PROTOCOL_VERSION = 1;

/** Application-level heartbeat period, mirroring Cindy's client. */
export const HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * Consecutive missed `pong`s that mark the socket dead.
 *
 * Cindy's client uses 3 ("连续 2 个周期无 pong 视为僵死" in its doc, `pongMissLimit: 3`
 * in its defaults), and — more to the point — it clears that counter on **any** inbound
 * frame. A host that counted only `pong` would declare a busy relay dead; see
 * `handleFrame`.
 */
export const HEARTBEAT_MISS_LIMIT = 3;

export const HOST_DEVICE_NAME = 'DSH Host';
export const HOST_PLATFORM = 'desktop';
export const HOST_APP_VERSION = '0.1.0';

/** Default socket factory; tests inject their own. */
function openRelaySocket(session, url = RELAY_WS_URL) {
  return new WebSocket(url, { headers: { Authorization: `Bearer ${session.accessToken}` } });
}

/**
 * Derive the account device directory from the relay's WebSocket URL.
 * @param relayUrl - the `…/api/device-link/ws` endpoint.
 * @returns the REST device-list URL on the same host.
 */
export function deviceListUrl(relayUrl = RELAY_WS_URL) {
  return `${relayUrl.replace(/^ws/, 'http').replace(/\/ws$/, '')}/devices`;
}

/**
 * Read the account's device directory.
 *
 * `presence-changed` only reaches us for devices that come online while we are
 * connected, so a device that links before us (or that never broadcasts) would
 * otherwise be a bare `deviceId`. This endpoint is the documented way to name it
 * (`Cindy/packages/device-link/src/protocol.ts`: `GET /api/device-link/devices`).
 * It is read-only; no device is created, changed, or removed.
 */
async function fetchDeviceDirectory(session, relayUrl) {
  const response = await fetch(deviceListUrl(relayUrl), { headers: { Authorization: `Bearer ${session.accessToken}`, accept: 'application/json' } });
  if (!response.ok) throw new Error('Cindy device directory request failed');
  return response.json();
}

/**
 * Start the Cindy Host runtime.
 *
 * The returned runtime starts in whatever state `settings` describes: with
 * `transportEnabled` false nothing connects until `updateSettings` turns it on.
 * @param source - optional DSH read source; without one the projection is skipped.
 * @param settings - resolved `dsh-cindy-host` settings section.
 * @param options - injectable session resolver, socket factory, clock, and timers.
 * @returns the runtime handle used by the plugin, the routes, and the tests.
 */
export async function startHost(initialSource, settings = DEFAULT_HOST_SETTINGS, options = {}) {
  const {
    resolveSession = restoreSession,
    openSocket = openRelaySocket,
    listDevices = fetchDeviceDirectory,
    relayUrl = RELAY_WS_URL,
    now = () => new Date(),
    heartbeatMs = HEARTBEAT_INTERVAL_MS,
    heartbeatMissLimit = HEARTBEAT_MISS_LIMIT,
    setInterval: setIntervalImpl = setInterval,
    clearInterval: clearIntervalImpl = clearInterval,
    setTimeout: setTimeoutImpl = setTimeout,
    clearTimeout: clearTimeoutImpl = clearTimeout,
    fetch: fetchImpl = fetch,
    maxAttachmentBytes = MAX_ATTACHMENT_BYTES,
  } = options;

  /**
   * The controller's uploaded attachments, fetched with this Host's own credential.
   *
   * Built here rather than in the plugin seam because the account session is *this*
   * runtime's: it is the one the relay socket authenticated with, and a second
   * `restoreSession()` call would refresh — and rotate — the same refresh token
   * concurrently, which is the failure that once cost a real login. `getSession`
   * reads the live session when the fetch happens, so a reconnect that refreshed the
   * token is picked up for free.
   */
  const mediaBase = mediaApiBaseUrl(relayUrl);
  const mediaOptions = { apiBaseUrl: mediaBase, getSession: () => session, fetchImpl, maxBytes: maxAttachmentBytes };
  const resolveAttachmentRef = createMediaRefResolver(mediaOptions);
  const releaseAttachmentRef = createMediaReleaser(mediaOptions);
  /**
   * The **outbound** half: staging a file from this machine so a controller can download it.
   *
   * An image the agent produced lives on this machine, and the controller cannot read this
   * machine's disk — the reference controlled end uploads it into the shared staging area
   * and answers with the key (`apps/desktop/src/main/device-link/mediaFetch.ts`,
   * `file-browser/device-op.ts`). Both the file browser's `exportFileStart` and
   * `device-link:media:fetch` ride this one uploader, and both use this runtime's account
   * session for the same reason attachment fetching does.
   */
  const uploadMedia = createMediaUploader(mediaOptions);
  /**
   * The controller asking this machine to hand over one of its files.
   *
   * The chat-image path: a picture the agent produced is referenced by path in the
   * transcript, and the controller resolves it through `device-link:media:fetch`. Same
   * uploader as the file browser's export ops, stricter request handling
   * (`host-media-fetch.js`): a containment root is mandatory and both sides are realpath'd.
   */
  const fetchLocalMedia = createLocalMediaFetcher({ uploader: uploadMedia });

  /**
   * File exports the controller is polling: transferId → `{ state, size, uploaded, key?, message? }`.
   *
   * The reference answers `exportFileStart` **immediately** with a transfer id and does the
   * upload behind the reply, because a photo can take longer than the invoke budget; the
   * controller then polls `exportFileStatus`. Terminal states are kept for a while on
   * purpose: a status reply that goes missing must still be re-readable, or the controller
   * shows a failed export for a file it could have shown.
   */
  const fileExports = new Map();
  const FILE_EXPORT_TTL_MS = 10 * 60_000;
  const FILE_EXPORT_MAX_JOBS = 64;

  /** Drop finished exports nobody can still be waiting for. */
  function pruneFileExports() {
    if (fileExports.size <= FILE_EXPORT_MAX_JOBS) return;
    const cutoff = now().getTime() - FILE_EXPORT_TTL_MS;
    for (const [transferId, job] of fileExports) {
      if (job.state !== 'uploading' && job.at < cutoff) fileExports.delete(transferId);
    }
  }

  /**
   * Resolve one controller-named path inside its workdir.
   *
   * `relPath` is resolved against the workdir and **realpath-checked on both sides**, so
   * neither `..` nor a symlink inside the workspace can reach outside it. The never-serve
   * list is the same one media fetching uses: a workdir can be as broad as a home
   * directory, so containment alone is not a secret boundary.
   */
  async function resolveInsideWorkdir(workdir, relPath) {
    if (typeof workdir !== 'string' || workdir.trim() === '') return { ok: false, code: 'BAD_REQUEST', message: 'file export needs a workdir' };
    if (typeof relPath !== 'string' || relPath.trim() === '') return { ok: false, code: 'BAD_REQUEST', message: 'file export needs a relPath' };
    if (/^[A-Za-z]:[\\/]/.test(relPath) || relPath.startsWith('/') || relPath.startsWith('\\')) {
      return { ok: false, code: 'BAD_REQUEST', message: 'relPath must be relative to the workdir' };
    }
    let real;
    let realRoot;
    try {
      realRoot = await realpathImpl(workdir);
      real = await realpathImpl(resolvePathImpl(workdir, relPath));
    } catch {
      return { ok: false, code: 'NOT_FOUND', message: 'the requested file does not exist' };
    }
    if (!isInsideDirectory(real, realRoot)) {
      return { ok: false, code: 'FORBIDDEN', message: 'the requested file is outside the workdir' };
    }
    if (isBlockedMediaPath(real)) {
      return { ok: false, code: 'FORBIDDEN', message: 'the requested file is not served to controllers' };
    }
    let info;
    try {
      info = await statImpl(real);
    } catch {
      return { ok: false, code: 'NOT_FOUND', message: 'the requested file could not be read' };
    }
    if (typeof info?.isDirectory === 'function' && info.isDirectory()) {
      return { ok: false, code: 'BAD_REQUEST', message: 'the requested path is a directory' };
    }
    if (Number.isFinite(info?.size) && info.size > MEDIA_FETCH_MAX_BYTES) {
      return { ok: false, code: 'OVERSIZE', message: `the file is ${info.size} bytes, over the ${MEDIA_FETCH_MAX_BYTES} byte limit` };
    }
    return { ok: true, real, info };
  }

  /**
   * Start one file export: answer with a transfer id, upload behind the reply.
   * @param input - `{ workdir, relPath }` as the controller sent them.
   * @returns `{ ok: true, transferId, size, mtimeMs }` or a refusal.
   */
  async function startFileExport(input) {
    const resolved = await resolveInsideWorkdir(input?.workdir, input?.relPath);
    if (resolved.ok !== true) return resolved;
    const transferId = `exp_${now().getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const job = { state: 'uploading', size: resolved.info.size, uploaded: 0, at: now().getTime() };
    fileExports.set(transferId, job);
    pruneFileExports();
    void (async () => {
      try {
        const bytes = await readFileImpl(resolved.real);
        const staged = await uploadMedia(bytes, { ext: extnameImpl(resolved.real).slice(1), contentType: mimeForMediaPath(resolved.real) });
        if (staged?.ok === true) Object.assign(job, { state: 'done', key: staged.key, size: bytes.length, uploaded: bytes.length });
        else Object.assign(job, { state: 'error', message: String(staged?.reason ?? 'staging failed'), uploaded: 0 });
      } catch (error) {
        // The message reaches the controller's failure placeholder, so it is the message —
        // not `Error: …` — that travels.
        Object.assign(job, { state: 'error', message: String(error?.message ?? error), uploaded: 0 });
      }
    })();
    return { ok: true, transferId, size: resolved.info.size, mtimeMs: Number.isFinite(resolved.info.mtimeMs) ? resolved.info.mtimeMs : 0 };
  }

  /** Report one export's progress or terminal state; idempotent on purpose. */
  function fileExportStatus(input) {
    const transferId = typeof input?.transferId === 'string' ? input.transferId : '';
    const job = transferId === '' ? undefined : fileExports.get(transferId);
    if (job === undefined) return { ok: false, code: 'NOT_FOUND', message: `unknown transfer: ${transferId === '' ? '<none>' : transferId}` };
    return {
      ok: true,
      state: job.state,
      size: job.size,
      uploaded: job.uploaded,
      ...(job.key === undefined ? {} : { key: job.key }),
      ...(job.message === undefined ? {} : { message: job.message }),
    };
  }

  const model = new SessionReadModel();
  /** Devices following the list-level `sessions` topic. */
  const subscribers = new Set();
  /** Devices following one session's live stream: `sessionId -> Set<deviceId>`. */
  const sessionSubscribers = new Map();
  /**
   * Sessions a controller has attached to at least once in this process.
   *
   * The distinction this exists for: *currently watching* and *belongs to the
   * phone* are not the same thing. A user who starts a turn from the phone and
   * then looks away unsubscribes the session topic, and a question the agent asks
   * in that window used to be handed straight to the Web bundle's remote
   * forwarder — which parks it waiting for a browser. Measured: `pending []` while
   * unwatched, still `[]` after re-subscribing, session `running` forever, and no
   * card anywhere the user was looking. A session this Host has served to a
   * controller is therefore claimed for that controller's user for the rest of the
   * process, and stays answerable from the phone's pending list.
   */
  const remoteOwnedSessions = new Set();
  /**
   * The session metadata DSH has no concept of: archived, deleted, pinned.
   *
   * Owned by the runtime rather than the plugin because it is per-process state the
   * channel layer and the row projection must agree on, and it is persisted through
   * the settings section the plugin passes in as `persistSessionFlags`.
   */
  const sessionFlags = createSessionFlags({ initial: settings?.sessionFlags, persist: options.persistSessionFlags });
  /** Questions DSH is waiting on, answered by whichever controller is watching. */
  const approvals = createApprovalRegistry({
    now,
    // How long a controller has to answer a card before the asker is released with
    // "cancelled". Two minutes was the default and it is the wrong budget for the
    // surface this Host serves: the phone's card has no countdown, the user may be
    // away from it, and the path this replaces (the Web bundle's remote forwarder)
    // waits indefinitely — so a short Host timeout is strictly worse than the
    // reference. Half an hour with cancellation as the escape hatch
    // (`maker:input:stop` settles the card immediately) mirrors the reference while
    // still bounding a forgotten turn.
    timeoutMs: 30 * 60_000,
    // Push the dismissal to every watcher, not just the controller that
    // answered: the card is gone for all of them.
    onDismissed: ({ sessionId, requestId }) => {
      pushSessionUpdate(sessionId, 'maker:interaction-dismissed', { sessionId, requestId });
    },
  });
  /** DSH's input queue and jobs, folded from the control stream. */
  const inputQueue = createInputQueueTracker();
  /** Session projections off the same stream — notably `goal`. */
  const projections = createProjectionTracker();
  const acceptedControllers = new Set();
  const policy = new AuthorizationPolicy(settings);
  const status = new HostStatus({ now });

  let current = settings;
  let source = initialSource;
  let active = false;
  let connecting = false;
  let session = null;
  let ws = null;
  let projection = null;
  let heartbeat = null;
  let pongMisses = 0;
  /**
   * The reconnect ladder: how many attempts have failed in a row, and the one pending
   * retry timer. `reconnectAttempt` is forgotten after `markConnectionStable`, so a
   * Host that flaps for a week still retries in a second once the link is healthy.
   */
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let stableTimer = null;
  /** Why the last retry was scheduled, for the status route and the card's message. */
  let reconnectReason = null;
  // Bumped by every teardown and every new connect: any async continuation or
  // socket callback that still carries an older generation has been superseded
  // and must not touch the runtime.
  let generation = 0;
  let stopped = false;
  /** Devices we already asked the directory to name in this connection. */
  const directoryAsked = new Set();
  /**
   * Frames this Host built but refused to send because they exceeded the relay's
   * per-frame ceiling.
   *
   * A refusal here is a bug in the reply path rather than a routine outcome: message
   * pages are degraded to fit before this point, and everything else this Host
   * answers is small. It is recorded because the alternative — a frame the relay
   * silently drops — is indistinguishable from a Host that never answered.
   */
  const frameRefusals = [];
  const FRAME_REFUSAL_LOG_LIMIT = 20;
  let frameRefusalTotal = 0;
  /** Replies that had to be degraded (or refused) to fit one frame, newest last. */
  const frameDegradations = [];

  function send(frame) {
    if (ws === null || typeof ws.send !== 'function') return;
    if (typeof ws.readyState === 'number' && ws.readyState !== 1) return;
    // The relay **rejects** a frame over `MAX_FRAME_BYTES` outright — it does not
    // truncate it, and the controller waiting on that frame is left until its own
    // deadline. So an oversized frame is refused here, where it is observable, rather
    // than handed to a socket that will drop it. Message pages never reach this point
    // oversized: `fitInvokeResultToFrame` degrades them first.
    const bytes = frameByteLength(frame);
    if (bytes > MAX_FRAME_BYTES) {
      frameRefusals.push({ at: now().toISOString(), kind: typeof frame?.kind === 'string' ? frame.kind : null, bytes });
      if (frameRefusals.length > FRAME_REFUSAL_LOG_LIMIT) frameRefusals.splice(0, frameRefusals.length - FRAME_REFUSAL_LOG_LIMIT);
      frameRefusalTotal += 1;
      return;
    }
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // A send that throws belongs to the socket's own error path.
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    pongMisses = 0;
    if (!(heartbeatMs > 0)) return;
    heartbeat = setIntervalImpl(() => {
      if (ws === null) return;
      pongMisses += 1;
      if (pongMisses > heartbeatMissLimit) {
        // Consecutive missed pongs mean a socket that looks open and routes nothing.
        // Drop it and retry with backoff — the card's manual reconnect stays available,
        // but a person at the desk must never be the mechanism that brings the Host back.
        void dropAndRetry('与 Cindy relay 的心跳已丢失');
        return;
      }
      send({ v: PROTOCOL_VERSION, kind: 'ping' });
    }, heartbeatMs);
    if (typeof heartbeat?.unref === 'function') heartbeat.unref();
  }

  function stopHeartbeat() {
    if (heartbeat !== null) clearIntervalImpl(heartbeat);
    heartbeat = null;
    pongMisses = 0;
  }

  /**
   * Start the DSH projection when both a source and the switch are present.
   *
   * Factored out because the source can arrive *after* the runtime: the DSH
   * services that supply it (`sessionController`) are provided by another plugin
   * and may activate later, so `apply` cannot read them synchronously.
   */
  async function ensureProjection() {
    if (projection !== null || source === undefined || source === null) return;
    projection = new ReadOnlyProjection(new ProjectionReadModelSink(model, (item) => {
      // List-level pushes are recorded through the same tally as session-scoped
      // ones: a running badge on the session list depends on them, so they must
      // be answerable from diagnostics too.
      const record = (channel, watchers, payload) => recordPush(null, channel, watchers, payload);
      if (ws !== null) publishLifecycle(ws, subscribers, item, record);
      publishTurnEvent(item);
    }));
    await projection.start(source);
  }

  /**
   * Tell the session's watchers what the turn is doing.
   *
   * The controller clears its "thinking" state on a terminal `maker:event` and on
   * nothing else: `maker:status-changed` only retires a *closed* session, and the
   * list-level `local-db:sessions:activity` push belongs to the `sessions` topic,
   * which a controller that is merely viewing one session does not hold. So a
   * turn that finished while the phone watched its session left the phone
   * spinning forever — the answer arrived, the composer still said 思考中.
   * @param item - one lifecycle item from the projection sink.
   */
  function publishTurnEvent(item) {
    // Keep the cached row's turn state in step with the lifecycle itself.
    //
    // The cache is refreshed by a **list read**, and a controller sitting inside
    // one session may not cause one for minutes — so a `running: true` captured
    // when the turn began outlived the turn that ended it. That stale `true` is
    // what silenced both safety nets (`pushTurnIdle` on attach and
    // `reconcileTurnState`), leaving the phone spinning after the answer had
    // arrived. The lifecycle event is the authority; the cache follows it.
    const cached = sessionRowCache.get(item?.sessionId);
    if (cached !== undefined) {
      cached.running = item.phase === 'running' || item.phase === 'waiting';
    }
    const turn = turnEventFor(item);
    if (turn === null) return;
    pushSessionUpdate(turn.payload.sessionId, turn.channel, turn.payload);
  }

  /**
   * Attach or replace the DSH read source.
   *
   * The runtime starts before the source exists (the settings page must work
   * even when this profile exposes no session API), so this is how the
   * projection joins once the supplying plugin activates.
   * @param next - the source, or undefined to detach.
   */
  async function setSource(next) {
    source = next === undefined ? undefined : next;
    if (stopped) return;
    if (projection !== null) {
      const closing = projection;
      projection = null;
      try {
        await closing.stop();
      } catch {
        // Already unreachable; a stop failure cannot make it worse.
      }
    }
    if (active) await ensureProjection();
  }

  /**
   * Wait, then bring the relay up again.
   *
   * A lost socket is **not** a terminal state. The reference here is the Cindy
   * device-link client, which keeps a `connecting` status and retries forever with
   * exponential backoff — the reason a Cindy client "从来没有掉线过". This Host used to
   * report `failed` and stop, which on a phone-controlled Host is a silent outage: the
   * card says 断线 and the handset has no DSH in its device list until a person walks
   * over to the desktop. The manual `/reconnect` route stays as an escape hatch, but it
   * must never be the mechanism.
   *
   * @param reason - what was lost, for the status line.
   */
  function scheduleReconnect(reason) {
    // Never reconnect behind the user's back: an explicit switch-off or a full stop
    // ends the story, and a second timer must not stack on an already-pending one.
    if (stopped || !active || reconnectTimer !== null) return;
    const attempt = reconnectAttempt;
    reconnectAttempt += 1;
    reconnectReason = reason;
    const delay = computeReconnectDelayMs({ attempt, random: Math.random() });
    status.setState('connecting', `${reason}，${Math.ceil(delay / 1_000)}s 后自动重连（第 ${reconnectAttempt} 次）`);
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
    if (typeof reconnectTimer?.unref === 'function') reconnectTimer.unref();
  }

  /** Forget the attempt ladder once a connection has held for the stable window. */
  function markConnectionStable() {
    if (stableTimer !== null) clearTimeoutImpl(stableTimer);
    stableTimer = setTimeoutImpl(() => {
      stableTimer = null;
      reconnectAttempt = 0;
    }, RECONNECT_STABLE_RESET_MS);
    if (typeof stableTimer?.unref === 'function') stableTimer.unref();
  }

  /**
   * Reconnect **now**, because a person asked.
   *
   * The card's button is an escape hatch, not the mechanism: it drops any queued retry and
   * resets the ladder so a host that had backed off to 30s comes back immediately.
   */
  async function reconnectNow() {
    cancelReconnect();
    reconnectAttempt = 0;
    reconnectReason = null;
    await connect();
  }

  /** Cancel a pending retry — the switch was turned off, or the runtime stopped. */
  function cancelReconnect() {
    if (reconnectTimer !== null) {
      clearTimeoutImpl(reconnectTimer);
      reconnectTimer = null;
    }
    if (stableTimer !== null) {
      clearTimeoutImpl(stableTimer);
      stableTimer = null;
    }
  }

  /**
   * Drop a socket and come back on our own.
   *
   * `keepSwitch` is what makes this a retry rather than a shutdown: the user asked for
   * the phone link, and a dead socket is not them changing their mind. The reason is
   * carried through to the card, because "心跳已丢失" and "连接已断开" are different
   * diagnoses for whoever reads the settings page.
   *
   * @param reason - what was lost.
   */
  async function dropAndRetry(reason) {
    await disconnect({ keepSwitch: true });
    scheduleReconnect(reason);
  }

  /** Accept a device as a controller of this Host and reflect it in the status. */
  function linkController(deviceId) {
    const known = status.snapshot().devices.find((device) => device.deviceId === deviceId);
    acceptedControllers.add(deviceId);
    status.upsertDevice(deviceId, { isController: true, linkedAt: now().toISOString(), online: true });
    status.refreshConnectionState();
    // A device that linked with no presence broadcast is a bare id until the
    // directory names it. Ask at most once per device per connection, so a
    // device the directory cannot name does not cost a request per link-open.
    if ((known === undefined || known.platform === null) && !directoryAsked.has(deviceId)) {
      directoryAsked.add(deviceId);
      void refreshDeviceDirectory();
    }
  }

  /**
   * Name the devices we have only seen by id.
   *
   * A device that linked before this Host connected, or one that never sent a
   * presence broadcast, is otherwise shown as a hex prefix. One directory read
   * fixes every such row at once; failures are silent because a missing name
   * only costs a nicer label, never a connection.
   */
  async function refreshDeviceDirectory() {
    if (session === null) return;
    const myGeneration = generation;
    let answer;
    try {
      answer = await listDevices(session, relayUrl);
    } catch {
      return;
    }
    if (stopped || !active || myGeneration !== generation) return;
    const rows = Array.isArray(answer?.devices) ? answer.devices : [];
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue;
      if (typeof row.deviceId !== 'string' || row.deviceId === '' || row.isSelf === true) continue;
      // Only overwrite a field when the directory actually carries one: a
      // presence snapshot already learned may be newer than the stored profile.
      const patch = {};
      const name = typeof row.selfName === 'string' && row.selfName !== '' ? row.selfName : row.name;
      if (typeof name === 'string' && name !== '') patch.name = name;
      if (typeof row.platform === 'string' && row.platform !== '') patch.platform = row.platform;
      if (typeof row.online === 'boolean') patch.online = row.online;
      if (typeof row.lastSeenAt === 'string' && row.lastSeenAt !== '') patch.lastSeenAt = row.lastSeenAt;
      if (Object.keys(patch).length > 0) status.upsertDevice(row.deviceId, patch);
    }
  }

  /**
   * Record a controller's topic choices.
   *
   * Two topics exist: `sessions` for list-level changes, and `session:<id>` for
   * one session's live stream. They are tracked separately because a push must
   * reach exactly the controllers that asked for it — sending a session's
   * transcript to every subscriber would leak one session into another's view.
   */
  function subscribeTopics(deviceId, topics) {
    for (const topic of topics) {
      if (topic === 'sessions') subscribers.add(deviceId);
      else if (topic.startsWith('session:')) {
        const sessionId = topic.slice('session:'.length);
        const devices = sessionSubscribers.get(sessionId) ?? new Set();
        devices.add(deviceId);
        sessionSubscribers.set(sessionId, devices);
        // Remembered beyond the subscription itself: a session a controller has
        // ever attached to belongs to that controller's user, so the questions it
        // asks are theirs to answer even if they have since looked away. See
        // `claimsInteraction`.
        remoteOwnedSessions.add(sessionId);
      }
    }
  }

  function unsubscribeTopics(deviceId, topics) {
    for (const topic of topics) {
      if (topic === 'sessions') subscribers.delete(deviceId);
      else if (topic.startsWith('session:')) {
        const sessionId = topic.slice('session:'.length);
        const devices = sessionSubscribers.get(sessionId);
        if (devices === undefined) continue;
        devices.delete(deviceId);
        if (devices.size === 0) sessionSubscribers.delete(sessionId);
      }
    }
  }

  /** Drop every subscription a device holds, on disconnect. */
  function forgetSubscriptions(deviceId) {
    subscribers.delete(deviceId);
    for (const [sessionId, devices] of sessionSubscribers) {
      devices.delete(deviceId);
      if (devices.size === 0) sessionSubscribers.delete(sessionId);
    }
  }

  /** How many controllers are following one session's live stream. */
  function watchersFor(sessionId) {
    return sessionSubscribers.get(sessionId)?.size ?? 0;
  }

  /**
   * Whether this Host should answer one session's approval or question itself.
   *
   * Claimed when a controller is watching **now**, or when one has watched this
   * session at any point in this process. Anything else is passed down the chain to
   * the desk's own UI, because swallowing a question a person at the desk could
   * answer is worse than not answering it here.
   * @param sessionId - the session the question belongs to.
   * @returns true when this Host owns the card.
   */
  function claimsInteraction(sessionId) {
    return watchersFor(sessionId) > 0 || remoteOwnedSessions.has(sessionId);
  }

  /**
   * Ask the controllers watching a session to decide a DSH approval.
   *
   * Returns `null` when nobody is watching, which is the answerer's cue to call
   * `next()` and let the local UI — or DSH's fail-closed default — decide. A
   * Host must never swallow a question the user could have answered at the desk.
   */
  async function askApproval({ sessionId, toolName, reason, callId, signal }) {
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    if (!claimsInteraction(sessionId)) return null;
    const { request, answered } = await approvals.ask({ sessionId, toolName, reason, callId, signal });
    // `{ sessionId, request }`, **not** the bare request. Both clients read the frame as
    // `payload.sessionId` plus a **nested** `payload.request` and drop anything else in
    // silence:
    //   remoteSessionStore.ts:  const request = isRecord(payload.request) ? payload.request : null;
    //                           if (sessionId && request) applyInteractionRequest(...)
    //   makerChatStore.ts:      const payload = raw as { sessionId?, request?: { requestId?, kind? } }
    // Sending the request flat therefore reached a watching controller and rendered
    // nothing — the card existed on the Host, was pushed to one watcher, and no client
    // ever showed it. `maker:get-pending-interactions` answers this same nested shape,
    // which is why testing through the list hid the bug.
    pushSessionUpdate(sessionId, 'maker:interaction-request', { sessionId, request });
    return answered;
  }

  /** Answer one pending interaction on the controller's behalf. */
  function resolveInteraction(requestId, decision) {
    return approvals.settle(requestId, decision);
  }

  /**
   * Ask the controllers watching a session a structured question.
   *
   * DSH's `user-questions/request` waterfall blocks the tool call until this
   * resolves, so an unanswered question does not degrade the conversation — it
   * stops it. The answerer therefore only claims questions for a session a
   * controller is actually watching, and passes every other one down the chain
   * so the local UI can answer it.
   *
   * Returns `null` when nobody is watching, which is the answerer's cue to call
   * `next()`.
   */
  async function askUserQuestion({ sessionId, questions, signal }) {
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    if (!claimsInteraction(sessionId)) return null;
    const { request, answered } = await approvals.askUser({ sessionId, questions, signal });
    // Same nested shape as `askApproval` above, for the same reason.
    pushSessionUpdate(sessionId, 'maker:interaction-request', { sessionId, request });
    return answered;
  }

  /**
   * Push one session-scoped event to the controllers watching that session.
   * @param sessionId - the session the event belongs to.
   * @param channel - the push channel.
   * @param payload - the channel's payload.
   */
  function pushSessionUpdate(sessionId, channel, payload) {
    const devices = sessionSubscribers.get(sessionId);
    const watchers = devices === undefined ? 0 : devices.size;
    recordPush(sessionId, channel, watchers, payload);
    if (watchers === 0) return;
    for (const deviceId of devices) {
      send({ v: PROTOCOL_VERSION, kind: 'push', dst: deviceId, payload: { channel, payload } });
    }
  }

  /**
   * Push one live message to the controllers watching that session.
   *
   * The payload is exactly what the controller's `local-db:messages:created`
   * handler reads — `{ sessionId, message }` — so a live append and a transcript
   * read produce identical rows.
   */
  function pushSessionMessage(sessionId, message) {
    pushSessionUpdate(sessionId, 'local-db:messages:created', { sessionId, message });
  }

  /**
   * Serve one invoke.
   *
   * Channels that need the DSH corpus answer `NOT_AVAILABLE` when this profile
   * exposes no session API, rather than letting a missing source surface as an
   * opaque failure — the controller can tell "no capability" from "it broke".
   */
  /**
   * The most recent source listing, keyed by id.
   *
   * The input projection needs each session's working directory, which the read
   * model does not carry; caching the listing keeps that free rather than paying
   * a second corpus read per projection request.
   */
  const sessionRowCache = new Map();
  function sessionRowFor(sessionId) {
    return sessionRowCache.get(sessionId);
  }

  const routeInvoke = createChannelRouter({
    listSessions: async () => {
      if (source === undefined || source === null) throw new Error('no DSH session source is attached');
      const rows = await source.listSessions();
      // The archive/delete/pin flags ride the source row's `status`/`pinnedAt`, which
      // is how they reach the wire row (`cindy-session-row.js`) at every read path —
      // list, get, and the row echoed back to a writer.
      const flagged = sessionFlags.projectAll(rows);
      sessionRowCache.clear();
      for (const row of flagged) sessionRowCache.set(String(row.id), row);
      return flagged;
    },
    /**
     * The same sessions, without the expensive half.
     *
     * `maker:list-active` and `maker:session-in-turn` only ask whether a turn is running,
     * and the controller polls them hard. Reading them through the full row fold made the
     * cheapest question on this Host pay the dearest read — measured 8.4s against a
     * profile with 219 sessions, in front of a handset that gives up at 15s, which is
     * exactly what "电脑暂时没有回应请求" looked like from the outside. A source without
     * the cheap read (the fixture used by tests) falls back to the full list, so a source
     * is never required to provide it.
     */
    listSessionStates: async () => {
      if (source === undefined || source === null) throw new Error('no DSH session source is attached');
      const rows = typeof source.listSessionStates === 'function' ? await source.listSessionStates() : await source.listSessions();
      return sessionFlags.projectAll(rows);
    },
    // Resolved per request. The approval pair lives here because the registry is
    // this runtime's own; everything else comes from the plugin, whose DSH
    // services may activate after this runtime is built.
    resolveCapabilities: () => {
      const provided = typeof options.resolveCapabilities === 'function' ? options.resolveCapabilities() : {};
      return {
        listPendingInteractions: (sessionId) => approvals.list(sessionId),
        resolveInteraction: (requestId, decision) => approvals.settle(requestId, decision),
        // The archive/delete/pin writes, and the one reader that decides whether a
        // session still belongs on the controller's live surfaces.
        applySessionFlags: (sessionId, patch) => sessionFlags.apply(sessionId, patch),
        sessionHidden: (sessionId) => sessionFlags.isHidden(sessionId),
        publishSessionMeta,
        // The controller's only way to *see* a file that lives on this machine: an image
        // the agent produced, or one picked in the file browser. Host-owned because the
        // upload needs this runtime's account session.
        exportFileStart: startFileExport,
        exportFileStatus: fileExportStatus,
        // The chat-image path: the controller names a file on this machine (an image the
        // agent drew, referenced by path) and gets a staged key back.
        fetchLocalMedia,
        // The work-grouped history window (`local-db:messages:view` and its two siblings):
        // what lets the controller keep a projection across re-entries instead of
        // re-deriving continuity from 20-row pages and dropping what it cannot prove.
        historyView: provided.historyView ?? null,
      inputProjection: (sessionId, pending) => inputQueue.projectionFor(sessionId, sessionRowFor(sessionId), pending ?? null),
      queuedRow: ({ clientId, text, sessionId }) => queuedRowFromController({ clientId, text, session: sessionRowFor(sessionId) }),
      goalStatus: (sessionId) => toGoalStatusPayload(sessionId, projections.goalOf(sessionId)),
      /**
       * The queue's locally-owned half.
       *
       * Every committed queue mutation is folded here as well as in DSH: the
       * service's own `queue` frame trails the commit, so answering the
       * controller from the un-mirrored fold would hand back the row it just
       * deleted. The controller's expanded/lock flags live only here — they are
       * queue state that the controller reads back out of the projection.
       */
      queueMirror: {
        has: (sessionId, itemId) => inputQueue.hasItem(sessionId, itemId),
        dshItemId: (sessionId, controllerId) => inputQueue.dshItemId(sessionId, controllerId),
        mirror: (sessionId, itemId, action) => inputQueue.mirror(sessionId, itemId, action),
        moveItem: (sessionId, itemId, targetIndex) => inputQueue.moveItem(sessionId, itemId, targetIndex),
        setExpanded: (sessionId, expanded) => inputQueue.setExpanded(sessionId, expanded),
        setEditLock: (sessionId, clientId, locked) => inputQueue.setEditLock(sessionId, clientId, locked),
        setInteractionLock: (sessionId, lockId, locked) => inputQueue.setInteractionLock(sessionId, lockId, locked),
        clearSession: (sessionId) => inputQueue.clearSession(sessionId),
        adopt: (sessionId, items) => inputQueue.adopt(sessionId, items),
        itemIds: (sessionId) => inputQueue.itemIds(sessionId),
      },
      /** Project a queue DSH actually reported, rather than the folded one. */
      projectionFromItems: (sessionId, items, pending = null) => inputQueue.projectionFor(sessionId, sessionRowFor(sessionId), pending, items),
      /**
       * Tell every watcher what the queue looks like now.
       *
       * A queue command answers the controller that sent it, but a second screen
       * watching the same session has no reason to ask again — without this it
       * keeps rendering a row the user just deleted.
       */
      pushInputProjection: (sessionId) => pushSessionUpdate(sessionId, 'maker:input:projection', inputQueue.projectionFor(sessionId, sessionRowFor(sessionId))),
      /**
       * Whether a turn is live for this session.
       *
       * It decides whether an accepted prompt queues or is admitted immediately,
       * which is the difference between showing a 队列中 row and inventing one.
       */
      isSessionRunning: (sessionId) => sessionRowFor(sessionId)?.running === true,
      /**
       * Tell a session's watchers the turn is over.
       *
       * The controller starts its spinner optimistically when it sends, and only
       * an explicit terminal `maker:event` or an explicit `isTurnRunning: false`
       * snapshot clears it — a *missing* session in `maker:list-active` is
       * deliberately not treated as idle. So an action whose turn never started
       * (a refused steer, a prompt that failed) left the phone spinning with
       * nothing on the Host to correct it. This is that correction.
       */
      pushTurnIdle: (sessionId) => announceTurnIdle(sessionId),
      /**
       * Tell a session's watchers the turn is live.
       *
       * The counterpart of {@link pushTurnIdle}, and what makes attaching
       * authoritative in both directions: a controller that reconnects into a
       * running turn must be told so rather than left to infer it from silence.
       */
      pushTurnRunning: (sessionId) => announceTurnRunning(sessionId),
      // The controller's goal panel refreshes from this push, so a write made on
      // the phone reaches any other screen watching the same session.
      pushGoalStatus: (sessionId, status) => pushSessionUpdate(sessionId, 'maker:goal:status-changed', { sessionId, goal: status }),
      ...provided,
      /**
       * The plugin's send seam, carrying this Host's media access.
       *
       * An attachment the controller uploaded is fetched with *this runtime's*
       * account session (see {@link createMediaRefResolver}), and only this runtime
       * holds it — so the seam is handed the two media functions rather than
       * resolving the credential again somewhere else. The wrap is deliberate: the
       * seam stays the plugin's, and nothing here knows how a prompt is built.
       */
      ...(typeof provided.sendMessage === 'function'
        ? { sendMessage: (input) => provided.sendMessage({ ...input, resolveAttachmentRef, releaseAttachmentRef }) }
        : {}),
      };
    },
    subscribers,
    onSubscribe: subscribeTopics,
    onUnsubscribe: unsubscribeTopics,
    now,
    // Every row must name the device it came from, or the phone's home filter
    // drops it as soon as the user selects this Host.
    getDevice: () => ({ deviceId: status.ownDeviceId, deviceName: HOST_DEVICE_NAME }),
  });

  /**
   * What this Host actually pushed, most recent last.
   *
   * `pushSessionUpdate` returns silently when nobody is watching, so "the phone
   * never updated" has two indistinguishable causes from the outside: no
   * controller held the topic, or the frame went out and the controller dropped
   * it. Recording the destination count separates them without guessing.
   */
  /** How long to wait before deciding a finished turn will never say so itself. */
  const TURN_RECONCILE_MS = 1500;

  const pushLog = [];
  /**
   * How many pushes the ring keeps.
   *
   * Forty was too few to read a single turn back: a turn appends dozens of events
   * and pushes a message row for several of them, so the frames that explain the
   * beginning were evicted before anyone could look — the `status isRunning:true`
   * that opens a turn disappeared while the `done` frames that followed stayed.
   */
  const PUSH_LOG_LIMIT = 200;
  /**
   * How many pushes of each channel this Host has sent, since start.
   *
   * The ring above is bounded and churns during a busy turn, so a count taken
   * from it can go *down* — which makes it useless as evidence that a push
   * happened. A monotonic tally answers the only question worth asking: did this
   * channel ever fire, and is it still firing.
   */
  const pushTotals = new Map();
  /**
   * How many times each invoke channel has been served, and how many refusals each
   * has produced, since start.
   *
   * Same reasoning as `pushTotals`, for the request direction: the invoke ring holds
   * forty entries and churns within seconds while a controller polls a transcript,
   * so "did the phone ever call this channel?" — the question that decides whether a
   * feature is exercised or merely implemented — cannot be answered from it. A
   * monotonic tally can, and it makes channel coverage measurable instead of
   * assumed.
   */
  const invokeTotals = new Map();
  const refusalTotals = new Map();
  /**
   * Pending "did this turn really end?" checks, one per session.
   *
   * Kept so a turn that announces its own end cancels the fallback instead of
   * being followed by a duplicate `done`, and so dozens of appended events do not
   * arm dozens of timers.
   */
  const pendingReconciles = new Map();

  /**
   * Keep the cached row's turn state in step with an authoritative boundary.
   *
   * `isSessionRunning` and the reconcile fallback both read this cache, and the
   * cache is only refreshed by a **list read** — which a controller sitting inside
   * one session may not cause for minutes. So the cache is fed by every authority
   * instead: DSH's `turn/start` and `turn/end` (the real boundaries) and the
   * lifecycle events. Leaving `turn/start` out was measurable: the cached flag
   * stayed at the flapping `api-session/status(false)`, the 1.5s fallback then
   * decided the turn was over, and a `done` went out 116 ms *before* the
   * assistant's message was appended.
   * @param sessionId - the session whose turn state changed.
   * @param running - whether a turn is live.
   */
  function setCachedRunning(sessionId, running) {
    const cached = sessionRowCache.get(sessionId);
    if (cached !== undefined) cached.running = running === true;
  }

  /**
   * Announce the end of a turn, and retire any pending fallback for it.
   *
   * A `done` is not idempotent for the controller: it finalizes streaming rows,
   * clears the reconnect state and drops the input-projection continuation owner.
   * Sending it twice is not free, and sending it when the turn ended on its own is
   * pure noise.
   * @param sessionId - the session whose turn ended.
   */
  function announceTurnIdle(sessionId) {
    const timer = pendingReconciles.get(sessionId);
    if (timer !== undefined) {
      pendingReconciles.delete(sessionId);
      if (typeof clearTimeoutImpl === 'function') clearTimeoutImpl(timer);
    }
    setCachedRunning(sessionId, false);
    pushSessionUpdate(sessionId, 'maker:event', { sessionId, event: { type: 'done' } });
    // …and, when nobody is watching, to the controllers that could still be waiting.
    //
    // A controller whose subscription died with the process (a Host restart, a reconnect)
    // shows 思考中 for a turn that is over and has no way to learn otherwise — its
    // watchdog only ever answers "is a turn running", and a missing session is
    // deliberately not read as idle. The frame carries nothing but the turn's end, and it
    // only goes out when the session has no watchers (with watchers the line above already
    // reached everyone who asked), so this cannot duplicate work or leak content.
    if (watchersFor(sessionId) === 0 && acceptedControllers.size > 0 && acceptedControllers.size <= MAX_TURN_ANNOUNCE) {
      const payload = { sessionId, event: { type: 'done' } };
      recordPush(sessionId, 'maker:event', acceptedControllers.size, payload);
      for (const deviceId of acceptedControllers) {
        send({ v: PROTOCOL_VERSION, kind: 'push', dst: deviceId, payload: { channel: 'maker:event', payload } });
      }
    }
    publishRowTurnState(sessionId, false);
  }

  /**
   * How many controllers one unwatched turn boundary may be fanned out to.
   *
   * The announcement above is a repair for a lost subscription, not a broadcast channel:
   * a Host with more controllers than this simply keeps the old behaviour for them (their
   * next read corrects it), rather than turning every turn boundary into a fan-out.
   */
  const MAX_TURN_ANNOUNCE = 8;

  /**
   * Patch one session row's turn flag, for every holder of that row.
   *
   * The session-scoped `maker:event` reaches a controller that is *viewing* the
   * session. A **list** spinner reads the row instead, and the row only changes when
   * something patches it: our `local-db:sessions:patched` push carried `updatedAt`
   * alone, so a controller holding the row kept `running: true` from the optimistic
   * start and spun on it — the reported "agent 已经结束了，但我这边还是显示 思考中",
   * both after a normal turn and after a goal round finished.
   *
   * Published at the same two moments as the `maker:event` frame (DSH's own
   * `turn/start` / `turn/end` boundaries), never from the flapping `idle` phase: the
   * row must not assert a turn state the Host cannot stand behind. Both directions of
   * the wire are covered — the `sessions` topic for list holders, and this session's
   * watchers for a header that reads its own row.
   * @param sessionId - the session whose row to patch.
   * @param running - the turn state DSH just reported.
   */
  function publishRowTurnState(sessionId, running) {
    publishRowPatch(sessionId, { running, updatedAt: now().toISOString() });
  }

  /**
   * Send one session row patch to every controller holding that row.
   *
   * Delivered once per controller, not once per topic: a controller looking at one
   * session holds both topics, and the row patch is a state assertion rather than an
   * event, so the same reader receiving it twice is pure duplicate work — and it is
   * what made "one patch per turn boundary" unverifiable from the frame log.
   * @param sessionId - the session whose row changed.
   * @param patch - the fields the controller's `local-db:sessions:patched` handler applies.
   */
  function publishRowPatch(sessionId, patch) {
    const payload = { sessionId, patch };
    const devices = new Set(subscribers);
    for (const deviceId of sessionSubscribers.get(sessionId) ?? []) devices.add(deviceId);
    recordPush(sessionId, 'local-db:sessions:patched', devices.size, payload);
    if (devices.size === 0) return;
    for (const dst of devices) send({ v: PROTOCOL_VERSION, kind: 'push', dst, payload: { channel: 'local-db:sessions:patched', payload } });
  }

  /**
   * Tell the controllers holding this session's row about an archive/delete/pin write.
   *
   * The writer already applied the change optimistically and gets this echo too —
   * `sessionPendingWrites.consumeMaskedPush` exists on the controller for exactly
   * that — while every *other* linked device would otherwise keep the stale status
   * until its next list read.
   * @param sessionId - the session the controller edited.
   * @param patch - the fields the controller wrote, with this Host's effective values.
   */
  function publishSessionMeta(sessionId, patch) {
    publishRowPatch(sessionId, { ...patch, updatedAt: now().toISOString() });
  }

  /**
   * Tell one controller which sessions are in a turn right now.
   *
   * A controller that has just re-linked knows nothing about this Host's live state, and
   * its view of a session is otherwise only corrected by a push it can no longer receive
   * (subscriptions die with the process). Reported as 手机一直显示思考中，5 分钟都没抓到最新
   * 的信息, right after a Host restart: the session was genuinely running, the phone was
   * never told, and nothing could ever end the spinner it already had.
   *
   * Bounded by construction: only sessions currently in a turn, and only to the one device
   * that just linked.
   * @param deviceId - the controller that re-linked.
   */
  async function announceRunningSessions(deviceId) {
    let rows;
    try {
      rows = await listSessionRowsForAnnouncement();
    } catch {
      return;
    }
    const running = rows.filter((row) => row?.running === true && !sessionFlags.isHidden(row.id));
    if (running.length === 0) return;
    for (const row of running) {
      const payload = { sessionId: String(row.id), event: { type: 'status', data: { isRunning: true } } };
      recordPush(String(row.id), 'maker:event', 1, payload);
      send({ v: PROTOCOL_VERSION, kind: 'push', dst: deviceId, payload: { channel: 'maker:event', payload } });
    }
  }

  /** The current listing, for the re-link announcement; the cache when the source is away. */
  async function listSessionRowsForAnnouncement() {
    if (source !== undefined && source !== null) {
      const rows = typeof source.listSessionStates === 'function' ? await source.listSessionStates() : await source.listSessions();
      return Array.isArray(rows) ? rows : [];
    }
    return [...sessionRowCache.values()];
  }

  /**
   * Announce that a turn is live.
   * @param sessionId - the session whose turn started.
   */
  function announceTurnRunning(sessionId) {
    setCachedRunning(sessionId, true);
    pushSessionUpdate(sessionId, 'maker:event', { sessionId, event: { type: 'status', data: { isRunning: true } } });
    publishRowTurnState(sessionId, true);
  }

  /**
   * A bounded, decision-shaped digest of one pushed payload.
   *
   * The channel and the watcher count answer "did it go out"; they cannot answer
   * "what did it say, and in what order". A controller that keeps spinning after
   * the answer arrived has two possible causes — the terminal event never fired,
   * or it fired and a later frame lit the state back up — and those are
   * indistinguishable without the payload. Only the fields that decide the
   * controller's own branches are kept, and each is truncated: this is evidence,
   * not a data dump.
   * @param channel - the push channel.
   * @param payload - the pushed payload.
   * @returns a short summary string.
   */
  function payloadDigest(channel, payload) {
    const clamp = (value) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      return typeof text === 'string' && text.length > 160 ? `${text.slice(0, 160)}…` : text;
    };
    if (payload === null || typeof payload !== 'object') return clamp(payload);
    if (channel === 'maker:event') {
      const event = payload.event ?? {};
      // `type` is the branch the controller switches on: a non-terminal event
      // clears its reconnect state, `done` is what retires the spinner.
      const data = event.data !== null && typeof event.data === 'object' ? event.data : {};
      return clamp({ type: event.type, isRunning: data.isRunning, status: data.status, turnContinuationId: event.turnContinuationId });
    }
    if (channel === 'local-db:messages:created') {
      const message = payload.message ?? {};
      // `role` + `kind` decide which card the row becomes, and `isStreaming`
      // decides whether that card keeps ticking.
      return clamp({ id: message.clientId ?? message.id, role: message.role, kind: message.kind, isStreaming: message.isStreaming, text: typeof message.content?.text === 'string' ? message.content.text.slice(0, 40) : undefined });
    }
    if (channel === 'maker:goal:status-changed') {
      const goal = payload.goal ?? {};
      return clamp({ status: goal.status, objective: goal.objective, maxTurns: goal.maxTurns, turnsUsed: goal.turnsUsed });
    }
    if (channel === 'local-db:sessions:activity') return clamp({ phase: payload.phase, attention: payload.attention });
    if (channel === 'local-db:sessions:patched') return clamp({ patch: payload.patch });
    return clamp(payload);
  }

  function recordPush(sessionId, channel, watchers, payload) {
    const name = typeof channel === 'string' ? channel : null;
    if (name !== null) pushTotals.set(name, (pushTotals.get(name) ?? 0) + 1);
    pushLog.push({
      at: now().toISOString(),
      sessionId: typeof sessionId === 'string' ? sessionId : null,
      channel: name,
      watchers,
      // The digest is what turns "the spinner stayed on" into a readable
      // sequence: which frames went out, in which order, saying what.
      said: payload === undefined ? null : payloadDigest(name, payload),
    });
    if (pushLog.length > PUSH_LOG_LIMIT) pushLog.splice(0, pushLog.length - PUSH_LOG_LIMIT);
  }

  /**
   * What this Host actually answered, most recent last.
   *
   * A controller's view is invisible from here, so "the phone shows nothing" has
   * three very different causes — the channel was never asked for, we refused it,
   * or we answered with something unusable. Only the channel name, outcome, and
   * reply size are kept; no payload ever enters this log.
   */
  const invokeLog = [];
  const INVOKE_LOG_LIMIT = 40;
  /**
   * Every refusal, kept separately and for far longer than the successes.
   *
   * A polling controller fills the ring in seconds — the phone re-reads
   * `local-db:messages:list` on every screen tick — so the one refused channel
   * that explains "host failed to serve this channel" is evicted long before
   * anyone looks. Refusals are rare and are the only entries that need to
   * survive.
   */
  const refusalLog = [];
  const REFUSAL_LOG_LIMIT = 60;
  /** Longest reply excerpt kept for a corpus read; enough to compare fields, not a data dump. */
  const INVOKE_PREVIEW_CHARS = 1200;
  const PREVIEW_CHANNELS = new Set([
    'local-db:sessions:list',
    'local-db:sessions:get',
    'maker:list-active',
    // The palette lists. Whether the controller renders a skill row depends on the
    // *shape* this Host sends (`{ success, skills: [{ kind: 'agent-skill', … }] }`)
    // and on it asking about a session at all — a bounded preview is the only way
    // to tell "we sent nothing" from "the phone dropped a correct list".
    'maker:list-agent-skills',
    'maker:list-agent-commands',
  ]);

  function recordInvoke(channel, reply, failure, src, ask = null) {
    const result = reply?.payload?.result;
    // Two reply families carry their list inside an envelope rather than as the
    // result itself, so "how many rows did we send" needs its own read.
    const enveloped = Array.isArray(result?.skills) ? result.skills
      : Array.isArray(result?.commands) ? result.commands
        : null;
    const entry = {
      at: now().toISOString(),
      channel: typeof channel === 'string' ? channel : null,
      // What was asked, for the channels where the question decides the answer.
      ask: typeof ask === 'string' ? ask : null,
      // Which device asked. Without this, polling from another linked computer
      // is indistinguishable from polling by the phone the user is holding —
      // and "the phone shows nothing" becomes unattributable.
      src: typeof src === 'string' ? src : null,
      ok: failure === undefined && reply !== null && reply?.payload?.ok === true,
      code: failure !== undefined ? 'THREW' : (reply?.payload?.ok === true ? null : (reply?.payload?.error?.code ?? 'NO_REPLY')),
      // Reply size is the cheapest signal that we answered with a list rather
      // than an empty envelope.
      bytes: reply === null ? 0 : JSON.stringify(reply).length,
      items: enveloped !== null ? enveloped.length : (Array.isArray(result) ? result.length : null),
      // A controller's view is invisible from the Host, so the row we actually
      // sent is the only way to tell "we sent the wrong shape" from "the phone
      // dropped a correct shape". Bounded, and only for corpus reads — the
      // settings page's own API carries no session data.
      preview: PREVIEW_CHANNELS.has(channel) && result !== undefined && reply?.payload?.ok === true
        ? JSON.stringify(result).slice(0, INVOKE_PREVIEW_CHARS)
        : null,
      detail: failure === undefined ? null : describeFailure(failure),
    };
    invokeLog.push(entry);
    if (invokeLog.length > INVOKE_LOG_LIMIT) invokeLog.splice(0, invokeLog.length - INVOKE_LOG_LIMIT);
    // Monotonic, so the ring above can churn without the evidence going with it.
    const served = typeof channel === 'string' ? channel : '<none>';
    invokeTotals.set(served, (invokeTotals.get(served) ?? 0) + 1);
    if (entry.ok === false) {
      refusalTotals.set(served, (refusalTotals.get(served) ?? 0) + 1);
      refusalLog.push(entry);
      if (refusalLog.length > REFUSAL_LOG_LIMIT) refusalLog.splice(0, refusalLog.length - REFUSAL_LOG_LIMIT);
    }
  }

  /**
   * Describe a failure well enough to act on.
   *
   * The message alone is not enough: a phone asked for `maker:input:steer` and
   * the log recorded `THREW` with an empty detail, which says only that
   * *something* went wrong. The error's name, its own `code`, and the first
   * stack frame are what locate the throw.
   * @param failure - whatever was thrown.
   * @returns a bounded one-line description.
   */
  function describeFailure(failure) {
    if (failure === null || failure === undefined) return 'threw a falsy value';
    const name = typeof failure?.name === 'string' && failure.name !== '' ? failure.name : typeof failure;
    const code = typeof failure?.code === 'string' && failure.code !== '' ? ` code=${failure.code}` : '';
    const message = typeof failure?.message === 'string' && failure.message !== '' ? failure.message : String(failure);
    const frame = typeof failure?.stack === 'string'
      ? failure.stack.split('\n').slice(1).find((line) => line.trim() !== '') ?? ''
      : '';
    return `${name}${code}: ${message}${frame === '' ? '' : ` @${frame.trim()}`}`.slice(0, 240);
  }

  /**
   * What the controller asked for, as far as it is safe and useful to record.
   *
   * The reply side alone cannot explain a bad page: "0 rows" is the correct
   * answer for a cursor past the start of the transcript and a bug for a cursor
   * the controller computed itself. A paging cursor is the exact value that
   * decides which, so it is kept — bounded, and only for reads the controller
   * paginates.
   */
  function askOf(channel, args) {
    // Which harness the controller is asking about decides the answer: this Host
    // offers exactly one, so a refusal here means "you asked for a kind that does
    // not exist" — and without the kind that refusal is indistinguishable from a
    // broken catalog.
    if (channel === 'maker:get-capabilities') {
      return `agentKind=${typeof args?.[0] === 'string' ? args[0] : 'none'}`;
    }
    // The composer palettes decide their answer from the *viewing session*: skills
    // and commands live in layered registries that answer per agent, so a request
    // without a session names the global layer alone and comes back empty on a
    // profile whose skills are all registered by a preset. Recording which session
    // was asked about — and the working directory, which selects project roots —
    // is what makes "the menu is empty" a fact instead of a guess.
    if (channel === 'maker:list-agent-skills' || channel === 'maker:list-agent-commands') {
      const options = args?.[1] !== null && typeof args?.[1] === 'object' ? args[1] : null;
      const sessionId = typeof options?.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : 'none';
      const cwd = typeof options?.workingDir === 'string' && options.workingDir !== '' ? 'yes' : 'no';
      return `agentKind=${typeof args?.[0] === 'string' ? args[0] : 'none'} sessionId=${sessionId} cwd=${cwd}`;
    }
    // Attachments arrive on the send paths and split into two forms: a path on
    // this machine (readable, becomes a durable attachment) and a transit reference
    // to the account's OSS staging area, whose bytes this Host fetches with its own
    // credential. Recording which forms arrived is what makes "the agent could not
    // see my image" answerable from diagnostics.
    //
    // Both reference schemes count as the reference form. The phones send the
    // **legacy** `xdt-oss-attach://` one, so a classifier that knew only the current
    // scheme reported a photographed page as `form=host-paths` — which is exactly
    // how a live attachment failure was first misread as "the phone never sent".
    if (channel === 'maker:send' || channel === 'maker:input:enqueue' || channel === 'maker:input:steer') {
      const files = Array.isArray(args?.[1]?.files) ? args[1].files : [];
      if (files.length === 0) return null;
      const refs = files.filter((file) => isAttachmentOssRef(file?.path)).length;
      const form = refs === files.length ? 'oss-refs' : refs === 0 ? 'host-paths' : 'mixed';
      return `attachments=${files.length} form=${form}`;
    }
    if (channel !== 'local-db:messages:list') return null;
    // Which session is being read matters as much as the cursor: two sessions
    // with very different transcripts produce very different pages, and without
    // the id a short page is unattributable.
    const sessionId = typeof args?.[0] === 'string' ? args[0] : '?';
    const options = Array.isArray(args) && args[1] !== null && typeof args[1] === 'object' ? args[1] : null;
    const limit = Number.isFinite(options?.limit) ? options.limit : null;
    const before = typeof options?.before === 'string' ? options.before : null;
    return `${sessionId} limit=${limit === null ? 'default' : limit} before=${before === null ? 'none' : before}`;
  }

  async function handleInvoke(frame) {
    const channel = frame?.payload?.channel;
    const ask = askOf(channel, frame?.payload?.args);
    const needsCorpus = channel === 'local-db:sessions:list' || channel === 'local-db:sessions:get' || channel === 'maker:list-active' || channel === 'local-db:messages:list';
    if (needsCorpus && (source === undefined || source === null)) {
      const reply = invokeError(frame, 'NOT_AVAILABLE', 'This DSH profile exposes no session API');
      recordInvoke(channel, reply, undefined, frame?.src, ask);
      return reply;
    }
    try {
      const reply = await routeInvoke(frame);
      recordInvoke(channel, reply, undefined, frame?.src, ask);
      return reply;
    } catch (failure) {
      recordInvoke(channel, null, failure, frame?.src, ask);
      throw failure;
    }
  }

  /**
   * Make one reply fit the relay's frame ceiling before it is sent.
   *
   * The device-link contract is explicit about who owes what here: the controlled end
   * degrades a message page (content truncation → placeholder → row trimming, each
   * marked so the controller keeps its "load earlier" affordance) and answers
   * everything else with a compact `PAYLOAD_TOO_LARGE` refusal, because an oversized
   * frame 「控制端收不到任何 invoke-result,只能干等 30s 超时」
   * (`apps/desktop/src/main/device-link/dispatch.ts`). Without this, a page carrying a
   * large tool output or an inlined photo simply never arrives — reported from the
   * handset as 历史消息全部消失、重新加载更早消息也没有响应.
   *
   * @param reply - the frame `routeInvoke` produced.
   * @param requestFrame - the inbound invoke, for its channel.
   * @returns the frame to send.
   */
  function fitReplyToFrame(reply, requestFrame) {
    const channel = typeof requestFrame?.payload?.channel === 'string' ? requestFrame.payload.channel : null;
    const fitted = fitInvokeResultToFrame({
      reply,
      request: { id: reply?.id, src: reply?.dst },
      channel,
    });
    if (fitted.level === 'fits') return reply;
    frameDegradations.push({
      at: now().toISOString(),
      channel,
      level: fitted.level,
      rows: fitted.rows,
      bytes: Math.round(fitted.bytes),
    });
    if (frameDegradations.length > FRAME_REFUSAL_LOG_LIMIT) {
      frameDegradations.splice(0, frameDegradations.length - FRAME_REFUSAL_LOG_LIMIT);
    }
    if (fitted.level === 'refused') frameRefusalTotal += 1;
    return fitted.reply;
  }

  function handleFrame(frame) {
    if (frame === null || typeof frame !== 'object') return;
    // **Any** inbound frame proves the link is alive, not just a `pong`.
    //
    // The Cindy client states the rule for its own watchdog ("入站业务流量会把这组计数
    // 清零"), and the difference is not academic: a relay that keeps delivering presence
    // and invoke frames while answering pings late — or not at all for a few periods —
    // would otherwise be declared dead and torn down mid-conversation.
    pongMisses = 0;
    switch (frame.kind) {
      case 'hello-ack': {
        const payload = frame.payload ?? {};
        status.setHost({
          deviceId: typeof payload.deviceId === 'string' ? payload.deviceId : null,
          userId: typeof payload.userId === 'string' ? payload.userId : null,
          protocolVersion: typeof payload.serverProtocolVersion === 'number' ? payload.serverProtocolVersion : null,
        });
        status.setState('waiting');
        // The relay itself accepted us, which is the first moment "online" is true —
        // so this is where the reconnect ladder starts forgetting failed attempts.
        markConnectionStable();
        // Devices already online for this account never re-announce themselves.
        void refreshDeviceDirectory();
        return;
      }
      case 'pong':
        pongMisses = 0;
        return;
      case 'ping':
        send({ v: PROTOCOL_VERSION, kind: 'pong' });
        return;
      case 'presence-changed': {
        const snapshot = frame.payload ?? {};
        if (typeof snapshot.deviceId !== 'string' || snapshot.deviceId === '') return;
        if (snapshot.deviceId === status.ownDeviceId) return;
        status.upsertDevice(snapshot.deviceId, {
          name: typeof snapshot.selfName === 'string' && snapshot.selfName !== '' ? snapshot.selfName : snapshot.deviceName,
          platform: typeof snapshot.platform === 'string' ? snapshot.platform : null,
          online: snapshot.online === true,
          lastSeenAt: typeof snapshot.lastSeenAt === 'number' ? new Date(snapshot.lastSeenAt).toISOString() : null,
        });
        return;
      }
      case 'link-open': {
        if (typeof frame.id !== 'string' || typeof frame.src !== 'string') return;
        if (!policy.canAccept(frame.src)) return;
        linkController(frame.src);
        send(acceptLink(frame, acceptedControllers));
        // A controller that has just re-linked knows nothing about this Host's live state.
        //
        // Subscriptions live in this process's memory, so a Host restart (or any reconnect)
        // empties them while the controller still believes it is inside a session. The
        // result was reported as 手机一直显示思考中，5 分钟都没抓到最新的信息: no live rows,
        // and — worse — no terminal `maker:event`, so the spinner had nothing to end it.
        // Tell the controller directly which sessions are running right now; the set is
        // bounded by the sessions actually in a turn, and the frame is session-scoped, so
        // it lands on the row the controller already holds.
        void announceRunningSessions(frame.src);
        return;
      }
      case 'link-close': {
        if (typeof frame.src !== 'string') return;
        acceptedControllers.delete(frame.src);
        status.upsertDevice(frame.src, { isController: false });
        status.refreshConnectionState();
        return;
      }
      case 'invoke': {
        if (typeof frame.id !== 'string' || typeof frame.src !== 'string') return;
        if (!policy.canAccept(frame.src)) {
          send({
            v: PROTOCOL_VERSION,
            kind: 'invoke-result',
            id: frame.id,
            dst: frame.src,
            payload: { ok: false, error: { code: 'CHANNEL_NOT_ALLOWED', message: 'This device is not authorized on the DSH Host' } },
          });
          return;
        }
        // Listing-only controllers never send `link-open`; an invoke is itself
        // proof that the phone reached this Host, so it links the device too.
        if (!acceptedControllers.has(frame.src)) linkController(frame.src);
        void handleInvoke(frame).then(
          (reply) => {
            // `null` means the request was unaddressable; the relay guard above
            // already rejects those, so this only defends the invariant.
            if (reply !== null) send(fitReplyToFrame(reply, frame));
          },
          () => send({ v: PROTOCOL_VERSION, kind: 'invoke-result', id: frame.id, dst: frame.src, payload: { ok: false, error: { code: 'INTERNAL', message: 'DSH Host failed to serve this channel' } } }),
        );
        return;
      }
      case 'relay-error': {
        const payload = frame.payload ?? {};
        const code = typeof payload.code === 'string' && payload.code !== '' ? payload.code : 'UNKNOWN';
        const message = typeof payload.message === 'string' && payload.message !== '' ? payload.message : `Cindy relay 返回错误：${code}`;
        // Only a protocol mismatch means this Host cannot be talked to. The rest
        // are per-request outcomes — `DEVICE_OFFLINE` says one push had no live
        // recipient, which is ordinary when a phone locks its screen. Treating
        // those as `failed` would tell the phone this Host is gone while its
        // relay link is perfectly healthy.
        if (code === 'VERSION_MISMATCH') status.setState('failed', message);
        else status.setState(status.snapshot().state, message);
        return;
      }
      default:
        // Unknown kinds are ignored, which is what lets the relay protocol grow.
        return;
    }
  }

  function wireSocket(socket, myGeneration) {
    socket.on('open', () => {
      if (myGeneration !== generation) return;
      send({
        v: PROTOCOL_VERSION,
        kind: 'hello',
        payload: {
          deviceName: HOST_DEVICE_NAME,
          platform: HOST_PLATFORM,
          appVersion: HOST_APP_VERSION,
          // The relay refuses to route link-open/invoke to a target that did not
          // advertise this, so it carries exactly the user's own opt-in.
          remoteControlEnabled: policy.isEnabled(),
          busy: false,
        },
      });
      startHeartbeat();
    });
    socket.on('message', (data) => {
      if (myGeneration !== generation) return;
      let frame;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      handleFrame(frame);
    });
    socket.on('error', () => {
      if (myGeneration !== generation) return;
      // A socket error is a retry, not a verdict: the switch is still on, so the Host
      // comes back on its own rather than asking the user to press reconnect.
      void dropAndRetry('Cindy relay 连接出错').then(() => undefined, () => undefined);
    });
    socket.on('close', () => {
      if (myGeneration !== generation || !active) return;
      void dropAndRetry('与 Cindy relay 的连接已断开').then(() => undefined, () => undefined);
    });
  }

  /** Bring the relay up. Safe to call repeatedly; only the first call connects. */
  async function connect() {
    if (stopped || connecting || ws !== null || !active) return;
    connecting = true;
    const myGeneration = ++generation;
    try {
      status.setLogin({ authenticated: false, required: false });
      status.setState('authenticating', '正在读取本机 Cindy 登录态');

      let resolved;
      try {
        resolved = await resolveSession();
      } catch {
        resolved = { ok: false, message: '读取本机 Cindy 登录态失败' };
      }
      if (stopped || !active || myGeneration !== generation) return;

      if (!resolved?.ok) {
        // No usable session: the relay stays down and the card shows the login
        // form. This is not a failure state — nothing has failed yet.
        status.setLogin({ authenticated: false, required: true });
        status.setState('disconnected', resolved?.message ?? '需要登录 Cindy');
        return;
      }

      session = resolved.session;
      status.setLogin({
        authenticated: true,
        required: false,
        kind: typeof session?.kind === 'string' ? session.kind : null,
        identifier: typeof session?.identifier === 'string' ? session.identifier : null,
      });
      status.setState('authenticating', '正在连接 Cindy DeviceLink');

      if (stopped || !active || myGeneration !== generation) return;

      await ensureProjection();
      if (stopped || !active || myGeneration !== generation) return;

      let socket;
      try {
        socket = openSocket(session, relayUrl);
      } catch {
        // A socket that cannot even be created is the ordinary case when the network is
        // down at startup, so it retries like every other loss. Reporting `failed` here
        // is how a Host that booted before its network stayed dead until a human noticed.
        scheduleReconnect('无法建立 Cindy relay 连接');
        return;
      }
      ws = socket;
      wireSocket(socket, myGeneration);
    } finally {
      connecting = false;
    }
  }

  /**
   * Tear the relay down and forget everything it taught us.
   * @param options - `keepSwitch` leaves the switch on (a heartbeat recovery
   *   attempt) instead of returning the status to `disconnected`.
   */
  async function disconnect({ keepSwitch = false } = {}) {
    generation += 1;
    stopHeartbeat();
    acceptedControllers.clear();
    subscribers.clear();
    sessionSubscribers.clear();
    directoryAsked.clear();
    // A question asked over a link that is going away can never be answered;
    // settling them cancelled is what releases DSH's awaiting turn.
    approvals.clear();
    inputQueue.clear();
    projections.clear();

    const socket = ws;
    ws = null;
    // The socket is deliberately gone: a queued retry for it would only race the next
    // connect. A retry that should survive this call is scheduled by the caller.
    cancelReconnect();
    if (socket !== null) {
      try {
        socket.close();
      } catch {
        // Closing an already-dead socket is not an error worth surfacing.
      }
    }

    if (projection !== null) {
      const closing = projection;
      projection = null;
      try {
        await closing.stop();
      } catch {
        // The projection is already unreachable; a stop failure cannot make it worse.
      }
    }

    session = null;
    status.clearDevices();
    if (!keepSwitch) {
      status.setLogin({ authenticated: false, required: false });
      status.reset();
    }
  }

  /**
   * Apply new settings. This is the only entry point that starts or stops the
   * relay, so the switch and the socket can never disagree.
   * @param next - the newly resolved settings section.
   */
  async function updateSettings(next) {
    if (stopped) return;
    const previous = current;
    current = next;
    // The settings section is the durable home of the archive/delete/pin flags, so
    // every settings change is also a chance for another instance (or a hand edit)
    // to have moved them. `replace` never writes back — see `session-flags.js`.
    sessionFlags.replace(next?.sessionFlags);
    policy.update(next);
    const wanted = next?.transportEnabled === true || next?.remoteControlEnabled === true;

    if (!wanted) {
      if (active) {
        active = false;
        await disconnect();
      }
      return;
    }

    if (active) {
      // Already up: refresh what the relay was told about controllability.
      if (ws !== null && previous?.remoteControlEnabled !== next?.remoteControlEnabled) {
        send({ v: PROTOCOL_VERSION, kind: 'presence-set', payload: { remoteControlEnabled: policy.isEnabled() } });
      }
      return;
    }

    active = true;
    await connect();
  }

  /** Full stop: used by plugin teardown, not by the switch. */
  async function stop() {
    stopped = true;
    active = false;
    await disconnect();
    status.setState('disconnected');
  }

  /** Start if the resolved settings already ask for transport. */
  await updateSettings(settings);

  return {
    model,
    subscribers,
    acceptedControllers,
    policy,
    status,
    getStatus: () => status.snapshot(),
    subscribeStatus: (listener) => status.subscribe(listener),
    /** The most recent invokes this Host served, for the status route's diagnostics. */
    getInvokeLog: () => invokeLog.slice(),
    /** Every refusal still in the window, so a rare one is never evicted by polling. */
    getRefusalLog: () => refusalLog.slice(),
    /** The most recent pushes this Host attempted, with their watcher counts. */
    getPushLog: () => pushLog.slice(),
    /** Per-channel push totals since start; monotonic, unlike the bounded ring. */
    getPushTotals: () => Object.fromEntries(pushTotals),
    /**
     * Per-channel invoke totals since start, and the refusals among them.
     *
     * Answers "has this channel ever been asked for", which the bounded ring cannot
     * once a controller starts polling, and turns channel coverage into something a
     * test run can report rather than something a person has to remember.
     */
    getInvokeTotals: () => Object.fromEntries(invokeTotals),
    getRefusalTotals: () => Object.fromEntries(refusalTotals),
    /**
     * How the automatic reconnection is doing.
     *
     * "The Host disappeared from the phone" and "the Host was briefly offline and came
     * back on its own" are indistinguishable from the outside without this, and the
     * difference is exactly what the user cares about: `attempts` counts retries since
     * the last stable connection, `pending` says one is queued right now.
     */
    getReconnectState: () => ({ attempts: reconnectAttempt, pending: reconnectTimer !== null, lastReason: reconnectReason }),
    /**
     * How the frame budget is doing.
     *
     * "The phone shows only its own last message and nothing loads" has two very
     * different causes — a reply that was degraded to fit, and a frame that was
     * refused outright — and neither is visible from the controller. `degradations`
     * names the stage that saved each reply; `refusals` should stay empty, because
     * message pages are degraded before the ceiling is ever reached.
     */
    getFrameBudget: () => ({
      limitBytes: MAX_FRAME_BYTES,
      refusals: frameRefusalTotal,
      recentRefusals: frameRefusals.slice(),
      degradations: frameDegradations.slice(),
    }),
    /** The topics controllers currently hold, for the status route's diagnostics. */
    getSubscriptions: () => ({
      devices: [...subscribers],
      sessions: [...sessionSubscribers].map(([sessionId, devices]) => ({ sessionId, devices: [...devices] })),
    }),
    /** Push one live session message to the controllers watching that session. */
    pushSessionMessage,
    /**
     * Announce a real turn boundary to a session's watchers.
     *
     * The plugin drives these from DSH's `turn/start` and `turn/end` events, which
     * are the boundaries the controller's spinner is defined against. The
     * projection's running flag flaps inside a single turn, so it is not allowed
     * to end one (see `turnEventFor`).
     */
    pushTurnRunning: (sessionId) => announceTurnRunning(sessionId),
    pushTurnIdle: (sessionId) => announceTurnIdle(sessionId),
    /**
     * Make sure a controller is not left spinning after a turn it was watching.
     *
     * The terminal `maker:event` comes from DSH's own turn boundary, and a
     * controller clears "thinking" on nothing else. If that event never arrives
     * the spinner would simply stay. A durable message is the second witness that
     * something finished, so this re-checks shortly afterwards and says so only if
     * the session really is idle by then.
     *
     * The delay is what makes it safe: a live turn is still running a moment
     * later, so this cannot clear a spinner for work in progress. **One pending
     * check per session**, because this is called once per appended event — a
     * single turn appends dozens, and an un-deduplicated timer turned one turn
     * into eighteen `done` pushes, each of which makes the controller finalize
     * its streaming rows again.
     */
    reconcileTurnState: (sessionId) => {
      if (typeof sessionId !== 'string' || sessionId === '') return;
      if (pendingReconciles.has(sessionId)) return;
      const timer = setTimeoutImpl(() => {
        pendingReconciles.delete(sessionId);
        if (sessionRowFor(sessionId)?.running === true) return;
        announceTurnIdle(sessionId);
      }, TURN_RECONCILE_MS);
      pendingReconciles.set(sessionId, timer);
      if (typeof timer?.unref === 'function') timer.unref();
    },
    /**
     * Retire the controller's queue row for a prompt that has been admitted.
     *
     * DSH's inbox drops an entry when its message becomes part of the session,
     * but the queue frame that would say so is not guaranteed to reach us — so
     * the controller's optimistic "队列中" row could outlive the message it
     * describes, leaving a queue that never drains and a spinner that never
     * stops. The durable message is the proof that the row is done.
     */
    retireQueuedItem: (sessionId, controllerId) => {
      if (typeof sessionId !== 'string' || sessionId === '') return;
      if (typeof controllerId !== 'string' || controllerId === '') return;
      inputQueue.mirror(sessionId, controllerId, { kind: 'remove' });
      pushSessionUpdate(sessionId, 'maker:input:projection', inputQueue.projectionFor(sessionId, sessionRowFor(sessionId)));
    },
    /** Ask the watching controllers to decide a DSH approval; null when none is watching. */
    askApproval,
    /** Ask the watching controllers a structured question; null when none is watching. */
    askUserQuestion,
    /** Fold one `sessionController.control()` frame into the input queue. */
    applyControlFrame: (frame) => {
      inputQueue.apply(frame);
      // A goal the Host advances on its own — the round driver counting a round,
      // the phase turning `complete` — changes the projection exactly like a user
      // write does, and the controller's goal card refreshes from
      // `maker:goal:status-changed` alone. Pushing only on our own writes left the
      // card frozen at whatever it was when the session was opened.
      const before = typeof frame?.sessionId === 'string' && frame.type !== 'baseline'
        ? toGoalStatusPayload(frame.sessionId, projections.goalOf(frame.sessionId))
        : undefined;
      projections.apply(frame);
      // A queue or job change is the controller's `maker:input:projection`
      // topic. Pushing it is what keeps the composer live after an enqueue that
      // the controller only saw the answer to.
      const sessionId = frame?.type === 'baseline' ? null : frame?.sessionId;
      if (typeof sessionId === 'string' && sessionId !== '') {
        const after = toGoalStatusPayload(sessionId, projections.goalOf(sessionId));
        if (after !== undefined && JSON.stringify(after) !== JSON.stringify(before)) {
          pushSessionUpdate(sessionId, 'maker:goal:status-changed', { sessionId, goal: after });
        }
        pushSessionUpdate(sessionId, 'maker:input:projection', inputQueue.projectionFor(sessionId, sessionRowFor(sessionId)));
      }
    },
    /** The controller's `InputProjection` for one session. */
    inputProjectionFor: (sessionId) => inputQueue.projectionFor(sessionId, sessionRowFor(sessionId)),
    /** The goal status the controller shows, read from the projection stream. */
    goalStatusFor: (sessionId) => toGoalStatusPayload(sessionId, projections.goalOf(sessionId)),
    /**
     * Run one channel exactly as a controller would, from inside this process.
     *
     * The Host's own view of what it sends is otherwise invisible: two real bugs
     * here were found only after a handset round trip (`local-db:sessions:list`
     * returning the wrong shape, and `prompt` throwing on a missing required
     * signal), and both looked identical from the outside — the controller just
     * showed nothing. This makes the same path reachable locally, against the
     * real services, so a fix can be proved without a phone.
     *
     * It performs whatever the channel performs: `maker:send` here really sends.
     * The route above it is loopback-only, the same trust boundary as the
     * settings API beside it.
     * @param channel - the channel to invoke.
     * @param args - its arguments.
     * @returns the reply frame, or a description of what it threw.
     */
    async invokeForTest(channel, args = []) {
      const frame = { v: PROTOCOL_VERSION, kind: 'invoke', id: `selftest-${Date.now()}`, src: 'selftest', payload: { channel, args } };
      try {
        return { ok: true, reply: await handleInvoke(frame) };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    },
    /** How many controllers are watching one session's live stream. */
    watchersFor,
    /** The questions still open, in the controller's shape. */
    listPendingInteractions: (sessionId) => approvals.list(sessionId),
    resolveInteraction,
    updateSettings,
    connect,
    /** The card's reconnect button: retry immediately and forget the backoff ladder. */
    reconnectNow,
    disconnect,
    setSource,
    stop,
    get sessionDeviceId() {
      return session?.deviceId ?? null;
    },
    /** Whether the DSH session projection is currently feeding the phone. */
    get projectionRunning() {
      return projection !== null;
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Interactive CLI entry. `DEFAULT_HOST_SETTINGS` leaves transport off, so this
  // starts disconnected and prints nothing — the settings card owns the switch.
  await startHost();
}
