import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HOST_PLUGIN_VERSION, HOST_APP_VERSION } from '../src/host-version.js';
test('runtime package version matches publish identity and keeps Cindy compatibility separate', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.name, 'dsh-cindy-host');
  assert.equal(pkg.version, HOST_PLUGIN_VERSION);
  assert.equal(HOST_PLUGIN_VERSION, '0.1.28');
  assert.equal(HOST_APP_VERSION, '0.1.82');
  assert.equal(pkg.optionalDependencies.keytar, '^7.9.0');
  assert.ok(pkg.peerDependencies['@deepseek-ai/dsh-session'].includes('0.2.1-rc.3'));
});
