import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichModelCatalog, MODEL_CONTEXT_CONCURRENCY } from '../src/host-model-catalog.js';
import { toProviderList } from '../src/host-models.js';
const catalog = () => ({ default: { provider: 'a', model: 'same' }, routableProviders: ['a'],
  groups: ['a', 'b'].map((id) => ({ id, models: [{ id: 'same', name: 'Same' }, { id: 'same', name: 'Again' }] })) });

test('context lookup is per exact route, deduplicated, detached and display-only', async () => {
  const raw = catalog(), calls = [];
  const enriched = await enrichModelCatalog(raw, async (provider, id) => {
    calls.push([provider, id]);
    return { provider, id, context: { contextWindow: provider === 'a' ? 100000 : 200000 },
      defaultMaxTokens: 10, credentials: 'secret' };
  });
  assert.deepEqual(calls, [['a', 'same'], ['b', 'same']]);
  assert.deepEqual(enriched.groups.map(g => g.models.map(m => m.contextWindow)), [[100000, 100000], [200000, 200000]]);
  assert.deepEqual(enriched.default, raw.default);
  assert.deepEqual(enriched.routableProviders, ['a']);
  assert.equal(raw.groups[0].models[0].contextWindow, undefined);
  assert.equal(JSON.stringify(enriched).includes('secret'), false);
  const wire = toProviderList(enriched, ['codex', 'pi']);
  assert.deepEqual(wire.providers.map(p => p.connected), [true, false]);
  assert.deepEqual(wire.providers[0].routing, { codex: {}, pi: {} });
});

test('missing service, wrong identity, missing capacity and per-model failure never drop models', async () => {
  for (const resolver of [undefined,
    async () => ({ provider: 'other', id: 'same', context: { contextWindow: 99 } }),
    async (provider, id) => ({ provider, id, defaultMaxTokens: 4096 }),
    async () => { throw new Error('private diagnostic'); },
  ]) {
    const result = await enrichModelCatalog(catalog(), resolver);
    assert.equal(result.contextFailures.length, 2);
    const wire = toProviderList(result, ['pi']);
    assert.equal(wire.providers.length, 2);
    assert.equal(wire.providers[0].models.pi.length, 2);
    assert.equal(wire.providers[0].models.pi[0].contextWindow, 0);
    assert.equal(JSON.stringify(result).includes('private diagnostic'), false);
  }
});

test('valid catalog capacity is retained; enrichment does not overwrite it', async () => {
  const raw = catalog();
  for (const group of raw.groups) for (const model of group.models) model.contextWindow = 12345;
  const result = await enrichModelCatalog(raw, () => assert.fail('already known'));
  assert.equal(result.groups[0].models[0].contextWindow, 12345);
});

test('partial metadata failure preserves successful exact-route capacity', async () => {
  const result = await enrichModelCatalog(catalog(), async (provider, id) => {
    if (provider === 'b') throw new Error('offline');
    return { provider, id, context: { contextWindow: 12345 } };
  });
  assert.equal(result.groups[0].models[0].contextWindow, 12345);
  assert.equal(result.groups[1].models[0].contextWindow, undefined);
  assert.deepEqual(result.contextFailures, [{ provider: 'b', model: 'same', code: 'metadata-read-failed' }]);
});

test('total deadline bounds non-cooperative lookups and ignores late values', async () => {
  let resolveLate, observedSignal;
  const input = { groups: [{ id: 'a', models: Array.from({length: 10}, (_, i) => ({ id: String(i) })) }] };
  let started = 0;
  const result = await enrichModelCatalog(input, (_provider, _id, signal) => {
    started++; observedSignal = signal;
    return new Promise(resolve => { resolveLate = resolve; });
  }, { timeoutMs: 20 });
  assert.equal(started, MODEL_CONTEXT_CONCURRENCY);
  assert.equal(observedSignal.aborted, true);
  assert.equal(result.contextFailures.length, 10);
  assert.ok(result.contextFailures.every(f => f.code === 'metadata-deadline'));
  const before = JSON.stringify(result);
  resolveLate({ provider: 'a', id: '3', context: { contextWindow: 999 } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.stringify(result), before);
});

test('already cancelled request starts no metadata work', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await enrichModelCatalog(catalog(), () => assert.fail('cancelled'), { signal: controller.signal });
  assert.ok(result.contextFailures.every(f => f.code === 'metadata-cancelled'));
});
