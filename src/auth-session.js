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
import { loadSession, saveSession, credentialStoreAvailable, clearSession as clearStoredSession } from './credential-store.js';

// One in-process writer for login/logout and guarded refresh commits. This is
// deliberately not a cross-process credential-store CAS.
let credentialRevision = 0;
let writes = Promise.resolve();
function serializeWrite(action) {
  const pending = writes.then(action);
  writes = pending.catch(() => {});
  return pending;
}
function sameCredential(a, b) {
  return a != null && b != null && ['deviceId', 'authBaseUrl', 'accessToken', 'refreshToken']
    .every((key) => a[key] === b[key]);
}
const superseded = () => ({ ok: false, reason: 'OWNER_UNVERIFIED', message: 'Cindy 登录归属已变化，未采用旧操作结果' });

/** Refresh only a captured authenticated lease, never import another stored identity. */
export async function refreshOwnedCredential(captured, ports = {}) {
  const load = ports.loadSession ?? loadSession;
  const save = ports.saveSession ?? saveSession;
  const refresh = ports.refreshStoredSession ?? refreshStoredSession;
  const current = ports.isCurrent ?? (() => false);
  const revision = credentialRevision;
  const snapshot = Object.freeze({ ...captured });
  const stored = await load();
  if (revision !== credentialRevision || !current() || !sameCredential(snapshot, stored)) return superseded();
  const timeoutMs = Number.isSafeInteger(ports.timeoutMs) && ports.timeoutMs > 0 ? Math.min(ports.timeoutMs, 30_000) : 30_000;
  const controller = new AbortController();
  const abort = () => controller.abort();
  ports.signal?.addEventListener('abort', abort, { once: true });
  if (ports.signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  let aborted;
  let refreshed;
  try {
    const cancelled = new Promise((resolve) => {
      aborted = () => resolve({ ok: false });
      controller.signal.addEventListener('abort', aborted, { once: true });
      if (controller.signal.aborted) aborted();
    });
    refreshed = await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return refresh(snapshot, { signal: controller.signal });
      }), cancelled,
    ]);
  } catch { refreshed = { ok: false }; }
  finally {
    clearTimeout(timer);
    ports.signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', aborted);
  }
  if (!refreshed?.ok) return { ok: false, reason: 'AUTH_FAILED', message: 'Cindy 登录续期失败' };
  const session = { ...snapshot, ...refreshed.session };
  if (session.deviceId !== snapshot.deviceId || session.authBaseUrl !== snapshot.authBaseUrl
      || typeof session.accessToken !== 'string' || !session.accessToken
      || typeof session.refreshToken !== 'string' || !session.refreshToken) return superseded();
  return serializeWrite(async () => {
    const stored = await load();
    if (revision !== credentialRevision || !current() || !sameCredential(snapshot, stored)) return superseded();
    await save(session);
    if (revision !== credentialRevision || !current()) return superseded();
    credentialRevision += 1;
    return { ok: true, session };
  });
}

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
  // A missing native dependency says nothing about whether the OS holds a login.
  // Injected stores do not depend on this machine's keytar unless they opt in.
  const available = ports.credentialStoreAvailable ?? (load === loadSession ? credentialStoreAvailable : undefined);
  if (available && !available()) {
    return {
      ok: false,
      reason: 'CREDENTIAL_STORE_UNAVAILABLE',
      message: '本机 Cindy 凭据存储不可用，无法读取已有登录态。请修复当前 DSH 配置中的 keytar 原生模块（允许安装构建脚本或重新构建），然后重启 DSH；请勿因此清除登录态或重复登录。',
    };
  }
  const save = ports.saveSession ?? saveSession;
  const refresh = ports.refreshStoredSession ?? refreshStoredSession;
  const revision = credentialRevision;
  const saved = await load();
  if (!saved) return { ok: false, reason: 'missing', message: '本机还没有 Cindy 登录态' };

  if (revision !== credentialRevision) return superseded();
  const refreshed = await refresh(saved);
  if (revision !== credentialRevision) return superseded();
  if (refreshed.ok) {
    const session = { ...saved, ...refreshed.session };
    return serializeWrite(async () => {
      const stored = await load();
      if (revision !== credentialRevision || !sameCredential(saved, stored)) return superseded();
      await save(session);
      if (revision !== credentialRevision) return superseded();
      credentialRevision += 1;
      return { ok: true, session };
    });
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
  credentialRevision += 1; // Fence refreshes immediately, before waiting for an older writer.
  await serializeWrite(() => save(stored));
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
  const clear = ports.clearSession ?? clearStoredSession;
  credentialRevision += 1;
  await serializeWrite(clear);
}

/**
 * CLI path: reuse a stored session when possible, otherwise ask on the terminal.
 * @returns a usable Cindy session.
 */
export async function getAuthenticatedSession() {
  const restored = await restoreSession();
  if (restored.ok) return restored.session;
  const session = await loginWithPhone({ clientType: 'desktop' });
  await adoptSession(session);
  return session;
}

export { forgetSession as clearSession };
