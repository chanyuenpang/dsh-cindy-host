import test from 'node:test';
import assert from 'node:assert/strict';
import { createCindyAuthController } from '../src/cindy-auth-controller.js';
import { createAuthEndpointRegistry, parseAuthEndpoints, authError, authJson, relayForEndpoints } from '../src/cindy-auth-endpoints.js';

const endpoints = region => parseAuthEndpoints({ schemaVersion: 1,
  authApiBaseUrl: `https://auth.cindy.${region === 'cn' ? 'com.cn' : 'app'}`,
  deviceLinkApiBaseUrl: `https://device-link.cindy.${region === 'cn' ? 'com.cn' : 'app'}`,
  authDesktopCallbackUrl: `https://auth.cindy.${region === 'cn' ? 'com.cn' : 'app'}/api/auth/desktop/callback`,
}, region);
const providers = region => ({ region, attribution: region === 'cn' ? 'phone' : 'email',
  phone: region === 'cn', email: region === 'global', social: region === 'cn' ? ['wechat', 'apple'] : ['apple', 'google'] });
const member = { id: 'account', displayName: 'User', kind: 'personal', role: 'owner', email: null, orgId: null, orgName: null };
const success = () => ({ status: 'ok', accessToken: 'resource-access-secret', refreshToken: 'resource-refresh-secret', membership: member });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
const settle = () => new Promise(r => setImmediate(r));
function harness({ handler, browser, commit, now, lifetimeMs } = {}) {
  const calls = []; const saved = [];
  const controller = createCindyAuthController({ deviceId: async () => 'device',
    registry: { load: async region => endpoints(region) }, now, lifetimeMs, browser,
    commitSession: commit ?? (async (session, lease) => { assert.equal(lease(), true); saved.push(session); }),
    request: async (ep, path, body) => {
      calls.push({ region: ep.region, path, body });
      const override = await handler?.(ep, path, body); if (override !== undefined) return override;
      if (path === '/api/auth/providers') return providers(ep.region);
      if (path === '/api/auth/sso/discovery') throw authError('ORG_SSO_NOT_FOUND');
      if (path === '/api/auth/discovery') return { methods: [{ type: 'email_code' }] };
      if (path.endsWith('/request-code')) return { status: 'sent' };
      if (path.endsWith('/verify-code') || path.endsWith('/verify') || path === '/api/auth/select-account') return success();
      throw Error(path);
    },
  });
  let view;
  return { controller, saved, calls, get view() { return view; },
    async start(region = 'cn') { const result = await controller.command({ action: 'start', region }); view = result.view; return result; },
    async act(action, fields = {}) { const result = await controller.command({ action, attemptId: view.attemptId, revision: view.revision, ...fields }); if (result.view) view = result.view; return result; },
  };
}

test('both regional manifests are pinned and reject redirects, foreign endpoints and response errors without leaking bodies', async () => {
  const seen = [];
  const registry = createAuthEndpointRegistry({ fetchImpl: async (url, init) => { seen.push([url, init]); const region = url.includes('com.cn') ? 'cn' : 'global'; return new Response(JSON.stringify(endpoints(region))); } });
  assert.equal((await registry.load('cn')).authApiBaseUrl, 'https://auth.cindy.com.cn');
  const global = await registry.load('global');
  assert.equal(relayForEndpoints(global), 'wss://device-link.cindy.app/api/device-link/ws');
  assert.equal(seen[0][1].redirect, 'error');
  assert.throws(() => parseAuthEndpoints({ ...global, deviceLinkApiBaseUrl: 'https://evil.example' }, 'global'), /INVALID_ENDPOINT/);
  assert.throws(() => parseAuthEndpoints({ ...global, authApiBaseUrl: 'https://auth.cindy.com.cn' }, 'global'), /INVALID_ENDPOINT/);
  assert.throws(() => parseAuthEndpoints({ ...global, schemaVersion: 2 }, 'global'), /INVALID_ENDPOINT/);
  await assert.rejects(authJson('https://auth.cindy.app/x', { fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'access-token-SECRET', message: 'refresh-secret' } }), { status: 400 }) }), error => error.message === 'AUTH_REQUEST_FAILED');
});

test('CN phone and global email login persist matching network snapshots, not tickets or account tokens', async t => {
  for (const region of ['cn', 'global']) {
    const h = harness(); t.after(() => h.controller.dispose());
    assert.equal((await h.start(region)).ok, true);
    const kind = region === 'cn' ? 'phone' : 'email';
    const identifier = kind === 'phone' ? '+8613800000000' : 'person@example.com';
    assert.equal((await h.act('request_code', { kind, identifier })).ok, true);
    assert.equal((await h.act('verify_code', { code: '123456' })).ok, true);
    assert.equal(h.view.step, 'completed');
    assert.equal(h.saved.length, 1);
    assert.equal(h.saved[0].realm, region);
    assert.equal(h.saved[0].endpointSnapshot.deviceLinkApiBaseUrl, endpoints(region).deviceLinkApiBaseUrl);
    assert.doesNotMatch(JSON.stringify(h.view), /resource-access|resource-refresh|Ticket|accountToken/);
  }
});

test('enabled Apple browser login is selectable in both regions and all secrets stay server-side', async t => {
  for (const region of ['cn', 'global']) {
    const outcome = deferred(); let browserArgs;
    const h = harness({ browser: async args => { browserArgs = args; return { authorizationUrl: 'https://auth.cindy.app/authorize?public=challenge', result: outcome.promise, close() {} }; } });
    t.after(() => h.controller.dispose()); await h.start(region);
    assert.equal((await h.act('start_browser', { kind: 'social', providerOrConnectionId: 'apple' })).ok, true);
    assert.equal(browserArgs.endpoints.region, region);
    outcome.resolve(success()); await settle();
    assert.equal((await h.act('read')).view.step, 'completed');
    assert.equal(h.saved[0].kind, 'apple');
    assert.doesNotMatch(JSON.stringify(h.view), /resource-access|resource-refresh/);
  }
});

test('outcomes chain through account selection, binding and SSO verification without exposing tickets', async t => {
  let phase = 0;
  const h = harness({ handler: (ep, path, body) => {
    if (path.endsWith('/verify-code')) return { status: 'select_account', loginTicket: 'login-ticket-SECRET', accounts: [member] };
    if (path === '/api/auth/select-account') { assert.equal(body.loginTicket, 'login-ticket-SECRET'); return { status: 'binding_required', bindType: 'email', bindTicket: 'binding-ticket-SECRET' }; }
    if (path === '/api/auth/binding/verify') { assert.equal(body.bindTicket, 'binding-ticket-SECRET'); return { status: 'sso_verification_required', verificationTicket: 'verification-ticket-SECRET', channel: 'sms', targetMasked: '***1234' }; }
    if (path === '/api/auth/sso/verification/verify') { phase++; assert.equal(body.verificationTicket, 'verification-ticket-SECRET'); return success(); }
  } });
  t.after(() => h.controller.dispose()); await h.start();
  await h.act('request_code', { kind: 'phone', identifier: '13800000000' });
  await h.act('verify_code', { code: '123456' });
  assert.equal(h.view.step, 'account-selection');
  assert.doesNotMatch(JSON.stringify(h.view), /ticket-SECRET/);
  assert.equal((await h.act('select_account', { accountId: 'forged' })).code, 'INVALID_ACCOUNT');
  await h.act('select_account', { accountId: 'account' });
  assert.equal(h.view.step, 'binding');
  assert.doesNotMatch(JSON.stringify(h.view), /ticket-SECRET/);
  await h.act('binding_request', { identifier: 'person@example.com' });
  await h.act('binding_verify', { identifier: 'person@example.com', code: '123456' });
  assert.equal(h.view.step, 'sso-verification');
  assert.doesNotMatch(JSON.stringify(h.view), /ticket-SECRET/);
  await h.act('sso_request'); await h.act('sso_verify', { code: '123456' });
  assert.equal(phase, 1); assert.equal(h.view.step, 'completed');
});

test('cross-region SSO discovery requires explicit confirmation and never guesses after partial failure', async t => {
  const connection = { connectionId: 'company-sso', protocol: 'oidc', connectionName: 'Company' };
  const h = harness({ handler: (ep, path) => { if (path === '/api/auth/sso/discovery' && ep.region === 'global') return { region: 'global', orgName: 'Company', connections: [connection] }; } });
  t.after(() => h.controller.dispose()); await h.start();
  assert.equal((await h.act('discover_org', { org: 'company.example' })).ok, true);
  assert.equal(h.view.step, 'region-confirmation'); assert.equal(h.view.region, 'cn');
  await h.act('confirm_region'); assert.equal(h.view.region, 'global');
  const broken = harness({ handler: (ep, path) => { if (path === '/api/auth/sso/discovery') { if (ep.region === 'cn') throw authError('NETWORK_ERROR'); return { region: 'global', orgName: 'Company', connections: [connection] }; } } });
  t.after(() => broken.controller.dispose()); await broken.start();
  assert.equal((await broken.act('discover_org', { org: 'company.example' })).code, 'ORG_REALM_UNAVAILABLE');
  assert.equal(broken.view.region, 'cn');
});

test('global CAPTCHA uses the official success-URL contract and refuses forged origins without spending a code', async t => {
  const h = harness({ handler: (ep, path) => path === '/api/auth/providers' ? { ...providers(ep.region), captcha: { provider: 'turnstile', siteKey: 'public-site-key', requiredFor: ['email_request_code'] } } : undefined });
  t.after(() => h.controller.dispose()); await h.start('global');
  await h.act('request_code', { kind: 'email', identifier: 'person@example.com' });
  assert.equal(h.view.step, 'captcha');
  assert.equal(h.calls.some(call => call.path.endsWith('/request-code')), false);
  assert.equal((await h.act('captcha_complete', { resultUrl: 'https://evil.example/captcha/turnstile#cindy-captcha=ok.SECRET' })).code, 'INVALID_CAPTCHA_RESULT');
  assert.equal((await h.act('captcha_complete', { resultUrl: h.view.challengeUrl + '#cindy-captcha=ok.captcha-proof' })).ok, true);
  assert.equal(h.view.step, 'verification-code');
  assert.equal(h.calls.at(-1).body.captchaToken, 'captcha-proof');
  assert.doesNotMatch(JSON.stringify(h.view), /captcha-proof/);
});

test('cancel and replacement fence delayed token results and stale page commands', async t => {
  const pending = deferred(); const h = harness({ handler: (ep, path) => path.endsWith('/verify-code') ? pending.promise : undefined });
  t.after(() => h.controller.dispose()); await h.start();
  await h.act('request_code', { kind: 'phone', identifier: '13800000000' });
  const verifying = h.act('verify_code', { code: '123456' }); await settle();
  await h.act('cancel'); pending.resolve(success()); await verifying;
  assert.equal(h.saved.length, 0);
  const old = h.view.attemptId; await h.start('global');
  assert.equal((await h.controller.command({ action: 'request_code', attemptId: old, revision: 0, kind: 'email', identifier: 'x@y.com' })).code, 'LOGIN_SUPERSEDED');
});

test('a refused second-page start does not reveal or invalidate the active attempt', async t => {
  const h = harness(); t.after(() => h.controller.dispose());
  await h.start(); const original = h.view;
  const other = await h.controller.command({ action: 'start', region: 'global' });
  assert.equal(other.code, 'LOGIN_BUSY'); assert.equal(other.view, undefined);
  assert.equal((await h.controller.command({ action: 'read', attemptId: original.attemptId })).view.step, 'identifier');
  assert.equal((await h.act('request_code', { kind: 'phone', identifier: '13800000000' })).ok, true);
});

test('a failed encrypted-store commit keeps the failure visible and allows a fresh login', async t => {
  const h = harness({ commit: async () => { throw Error('secret-store-error'); } }); t.after(() => h.controller.dispose());
  await h.start(); await h.act('request_code', { kind: 'phone', identifier: '13800000000' });
  const result = await h.act('verify_code', { code: '123456' });
  assert.equal(result.ok, false); assert.equal(result.view.step, 'error');
  assert.doesNotMatch(JSON.stringify(result), /secret-store-error|resource-access/);
  assert.equal((await h.start('global')).ok, true);
});

test('revision prevents duplicate commands, disabled providers cannot start and expired attempts do not commit', async t => {
  let now = 100; const h = harness({ now: () => now, lifetimeMs: 1000 }); t.after(() => h.controller.dispose()); await h.start();
  const stale = h.view.revision;
  assert.equal((await h.act('start_browser', { kind: 'social', providerOrConnectionId: 'google' })).code, 'LOGIN_METHOD_DISABLED');
  assert.equal((await h.controller.command({ action: 'request_code', attemptId: h.view.attemptId, revision: stale, kind: 'phone', identifier: '13800000000' })).code, 'LOGIN_STEP_CHANGED');
  now = 1101; assert.equal((await h.act('read')).view.error, 'LOGIN_EXPIRED');
  assert.equal((await h.act('request_code', { kind: 'phone', identifier: '13800000000' })).code, 'LOGIN_SUPERSEDED');
  assert.equal(h.saved.length, 0);
});
