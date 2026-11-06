import { createHash } from 'node:crypto';
import { createReasoningStream } from './reasoning-stream.js';

export const REASONING_INTERVAL_MS = 1000;
export const REASONING_RATE_BYTES = 32 * 1024;
export const REASONING_BURST_BYTES = 64 * 1024;
export const REASONING_SNAPSHOT_BYTES = 64 * 1024;

/** Latest-wins interim snapshots. Full bodies remain readable; terminal deletion never waits. */
export function createReasoningPublisher({ push, invalidate, watched, rawNeeded = watched,
  setTimeout: schedule = setTimeout, clearTimeout: cancel = clearTimeout, now = Date.now,
  intervalMs = REASONING_INTERVAL_MS, rateBytes = REASONING_RATE_BYTES,
  burstBytes = REASONING_BURST_BYTES, maxSnapshotBytes = REASONING_SNAPSHOT_BYTES }) {
  const sessions = new Map();

  function drop(sessionId) {
    const state = sessions.get(sessionId);
    if (state?.timer !== null && state?.timer !== undefined) cancel(state.timer);
    sessions.delete(sessionId);
  }
  function later(sessionId, state, delay = intervalMs) {
    if (state.timer !== null) return;
    state.timer = schedule(() => flush(sessionId, state), delay);
    state.timer?.unref?.();
  }
  function flush(sessionId, state) {
    if (state.timer !== null) cancel(state.timer);
    state.timer = null;
    if (sessions.get(sessionId) !== state) return;
    if (!watched(sessionId)) { drop(sessionId); return; }
    const ids = new Set(state.rows.map(row => row.clientId));
    const removed = [...state.known].filter(id => !ids.has(id));
    if (removed.length) push(sessionId, 'local-db:messages:deleted', { sessionId, clientIds: removed });
    for (const id of removed) state.sent.delete(id);
    state.known = ids;
    const clock = now();
    state.tokens = Math.min(burstBytes, state.tokens + Math.max(0, clock - state.tokenAt) * rateBytes / 1000);
    state.tokenAt = clock;
    let retryMs = 0;
    if (rawNeeded(sessionId)) for (const message of state.rows) {
      const payload = { sessionId, message };
      const serialized = JSON.stringify(payload);
      const stamp = createHash('sha256').update(serialized).digest('hex');
      if (state.sent.get(message.clientId) === stamp) continue;
      const bytes = Buffer.byteLength(serialized, 'utf8');
      // Do not cut an interim prefix and label it full content. A page/explicit details
      // (or the durable final row) owns delivery of unusually large reasoning bodies.
      if (bytes > maxSnapshotBytes || bytes > burstBytes) continue;
      if (bytes > state.tokens) { retryMs = Math.max(retryMs, Math.ceil((bytes - state.tokens) * 1000 / rateBytes)); continue; }
      push(sessionId, 'local-db:messages:created', payload);
      state.tokens -= bytes;
      state.sent.set(message.clientId, stamp);
    }
    invalidate(sessionId);
    if (!state.rows.length) drop(sessionId);
    else if (retryMs > 0) later(sessionId, state, Math.max(intervalMs, retryMs));
  }

  function noteEvent(sessionId, event, cached = {}) {
    if (!watched(sessionId)) { drop(sessionId); return; }
    let state = sessions.get(sessionId);
    if (!state) {
      if (event?.type !== 'assistant/chunk' && !(cached.before?.length > 0)) return;
      state = { stream: createReasoningStream(sessionId), rows: [], known: new Set(), sent: new Map(),
        timer: null, tokens: burstBytes, tokenAt: now() };
      sessions.set(sessionId, state);
    }
    for (const row of cached.before ?? []) state.known.add(row.clientId);
    const changed = state.stream.consume(event);
    const next = cached.after ?? state.stream.rows();
    if (!changed && !next.length && !state.known.size) { drop(sessionId); return; }
    if (!changed && !['assistant/message', 'turn/end', 'step/end'].includes(event?.type)) return;
    state.rows = next;
    const immediate = event?.type !== 'assistant/chunk' || event.data?.chunk?.type === 'block-end';
    if (immediate) flush(sessionId, state);
    else later(sessionId, state);
  }
  function clear() { for (const sessionId of sessions.keys()) drop(sessionId); }
  return { noteEvent, clear };
}
