/** Disposable transport state, scoped to an accepted controller and its subscription lease. */
export function createHistoryDeliveryState(canWatch) {
  const controllers = new Map();
  function forget(deviceId, sessionId) {
    if (sessionId === undefined) controllers.delete(deviceId);
    else { const sessions = controllers.get(deviceId); sessions?.delete(sessionId); if (!sessions?.size) controllers.delete(deviceId); }
  }
  function ready(deviceId, sessionId) {
    if (!canWatch(deviceId, sessionId)) { forget(deviceId, sessionId); return false; }
    return controllers.get(deviceId)?.get(sessionId)?.ready === true;
  }
  function begin(frame) {
    if (frame.payload?.channel !== 'local-db:messages:view') return null;
    const sessionId = frame.payload.args?.[0];
    if (typeof sessionId !== 'string' || !canWatch(frame.src, sessionId)) return null;
    const sessions = controllers.get(frame.src) ?? new Map();
    const latest = !(typeof frame.payload.args?.[1]?.before === 'string' && frame.payload.args[1].before !== '');
    const token = { deviceId: frame.src, sessionId, latest, dirty: false,
      ready: !latest && sessions.get(sessionId)?.ready === true };
    sessions.set(sessionId, token); controllers.set(frame.src, sessions);
    return token;
  }
  function finish(token, success) {
    if (!token || controllers.get(token.deviceId)?.get(token.sessionId) !== token) return false;
    if (!success || !canWatch(token.deviceId, token.sessionId)) { forget(token.deviceId, token.sessionId); return false; }
    if (token.latest) token.ready = true;
    const dirty = token.dirty; token.dirty = false;
    return dirty;
  }
  function changed(sessionId) { for (const sessions of controllers.values()) { const state = sessions.get(sessionId); if (state) state.dirty = true; } }
  return { ready, begin, finish, changed, forget, clear: () => controllers.clear() };
}
