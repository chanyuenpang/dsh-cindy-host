import { queueItemsFromInbox } from './host-input-queue.js';

/** Event-driven repair, not a poller. Failed/stale reads never erase known input. */
export function createNativeInboxRefresh({ getReader, version, current = () => true, adopt, publish, onError = () => {} }) {
  const flights = new Map();
  function refresh(sessionId, notify = false) {
    if (typeof sessionId !== 'string' || !sessionId || !current()) return Promise.resolve(false);
    const pending = flights.get(sessionId);
    if (pending) { pending.again ||= notify; pending.notify ||= notify; return pending.promise; }
    const state = { again: false, notify, promise: null };
    flights.set(sessionId, state);
    state.promise = (async () => {
      let applied = false;
      do {
        state.again = false;
        const read = getReader();
        if (typeof read !== 'function') break;
        const stamp = version(sessionId);
        let snapshot;
        try { snapshot = await read(sessionId); }
        catch (error) { onError(error); continue; }
        if (!current() || stamp !== version(sessionId) || read !== getReader()) continue;
        const inbox = snapshot?.inbox;
        if (!inbox || typeof inbox !== 'object' ||
          !Array.isArray(inbox['next-turn']) || !Array.isArray(inbox['next-step'])) continue;
        adopt(sessionId, queueItemsFromInbox(inbox)); applied = true;
        if (state.notify) publish(sessionId);
      } while (state.again && current());
      return applied;
    })().catch(error => { onError(error); return false; }).finally(() => { if (flights.get(sessionId) === state) flights.delete(sessionId); });
    return state.promise;
  }
  return { refresh };
}
