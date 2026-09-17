/**
 * The destructive half of session restore, pinned by test.
 *
 * A Host refreshes its stored Cindy credential on **every** start. The first
 * version treated any refresh failure as "this credential is dead" and deleted it,
 * which — combined with a second Host instance rotating the same refresh token —
 * permanently signed the user out and forced a fresh login. These tests exist so
 * that rule cannot come back: only an explicit logout deletes anything.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreSession, forgetSession, adoptSession } from '../src/auth-session.js';

/** A credential store double that records every mutation. */
function store(initial) {
  const calls = [];
  return {
    calls,
    loadSession: async () => initial,
    saveSession: async (session) => calls.push(['save', session]),
    clearSession: async () => calls.push(['clear']),
  };
}

const STORED = { deviceId: 'dev-1', authBaseUrl: 'https://auth.example', refreshToken: 'rt', accessToken: 'at' };

test('a refused refresh reports the session as expired without deleting it', async () => {
  const credentials = store(STORED);
  const result = await restoreSession({
    ...credentials,
    refreshStoredSession: async () => ({ ok: false, rejected: true, message: 'Cindy 登录态已过期' }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'expired');
  assert.equal(result.rejected, true);
  assert.deepEqual(credentials.calls, [], 'a refusal must not touch the stored credential');
});

test('an unreachable service keeps the credential and connects with what is stored', async () => {
  const credentials = store(STORED);
  const result = await restoreSession({
    ...credentials,
    refreshStoredSession: async () => ({ ok: false, transient: true, message: '暂时无法续期 Cindy 登录态：网络不通' }),
  });

  assert.equal(result.ok, true, 'a dead network is not evidence about the credential');
  assert.equal(result.refreshDeferred, true);
  assert.equal(result.session.accessToken, 'at');
  assert.deepEqual(credentials.calls, []);
});

test('a successful refresh is persisted', async () => {
  const credentials = store(STORED);
  const result = await restoreSession({
    ...credentials,
    refreshStoredSession: async () => ({ ok: true, session: { accessToken: 'at2', refreshToken: 'rt2' } }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.session.accessToken, 'at2');
  assert.equal(credentials.calls.length, 1);
  assert.equal(credentials.calls[0][0], 'save');
  assert.equal(credentials.calls[0][1].refreshToken, 'rt2', 'the rotated token is written back');
});

test('no stored credential is a missing login, not a deletion', async () => {
  const credentials = store(null);
  const result = await restoreSession({ ...credentials, refreshStoredSession: async () => ({ ok: true, session: {} }) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing');
  assert.deepEqual(credentials.calls, []);
});

test('an explicit logout is the only thing that deletes the credential', async () => {
  const credentials = store(STORED);
  await forgetSession({ clearSession: credentials.clearSession });
  assert.deepEqual(credentials.calls, [['clear']]);

  await adoptSession({ deviceId: 'dev-2', accessToken: 'at' }, { saveSession: credentials.saveSession });
  assert.equal(credentials.calls[1][0], 'save');
  assert.equal(credentials.calls[1][1].deviceId, 'dev-2');
});
