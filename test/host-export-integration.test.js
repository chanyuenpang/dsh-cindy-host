import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { FixtureDshSource } from '../src/fixture-source.js';
import { startHost } from '../src/host.js';
import { createHostRoutes } from '../src/host-routes.js';

const ON = { transportEnabled: true, remoteControlEnabled: true, controllers: {} };
const OFF = { transportEnabled: false, remoteControlEnabled: false, controllers: {} };
const SESSION = { deviceId: 'host-fixture', authBaseUrl: 'https://auth.example.test', accessToken: 'fake-access-1', refreshToken: 'fake-refresh-1' };
const ROTATED = { ...SESSION, accessToken: 'fake-access-2', refreshToken: 'fake-refresh-2' };
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
async function waitFor(check, label = 'condition') {
  const until = Date.now() + 4000;
  while (Date.now() < until) { const value = await check(); if (value) return value; await delay(2); }
  assert.fail('timed out waiting for ' + label);
}
class Socket {
  readyState = 1; closed = 0; sent = []; handlers = new Map();
  on(event, handler) { const list = this.handlers.get(event) ?? []; list.push(handler); this.handlers.set(event, list); return this; }
  emit(event, ...args) { for (const handler of this.handlers.get(event) ?? []) handler(...args); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.closed++; this.readyState = 3; }
  frame(frame) { this.emit('message', Buffer.from(JSON.stringify(frame))); }
}
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status,
  headers: { get: () => null }, json: async () => value });

async function fixture(t, { hello = true, hold = false, sign, options = {} } = {}) {
  const workdir = await fs.mkdtemp(join(tmpdir(), 'export-host-integration-'));
  const bytes = Buffer.from('streaming export integration fixture');
  await fs.writeFile(join(workdir, 'fixture.bin'), bytes);
  const f = { workdir, bytes, sockets: [], puts: [], signs: [], deletes: [], timers: [], session: { ...SESSION }, resolves: 0, rpc: 0 };
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith('/devices')) return response([]);
    if (String(url).endsWith('/media/presign-put')) {
      const call = { url, init, body: JSON.parse(init.body) };
      f.signs.push(call);
      if (sign) { const result = await sign(call, f); if (result) return result; }
      return response({ putUrl: 'https://oss.example.test/fixture', key: 'exports/job-' + f.signs.length });
    }
    if (String(url).endsWith('/media') && init.method === 'DELETE') {
      f.deletes.push({ url, init, body: JSON.parse(init.body) });
      return response({});
    }
    throw new Error('unexpected fake HTTP path: ' + url);
  };
  f.runtime = await startHost(new FixtureDshSource(), ON, {
    heartbeatMs: 0,
    resolveSession: async () => { f.resolves++; return { ok: true, session: { ...f.session } }; },
    openSocket: () => { const socket = new Socket(); f.sockets.push(socket); return socket; },
    fetch: fetchImpl,
    setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false, unref() {} }; f.timers.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cleared = true; },
    fileExportUploadOptions: { putImpl: async (url, init) => {
      const put = { url, init, gate: deferred(), chunks: [], completeBody: false };
      f.puts.push(put);
      for await (const chunk of init.body) put.chunks.push(Buffer.from(chunk));
      put.completeBody = true;
      if (hold) {
        let aborted;
        try {
          await Promise.race([put.gate.promise, new Promise((_, reject) => {
            aborted = () => reject(new Error('fake PUT aborted'));
            if (init.signal.aborted) aborted();
            else init.signal.addEventListener('abort', aborted, { once: true });
          })]);
        } finally { init.signal.removeEventListener('abort', aborted); }
      }
      return response({});
    } },
    ...options,
  });
  t.after(async () => {
    for (const put of f.puts) put.gate.resolve();
    await f.runtime.stop();
    await fs.rm(workdir, { recursive: true, force: true });
  });
  f.socket = () => f.sockets.at(-1);
  f.hello = (userId = 'user-a', socket = f.socket()) => {
    socket.emit('open');
    socket.frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: SESSION.deviceId, userId } });
  };
  f.invoke = async (input, { id = 'rpc-' + (++f.rpc), src = 'alice', socket = f.socket() } = {}) => {
    const before = socket.sent.length;
    socket.frame({ v: 1, kind: 'invoke', id, src, payload: { channel: 'file-browser:remote-op', args: [input] } });
    const frame = await waitFor(() => socket.sent.slice(before).find(row => row.kind === 'invoke-result' && row.id === id && row.dst === src), 'RPC ' + id);
    return frame.payload;
  };
  f.start = (input = {}, request) => f.invoke({ op: 'exportFileStart', workdir, relPath: 'fixture.bin', ...input }, request);
  f.status = (transferId, request) => f.invoke({ op: 'exportFileStatus', transferId }, request);
  f.idle = () => waitFor(() => f.runtime.getTransferDiagnostics().jobs.active === 0, 'export resource settlement');
  f.done = async transferId => waitFor(async () => {
    const answer = await f.status(transferId);
    assert.equal(answer.ok, true, JSON.stringify(answer));
    if (answer.result.state === 'uploading') return false;
    assert.equal(answer.result.state, 'done', JSON.stringify(answer));
    return answer.result;
  }, 'done status');
  if (hello) f.hello();
  else f.socket().emit('open');
  return f;
}

test('real file-export RPC forwards caller maxBytes and trusted src/RPC id, not payload spoofing', async t => {
  const f = await fixture(t, { hold: true });
  const limited = await f.start({ maxBytes: f.bytes.length - 1 });
  assert.equal(limited.error.code, 'OVERSIZE');
  const invalid = await f.start({ maxBytes: -1 });
  assert.equal(invalid.error.code, 'BAD_REQUEST');
  assert.equal(f.signs.length, 0);
  const first = await f.start({ maxBytes: f.bytes.length, src: 'bob', id: 'spoof' }, { id: 'trusted-rpc' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const again = await f.start({ maxBytes: f.bytes.length, src: 'not-alice' }, { id: 'trusted-rpc' });
  assert.equal(again.result.transferId, first.result.transferId);
  const conflict = await f.start({ maxBytes: f.bytes.length + 1 }, { id: 'trusted-rpc' });
  assert.equal(conflict.error.code, 'BAD_REQUEST');
  const hidden = await f.status(first.result.transferId, { src: 'bob' });
  assert.equal(hidden.error.code, 'NOT_FOUND');
  const second = await f.start({ maxBytes: f.bytes.length }, { id: 'trusted-rpc', src: 'bob' });
  assert.notEqual(second.result.transferId, first.result.transferId);
  await waitFor(() => f.puts.length === 2 && f.puts.every(p => p.completeBody));
  assert.equal(f.signs.length, 2);
  for (const put of f.puts) {
    assert.deepEqual(Buffer.concat(put.chunks), f.bytes);
    assert.equal(put.init.headers['Content-Length'], String(f.bytes.length));
    assert.equal(put.init.headers['x-oss-object-acl'], 'private');
    put.gate.resolve();
  }
  await f.done(first.result.transferId);
  await f.idle();
});

test('export denies identity before hello-ack and after hello-ack without trusted userId', async t => {
  const f = await fixture(t, { hello: false });
  assert.equal((await f.start()).error.code, 'OWNER_UNVERIFIED');
  // Omit userId explicitly; helper default is only for normal trusted handshakes.
  const second = await fixture(t, { hello: false });
  second.socket().frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: SESSION.deviceId } });
  assert.equal((await second.start()).error.code, 'OWNER_UNVERIFIED');
  assert.equal(f.signs.length + second.signs.length, 0);
});

test('link-close and transient relay loss do not cancel an existing upload', async t => {
  const f = await fixture(t, { hold: true });
  const started = await f.start();
  await waitFor(() => f.puts[0]?.completeBody);
  const put = f.puts[0], old = f.socket();
  old.frame({ v: 1, kind: 'link-close', src: 'alice' });
  assert.equal(put.init.signal.aborted, false);
  old.readyState = 3;
  old.emit('close', 1006, Buffer.from('transient test disconnect'));
  await delay(5);
  assert.equal(put.init.signal.aborted, false);
  assert.equal(f.runtime.getTransferDiagnostics().jobs.uploading, 1);
  put.gate.resolve();
  await f.idle();
  await f.runtime.connect();
  assert.equal(f.sockets.length, 2);
  f.hello('user-a');
  const status = await f.status(started.result.transferId);
  assert.equal(status.result.state, 'done');
  assert.equal(status.result.key, 'exports/job-1');
});

for (const operation of ['revoke', 'disable', 'stop']) test(operation + ' cancels in-flight Export and prevents late success publication', async t => {
  const f = await fixture(t, { hold: true });
  const started = await f.start();
  await waitFor(() => f.puts[0]?.completeBody);
  if (operation === 'revoke') await f.runtime.updateSettings({ ...ON, controllers: { alice: { state: 'revoked' } } });
  if (operation === 'disable') await f.runtime.updateSettings(OFF);
  if (operation === 'stop') await f.runtime.stop();
  assert.equal(f.puts[0].init.signal.aborted, true);
  f.puts[0].gate.resolve();
  await f.idle();
  assert.equal(f.runtime.getTransferDiagnostics().jobs.done, 0);
  if (operation === 'revoke') {
    await f.runtime.updateSettings(ON);
    assert.equal((await f.status(started.result.transferId)).error.code, 'NOT_FOUND');
  } else if (operation === 'disable') {
    await f.runtime.updateSettings(ON);
    f.hello();
    assert.equal((await f.status(started.result.transferId)).error.code, 'NOT_FOUND');
    const fresh = await f.start();
    assert.equal(fresh.ok, true, JSON.stringify(fresh));
    await waitFor(() => f.puts[1]?.completeBody);
    f.puts[1].gate.resolve();
    await f.done(fresh.result.transferId);
  }
});

test('explicit identity change closes old socket before new handshake and hides previous owner jobs', async t => {
  const f = await fixture(t, { hold: true });
  const started = await f.start();
  await waitFor(() => f.puts[0]?.completeBody);
  const old = f.socket();
  await f.runtime.beginIdentityChange();
  assert.equal(old.closed, 1);
  assert.equal(f.puts[0].init.signal.aborted, true);
  f.session = { ...ROTATED };
  await f.runtime.connect();
  assert.equal(f.sockets.length, 2);
  const newSocket = f.socket();
  assert.notEqual(newSocket, old);
  assert.equal((await f.start()).error.code, 'OWNER_UNVERIFIED');
  f.hello('user-b');
  old.frame({ v: 1, kind: 'hello-ack', payload: { deviceId: 'stale-device', userId: 'user-a' } });
  assert.equal(f.runtime.getStatus().host.userId, 'user-b');
  assert.equal((await f.status(started.result.transferId)).error.code, 'NOT_FOUND');
  await f.idle();
  const fresh = await f.start();
  assert.equal(fresh.ok, true, JSON.stringify(fresh));
  await waitFor(() => f.puts[1]?.completeBody);
  f.puts[1].gate.resolve();
  await f.done(fresh.result.transferId);
  assert.equal(f.deletes.length, 0, 'old-account cleanup must not borrow newly logged-in credentials');
});

for (const staleOutcome of ['success', 'failure']) test('explicit login supersedes pending connect; stale ' + staleOutcome + ' cannot unlatch new generation', async t => {
  const oldGate = deferred(), newGate = deferred(), persisted = deferred();
  const sockets = [], credentials = [];
  let stored = { ...SESSION }, resolves = 0;
  const runtime = await startHost(new FixtureDshSource(), OFF, {
    heartbeatMs: 0,
    resolveSession: async () => {
      const call = ++resolves;
      const snapshot = { ...stored };
      if (call === 1) {
        await oldGate.promise;
        if (staleOutcome === 'failure') throw new Error('superseded credential restore failed');
      } else if (call === 2) await newGate.promise;
      return { ok: true, session: snapshot };
    },
    openSocket: session => {
      credentials.push(session);
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
    fetch: async url => {
      assert.ok(String(url).endsWith('/devices'), 'no Export/refresh HTTP should run');
      return response([]);
    },
    setTimeout: (fn, ms) => ({ fn, ms, unref() {} }),
    clearTimeout: () => {},
  });
  t.after(async () => { oldGate.resolve(); newGate.resolve(); await runtime.stop(); });
  const oldConnect = runtime.updateSettings(ON);
  await waitFor(() => resolves === 1, 'first connect waiting for credential restore');
  const routes = createHostRoutes({ getRuntime: () => runtime, auth: {
    loadSession: async () => ({ ...stored }),
    verifyLoginCode: async () => ({ ok: true, session: ROTATED }),
    adoptSession: async session => { stored = { ...session }; persisted.resolve(); },
    forgetSession: async () => { stored = null; },
    selectLoginAccount: async () => ({ ok: false }),
  } });
  const loggingIn = routeCall(routes, '/login/verify-code', { kind: 'phone', identifier: 'fixture', code: 'fake-code' });
  await persisted.promise;
  await delay(2); // Allow the route's new-generation connect to enter its guard.
  assert.equal(sockets.length, 0);
  assert.equal(resolves, 1, 'credential operations serialize behind old restore');
  oldGate.resolve();
  await oldConnect;
  await waitFor(() => resolves === 2, 'new login must not be swallowed by old connecting state');
  assert.equal(sockets.length, 0, 'new-generation restore remains deliberately pending');
  let redundantSettled = false;
  const redundant = runtime.connect().then(() => { redundantSettled = true; });
  await delay(2);
  assert.equal(redundantSettled, true, 'stale finally must not clear current-generation connecting guard');
  assert.equal(resolves, 2, 'redundant connect must not enqueue a third credential restore');
  newGate.resolve();
  const loginReply = await loggingIn;
  await redundant;
  assert.equal(loginReply.status, 200);
  assert.equal(sockets.length, 1, 'only authenticated replacement opens a socket');
  assert.deepEqual(credentials[0], ROTATED);
  sockets[0].emit('open');
  sockets[0].frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: SESSION.deviceId, userId: 'user-b' } });
  assert.equal(runtime.getStatus().host.userId, 'user-b');
  assert.equal(resolves, 2);
  assert.equal(runtime.getTransferDiagnostics().jobs.records, 0, 'this is explicit-login reconnect, not export/refresh reconnect');
});

test('same-owner presign 401 uses pinned fake auth refresh and retries once without socket replacement', async t => {
  let stored = { ...SESSION }, apiCalls = 0, saves = 0;
  const f = await fixture(t, {
    sign: (_call, state) => state.signs.length === 1 ? response({}, 401) : undefined,
    options: { exportCredentialOptions: { ports: {
      loadSession: async () => ({ ...stored }),
      saveSession: async session => { saves++; stored = { ...session }; },
      refreshStoredSession: async captured => {
        apiCalls++;
        assert.deepEqual(captured, SESSION);
        assert.ok(Object.isFrozen(captured));
        return { ok: true, session: ROTATED };
      },
    } } },
  });
  const socket = f.socket();
  const start = await f.start();
  assert.equal(start.ok, true, JSON.stringify(start));
  await f.done(start.result.transferId);
  assert.equal(apiCalls, 1);
  assert.equal(saves, 1);
  assert.equal(f.signs.length, 2);
  assert.equal(f.signs[0].init.headers.Authorization, 'Bearer ' + SESSION.accessToken);
  assert.equal(f.signs[1].init.headers.Authorization, 'Bearer ' + ROTATED.accessToken);
  assert.equal(f.puts.length, 1);
  assert.equal(f.resolves, 1, 'refresh does not call general restoreSession/resolveSession');
  assert.equal(f.sockets.length, 1);
  assert.equal(socket.closed, 0);
  assert.equal(f.runtime.getStatus().host.userId, 'user-a');
});

test('revoking one controller does not abort account refresh shared by another export', async t => {
  const api = deferred(), entered = deferred();
  let stored = { ...SESSION }, signal, refreshes = 0;
  const f = await fixture(t, {
    sign: (_call, state) => state.signs.length <= 2 ? response({}, 401) : undefined,
    options: { exportCredentialOptions: { ports: {
      loadSession: async () => ({ ...stored }),
      saveSession: async session => { stored = { ...session }; },
      refreshStoredSession: async (_captured, options) => {
        refreshes++;
        signal = options.signal;
        entered.resolve();
        return api.promise;
      },
    } } },
  });
  const alice = await f.start();
  const bob = await f.start({}, { src: 'bob' });
  await entered.promise;
  await waitFor(() => f.signs.length === 2);
  await f.runtime.updateSettings({ ...ON, controllers: { alice: { state: 'revoked' } } });
  assert.equal(signal.aborted, false, 'one job cancellation must not revoke account refresh');
  api.resolve({ ok: true, session: ROTATED });
  const finished = await waitFor(async () => {
    const status = await f.status(bob.result.transferId, { src: 'bob' });
    if (status.result?.state === 'uploading') return false;
    assert.equal(status.result?.state, 'done', JSON.stringify(status));
    return status;
  });
  assert.ok(finished.result.key);
  assert.equal(refreshes, 1);
  assert.equal(f.signs.length, 3, 'only still-authorized job retries presign');
  assert.equal(f.puts.length, 1);
  assert.equal(f.socket().closed, 0);
  await f.runtime.updateSettings(ON);
  assert.equal((await f.status(alice.result.transferId)).error.code, 'NOT_FOUND');
});

async function routeCall(routes, path, body = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST'; req.url = '/api/dsh-cindy-host' + path;
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = { headersSent: false, writeHead(status) { this.status = status; this.headersSent = true; }, end(value) { this.body = value ? JSON.parse(String(value)) : null; } };
  await routes.handle(req, res);
  return res;
}
function routeFixture(result = { ok: true, session: SESSION }) {
  const events = [], calls = [];
  const runtime = {
    beginIdentityChange: async () => { events.push('invalidate'); },
    connect: async () => { events.push('connect'); },
    disconnect: async () => { events.push('disconnect'); },
    status: { setLogin: () => events.push('set-login') },
    getStatus: () => ({ state: 'fixture' }),
  };
  const routes = createHostRoutes({ getRuntime: () => runtime, auth: {
    loadSession: async () => ({ ...SESSION }),
    adoptSession: async session => { events.push('persist'); assert.deepEqual(session, SESSION); },
    forgetSession: async () => { events.push('clear'); },
    verifyLoginCode: async input => { calls.push(input); events.push('verify'); return result; },
    selectLoginAccount: async input => { calls.push(input); events.push('select'); return result; },
  } });
  return { routes, events, calls };
}

for (const operation of ['verify', 'select']) test('login route ' + operation + ' invalidates before persistence/connect; failure retains existing identity', async () => {
  const path = operation === 'verify' ? '/login/verify-code' : '/login/select-account';
  const input = { kind: 'phone', identifier: 'fake-user', code: 'fixture-code', loginTicket: 'fixture-ticket', accountId: 'selected-account' };
  const f = routeFixture();
  const answered = await routeCall(f.routes, path, input);
  assert.equal(answered.status, 200);
  assert.deepEqual(f.events, [operation, 'invalidate', 'persist', 'set-login', 'connect']);
  assert.equal(f.calls[0].deviceId, SESSION.deviceId);
  const rejected = routeFixture({ ok: false, message: 'fixture rejection' });
  assert.equal((await routeCall(rejected.routes, path, input)).status, 400);
  assert.deepEqual(rejected.events, [operation]);
});

test('logout route invalidates owner before credential clear and disconnect', async () => {
  const f = routeFixture();
  assert.equal((await routeCall(f.routes, '/logout')).status, 200);
  assert.deepEqual(f.events, ['invalidate', 'clear', 'disconnect']);
});
