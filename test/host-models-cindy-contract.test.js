import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { toProviderList } from '../src/host-models.js';
import { createChannelRouter, DSH_AGENT_KINDS } from '../src/cindy-channels.js';

// Optional cross-repository check against real Cindy consumers, not a copied predicate.
// CINDY_SOURCE_ROOT=<checkout> node --test test/host-models-cindy-contract.test.js
// Requires a Node runtime with registerHooks and native TypeScript stripping.
test('Host wire providers survive real Cindy registry and unified picker derivation', {
  skip: !process.env.CINDY_SOURCE_ROOT && 'Set CINDY_SOURCE_ROOT to test the real Cindy consumers',
}, async () => {
  const { registerHooks } = await import('node:module');
  const root = pathToFileURL(resolve(process.env.CINDY_SOURCE_ROOT, 'packages/model-providers/src') + '/');
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      // Cindy TS sources use .js ESM specifiers. Resolve only inside this package.
      if (context.parentURL?.startsWith(root.href) && specifier.startsWith('./') && specifier.endsWith('.js')) {
        const ts = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
        if (existsSync(ts)) return next(ts.href, context);
      }
      return next(specifier, context);
    },
  });
  try {
    const { connectedProvidersForAgent } = await import(new URL('registry.ts', root));
    const { buildProviderSections } = await import(new URL('sections.ts', root));
    const { unifiedModelEntries } = await import(new URL('unifiedSelection.ts', root));
    // Current DSH buildModelCatalog exports id/name/description/reasoning only.
    const model = { id: 'gpt-x', name: 'GPT X',
      reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' } };
    const catalog = {
      routableProviders: ['one', 'two'],
      groups: ['one', 'two', 'offline'].map((id) => ({ id, name: id, models: [model] })),
    };
    let failed = false;
    const router = createChannelRouter({ listSessions: async () => [], subscribers: new Set(),
      resolveCapabilities: () => ({ modelCatalog: async () => {
        if (failed) throw new Error('catalog unavailable');
        return catalog;
      } }),
    });
    const request = { id: 'catalog', src: 'phone', type: 'invoke', payload: { channel: 'maker:provider:list', args: [] } };
    const reply = await router(request);
    assert.equal(reply.payload.ok, true);
    const providers = JSON.parse(JSON.stringify(reply.payload.result.providers));
    const before = providers.map(({ routing, ...rest }) => rest);
    assert.deepEqual(unifiedModelEntries({ providers: before }), [], 'old Host payload reproduces the empty picker');
    for (const agent of DSH_AGENT_KINDS) {
      assert.deepEqual(connectedProvidersForAgent(before, agent), []);
      const connected = connectedProvidersForAgent(providers, agent);
      assert.deepEqual(connected.map((p) => p.id), ['one', 'two']);
      const sections = buildProviderSections({ providers: connected, agent, isVisible: () => true });
      assert.deepEqual(sections.flatMap((s) => s.models.map((m) => m.id)), ['gpt-x', 'gpt-x']);
      assert.deepEqual(sections[0].models[0].efforts, ['low', 'high']);
      assert.equal(sections[0].models[0].defaultEffort, 'high');
      assert.equal(sections[0].models[0].contextWindow, 0, 'unknown capacity must not hide the model');
      const disabled = structuredClone(providers);
      for (const p of disabled) p.routing[agent].disabled = true;
      assert.deepEqual(connectedProvidersForAgent(disabled, agent), []);
    }
    assert.deepEqual(connectedProvidersForAgent(providers, 'unknown'), []);
    for (const scope of ['draft', 'session']) {
      const rows = unifiedModelEntries({ providers, scope });
      assert.deepEqual(rows.map((r) => [r.providerId, r.modelId]), [['one', 'gpt-x'], ['two', 'gpt-x']]);
      for (const row of rows) {
        assert.deepEqual(row.candidates, DSH_AGENT_KINDS);
        for (const agent of row.candidates) assert.equal(row.capabilities[agent].wireModelId, 'gpt-x');
      }
    }
    assert.deepEqual(unifiedModelEntries({ providers: toProviderList({ groups: [] }, DSH_AGENT_KINDS).providers }), []);
    failed = true;
    const failure = await router(request);
    assert.equal(failure.payload.ok, false);
    assert.equal(failure.payload.error.code, 'NOT_AVAILABLE', 'failure must not reuse the last successful catalog');
  } finally {
    hooks.deregister();
  }
});
