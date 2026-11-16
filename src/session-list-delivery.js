/** Bounded, disposable list-state delivery, not a reliable event log.
 * send=true is local socket acceptance, never a client application receipt.
 */
export function createSessionListDelivery({
  stamp, eligible, send, reseedValidated = () => false, now = () => Date.now(),
  setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random,
  mergeMs = 250, intervalMs = 60_000, maxPeers = 128, maxRows = 128, maxBytes = 1024 * 1024,
}) {
  const peers = new Map(); let timer = null, stopped = false, pendingBytes = 0;
  const stats = { sent: 0, retries: 0, overflow: 0, reseeds: 0, compatibilityBlocked: 0, staleDropped: 0 };
  function forget(id) { pendingBytes -= peers.get(id)?.bytes ?? 0; peers.delete(id); }
  function ensure(id) {
    if (stopped || !eligible(id)) { forget(id); return null; }
    const scope = stamp(id); if (scope == null) return null;
    let peer = peers.get(id);
    if (peer?.scope !== scope) {
      if (peer) { stats.staleDropped++; forget(id); }
      if (!peer && peers.size >= maxPeers) { stats.overflow++; return null; }
      peer = { scope, patches: new Map(), sizes: new Map(), bytes: 0, activities: new Map(), created: new Set(), dirty: false, due: now() + mergeMs,
        periodic: now() + intervalMs + Math.floor(random() * Math.min(5000, intervalMs / 10)) };
      peers.set(id, peer);
    }
    return peer;
  }
  function current(id, peer) { return !stopped && peers.get(id) === peer && eligible(id) && stamp(id) === peer.scope; }
  function write(id, peer, channel, payload) {
    if (!current(id, peer)) { forget(id); stats.staleDropped++; return false; }
    try {
      if (send(id, channel, payload) === true) { stats.sent++; return true; }
    } catch { /* State remains pending; no unhandled timer errors. */ }
    stats.retries++; return false;
  }
  function qualified(id) { try { return reseedValidated(id) === true; } catch { return false; } }
  function dirty(id, peer) {
    if (!qualified(id)) { stats.compatibilityBlocked++; return; }
    peer.dirty = true;
  }
  function schedule() {
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (stopped || !peers.size) return;
    let due = Infinity;
    for (const [id, peer] of peers) {
      if (!current(id, peer)) { forget(id); continue; }
      if (peer.patches.size || peer.activities.size || peer.created.size || peer.dirty) due = Math.min(due, peer.due);
      if (qualified(id)) due = Math.min(due, peer.periodic);
    }
    if (!Number.isFinite(due)) return;
    timer = setTimer(() => { timer = null; flush(); }, Math.max(1, due - now()));
    timer?.unref?.();
  }
  function flush() {
    const at = now();
    for (const [id, peer] of peers) {
      if (!current(id, peer)) { forget(id); continue; }
      if (at >= peer.periodic && qualified(id)) {
        peer.dirty = true;
        peer.periodic = at + intervalMs + Math.floor(random() * Math.min(5000, intervalMs / 10));
      }
      if (at < peer.due) continue;
      let budget = 8;
      const failures = stats.retries;
      for (const sessionId of peer.created) {
        if (budget-- <= 0) break;
        if (!write(id, peer, 'local-db:sessions:created', { sessionId })) break;
        peer.created.delete(sessionId);
      }
      for (const [sessionId, patch] of peer.patches) {
        if (budget-- <= 0) break;
        if (!write(id, peer, 'local-db:sessions:patched', { sessionId, patch })) break;
        if (peer.patches.get(sessionId) === patch) {
          const bytes = peer.sizes.get(sessionId) ?? 0; peer.bytes -= bytes; pendingBytes -= bytes;
          peer.sizes.delete(sessionId); peer.patches.delete(sessionId);
        }
      }
      for (const [sessionId, payload] of peer.activities) {
        if (budget-- <= 0) break;
        if (!write(id, peer, 'local-db:sessions:activity', payload)) break;
        if (peer.activities.get(sessionId) === payload) peer.activities.delete(sessionId);
      }
      if (peer.dirty && budget > 0 && qualified(id)
        && write(id, peer, 'local-db:sessions:created', {})) { peer.dirty = false; stats.reseeds++; }
      peer.due = at + (stats.retries > failures ? Math.max(mergeMs, 1000) : mergeMs);
    }
    schedule();
  }
  return {
    subscribe(id) { const peer = ensure(id); if (peer) dirty(id, peer); schedule(); },
    recover(id) { const peer = ensure(id); if (peer) { dirty(id, peer); peer.due = now(); } schedule(); },
    reseed(ids = peers.keys()) { for (const id of ids) { const peer = ensure(id); if (peer) dirty(id, peer); } schedule(); },
    created(ids, sessionId) {
      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 512) return;
      for (const id of ids) {
        const peer = ensure(id); if (!peer) continue;
        if (peer.created.size >= maxRows) { stats.overflow++; dirty(id, peer); }
        else peer.created.add(sessionId);
      }
      schedule();
    },
    activity(ids, payload) {
      for (const id of ids) {
        const peer = ensure(id); if (!peer) continue;
        if (peer.activities.size >= maxRows && !peer.activities.has(payload.sessionId)) { stats.overflow++; dirty(id, peer); continue; }
        peer.activities.set(payload.sessionId, payload);
        if (write(id, peer, 'local-db:sessions:activity', payload) && peer.activities.get(payload.sessionId) === payload) peer.activities.delete(payload.sessionId);
      }
      schedule();
    },
    patch(ids, sessionId, fields, barrier = false) {
      for (const id of ids) {
        const peer = ensure(id); if (!peer) continue;
        if (fields.status === 'archived' || fields.status === 'deleted') peer.activities.delete(sessionId);
        const patch = { ...peer.patches.get(sessionId), ...fields };
        const bytes = Buffer.byteLength(JSON.stringify(patch));
        const previousBytes = peer.sizes.get(sessionId) ?? 0;
        if (pendingBytes - previousBytes + bytes > maxBytes || peer.patches.size >= maxRows && !peer.patches.has(sessionId)) {
          stats.overflow++; dirty(id, peer); continue;
        }
        peer.bytes += bytes - previousBytes; pendingBytes += bytes - previousBytes;
        peer.patches.set(sessionId, patch); peer.sizes.set(sessionId, bytes);
        if (barrier && write(id, peer, 'local-db:sessions:patched', { sessionId, patch }) && peer.patches.get(sessionId) === patch) {
          peer.bytes -= bytes; pendingBytes -= bytes; peer.sizes.delete(sessionId); peer.patches.delete(sessionId);
        }
      }
      schedule();
    },
    forget(id) { forget(id); schedule(); },
    clear() { peers.clear(); pendingBytes = 0; if (timer !== null) clearTimer(timer); timer = null; },
    stop() { stopped = true; this.clear(); },
    diagnostics() { return { ...stats, peers: peers.size, pendingBytes, pending: [...peers.values()].reduce((n, peer) => n + peer.patches.size + peer.activities.size + peer.created.size + Number(peer.dirty), 0) }; },
    flush,
  };
}
