import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDshSource } from '../src/dsh-plugin.js';

function palette(services) {
  const ctx = {
    get: name => services[name],
    on: () => () => {},
    effect: fn => fn(),
    inject: (names, fn) => {
      if (names.every(name => services[name] !== undefined)) fn(ctx);
      return () => {};
    },
  };
  services.sessionController ??= { resolveAgent: async () => { throw new Error('draft must not activate an Agent'); } };
  return buildDshSource(ctx, 'sessionController').palette;
}

test('alpha peers are explicit and lockfile root stays in sync without bundling a DSH runtime', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url)));
  assert.deepEqual(lock.packages[''].peerDependencies, manifest.peerDependencies);
  for (const name of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-settings']) {
    assert.deepEqual(manifest.peerDependencies[name].split(' || '), ['0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5', '0.2.2-alpha.2', '0.2.2-rc.1']);
  }
  assert.equal(manifest.peerDependencies['@deepseek-ai/schemastery'], '^3.18.1 || 3.18.6-alpha.1');
  for (const group of ['dependencies', 'optionalDependencies']) {
    assert.ok(!Object.keys(manifest[group] ?? {}).some(name => name.startsWith('@deepseek-ai/')));
  }
});

test('draft skills hold the acquired revision through the entire asynchronous read', async () => {
  const key = {};
  let released = false;
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const skills = palette({
    agentPresets: {
      acquireScope: async () => ({ key, async [Symbol.asyncDispose]() { released = true; } }),
      standingKeyFor() { assert.fail('current lease API must win'); },
    },
    skills: { async list(options) {
      assert.equal(options.scope, key);
      assert.equal(options.cwd, 'G:\\workspace');
      await pending;
      assert.equal(released, false);
      return [{ name: 'scoped' }];
    } },
  }).skills({ cwd: 'G:\\workspace' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(released, false);
  finish();
  assert.deepEqual(await skills, [{ name: 'scoped' }]);
  assert.equal(released, true);
});

test('draft scope is released on a failed read without retrying the global catalog', async () => {
  const failure = new Error('catalog failed');
  let reads = 0;
  let releases = 0;
  const menu = palette({
    agentPresets: { acquireScope: async () => ({ key: {}, async [Symbol.asyncDispose]() { releases++; } }) },
    skills: { list: async () => { reads++; throw failure; } },
  });
  await assert.rejects(menu.skills({}), error => error === failure);
  assert.equal(releases, 1);
  assert.equal(reads, 1);
});

test('failed draft scope acquisition keeps the existing global-only fallback', async () => {
  const menu = palette({
    agentPresets: { acquireScope: async () => { throw new Error('unusable preset'); } },
    skills: { list: async options => { assert.equal(options.scope, undefined); return [{ name: 'global' }]; } },
  });
  assert.deepEqual(await menu.skills({}), [{ name: 'global' }]);
});

test('older standing-key carriers remain supported', async () => {
  const key = {};
  const menu = palette({
    agentPresets: { standingKeyFor: async () => key },
    skills: { list: async options => { assert.equal(options.scope, key); return []; } },
  });
  assert.deepEqual(await menu.skills({}), []);
});

test('live session skills use the isolated preset service and never acquire a draft scope', async () => {
  const agent = { ctx: {} };
  const scoped = { list: async options => { assert.equal(options.scope, agent); return [{ name: 'isolated' }]; } };
  const menu = palette({
    agents: { get: id => { assert.equal(id, 'live'); return agent; } },
    agentPresets: {
      acquireScope() { assert.fail('a live Agent already owns its revision'); },
      serviceFor(subject, name) { assert.equal(subject, agent); assert.equal(name, 'skills'); return scoped; },
    },
    skills: { list() { assert.fail('the isolated registry must win'); } },
  });
  assert.deepEqual(await menu.skills({ sessionId: 'live' }), [{ name: 'isolated' }]);
});

test('cold session resolution still selects its own Agent instead of the default preset', async () => {
  const agent = { ctx: {} };
  const menu = palette({
    sessionController: { resolveAgent: async id => { assert.equal(id, 'cold'); return { agent }; } },
    agentPresets: { acquireScope() { assert.fail('must not replace a named session with the default'); } },
    skills: { list: async options => { assert.equal(options.scope, agent); return []; } },
  });
  assert.deepEqual(await menu.skills({ sessionId: 'cold' }), []);
});

test('a draft with no skills service still releases its revision lease', async () => {
  let releases = 0;
  const menu = palette({ agentPresets: { acquireScope: async () => ({ key: {}, async [Symbol.asyncDispose]() { releases++; } }) } });
  assert.deepEqual(await menu.skills({}), []);
  assert.equal(releases, 1);
});
