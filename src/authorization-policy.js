/**
 * Who may control this Host.
 *
 * Two facts decide admission, and only two:
 *  1. the user turned the phone connection on (the settings switch), and
 *  2. the device has not been explicitly revoked.
 *
 * There is deliberately no per-device enrollment step. The relay only ever
 * routes frames between devices of ONE Cindy account, so a `link-open` that
 * arrives here is already the same account as the session this Host logged in
 * with; asking the user to additionally bless each device would be an
 * enrollment UI the current scope excludes. Revocation stays available and is
 * honored, which is what makes that omission safe to revisit later.
 */
export class AuthorizationPolicy {
  /** @param settings - resolved `dsh-cindy-host` settings section. */
  constructor(settings = {}) {
    this.update(settings);
  }

  /** Re-resolve from settings; called on every settings change. */
  update(settings = {}) {
    // Keep the caller's section verbatim so `revoke` can hand back something
    // `update` accepts — the internal shape below is not the settings shape.
    this.raw = settings;
    this.settings = {
      // `transportEnabled` is the card's switch. `remoteControlEnabled` is the
      // legacy/hand-edited spelling of the same intent and is still honored.
      enabled: settings.transportEnabled === true || settings.remoteControlEnabled === true,
      controllers: settings.controllers && typeof settings.controllers === 'object' ? settings.controllers : {},
    };
  }

  /** Whether this Host is currently willing to be controlled at all. */
  isEnabled() {
    return this.settings.enabled;
  }

  /**
   * Whether one `link-open`/`invoke` source may be served.
   * @param deviceId - relay-assigned source device id (`Envelope.src`).
   */
  canAccept(deviceId) {
    if (!this.settings.enabled || typeof deviceId !== 'string' || deviceId === '') return false;
    return this.settings.controllers[deviceId]?.state !== 'revoked';
  }

  /** Produce the settings a revocation would write. Pure: the caller persists it. */
  revoke(deviceId) {
    const entry = this.settings.controllers[deviceId] ?? {};
    return {
      ...this.raw,
      controllers: {
        ...this.settings.controllers,
        [deviceId]: { ...entry, state: 'revoked', revokedAt: new Date().toISOString(), grantRevision: (entry.grantRevision || 0) + 1 },
      },
    };
  }
}
