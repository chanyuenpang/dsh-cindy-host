import test from 'node:test';
import assert from 'node:assert/strict';
import { importedChannelConstants, referencedChannels, literalChannelCalls } from '../tools/channel-audit-source.mjs';
import { createChannelRouter } from '../src/cindy-channels.js';

test('read-only audit resolves used scalar imports and aliases without executing upstream code', () => {
  const source = `import { MACHINE_CHANNEL as LOCAL_CHANNEL, WAIT_MS } from './machine.js';\nexport const DL_LOCAL_CHANNEL = 'device-link:subscribe';`;
  const modules = [];
  const constants = importedChannelConstants(source, name => {
    modules.push(name);
    return `export const MACHINE_CHANNEL: string = "maker:machine:status";\nexport const WAIT_MS = 30000;\nthrow new Error('must not execute upstream');`;
  });
  assert.deepEqual(modules, ['./machine.js']);
  assert.deepEqual([...referencedChannels(`[LOCAL_CHANNEL, DL_LOCAL_CHANNEL, "maker:model-catalog:read"]`, constants)], ['maker:model-catalog:read', 'maker:machine:status', 'device-link:subscribe']);
});

test('an unresolved imported scalar channel is a visible audit failure, not silently omitted', () => {
  const constants = importedChannelConstants(`import { DYNAMIC_CHANNEL } from './dynamic.js';`, () => 'export const DYNAMIC_CHANNEL = buildChannel();');
  assert.throws(() => referencedChannels('[DYNAMIC_CHANNEL]', constants), /Cannot statically resolve/);
  assert.deepEqual([...referencedChannels('["maker:read"]', constants)], ['maker:read']);
});

test('audit recognizes double quotes and generic call sites in independent consumer modules', () => {
  const mobile = literalChannelCalls(`transport.call<Result>("device-link:usage-widget:snapshot:v1"); call('maker:read');`);
  assert.equal(mobile.get('device-link:usage-widget:snapshot:v1'), 1);
  assert.equal(mobile.get('maker:read'), 1);
  const desktop = literalChannelCalls(`invokeRemote<Catalog>(device, "maker:model-catalog:read"); t('maker:read');`, true);
  assert.equal(desktop.get('maker:model-catalog:read'), 1);
  assert.equal(desktop.get('maker:read'), 1);
});

test('audit ignores commented examples and preserves strings containing URL comment markers', () => {
  const source = `const url = 'https://example.invalid'; call("maker:real");\n// call('maker:comment')\n/* invokeRemote(x, 'maker:comment') */`;
  assert.deepEqual([...literalChannelCalls(source)], [['maker:real', 1]]);
  assert.deepEqual([...literalChannelCalls(source, true)], []);
});

test('new optional upstream channels actually refuse without claiming native support', async () => {
  const router = createChannelRouter({ listSessions: async () => [], subscribers: new Set() });
  for (const channel of ['maker:model-catalog:read', 'maker:machine:status', 'device-link:usage-widget:snapshot:v1', 'maker:companion-cloud:caps', 'maker:companion-cloud:flush', 'maker:companion-cloud:hand-over', 'maker:companion-cloud:merge', 'maker:companion-cloud:targets', 'maker:remote-agent:v1', 'maker:task-copy', 'provider-group:remote', 'maker:companion-live:read', 'maker:setup-snapshot', 'maker:setup-transfer']) {
    const result = await router({ v: 1, kind: 'invoke', id: channel, src: 'audit', payload: { channel, args: [] } });
    assert.equal(result.payload.ok, false);
    assert.equal(result.payload.error.code, 'CHANNEL_NOT_ALLOWED');
  }
});
