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
import { join as joinDeliveryPath } from 'node:path';
import { createHash as deliveryHash } from 'node:crypto';
import { openInputDeliveryStore, deliveryError } from './host-input-delivery-store.js';
import { createInputDeliveryCoordinator } from './host-input-delivery.js';
import { realpath as realpathImpl, stat as statImpl } from 'node:fs/promises';
import { extname as extnameImpl, resolve as resolvePathImpl } from 'node:path';
import { restoreSession } from './auth-session.js';
import { createChannelRouter, invokeError, refusalError } from './cindy-channels.js';
import { NATIVE_PIN_MEMBERSHIP_AT } from './dsh-session-archive.js';
import { createApprovalRegistry } from './host-approvals.js';
import { createInputQueueTracker, queuedRowFromController } from './host-input-queue.js';
import { createProjectionTracker, toGoalStatusPayload } from './host-goals.js';
import { ReadOnlyProjection } from './projection.js';
import { SessionReadModel } from './session-read-model.js';
import { ProjectionReadModelSink } from './projection-read-model-sink.js';
import { publishLifecycle, runningStatusEvent, turnEventFor } from './session-publisher.js';
import { createReasoningPublisher } from './reasoning-publisher.js';
import { createHistoryDeliveryState } from './history-delivery-state.js';
import { turnDiagnosticRow, turnDiagnosticPayload } from './turn-error.js';
import { advanceInterruptionMetadata, diagnosticOwner, interruptionFields, projectDismissedErrors } from './diagnostic-presentation.js';
import { acceptLink } from './host-authorization.js';
import { AuthorizationPolicy } from './authorization-policy.js';
import { HostStatus } from './host-status.js';
import { DEFAULT_HOST_SETTINGS, DEFAULT_HOST_DEVICE_NAME, hostDeviceName } from './host-settings.js';
import { createDeviceNameSync } from './host-device-name.js';
import { createSessionFlags } from './session-flags.js';
import { MAX_ATTACHMENT_BYTES } from './host-attachments.js';
import { createMediaRefResolver, createMediaReleaser, createMediaUploader, mediaApiBaseUrl, isAttachmentOssRef } from './host-media.js';
import { createLocalMediaFetcher, createLocalFileResolver, isBlockedMediaPath, isInsideDirectory, mimeForMediaPath } from './host-media-fetch.js';
import { createFilePeerManager } from './host-file-peer.js';
import { createAttachmentMediaFetcher } from './host-attachment-media.js';
import { createFileIceLoader } from './host-file-ice.js';
import { createLocalFileUrl } from './host-file-reference.js';
import { FILE_PEER_MAX_BYTES } from './file-peer-protocol.js';
import { createFileMediaUploader } from './host-media.js';
import { createExportJobs } from './host-export-jobs.js';
import { createExportOwner } from './host-export-owner.js';
import { createTransferDiagnostics } from './host-transfer-diagnostics.js';
import { normalizeAuthBaseUrl } from './cindy-login-flow.js';
import { loadSession as loadNetworkCredential } from './credential-store.js';
import { sessionEndpoints, relayForEndpoints } from './cindy-auth-endpoints.js';
import { RECONNECT_STABLE_RESET_MS, computeReconnectDelayMs } from './host-reconnect.js';
import { MAX_FRAME_BYTES, FRAME_BUDGET_BYTES, fitInvokeResultToFrame, frameByteLength } from './host-frame-budget.js';

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

export const HOST_DEVICE_NAME = DEFAULT_HOST_DEVICE_NAME;
export const HOST_PLATFORM = 'desktop';
import { deleteAccountDevice } from './host-device-delete.js';
import { HOST_APP_VERSION, HOST_PLUGIN_VERSION } from './host-version.js';
export { HOST_APP_VERSION } from './host-version.js';

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
  // Freeze one network context for this runtime. A region/account change rebuilds
  // every owner, rather than changing only the socket while media/ICE keep old URLs.
  let boundEndpoints = options.connectionEndpoints ?? null;
  let networkError = null;
  if (!boundEndpoints && !options.resolveSession && !options.relayUrl) {
    try { boundEndpoints = sessionEndpoints(await (options.credentialPorts?.loadSession ?? loadNetworkCredential)()); }
    catch (error) { if (['SESSION_REALM_MISMATCH', 'INVALID_ENDPOINT_MANIFEST', 'INVALID_REGION'].includes(error?.code)) networkError = error; }
  }
  const resolver = options.resolveSession ?? (() => restoreSession(options.credentialPorts));
  const resolveSession = async () => {
    const current = options.identityIsCurrent ?? (() => true);
    if (!current() || networkError) return { ok: false, reason: 'SESSION_REALM_MISMATCH', message: '登录身份或账号区域已改变，请重新连接' };
    const result = await resolver();
    if (!current()) return { ok: false, reason: 'SESSION_REALM_MISMATCH', message: '登录身份已改变' };
    if (result.ok && (boundEndpoints || (!options.resolveSession && !options.relayUrl))) {
      let actual; try { actual = sessionEndpoints(result.session); } catch { actual = null; }
      if (!actual || !boundEndpoints || JSON.stringify(actual) !== JSON.stringify(boundEndpoints)) return { ok: false, reason: 'SESSION_REALM_MISMATCH', message: '账号区域已改变，请重新加载 Host 连接' };
    }
    return result;
  };
  const {
    openSocket = openRelaySocket,
    listDevices = fetchDeviceDirectory,
    relayUrl = boundEndpoints ? relayForEndpoints(boundEndpoints) : RELAY_WS_URL,
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

  /**
   * Refresh this runtime's account session because a media call was refused with 401.
   *
   * The session above is read **once** at startup (and again when the relay reconnects), so a
   * credential refreshed outside this process — the settings card, a tool, another Host — is
   * invisible here and every signed request keeps failing. Measured 2026-09-18: after the
   * stored session was refreshed, the in-app 导出 path still answered `presign-put answered 401`
   * while the same stored token worked from a fresh process.
   *
   * Two deliberate constraints, both learned the hard way:
   *  - **One refresh at a time.** Concurrent `restoreSession()` calls rotate the same refresh
   *    token; that race is what once cost a real login (see the comment on `mediaOptions`).
   *  - **A cooldown.** A stream of 401s must not turn into a stream of refreshes: the second
   *    failure within `SESSION_REFRESH_COOLDOWN_MS` is reported, not retried.
   * @returns whether the in-memory session is now a refreshed one.
   */
  let credentialOperations = Promise.resolve();
  function serializeCredentialOperation(action) {
    const next = credentialOperations.then(action);
    credentialOperations = next.catch(() => {});
    return next;
  }
  let sessionRefreshInFlight = null;
  let sessionRefreshedAt = 0;
  const SESSION_REFRESH_COOLDOWN_MS = 30_000;
  function refreshSessionForMedia() {
    if (sessionRefreshInFlight !== null) return sessionRefreshInFlight;
    if (Date.now() - sessionRefreshedAt < SESSION_REFRESH_COOLDOWN_MS) return Promise.resolve(false);
    const callerGeneration = generation;
    const capturedOwner = exportOwner.capture();
    const capturedCredential = exportOwner.getCredential(capturedOwner);
    const attempt = serializeCredentialOperation(async () => {
      if (stopped || callerGeneration !== generation) return false;
      if (capturedOwner) {
        const renewed = await exportOwner.refreshCredential(capturedCredential);
        sessionRefreshedAt = Date.now();
        return renewed !== null;
      }
      const result = await restoreSession(options.credentialPorts);
      sessionRefreshedAt = Date.now();
      if (stopped || callerGeneration !== generation || exportOwner.capture()) return false;
      if (result?.ok === true && result.session !== undefined) {
        session = result.session;
        return true;
      }
      return false;
    }).catch(() => { sessionRefreshedAt = Date.now(); return false; });
    sessionRefreshInFlight = attempt;
    void attempt.then(() => { if (sessionRefreshInFlight === attempt) sessionRefreshInFlight = null; });
    return attempt;
  }

  const mediaOptions = {
    apiBaseUrl: mediaBase,
    getSession: () => session,
    fetchImpl,
    maxBytes: maxAttachmentBytes,
    onUnauthorized: refreshSessionForMedia,
  };
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
  // Streamed workdir Export follows Cindy's inclusive 2GiB ceiling.
  const FILE_EXPORT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
  /**
   * The controller asking this machine to hand over one of its files.
   *
   * The chat-image path: a picture the agent produced is referenced by path in the
   * transcript, and the controller resolves it through `device-link:media:fetch`. Same
   * uploader as the file browser's export ops, stricter request handling
   * (`host-media-fetch.js`): a containment root is mandatory and both sides are realpath'd.
   */
  const fetchFileMedia = createLocalMediaFetcher({ uploader: uploadMedia });
  const fetchAttachmentMedia = createAttachmentMediaFetcher({
    uploader: uploadMedia,
    getScope: () => stopped ? null : `${generation}:${sourceRevision}`,
    isAllowed: locator => !sessionIsHidden(locator.sessionId),
    readSource: async locator => {
    if (sessionIsHidden(locator.sessionId)) return { ok: false, code: 'FORBIDDEN', message: 'source session unavailable' };
    const capabilities = typeof options.resolveCapabilities === 'function' ? options.resolveCapabilities() : {};
    return typeof capabilities.readAttachmentSource === 'function'
      ? capabilities.readAttachmentSource(locator)
      : { ok: false, code: 'NOT_AVAILABLE', message: 'native attachment reader unavailable' };
  } });
  const fetchLocalMedia = input => typeof input?.url === 'string' && input.url.startsWith('xdt-image://')
    ? fetchAttachmentMedia(input) : fetchFileMedia(input);
  const resolvePeerFile = createLocalFileResolver({ maxBytes: FILE_PEER_MAX_BYTES });
  const fileUrl = createLocalFileUrl({ resolveFile: resolvePeerFile });

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
    if (Number.isFinite(info?.size) && info.size > FILE_EXPORT_MAX_BYTES) {
      return { ok: false, code: 'OVERSIZE', message: `the file is ${info.size} bytes, over the ${FILE_EXPORT_MAX_BYTES} byte export limit` };
    }
    return { ok: true, real, info };
  }

  /**
   * Start one file export: answer with a transfer id, upload behind the reply.
   * @param input - `{ workdir, relPath }` as the controller sent them.
   * @returns `{ ok: true, transferId, size, mtimeMs }` or a refusal.
   */
  const startFileExport = (input, request) => fileExports.start(input, request);
  const fileExportStatus = (input, request) => fileExports.status(input, request);

  const model = new SessionReadModel();
  /** Devices following the list-level `sessions` topic. */
  const subscribers = new Set();
  /** Devices following one session's live stream: `sessionId -> Set<deviceId>`. */
  const sessionSubscribers = new Map();
  const historyDelivery = createHistoryDeliveryState((deviceId, sessionId) =>
    acceptedControllers.has(deviceId) && policy.canAccept(deviceId) && !sessionIsHidden(sessionId)
      && sessionSubscribers.get(sessionId)?.has(deviceId) === true);
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
   * Controller-only delete/pin metadata and compatibility archive flags.
   *
   * Owned by the runtime rather than the plugin because it is per-process state the
   * channel layer and the row projection must agree on, and it is persisted through
   * the settings section the plugin passes in as `persistSessionFlags`.
   */
  const sessionFlags = createSessionFlags({ initial: settings?.sessionFlags, persist: options.persistSessionFlags });
  /** Questions DSH is waiting on, answered by whichever controller is watching. */
  const approvals = createApprovalRegistry({
    now,
    // Permission cards keep their existing deadline. Questions have no Host
    // timeout: only an answer or the caller's stop/cancel lifecycle ends them.
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
  const deviceNameSync = createDeviceNameSync({ url: deviceListUrl(relayUrl), fetchImpl });
  deviceNameSync.reset(current?.deviceName?.trim() || null);
  function syncDeviceName() {
    deviceNameSync.update({ name: current?.deviceName?.trim() || null,
      session: active && ws !== null && boundSocketGeneration === generation &&
        (current?.transportEnabled || current?.remoteControlEnabled) && status.ownDeviceId ? session : null, deviceId: status.ownDeviceId });
  }
  let source = initialSource;
  let sourceRevision = 0;
  let disposeProjectOrderObservation = null;
  let projectOrderObserverSource;
  let projectOrderObserverPort;
  let disposeArchiveObservation = null;
  let disposeReminderObservation = null;
  let reminderObserverSource;
  let reminderObserverPort;
  const sessionMetaWrites = new Map();
  const interruptionStates = new Map();
  const nativePresentationMetadata = new Map();
  const presentationData = () => options.diagnosticPreferences?.snapshot?.() ?? {};
  const presentationOwner = () => diagnosticOwner(deliveryNamespace, options.inputDeliveryDirectory ?? '');
  const presentationFields = (sid, running = false, candidate = interruptionStates.get(sid)) => interruptionFields(candidate, running, sessionIsHidden(sid), presentationData(), presentationOwner(), sid);
  const projectMessages = rows => projectDismissedErrors(rows, presentationData(), presentationOwner());

  async function refreshInterruption(sid, row) {
    const owner = source; const revision = sourceRevision; const version = turnVersions.get(sid); const connection = generation;
    const reader = options.resolveCapabilities?.()?.readMessages;
    if (typeof reader?.turnState !== 'function') return;
    const state = await reader.turnState(sid);
    if (stopped || generation !== connection || source !== owner || sourceRevision !== revision || turnVersions.get(sid) !== version || options.resolveCapabilities?.()?.readMessages !== reader) throw Object.assign(new Error('Native session changed; synchronize again'), { code: 'NOT_AVAILABLE' });
    let live = row;
    if (typeof owner?.listSessionStates === 'function') {
      const rows = await owner.listSessionStates(sid); live = rows.find(item => String(item.id) === sid);
    }
    if (stopped || generation !== connection || source !== owner || sourceRevision !== revision || turnVersions.get(sid) !== version || options.resolveCapabilities?.()?.readMessages !== reader || !live || typeof live.running !== 'boolean' || (nativeBoundaries.get(sid)?.seq ?? -1) > (state?.seq ?? -1)) throw Object.assign(new Error('Native session state is unavailable'), { code: 'NOT_AVAILABLE' });
    if (Number.isSafeInteger(state?.boundarySeq)) nativeBoundaries.set(sid, { seq: state.boundarySeq, turn: state.nativeMetadata?.start?.data?.turn });
    interruptionStates.set(sid, live.running || state?.running ? null : state?.interruption ?? null);
    if (state?.nativeMetadata) nativePresentationMetadata.set(sid, state.nativeMetadata);
  }

  async function diagnosticAction(sid, peer, clientId) {
    const scopeOwner = source; const revision = sourceRevision; const owner = presentationOwner(); const connection = generation;
    const grant = current?.controllers?.[peer]?.grantRevision;
    const valid = () => !stopped && active && owner && presentationOwner() === owner && source === scopeOwner && sourceRevision === revision
      && generation === connection && acceptedControllers.has(peer) && policy.canAccept(peer) && !sessionIsHidden(sid)
      && current?.controllers?.[peer]?.grantRevision === grant;
    const requireCurrent = () => { if (!valid()) throw Object.assign(new Error('Diagnostic action scope is unavailable'), { code: 'NOT_AVAILABLE' }); };
    requireCurrent();
    const row = await (typeof source.getSession === 'function' ? source.getSession(sid) : source.listSessions().then(rows => rows.find(row => String(row.id) === sid)));
    requireCurrent(); if (!row) throw Object.assign(new Error('Session does not exist'), { code: 'NOT_FOUND' });
    const preferences = options.diagnosticPreferences;
    if (typeof preferences?.commit !== 'function') throw Object.assign(new Error('Durable diagnostic preferences are unavailable'), { code: 'NOT_AVAILABLE' });
    if (clientId === undefined) {
      await refreshInterruption(sid, row); requireCurrent();
      const candidate = interruptionStates.get(sid);
      if (!candidate) return { ok: true };
      await preferences.commit({ owner, sessionId: sid, kind: 'interruptions', id: candidate.id }, valid);
      requireCurrent();
      // Re-read after persistence; an in-flight old acknowledgement never clears a new interruption.
      await refreshInterruption(sid, row); requireCurrent();
      publishRowPatch(sid, presentationFields(sid, isSessionRunningNow(sid)));
      routeInvoke.invalidateSessionRows();
      return { ok: true };
    }
    const reader = options.resolveCapabilities?.()?.readAllMessages;
    if (typeof reader !== 'function') throw Object.assign(new Error('Committed message history is unavailable'), { code: 'NOT_AVAILABLE' });
    const rows = await reader(sid); requireCurrent();
    const prefix = `${sid}:turn-error:`;
    const message = rows.find(item => {
      if (item.sessionId !== sid || item.clientId !== clientId || item.id !== clientId || item.role !== 'error' || typeof item.id !== 'string' || !item.id.startsWith(prefix)) return false;
      const seq = Number(item.id.slice(prefix.length));
      return Number.isSafeInteger(seq) && seq >= 0 && item.id === `${prefix}${seq}`;
    });
    if (!message) throw Object.assign(new Error('Host error message does not exist'), { code: 'NOT_FOUND' });
    await preferences.commit({ owner, sessionId: sid, kind: 'errors', id: clientId }, valid); requireCurrent();
    const [effective] = projectMessages([message]);
    pushSessionUpdate(sid, 'local-db:messages:created', { sessionId: sid, message: effective });
    pushHistoryViewChanged(sid);
    return effective;
  }
  function serializeSessionMeta(sessionId, operation) {
    const pending = (sessionMetaWrites.get(sessionId) ?? Promise.resolve()).then(operation);
    const settled = pending.then(() => {}, () => {});
    sessionMetaWrites.set(sessionId, settled);
    void settled.then(() => { if (sessionMetaWrites.get(sessionId) === settled) sessionMetaWrites.delete(sessionId); });
    return pending;
  }
  function projectSessionRows(rows) {
    const archived = source?.archive?.snapshot(); // Read the native set once per page, not once per row.
    const pinned = source?.archive?.pinSnapshot?.();
    // Native settings describe can traverse every plugin: read once per page.
    const data = presentationData(); const owner = presentationOwner();
    const nativeReader = typeof options.resolveCapabilities?.()?.readMessages?.turnState === 'function';
    return sessionFlags.projectAll(rows).map(original => {
      const sid = String(original.id);
      const native = nativeReader || Object.hasOwn(original, 'interruption');
      const candidate = interruptionStates.has(sid) ? interruptionStates.get(sid) : original.interruption;
      const row = native ? { ...original, ...interruptionFields(candidate, original.running === true || isSessionRunningNow(sid), sessionIsHidden(sid), data, owner, sid) } : original;
      if (archived?.has(String(row.id)) === true) {
        return { ...row, status: row.status === 'deleted' ? 'deleted' : 'archived', pinnedAt: null };
      }
      if (pinned instanceof Set) {
        const hidden = row.status === 'deleted' || row.status === 'archived';
        return { ...row, pinnedAt: hidden ? null : pinned.has(String(row.id))
          ? NATIVE_PIN_MEMBERSHIP_AT : sessionFlags.flagsFor(row.id)?.pinnedAt ?? null };
      }
      return row;
    });
  }
  function sessionIsHidden(sessionId) {
    return sessionFlags.isHidden(sessionId) || source?.archive?.isArchived(sessionId) === true;
  }
  function observeProjectOrderSource() {
    const owner = source; const port = owner?.projectOrder;
    const enabled = active && !stopped && [...acceptedControllers].some(id => policy.canAccept(id)) && typeof port?.onChange === 'function';
    if (enabled && disposeProjectOrderObservation && projectOrderObserverSource === owner && projectOrderObserverPort === port) return;
    disposeProjectOrderObservation?.(); disposeProjectOrderObservation = null;
    projectOrderObserverSource = undefined; projectOrderObserverPort = undefined;
    if (!enabled) return;
    projectOrderObserverSource = owner; projectOrderObserverPort = port;
    disposeProjectOrderObservation = port.onChange(snapshot => {
      if (stopped || !active || source !== owner || source?.projectOrder !== port || !snapshot?.available) return;
      const devices = [...subscribers].filter(id => acceptedControllers.has(id) && policy.canAccept(id) && !offlineDevices.has(id));
      if (!devices.length) return;
      recordPush(null, 'sidebar-settings:project-order-changed', devices.length, snapshot);
      for (const deviceId of devices) send({ v: PROTOCOL_VERSION, kind: 'push', dst: deviceId, payload: { channel: 'sidebar-settings:project-order-changed', payload: [snapshot, snapshot.ownerStamp] } });
    });
  }
  function observeRemindersSource() {
    observeProjectOrderSource();
    const owner = source; const port = owner?.reminders;
    const enabled = active && !stopped && [...acceptedControllers].some(id => policy.canAccept(id)) && typeof port?.onChange === 'function';
    if (enabled && disposeReminderObservation && reminderObserverSource === owner && reminderObserverPort === port) return;
    disposeReminderObservation?.(); disposeReminderObservation = null;
    reminderObserverSource = undefined; reminderObserverPort = undefined;
    if (!enabled) return;
    reminderObserverSource = owner; reminderObserverPort = port;
    disposeReminderObservation = port.onChange(event => {
      if (stopped || !active || source !== owner || source?.reminders !== port || event?.type !== 'ready') return;
      const devices = [...acceptedControllers].filter(id => policy.canAccept(id) && !offlineDevices.has(id));
      if (!devices.length) return;
      const payload = { type: 'ready' }; recordPush(null, 'maker:schedule:event', devices.length, payload);
      for (const deviceId of devices) send({ v: PROTOCOL_VERSION, kind: 'push', dst: deviceId, payload: { channel: 'maker:schedule:event', payload } });
    });
  }
  function observeArchiveSource() {
    disposeArchiveObservation?.();
    disposeArchiveObservation = null;
    const observedSource = source;
    if (typeof observedSource?.archive?.onChange !== 'function') return;
    disposeArchiveObservation = observedSource.archive.onChange((ids, change) => {
      routeInvoke.invalidateSessionRows(); // A committed desktop edit invalidates warm phone lists immediately.
      for (const sessionId of ids) {
        void serializeSessionMeta(sessionId, async () => {
          if (stopped || source !== observedSource) return;
          // DSH drops its pin on archive; retire the Host's legacy pin too.
          if ((source.archive.isArchived(sessionId) === true || change?.pinIds?.includes(sessionId)) && sessionFlags.flagsFor(sessionId)?.pinnedAt) {
            await sessionFlags.apply(sessionId, { pinnedAt: null });
          }
          if (stopped || source !== observedSource) return;
          const cached = sessionRowCache.get(sessionId);
          const [row] = projectSessionRows([{ ...cached, id: sessionId, status: 'active' }]);
          if (cached) sessionRowCache.set(sessionId, row);
          routeInvoke.invalidateSessionRows();
          const nativePinsKnown = source.archive.pinSnapshot?.() instanceof Set;
          publishSessionMeta(sessionId, { status: row.status, ...(nativePinsKnown || row.status === 'archived' ? { pinnedAt: row.pinnedAt ?? null } : {}) });
        }).catch(error => recordHandlerError('native-session-archive', error));
      }
    });
  }
  function validateSessionMetaPatch(patch) {
    if (!source?.archive) return;
    const pinRequested = patch.pinnedAt !== undefined;
    const pinValue = patch.pinnedAt !== null && patch.pinnedAt !== '';
    if (patch.status !== undefined && !['active', 'archived', 'deleted'].includes(patch.status)) {
      throw refusalError('BAD_REQUEST', 'Unknown session status');
    }
    if (pinRequested && patch.pinnedAt !== null && patch.pinnedAt !== '' &&
      (typeof patch.pinnedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(patch.pinnedAt) || !Number.isFinite(Date.parse(patch.pinnedAt)))) {
      throw refusalError('BAD_REQUEST', 'pinnedAt must be an ISO string or null');
    }
    if (pinRequested && pinValue && patch.status !== undefined) {
      throw refusalError('BAD_REQUEST', 'Pinning and a status change require separate native operations');
    }
    if (patch.title !== undefined && (pinRequested || patch.status !== undefined)) {
      throw refusalError('BAD_REQUEST', 'Rename and metadata changes require separate native operations');
    }
  }
  function applySessionMetadataFlags(sessionId, patch) {
    const owner = source;
    return serializeSessionMeta(sessionId, async () => {
      if (stopped || source !== owner) throw refusalError('NOT_AVAILABLE', 'The DSH session source changed before the metadata write');
      const archive = owner?.archive;
      const pinRequested = patch.pinnedAt !== undefined;
      const pinValue = patch.pinnedAt !== null && patch.pinnedAt !== '';
      validateSessionMetaPatch(patch);
      const archiveRequested = patch.status === 'archived' || patch.status === 'active';
      if (archive && (archiveRequested || (pinRequested && patch.status !== 'deleted'))) {
        // Source exact reads are the ordinary-session visibility boundary; do not
        // let the global Workspace registry authorize arbitrary child/session IDs.
        const visible = typeof owner.getSession === 'function' ? await owner.getSession(sessionId)
          : (await owner.listSessions()).find(row => String(row.id) === sessionId);
        if (!visible) throw refusalError('NOT_FOUND', 'No visible DSH session for this metadata write');
        if (stopped || source !== owner) throw refusalError('NOT_AVAILABLE', 'The DSH source changed during the metadata read');
      }
      if (archive && archiveRequested) {
        // Validate other fields before the native write, so malformed metadata has no side effect.
        if (patch.pinnedAt !== undefined && patch.pinnedAt !== null && typeof patch.pinnedAt !== 'string') {
          throw refusalError('BAD_REQUEST', 'pinnedAt must be an ISO string or null');
        }
        const archived = patch.status === 'archived';
        await archive.setArchived(sessionId, archived);
        if (stopped || source !== owner) throw refusalError('NOT_AVAILABLE', 'The DSH session source changed during the archive write');
        // Native state owns new archives; clear old archived/deleted overlays only
        // after success. Keep unrelated legacy flags and never mutate other sessions.
        const local = await sessionFlags.apply(sessionId, { status: 'active', pinnedAt: archived ? null : patch.pinnedAt });
        return { ...local, status: archived ? 'archived' : 'active' };
      }
      if (archive && pinRequested && patch.status !== 'deleted') {
        if (pinValue && (sessionFlags.isHidden(sessionId) || archive.isArchived(sessionId) === true)) {
          throw refusalError('BAD_REQUEST', 'An archived or deleted session cannot be pinned');
        }
        if (typeof archive.setPinned !== 'function') throw refusalError('NOT_AVAILABLE', 'Native DSH pinning is unavailable');
        await archive.setPinned(sessionId, pinValue);
        if (stopped || source !== owner) throw refusalError('NOT_AVAILABLE', 'The DSH source changed during the pin write');
        const local = await sessionFlags.apply(sessionId, { pinnedAt: null });
        return { ...local, pinnedAt: pinValue ? NATIVE_PIN_MEMBERSHIP_AT : null };
      }
      return sessionFlags.apply(sessionId, patch);
    });
  }
  let active = false;
  let connecting = null; // Generation owning the in-flight connect, not a global latch.
  let session = null;
  let socketSession = null;
  let boundSocketGeneration = -1;
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
  // Peer connections never outlive the relay/account authorization that created them.
  const transferDiagnostics = createTransferDiagnostics({ now: () => Number(now()) });
  let fileExports;
  const exportOwner = createExportOwner({
    ...options.exportCredentialOptions, now: () => Number(now()),
    ports: { ...options.credentialPorts, ...options.exportCredentialOptions?.ports },
    onSession: (next) => { session = next; },
    onInvalidate: () => { void fileExports?.invalidateOwner(); transferDiagnostics.clear(); },
  });
  const uploadExport = createFileMediaUploader({
    ...options.fileExportUploadOptions, apiBaseUrl: mediaBase, fetchImpl,
    getCredential: (owner) => exportOwner.getCredential(owner),
    refreshCredential: async (captured) => {
      const owner = exportOwner.capture();
      if (!owner || exportOwner.getCredential(owner) !== captured) return null;
      const ok = await refreshSessionForMedia();
      const next = exportOwner.getCredential(owner);
      return ok && next !== captured ? next : null;
    },
  });
  fileExports = createExportJobs({
    ...options.fileExportJobOptions, resolveSource: resolveInsideWorkdir, upload: uploadExport,
    captureOwner: () => exportOwner.capture(), isOwnerCurrent: (owner) => exportOwner.isCurrent(owner),
    isControllerAllowed: (src) => policy.canAccept(src), now: () => Number(now()),
    identify: (facts) => transferDiagnostics.identify(facts),
    emit: (event) => transferDiagnostics.record(event),
  });
  const filePeer = createFilePeerManager({
    ...options.filePeerOptions,
    identify: (facts) => transferDiagnostics.identify({ ...facts, owner: exportOwner.capture() }),
    onEvent: (event) => { if (exportOwner.capture()) transferDiagnostics.record(event); },
    resolveFile: resolvePeerFile,
    isAllowed: (peer) => !stopped && active && ws?.readyState === 1 && session !== null && policy.canAccept(peer),
    loadIceServers: options.filePeerOptions?.loadIceServers ?? createFileIceLoader(mediaOptions),
  });
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

  /**
   * Errors this Host caught at its own boundaries, newest last.
   *
   * This is not bookkeeping for its own sake: **an unhandled rejection is fatal to the whole
   * `dsh web` process.** DSH installs a fail-loud handler
   * (`@deepseek-ai/dsh-app-boot`: `proc.on('unhandledRejection', …)` → stderr
   * `fatal load failure` → `proc.exit(1)`), and Cordis dispatches listeners with no
   * `try`/`catch` of its own (`events.emit` → `this.dispatch(...).map(cb => cb(...))`). So a
   * single throw from our code does not degrade this Host — it takes the desktop's DSH down
   * with it. Measured once: the process vanished mid-turn at 17:30:23 with `turn/end
   * reason=interrupted`, no Windows crash record, and a two-minute gap before the user
   * restarted it. Every boundary below therefore catches, and what it caught is readable
   * here instead of only in a terminal scrollback.
   */
  const handlerErrors = [];
  const HANDLER_ERROR_LIMIT = 20;
  /**
   * Rows this Host decided the phone should not see, counted.
   *
   * Today that is one thing: a harness notice (a background job finishing, written by the
   * `tool-jobs` plugin) used to be projected as a **user bubble**, so the user read a command
   * line as if they had said it. Hiding it is a projection decision; counting it is what keeps
   * the decision from being indistinguishable from a dropped message.
   */
  let suppressedNotices = 0;
  /** When this Host started, for the diagnostics liveness verdict. */
  const startedAtMs = now().getTime();

  /** Record one error caught at a Host boundary (bounded, never throws). */
  function recordHandlerError(where, error) {
    try {
      const message = error instanceof Error ? error.message : String(error);
      handlerErrors.push({
        at: now().toISOString(),
        where,
        message: message.slice(0, 400),
        stack: (error instanceof Error && typeof error.stack === 'string' ? error.stack : '').split('\n').slice(0, 6).join('\n').slice(0, 1200),
      });
      if (handlerErrors.length > HANDLER_ERROR_LIMIT) handlerErrors.splice(0, handlerErrors.length - HANDLER_ERROR_LIMIT);
    } catch {
      // A recorder that can throw is worse than no recorder.
    }
  }

  function send(frame) {
    if (ws === null || typeof ws.send !== 'function' || (ws.readyState !== undefined && ws.readyState !== 1)) return false;
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
      return false;
    }
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch {
      // A send that throws belongs to the socket's own error path.
      return false;
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
        void dropAndRetry('与 Cindy relay 的心跳已丢失').catch((error) => recordHandlerError('heartbeat-drop', error));
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
      // A summary-level error is only an invalidation hint; it must not
      // terminate a newer turn on list-only phones either.
      const nativeRecovery = typeof options.resolveCapabilities?.()?.readMessages?.turnState === 'function';
      const lifecycle = item.phase === 'error' && nativeRecovery ? { ...item, phase: 'active' } : item;
      if (ws !== null) publishLifecycle(ws, subscribers, lifecycle, record);
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
    // The summary error signal has no durable identity and can arrive late.
    // Recover from native boundaries instead of inventing a successful done.
    if (item?.phase === 'error') {
      if (typeof options.resolveCapabilities?.()?.readMessages?.turnState !== 'function') {
        announceTurnIdle(item.sessionId); // Legacy source: keep its status-only correction.
        return;
      }
      for (const deviceId of sessionSubscribers.get(item.sessionId) ?? []) {
        void restoreWatchedTurnState(deviceId, item.sessionId);
      }
      return;
    }
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
    if (source !== next) {
      sourceRevision++;
      nativeBoundaries.clear();
      interruptionStates.clear();
      nativePresentationMetadata.clear();
      turnVersions.clear();
      terminalIdentities.clear();
      source?.manualCompact?.cancelAll('DSH source replaced');
      source?.forkSession?.cancelAll();
      source?.keywordSearch?.cancelAll();
      source?.backgroundJobs?.cancelAll();
      source?.subagentReads?.cancelAll();
      source?.reminders?.cancelAll();
      source?.projectOrder?.cancelAll();
      source?.referenceHistory?.cancelAll();
    }
    source = next === undefined ? undefined : next;
    if (stopped) return;
    routeInvoke.invalidateSessionRows();
    sessionRowCache.clear();
    observeArchiveSource();
    observeRemindersSource();
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
      void connect().catch((error) => recordHandlerError('reconnect', error));
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
    await disconnect({ keepSwitch: true, preserveExports: true });
    scheduleReconnect(reason);
  }

  /**
   * Every session a device has held a subscription to, remembered past a disconnect.
   *
   * The relay may declare the device offline while it is still looking at these sessions — a
   * presence snapshot is an opinion, not a fact, and **it never removes the subscription**. What
   * it removes is the device's right to be *counted as reached*. This map is what lets the Host
   * tell the device the truth about each session when it speaks again, instead of leaving a stale
   * spinner until the user re-enters the session by hand.
   */
  const watchedSessionsByDevice = new Map();
  /**
   * `deviceId\0sessionId` → when that pair was last told a turn is over.
   *
   * A `done` is not idempotent for the controller, and a re-link can race the ordinary
   * terminal announcement for the same turn; this is the de-duplication window.
   */
  const lastTerminalAnnounce = new Map();
  // Disposable delivery guards, not a second error ledger. Only the latest
  // identity per device/session and native boundary per session are retained.
  const terminalIdentities = new Map();
  const subscriptionLeases = new Map();
  const nativeBoundaries = new Map();
  const turnVersions = new Map();

  function renewTurnLease(deviceId, sessionId) {
    const key = terminalAnnounceKey(deviceId, sessionId);
    subscriptionLeases.set(key, (subscriptionLeases.get(key) ?? 0) + 1);
    terminalIdentities.delete(key);
  }
  const TERMINAL_ANNOUNCE_WINDOW_MS = 30_000;
  /**
   * Devices the relay has told us it cannot route to.
   *
   * Their subscriptions are **untouched** — see {@link markDeviceUnreachable} for why deleting
   * them was the wrong repair. This is what keeps the *unwatched* fallback in
   * {@link announceTurnIdle} from sending into the same void and then recording the frame as
   * delivered. Cleared the moment the device links again, which is itself proof of a route.
   */
  const offlineDevices = new Set();
  /**
   * Devices that subscribed to the `sessions` topic at least once.
   *
   * Their session topics are remembered in {@link watchedSessionsByDevice}; the list topic has
   * no session id to hang off, so it is remembered here.
   *
   * Left over from the reversed policy above: nothing reads this any more (the subscription it
   * was meant to restore is never removed), so it is bookkeeping with no consumer.
   */
  const watchedListDevices = new Set();

  /** De-duplication key for "this device was told this session's turn is over". */
  function terminalAnnounceKey(deviceId, sessionId) {
    return `${deviceId}\u0000${sessionId}`;
  }

  /** Send a native terminal identity once per authorized subscription/connection. */
  function sendNativeTerminal(deviceId, sessionId, payload, identity, row) {
    if (stopped || !active || !acceptedControllers.has(deviceId) || !policy.canAccept(deviceId) || sessionIsHidden(sessionId)
      || !sessionSubscribers.get(sessionId)?.has(deviceId)) return false;
    const key = terminalAnnounceKey(deviceId, sessionId);
    const stamp = `${generation}:${subscriptionLeases.get(key) ?? 0}:${identity}`;
    if (terminalIdentities.get(key) === stamp) return false;
    // Reconnect must restore the actual diagnostic, not merely stop a spinner.
    if (row) {
      const notice = { sessionId, message: row };
      recordPush(sessionId, 'local-db:messages:created', offlineDevices.has(deviceId) ? 0 : 1, notice);
      send({ v: PROTOCOL_VERSION, kind: 'push', dst: deviceId, payload: { channel: 'local-db:messages:created', payload: notice } });
    }
    recordPush(sessionId, 'maker:event', offlineDevices.has(deviceId) ? 0 : 1, payload);
    send({ v: PROTOCOL_VERSION, kind: 'push', dst: deviceId, payload: { channel: 'maker:event', payload } });
    if (!offlineDevices.has(deviceId)) {
      terminalIdentities.set(key, stamp);
      noteTerminalAnnounce(deviceId, sessionId);
    }
    return true;
  }

  /** Event callers intentionally fire-and-forget; provider replacement must not
   * turn a failed recovery into an unhandled rejection at the DSH boundary. */
  async function restoreWatchedTurnState(deviceId, sessionId) {
    try { await readWatchedTurnState(deviceId, sessionId); } catch {
      if (!stopped) recordHandlerError('turn-recovery', new Error('Native turn recovery capability is unavailable'));
    }
  }

  /** Cold/reconnect repair uses fresh native evidence; every await is generation guarded. */
  async function readWatchedTurnState(deviceId, sessionId) {
    const reader = options.resolveCapabilities?.()?.readMessages;
    if (typeof reader?.turnState !== 'function') {
      announceWatchedTurnState(deviceId, sessionId);
      return;
    }
    const owner = source; const revision = sourceRevision; const connection = generation;
    const version = turnVersions.get(sessionId);
    const key = terminalAnnounceKey(deviceId, sessionId);
    const lease = subscriptionLeases.get(key);
    const valid = () => !stopped && active && source === owner && sourceRevision === revision
      && generation === connection && turnVersions.get(sessionId) === version
      && subscriptionLeases.get(key) === lease && acceptedControllers.has(deviceId) && policy.canAccept(deviceId)
      && !sessionIsHidden(sessionId) && sessionSubscribers.get(sessionId)?.has(deviceId)
      && options.resolveCapabilities?.()?.readMessages === reader;
    if (!valid()) return;
    try {
      const state = await reader.turnState(sessionId);
      if (!valid() || !state) return;
      // The log can end before a newly admitted turn has appended its start.
      // A live registry check after replay prevents that gap being called idle.
      let live;
      if (typeof owner?.listSessionStates === 'function') {
        const rows = await owner.listSessionStates(sessionId);
        live = Array.isArray(rows) ? rows.find(row => String(row?.id) === sessionId) : null;
      } else if (typeof owner?.getSession === 'function') live = await owner.getSession(sessionId);
      if (!valid() || !live || typeof live.running !== 'boolean') return;
      interruptionStates.set(sessionId, live.running || state.running ? null : state.interruption ?? null);
      if (state.nativeMetadata) nativePresentationMetadata.set(sessionId, state.nativeMetadata);
      publishRowPatch(sessionId, presentationFields(sessionId, live.running));
      if (live.running) {
        setCachedRunning(sessionId, true);
        const payload = { sessionId, event: runningStatusEvent(state.retryNotice?.content ?? 'running') };
        recordPush(sessionId, 'maker:event', 1, payload);
        send({ v: PROTOCOL_VERSION, kind: 'push', dst: deviceId, payload: { channel: 'maker:event', payload } });
        return;
      }
      if (state.running) return; // An unfinished historical turn is not live-registry evidence.
      if ((nativeBoundaries.get(sessionId)?.seq ?? -1) > state.boundarySeq) return;
      // No await after the final guard: a new boundary cannot interleave with send.
      setCachedRunning(sessionId, false);
      const diagnostic = state.error ?? state.notice;
      const [effective] = diagnostic ? projectMessages([diagnostic]) : [];
      const payload = effective ? turnDiagnosticPayload(effective) : { sessionId, event: { type: 'done' } };
      sendNativeTerminal(deviceId, sessionId, payload, `end:${state.boundarySeq}`, effective);
    } catch {
      if (!valid()) return;
      // Never reflect arbitrary upstream exception prose into remote diagnostics.
      recordHandlerError('turn-recovery', new Error('Native turn state is unavailable; retry on the next synchronization'));
      if (valid()) pushHistoryViewChanged(sessionId);
    }
  }

  /** Note that one device has just been told a session's turn is over. */
  function noteTerminalAnnounce(deviceId, sessionId) {
    lastTerminalAnnounce.set(terminalAnnounceKey(deviceId, sessionId), now().getTime());
  }

  /** Note that a device is (or was) watching one session. */
  function rememberWatchedSession(deviceId, sessionId) {
    let sessions = watchedSessionsByDevice.get(deviceId);
    if (sessions === undefined) {
      sessions = new Set();
      watchedSessionsByDevice.set(deviceId, sessions);
    }
    sessions.add(sessionId);
  }

  /**
   * Mark a device unreachable because the relay says so.
   *
   * **It does not touch the subscription set**, and that is the whole point. The first version
   * deleted the device's topics here, on the reasoning that a subscription the relay cannot
   * reach is not a subscription. Measured twice over, that reasoning is backwards:
   *
   * - the relay's presence is an *opinion* it never has to correct: it sends deltas, so a stale
   *   `online:false` is never followed by a fresh `online:true` unless the device really
   *   reconnects. At 09:48:04 it reported the handset offline while the user was watching it,
   *   the topics went, and three minutes of 转圈 followed — the exact symptom the deletion was
   *   meant to fix.
   * - the repair was dead code in practice. `markDeviceReachable` below is triggered by an
   *   inbound frame, and the client *stops sending them* while it believes the peer is
   *   unavailable (it cancels its own peer recovery and filters the device out of its plans).
   *   So the host could destroy its only record of who asked to be pushed and then wait for the
   *   very device it had just gone silent on.
   *
   * The subscription set is this process's own record of *who asked to be pushed*. Reachability
   * is a different fact, owned here, and it only decides whether a push is **counted as
   * delivered** — never whether the record exists. `push` is a routed fire-and-forget frame
   * with no acknowledgement, so an unreachable-device push costs one frame the relay discards;
   * losing the record costs the session.
   *
   * @param deviceId - the device the relay reports offline.
   */
  function markDeviceUnreachable(deviceId) {
    if (typeof deviceId !== 'string' || deviceId === '') return;
    offlineDevices.add(deviceId);
    historyDelivery.forget(deviceId);
    for (const sessionId of watchedSessionsByDevice.get(deviceId) ?? []) renewTurnLease(deviceId, sessionId);
  }

  /**
   * Revoke an unreachability verdict, because the device itself just proved otherwise.
   *
   * A frame from a device is stronger evidence than a presence snapshot: it arrived over the
   * very link that was declared dead. The subscriptions are untouched (`markDeviceUnreachable`
   * never removed them), so what is left to do is tell it what it may have missed — the turn
   * state, so a spinner ends, and a view invalidation, so the transcript it is looking at is
   * re-read instead of staying stale.
   *
   * This is an accelerator, not a lifeline: pushes are sent regardless of reachability, so a
   * device that never speaks again still receives everything the relay can route to it.
   *
   * @returns the sessions it is watching.
   */
  function markDeviceReachable(deviceId) {
    if (!offlineDevices.delete(deviceId)) return [];
    const sessions = [...(watchedSessionsByDevice.get(deviceId) ?? [])];
    for (const sessionId of sessions) {
      announceWatchedTurnState(deviceId, sessionId);
      pushHistoryViewChanged(sessionId);
      replayUserQuestions(sessionId);
    }
    return sessions;
  }

  /**
   * Tell one device the turn state of one session it is (or was) watching.
   *
   * Only when the cache positively says the turn is over: a cold row must never be read as
   * idle, or this would clear a spinner on a turn that is still running. And only once per
   * turn — a `done` is not idempotent for the controller (it finalizes streaming rows), so
   * the same `device × session` pair is de-duplicated through the window every other terminal
   * announcement uses, because this is racing them by construction.
   * @param deviceId - the device to tell.
   * @param sessionId - the session whose turn state to report.
   */
  function announceWatchedTurnState(deviceId, sessionId) {
    if (typeof options.resolveCapabilities?.()?.readMessages?.turnState === 'function') {
      void restoreWatchedTurnState(deviceId, sessionId);
      return;
    }
    const cached = sessionRowFor(sessionId);
    if (cached === undefined || cached.running === true) return;
    const key = terminalAnnounceKey(deviceId, sessionId);
    const at = now().getTime();
    if ((lastTerminalAnnounce.get(key) ?? 0) + TERMINAL_ANNOUNCE_WINDOW_MS > at) return;
    lastTerminalAnnounce.set(key, at);
    const payload = { sessionId, event: { type: 'done' } };
    recordPush(sessionId, 'maker:event', 1, payload);
    send({ v: PROTOCOL_VERSION, kind: 'push', dst: deviceId, payload: { channel: 'maker:event', payload } });
  }

  /** Accept a device as a controller of this Host and reflect it in the status. */
  function linkController(deviceId) {
    const known = status.snapshot().devices.find((device) => device.deviceId === deviceId);
    acceptedControllers.add(deviceId);
    observeRemindersSource();
    status.upsertDevice(deviceId, { isController: true, linkedAt: now().toISOString(), online: true });
    status.refreshConnectionState();
    // A device that linked with no presence broadcast is a bare id until the
    // directory names it. Ask at most once per device per connection, so a
    // device the directory cannot name does not cost a request per link-open.
    if ((known === undefined || known.platform === null) && !directoryAsked.has(deviceId)) {
      directoryAsked.add(deviceId);
      void refreshDeviceDirectory().catch((error) => recordHandlerError('device-directory', error));
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
  let directoryEpoch = 0;
  const pendingDeletes = new Set();
  async function deleteDevice(deviceId) {
    if (pendingDeletes.has(deviceId)) return { ok: false, statusCode: 409, message: '设备正在删除' };
    let owner = session;
    const epoch = generation;
    if (stopped || !active) return { ok: false, statusCode: 409, message: '请先连接 Cindy Host' };
    pendingDeletes.add(deviceId);
    try {
      const result = await deleteAccountDevice({
        deviceId, session: owner, snapshot: status.snapshot(),
        getSnapshot: () => status.snapshot(), url: deviceListUrl(relayUrl), fetchImpl,
        refreshSession: async captured => {
          if (stopped || !active || generation !== epoch || session !== captured) return null;
          const refreshed = await refreshSessionForMedia();
          if (!refreshed || stopped || !active || generation !== epoch ||
              !session || session.deviceId !== captured.deviceId || session.authBaseUrl !== captured.authBaseUrl) return null;
          owner = session;
          return session;
        },
      });
      if (stopped || generation !== epoch || session !== owner) return { ok: false, statusCode: 409, message: '连接身份已改变，请刷新设备列表' };
      if (result.ok) {
        directoryEpoch++;
        acceptedControllers.delete(deviceId);
        historyDelivery.forget(deviceId);
        observeRemindersSource();
        subscribers.delete(deviceId);
        status.removeDevice(deviceId);
        status.refreshConnectionState();
      }
      return result;
    } finally {
      pendingDeletes.delete(deviceId);
    }
  }

  async function refreshDeviceDirectory() {
    if (session === null) return;
    const myGeneration = generation;
    const readEpoch = directoryEpoch;
    let answer;
    try {
      answer = await listDevices(session, relayUrl);
    } catch {
      return;
    }
    if (stopped || !active || myGeneration !== generation || readEpoch !== directoryEpoch) return;
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
      if (topic === 'sessions') {
        subscribers.add(deviceId);
        // Remembered for the same reason a session topic is (the device's turn state has to be
        // announced when it speaks again). Nothing reads it today: it existed to hand the topic
        // back to a device that had been dropped for being unreachable, and that drop is gone.
        watchedListDevices.add(deviceId);
      } else if (topic.startsWith('session:')) {
        const sessionId = topic.slice('session:'.length);
        renewTurnLease(deviceId, sessionId);
        const devices = sessionSubscribers.get(sessionId) ?? new Set();
        devices.add(deviceId);
        sessionSubscribers.set(sessionId, devices);
        // Remembered beyond the subscription itself: a session a controller has
        // ever attached to belongs to that controller's user, so the questions it
        // asks are theirs to answer even if they have since looked away. See
        // `claimsInteraction`.
        remoteOwnedSessions.add(sessionId);
        // …and beyond a *disconnect*: when this device re-links, the Host has to be able to
        // tell it the turn state of every session it was inside, not just the running ones.
        rememberWatchedSession(deviceId, sessionId);
        replayUserQuestions(sessionId);
      }
    }
  }

  function unsubscribeTopics(deviceId, topics) {
    for (const topic of topics) {
      if (topic === 'sessions') subscribers.delete(deviceId);
      else if (topic.startsWith('session:')) {
        const sessionId = topic.slice('session:'.length);
        historyDelivery.forget(deviceId, sessionId);
        renewTurnLease(deviceId, sessionId);
        const devices = sessionSubscribers.get(sessionId);
        if (devices === undefined) continue;
        devices.delete(deviceId);
        if (devices.size === 0) sessionSubscribers.delete(sessionId);
      }
    }
  }

  /** Drop every subscription a device holds, on disconnect. */
  function forgetSubscriptions(deviceId) {
    historyDelivery.forget(deviceId);
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
   * How often one session may be repaired because a controller spoke about it.
   *
   * A controller that returns from the background does **not** re-subscribe — measured: twenty
   * consecutive invokes with no `device-link:subscribe` among them — but it does keep asking
   * (`messages:view`, `view-intent`, `input:enqueue` every few seconds). So "this device said
   * something about this session" is the one recovery trigger certain to arrive, and this is the
   * rate limit that keeps ordinary polling from becoming a flood.
   */
  const REPAIR_PULSE_MS = 30_000;
  /** `sessionId` -> when it was last repaired this way. */
  const lastRepairPulse = new Map();

  /**
   * Repair one session for its watchers because a controller just spoke about it.
   *
   * The two frames are exactly what a dropped push would have carried: the authoritative input
   * projection (which retires a bubble left spinning) and a view invalidation (which makes the
   * transcript re-read). Idempotent, bounded to one per {@link REPAIR_PULSE_MS} per session, and
   * it does nothing at all when nobody is watching.
   * @param sessionId - the session a controller just asked about.
   */
  function pulseRepair(sessionId) {
    const devices = sessionSubscribers.get(sessionId);
    if (devices === undefined || devices.size === 0) return;
    const at = now().getTime();
    if ((lastRepairPulse.get(sessionId) ?? 0) + REPAIR_PULSE_MS > at) return;
    lastRepairPulse.set(sessionId, at);
    pushSessionUpdate(sessionId, 'maker:input:projection', inputQueue.projectionFor(sessionId, sessionRowFor(sessionId)));
    pushHistoryViewChanged(sessionId);
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
  async function beginApproval({ sessionId, toolName, reason, callId, signal }) {
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    if (!claimsInteraction(sessionId)) return null;
    const handle = await approvals.ask({ sessionId, toolName, reason, callId, signal });
    pushSessionUpdate(sessionId, 'maker:interaction-request', { sessionId, request: handle.request });
    return handle;
  }

  async function askApproval(options) {
    const handle = await beginApproval(options);
    return handle === null ? null : handle.answered;
  }

  /** Answer one pending interaction on the controller's behalf. */
  function resolveInteraction(requestId, decision) {
    return approvals.settle(requestId, decision);
  }

  function settleInteractionOutcome(requestId, outcome) {
    return approvals.settleOutcome(requestId, outcome);
  }

  /**
   * Register before presentation, even when no phone has opened this session.
   * Watching controls push delivery only; late phones query the same pending
   * request while the plugin also forwards it to DSH's native answerer.
   * Returns null when the bridge is disabled or the session is unidentified.
   */
  async function beginUserQuestion({ sessionId, questions, signal }) {
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    if (!active || stopped) return null;
    const handle = await approvals.askUser({ sessionId, questions, signal });
    if (!signal?.aborted) pushSessionUpdate(sessionId, 'maker:interaction-request', { sessionId, request: handle.request });
    return handle;
  }

  function replayUserQuestions(sessionId) {
    for (const { request } of approvals.list(sessionId)) {
      if (request.kind === 'ask_user_question') {
        pushSessionUpdate(sessionId, 'maker:interaction-request', { sessionId, request });
      }
    }
  }

  async function askUserQuestion(options) {
    const handle = await beginUserQuestion(options);
    return handle === null ? null : handle.answered;
  }

  /**
   * Push one session-scoped event to the controllers watching that session.
   *
   * The frame goes to every watcher, reachable or not — the relay discards what it cannot route,
   * and a presence snapshot is not evidence enough to stop delivering to a device the user may
   * be staring at. The **count** is what presence decides: a watcher the relay calls
   * unreachable is not recorded as reached, so the terminal-state de-duplication stays honest
   * and the repair announcement when it returns is still allowed to fire.
   *
   * @param sessionId - the session the event belongs to.
   * @param channel - the push channel.
   * @param payload - the channel's payload.
   */
  function pushSessionUpdate(sessionId, channel, payload) {
    if (channel === 'maker:input:projection' && activeDelivery) payload = activeDelivery.currentProjection(sessionId, [], payload);
    const guarded = channel === 'local-db:messages:created' || channel === 'maker:event';
    const thinking = channel === 'local-db:messages:created' && payload?.message?.role === 'thinking';
    const devices = guarded
      ? new Set([...(sessionSubscribers.get(sessionId) ?? [])].filter(id => !sessionIsHidden(sessionId) && acceptedControllers.has(id) && policy.canAccept(id)))
      : sessionSubscribers.get(sessionId);
    // Only a successfully delivered view opts this controller out of raw thinking.
    if (thinking && devices) for (const deviceId of devices) {
      if (historyDelivery.ready(deviceId, sessionId)) devices.delete(deviceId);
    }
    const watchers = devices === undefined ? 0 : devices.size;
    const reachable = devices === undefined ? 0 : [...devices].filter((deviceId) => !offlineDevices.has(deviceId)).length;
    recordPush(sessionId, channel, reachable, payload);
    if (watchers === 0) return;
    for (const deviceId of devices) {
      send({ v: PROTOCOL_VERSION, kind: 'push', dst: deviceId, payload: { channel, payload } });
    }
  }

  /**
   * How long view invalidations for one session are coalesced.
   *
   * Every renderable row sends one `maker:history-view-changed`, and the controller answers
   * that channel by re-reading the newest page — up to `HISTORY_PAGE_BYTES` (256 KiB) after
   * its own 500 ms debounce. A working turn appends several rows a second, so the frames are
   * cheap but the *re-reads* are not: without coalescing, N rows cost N page reads of up to
   * 256 KiB. One trailing invalidation per second carries the same fact — the view's content
   * changed — and the last row of a turn is still announced, because the timer always fires.
   */
  const HISTORY_VIEW_PUSH_COALESCE_MS = 1000;
  /** `sessionId` → the pending view invalidation. */
  const historyViewPushes = new Map();
  const reasoningPublisher = createReasoningPublisher({
    push: pushSessionUpdate, invalidate: pushHistoryViewChanged,
    watched: (sessionId) => watchersFor(sessionId) > 0,
    rawNeeded: (sessionId) => [...(sessionSubscribers.get(sessionId) ?? [])].some(deviceId =>
      acceptedControllers.has(deviceId) && policy.canAccept(deviceId) && !historyDelivery.ready(deviceId, sessionId)),
    now: () => Number(now()),
    setTimeout: setTimeoutImpl, clearTimeout: clearTimeoutImpl,
  });

  /**
   * Tell the controllers watching a session that its history view changed.
   * @param sessionId - the session whose projection changed.
   */
  function pushHistoryViewChanged(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    historyDelivery.changed(sessionId);
    if (watchersFor(sessionId) === 0) return;
    if (historyViewPushes.has(sessionId)) return;
    const timer = setTimeoutImpl(() => {
      historyViewPushes.delete(sessionId);
      pushSessionUpdate(sessionId, 'maker:history-view-changed', { sessionId });
    }, HISTORY_VIEW_PUSH_COALESCE_MS);
    if (typeof timer?.unref === 'function') timer.unref();
    historyViewPushes.set(sessionId, timer);
  }

  /** Drop every pending view invalidation (teardown: no timers outlive the socket). */
  function clearHistoryViewPushes() {
    for (const timer of historyViewPushes.values()) {
      if (typeof clearTimeoutImpl === 'function') clearTimeoutImpl(timer);
    }
    historyViewPushes.clear();
  }

  /**
   * Push one live message to the controllers watching that session.
   *
   * The payload is exactly what the controller's `local-db:messages:created`
   * handler reads — `{ sessionId, message }` — so a live append and a transcript
   * read produce identical rows.
   *
   * "Identical rows" includes the images: a row is only renderable once its handles are inlined,
   * and this is the live half of that rule. It used to be the *only* half missing — the two read
   * paths hydrated, this one did not, so a photo the user had just sent arrived as a file entry
   * whose `imageRef` means nothing to the phone, and stayed that way until something re-read a
   * hydrated page (measured: 「我发给你的照片我在信息流里看不到」, with
   * `attachmentReads.attempted = 0`).
   *
   * Hydration failure must never cost the message: the row goes regardless, it just shows a file
   * chip instead of the picture.
   */
  async function pushSessionMessage(sessionId, message) {
    [message] = projectMessages([message]);
    if (message?.role === 'user' && activeDelivery?.owns(sessionId, message.clientId)) {
      await new Promise(resolve => queueMicrotask(resolve));
      const proof = await activeDelivery.projection(sessionId, { deliveryClientIds: [message.clientId] });
      if (proof.deliveryReceipts[0]?.state !== 'accepted') return;
    }
    try {
      // `options.resolveCapabilities` is the plugin's provider — the only source of the hydrator.
      // (Reading it through the router's own `resolveCapabilities` is not possible from here: that
      // name exists only as a property of the router's options object, and calling it as a bare
      // function threw a ReferenceError this `catch` then swallowed — hydration silently did
      // nothing, which is the same class of failure as the bug being fixed.)
      const provider = typeof options.resolveCapabilities === 'function' ? options.resolveCapabilities() : undefined;
      const hydrate = provider?.hydrateImages;
      if (!['error', 'system'].includes(message?.role) && typeof hydrate === 'function') await hydrate([message]);
    } catch {
      // Un-hydrated is still worth sending.
    }
    pushSessionUpdate(sessionId, 'local-db:messages:created', { sessionId, message });
    // …and tell the history view to re-read, coalesced. The two are not the same message: the
    // row above feeds the controller's message store, while this one is the only signal the
    // work-grouped view acts on (`DeviceLinkContext`: `historyView.invalidate(); return;`).
    // Without it a session the user was already inside did not update until it was reopened —
    // 报「重新进入会话之后对话就出来了」.
    pushHistoryViewChanged(sessionId);
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

  let deliveryNamespace = options.inputDeliveryNamespace ?? null;
  var activeDelivery = null;
  const deliveryInstances = new Set();
  let deliveryLastError = null;
  function getInputDelivery() {
    if (!options.inputDeliveryDirectory) return null;
    if (!deliveryNamespace) throw deliveryError('DELIVERY_NOT_AVAILABLE', 'Waiting for the authenticated Host account');
    if (activeDelivery) return activeDelivery;
    const namespace = deliveryNamespace;
    const currentBackend = () => {
      const backend = options.resolveCapabilities?.().inputDeliveryBackend;
      if (!backend || !backend.available()) throw deliveryError('DELIVERY_NOT_AVAILABLE', 'Durable DSH delivery backend is unavailable');
      return backend;
    };
    currentBackend();
    const file = joinDeliveryPath(options.inputDeliveryDirectory, deliveryHash('sha256').update(namespace).digest('hex') + '.sqlite');
    const store = openInputDeliveryStore({ file, namespace });
    const coordinator = createInputDeliveryCoordinator({
      store,
      backend: {
        prepare: (sid, row, opts) => currentBackend().prepare(sid, row, { ...opts, resolveAttachmentRef }),
        evidence: sid => currentBackend().evidence(sid),
        dispatch: entry => currentBackend().dispatch(entry, { releaseAttachmentRef: key => deliveryNamespace === namespace ? releaseAttachmentRef(key) : Promise.resolve() }),
        remove: (sid, id) => currentBackend().remove(sid, id),
        promote: (sid, id) => currentBackend().promote(sid, id),
        recoverColdInbox: (sid, entries) => currentBackend().recoverColdInbox(sid, entries),
      },
      baseProjection: sid => inputQueue.projectionFor(sid, sessionRowFor(sid)),
      validateProjection: projection => frameByteLength({ v: 1, kind: 'invoke-result', id: 'delivery', dst: 'controller', payload: { ok: true, result: projection } }) <= FRAME_BUDGET_BYTES - 24576,
      onChange: sid => {
        if (activeDelivery !== coordinator || deliveryNamespace !== namespace || stopped) return;
        pushSessionUpdate(sid, 'maker:input:projection', coordinator.currentProjection(sid));
        pushHistoryViewChanged(sid);
      },
      onError: error => { deliveryLastError = { at: new Date().toISOString(), code: error?.code ?? 'DELIVERY_FAILURE', message: String(error?.message ?? error).slice(0, 300) }; },
    });
    deliveryInstances.add(coordinator);
    activeDelivery = coordinator;
    coordinator.recover();
    return coordinator;
  }
  function bindDeliveryNamespace(namespace) {
    if (deliveryNamespace === namespace) return;
    deliveryNamespace = namespace;
    const previous = activeDelivery; activeDelivery = null;
    if (previous) void previous.close().then(() => deliveryInstances.delete(previous)).catch(error => recordHandlerError('input-delivery-close', error));
  }
  const deliveryTimer = options.inputDeliveryDirectory ? setInterval(() => { if (!stopped) activeDelivery?.recover(); }, 1000) : null;
  deliveryTimer?.unref?.();

  const routeInvoke = createChannelRouter({
    getSession: async (sessionId) => {
      if (source == null) throw new Error('no DSH session source is attached');
      const row = typeof source.getSession === 'function'
        ? await source.getSession(sessionId)
        : (await source.listSessions()).find((candidate) => String(candidate.id) === sessionId);
      if (row == null) return undefined;
      await refreshInterruption(sessionId, row);
      const [flagged] = projectSessionRows([row]);
      if (flagged !== undefined) sessionRowCache.set(String(flagged.id), flagged);
      return flagged;
    },
    listSessions: async () => {
      if (source === undefined || source === null) throw new Error('no DSH session source is attached');
      const rows = await source.listSessions();
      // The archive/delete/pin flags ride the source row's `status`/`pinnedAt`, which
      // is how they reach the wire row (`cindy-session-row.js`) at every read path —
      // list, get, and the row echoed back to a writer.
      const flagged = projectSessionRows(rows);
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
    listSessionStates: async (requestedSessionId) => {
      if (source === undefined || source === null) throw new Error('no DSH session source is attached');
      const rows = typeof source.listSessionStates === 'function' ? await source.listSessionStates(requestedSessionId) : await source.listSessions();
      return projectSessionRows(rows);
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
        validateSessionMetaPatch,
        applySessionFlags: applySessionMetadataFlags,
        sessionHidden: sessionIsHidden,
        publishSessionMeta,
        publishSessionCreated,
        // The controller's only way to *see* a file that lives on this machine: an image
        // the agent produced, or one picked in the file browser. Host-owned because the
        // upload needs this runtime's account session.
        exportFileStart: startFileExport,
        exportFileStatus: fileExportStatus,
        fileUrl,
        filePeer: (peer, payload) => filePeer.handle(peer, payload),
        // The chat-image path: the controller names a file on this machine (an image the
        // agent drew, referenced by path) and gets a staged key back.
        fetchLocalMedia,
        // The work-grouped history window (`local-db:messages:view` and its two siblings):
        // what lets the controller keep a projection across re-entries instead of
        // re-deriving continuity from 20-row pages and dropping what it cannot prove.
        historyView: provided.historyView ?? null,
        // The live push path's hydrator. It is not a controller capability — it never reaches a
        // channel — but it crosses this boundary for the same reason `historyView` does: the
        // plugin owns the attachment reader, and a row must be renderable in the frame that
        // carries it (see `pushSessionMessage`).
        hydrateImages: provided.hydrateImages,
      inputDelivery: getInputDelivery,
      inputProjection: (sessionId, pending) => { const base = inputQueue.projectionFor(sessionId, sessionRowFor(sessionId), pending ?? null); return activeDelivery ? activeDelivery.currentProjection(sessionId, [], base) : base; },
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
        // A prompt just accepted as steering: the controller's own id has to appear in
        // `steeringQueueClientIds`, or its bubble has nothing to hold on to until the
        // durable row lands (the model driver retires it in between).
        markSteering: (sessionId, item) => inputQueue.markSteering(sessionId, item),
        // And a prompt accepted as *queued*: the authoritative read can race DSH's splice,
        // so the row the controller is showing has to exist in the fold for a later
        // promotion, edit or removal to resolve.
        markQueued: (sessionId, item) => inputQueue.markQueued(sessionId, item),
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
       * Ask the controllers watching a session to re-read its history view.
       *
       * Exposed for the subscribe path: a controller that has just (re)subscribed is rebuilding
       * its view, and every push it missed while it was away was dropped by the relay, not queued.
       */
      invalidateHistoryView: (sessionId) => pushHistoryViewChanged(sessionId),
      /**
       * Whether a turn is live for this session.
       *
       * It decides whether an accepted prompt queues or is admitted immediately,
       * which is the difference between showing a 队列中 row and inventing one.
       */
      isSessionRunning: (sessionId) => isSessionRunningNow(sessionId),
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
      restoreTurnState: typeof provided.readMessages?.turnState === 'function' ? restoreWatchedTurnState : undefined,
      // The controller's goal panel refreshes from this push, so a write made on
      // the phone reaches any other screen watching the same session.
      pushGoalStatus: (sessionId, status) => pushSessionUpdate(sessionId, 'maker:goal:status-changed', { sessionId, goal: status }),
      ...provided,
      ackInterrupted: (sid, peer) => diagnosticAction(sid, peer),
      dismissError: (sid, cid, peer) => diagnosticAction(sid, peer, cid),
      ...(typeof provided.readMessages === 'function' ? { readMessages: async (...args) => projectMessages(await provided.readMessages(...args)) } : {}),
      ...(typeof provided.readAllMessages === 'function' ? { readAllMessages: async (...args) => projectMessages(await provided.readAllMessages(...args)) } : {}),
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
    getDevice: () => ({ deviceId: status.ownDeviceId, deviceName: hostDeviceName(current) }),
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
   * sessionId -> whether a turn is live, from DSH's own 	urn/start / 	urn/end.
   *
   * Deliberately not the row cache: see {@link setCachedRunning} — the cache is empty until
   * something reads the session list, and a Host that has just restarted has read nothing.
   */
  const liveTurnState = new Map();

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
    // The authoritative state lives **outside** the row cache.
    //
    // The cache is populated by list reads, so right after a restart — or simply before any
    // controller has listed sessions — there is no row to write to and the old version dropped the
    // fact on the floor. Measured consequence: a live turn reported `isSessionRunning: false`, so
    // `local-db:messages:view` marked the running work group `isStreaming: false` and the phone
    // neither drew the live card nor let this Host pin it to the end of the page
    // (「你一直在我的对话之上在工作」). The map is fed by every authority the cache is, and is the
    // one thing that is true whether or not a row has ever been read.
    liveTurnState.set(sessionId, running === true);
    const cached = sessionRowCache.get(sessionId);
    if (cached !== undefined) cached.running = running === true;
  }

  /** The turn state from DSH's own boundaries, falling back to a read row when none was seen. */
  function isSessionRunningNow(sessionId) {
    const known = liveTurnState.get(sessionId);
    return known === undefined ? sessionRowFor(sessionId)?.running === true : known;
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
  function announceTurnIdle(sessionId, event) {
    if (!event && typeof options.resolveCapabilities?.()?.readMessages?.turnState === 'function') {
      for (const deviceId of sessionSubscribers.get(sessionId) ?? []) void restoreWatchedTurnState(deviceId, sessionId);
      return;
    }
    const rawDiagnostic = turnDiagnosticRow(event, sessionId);
    const diagnostic = rawDiagnostic ? projectMessages([rawDiagnostic])[0] : null;
    const requiresNotice = diagnostic !== null || ['error', 'interrupted', 'max-tokens', 'aborted', 'blocked'].includes(event?.data?.reason?.kind);
    if (requiresNotice && !diagnostic) {
      recordHandlerError('turn-error', new Error('Invalid native failed-turn identity; history resynchronization required'));
      pushHistoryViewChanged(sessionId);
      return;
    }
    if (event && Number.isSafeInteger(event.seq)) {
      if ((nativeBoundaries.get(sessionId)?.seq ?? -1) >= event.seq) return;
      nativeBoundaries.set(sessionId, { seq: event.seq, turn: event.data?.turn });
    }
    turnVersions.set(sessionId, (turnVersions.get(sessionId) ?? 0) + 1);
    if (event) {
      const meta = advanceInterruptionMetadata(nativePresentationMetadata.get(sessionId), event, sessionId);
      nativePresentationMetadata.set(sessionId, meta); interruptionStates.set(sessionId, meta.interruption);
      if (event.data?.reason?.kind === 'interrupted' && !meta.start) {
        interruptionStates.delete(sessionId);
        void refreshInterruption(sessionId, sessionRowFor(sessionId)).then(() => publishRowPatch(sessionId, presentationFields(sessionId, isSessionRunningNow(sessionId))))
          .catch(error => recordHandlerError('interruption-metadata', error));
      }
    }
    const timer = pendingReconciles.get(sessionId);
    if (timer !== undefined) {
      pendingReconciles.delete(sessionId);
      if (typeof clearTimeoutImpl === 'function') clearTimeoutImpl(timer);
    }
    setCachedRunning(sessionId, false);
    // The frame goes to every watcher; only the **reachable** ones are recorded as told. The
    // same `device × session` pair must not be told twice inside the window, whichever path
    // tells it first — and the re-link repair depends on that record meaning "it arrived", so a
    // device the relay calls unreachable must not be written into it.
    const watchers = [...(sessionSubscribers.get(sessionId) ?? [])];
    if (requiresNotice) {
      const payload = turnDiagnosticPayload(diagnostic);
      for (const deviceId of watchers) sendNativeTerminal(deviceId, sessionId, payload, `end:${event.seq}`);
      // Error detail never goes to list subscribers or unwatched controllers.
      publishRowTurnState(sessionId, false);
      return;
    }
    if (event && Number.isSafeInteger(event.seq)) {
      for (const deviceId of watchers) sendNativeTerminal(deviceId, sessionId, { sessionId, event: { type: 'done' } }, `end:${event.seq}`);
    } else pushSessionUpdate(sessionId, 'maker:event', { sessionId, event: { type: 'done' } });
    for (const deviceId of watchers) {
      if (!offlineDevices.has(deviceId)) noteTerminalAnnounce(deviceId, sessionId);
    }
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
      // Reachable controllers only. A device the relay has declared offline is not told and
      // is not counted as told — the de-duplication entry below is a claim that the frame
      // arrived, and the re-link announcement above depends on it being true.
      const reachable = [...acceptedControllers].filter((deviceId) => !offlineDevices.has(deviceId));
      if (reachable.length > 0) {
        recordPush(sessionId, 'maker:event', reachable.length, payload);
        for (const deviceId of reachable) {
          send({ v: PROTOCOL_VERSION, kind: 'push', dst: deviceId, payload: { channel: 'maker:event', payload } });
          noteTerminalAnnounce(deviceId, sessionId);
        }
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
    publishRowPatch(sessionId, { running, ...presentationFields(sessionId, running), updatedAt: now().toISOString() });
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
    for (const dst of devices) if (acceptedControllers.has(dst) && policy.canAccept(dst)) send({ v: PROTOCOL_VERSION, kind: 'push', dst, payload: { channel: 'local-db:sessions:patched', payload } });
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
  function publishNativeJobUpdates(sessionId, jobs) {
    const owner = source; const port = owner?.backgroundJobs;
    if (stopped || watchersFor(sessionId) === 0 || typeof port?.updates !== 'function') return;
    void port.updates(sessionId, jobs).then(events => {
      if (stopped || source !== owner || source?.backgroundJobs !== port || watchersFor(sessionId) === 0) return;
      for (const event of events) pushSessionUpdate(sessionId, 'maker:event', { sessionId, event });
    }).catch(error => {
      if (!stopped && source === owner && watchersFor(sessionId) > 0) record('background-jobs', String(error?.message ?? error));
    });
  }
  function publishSessionCreated(sessionId) {
    if (ws !== null) publishLifecycle(ws, subscribers, { kind: 'session-added', sessionId },
      (channel, count, payload) => recordPush(sessionId, channel, count, payload));
  }
  function publishSessionMeta(sessionId, patch) {
    if (patch?.clearedAt !== undefined || patch?.status === 'deleted' || patch?.status === 'archived') {
      for (const deviceId of sessionSubscribers.get(sessionId) ?? []) historyDelivery.forget(deviceId, sessionId);
    }
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
    const running = rows.filter((row) => row?.running === true && !sessionIsHidden(row.id));
    if (running.length === 0) return;
    for (const row of running) {
      const payload = { sessionId: String(row.id), event: runningStatusEvent() };
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
  function announceTurnRunning(sessionId, event) {
    if (event && Number.isSafeInteger(event.seq)) {
      if ((nativeBoundaries.get(sessionId)?.seq ?? -1) >= event.seq) return;
      nativeBoundaries.set(sessionId, { seq: event.seq, turn: event.data?.turn });
    }
    turnVersions.set(sessionId, (turnVersions.get(sessionId) ?? 0) + 1);
    interruptionStates.set(sessionId, null);
    if (event) nativePresentationMetadata.set(sessionId, advanceInterruptionMetadata(nativePresentationMetadata.get(sessionId), event, sessionId));
    setCachedRunning(sessionId, true);
    pushSessionUpdate(sessionId, 'maker:event', { sessionId, event: runningStatusEvent() });
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
  /**
   * The phone's own diagnostics, kept apart from everything else and with their timestamps.
   *
   * A controller with no log of its own reports by invoking an unknown channel whose **name
   * carries the reading** — `psdiag.s10.p0.a0.c0.o0` from device-link's peer-silence probe,
   * `tdiag.stall.s96.r1.frame` / `tdiag.recover.after31s.r1.frame` from the mobile timer
   * liveness guard. Every one of them is refused here, which is the point: refusal is the
   * mailbox. Ordinary polling churns the rings above within seconds, so a stall that happened
   * two minutes ago is unreadable by the time anyone asks. This ring is evicted only by more
   * diagnostics, and each entry keeps the `at` the phone's report arrived at — the only
   * timeline that exists for a stalled app.
   */
  const phoneDiagnostics = [];
  const PHONE_DIAGNOSTIC_LIMIT = 40;
  const PHONE_DIAGNOSTIC_PREFIXES = ['psdiag.', 'tdiag.'];
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
      // A controller's self-report is the one refusal that carries evidence rather than a
      // capability gap, and it is worthless without its arrival time.
      if (PHONE_DIAGNOSTIC_PREFIXES.some((prefix) => served.startsWith(prefix))) {
        phoneDiagnostics.push({ at: entry.at, channel: served, src: entry.src ?? null });
        if (phoneDiagnostics.length > PHONE_DIAGNOSTIC_LIMIT) {
          phoneDiagnostics.splice(0, phoneDiagnostics.length - PHONE_DIAGNOSTIC_LIMIT);
        }
      }
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
      // Which session received the prompt, and which text: a send is the one request whose
      // effect is invisible in this log otherwise, and 「我发了两条消息，你收到了吗」 took a
      // log excavation to answer — the session id and a bounded length make it a lookup.
      const sessionId = typeof args?.[0] === 'string' && args[0] !== '' ? args[0] : (typeof args?.[0]?.sessionId === 'string' ? args[0].sessionId : '?');
      const text = typeof args?.[1] === 'string' ? args[1] : (typeof args?.[1]?.text === 'string' ? args[1].text : null);
      const clientId = typeof args?.[1]?.clientId === 'string' && args[1].clientId !== '' ? args[1].clientId : null;
      const parts = [
        sessionId,
        `text=${text === null ? 'none' : `${text.length}c`}`,
        `clientId=${clientId ?? 'none'}`,
      ];
      if (files.length > 0) {
        const refs = files.filter((file) => isAttachmentOssRef(file?.path)).length;
        const form = refs === files.length ? 'oss-refs' : refs === 0 ? 'host-paths' : 'mixed';
        parts.push(`attachments=${files.length} form=${form}`);
      }
      return parts.join(' ');
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
        if (boundSocketGeneration !== generation) {
          boundSocketGeneration = generation;
          exportOwner.bind({ realm: mediaBase + '|' + normalizeAuthBaseUrl(socketSession?.authBaseUrl),
            userId: frame.payload?.userId, session: socketSession });
        }
        const payload = frame.payload ?? {};
        status.setHost({
          deviceName: hostDeviceName(current),
          deviceId: typeof payload.deviceId === 'string' ? payload.deviceId : null,
          userId: typeof payload.userId === 'string' ? payload.userId : null,
          protocolVersion: typeof payload.serverProtocolVersion === 'number' ? payload.serverProtocolVersion : null,
        });
        if (typeof payload.userId === 'string' && typeof payload.deviceId === 'string') bindDeliveryNamespace([mediaBase, normalizeAuthBaseUrl(socketSession?.authBaseUrl), payload.userId, payload.deviceId].join('|'));
        status.setState('waiting');
        syncDeviceName();
        // The relay itself accepted us, which is the first moment "online" is true —
        // so this is where the reconnect ladder starts forgetting failed attempts.
        markConnectionStable();
        // Devices already online for this account never re-announce themselves.
        void refreshDeviceDirectory().catch((error) => recordHandlerError('device-directory', error));
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
        // The relay's own answer about reachability, and the only one that counts.
        //
        // Measured failure this prevents: the relay reported the handset `online:false` at
        // 09:17:38 while the Host kept pushing rows and turn events at it for minutes — each
        // frame dropped with no route, the phone frozen on 思考中. What presence decides is that
        // those frames are **not counted as delivered** (so the re-link announcement is still
        // allowed to fire); it does **not** delete the subscription. See
        // `markDeviceUnreachable` — the first version did delete it, and a stale `online:false`
        // at 09:48:04 then silenced a handset the user was holding.
        if (snapshot.online !== true) {
          // Marked unreachable *before* anything else, because the terminal announcement for a
          // turn that ends while the device is away must not be counted as delivered: it is a
          // frame into a void, and recording it would suppress the re-link announcement that
          // is supposed to repair exactly that.
          filePeer.closePeer(snapshot.deviceId);
          markDeviceUnreachable(snapshot.deviceId);
        } else if (typeof snapshot.deviceId === 'string') {
          // Reachable again by the relay's own account: same restoration as an inbound frame,
          // so a device that comes back does not have to re-subscribe by hand to be pushed to.
          markDeviceReachable(snapshot.deviceId);
        }
        return;
      }
      case 'link-open': {
        if (typeof frame.id !== 'string' || typeof frame.src !== 'string') return;
        if (!policy.canAccept(frame.src)) return;
        historyDelivery.forget(frame.src);
        for (const sessionId of watchedSessionsByDevice.get(frame.src) ?? []) renewTurnLease(frame.src, sessionId);
        // A link-open is itself proof the relay has a route to this device.
        markDeviceReachable(frame.src);
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
        void announceRunningSessions(frame.src).catch((error) => recordHandlerError('announce-running', error));
        // …and the *terminal* truth for the sessions it was watching before the relay
        // dropped it. `announceRunningSessions` covers a turn still in flight; a turn that
        // ended while the device was away would otherwise be announced by nothing, and the
        // handset would keep spinning until the user re-entered the session by hand — the
        // reported 「我必须要返回上一页退出会话重新进才能看到你的回答」.
        for (const sessionId of watchedSessionsByDevice.get(frame.src) ?? []) {
          announceWatchedTurnState(frame.src, sessionId);
        }
        return;
      }
      case 'link-close': {
        if (typeof frame.src !== 'string') return;
        for (const sessionId of watchedSessionsByDevice.get(frame.src) ?? []) renewTurnLease(frame.src, sessionId);
        filePeer.closePeer(frame.src);
        acceptedControllers.delete(frame.src);
        historyDelivery.forget(frame.src);
        observeRemindersSource();
        status.upsertDevice(frame.src, { isController: false });
        status.refreshConnectionState();
        return;
      }
      case 'invoke': {
        if (typeof frame.id !== 'string' || typeof frame.src !== 'string') return;
        // Before anything else: a frame from a device the relay declared unreachable revokes
        // that verdict, and everything it was dropped from comes back. See
        // `markDeviceReachable` — presence can be stale in the direction that leaves a
        // live handset with no pushes at all.
        markDeviceReachable(frame.src);
        // …and, when this frame names a session somebody is watching, repair it for them. This is
        // the trigger that survives a background/foreground transition: the client does not
        // re-subscribe on resume, but it always talks to us about the session it is showing.
        {
          const candidate = typeof frame?.payload?.args?.[0] === 'string' ? frame.payload.args[0] : null;
          if (candidate !== null && sessionSubscribers.has(candidate)) pulseRepair(candidate);
        }
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
        const historyRead = historyDelivery.begin(frame);
        const invokeGeneration = generation;
        const invokeSocket = ws;
        void handleInvoke(frame).then(
          (reply) => {
            // `null` means the request was unaddressable; the relay guard above
            // already rejects those, so this only defends the invariant.
            if (reply === null || invokeGeneration !== generation || invokeSocket !== ws) {
              historyDelivery.finish(historyRead, false); return;
            }
            // Fitting and sending are Host code on a reply that ultimately came from DSH, so
            // they are exactly where an unexpected shape would surface — and a throw from
            // inside a `.then` callback is an unhandled rejection, which this process treats
            // as fatal. The controller still needs an answer, so it gets one.
            try {
              const fitted = fitReplyToFrame(reply, frame);
              const sent = send(fitted);
              const page = fitted?.payload?.result;
              const complete = sent && fitted?.payload?.ok === true && page?.version === 1 && Array.isArray(page.items);
              if (historyDelivery.finish(historyRead, complete)) pushHistoryViewChanged(historyRead.sessionId);
            } catch (error) {
              historyDelivery.finish(historyRead, false);
              recordHandlerError('invoke-reply', error);
              send({
                v: PROTOCOL_VERSION,
                kind: 'invoke-result',
                id: frame.id,
                dst: frame.src,
                payload: { ok: false, error: { code: 'INTERNAL', message: 'DSH Host failed to serve this channel' } },
              });
            }
          },
          (error) => {
            // Named with the channel: seven identical `TimeoutError`s in the diagnostics after one
            // restart were unattributable, and "which read is missing its budget" is the whole
            // question. `frame.payload.channel` is the only thing that answers it.
            historyDelivery.finish(historyRead, false);
            if (invokeGeneration !== generation || invokeSocket !== ws) return;
            recordHandlerError(`invoke:${typeof frame?.payload?.channel === 'string' ? frame.payload.channel : '?'}`, error);
            send({ v: PROTOCOL_VERSION, kind: 'invoke-result', id: frame.id, dst: frame.src, payload: { ok: false, error: { code: 'INTERNAL', message: 'DSH Host failed to serve this channel' } } });
          },
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
          deviceName: hostDeviceName(current),
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
      // A relay frame is outside input, and a synchronous throw here would leave this
      // listener and become an uncaught exception — fatal to the whole DSH process, not just
      // to this Host. Contain it and record what it was.
      try {
        handleFrame(frame);
      } catch (error) {
        recordHandlerError('frame', error);
      }
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
    if (stopped || connecting === generation || ws !== null || !active) return;
    const myGeneration = ++generation;
    connecting = myGeneration;
    try {
      status.setLogin({ authenticated: false, required: false });
      status.setState('authenticating', '正在读取本机 Cindy 登录态');

      let resolved;
      try {
        resolved = await serializeCredentialOperation(() => resolveSession());
      } catch (error) {
        resolved = error?.code === 'CREDENTIAL_STORE_UNAVAILABLE'
          ? { ok: false, reason: error.code, message: error.message }
          : { ok: false, message: '读取本机 Cindy 登录态失败' };
      }
      if (stopped || !active || myGeneration !== generation) return;

      if (!resolved?.ok) {
        if (resolved?.reason === 'CREDENTIAL_STORE_UNAVAILABLE') {
          // Repair the local store first; another login cannot be persisted either.
          status.setLogin({ authenticated: false, required: false });
          status.setState('failed', resolved.message);
          return;
        }
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
        socketSession = Object.freeze({ ...session });
        socket = openSocket(socketSession, relayUrl);
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
      if (connecting === myGeneration) connecting = null;
    }
  }

  /**
   * Tear the relay down and forget everything it taught us.
   * @param options - `keepSwitch` leaves the switch on (a heartbeat recovery
   *   attempt) instead of returning the status to `disconnected`.
   */
  async function disconnect({ keepSwitch = false, preserveExports = false } = {}) {
    source?.manualCompact?.cancelAll('Host link disconnected');
    source?.forkSession?.cancelAll();
    source?.keywordSearch?.cancelAll();
    source?.backgroundJobs?.cancelAll();
    source?.subagentReads?.cancelAll();
    source?.reminders?.cancelAll();
    source?.projectOrder?.cancelAll();
    source?.referenceHistory?.cancelAll();
    disposeProjectOrderObservation?.(); disposeProjectOrderObservation = null;
    disposeReminderObservation?.(); disposeReminderObservation = null;
    if (!preserveExports) exportOwner.invalidate();
    generation += 1;
    deviceNameSync.reset(current?.deviceName?.trim() || null);
    filePeer.closeAll();
    stopHeartbeat();
    // A pending view invalidation has no socket to reach once this returns; firing it later
    // would push to a link that is gone.
    clearHistoryViewPushes();
    reasoningPublisher.clear();
    historyDelivery.clear();
    acceptedControllers.clear();
    subscribers.clear();
    sessionSubscribers.clear();
    liveTurnState.clear();
    nativeBoundaries.clear();
    interruptionStates.clear();
    nativePresentationMetadata.clear();
    turnVersions.clear();
    terminalIdentities.clear();
    subscriptionLeases.clear();
    lastRepairPulse.clear();
    directoryAsked.clear();
    // Relay recovery is not task cancellation. Keep questions for the next
    // subscription; explicit switch-off/stop still releases all waits.
    approvals.clear({ preserveQuestions: keepSwitch });
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
    socketSession = null;
    if (!preserveExports) transferDiagnostics.clear();
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
    const nameChanged = previous?.deviceName !== next?.deviceName;
    const host = status.snapshot().host;
    if (host && nameChanged) status.setHost({ ...host, deviceName: hostDeviceName(next) });
    if (nameChanged) syncDeviceName();
    // The settings section is the durable home of the archive/delete/pin flags, so
    // every settings change is also a chance for another instance (or a hand edit)
    // to have moved them. `replace` never writes back — see `session-flags.js`.
    sessionFlags.replace(next?.sessionFlags);
    policy.update(next);
    historyDelivery.clear();
    observeRemindersSource();
    filePeer.pruneUnauthorized();
    fileExports.pruneUnauthorized();
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
    disposeArchiveObservation?.();
    disposeArchiveObservation = null;
    active = false;
    await disconnect();
    await fileExports.stop();
    if (deliveryTimer !== null) clearInterval(deliveryTimer);
    await Promise.all([...deliveryInstances].map(coordinator => coordinator.close()));
    deliveryInstances.clear(); activeDelivery = null;
    status.setState('disconnected');
  }

  /** Follow native metadata even while transport is off; reconnect reads the same registry. */
  observeArchiveSource();
  /** Start if the resolved settings already ask for transport. */
  await updateSettings(settings);

  return {
    model,
    subscribers,
    acceptedControllers,
    policy,
    status,
    getProjectOrderOwner: () => {
      const owner = exportOwner.capture(); const deviceId = status.ownDeviceId;
      if (!active || stopped || !source || !owner || !deviceId || !['waiting', 'connected'].includes(status.snapshot().state)) return undefined;
      return { dataOwnerId: 'dsh:' + owner.runtimeId + ':' + deviceId + ':' + sourceRevision, ownerGeneration: owner.epoch };
    },
    getStatus: () => ({ ...status.snapshot(), pluginVersion: HOST_PLUGIN_VERSION, nameSync: deviceNameSync.snapshot(), inputDelivery: { ready: activeDelivery !== null, version: activeDelivery ? 1 : null, pending: activeDelivery?.diagnostics().slice(0, 30) ?? [], lastError: deliveryLastError } }),
    deleteDevice,
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
    /** The phone's own reports, oldest first, each with the time it arrived. */
    getPhoneDiagnostics: () => phoneDiagnostics.slice(),
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
    /**
     * Errors caught at this Host's own boundaries.
     *
     * Empty is the only healthy value. A populated entry means some frame, reply or
     * background chain would otherwise have escaped as an unhandled rejection — which DSH
     * answers with `fatal load failure` and `exit(1)` for the entire desktop process, so
     * this list is the record of an outage that was prevented rather than survived.
     */
    getHandlerErrors: () => handlerErrors.slice(),
    /** How many rows were deliberately not shown; see {@link suppressedNotices}. */
    getSuppressedNotices: () => suppressedNotices,
    /** Count one hidden row. */
    noteSuppressedNotice: () => { suppressedNotices += 1; },
    /**
     * How long this Host has been up.
     *
     * Read by the diagnostics liveness verdict: a clean boundary record is only meaningful next
     * to the time it has had to fire, because a boundary that never fires and one that is not
     * installed look identical from the outside.
     */
    getUptimeMs: () => now().getTime() - startedAtMs,
    /**
     * Record an error caught in the plugin layer.
     *
     * Cordis dispatches listeners with no `try`/`catch` of its own, so a throw from a
     * `session/event` handler leaves DSH's event dispatch as an unhandled rejection — which
     * this process treats as fatal. The plugin's own boundaries have nowhere else to put
     * what they caught, so they hand it here.
     */
    noteHandlerError: (where, error) => recordHandlerError(where, error),
    /** The topics controllers currently hold, for the status route's diagnostics. */
    getSubscriptions: () => ({
      devices: [...subscribers],
      sessions: [...sessionSubscribers].map(([sessionId, devices]) => ({ sessionId, devices: [...devices] })),
    }),
    /** Push one live session message to the controllers watching that session. */
    pushSessionMessage,
    projectMessages,
    pushSessionReasoning: reasoningPublisher.noteEvent,
    // Only explicit native scheduled/started retry events assert ongoing work.
    // Failed attempts alone never terminate or start a turn.
    pushSessionDiagnostic: (sessionId, event) => {
      if (!['llm/retry', 'llm/retry-started'].includes(event?.type)) return;
      const row = turnDiagnosticRow(event, sessionId);
      const boundary = nativeBoundaries.get(sessionId);
      if (!row || (boundary?.seq ?? -1) >= event.seq
        || (boundary?.turn !== undefined && boundary.turn !== event.data?.turn)) return;
      turnVersions.set(sessionId, (turnVersions.get(sessionId) ?? 0) + 1);
      setCachedRunning(sessionId, true);
      pushSessionUpdate(sessionId, 'maker:event', { sessionId, event: runningStatusEvent(row.content) });
    },
    /**
     * Announce a real turn boundary to a session's watchers.
     *
     * The plugin drives these from DSH's `turn/start` and `turn/end` events, which
     * are the boundaries the controller's spinner is defined against. The
     * projection's running flag flaps inside a single turn, so it is not allowed
     * to end one (see `turnEventFor`).
     */
    pushTurnRunning: (sessionId, event) => announceTurnRunning(sessionId, event),
    pushTurnIdle: (sessionId, event) => announceTurnIdle(sessionId, event),
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
        if (isSessionRunningNow(sessionId)) return;
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
      inputQueue.retire(sessionId, controllerId);
      pushSessionUpdate(sessionId, 'maker:input:projection', inputQueue.projectionFor(sessionId, sessionRowFor(sessionId)));
    },
    /** Begin a controller approval and expose its cancellable pending handle. */
    beginApproval,
    /** Ask the watching controllers to decide a DSH approval; null when none is watching. */
    askApproval,
    /** Begin a controller question and expose its cancellable pending handle. */
    beginUserQuestion,
    /** Ask the watching controllers a structured question; null when none is watching. */
    askUserQuestion,
    /** Fold one `sessionController.control()` frame into the input queue. */
    applyControlFrame: (frame) => {
      inputQueue.apply(frame);
      // Reuse DSH's existing source-owned control stream: no per-phone job
      // stream, output cursor or extra observer remains alive after disconnect.
      if (frame?.type === 'jobs' && typeof frame.sessionId === 'string') publishNativeJobUpdates(frame.sessionId, frame.jobs);
      if (frame?.type === 'baseline') for (const [id, jobs] of Object.entries(frame.value?.jobs ?? {})) publishNativeJobUpdates(id, jobs);
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
    /**
     * Whether a turn is live for one session, from DSH's own boundaries.
     *
     * Public because it is the fact the history view's `isStreaming` marker is built on: "the
     * phone drew no live card" and "the running card was not pinned last" both reduce to this
     * answering false during a live turn.
     */
    isSessionRunning: (sessionId) => isSessionRunningNow(sessionId),
    /** The questions still open, in the controller's shape. */
    listPendingInteractions: (sessionId) => approvals.list(sessionId),
    /**
     * Let the Web/API bridge observe the same ask_user registry as the phone.
     * Registering replays open questions; disposing only ends observation.
     */
    observeUserQuestions: (observer) => approvals.observeUserQuestions(observer),
    /** Both Web and Android answers go through this one registry settlement. */
    resolveInteraction,
    /** A DSH-local UI answer is already in DSH outcome form. */
    settleInteractionOutcome,
    updateSettings,
    connect,
    /** The card's reconnect button: retry immediately and forget the backoff ladder. */
    reconnectNow,
    disconnect,
    // Explicit successful login/select only; never called by Export or refresh.
    beginIdentityChange: () => disconnect({ keepSwitch: true }),
    getTransferDiagnostics: () => ({ ...transferDiagnostics.snapshot(), jobs: fileExports.getStats() }),
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
