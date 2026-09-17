/**
 * Reconnect policy for the relay socket.
 *
 * The reference is the Cindy device-link **client** (`packages/device-link/src/client.ts`),
 * which never treats a lost socket as a terminal state: it keeps a `connecting` status
 * and retries with exponential backoff, which is why a Cindy client "从来没有掉线过".
 * This Host used to do the opposite — drop the socket, report `failed`, and wait for a
 * person to press reconnect. On a phone-controlled Host that is a silent outage: the
 * card says 断线 and the handset simply has no DSH in its device list until someone
 * walks over to the desktop.
 *
 * The numbers are the client's defaults, so both ends of the same link recover on the
 * same schedule:
 *
 * | constant | value | meaning |
 * | --- | --- | --- |
 * | `RECONNECT_BASE_MS` | 1s | first retry |
 * | `RECONNECT_MAX_MS` | 30s | cap, so retries continue forever at ≤30s |
 * | `RECONNECT_STABLE_RESET_MS` | 10s | stably online this long resets the ladder |
 *
 * One deliberate omission: the client's separate **congestion** ladder
 * (`congestionBackoffBaseMs`/`congestionStableResetMs`) is driven by its reliable
 * transport's backpressure signal (`transport-timeout-close-v1`), and this Host has no
 * such layer — inventing a second ladder without that signal would only make the delay
 * harder to predict.
 *
 * @module dsh-cindy-host/host-reconnect
 */

/** First retry delay, matching the Cindy client. */
export const RECONNECT_BASE_MS = 1_000;
/** Longest gap between retries: retries continue indefinitely at this ceiling. */
export const RECONNECT_MAX_MS = 30_000;
/** How long a connection must hold before the attempt counter is forgotten. */
export const RECONNECT_STABLE_RESET_MS = 10_000;

/**
 * Delay before the next attempt.
 *
 * Exponential from the base, capped, then multiplied by a **downward** jitter
 * (0.7×–1.0×): many hosts that lose the same relay at the same moment must not come
 * back in lockstep and re-congest it. Non-finite inputs are clamped rather than
 * propagated — a `NaN` delay would silently become an immediate retry storm.
 *
 * @param options - `attempt` (0 for the first retry), the two bounds, and `random` in
 *   `[0, 1]` (injected so a test can pin the curve).
 * @returns milliseconds to wait.
 */
export function computeReconnectDelayMs({ attempt, reconnectBaseMs = RECONNECT_BASE_MS, reconnectMaxMs = RECONNECT_MAX_MS, random = 0 } = {}) {
  const step = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  const roll = Number.isFinite(random) ? Math.min(Math.max(random, 0), 1) : 0;
  const base = Math.min(reconnectBaseMs * 2 ** step, reconnectMaxMs);
  return Math.round(base * (0.7 + roll * 0.3));
}
