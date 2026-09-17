export const SETTINGS_NAMESPACE = 'dsh-cindy-host';

// Network access is opt-in. A newly mounted bundle only projects local DSH data.
//
// `sessionFlags` is the one section a *controller* writes: DSH has no archived,
// deleted or pinned session state, so the phone's 删除/归档/置顶 are this Host's own
// bookkeeping and they have to survive a restart (see `session-flags.js`).
export const DEFAULT_HOST_SETTINGS = Object.freeze({ transportEnabled: false, remoteControlEnabled: false, controllers: {}, deviceId: '', sessionFlags: {} });

/**
 * The Host's own relay identity, when it has one.
 *
 * It is stored here rather than derived from the credential because the credential
 * can legitimately disappear — an expired token, a fresh install, or (as happened
 * once) a refresh failure that used to delete it — while the identity is what a
 * phone linked to. Losing the credential must not silently re-pair the Host as a
 * different device.
 * @param value - the settings section.
 * @returns the device id, or an empty string when none was ever recorded.
 */
export function rememberedDeviceId(value) {
  return typeof value?.deviceId === 'string' ? value.deviceId.trim() : '';
}

export function validateHostSettings(value) {
  if (!value || typeof value !== 'object' || typeof value.transportEnabled !== 'boolean' || typeof value.remoteControlEnabled !== 'boolean' || !value.controllers || typeof value.controllers !== 'object') throw new Error('Invalid DSH Cindy Host settings');
  if (value.deviceId !== undefined && typeof value.deviceId !== 'string') throw new Error('Invalid DSH Cindy Host settings');
  for (const [id, entry] of Object.entries(value.controllers)) {
    if (!id || !entry || !['authorized', 'revoked'].includes(entry.state)) throw new Error('Invalid controller authorization');
  }
  // An absent section is valid — every settings file written before this field
  // existed has none, and rejecting it would fail the load instead of the flag.
  if (value.sessionFlags !== undefined) {
    if (value.sessionFlags === null || typeof value.sessionFlags !== 'object') throw new Error('Invalid session flags');
    for (const [sessionId, flags] of Object.entries(value.sessionFlags)) {
      if (sessionId === '' || flags === null || typeof flags !== 'object') throw new Error('Invalid session flags');
      if (flags.status !== undefined && !['active', 'archived', 'deleted'].includes(flags.status)) throw new Error('Invalid session status flag');
      if (flags.pinnedAt !== undefined && typeof flags.pinnedAt !== 'string') throw new Error('Invalid session pin flag');
    }
  }
}
