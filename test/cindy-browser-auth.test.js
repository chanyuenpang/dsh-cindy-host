import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { beginBrowserAuth } from '../src/cindy-browser-auth.js';

const ep = { authApiBaseUrl: 'https://auth.cindy.app', authDesktopCallbackUrl: 'https://auth.cindy.app/api/auth/desktop/callback' };
const hash = value => createHash('sha256').update(value).digest('base64url');

test('hosted Apple authorization uses PKCE, separate hashed poll state and exact official fields', async () => {
  const seen = []; let polls = 0;
  const auth = await beginBrowserAuth({ endpoints: ep, kind: 'social', providerOrConnectionId: 'apple', deviceId: 'device', pollDelayMs: 1,
    request: async (endpoints, path, body) => { seen.push({ endpoints, path, body });
      if (path.endsWith('/poll')) return ++polls === 1 ? { status: 'pending' } : { status: 'ok', code: 'one-use-code' };
      return { status: 'ok', accessToken: 'secret' };
    },
  });
  assert.equal((await auth.result).status, 'ok');
  const url = new URL(auth.authorizationUrl); const pollSecret = seen[0].body.pollSecret;
  const exchange = seen.find(call => call.path === '/api/auth/token');
  assert.equal(url.pathname, '/api/auth/social/apple/authorize');
  assert.equal(url.searchParams.get('client_type'), 'desktop');
  assert.equal(url.searchParams.get('redirect_uri'), ep.authDesktopCallbackUrl);
  assert.equal(url.searchParams.get('client_state'), hash(pollSecret));
  assert.equal(url.searchParams.get('code_challenge'), hash(exchange.body.codeVerifier));
  assert.equal(exchange.body.grantType, 'authorization_code');
  assert.equal(exchange.body.code, 'one-use-code');
  assert.equal(exchange.body.deviceId, 'device');
  assert.ok(!auth.authorizationUrl.includes(pollSecret));
  assert.ok(!auth.authorizationUrl.includes(exchange.body.codeVerifier));
  assert.doesNotMatch(auth.authorizationUrl, /one-use-code|secret/);
});

test('hosted provider error is fixed text and never downgrades to loopback', async () => {
  let exchanges = 0;
  const auth = await beginBrowserAuth({ endpoints: ep, kind: 'sso', providerOrConnectionId: 'org/id', deviceId: 'device',
    request: async (endpoints, path) => { if (path.endsWith('/poll')) return { status: 'error', error: 'secret-upstream-error' }; exchanges++; },
  });
  await assert.rejects(auth.result, error => error.code === 'AUTH_PROVIDER_FAILED' && !error.message.includes('secret'));
  assert.equal(exchanges, 0);
  assert.equal(new URL(auth.authorizationUrl).searchParams.get('redirect_uri'), ep.authDesktopCallbackUrl);
});

test('loopback is local, state-checked, one-use and never reflects provider input into HTML', async t => {
  const abort = new AbortController(); t.after(() => abort.abort());
  const exchanges = [];
  const auth = await beginBrowserAuth({ endpoints: { ...ep, authDesktopCallbackUrl: '' }, kind: 'sso', providerOrConnectionId: 'company', deviceId: 'device', signal: abort.signal,
    request: async (endpoints, path, body) => { exchanges.push(body); return { status: 'ok' }; },
  });
  const url = new URL(auth.authorizationUrl); const callback = url.searchParams.get('redirect_uri');
  assert.equal(new URL(callback).hostname, '127.0.0.1');
  assert.equal((await fetch(callback + '?state=wrong&code=stolen')).status, 400);
  assert.equal(exchanges.length, 0);
  const reply = await fetch(callback + '?state=' + url.searchParams.get('client_state') + '&code=valid-code');
  assert.equal(reply.status, 200);
  assert.doesNotMatch(await reply.text(), /valid-code|stolen/);
  await auth.result;
  assert.equal(exchanges.length, 1);
  assert.equal(hash(exchanges[0].codeVerifier), url.searchParams.get('code_challenge'));
  try { const again = await fetch(callback + '?state=' + url.searchParams.get('client_state') + '&code=valid-code'); assert.notEqual(again.status, 200); } catch { /* listener already closed */ }
  assert.equal(exchanges.length, 1);
});

test('cancel aborts polling and cannot exchange a code', async () => {
  const abort = new AbortController(); let exchanges = 0;
  const auth = await beginBrowserAuth({ endpoints: ep, kind: 'social', providerOrConnectionId: 'apple', deviceId: 'device', signal: abort.signal, pollDelayMs: 1,
    request: async (endpoints, path, body, signal) => {
      if (path.endsWith('/poll')) return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'USER_CANCELLED' })), { once: true }));
      exchanges++; return {};
    },
  });
  abort.abort(); await assert.rejects(auth.result); assert.equal(exchanges, 0);
});
