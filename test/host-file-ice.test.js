import test from 'node:test';
import assert from 'node:assert/strict';
import { createFileIceLoader, parseFileIceConfig } from '../src/host-file-ice.js';

const now = Date.now();
const server = { urls: ['turn:relay.example:3478?transport=udp', 'turns:relay.example:5349?transport=tcp'], username: 'short-lived', credential: 'secret' };
const config = () => ({ iceServers: [server], expiresAt: new Date(now + 3600_000).toISOString() });

test('ICE config retains validated short-lived UDP/TCP/TLS credentials only', () => {
  assert.deepEqual(parseFileIceConfig(config(), now), [server]);
  assert.deepEqual(parseFileIceConfig({ iceServers: [], expiresAt: null }, now), []);
  assert.throws(() => parseFileIceConfig({ ...config(), expiresAt: new Date(now).toISOString() }, now));
  assert.throws(() => parseFileIceConfig({ ...config(), expiresAt: new Date(now + 2 * 86400_000).toISOString() }, now));
  for (const urls of [['https://relay.example'], ['turns:relay.example:5349?transport=udp'], ['turn:relay.example:0'], ['turn:relay.example:99999'], ['turn:bad..example:3478']]) {
    assert.throws(() => parseFileIceConfig({ ...config(), iceServers: [{ ...server, urls }] }, now));
  }
  assert.throws(() => parseFileIceConfig({ ...config(), iceServers: [{ urls: server.urls }] }, now));
});

test('ICE uses live account credentials and one authorized refresh, never a separate login', async () => {
  let token = 'old';
  let refreshes = 0;
  const calls = [];
  const load = createFileIceLoader({ apiBaseUrl: 'https://relay.example/api/device-link', getSession: () => ({ accessToken: token }), now: () => now,
    onUnauthorized: async () => { refreshes++; token = 'fresh'; return true; },
    fetchImpl: async (url, options) => {
      calls.push({ url, token: options.headers.Authorization });
      assert.equal(options.cache, 'no-store');
      return calls.length === 1 ? { status: 401, ok: false } : { status: 200, ok: true, json: async () => config() };
    },
  });
  assert.deepEqual(await load(), [server]);
  assert.equal(refreshes, 1);
  assert.deepEqual(calls.map(c => c.token), ['Bearer old', 'Bearer fresh']);
  assert.equal(calls[0].url, 'https://relay.example/api/device-link/ice-servers');
  token = 'new-account';
  await load();
  assert.equal(calls[2].token, 'Bearer new-account');
});

test('ICE timeout aborts fetch and returns bounded STUN fallback without logging credentials', async () => {
  let signal;
  const load = createFileIceLoader({ apiBaseUrl: 'https://relay.example', getSession: () => ({ accessToken: 'token' }), timeoutMs: 10,
    fetchImpl: async (_, options) => { signal = options.signal; return new Promise(() => {}); },
  });
  const servers = await load();
  assert.equal(signal.aborted, true);
  assert.deepEqual(servers, [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['stun:stun.l.google.com:19302'] }]);
});

test('missing/invalid config and repeated 401 degrade without unbounded refresh', async () => {
  for (const response of [{ ok: false, status: 500 }, { ok: true, json: async () => ({ secret: 'must-not-log' }) }, { ok: false, status: 401 }]) {
    let refreshes = 0;
    const load = createFileIceLoader({ apiBaseUrl: 'https://relay.example', getSession: () => ({ accessToken: 'token' }),
      onUnauthorized: async () => { refreshes++; return true; }, fetchImpl: async () => response,
    });
    assert.equal((await load())[0].urls[0], 'stun:stun.cloudflare.com:3478');
    assert.ok(refreshes <= 1);
  }
});
