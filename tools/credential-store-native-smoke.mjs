import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCredentialStore } from '../src/credential-store.js';

/** Uses installed DSH modules, but ONLY an isolated temporary credential document.
 * Run on Windows: node tools/credential-store-native-smoke.mjs --runtime <DSH root>
 * The runtime root must contain compiled node_modules/@deepseek-ai packages.
 * No user credential/profile or auth server is accessed; all credentials are fake.
 */
export async function smoke({ runtimePath, tempRoot = tmpdir(), env = process.env }) {
  assert.equal(process.platform, 'win32', 'this smoke verifies actual Windows DPAPI');
  const moduleUrl = name => pathToFileURL(join(runtimePath, 'node_modules', '@deepseek-ai', name, 'lib', 'index.js')).href;
  const { Context } = await import(moduleUrl('cordis'));
  const { LocalCredentialProvider } = await import(moduleUrl('dsh-credentials-local'));
  const dir = await mkdtemp(join(tempRoot, 'cindy-native-store-'));
  const path = join(dir, '.credentials.yaml');
  const session = { deviceId: 'fake-smoke-device', authBaseUrl: 'https://auth.invalid', accessToken: 'fake-smoke-access', refreshToken: 'fake-smoke-refresh' };
  const fibers = [];
  async function boot() {
    const ctx = new Context();
    const fiber = ctx.plugin(LocalCredentialProvider, { path, dshHome: dir, watch: false });
    fibers.push(fiber);
    await fiber;
    return createCredentialStore({ platform: 'win32', env, account: 'session-v1', getCredentials: () => ctx.get('credentials') });
  }
  try {
    const first = await boot();
    await first.saveSession(session);
    const text = await readFile(path, 'utf8');
    assert.ok(text.includes('dpapi-current-user-v1'));
    assert.ok(!text.includes(session.accessToken) && !text.includes(session.refreshToken));
    await fibers.shift().dispose();
    const reopened = await boot();
    assert.deepEqual(await reopened.loadSession(), session);
    const renewed = { ...session, accessToken: 'fake-renewed-access', refreshToken: 'fake-renewed-refresh' };
    await reopened.saveSession(renewed);
    assert.deepEqual(await reopened.loadSession(), renewed);
    await reopened.clearSession();
    assert.equal(await reopened.loadSession(), null);
    return { nativeDSH: true, realDPAPI: true, ciphertextOnly: true, freshContextRead: true, renewal: true, logout: true };
  } finally {
    for (const fiber of fibers) await fiber.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const index = process.argv.indexOf('--runtime');
  if (index < 0 || !process.argv[index + 1]) throw new Error('Usage: node tools/credential-store-native-smoke.mjs --runtime <DSH root>');
  console.log(await smoke({ runtimePath: resolve(process.argv[index + 1]) }));
}
