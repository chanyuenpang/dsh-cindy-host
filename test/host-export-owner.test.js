import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as immediate } from 'node:timers/promises';
import { createExportOwner } from '../src/host-export-owner.js';
import { refreshOwnedCredential, adoptSession, forgetSession } from '../src/auth-session.js';

const SESSION = { deviceId: 'host-fixture', authBaseUrl: 'https://auth.example.test', accessToken: 'fake-access-1', refreshToken: 'fake-refresh-1', identifier: 'not-an-account-id' };
const ROTATED = { ...SESSION, accessToken: 'fake-access-2', refreshToken: 'fake-refresh-2' };
const REALM = 'https://relay.example.test/api|https://auth.example.test';
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(extra = {}) {
  const f = { stored: { ...SESSION }, saves: [], refreshes: [], adopted: [], invalidations: 0, at: 0 };
  f.ports = {
    loadSession: async () => f.stored && { ...f.stored },
    saveSession: async session => { f.saves.push({ ...session }); f.stored = { ...session }; },
    clearSession: async () => { f.stored = null; },
    refreshStoredSession: async session => { f.refreshes.push(session); return { ok: true, session: ROTATED }; },
    ...extra.ports,
  };
  f.owner = createExportOwner({ ports: f.ports, now: () => f.at,
    onSession: value => f.adopted.push(value), onInvalidate: () => { f.invalidations++; }, ...extra.owner });
  f.bind = (session = SESSION, userId = 'user-a', realm = REALM) => f.owner.bind({ session, userId, realm });
  return f;
}

test('owner is absent until authenticated identity binding, immutable and distinct from credentials', () => {
  const f = fixture();
  assert.equal(f.owner.capture(), null);
  assert.equal(f.owner.getCredential(null), null);
  assert.equal(f.owner.isCurrent({}), false);
  const session = { ...SESSION };
  const owner = f.bind(session);
  const credential = f.owner.getCredential(owner);
  assert.equal(owner.userId, 'user-a');
  assert.equal(owner.realm, REALM);
  assert.ok(Object.isFrozen(owner));
  assert.ok(Object.isFrozen(credential.session));
  assert.deepEqual(Object.keys(credential.lease), []);
  assert.equal(JSON.stringify(owner).includes('fake-access'), false);
  session.accessToken = 'changed-after-binding';
  assert.equal(credential.session.accessToken, SESSION.accessToken);
  assert.equal(f.owner.capture(), owner);
});

test('same-account credential rotation retains owner and invalidates old credential revision', async () => {
  const f = fixture();
  const owner = f.bind();
  const original = f.owner.getCredential(owner);
  const next = await f.owner.refreshCredential(original);
  assert.ok(next);
  assert.equal(f.owner.capture(), owner);
  assert.notEqual(next.lease, original.lease);
  assert.equal(next.session.accessToken, ROTATED.accessToken);
  assert.equal(await f.owner.refreshCredential(original), null);
  assert.equal(f.owner.getCredential(owner), next);
  assert.deepEqual(f.adopted, [ROTATED]);
  assert.equal(f.invalidations, 0);
});

test('same lease refresh is singleflight; changed lease does not join and cooldown is bounded', async () => {
  const pending = deferred();
  let calls = 0;
  const f = fixture({ owner: { refresh: async () => { calls++; return pending.promise; } } });
  const owner = f.bind();
  const first = f.owner.getCredential(owner);
  const a = f.owner.refreshCredential(first);
  assert.strictEqual(f.owner.refreshCredential(first), a);
  pending.resolve({ ok: true, session: ROTATED });
  const next = await a;
  await immediate();
  assert.equal(calls, 1);
  assert.equal(await f.owner.refreshCredential(next), null);
  assert.equal(calls, 1);
  f.at = 30000;
  assert.ok(await f.owner.refreshCredential(next));
  assert.equal(calls, 2);
});

test('re-binding another lease while refresh waits does not join or adopt its old result', async () => {
  const pending = deferred();
  const f = fixture({ owner: { refresh: async () => pending.promise } });
  const owner = f.bind();
  const old = f.owner.getCredential(owner);
  const refresh = f.owner.refreshCredential(old);
  assert.equal(f.bind(ROTATED), owner);
  const newer = f.owner.getCredential(owner);
  assert.equal(await f.owner.refreshCredential(newer), null);
  pending.resolve({ ok: true, session: SESSION });
  assert.equal(await refresh, null);
  assert.equal(f.owner.getCredential(owner), newer);
  assert.deepEqual(f.adopted, []);
});

test('identity or realm change rotates owner epoch; explicit invalidation removes cleanup credentials', () => {
  const f = fixture();
  const a = f.bind();
  const b = f.bind(SESSION, 'user-b');
  assert.notEqual(a, b);
  assert.ok(b.epoch > a.epoch);
  assert.equal(f.owner.getCredential(a), null);
  const c = f.bind(SESSION, 'user-b', REALM + '-different');
  assert.notEqual(c, b);
  f.owner.invalidate();
  assert.equal(f.owner.capture(), null);
  assert.equal(f.owner.getCredential(c), null);
  assert.equal(f.owner.isCurrent(c), false);
  const d = f.bind(SESSION, 'user-b', REALM + '-different');
  assert.notEqual(c, d);
  assert.ok(d.epoch > c.epoch);
});

test('unverified or malformed binding cannot retain prior authority', () => {
  for (const fields of [{ userId: '' }, { userId: null }, { realm: '' }, { session: null }]) {
    const f = fixture();
    const owner = f.bind();
    assert.equal(f.owner.bind({ userId: 'user-a', realm: REALM, session: SESSION, ...fields }), null);
    assert.equal(f.owner.getCredential(owner), null);
  }
});

test('refresh sends a frozen captured snapshot, not a later caller mutation or live-store credential', async () => {
  const loaded = deferred();
  const captured = { ...SESSION };
  let passed;
  const refreshed = refreshOwnedCredential(captured, {
    isCurrent: () => true,
    loadSession: async () => { await loaded.promise; return { ...SESSION }; },
    refreshStoredSession: async snapshot => { passed = snapshot; return { ok: true, session: ROTATED }; },
    saveSession: async () => {},
  });
  captured.refreshToken = 'caller-mutated-token';
  captured.authBaseUrl = 'https://evil.example.test';
  loaded.resolve();
  assert.equal((await refreshed).ok, true);
  assert.deepEqual(passed, SESSION);
  assert.ok(Object.isFrozen(passed));
});

test('external store replacement before refresh or before save is refused without stale adoption', async () => {
  for (const moment of ['before', 'during']) {
    const api = deferred();
    const entered = deferred();
    const f = fixture({ ports: { refreshStoredSession: async () => { entered.resolve(); return api.promise; } } });
    const owner = f.bind();
    const captured = f.owner.getCredential(owner);
    if (moment === 'before') f.stored = { ...ROTATED, identifier: SESSION.identifier };
    const pending = f.owner.refreshCredential(captured);
    if (moment === 'during') {
      await entered.promise;
      f.stored = { ...ROTATED, identifier: SESSION.identifier };
      api.resolve({ ok: true, session: ROTATED });
    }
    assert.equal(await pending, null);
    assert.deepEqual(f.saves, []);
    assert.deepEqual(f.adopted, []);
    assert.equal(f.owner.getCredential(owner), captured);
  }
});

test('owned refresh request deadline aborts and ignores a late success without saving', async () => {
  const api = deferred();
  let signal;
  const f = fixture({ ports: { timeoutMs: 5, refreshStoredSession: async (_captured, options) => {
    signal = options.signal;
    return api.promise;
  } } });
  const owner = f.bind();
  const captured = f.owner.getCredential(owner);
  assert.equal(await f.owner.refreshCredential(captured), null);
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, true);
  assert.equal(f.owner.getCredential(owner), captured);
  assert.deepEqual(f.saves, []);
  api.resolve({ ok: true, session: ROTATED });
  await immediate();
  assert.deepEqual(f.saves, []);
  assert.deepEqual(f.adopted, []);
  assert.deepEqual(f.stored, SESSION);
});

test('account invalidation aborts a shared refresh immediately and ignores late API success', async () => {
  const api = deferred(), entered = deferred();
  let signal;
  const f = fixture({ ports: { refreshStoredSession: async (_captured, options) => {
    signal = options.signal;
    entered.resolve();
    return api.promise;
  } } });
  const owner = f.bind();
  const captured = f.owner.getCredential(owner);
  const first = f.owner.refreshCredential(captured);
  assert.strictEqual(f.owner.refreshCredential(captured), first);
  await entered.promise;
  assert.equal(signal.aborted, false);
  f.owner.invalidate();
  assert.equal(signal.aborted, true);
  assert.equal(f.owner.getCredential(owner), null);
  assert.equal(await first, null, 'abort settles without waiting for API');
  api.resolve({ ok: true, session: ROTATED });
  await immediate();
  assert.deepEqual(f.saves, []);
  assert.deepEqual(f.adopted, []);
});

test('refresh cannot change captured realm/device or adopt missing credentials', async () => {
  for (const change of [{ authBaseUrl: 'https://other.example.test' }, { deviceId: 'other-device' },
    { accessToken: '' }, { refreshToken: '' }]) {
    const f = fixture({ ports: { refreshStoredSession: async () => ({ ok: true, session: { ...ROTATED, ...change } }) } });
    const owner = f.bind();
    assert.equal(await f.owner.refreshCredential(f.owner.getCredential(owner)), null);
    assert.equal(f.saves.length, 0);
    assert.equal(f.adopted.length, 0);
  }
});

for (const action of ['login', 'logout']) test(action + ' fences a delayed API refresh before it can save or adopt', async () => {
  const api = deferred(), entered = deferred();
  const f = fixture({ ports: { refreshStoredSession: async () => { entered.resolve(); return api.promise; } } });
  const owner = f.bind();
  const pending = f.owner.refreshCredential(f.owner.getCredential(owner));
  await entered.promise;
  f.owner.invalidate();
  if (action === 'login') await adoptSession({ ...ROTATED, accessToken: 'new-login' }, f.ports);
  else await forgetSession(f.ports);
  api.resolve({ ok: true, session: ROTATED });
  assert.equal(await pending, null);
  assert.equal(f.owner.getCredential(owner), null);
  assert.equal(f.adopted.length, 0);
  assert.equal(f.stored?.accessToken ?? null, action === 'login' ? 'new-login' : null);
  assert.equal(f.saves.length, action === 'login' ? 1 : 0);
});

for (const action of ['login', 'logout']) test(action + ' wins serialized commit against a refresh already inside save', async () => {
  const saving = deferred(), release = deferred();
  const f = fixture();
  let saves = 0;
  f.ports.saveSession = async session => {
    saves++;
    if (saves === 1) { saving.resolve(); await release.promise; }
    f.stored = { ...session };
  };
  const owner = f.bind();
  const refreshing = f.owner.refreshCredential(f.owner.getCredential(owner));
  await saving.promise;
  f.owner.invalidate();
  const writing = action === 'login'
    ? adoptSession({ ...ROTATED, accessToken: 'new-login' }, f.ports)
    : forgetSession(f.ports);
  release.resolve();
  assert.equal(await refreshing, null);
  await writing;
  assert.equal(f.stored?.accessToken ?? null, action === 'login' ? 'new-login' : null);
  assert.equal(f.adopted.length, 0);
});
