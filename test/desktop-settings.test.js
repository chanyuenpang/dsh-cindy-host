import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, createSettingsScope } from '../src/dsh-plugin.js';
import { DEFAULT_HOST_SETTINGS, SETTINGS_NAMESPACE as NS } from '../src/host-settings.js';
import { startHost } from '../src/host.js';

function fixture(initial = {}) {
  let value = { ...DEFAULT_HOST_SETTINGS, ...initial };
  const warnings = [];
  const calls = [];
  const settings = {
    describe: () => [{ ns: NS, value }],
    update: async (ns, patch) => { calls.push(['update', ns]); value = { ...value, ...patch }; },
    replace: async (ns, section) => { calls.push(['replace', ns]); value = { ...DEFAULT_HOST_SETTINGS, ...section }; },
  };
  const ctx = { settings, logger: { warn: (message) => warnings.push(message) } };
  const scope = createSettingsScope(ctx, NS, value);
  return { ctx, scope, settings, warnings, calls, set: (next) => { value = { ...DEFAULT_HOST_SETTINGS, ...next }; } };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('desktop re-reads external settings changes without a plugin remount', () => {
  const f = fixture();
  const observed = [];
  f.scope.watch((next) => observed.push(next));
  f.set({ transportEnabled: true, remoteControlEnabled: true });
  f.scope.refresh();
  assert.equal(f.scope.get().transportEnabled, true);
  assert.equal(observed.length, 1);
  f.scope.refresh();
  assert.equal(observed.length, 1, 'duplicate document notifications are not new settings');
  f.set({});
  f.scope.refresh();
  assert.equal(observed[1].transportEnabled, false);
});

test('snapshots detach nested live Config values', () => {
  const controllers = { phone: { state: 'authorized' } };
  const f = fixture({ controllers });
  controllers.phone.state = 'revoked';
  assert.equal(f.scope.get().controllers.phone.state, 'authorized');
  f.scope.refresh();
  assert.equal(f.scope.get().controllers.phone.state, 'revoked');
});

test('desktop writes publish only the settings owner resolved result', async () => {
  const f = fixture();
  f.settings.update = async () => f.set({ transportEnabled: true, deviceId: 'resolved' });
  await f.scope.update({ transportEnabled: true });
  assert.equal(f.scope.get().deviceId, 'resolved');
  await f.scope.replace({ remoteControlEnabled: true });
  assert.equal(f.scope.get().transportEnabled, false);
  assert.equal(f.scope.get().remoteControlEnabled, true);
  assert.deepEqual(f.calls, [['replace', NS]]);
  f.settings.update = async () => { throw new Error('persist failed'); };
  await assert.rejects(f.scope.update({ remoteControlEnabled: false }), /persist failed/);
  assert.equal(f.scope.get().remoteControlEnabled, true);
});

test('failed async watchers are contained and do not stop other watchers', async () => {
  const f = fixture();
  let observed = 0;
  f.scope.watch(() => { throw new Error('sync'); });
  f.scope.watch(async () => { throw new Error('async'); });
  const off = f.scope.watch(() => { observed++; });
  f.set({ transportEnabled: true });
  f.scope.refresh();
  await flush();
  assert.equal(observed, 1);
  assert.equal(f.warnings.length, 2);
  off();
  f.set({});
  f.scope.refresh();
  await flush();
  assert.equal(observed, 1);
});

test('refresh tolerates describe reentrancy, missing entries, and invalid settings', () => {
  const f = fixture();
  f.settings.describe = () => { f.scope.refresh(); return [{ ns: NS, value: { ...DEFAULT_HOST_SETTINGS, transportEnabled: true } }]; };
  f.scope.refresh();
  assert.equal(f.scope.get().transportEnabled, true);
  f.settings.describe = () => [];
  f.scope.refresh();
  assert.equal(f.scope.get().transportEnabled, true);
  f.settings.describe = () => [{ ns: NS, value: { transportEnabled: 'invalid' } }];
  assert.throws(() => f.scope.refresh(), /Invalid/);
  assert.equal(f.scope.get().transportEnabled, true);
});

test('legacy settings register keeps its original live scope', () => {
  const legacy = {};
  const ctx = { settings: { register: (ns) => { assert.equal(ns, NS); return legacy; } } };
  assert.equal(createSettingsScope(ctx, NS), legacy);
});

test('plugin subscribes to the correct settings event and contains early failures', () => {
  const f = fixture();
  const listeners = new Map();
  let reads = 0;
  f.ctx.on = (event, listener) => { listeners.set(event, listener); return () => {}; };
  f.ctx.effect = () => {};
  f.ctx.inject = () => {};
  f.settings.describe = () => { reads++; throw new Error('read unavailable before runtime startup'); };
  apply(f.ctx, DEFAULT_HOST_SETTINGS);
  const listener = listeners.get('settings/document-updated');
  assert.equal(typeof listener, 'function');
  listener('other-plugin', 1);
  assert.equal(reads, 0);
  assert.doesNotThrow(() => listener(NS, 2));
  assert.equal(reads, 1);
});

test('external switch changes reach real Host authentication and disable it again', async () => {
  const f = fixture();
  let authentications = 0;
  const runtime = await startHost(undefined, f.scope.get(), {
    resolveSession: async () => { authentications++; return { ok: false, reason: 'missing', message: 'test login required' }; },
    openSocket: () => { throw new Error('test must not connect'); },
  });
  const off = f.scope.watch((next) => runtime.updateSettings(next));
  try {
    assert.equal(authentications, 0);
    f.set({ transportEnabled: true, remoteControlEnabled: true });
    f.scope.refresh();
    await flush();
    assert.equal(authentications, 1);
    assert.equal(runtime.getStatus().login.required, true);
    f.set({});
    f.scope.refresh();
    await flush();
    assert.equal(runtime.getStatus().state, 'disconnected');
    assert.equal(runtime.getStatus().login.required, false);
    f.set({ transportEnabled: true });
    f.scope.refresh();
    await flush();
    assert.equal(authentications, 2);
  } finally { off(); await runtime.stop(); }
});
