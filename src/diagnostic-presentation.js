import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
const unavailable = message => Object.assign(new Error(message), { code: 'NOT_AVAILABLE' });
export const EMPTY_INTERRUPTION = Object.freeze({ activeTurnStartedAt: null, interruptedTurnStartedAt: null, lastTurnEndedAt: null, clearedAt: null });

/** Presentation identities use the original turn/start, never a synthetic closer. */
export function nativeInterruption(sessionId, start, end, priorEndedAt) {
  if (end?.data?.reason?.kind !== 'interrupted' || !Number.isSafeInteger(start?.data?.turn) || start.data.turn < 0 || start?.data?.turn !== end?.data?.turn
    || !Number.isSafeInteger(end.seq) || end.seq <= start?.seq || !Number.isFinite(end.time)
    || !Number.isSafeInteger(start?.seq) || start.seq < 0 || !Number.isFinite(start.time) || start.time <= 0
    || (Number.isFinite(priorEndedAt) && priorEndedAt >= start.time)) return null;
  return { id: `${sessionId}:interrupted:${start.seq}:${start.time}:${start.data.turn}`,
    startedAt: start.time, priorEndedAt: Number.isFinite(priorEndedAt) ? priorEndedAt : null };
}
export function advanceInterruptionMetadata(state, event, sessionId) {
  const previous = state ?? { start: null, priorEndedAt: null, interruption: null };
  if (event?.type === 'turn/start') return { ...previous, start: { seq: event.seq, time: event.time, data: { turn: event.data?.turn } }, interruption: null };
  if (event?.type !== 'turn/end') return previous;
  return { ...previous, interruption: nativeInterruption(sessionId, previous.start, event, previous.priorEndedAt),
    priorEndedAt: event.data?.reason?.kind === 'interrupted' ? previous.priorEndedAt : Number.isFinite(event.time) ? event.time : previous.priorEndedAt };
}
export function diagnosticOwner(namespace, profile = '') {
  return typeof namespace === 'string' && namespace ? hash(`${profile}|${namespace}`) : null;
}
export function preferenceHas(data, owner, sid, kind, id) {
  return Boolean(owner && data?.[owner]?.[hash(sid)]?.[kind]?.[hash(id)] === true);
}
export function interruptionFields(candidate, running, hidden, data, owner, sid) {
  if (!candidate || running || hidden || preferenceHas(data, owner, sid, 'interruptions', candidate.id)) return { ...EMPTY_INTERRUPTION };
  return { activeTurnStartedAt: candidate.startedAt, interruptedTurnStartedAt: candidate.startedAt, lastTurnEndedAt: candidate.priorEndedAt, clearedAt: null };
}
export function projectDismissedErrors(rows, data, owner) {
  return rows.map(row => row?.role === 'error' && preferenceHas(data, owner, row.sessionId, 'errors', row.clientId)
    ? { ...row, content: { ...row.content, dismissed: true } } : row);
}

/** One transactional settings owner; no optimistic mirror of error/turn facts.
 * Leaf writes preserve other grants/preferences. Revision conflicts are retried
 * from describe, and successful writes are verified by authoritative readback. */
export function diagnosticPreferenceStore(settings, ns) {
  function describe() {
    if (typeof settings?.describe !== 'function' || typeof settings?.mutate !== 'function') throw unavailable('Diagnostic preferences require revisioned native settings');
    const entry = settings.describe().find(entry => entry.ns === ns);
    if (!entry || !Number.isSafeInteger(entry.revision)) throw unavailable('Diagnostic settings namespace is unavailable');
    return entry;
  }
  return {
    snapshot() { try { return describe().value?.diagnosticPresentationV1 ?? {}; } catch { return {}; } },
    async commit({ owner, sessionId, kind, id }, valid = () => true) {
      if (!owner || !['interruptions', 'errors'].includes(kind)) throw unavailable('No authenticated diagnostic preference owner');
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!valid()) throw unavailable('Diagnostic action scope changed');
        const entry = describe();
        if (preferenceHas(entry.value?.diagnosticPresentationV1, owner, sessionId, kind, id)) return;
        try {
          await settings.mutate(ns, [{ op: 'set', path: ['diagnosticPresentationV1', owner, hash(sessionId), kind, hash(id)], value: true }], entry.revision);
        } catch (error) { if (error?.code === 'SETTINGS_CONFLICT') continue; throw error; }
        if (!valid()) throw unavailable('Diagnostic action completed in an expired scope');
        if (!preferenceHas(describe().value?.diagnosticPresentationV1, owner, sessionId, kind, id)) throw unavailable('Diagnostic preference was not committed');
        return;
      }
      throw unavailable('Diagnostic settings changed concurrently; retry the action');
    },
  };
}
