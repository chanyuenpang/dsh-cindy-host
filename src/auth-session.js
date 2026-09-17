/**
 * Session lifecycle for the Cindy Host.
 *
 * Two callers with different needs share this module:
 *  - the Web settings card needs a non-interactive restore (`restoreSession`),
 *    because a host with no TTY can never answer a readline prompt;
 *  - the `npm run host` CLI keeps the interactive fallback that asks for a
 *    phone number and a verification code on the terminal.
 *
 * Tokens only ever travel between the OS credential store and the relay
 * handshake; neither path prints them.
 */
import { randomUUID } from 'node:crypto';
import { loginWithPhone } from './cindy-login.js';
import { refreshStoredSession } from './cindy-login-flow.js';
import { loadSession, saveSession, clearSession } from './credential-store.js';

/**
 * Load the stored session and refresh it.
 *
 * The credential ports are injectable so the **deletion rule** can be tested
 * directly: it is the one behaviour here that is destructive, and it already cost
 * a real login once.
 * @param ports - optional overrides for the credential store and the refresher.
 * @returns `{ ok: true, session }` when a usable session stands, else the reason none does.
 */
export async function restoreSession(ports = {}) {
  const load = ports.loadSession ?? loadSession;
  const save = ports.saveSession ?? saveSession;
  const refresh = ports.refreshStoredSession ?? refreshStoredSession;
  const saved = await load();
  if (!saved) return { ok: false, reason: 'missing', message: '本机还没有 Cindy 登录态' };

  const refreshed = await refresh(saved);
  if (refreshed.ok) {
    const session = { ...saved, ...refreshed.session };
    await save(session);
    return { ok: true, session };
  }

  // A service that could not be reached is not evidence about the credential at
  // all: keep it and try with what is stored. If the access token has also
  // expired the connection fails visibly, which is recoverable — unlike a
  // credential that no longer exists.
  if (refreshed.transient === true) {
    return { ok: true, session: saved, refreshDeferred: true, message: refreshed.message };
  }

  // A **refused** session is reported, never deleted.
  //
  // This used to `clearSession()` on any failure, and that is what cost a real
  // login: every Host start refreshes, `refreshStoredSession` used to fold
  // timeouts and 5xx into "expired", and a second instance sharing the credential
  // rotates the refresh token out from under the first — so one hiccup permanently
  // deleted a working credential and forced a fresh login.
  //
  // Keeping it is safe, because the card's login form keys off this result
  // (`resolved.ok`), not off the credential's presence: a rejected session still
  // shows the form. What the user gets back is the ability to recover — a rotation
  // that merely raced works again on the next start instead of demanding a new
  // login. Deleting the credential is now something only an explicit logout does
  // (`forgetSession`).
  return { ok: false, reason: 'expired', message: refreshed.message, rejected: refreshed.rejected === true };
}

/**
 * Persist a session the card just established.
 * @param session - the session the login flow returned.
 * @param ports - optional credential-store override, for tests.
 */
export async function adoptSession(session, ports = {}) {
  const save = ports.saveSession ?? saveSession;
  const stored = { deviceId: session.deviceId ?? randomUUID(), ...session };
  await save(stored);
  return stored;
}

/**
 * Drop the stored session; the next connect starts from the login form.
 *
 * This is the **only** path that deletes the credential. A failed refresh reports
 * itself instead (see {@link restoreSession}).
 * @param ports - optional credential-store override, for tests.
 */
export async function forgetSession(ports = {}) {
  const clear = ports.clearSession ?? clearSession;
  await clear();
}

/**
 * CLI path: reuse a stored session when possible, otherwise ask on the terminal.
 * @returns a usable Cindy session.
 */
export async function getAuthenticatedSession() {
  const restored = await restoreSession();
  if (restored.ok) return restored.session;
  const session = await loginWithPhone({ clientType: 'desktop' });
  await saveSession(session);
  return session;
}

export { clearSession };
