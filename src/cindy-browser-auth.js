import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { authError } from './cindy-auth-endpoints.js';

const secret = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('base64url');
function delay(ms, signal) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms); timer.unref?.();
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}

/** Public authorize URL carries a hash/challenge only. All secret originals remain here. */
export async function beginBrowserAuth({ endpoints, kind, providerOrConnectionId, deviceId, request,
  signal, timeoutMs = 300000, pollDelayMs = 1000 }) {
  const codeVerifier = secret();
  const codeChallenge = hash(codeVerifier);
  const deadline = AbortSignal.timeout(timeoutMs);
  const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let close = () => {};
  let authorizationUrl;
  function urlFor(redirectUri, state) {
    const segment = kind === 'social' ? 'social' : 'sso';
    const url = new URL(endpoints.authApiBaseUrl + `/api/auth/${segment}/${encodeURIComponent(providerOrConnectionId)}/authorize`);
    url.search = new URLSearchParams({ client_type: 'desktop', device_id: deviceId, redirect_uri: redirectUri,
      code_challenge: codeChallenge, code_challenge_method: 'S256', client_state: state, ui_locale: 'zh-CN' }).toString();
    return url.href;
  }
  let callback;
  if (endpoints.authDesktopCallbackUrl) {
    const pollSecret = secret();
    authorizationUrl = urlFor(endpoints.authDesktopCallbackUrl, hash(pollSecret));
    callback = (async () => {
      let failures = 0;
      const started = Date.now();
      while (!active.aborted) {
        try {
          const result = await request(endpoints, '/api/auth/desktop/callback/poll', { pollSecret, deviceId }, active, 30000);
          failures = 0;
          if (result?.status === 'ok' && typeof result.code === 'string' && result.code) return result.code;
          if (result?.status === 'expired') throw authError('INVALID_AUTH_CODE');
          if (result?.status === 'error') throw authError('AUTH_PROVIDER_FAILED');
          if (result?.status !== 'pending') throw authError('INVALID_RESPONSE');
        } catch (error) {
          if (active.aborted || !['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'AUTH_REQUEST_FAILED'].includes(error.code) || ++failures >= 8) throw error;
        }
        await delay(Date.now() - started >= 30000 ? Math.max(pollDelayMs, 2000) : pollDelayMs, active);
      }
      throw authError('USER_CANCELLED');
    })();
  } else {
    const state = secret();
    let resolveCallback;
    let rejectCallback;
    callback = new Promise((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
    // Attach immediately: bind/listen may fail before the final result chain is returned.
    callback.catch(() => {});
    let consumed = false;
    const server = createServer((req, res) => {
      let url;
      try {
        if (typeof req.url !== 'string' || req.url.length > 16384) throw authError('INVALID_AUTH_CODE');
        url = new URL(req.url, 'http://127.0.0.1');
      } catch { res.writeHead(400, { 'cache-control': 'no-store' }).end('Invalid callback'); return; }
      if (consumed || req.method !== 'GET' || url.pathname !== '/auth/callback'
        || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== state
        || (url.searchParams.getAll('code').length !== 1 && !url.searchParams.has('error'))) {
        res.writeHead(400, { 'cache-control': 'no-store' }).end('Invalid callback'); return;
      }
      consumed = true;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" })
        .end('<!doctype html><meta charset="utf-8"><title>Cindy</title><p>Return to DSH to complete sign-in. 请返回 DSH 完成登录。</p>');
      if (url.searchParams.has('error')) rejectCallback(authError('AUTH_PROVIDER_FAILED'));
      else if (!url.searchParams.get('code')) rejectCallback(authError('INVALID_AUTH_CODE'));
      else resolveCallback(url.searchParams.get('code'));
      server.close();
    });
    close = () => { server.close(); server.closeAllConnections?.(); };
    const cancel = () => { close(); rejectCallback(authError('USER_CANCELLED')); };
    active.addEventListener('abort', cancel, { once: true });
    const closeServer = close;
    close = () => { active.removeEventListener('abort', cancel); closeServer(); };
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      if (active.aborted) throw authError('USER_CANCELLED');
      authorizationUrl = urlFor(`http://127.0.0.1:${server.address().port}/auth/callback`, state);
    } catch (error) { close(); throw error; }
  }
  const result = callback.then(async code => {
    if (active.aborted) throw authError('USER_CANCELLED');
    const outcome = await request(endpoints, '/api/auth/token', { grantType: 'authorization_code', code, codeVerifier, deviceId }, active);
    if (active.aborted) throw authError('USER_CANCELLED');
    return outcome;
  }).catch(error => {
    if (deadline.aborted && !signal?.aborted) throw authError('REQUEST_TIMEOUT');
    throw error;
  }).finally(close);
  result.catch(() => {});
  return { authorizationUrl, result, close };
}
