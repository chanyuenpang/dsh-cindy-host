import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateIdentifier,
  normalizeAuthBaseUrl,
  requestLoginCode,
  verifyLoginCode,
  selectLoginAccount,
  refreshStoredSession,
  MAINLAND_CINDY_AUTH_BASE_URL,
} from '../src/cindy-login-flow.js';

/** Replace `globalThis.fetch` for one test and record what was sent. */
function stubFetch(respond) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    const result = respond(String(url), JSON.parse(init.body));
    if (result instanceof Error) throw result;
    // `status` travels too: the refresh path distinguishes a refusal (4xx) from a
    // service that is merely down (5xx), and a stub that hides it tests neither.
    return { ok: result.ok !== false, status: result.status, json: async () => result.body };
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test('normalizes the auth base URL and defaults to the mainland endpoint', () => {
  assert.equal(normalizeAuthBaseUrl(undefined), MAINLAND_CINDY_AUTH_BASE_URL);
  assert.equal(normalizeAuthBaseUrl('  '), MAINLAND_CINDY_AUTH_BASE_URL);
  assert.equal(normalizeAuthBaseUrl('https://auth.example/'), 'https://auth.example');
});

test('validates identifiers before spending a verification code', () => {
  assert.equal(validateIdentifier('phone', '13800000000').ok, true);
  assert.equal(validateIdentifier('phone', '+86 138 0000 0000').ok, true);
  assert.equal(validateIdentifier('email', 'a@b.co').ok, true);

  assert.equal(validateIdentifier('phone', '').ok, false);
  assert.equal(validateIdentifier('phone', 'abc').ok, false);
  assert.equal(validateIdentifier('email', 'nope').ok, false);
  assert.equal(validateIdentifier('telegram', 'x').ok, false);
});

test('requestLoginCode posts the kind-specific body', async () => {
  const stub = stubFetch(() => ({ body: {} }));
  try {
    const result = await requestLoginCode({ kind: 'phone', identifier: ' 13800000000 ' });
    assert.equal(result.ok, true);
    assert.equal(result.identifier, '13800000000');
    assert.equal(stub.calls.length, 1);
    assert.match(stub.calls[0].url, /\/api\/auth\/phone\/request-code$/);
    assert.deepEqual(stub.calls[0].body, { phone: '13800000000', locale: 'zh-CN' });
  } finally {
    stub.restore();
  }
});

test('requestLoginCode refuses to call Cindy for an invalid identifier', async () => {
  const stub = stubFetch(() => ({ body: {} }));
  try {
    const result = await requestLoginCode({ kind: 'phone', identifier: '' });
    assert.equal(result.ok, false);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('requestLoginCode reports a transport failure as a value', async () => {
  const stub = stubFetch(() => new Error('network down'));
  try {
    const result = await requestLoginCode({ kind: 'phone', identifier: '13800000000' });
    assert.equal(result.ok, false);
    assert.match(result.message, /验证码发送失败/);
  } finally {
    stub.restore();
  }
});

test('verifyLoginCode returns a session stamped with the caller-supplied device handle', async () => {
  const stub = stubFetch(() => ({ body: { tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: 123 } } }));
  try {
    const result = await verifyLoginCode({ kind: 'phone', identifier: '13800000000', code: ' 1234 ', deviceId: 'device-1' });
    assert.equal(result.ok, true);
    assert.equal(result.session.accessToken, 'at');
    assert.equal(result.session.refreshToken, 'rt');
    assert.equal(result.session.deviceId, 'device-1');
    assert.equal(result.session.kind, 'phone');
    assert.equal(result.session.authBaseUrl, MAINLAND_CINDY_AUTH_BASE_URL);
    assert.match(stub.calls[0].url, /\/api\/auth\/phone\/verify-code$/);
    assert.equal(stub.calls[0].body.code, '1234');
  } finally {
    stub.restore();
  }
});

test('verifyLoginCode accepts a flat token answer', async () => {
  const stub = stubFetch(() => ({ body: { accessToken: 'at', refreshToken: 'rt' } }));
  try {
    const result = await verifyLoginCode({ kind: 'email', identifier: 'a@b.co', code: '1', deviceId: 'd' });
    assert.equal(result.ok, true);
    assert.equal(result.session.accessToken, 'at');
  } finally {
    stub.restore();
  }
});

test('verifyLoginCode turns every other Cindy outcome into an ok:false value', async () => {
  const cases = [
    [{ status: 'select_account', accounts: [{ id: 'a1', displayName: 'Work' }], loginTicket: 't1' }, 'select_account'],
    [{ status: 'binding_required' }, 'binding_required'],
    [{ status: 'sso_verification_required' }, 'sso_verification_required'],
  ];
  for (const [body, expected] of cases) {
    const stub = stubFetch(() => ({ body }));
    try {
      const result = await verifyLoginCode({ kind: 'phone', identifier: '13800000000', code: '1', deviceId: 'd' });
      assert.equal(result.ok, false);
      assert.equal(result.status, expected);
    } finally {
      stub.restore();
    }
  }
});

test('verifyLoginCode rejects a token-less or codeless answer without a request', async () => {
  const stub = stubFetch(() => ({ body: { status: 'ok' } }));
  try {
    assert.equal((await verifyLoginCode({ kind: 'phone', identifier: '13800000000', code: '', deviceId: 'd' })).ok, false);
    assert.equal(stub.calls.length, 0);
    const noTokens = await verifyLoginCode({ kind: 'phone', identifier: '13800000000', code: '1', deviceId: 'd' });
    assert.equal(noTokens.ok, false);
    assert.match(noTokens.message, /未返回登录凭据/);
  } finally {
    stub.restore();
  }
});

test('verifyLoginCode requires a stable device handle', async () => {
  const stub = stubFetch(() => ({ body: { accessToken: 'a', refreshToken: 'b' } }));
  try {
    const result = await verifyLoginCode({ kind: 'phone', identifier: '13800000000', code: '1' });
    assert.equal(result.ok, false);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('selectLoginAccount exchanges a ticket for tokens', async () => {
  const stub = stubFetch(() => ({ body: { accessToken: 'at', refreshToken: 'rt' } }));
  try {
    const result = await selectLoginAccount({ loginTicket: 't1', accountId: 'a1', deviceId: 'device-1' });
    assert.equal(result.ok, true);
    assert.equal(result.session.deviceId, 'device-1');
    assert.deepEqual(stub.calls[0].body, { loginTicket: 't1', accountId: 'a1', deviceId: 'device-1' });
  } finally {
    stub.restore();
  }
});

test('selectLoginAccount refuses an incomplete selection', async () => {
  const stub = stubFetch(() => ({ body: {} }));
  try {
    assert.equal((await selectLoginAccount({ accountId: 'a1', deviceId: 'd' })).ok, false);
    assert.equal((await selectLoginAccount({ loginTicket: 't1', deviceId: 'd' })).ok, false);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('refreshStoredSession merges the new token pair over the stored session', async () => {
  const stub = stubFetch(() => ({ body: { accessToken: 'at2', refreshToken: 'rt2' } }));
  try {
    const result = await refreshStoredSession({ authBaseUrl: 'https://auth.example', deviceId: 'd1', refreshToken: 'rt1' });
    assert.equal(result.ok, true);
    assert.equal(result.session.accessToken, 'at2');
    assert.equal(result.session.deviceId, 'd1');
    assert.match(stub.calls[0].url, /^https:\/\/auth\.example\/api\/auth\/refresh$/);
  } finally {
    stub.restore();
  }
});

test('refreshStoredSession separates a refused credential from an unreachable service', async () => {
  // The caller deletes the stored credential on a refusal and must never do so on
  // a transport failure. Collapsing both into one outcome is what signed a working
  // session out on a flaky connection: every Host start refreshes, so one hiccup
  // deleted the credential permanently and forced a fresh login.
  const offTheWire = stubFetch(() => new Error('socket hang up'));
  try {
    assert.equal((await refreshStoredSession(null)).rejected, true, 'nothing stored is a refusal, not a retry');
    assert.equal((await refreshStoredSession({ deviceId: 'd1' })).rejected, true);
    const unreachable = await refreshStoredSession({ authBaseUrl: 'https://auth.example', deviceId: 'd1', refreshToken: 'rt' });
    assert.equal(unreachable.ok, false);
    assert.equal(unreachable.transient, true);
    assert.equal(unreachable.rejected, undefined, 'a dead network is not a dead credential');
    assert.match(unreachable.message, /网络不通/);
  } finally {
    offTheWire.restore();
  }

  const refused = stubFetch(() => ({ ok: false, status: 401, body: {} }));
  try {
    const expired = await refreshStoredSession({ authBaseUrl: 'https://auth.example', deviceId: 'd1', refreshToken: 'rt' });
    assert.equal(expired.rejected, true, 'the service answered and refused the token');
    assert.match(expired.message, /过期/);
  } finally {
    refused.restore();
  }

  const broken = stubFetch(() => ({ ok: false, status: 503, body: {} }));
  try {
    const later = await refreshStoredSession({ authBaseUrl: 'https://auth.example', deviceId: 'd1', refreshToken: 'rt' });
    assert.equal(later.transient, true, 'a 503 is the service being unavailable, not the token being invalid');
  } finally {
    broken.restore();
  }
});
