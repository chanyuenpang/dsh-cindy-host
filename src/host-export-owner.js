import { randomUUID } from 'node:crypto';
import { refreshOwnedCredential } from './auth-session.js';

/** Verified socket identity and private credential leases. Neither is a relay generation. */
export function createExportOwner({ refresh = refreshOwnedCredential, ports = {}, now = Date.now, cooldownMs = 30_000, onSession = () => {}, onInvalidate = () => {} } = {}) {
  const runtimeId = randomUUID();
  const leases = new WeakMap();
  let epoch = 0;
  let owner = null;
  let credential = null;
  let revision = 0;
  let pending = null;
  let refreshedAt = -Infinity;
  const current = (captured) => captured != null && captured === owner;
  function invalidate() {
    pending?.controller.abort();
    epoch += 1;
    owner = null;
    credential = null;
    revision += 1;
    try { onInvalidate(); } catch { /* diagnostics/consumers must not retain authority */ }
  }
  function install(session) {
    const lease = Object.freeze({});
    const next = Object.freeze({ lease, session: Object.freeze({ ...session }) });
    leases.set(lease, { owner, revision: ++revision });
    credential = next;
    return next;
  }
  function bind({ realm, userId, session }) {
    if (typeof userId !== 'string' || !userId || typeof realm !== 'string' || !realm || !session) { invalidate(); return null; }
    if (owner && (owner.realm !== realm || owner.userId !== userId)) invalidate();
    if (!owner) owner = Object.freeze({ runtimeId, epoch: ++epoch, realm, userId });
    install(session);
    return owner;
  }
  function refreshCredential(captured) {
    const record = captured?.lease && leases.get(captured.lease);
    if (!record || !current(record.owner) || credential !== captured || record.revision !== revision) return Promise.resolve(null);
    if (pending?.captured === captured) return pending.promise;
    // Never join a refresh for another lease, nor launch overlapping token rotations.
    if (pending || Number(now()) - refreshedAt < cooldownMs) return Promise.resolve(null);
    refreshedAt = Number(now());
    const isCurrent = () => current(record.owner) && credential === captured && revision === record.revision;
    const controller = new AbortController();
    const promise = (async () => {
      try {
        const result = await refresh(captured.session, { ...ports, isCurrent, signal: controller.signal });
        if (!result?.ok || !isCurrent()) return null;
        const next = install(result.session);
        onSession(next.session);
        return next;
      } catch { return null; }
    })();
    const flight = { captured, promise, controller };
    pending = flight;
    void promise.finally(() => { if (pending === flight) pending = null; }).catch(() => {});
    return promise;
  }
  return { bind, invalidate, capture: () => owner, isCurrent: current,
    getCredential: (captured) => current(captured) ? credential : null, refreshCredential };
}
