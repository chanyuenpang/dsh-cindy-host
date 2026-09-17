/**
 * The Cindy Host's connection status — the single source of truth the settings
 * card renders.
 *
 * The card never decides whether the Host is connected: it polls this snapshot
 * and draws it. Every field here is produced by an observed event (an HTTP
 * answer from Cindy, a relay frame, a socket close), never by a UI guess.
 *
 * State vocabulary is the six states the Settings card must show:
 *   disconnected   the 连接手机 switch is off, or nothing has started
 *   authenticating a Cindy session is being read, refreshed, or logged in
 *   connecting     a connection was lost and is being retried automatically
 *   waiting        the relay is online; no phone has reached this Host yet
 *   connected      a phone opened a link or invoked this Host
 *   failed         a concrete failure; `message` says which
 *
 * `connecting` is the state that makes a dropped socket survivable. Without it a Host
 * that lost the relay had nowhere honest to put "retrying" and reported `failed`, which
 * on a phone-controlled Host reads as "DSH is gone" until somebody presses reconnect.
 * The Cindy client has exactly this middle state (`stopped | connecting | online`) and
 * never shows a terminal failure for an ordinary network loss.
 */

/** Ordered state vocabulary; also the wire vocabulary of the status route. */
export const CONNECTION_STATES = Object.freeze(['disconnected', 'authenticating', 'connecting', 'waiting', 'connected', 'failed']);

/** Chinese labels for the card. Kept beside the states so both move together. */
export const STATE_LABELS = Object.freeze({
  disconnected: '未连接',
  authenticating: '登录中',
  connecting: '正在重连',
  waiting: '等待手机连接',
  connected: '已连接',
  failed: '连接失败',
});

/** English labels, used when the page language is not Chinese. */
export const STATE_LABELS_EN = Object.freeze({
  disconnected: 'Not connected',
  authenticating: 'Signing in',
  connecting: 'Reconnecting',
  waiting: 'Waiting for phone',
  connected: 'Connected',
  failed: 'Connection failed',
});

/** A device row the card may show; deviceId is the only required field. */
function normalizeDevice(deviceId, patch) {
  return {
    deviceId,
    name: typeof patch.name === 'string' && patch.name !== '' ? patch.name : deviceId.slice(0, 8),
    platform: typeof patch.platform === 'string' ? patch.platform : null,
    online: patch.online === true,
    isController: patch.isController === true,
    linkedAt: patch.linkedAt ?? null,
    lastSeenAt: patch.lastSeenAt ?? null,
  };
}

/** Whether a device row is a phone the user cares about. */
export function isMobilePlatform(platform) {
  return platform === 'ios' || platform === 'android';
}

/**
 * Holds the Host's current status and notifies subscribers on change.
 *
 * Notifications are coalesced by value: `publish` runs only when the snapshot
 * actually differs, so a relay that repeats a presence frame does not wake the
 * card's poll loop for nothing.
 */
export class HostStatus {
  #listeners = new Set();
  #devices = new Map();
  #ownDeviceId = null;
  #status;

  /** @param options - injectable clock for deterministic tests. */
  constructor({ now = () => new Date() } = {}) {
    this.now = now;
    this.#status = {
      state: 'disconnected',
      stateLabel: STATE_LABELS.disconnected,
      message: null,
      login: { authenticated: false, required: false, kind: null, identifier: null },
      host: null,
      devices: [],
      updatedAt: this.now().toISOString(),
    };
  }

  /** @param listener - invoked after each replacement snapshot. @returns disposer. */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** @returns a deep copy; callers may serialize it freely. */
  snapshot() {
    return {
      ...this.#status,
      login: { ...this.#status.login },
      host: this.#status.host === null ? null : { ...this.#status.host },
      devices: this.#status.devices.map((device) => ({ ...device })),
    };
  }

  /** The relay-assigned device id of this Host, excluded from the device list. */
  get ownDeviceId() {
    return this.#ownDeviceId;
  }

  #publish(patch) {
    const previous = JSON.stringify({ ...this.#status, updatedAt: '' });
    const next = { ...this.#status, ...patch };
    next.devices = [...this.#devices.values()]
      .filter((device) => device.deviceId !== this.#ownDeviceId)
      .sort(compareDevices);
    next.stateLabel = STATE_LABELS[next.state] ?? next.state;
    if (JSON.stringify({ ...next, updatedAt: '' }) === previous) return;
    next.updatedAt = this.now().toISOString();
    this.#status = next;
    const snapshot = this.snapshot();
    for (const listener of [...this.#listeners]) {
      try {
        listener(snapshot);
      } catch {
        // A broken observer must not corrupt the Host's own status.
      }
    }
  }

  /** Move to a state, replacing the failure message (or clearing it). */
  setState(state, message = null) {
    if (!CONNECTION_STATES.includes(state)) throw new Error(`Unknown Cindy host state: ${String(state)}`);
    this.#publish({ state, message });
  }

  /** Record what the Host knows about the Cindy account behind the relay. */
  setLogin({ authenticated, required = false, kind = null, identifier = null }) {
    this.#publish({ login: { authenticated: authenticated === true, required: required === true, kind, identifier } });
  }

  /** Record this Host's relay identity from `hello-ack`, or clear it. */
  setHost(host) {
    if (host === null) {
      this.#ownDeviceId = null;
      this.#publish({ host: null });
      return;
    }
    this.#ownDeviceId = typeof host.deviceId === 'string' ? host.deviceId : null;
    this.#publish({ host: { deviceName: 'DSH Host', platform: 'desktop', appVersion: '0.1.0', online: true, protocolVersion: null, userId: null, ...host } });
  }

  /** Insert or merge one device row, preserving fields the patch omits. */
  upsertDevice(deviceId, patch = {}) {
    if (typeof deviceId !== 'string' || deviceId === '') return;
    const existing = this.#devices.get(deviceId);
    this.#devices.set(deviceId, normalizeDevice(deviceId, { ...existing, ...patch }));
    this.#publish({});
  }

  /** Drop one device row (e.g. it left the account). */
  removeDevice(deviceId) {
    if (!this.#devices.delete(deviceId)) return;
    this.#publish({});
  }

  /** Forget every device and accepted controller — the switch-off reset. */
  clearDevices() {
    if (this.#devices.size === 0) return;
    this.#devices.clear();
    this.#publish({});
  }

  /** Whether any device has actually reached this Host. */
  get hasLinkedController() {
    for (const device of this.#devices.values()) if (device.isController) return true;
    return false;
  }

  /**
   * Re-derive `connected`/`waiting` from the device ledger.
   *
   * Called after a controller arrives or leaves; never called while the Host is
   * mid-handshake or failed, so a late frame cannot mask a real failure.
   */
  refreshConnectionState() {
    if (this.#status.state === 'disconnected' || this.#status.state === 'failed') return;
    if (this.hasLinkedController) this.setState('connected');
    else if (this.#ownDeviceId !== null) this.setState('waiting');
  }

  /** Reset everything for a switch-off, in one publish. */
  reset() {
    this.#devices.clear();
    this.#ownDeviceId = null;
    this.#publish({
      state: 'disconnected',
      message: null,
      host: null,
      login: { authenticated: false, required: false, kind: null, identifier: null },
    });
  }
}

/** Phones first, then controllers, then by name and id for a stable order. */
function compareDevices(left, right) {
  return (
    Number(isMobilePlatform(right.platform)) - Number(isMobilePlatform(left.platform)) ||
    Number(right.isController) - Number(left.isController) ||
    Number(right.online) - Number(left.online) ||
    String(left.name).localeCompare(String(right.name)) ||
    left.deviceId.localeCompare(right.deviceId)
  );
}
