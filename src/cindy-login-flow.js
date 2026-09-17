/**
 * Non-interactive Cindy login steps, driven by the Settings card.
 *
 * `cindy-login.js` owns the interactive CLI flow (readline prompts). This module
 * exposes the same three wire calls as separate steps so a browser surface can
 * stage them: request a verification code, verify it, and refresh an existing
 * session. Nothing here prompts, and nothing here prints a token.
 *
 * Outcomes are values rather than exceptions: `binding_required` and
 * `sso_verification_required` are answers the card must render, not transport
 * failures, so callers can distinguish "Cindy said no" from "the request broke".
 */
import { MAINLAND_CINDY_AUTH_BASE_URL, cindyRequest } from './cindy-login.js';

export { MAINLAND_CINDY_AUTH_BASE_URL };

/** Login identifiers Cindy's code endpoints accept. */
export const LOGIN_KINDS = Object.freeze(['phone', 'email']);

/** Normalize a base URL the same way the CLI flow does. */
export function normalizeAuthBaseUrl(value) {
  const base = typeof value === 'string' && value.trim() !== '' ? value.trim() : MAINLAND_CINDY_AUTH_BASE_URL;
  return base.replace(/\/$/, '');
}

/** Reject an identifier the card could not have meant, before spending a code. */
export function validateIdentifier(kind, identifier) {
  const value = typeof identifier === 'string' ? identifier.trim() : '';
  if (!LOGIN_KINDS.includes(kind)) return { ok: false, message: 'Cindy 登录方式无效' };
  if (value === '') return { ok: false, message: kind === 'phone' ? '请填写手机号' : '请填写邮箱' };
  if (kind === 'phone' && !/^\+?[0-9][0-9\s-]{4,19}$/.test(value)) return { ok: false, message: '手机号格式不正确' };
  if (kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { ok: false, message: '邮箱格式不正确' };
  return { ok: true, value };
}

/**
 * Ask Cindy to send a verification code.
 * @param options - auth base URL, identifier kind, and the raw identifier.
 * @returns `{ ok: true }` once Cindy accepted the request, else an ok:false message.
 */
export async function requestLoginCode({ authBaseUrl, kind, identifier, locale = 'zh-CN' }) {
  const checked = validateIdentifier(kind, identifier);
  if (!checked.ok) return checked;
  try {
    await cindyRequest(normalizeAuthBaseUrl(authBaseUrl), `/api/auth/${kind}/request-code`, { [kind]: checked.value, locale });
    return { ok: true, identifier: checked.value };
  } catch {
    return { ok: false, message: '验证码发送失败，请检查账号或网络' };
  }
}

/** Select one token pair from a Cindy auth answer, or explain why there is none. */
function tokenPairOf(outcome) {
  const tokens = outcome?.tokens || outcome;
  if (typeof tokens?.accessToken !== 'string' || typeof tokens?.refreshToken !== 'string') {
    return { ok: false, message: 'Cindy 未返回登录凭据' };
  }
  return {
    ok: true,
    session: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      ...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt }),
    },
  };
}

/**
 * Exchange a verification code for a Cindy session.
 *
 * The device handle is minted once and reused, so a second login on the same
 * Host does not register as a new device (`cindy-login.js` mints one per
 * process; a card can log in repeatedly, so the caller supplies and persists it).
 * @param options - auth base URL, kind, identifier, code, and the stable device handle.
 * @returns an ok session, or a status naming what Cindy still requires.
 */
export async function verifyLoginCode({ authBaseUrl, kind, identifier, code, deviceId, clientType = 'desktop', locale = 'zh-CN' }) {
  const checked = validateIdentifier(kind, identifier);
  if (!checked.ok) return checked;
  const trimmedCode = typeof code === 'string' ? code.trim() : '';
  if (trimmedCode === '') return { ok: false, message: '请填写验证码' };
  if (typeof deviceId !== 'string' || deviceId === '') return { ok: false, message: '缺少设备标识' };

  const base = normalizeAuthBaseUrl(authBaseUrl);
  let outcome;
  try {
    outcome = await cindyRequest(base, `/api/auth/${kind}/verify-code`, { [kind]: checked.value, code: trimmedCode, deviceId, clientType, locale });
  } catch {
    return { ok: false, message: '验证失败，请检查验证码或网络' };
  }

  if (outcome?.status === 'select_account') {
    const accounts = Array.isArray(outcome.accounts) ? outcome.accounts.map((account) => ({ id: account?.id, displayName: account?.displayName })) : [];
    return { ok: false, status: 'select_account', message: '该账号需要选择要登录的 Cindy 账户', accounts, loginTicket: outcome.loginTicket };
  }
  if (outcome?.status === 'binding_required') return { ok: false, status: 'binding_required', message: '该 Cindy 账号需要先完成绑定' };
  if (outcome?.status === 'sso_verification_required') return { ok: false, status: 'sso_verification_required', message: '该 Cindy 账号需要 SSO 验证' };
  if (outcome?.status !== undefined && outcome.status !== 'ok') return { ok: false, message: `Cindy 返回了未支持的登录结果：${String(outcome.status)}` };

  const pair = tokenPairOf(outcome);
  if (!pair.ok) return pair;
  return { ok: true, session: { authBaseUrl: base, deviceId, kind, identifier: checked.value, clientType, ...pair.session } };
}

/** Finish a multi-account login once the user picked one. */
export async function selectLoginAccount({ authBaseUrl, loginTicket, accountId, deviceId, clientType = 'desktop', locale = 'zh-CN' }) {
  if (typeof loginTicket !== 'string' || loginTicket === '') return { ok: false, message: '缺少登录票据' };
  if (typeof accountId !== 'string' || accountId === '') return { ok: false, message: '缺少账户选择' };
  const base = normalizeAuthBaseUrl(authBaseUrl);
  let outcome;
  try {
    outcome = await cindyRequest(base, '/api/auth/select-account', { loginTicket, accountId, deviceId });
  } catch {
    return { ok: false, message: '账户选择失败，请重试' };
  }
  const pair = tokenPairOf(outcome);
  if (!pair.ok) return pair;
  return { ok: true, session: { authBaseUrl: base, deviceId, clientType, ...pair.session } };
}

/**
 * Refresh a stored session. Rejects nothing: an expired session is a value, not a
 * crash.
 *
 * It distinguishes **rejected** from **unreachable**, because the caller deletes
 * the stored credential on the first and must never do so on the second:
 *
 *  - the service answered and refused the token (400/401/403) → `rejected: true`;
 *  - the request timed out, DNS failed, or the service answered 5xx/429 →
 *    `transient: true`.
 *
 * Collapsing both into one outcome is what signed a working session out on a
 * flaky connection: every Host start refreshes, so a single hiccup deleted the
 * credential permanently and the user had to log in again.
 * @param session - the stored session.
 * @returns `{ ok: true, session }`, or a failure carrying `rejected` or `transient`.
 */
export async function refreshStoredSession(session) {
  const base = normalizeAuthBaseUrl(session?.authBaseUrl);
  if (typeof session?.refreshToken !== 'string' || typeof session?.deviceId !== 'string') {
    return { ok: false, rejected: true, message: '本机没有可续期的 Cindy 登录态' };
  }
  let next;
  try {
    next = await cindyRequest(base, '/api/auth/refresh', { deviceId: session.deviceId, refreshToken: session.refreshToken });
  } catch (error) {
    const status = typeof error?.status === 'number' ? error.status : null;
    const refused = status === 400 || status === 401 || status === 403;
    if (refused) return { ok: false, rejected: true, message: 'Cindy 登录态已过期' };
    return {
      ok: false,
      transient: true,
      message: `暂时无法续期 Cindy 登录态：${status === null ? '网络不通' : `HTTP ${status}`}`,
    };
  }
  const pair = tokenPairOf(next);
  if (!pair.ok) return pair;
  return { ok: true, session: { ...session, authBaseUrl: base, ...pair.session } };
}
