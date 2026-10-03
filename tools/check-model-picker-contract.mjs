/** Read-only live model contract check; never selects models or sends prompts.
 * CINDY_SOURCE_ROOT=<checkout> node tools/check-model-picker-contract.mjs [base-url]
 * Requires Node with registerHooks/native TypeScript stripping.
 */
import assert from 'node:assert/strict';
import { loadCindyModelConsumers } from '../test/support/cindy-model-consumers.js';
if (!process.env.CINDY_SOURCE_ROOT) throw new Error('Set CINDY_SOURCE_ROOT to the actual Cindy checkout');
const base = process.argv[2] ?? 'http://127.0.0.1:19387';
const client = await loadCindyModelConsumers(process.env.CINDY_SOURCE_ROOT);
const device = 'live-model-contract';
async function call(channel) {
  const response = await fetch(base + '/api/dsh-cindy-host/selftest', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel, args: [] }), signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.ok, true);
  const envelope = await response.json();
  assert.equal(envelope.reply?.payload?.ok, true, channel + ' must succeed');
  return envelope.reply.payload.result;
}
try {
  const wire = JSON.stringify(await call('maker:provider:list'));
  const raw = JSON.parse(wire);
  const desktop = client.parseDesktopProviders(JSON.parse(wire));
  const mobile = await client.fetchMobileProviders(device, async () => JSON.parse(wire));
  const capabilities = await call('maker:get-capabilities');
  const keys = rows => rows.map(row => row.providerId + ':' + row.modelId).sort();
  const summary = { providerCount: raw.providers.length,
    unknownWindows: raw.providers.flatMap(p => (p.models.codex ?? [])
      .filter(m => !(m.contextWindow > 0)).map(m => ({ provider: p.id, model: m.id }))),
    paths: [] };
  for (const scope of ['draft', 'session']) {
    const hostRows = client.unifiedModelEntries({ providers: raw.providers, scope });
    const desktopRows = client.unifiedModelEntries({ providers: desktop.providers, scope });
    const mobileRows = client.unifiedModelEntries({ providers: mobile.providers, scope });
    summary.paths.push({ scope, host: hostRows.length, desktop: desktopRows.length, mobile: mobileRows.length });
    console.log(JSON.stringify(summary.paths.at(-1)));
    assert.ok(hostRows.length > 0, 'current Host must advertise at least one model');
    assert.deepEqual(keys(desktopRows), keys(hostRows), 'desktop ingress must not silently remove Host models');
    assert.deepEqual(keys(mobileRows), keys(hostRows), 'mobile ingress must preserve the same routes');
    assert.deepEqual([...new Set(hostRows.map(r => r.modelId))].sort(),
      [...new Set(capabilities.availableModels.map(m => m.id))].sort());
  }
  console.log(JSON.stringify({ ...summary, result: 'PASS', uiVerified: false }));
} finally { client.evictMobileProviders(device); client.dispose(); }
