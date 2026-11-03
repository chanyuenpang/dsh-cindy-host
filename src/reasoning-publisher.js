import { createReasoningStream } from './reasoning-stream.js';

/** Coalesce token-sized updates; a final message synchronously retires its preview. */
export function createReasoningPublisher({ push, invalidate, watched,
  setTimeout: schedule = setTimeout, clearTimeout: cancel = clearTimeout, intervalMs = 100 }) {
  const sessions = new Map();

  function drop(sessionId) {
    const state = sessions.get(sessionId);
    if (state?.timer !== null && state?.timer !== undefined) cancel(state.timer);
    sessions.delete(sessionId);
  }

  function flush(sessionId, state) {
    if (state.timer !== null) cancel(state.timer);
    state.timer = null;
    if (!watched(sessionId)) { drop(sessionId); return; }
    const ids = new Set(state.rows.map(row => row.clientId));
    const removed = [...state.known].filter(id => !ids.has(id));
    if (removed.length > 0) push(sessionId, 'local-db:messages:deleted', { sessionId, clientIds: removed });
    for (const message of state.rows) push(sessionId, 'local-db:messages:created', { sessionId, message });
    state.known = ids;
    invalidate(sessionId);
    if (state.rows.length === 0) drop(sessionId);
  }

  function noteEvent(sessionId, event, cached = {}) {
    if (!watched(sessionId)) { drop(sessionId); return; }
    let state = sessions.get(sessionId);
    if (!state) {
      if (event?.type !== 'assistant/chunk' && !(cached.before?.length > 0)) return;
      state = { stream: createReasoningStream(sessionId), rows: [], known: new Set(), timer: null };
      sessions.set(sessionId, state);
    }
    // A controller can open the session mid-block and read its preview before this
    // publisher sees any chunks. Include those cached identities when retiring it.
    for (const row of cached.before ?? []) state.known.add(row.clientId);
    const changed = state.stream.consume(event);
    const next = cached.after ?? state.stream.rows();
    if (!changed && next.length === 0 && state.known.size === 0) { drop(sessionId); return; }
    if (!changed && event?.type !== 'assistant/message' && event?.type !== 'turn/end' && event?.type !== 'step/end') return;
    state.rows = next;
    const immediate = event?.type !== 'assistant/chunk' || event.data?.chunk?.type === 'block-end';
    if (immediate) flush(sessionId, state);
    else if (state.timer === null) {
      state.timer = schedule(() => flush(sessionId, state), intervalMs);
      state.timer?.unref?.();
    }
  }

  function clear() { for (const sessionId of sessions.keys()) drop(sessionId); }
  return { noteEvent, clear };
}
