import { randomUUID } from 'node:crypto';
import { authError, authRegion, authJson, createAuthEndpointRegistry, CindyAuthError } from './cindy-auth-endpoints.js';
import { beginBrowserAuth } from './cindy-browser-auth.js';
import { validateIdentifier } from './cindy-login-flow.js';

const text = (value, max = 2048) => typeof value === 'string' && value.length > 0 && value.length <= max;
const protocols = ['oidc', 'saml', 'cas'];
const social = ['apple', 'google', 'wechat'];
const terminal = ['completed', 'cancelled', 'error'];
const mask = value => value?.includes('@') ? value.slice(0, 1) + '***@' + value.split('@')[1] : value ? '***' + value.slice(-4) : '';
function providersOf(value, region) {
  if (!value || value.region !== region || typeof value.phone !== 'boolean' || typeof value.email !== 'boolean'
    || !Array.isArray(value.social) || value.social.some(x => !social.includes(x))) throw authError('INVALID_PROVIDERS');
  let captcha;
  if (value.captcha) {
    if (value.captcha.provider !== 'turnstile' || !text(value.captcha.siteKey) || !Array.isArray(value.captcha.requiredFor)) throw authError('INVALID_PROVIDERS');
    captcha = { requiredFor: value.captcha.requiredFor.filter(x => ['email_request_code', 'phone_request_code'].includes(x)) };
  }
  return { region, phone: value.phone, email: value.email, social: [...value.social], ...(captcha ? { captcha } : {}) };
}
function methodsOf(items) {
  if (!Array.isArray(items)) throw authError('INVALID_RESPONSE');
  return items.flatMap(item => {
    if (item?.type === 'email_code') return [{ type: 'email_code' }];
    if (item?.type === 'sso') {
      if (!text(item.connectionId, 256) || !protocols.includes(item.protocol) || !text(item.orgName, 300)
        || typeof item.connectionName !== 'string' || typeof item.ssoRequired !== 'boolean') throw authError('INVALID_RESPONSE');
      return [{ type: 'sso', connectionId: item.connectionId, protocol: item.protocol, orgName: item.orgName,
        connectionName: item.connectionName.slice(0, 300), ssoRequired: item.ssoRequired }];
    }
    if (!text(item?.type)) throw authError('INVALID_RESPONSE');
    return [];
  });
}
function validContact(kind, identifier) {
  const checked = validateIdentifier(kind, identifier);
  if (!checked.ok || checked.value.length > 254) throw authError('INVALID_IDENTIFIER');
  return kind === 'email' ? checked.value.toLowerCase() : checked.value;
}
function publicMember(member) {
  if (!text(member?.id, 256) || typeof member.displayName !== 'string') throw authError('INVALID_RESPONSE');
  return { id: member.id, displayName: member.displayName.slice(0, 300), orgName: typeof member.orgName === 'string' ? member.orgName.slice(0, 300) : null };
}

/** One installation-scoped owner. Tickets, codes and PKCE material never enter view(). */
export function createCindyAuthController({ deviceId, commitSession, registry = createAuthEndpointRegistry(),
  fetchImpl = fetch, request: requestPort, browser = beginBrowserAuth, onStart = () => {}, now = Date.now, lifetimeMs = 15 * 60000 } = {}) {
  const request = requestPort ?? ((endpoints, path, body, signal, timeoutMs) =>
    authJson(endpoints.authApiBaseUrl + path, { body, signal, timeoutMs, fetchImpl }));
  let active = null;
  let epoch = 0;
  let committing = Promise.resolve();
  let disposed = false;
  const current = attempt => !disposed && active === attempt && attempt.epoch === epoch && !attempt.abort.signal.aborted;
  function cleanup(attempt) {
    if (!attempt) return;
    clearTimeout(attempt.timer); attempt.abort.abort(); attempt.browser?.close();
    attempt.ticket = null; attempt.authorizationUrl = null;
  }
  function invalidate() { epoch++; cleanup(active); if (active) { active.step = 'cancelled'; active.busy = false; active.revision++; } }
  function view(attempt = active) {
    if (!attempt) return null;
    if (current(attempt) && now() >= attempt.expiresAt && !attempt.sealed) { invalidate(); attempt.step = 'error'; attempt.error = 'LOGIN_EXPIRED'; }
    return { attemptId: attempt.id, revision: attempt.revision, region: attempt.region, initialRegion: attempt.initialRegion,
      step: attempt.step, busy: attempt.busy, providers: attempt.providers, methods: attempt.methods,
      ...(attempt.pendingRegion ? { targetRegion: attempt.pendingRegion } : {}),
      ...(attempt.accounts ? { accounts: attempt.accounts } : {}),
      ...(attempt.kind ? { kind: attempt.kind } : {}),
      ...(attempt.identifier ? { targetMasked: mask(attempt.identifier) } : {}),
      ...(attempt.bindType ? { bindType: attempt.bindType } : {}),
      ...(attempt.verification ? { channel: attempt.verification.channel, targetMasked: attempt.verification.targetMasked } : {}),
      ...(attempt.authorizationUrl ? { authorizationUrl: attempt.authorizationUrl } : {}),
      ...(attempt.challengeUrl ? { challengeUrl: attempt.challengeUrl } : {}),
      ...(attempt.member ? { membership: attempt.member } : {}),
      ...(attempt.error ? { error: attempt.error } : {}) };
  }
  function check(attempt) { if (!current(attempt) || now() >= attempt.expiresAt) throw authError('LOGIN_SUPERSEDED', 409); }
  async function call(attempt, path, body, endpoints = attempt.endpoints) {
    check(attempt); const value = await request(endpoints, path, body, attempt.abort.signal); check(attempt); return value;
  }
  async function load(attempt, region) {
    const endpoints = await registry.load(region, attempt.abort.signal); check(attempt);
    const providers = providersOf(await call(attempt, '/api/auth/providers', undefined, endpoints), region);
    return { endpoints, providers };
  }
  async function accept(attempt, outcome) {
    check(attempt);
    if (!outcome || Boolean(outcome.accountToken) !== Boolean(outcome.accountRefreshToken)) throw authError('INVALID_RESPONSE');
    attempt.ticket = null; attempt.accounts = null; attempt.bindType = null; attempt.bindingContact = null; attempt.verification = null; attempt.authorizationUrl = null;
    if (outcome.status === 'select_account') {
      if (!text(outcome.loginTicket) || !Array.isArray(outcome.accounts) || !outcome.accounts.length) throw authError('INVALID_RESPONSE');
      attempt.ticket = outcome.loginTicket; attempt.accounts = outcome.accounts.map(publicMember); attempt.step = 'account-selection';
    } else if (outcome.status === 'binding_required') {
      if (!['phone', 'email'].includes(outcome.bindType) || !text(outcome.bindTicket)) throw authError('INVALID_RESPONSE');
      attempt.ticket = outcome.bindTicket; attempt.bindType = outcome.bindType; attempt.step = 'binding';
    } else if (outcome.status === 'sso_verification_required') {
      if (!['email', 'sms'].includes(outcome.channel) || !text(outcome.verificationTicket) || !text(outcome.targetMasked, 300)) throw authError('INVALID_RESPONSE');
      attempt.ticket = outcome.verificationTicket; attempt.verification = { channel: outcome.channel, targetMasked: outcome.targetMasked }; attempt.step = 'sso-verification';
    } else if (outcome.status === 'ok') {
      if (!text(outcome.accessToken, 100000) || !text(outcome.refreshToken, 100000)) throw authError('INVALID_RESPONSE');
      const member = publicMember(outcome.membership);
      attempt.step = 'committing'; attempt.sealed = true;
      const lease = () => current(attempt);
      committing = Promise.resolve().then(async () => {
        check(attempt);
        await commitSession({ sessionVersion: 2, realm: attempt.region, endpointSnapshot: attempt.endpoints,
          authBaseUrl: attempt.endpoints.authApiBaseUrl, deviceId: attempt.deviceId, membershipId: member.id,
          kind: attempt.kind ?? 'sso', identifier: attempt.identifier ?? member.displayName, clientType: 'desktop',
          accessToken: outcome.accessToken, refreshToken: outcome.refreshToken }, lease);
        check(attempt);
      });
      await committing;
      attempt.member = member; attempt.step = 'completed'; cleanup(attempt);
    } else throw authError('INVALID_RESPONSE');
  }
  async function discoverOrg(attempt, org) {
    if (!text(org, 254) || /[\s/@]/.test(org)) throw authError('INVALID_ORGANIZATION');
    const results = await Promise.allSettled(['cn', 'global'].map(async region => {
      const endpoints = await registry.load(region, attempt.abort.signal); check(attempt);
      const result = await call(attempt, '/api/auth/sso/discovery', { org: org.toLowerCase() }, endpoints);
      if (result?.region !== region || typeof result.orgName !== 'string' || !Array.isArray(result.connections)) throw authError('INVALID_RESPONSE');
      if (!result.connections.length) throw authError('ORG_SSO_NOT_FOUND');
      const methods = methodsOf(result.connections.map(connection => ({ ...connection, type: 'sso', orgName: result.orgName, ssoRequired: true })));
      return { region, methods };
    }));
    check(attempt);
    if (results.every(r => r.status === 'fulfilled')) throw authError('ORG_REALM_AMBIGUOUS');
    const successes = results.filter(r => r.status === 'fulfilled');
    const missing = results.filter(r => r.status === 'rejected' && r.reason?.code === 'ORG_SSO_NOT_FOUND');
    if (successes.length === 1 && missing.length === 1) return successes[0].value;
    if (missing.length === 2) throw authError('ORG_SSO_NOT_FOUND');
    throw authError('ORG_REALM_UNAVAILABLE', 503);
  }
  function showMethods(attempt, found) {
    attempt.methods = found.methods;
    if (found.region !== attempt.region) { attempt.pendingRegion = found.region; attempt.step = 'region-confirmation'; }
    else attempt.step = 'method-choice';
  }
  async function sendCode(attempt, kind, identifier, captchaToken) {
    if (!attempt.providers[kind]) throw authError('LOGIN_METHOD_DISABLED');
    if (attempt.providers.captcha?.requiredFor.includes(kind + '_request_code') && !captchaToken) {
      attempt.pendingCode = { kind, identifier }; attempt.step = 'captcha';
      const url = new URL(attempt.endpoints.authApiBaseUrl + '/captcha/turnstile');
      url.search = new URLSearchParams({ action: kind + '_request_code', theme: 'auto', lang: 'zh-CN' }).toString();
      attempt.challengeUrl = url.href; return;
    }
    const result = await call(attempt, `/api/auth/${kind}/request-code`, { [kind]: identifier, locale: 'zh-CN', ...(captchaToken ? { captchaToken } : {}) });
    if (result?.status !== 'sent') throw authError('INVALID_RESPONSE');
    attempt.kind = kind; attempt.identifier = identifier; attempt.challengeUrl = null; attempt.pendingCode = null; attempt.step = 'verification-code';
  }
  async function work(attempt, input) {
    const action = input.action;
    if (action === 'discover_org' || action === 'discover_email') {
      if (!['identifier', 'method-choice'].includes(attempt.step)) throw authError('INVALID_STEP', 409);
      if (action === 'discover_org') showMethods(attempt, await discoverOrg(attempt, String(input.org ?? '').trim()));
      else {
        const email = validContact('email', input.identifier); attempt.personalEmail = email;
        let org = null;
        try { org = await discoverOrg(attempt, email.split('@')[1]); } catch (error) { if (error.code !== 'ORG_SSO_NOT_FOUND') throw error; }
        if (org && org.region !== attempt.initialRegion) showMethods(attempt, { ...org, methods: [...org.methods, { type: 'email_code' }] });
        else {
          const result = await call(attempt, '/api/auth/discovery', { email });
          const methods = methodsOf(result?.methods);
          if (!methods.length) throw authError('LOGIN_METHOD_DISABLED');
          showMethods(attempt, { region: attempt.region, methods });
        }
      }
    } else if (action === 'confirm_region') {
      if (attempt.step !== 'region-confirmation' || !attempt.pendingRegion) throw authError('INVALID_STEP', 409);
      const next = await load(attempt, attempt.pendingRegion);
      attempt.region = attempt.pendingRegion; attempt.pendingRegion = null; Object.assign(attempt, next); attempt.step = 'method-choice';
    } else if (action === 'personal_email') {
      if (!attempt.personalEmail || !attempt.methods?.some(x => x.type === 'email_code')) throw authError('INVALID_STEP');
      Object.assign(attempt, await load(attempt, attempt.initialRegion)); attempt.region = attempt.initialRegion; attempt.pendingRegion = null; attempt.methods = [];
      await sendCode(attempt, 'email', attempt.personalEmail);
    } else if (action === 'request_code') {
      if (!['identifier', 'verification-code'].includes(attempt.step)) throw authError('INVALID_STEP');
      await sendCode(attempt, input.kind, validContact(input.kind, input.identifier));
    } else if (action === 'captcha_complete') {
      if (attempt.step !== 'captcha' || !attempt.pendingCode) throw authError('INVALID_STEP');
      let url; try { url = new URL(input.resultUrl); } catch { throw authError('INVALID_CAPTCHA_RESULT'); }
      if (url.origin !== new URL(attempt.endpoints.authApiBaseUrl).origin || url.pathname !== '/captcha/turnstile' || !url.hash.startsWith('#cindy-captcha=ok.')) throw authError('INVALID_CAPTCHA_RESULT');
      let token; try { token = decodeURIComponent(url.hash.slice('#cindy-captcha=ok.'.length)); } catch { throw authError('INVALID_CAPTCHA_RESULT'); }
      if (!text(token, 8192)) throw authError('INVALID_CAPTCHA_RESULT');
      await sendCode(attempt, attempt.pendingCode.kind, attempt.pendingCode.identifier, token);
    } else if (action === 'verify_code') {
      if (attempt.step !== 'verification-code' || !text(input.code, 100)) throw authError('INVALID_STEP');
      await accept(attempt, await call(attempt, `/api/auth/${attempt.kind}/verify-code`, { [attempt.kind]: attempt.identifier, code: input.code.trim(), deviceId: attempt.deviceId, clientType: 'desktop', locale: 'zh-CN' }));
    } else if (action === 'select_account') {
      if (attempt.step !== 'account-selection' || !attempt.accounts.some(x => x.id === input.accountId)) throw authError('INVALID_ACCOUNT');
      await accept(attempt, await call(attempt, '/api/auth/select-account', { loginTicket: attempt.ticket, accountId: input.accountId, deviceId: attempt.deviceId }));
    } else if (action === 'binding_request' || action === 'binding_verify') {
      if (attempt.step !== 'binding') throw authError('INVALID_STEP');
      const contact = validContact(attempt.bindType, input.identifier);
      const body = { bindTicket: attempt.ticket, [attempt.bindType]: contact };
      if (action === 'binding_request') {
        const response = await call(attempt, '/api/auth/binding/request-code', { ...body, locale: 'zh-CN' });
        if (response?.status !== 'sent') throw authError('INVALID_RESPONSE');
        attempt.bindingContact = contact;
      } else {
        if (contact !== attempt.bindingContact || !text(input.code, 100)) throw authError('INVALID_STEP');
        await accept(attempt, await call(attempt, '/api/auth/binding/verify', { ...body, code: input.code.trim(), deviceId: attempt.deviceId }));
      }
    } else if (action === 'sso_request' || action === 'sso_verify') {
      if (attempt.step !== 'sso-verification') throw authError('INVALID_STEP');
      if (action === 'sso_request') {
        const response = await call(attempt, '/api/auth/sso/verification/request-code', { verificationTicket: attempt.ticket, deviceId: attempt.deviceId });
        if (response?.status !== 'sent') throw authError('INVALID_RESPONSE');
      } else {
        if (!text(input.code, 100)) throw authError('INVALID_CODE');
        await accept(attempt, await call(attempt, '/api/auth/sso/verification/verify', { verificationTicket: attempt.ticket, code: input.code.trim(), deviceId: attempt.deviceId }));
      }
    } else if (action === 'start_browser') {
      if (!['identifier', 'method-choice'].includes(attempt.step)) throw authError('INVALID_STEP');
      if (input.kind === 'social') { if (!attempt.providers.social.includes(input.providerOrConnectionId)) throw authError('LOGIN_METHOD_DISABLED'); }
      else if (input.kind !== 'sso' || !attempt.methods?.some(x => x.type === 'sso' && x.connectionId === input.providerOrConnectionId)) throw authError('CONNECTION_NOT_FOUND');
      attempt.kind = input.kind === 'social' ? input.providerOrConnectionId : 'sso';
      const started = await browser({ endpoints: attempt.endpoints, kind: input.kind, providerOrConnectionId: input.providerOrConnectionId,
        deviceId: attempt.deviceId, request, signal: attempt.abort.signal });
      check(attempt); attempt.browser = started; attempt.authorizationUrl = started.authorizationUrl; attempt.step = 'browser';
      attempt.background = started.result.then(async outcome => { check(attempt); await accept(attempt, outcome); }).catch(error => {
        if (current(attempt)) { attempt.error = error instanceof CindyAuthError ? error.code : 'AUTH_REQUEST_FAILED'; attempt.step = 'error'; cleanup(attempt); }
      }).finally(() => { if (active === attempt) { attempt.busy = false; attempt.revision++; } });
    } else throw authError('UNKNOWN_LOGIN_ACTION');
  }
  async function command(input = {}) {
    let startedId = null;
    try {
      if (disposed) throw authError('LOGIN_UNAVAILABLE', 503);
      if (input.action === 'start') {
        if (active && !terminal.includes(active.step) && !input.takeover) throw authError('LOGIN_BUSY', 409);
        if (active?.sealed && active.step === 'committing') throw authError('LOGIN_COMMITTING', 409);
        const region = authRegion(input.region);
        invalidate(); onStart();
        const attempt = { id: randomUUID(), epoch, region, initialRegion: region, revision: 0, step: 'identifier',
          busy: true, abort: new AbortController(), expiresAt: now() + lifetimeMs, methods: [], providers: null };
        active = attempt; startedId = attempt.id;
        attempt.timer = setTimeout(() => { if (current(attempt) && !attempt.sealed) { invalidate(); attempt.step = 'error'; attempt.error = 'LOGIN_EXPIRED'; } }, lifetimeMs); attempt.timer.unref?.();
        try { attempt.deviceId = await deviceId(); check(attempt); Object.assign(attempt, await load(attempt, region)); }
        catch (error) { if (active === attempt) { attempt.step = 'error'; cleanup(attempt); } throw error; }
        finally { attempt.busy = false; attempt.revision++; }
        return { ok: true, view: view() };
      }
      const attempt = active;
      if (!attempt || input.attemptId !== attempt.id) throw authError('LOGIN_SUPERSEDED', 409);
      if (input.action === 'read') return { ok: true, view: view() };
      if (input.action === 'cancel') {
        if (attempt.sealed) throw authError('LOGIN_COMMITTING', 409);
        invalidate(); return { ok: true, view: view() };
      }
      check(attempt);
      if (input.revision !== attempt.revision || attempt.busy) throw authError('LOGIN_STEP_CHANGED', 409);
      attempt.busy = true; attempt.error = null; attempt.revision++;
      try { await work(attempt, input); } catch (error) {
        if (current(attempt) && attempt.step === 'committing') { attempt.step = 'error'; attempt.error = 'CREDENTIAL_COMMIT_FAILED'; cleanup(attempt); }
        throw error;
      } finally { if (active === attempt) { attempt.busy = false; attempt.revision++; } }
      return { ok: true, view: view() };
    } catch (error) {
      return { ok: false, code: error instanceof CindyAuthError ? error.code : 'AUTH_REQUEST_FAILED',
        statusCode: error instanceof CindyAuthError ? error.status : 502, ...(input.attemptId === active?.id || startedId === active?.id ? { view: view() } : {}) };
    }
  }
  async function stop() { invalidate(); await committing.catch(() => {}); }
  async function dispose() { disposed = true; await stop(); }
  return { command, stop, dispose };
}
