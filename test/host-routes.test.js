import test from 'node:test';
import assert from 'node:assert/strict';
import { API_PREFIX, createHostRoutes, isLoopbackRequest } from '../src/host-routes.js';

/** A request double that is async-iterable, the way node's IncomingMessage is. */
function makeRequest({ method = 'GET', url = API_PREFIX + '/status', remoteAddress = '127.0.0.1', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  return {
    method,
    url,
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/** A response double owner enough to observe what the handler wrote. */
function makeResponse() {
  return {
    statusCode: 0,
    headers: null,
    body: undefined,
    headersSent: false,
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
      this.headersSent = true;
    },
    end(payload) {
      this.body = payload === undefined || payload === null ? null : JSON.parse(String(payload));
    },
  };
}

const STATUS = { state: 'waiting', stateLabel: '等待手机连接', devices: [], host: null, login: { authenticated: true, required: false } };

function fakeRuntime(status = STATUS) {
  const calls = { connect: 0, disconnect: 0, setLogin: [] };
  return {
    calls,
    getStatus: () => status,
    connect: async () => {
      calls.connect += 1;
    },
    disconnect: async () => {
      calls.disconnect += 1;
    },
    status: { setLogin: (value) => calls.setLogin.push(value) },
  };
}

/** Run one request through the route handler and return the response. */
async function call(routes, request) {
  const response = makeResponse();
  await routes.handle(request, response);
  return response;
}

test('serves the Host status verbatim', async () => {
  const runtime = fakeRuntime();
  const routes = createHostRoutes({ getRuntime: () => runtime });
  const response = await call(routes, makeRequest());
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.deepEqual(response.body.status, STATUS);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(response.headers['content-type'], /application\/json/);
});

test('answers installed-but-not-ready before the runtime exists', async () => {
  const routes = createHostRoutes({ getRuntime: () => undefined });
  const response = await call(routes, makeRequest());
  assert.equal(response.statusCode, 200);
  // `diagnostics` is omitted entirely when no producer is wired.
  assert.deepEqual(response.body, { ok: true, installed: true, status: null });
});

test('reports which seam supplied the DSH source and how much it projected', async () => {
  const routes = createHostRoutes({
    getRuntime: () => fakeRuntime(),
    getDiagnostics: () => ({ dataSource: 'session-controller', projectionRunning: true, projectedSessions: 7 }),
  });
  const response = await call(routes, makeRequest());
  assert.deepEqual(response.body.diagnostics, { dataSource: 'session-controller', projectionRunning: true, projectedSessions: 7 });
  assert.deepEqual(response.body.status, STATUS, 'diagnostics are additive; the status contract is unchanged');
});

test('a failing diagnostics producer cannot break the status route', async () => {
  const routes = createHostRoutes({
    getRuntime: () => fakeRuntime(),
    getDiagnostics: () => {
      throw new Error('diagnostics exploded');
    },
  });
  const response = await call(routes, makeRequest());
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.diagnostics, undefined);
  assert.deepEqual(response.body.status, STATUS);
});

test('refuses requests that did not arrive over loopback', async () => {
  const routes = createHostRoutes({ getRuntime: () => fakeRuntime() });
  const response = await call(routes, makeRequest({ remoteAddress: '10.0.0.5' }));
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.ok, false);
});

test('treats the IPv6 and IPv4-mapped loopback forms as local', () => {
  assert.equal(isLoopbackRequest(makeRequest({ remoteAddress: '::1' })), true);
  assert.equal(isLoopbackRequest(makeRequest({ remoteAddress: '::ffff:127.0.0.1' })), true);
  assert.equal(isLoopbackRequest(makeRequest({ remoteAddress: '192.168.1.20' })), false);
  assert.equal(isLoopbackRequest({ socket: {} }), true);
});

test('rejects an unknown route and method', async () => {
  const routes = createHostRoutes({ getRuntime: () => fakeRuntime() });
  const response = await call(routes, makeRequest({ url: API_PREFIX + '/nope' }));
  assert.equal(response.statusCode, 404);
  const wrongMethod = await call(routes, makeRequest({ method: 'POST', url: API_PREFIX + '/status' }));
  assert.equal(wrongMethod.statusCode, 404);
});

test('reports an unavailable runtime for reconnect', async () => {
  const routes = createHostRoutes({ getRuntime: () => undefined });
  const response = await call(routes, makeRequest({ method: 'POST', url: API_PREFIX + '/reconnect', body: {} }));
  assert.equal(response.statusCode, 503);
});

test('reconnects through the runtime and answers with the new status', async () => {
  const runtime = fakeRuntime();
  const routes = createHostRoutes({ getRuntime: () => runtime });
  const response = await call(routes, makeRequest({ method: 'POST', url: API_PREFIX + '/reconnect', body: {} }));
  assert.equal(response.statusCode, 200);
  assert.equal(runtime.calls.connect, 1);
  assert.deepEqual(response.body.status, STATUS);
});

test('rejects a malformed JSON body', async () => {
  const routes = createHostRoutes({ getRuntime: () => fakeRuntime() });
  const response = await call(routes, makeRequest({ method: 'POST', url: API_PREFIX + '/reconnect', body: '{not json' }));
  assert.equal(response.statusCode, 400);
});

test('rejects an oversized body', async () => {
  const routes = createHostRoutes({ getRuntime: () => fakeRuntime() });
  const response = await call(routes, makeRequest({ method: 'POST', url: API_PREFIX + '/reconnect', body: 'x'.repeat(70 * 1024) }));
  assert.equal(response.statusCode, 413);
});

test('validates the login identifier before touching the credential store', async () => {
  const routes = createHostRoutes({ getRuntime: () => fakeRuntime() });
  const response = await call(routes, makeRequest({ method: 'POST', url: API_PREFIX + '/login/request-code', body: { kind: 'phone', identifier: '' } }));
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.ok, false);
});

test('a handler failure becomes a 500 rather than an unhandled rejection', async () => {
  const routes = createHostRoutes({
    getRuntime: () => ({
      getStatus() {
        throw new Error('runtime exploded');
      },
    }),
  });
  const response = await call(routes, makeRequest());
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.ok, false);
});
