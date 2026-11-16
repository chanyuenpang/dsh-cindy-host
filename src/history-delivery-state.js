/** Disposable transport state, scoped to an accepted controller and its subscription lease. */
export function createHistoryDeliveryState(canWatch) {
  const controllers = new Map();
  function forget(deviceId, sessionId) {
    if (sessionId === undefined) controllers.delete(deviceId);
    else { const sessions = controllers.get(deviceId); sessions?.delete(sessionId); if (!sessions?.size) controllers.delete(deviceId); }
  }
  function stateFor(deviceId, sessionId, create = false) {
    if (!canWatch(deviceId, sessionId)) { forget(deviceId, sessionId); return null; }
    let sessions = controllers.get(deviceId);
    if (!sessions && create) { sessions = new Map(); controllers.set(deviceId, sessions); }
    let state = sessions?.get(sessionId);
    if (!state && create) {
      state = { ready: false, workLines: false, page: null, version: 0, pending: null, expanded: [] };
      sessions.set(sessionId, state);
    }
    return state ?? null;
  }
  function ready(deviceId, sessionId) { return stateFor(deviceId, sessionId)?.ready === true; }
  function begin(frame) {
    if (frame.payload?.channel !== 'local-db:messages:view') return null;
    const sessionId = frame.payload.args?.[0];
    if (typeof sessionId !== 'string') return null;
    const state = stateFor(frame.src, sessionId, true);
    if (!state) return null;
    const options = frame.payload.args?.[1];
    const latest = !(typeof options?.before === 'string' && options.before !== '');
    const token = { deviceId: frame.src, sessionId, latest, workLines: options?.workLines === true, dirty: false, state };
    state.version++;
    state.pending = token;
    if (latest) { state.ready = false; state.page = null; }
    return token;
  }
  // `page` must be the actual fitted frame that send accepted, never the pre-fit reader result.
  function finish(token, success, page) {
    if (!token || stateFor(token.deviceId, token.sessionId) !== token.state || token.state.pending !== token) return false;
    const state = token.state;
    if (!success) { forget(token.deviceId, token.sessionId); return false; }
    state.pending = null;
    state.version++;
    if (token.latest) {
      state.ready = true;
      state.workLines = token.workLines;
      state.page = token.workLines && page?.version === 1 && Array.isArray(page.items) ? structuredClone(page) : null;
    }
    return token.dirty;
  }
  function changed(sessionId) {
    for (const sessions of controllers.values()) {
      const state = sessions.get(sessionId);
      if (state?.pending) state.pending.dirty = true;
    }
  }
  function capture(deviceId, sessionId) {
    const state = stateFor(deviceId, sessionId);
    return state ? { deviceId, sessionId, state, version: state.version, page: state.page,
      workLines: state.workLines, expanded: [...state.expanded] } : null;
  }
  function current(lease) {
    return !!lease && stateFor(lease.deviceId, lease.sessionId) === lease.state && lease.state.version === lease.version;
  }
  function acceptPatch(lease, page) {
    if (!current(lease) || !lease.state.ready || lease.state.pending || !lease.state.workLines) return false;
    lease.state.page = structuredClone(page);
    lease.state.version++;
    return true;
  }
  function invalidate(lease) {
    if (!current(lease)) return;
    lease.state.page = null;
    lease.state.version++;
  }
  function intent(deviceId, sessionId, refs) {
    if (!Array.isArray(refs) || refs.length > 100 || refs.some(ref => typeof ref?.key !== 'string' || !ref.key.replace(/^preview-/, ''))) {
      return { ok: false, code: 'BAD_REQUEST', message: 'invalid expanded work groups' };
    }
    const state = stateFor(deviceId, sessionId, true);
    if (!state) return { ok: false, code: 'FORBIDDEN', message: 'history intent needs an accepted session subscription' };
    state.expanded = [...new Set(refs.map(ref => ref.key.replace(/^preview-/, '')))];
    state.version++;
    return { ok: true, result: true };
  }
  return { ready, begin, finish, changed, forget, capture, current, acceptPatch, invalidate, intent,
    pending: token => !!token && stateFor(token.deviceId, token.sessionId) === token.state && token.state.pending === token,
    expandedFor: (deviceId, sessionId) => [...(stateFor(deviceId, sessionId)?.expanded ?? [])],
    clear: () => controllers.clear() };
}
