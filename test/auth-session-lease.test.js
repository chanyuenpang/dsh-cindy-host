import test from 'node:test';
import assert from 'node:assert/strict';
import { adoptSession, forgetSession, restoreSession, refreshOwnedCredential } from '../src/auth-session.js';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };

test('lease invalidated before queued vault write cannot replace the signed-in identity', async () => {
  const pending = deferred(); let stored = null;
  const ports = { saveSession: async session => { await pending.promise; stored = session; }, clearSession: async () => { stored = null; } };
  const first = adoptSession({ deviceId: 'device', accessToken: 'old' }, ports);
  await new Promise(resolve => setImmediate(resolve));
  let current = true;
  const late = adoptSession({ deviceId: 'device', accessToken: 'late' }, { ...ports, isCurrent: () => current });
  current = false; pending.resolve(); await first;
  await assert.rejects(late, error => error.code === 'LOGIN_SUPERSEDED');
  assert.equal(stored.accessToken, 'old');
});

test('logout waits for in-progress vault write, clears it and no late completion can resurrect login', async () => {
  const pending = deferred(); let stored = null; let current = true;
  const ports = { saveSession: async session => { await pending.promise; stored = session; }, clearSession: async () => { stored = null; } };
  const login = adoptSession({ deviceId: 'device', accessToken: 'late' }, { ...ports, isCurrent: () => current });
  await new Promise(resolve => setImmediate(resolve));
  current = false; const logout = forgetSession(ports); pending.resolve();
  await assert.rejects(login, error => error.code === 'LOGIN_SUPERSEDED');
  await logout; assert.equal(stored, null);
});

test('corrupt or cross-region v2 snapshots never send a refresh token to an unverified endpoint', async () => {
  for (const authBaseUrl of ['https://evil.example', 'https://auth.cindy.com.cn']) {
    const captured = { deviceId: 'd', accessToken: 'a', refreshToken: 'r', sessionVersion: 2, realm: 'global', authBaseUrl,
      endpointSnapshot: { schemaVersion: 1, authApiBaseUrl: 'https://auth.cindy.app', deviceLinkApiBaseUrl: 'https://device-link.cindy.app' } };
    let refreshes = 0; const ports = { loadSession: async () => captured, refreshStoredSession: async () => { refreshes++; return { ok: true, session: captured }; }, saveSession: async () => assert.fail('must not rewrite the credential'), isCurrent: () => true };
    assert.equal((await restoreSession(ports)).reason, 'SESSION_REALM_MISMATCH');
    assert.equal((await refreshOwnedCredential(captured, ports)).reason, 'SESSION_REALM_MISMATCH');
    assert.equal(refreshes, 0);
  }
});
