/** Trusted regional bootstrap, from Cindy config/endpoint{,.global}.json. */
export const AUTH_MANIFESTS = Object.freeze({
  cn: 'https://hotfix.cindy.com.cn/cindy/endpoint.json',
  global: 'https://hotfix.cindy.app/cindy/endpoint.json',
});
export class CindyAuthError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export const authError = (code, status) => new CindyAuthError(code, status);
export function authRegion(value) {
  if (value !== 'cn' && value !== 'global') throw authError('INVALID_REGION');
  return value;
}
const nonempty = value => typeof value === 'string' && value.length > 0;
function trustedUrl(value, region, optional = false) {
  if (optional && (value === undefined || value === '')) return '';
  if (!nonempty(value)) throw authError('INVALID_ENDPOINT_MANIFEST');
  let url; try { url = new URL(value); } catch { throw authError('INVALID_ENDPOINT_MANIFEST'); }
  const domain = region === 'cn' ? 'cindy.com.cn' : 'cindy.app';
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port
    || !(url.hostname === domain || url.hostname.endsWith('.' + domain))) throw authError('INVALID_ENDPOINT_MANIFEST');
  return url.href.replace(/\/$/, '');
}
export function parseAuthEndpoints(manifest, region) {
  authRegion(region);
  if (!manifest || manifest.schemaVersion !== 1 || (manifest.region !== undefined && manifest.region !== region)) throw authError('INVALID_ENDPOINT_MANIFEST');
  const authApiBaseUrl = trustedUrl(manifest.authApiBaseUrl, region);
  const deviceLinkApiBaseUrl = trustedUrl(manifest.deviceLinkApiBaseUrl, region);
  const authDesktopCallbackUrl = trustedUrl(manifest.authDesktopCallbackUrl, region, true);
  if (authDesktopCallbackUrl && new URL(authDesktopCallbackUrl).origin !== new URL(authApiBaseUrl).origin) throw authError('INVALID_ENDPOINT_MANIFEST');
  return Object.freeze({ schemaVersion: 1, region, authApiBaseUrl, deviceLinkApiBaseUrl, authDesktopCallbackUrl });
}

/** Fixed error text/codes only: never put upstream bodies, URLs or credentials into errors. */
export async function authJson(url, { body, signal, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetchImpl(url, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: combined, redirect: 'error' });
    const text = await response.text();
    if (text.length > 256 * 1024) throw authError('INVALID_RESPONSE');
    let data; try { data = JSON.parse(text); } catch { throw authError('INVALID_RESPONSE'); }
    if (!response.ok) {
      const raw = data?.error?.code ?? data?.code;
      const known = new Set(['ORG_SSO_NOT_FOUND', 'INVALID_AUTH_CODE', 'INVALID_CODE', 'CODE_EXPIRED',
        'CAPTCHA_REQUIRED', 'CAPTCHA_INVALID', 'CAPTCHA_FAILED', 'RATE_LIMITED', 'CONNECTION_NOT_FOUND',
        'INVALID_LOGIN_TICKET', 'INVALID_BIND_TICKET', 'INVALID_SSO_VERIFICATION_TICKET', 'SSO_DISABLED', 'ACCOUNT_DISABLED']);
      throw authError(known.has(raw) ? raw : 'AUTH_REQUEST_FAILED', response.status);
    }
    return data;
  } catch (error) {
    if (signal?.aborted) throw authError('USER_CANCELLED');
    if (timeout.aborted) throw authError('REQUEST_TIMEOUT');
    if (error instanceof CindyAuthError) throw error;
    throw authError('NETWORK_ERROR', 502);
  }
}
export function createAuthEndpointRegistry({ fetchImpl = fetch } = {}) {
  return { async load(region, signal) {
    authRegion(region);
    return parseAuthEndpoints(await authJson(AUTH_MANIFESTS[region], { fetchImpl, signal }), region);
  } };
}
export function relayForEndpoints(endpoints) {
  return endpoints.deviceLinkApiBaseUrl.replace(/^https:/, 'wss:') + '/api/device-link/ws';
}
/** Migration only: pre-v2 sessions knew just these official auth origins. New logins use manifests. */
export function sessionEndpoints(session) {
  if (!session) return null;
  if (session.endpointSnapshot) return validateSessionEndpoints(session);
  const origins = { 'https://auth.cindy.com.cn': ['cn', 'https://device-link.cindy.com.cn'],
    'https://auth.cindy.app': ['global', 'https://device-link.cindy.app'] };
  const legacy = origins[session.authBaseUrl?.replace(/\/$/, '')];
  if (!legacy || (session.realm !== undefined && session.realm !== legacy[0]) || session.sessionVersion === 2) throw authError('SESSION_REALM_MISMATCH');
  return parseAuthEndpoints({ schemaVersion: 1, authApiBaseUrl: session.authBaseUrl.replace(/\/$/, ''), deviceLinkApiBaseUrl: legacy[1] }, legacy[0]);
}

export function validateSessionEndpoints(session) {
  if (!session?.endpointSnapshot) return null;
  const endpoints = parseAuthEndpoints(session.endpointSnapshot, authRegion(session.realm));
  if (endpoints.authApiBaseUrl !== session.authBaseUrl) throw authError('SESSION_REALM_MISMATCH');
  return endpoints;
}
