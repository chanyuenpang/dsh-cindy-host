import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot';
import { HOST_PLUGIN_VERSION, HOST_APP_VERSION } from '../src/host-version.js';
test('runtime package version matches publish identity and keeps Cindy compatibility separate', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.name, 'dsh-cindy-host');
  assert.equal(pkg.version, HOST_PLUGIN_VERSION);
  assert.equal(HOST_PLUGIN_VERSION, '0.1.41');
  assert.equal(HOST_APP_VERSION, '0.1.82');
  assert.equal(pkg.dependencies?.keytar, undefined);
  assert.equal(pkg.optionalDependencies?.keytar, undefined);
  assert.ok(pkg.peerDependencies['@deepseek-ai/dsh-session'].includes('0.2.1-rc.5'));
  assert.ok(pkg.peerDependencies['@deepseek-ai/dsh-settings'].includes('0.2.1-rc.5'));
});

test('DSH installer accepts reviewed carriers and rejects unverified prereleases', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const version of ['0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5', '0.2.2-alpha.2', '0.2.2-rc.1']) {
    assert.equal(evaluatePluginCompatibility(pkg, {}, version), undefined, version);
  }
  for (const version of ['0.2.2-alpha.3', '0.2.2-rc.2', '0.2.2', '0.3.0-rc.1']) {
    assert.ok(evaluatePluginCompatibility(pkg, {}, version), version);
  }
  for (const group of ['dependencies', 'optionalDependencies']) {
    assert.equal(Object.keys(pkg[group] ?? {}).some(name => name.startsWith('@deepseek-ai/dsh')), false);
  }
});
