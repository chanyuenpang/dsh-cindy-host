/**
 * The settings card's Host API.
 *
 * One prefix route registered on `ctx.webServer`, so the card — served from the
 * same origin as the GUI — reads status and drives login with plain `fetch`.
 * This is the pattern DSH's own plugins use for browser-facing Host surfaces
 * (see `dsh-client-connection`'s `/api` route), and it avoids inventing a
 * second transport for four small JSON calls.
 *
 * Nothing here decides state: every handler asks the runtime and answers with
 * what the runtime says. The card is a renderer.
 */
import { randomUUID } from 'node:crypto';
import { loadSession, clearSession } from './credential-store.js';
import { rememberedDeviceId } from './host-settings.js';
import { requestLoginCode, verifyLoginCode, selectLoginAccount } from './cindy-login-flow.js';
import { adoptSession } from './auth-session.js';

/** Route prefix; the card hardcodes the same value. */
export const API_PREFIX = '/api/dsh-cindy-host';

/** Largest accepted JSON body. Four short scalars never come close. */
const MAX_BODY_BYTES = 64 * 1024;

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Whether a request arrived over the loopback interface. */
export function isLoopbackRequest(req) {
  const address = req?.socket?.remoteAddress;
  // A socket with no address (an injected test double) is treated as local.
  return address === undefined || address === null || LOOPBACK.has(address);
}

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.byteLength, 'cache-control': 'no-store' });
  res.end(payload);
}

/** Read and parse a JSON request body, refusing anything oversized or non-JSON. */
export async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new Error('BODY_NOT_JSON');
  }
}

/**
 * Build the handlers for one running runtime.
 *
 * The runtime is read lazily through `getRuntime`, because the plugin replaces
 * it whenever settings restart the transport.
 * @param options - the runtime accessor and an optional diagnostics producer.
 * @returns one handler per route, each owning its own response.
 */
export function createHostRoutes({ getRuntime, getDiagnostics, getSettings, rememberDeviceId }) {
  /**
   * The stable Cindy device handle for this Host.
   *
   * The credential is preferred because that is the identity the relay has already
   * seen, but it is not the only source: a credential can legitimately vanish while
   * the phone still holds a link to this Host's device id, so the id is also kept in
   * settings. Generating a fresh one in that situation re-pairs the Host as a
   * different device and makes the phone's existing link dangle.
   * @returns the device id to log in with.
   */
  async function hostDeviceId() {
    const stored = await loadSession().catch(() => null);
    const fromCredential = typeof stored?.deviceId === 'string' ? stored.deviceId.trim() : '';
    const remembered = typeof getSettings === 'function'
      ? (() => { try { return rememberedDeviceId(getSettings()); } catch { return ''; } })()
      : '';
    const deviceId = fromCredential !== '' ? fromCredential : (remembered !== '' ? remembered : randomUUID());
    if (deviceId !== remembered && typeof rememberDeviceId === 'function') {
      // Remembering is best effort: a settings write that fails must not cost the
      // login the user is in the middle of.
      try {
        await rememberDeviceId(deviceId);
      } catch {
        // Ignored on purpose.
      }
    }
    return deviceId;
  }

  /** Why the Host has (or has not) any data to serve — cheap, and only for diagnosis. */
  function diagnostics() {
    if (typeof getDiagnostics !== 'function') return undefined;
    try {
      return getDiagnostics();
    } catch {
      // Diagnostics must never be the reason a status read fails.
      return undefined;
    }
  }

  async function handleStatus(req, res) {
    const runtime = getRuntime();
    if (!runtime) {
      sendJson(res, 200, { ok: true, installed: true, status: null, diagnostics: diagnostics() });
      return;
    }
    sendJson(res, 200, { ok: true, installed: true, status: runtime.getStatus(), diagnostics: diagnostics() });
  }

  async function handleReconnect(req, res) {
    const runtime = getRuntime();
    if (!runtime) {
      sendJson(res, 503, { ok: false, message: 'Cindy Host 运行时尚未就绪' });
      return;
    }
    // The card's button is an escape hatch, not the mechanism: the Host retries on its
    // own with backoff (`host-reconnect.js`). This path exists so a person can skip the
    // wait — it drops any queued retry and forgets the ladder.
    if (typeof runtime.reconnectNow === 'function') await runtime.reconnectNow();
    else await runtime.connect();
    sendJson(res, 200, { ok: true, status: runtime.getStatus() });
  }

  async function handleRequestCode(req, res, body) {
    const result = await requestLoginCode({ kind: body.kind, identifier: body.identifier });
    sendJson(res, result.ok ? 200 : 400, result);
  }

  async function handleVerifyCode(req, res, body) {
    const runtime = getRuntime();
    const result = await verifyLoginCode({
      kind: body.kind,
      identifier: body.identifier,
      code: body.code,
      deviceId: await hostDeviceId(),
    });
    if (!result.ok) {
      sendJson(res, 400, result);
      return;
    }
    await adoptSession(result.session);
    // A login while the switch is already on must finish the connect the user
    // asked for; with the switch off it only stores the session.
    if (runtime) {
      runtime.status.setLogin({ authenticated: true, required: false, kind: result.session.kind ?? null, identifier: result.session.identifier ?? null });
      await runtime.connect();
    }
    sendJson(res, 200, { ok: true, deviceId: result.session.deviceId, status: runtime ? runtime.getStatus() : null });
  }

  async function handleSelectAccount(req, res, body) {
    const runtime = getRuntime();
    const result = await selectLoginAccount({ loginTicket: body.loginTicket, accountId: body.accountId, deviceId: await hostDeviceId() });
    if (!result.ok) {
      sendJson(res, 400, result);
      return;
    }
    await adoptSession(result.session);
    if (runtime) {
      runtime.status.setLogin({ authenticated: true, required: false });
      await runtime.connect();
    }
    sendJson(res, 200, { ok: true, deviceId: result.session.deviceId, status: runtime ? runtime.getStatus() : null });
  }

  async function handleLogout(req, res) {
    const runtime = getRuntime();
    await clearSession();
    if (runtime) await runtime.disconnect();
    sendJson(res, 200, { ok: true, status: runtime ? runtime.getStatus() : null });
  }

  /**
   * Run one channel against the real services, from this process.
   *
   * This exists because "the phone shows nothing" is otherwise unverifiable
   * without a handset: two bugs were found only after a round trip, and both
   * looked identical from here. It is a diagnostic, not a feature — it carries
   * the same loopback-only trust boundary as every other route on this prefix,
   * and it performs whatever the channel performs.
   */
  async function handleSelfTest(req, res, body) {
    const runtime = getRuntime();
    if (!runtime || typeof runtime.invokeForTest !== 'function') {
      sendJson(res, 503, { ok: false, message: 'Cindy Host 运行时尚未就绪' });
      return;
    }
    const channel = typeof body.channel === 'string' ? body.channel : '';
    if (channel === '') {
      sendJson(res, 400, { ok: false, message: 'self-test needs a channel' });
      return;
    }
    const args = Array.isArray(body.args) ? body.args : [];
    sendJson(res, 200, await runtime.invokeForTest(channel, args));
  }

  /**
   * The route table: one entry per accepted method+path.
   * @returns handlers keyed by method and pathname.
   */
  const table = new Map([
    ['GET /status', handleStatus],
    ['POST /reconnect', handleReconnect],
    ['POST /login/request-code', handleRequestCode],
    ['POST /login/verify-code', handleVerifyCode],
    ['POST /login/select-account', handleSelectAccount],
    ['POST /logout', handleLogout],
    ['POST /selftest', handleSelfTest],
  ]);

  /** Paths that take a JSON body. */
  const BODY_PATHS = new Set(['/reconnect', '/login/request-code', '/login/verify-code', '/login/select-account', '/logout', '/selftest']);

  /**
   * The one handler registered on the web server.
   * @param req - incoming request.
   * @param res - response owned by this handler.
   */
  async function handle(req, res) {
    if (!isLoopbackRequest(req)) {
      sendJson(res, 403, { ok: false, message: 'Cindy Host API is loopback-only' });
      return;
    }

    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const suffix = pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length) : pathname;
    const handler = table.get(`${req.method ?? 'GET'} ${suffix}`);
    if (handler === undefined) {
      sendJson(res, 404, { ok: false, message: `Unknown Cindy Host route: ${req.method ?? 'GET'} ${pathname}` });
      return;
    }

    let body = {};
    if (BODY_PATHS.has(suffix)) {
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, error instanceof Error && error.message === 'BODY_TOO_LARGE' ? 413 : 400, { ok: false, message: '请求体无效' });
        return;
      }
    }

    try {
      await handler(req, res, body);
    } catch {
      if (!res.headersSent) sendJson(res, 500, { ok: false, message: 'Cindy Host 处理请求失败' });
      else res.end();
    }
  }

  return { handle, API_PREFIX };
}
