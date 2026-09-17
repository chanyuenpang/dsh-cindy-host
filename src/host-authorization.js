/**
 * The link-accept this Host answers a controller's `link-open` with.
 *
 * Two payload fields matter beyond the formality of accepting:
 *
 *  - `allowlistHash` — a fingerprint of the channel set, so a controller can notice that
 *    the two ends disagree about what exists.
 *  - `capabilities` — the **optional end-to-end** features this controlled end offers.
 *    They are negotiated here and nowhere else: the phone's transport reads
 *    `accepted.capabilities` before it will even call a gated channel
 *    (`apps/mobile/src/device-link/historyViewCapability.ts` refuses the three
 *    `local-db:messages:*view*` channels unless `history-view-v1` is present). Serving a
 *    gated channel without advertising its capability therefore changes nothing at all —
 *    which is exactly the trap this file now documents.
 */

const CHANNELS = ['device-link:subscribe', 'local-db:sessions:list'];

/**
 * Optional capabilities this Host offers.
 *
 * `history-view-v1` (`DEVICE_LINK_CAPABILITY_HISTORY_VIEW_V1` in the Cindy protocol) turns
 * on the work-grouped history window: the controller keeps a projection with its own cursor
 * instead of re-deriving continuity from 20-row pages, which is what made re-entering a
 * session drop the history it had already loaded.
 */
export const HOST_CAPABILITIES = Object.freeze(['history-view-v1']);

export function computeAllowlistHash() { const text = [...CHANNELS].sort().join('\n'); let hash = 0x811c9dc5; for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; } return hash.toString(16).padStart(8, '0'); }

/**
 * Accept one controller's link and tell it what this Host can do.
 * @param frame - the `link-open` frame being answered.
 * @param acceptedControllers - the set of controllers this Host accepts.
 * @param capabilities - what to advertise; defaults to {@link HOST_CAPABILITIES}.
 * @returns the `link-accept` frame.
 */
export function acceptLink(frame, acceptedControllers, capabilities = HOST_CAPABILITIES) {
  acceptedControllers.add(frame.src);
  return {
    v: 1,
    kind: 'link-accept',
    id: frame.id,
    dst: frame.src,
    payload: {
      appVersion: '0.1.0',
      allowlistHash: computeAllowlistHash(),
      ...(capabilities.length === 0 ? {} : { capabilities: [...capabilities] }),
    },
  };
}
