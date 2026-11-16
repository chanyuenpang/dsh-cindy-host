/** A single, disposable SessionListView. Native services remain the fact owners.
 * Subscribe before any baseline; snapshots, exact reads and row notifications use
 * collection/row/domain cut fences. No result TTL, stale-success or corpus transcript warm.
 */
const ordinary = item => item && typeof item === 'object' && item.origin !== 'subagent';
const visible = item => ordinary(item) && item.blank !== true;
const failure = message => Object.assign(new Error(message), { code: 'NOT_AVAILABLE' });
const clone = value => structuredClone(value);
const byActivity = (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || String(b.id).localeCompare(String(a.id));
function coreSignature(item) {
  const { values = {}, ...provenance } = item.projections ?? {};
  return JSON.stringify({ id: item.sessionId, createdAt: item.createdAt, updatedAt: item.updatedAt,
    running: item.running, blank: item.blank, cwd: item.cwd, origin: item.origin,
    projections: { ...provenance, values: { title: values.title, sessionListMetadata: values.sessionListMetadata,
      modelSelection: values.modelSelection, permissions: values.permissions } } });
}

/** Optional enrichment has its own version; it must not invalidate core reads. */
export const listEventAffectsCore = event => event?.kind !== 'evidence';

/** Select after status/pin overlays, before expensive evidence reads. */
export function selectSessionRows(rows, { limit, status, includePinned } = {}) {
  const matching = rows.filter(row => status === 'active' || status === 'archived'
    ? (row.status ?? 'active') === status : row.status !== 'deleted').sort(byActivity);
  if (limit === undefined) return matching;
  const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(1000, Math.floor(Number(limit))) : 20;
  const recent = matching.slice(0, cap);
  const ids = new Set(recent.map(row => row.id));
  return includePinned === true ? [...recent, ...matching.filter(row => row.pinnedAt != null && !ids.has(row.id))] : recent;
}

export function createSessionControllerSource({
  sessionController, subscribe, readTitles, readSessionMeta, readActivityEvidence,
  readSessionSummary, readActiveSessions, strictCore = typeof readSessionSummary === 'function',
  listTimeoutMs = 5_000, titleRefreshBudget = 16, evidenceConcurrency = 2,
  evidenceCacheSize = 1024, now = () => Date.now(),
}) {
  if (!sessionController) throw new Error('createSessionControllerSource requires sessionController');
  evidenceConcurrency = Math.min(2, Math.max(1, Math.floor(evidenceConcurrency) || 2));
  evidenceCacheSize = Math.min(1024, Math.max(1, Math.floor(evidenceCacheSize) || 1024));
  const rows = new Map();
  const signatures = new Map();
  const dirty = new Map();
  const repaired = new Map();
  const demanded = new Set();
  const headers = new Map();
  const knownIds = new Set();
  const nonTaskIds = new Set();
  // Explicit native format scope, not an operational-error/absence cache.
  const migrationRequired = new Set();
  const evidence = new Map();
  const evidenceVersions = new Map();
  const evidenceQueue = new Map();
  const evidenceFlights = new Map();
  const rowFlights = new Map();
  const changes = new Set();
  const lifecycle = new Set();
  let viewRevision = 0, enrichmentRevision = 0;
  let epoch = 0, catalogRevision = 0, coreGeneration = 0, disposed = false, listFlight = null, repairFlight = null, initialized = false;
  let catalogTail = Promise.resolve(), coreActive = 0;
  const coreQueue = [];
  function coreSlot() {
    return new Promise((resolve, reject) => {
      const enter = () => {
        if (disposed) { reject(failure('Session list source was disposed')); return; }
        coreActive++;
        resolve(() => { coreActive--; coreQueue.shift()?.enter(); });
      };
      if (coreActive < 2) enter();
      else if (coreQueue.length < 128) coreQueue.push({ enter, reject });
      else reject(failure('Session core repair is at capacity; retry synchronization'));
    });
  }
  let evidenceWorkers = 0, retryTimer = null, repairTimer = null, repairBackoff = 1000;
  const stats = { coverage: 'cold', reads: 0, exactReads: 0, rejectedVersions: 0, evidenceReads: 0,
    evidenceErrors: 0, staleServes: 0, lastStaleReason: null, lastListedAt: null, lastListedCount: null,
    activeStateReads: 0, activeStateFallbacks: 0, lastActiveStateError: null, lastError: null };
  const version = id => dirty.get(id) ?? 0;
  const evidenceVersion = id => evidenceVersions.get(id) ?? 0;
  const requireOpen = () => { if (disposed) throw failure('Session list source was disposed'); };
  function emit(listeners, event) {
    for (const listener of listeners) {
      try { Promise.resolve(listener(event)).catch(() => {}); } catch { /* Never break a native append. */ }
    }
  }
  function notify(event) {
    if (listEventAffectsCore(event)) viewRevision++; else enrichmentRevision++;
    emit(changes, event);
  }
  function bump(id) {
    epoch++;
    if (id) {
      if (!knownIds.has(id)) { knownIds.add(id); catalogRevision++; }
      dirty.set(id, version(id) + 1); signatures.delete(id);
    } else { catalogRevision++; coreGeneration++; signatures.clear(); repaired.clear(); }
  }
  function rowVisible(row) {
    return row && !migrationRequired.has(row.id) && row.blank !== true && (typeof readTitles !== 'function' && !strictCore || typeof row.title === 'string' && row.title.trim() !== '');
  }
  function commit(id, row, stamp) {
    requireOpen();
    if (version(id) !== stamp) { stats.rejectedVersions++; throw failure('Session changed during list observation'); }
    const previous = rows.get(id);
    if (row === undefined) rows.delete(id); else rows.set(id, row);
    if (JSON.stringify(previous) !== JSON.stringify(row)) notify({ kind: 'row', sessionId: id,
      row: row && clone(row), previous: previous && clone(previous), discovered: !rowVisible(previous) && rowVisible(row),
      initial: !initialized, version: stamp });
    return row;
  }
  async function metadata(items) {
    const missing = items.filter(item => !Number.isFinite(item.createdAt) && !headers.has(String(item.sessionId))).map(item => String(item.sessionId));
    if (missing.length && typeof readSessionMeta === 'function') {
      const values = await readSessionMeta(missing);
      requireOpen();
      for (const [id, value] of values ?? []) headers.set(id, value);
    }
  }
  async function project(item, title) {
    if (!ordinary(item)) return undefined;
    const id = String(item.sessionId);
    const meta = headers.get(id);
    const created = Number.isFinite(item.createdAt) ? item.createdAt : Date.parse(meta?.createdAt);
    const values = item.projections?.values ?? {};
    const listMeta = values.sessionListMetadata;
    if (strictCore && (!Number.isFinite(created) || typeof listMeta?.blank !== 'boolean'
      || !Object.hasOwn(values, 'title'))) throw failure('Native session core projections are not available');
    const updated = listMeta ? Math.max(created, listMeta.lastPromptAt ?? 0) : item.updatedAt;
    if (strictCore && !Number.isFinite(updated)) throw failure('Native session activity time is unavailable');
    // Legacy fixture sources have no immutable headers. Production opts into strictCore.
    const at = new Date(Number.isFinite(updated) ? updated : 0).toISOString();
    const selection = values.modelSelection?.next ?? values.modelSelection?.lastUsed;
    const permission = values.permissions?.currentValue;
    return { id, title: Object.hasOwn(values, 'title') ? values.title : title,
      running: item.running === true, updatedAt: at, lastActivityAt: at,
      createdAt: Number.isFinite(created) ? new Date(created).toISOString() : at,
      cwd: item.cwd ?? meta?.cwd ?? null, blank: listMeta?.blank ?? item.blank === true,
      ...(selection?.model ? { model: selection.model } : {}),
      ...(selection?.provider ? { providerId: selection.provider } : {}),
      ...(selection?.reasoningEffort ? { effort: selection.reasoningEffort } : {}),
      ...(permission ? { permissionMode: permission } : {}) };
  }
  async function exact(id, seed, force = false) {
    const stamp = version(id), generation = coreGeneration;
    const existing = rowFlights.get(id);
    if (!force && existing?.stamp === stamp && existing.generation === generation) return existing.promise;
    const flight = { stamp, generation, promise: null };
    flight.promise = (async () => {
      let item = seed;
      if (typeof readSessionSummary === 'function') {
        const release = await coreSlot();
        try {
          if (generation !== coreGeneration || stamp !== version(id)) throw failure('Session changed before core repair');
          stats.exactReads++; item = await readSessionSummary(id);
        } finally { release(); }
      }
      else if (strictCore) throw failure('Exact native session observations are unavailable');
      requireOpen();
      if (generation !== coreGeneration) throw failure('Session list scope changed during observation');
      if (item == null || !ordinary(item)) { repaired.set(id, stamp); return commit(id, undefined, stamp); }
      if (String(item.sessionId) !== id) throw failure('Native session observation identity mismatch');
      if (!strictCore) await metadata([item]);
      let title;
      if (!strictCore && !Object.hasOwn(item.projections?.values ?? {}, 'title') && typeof readTitles === 'function') {
        title = (await readTitles([id]))?.get(id);
      }
      const row = await project(item, title);
      if (generation !== coreGeneration) throw failure('Session list scope changed during observation');
      const result = commit(id, row, stamp); repaired.set(id, stamp);
      return result;
    })();
    rowFlights.set(id, flight);
    try { return await flight.promise; }
    finally { if (rowFlights.get(id) === flight) rowFlights.delete(id); }
  }
  async function verifyRow(id, seed) {
    // A row changing while observed needs a new exact cut, not a corpus scan.
    for (let attempt = 0; attempt < 8; attempt++) {
      requireOpen(); const stamp = version(id), generation = coreGeneration;
      if (attempt && typeof readSessionSummary !== 'function') {
        const value = await sessionController.list({}, AbortSignal.timeout(listTimeoutMs));
        seed = value?.items?.find(item => String(item.sessionId) === id);
      }
      try {
        const row = await exact(id, seed);
        if (generation !== coreGeneration) throw failure('Session list scope changed during observation');
        if (stamp !== version(id)) continue;
        return { row, stamp, generation };
      } catch (error) {
        if (disposed || generation !== coreGeneration || stamp === version(id)) throw error;
      }
    }
    throw failure('Session is changing during core repair');
  }
  async function settleRows(items) {
    const seeds = new Map(items.map(item => [String(item.sessionId), item]));
    for (let pass = 0; pass < 8; pass++) {
      const ids = new Set([...seeds.keys(), ...rows.keys()]);
      const pending = [...ids].filter(id => !migrationRequired.has(id) && repaired.get(id) !== version(id));
      if (!pending.length) return;
      for (let index = 0; index < pending.length; index += 2) {
        await Promise.all(pending.slice(index, index + 2).map(id => verifyRow(id, seeds.get(id))));
      }
    }
    throw failure('Session core changed repeatedly; synchronize again');
  }
  // Evidence is an independently versioned scalar memo, never a prerequisite for a list.
  function queueEvidence(ids) {
    if (typeof readActivityEvidence !== 'function' || disposed) return;
    for (const id of ids) {
      demanded.delete(id); demanded.add(id);
      while (demanded.size > evidenceCacheSize) demanded.delete(demanded.values().next().value);
    }
    for (const id of ids) if (!evidence.has(id) && !evidenceQueue.has(id) && !evidenceFlights.has(id) && evidenceQueue.size < evidenceCacheSize) {
      evidenceQueue.set(id, { stamp: evidenceVersion(id), attempts: 0, due: 0 });
    }
    pumpEvidence();
  }
  function pumpEvidence() {
    if (disposed) return;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    while (evidenceWorkers < evidenceConcurrency) {
      const next = [...evidenceQueue].find(([, job]) => job.due <= now());
      if (!next) break;
      const [id, job] = next; evidenceQueue.delete(id);
      evidenceWorkers++; stats.evidenceReads++;
      const work = Promise.resolve().then(() => readActivityEvidence(id)).then(value => {
        if (disposed || job.stamp !== evidenceVersion(id)) return;
        if (!Number.isSafeInteger(value?.messageCount) || value.messageCount < 0
          || !(value.userSendAt === null || typeof value.userSendAt === 'string' && Number.isFinite(Date.parse(value.userSendAt)))) throw failure('Invalid activity evidence');
        const scalar = { messageCount: Math.floor(value.messageCount), userSendAt: value.userSendAt,
          ...(Object.hasOwn(value, 'interruption') ? { interruption: clone(value.interruption) } : {}) };
        const previousEvidence = evidence.get(id);
        evidence.delete(id); evidence.set(id, scalar);
        while (evidence.size > evidenceCacheSize) evidence.delete(evidence.keys().next().value);
        const row = rows.get(id);
        if (row) notify({ kind: 'evidence', sessionId: id, row: clone({ ...row, ...scalar }),
          previous: clone({ ...row, ...previousEvidence }), version: version(id) });
      }).catch(() => {
        if (disposed || job.stamp !== evidenceVersion(id)) return;
        stats.evidenceErrors++;
        if (job.attempts < 3) evidenceQueue.set(id, { ...job, attempts: job.attempts + 1, due: now() + 1000 * 2 ** job.attempts });
      }).finally(() => {
        evidenceWorkers--; evidenceFlights.delete(id);
        if (!disposed && job.stamp !== evidenceVersion(id) && demanded.has(id)) queueEvidence([id]);
        pumpEvidence();
      });
      evidenceFlights.set(id, work);
    }
    if (evidenceQueue.size && evidenceWorkers < evidenceConcurrency) {
      const due = Math.min(...[...evidenceQueue.values()].map(job => job.due));
      retryTimer = setTimeout(() => { retryTimer = null; pumpEvidence(); }, Math.max(1, due - now()));
      retryTimer.unref?.();
    }
  }
  function invalidateEvidence(id) {
    if (!demanded.has(id) && !evidence.has(id) && !evidenceFlights.has(id)) return false;
    const had = evidence.delete(id);
    evidenceVersions.set(id, evidenceVersion(id) + 1); evidenceQueue.delete(id);
    return had;
  }
  async function baseline() {
    requireOpen(); stats.coverage = 'rebuilding';
    const stamp = catalogRevision;
    stats.reads++;
    const value = await sessionController.list({}, AbortSignal.timeout(listTimeoutMs));
    requireOpen();
    if (!Array.isArray(value?.items)) throw failure('Native session catalog is unavailable');
    for (const item of value.items) if (typeof item?.sessionId === 'string') {
      knownIds.add(item.sessionId);
      if (ordinary(item)) nonTaskIds.delete(item.sessionId); else nonTaskIds.add(item.sessionId);
    }
    const catalogItems = value.items.filter(ordinary);
    const unsupported = new Set(catalogItems.filter(item => item.formatStatus === 'migration-required').map(item => String(item.sessionId)));
    if (unsupported.size !== migrationRequired.size || [...unsupported].some(id => !migrationRequired.has(id))) {
      const changedIds = new Set([...unsupported].filter(id => !migrationRequired.has(id))
        .concat([...migrationRequired].filter(id => !unsupported.has(id))));
      migrationRequired.clear(); for (const id of unsupported) migrationRequired.add(id);
      for (const id of changedIds) {
        bump(id); // Scope transitions fence in-flight cuts too.
        if (!unsupported.has(id)) rows.delete(id); // Readmission requires a fresh core and discovery notification.
      }
      notify({ kind: 'scope', migrationRequired: migrationRequired.size });
    }
    // Only an explicit native migration-required declaration is out of scope.
    // Current-format I/O/replay errors still fail coverage; never swallow them.
    const items = catalogItems.filter(item => item.formatStatus !== 'migration-required');
    if (!strictCore) await metadata(items);
    // Exact native observations already carry immutable headers; do not scan the
    // persistent corpus a second time merely to decorate controller summaries.
    // Necessary core repair survives a caller timeout. Validated progress stays in rows.
    for (let index = 0; index < items.length; index += Math.max(1, evidenceConcurrency)) {
      await Promise.all(items.slice(index, index + Math.max(1, evidenceConcurrency)).map(async item => {
        const id = String(item.sessionId);
        const signature = coreSignature(item);
        if (rows.has(id) && signatures.get(id) === signature) return;
        const cut = await verifyRow(id, item);
        if (!disposed && cut.generation === coreGeneration && version(id) === cut.stamp) signatures.set(id, signature);
      }));
    }
    if (stamp !== catalogRevision) { stats.rejectedVersions++; throw failure('Session catalog changed during observation'); }
    const ids = new Set(catalogItems.map(item => String(item.sessionId)));
    for (const id of [...rows.keys()]) if (!ids.has(id) && rowVisible(rows.get(id))) {
      // Catalog absence alone is not proof of deletion (drafts/visibility can
      // differ). Confirm by exact identity and fence older observations first.
      bump(id); await verifyRow(id);
      if (!rows.has(id)) {
        invalidateEvidence(id); demanded.delete(id); evidenceQueue.delete(id); headers.delete(id);
      }
    }
    await settleRows(items);
    if (stamp !== catalogRevision) { stats.rejectedVersions++; throw failure('Session catalog changed during core repair'); }
    stats.coverage = 'ready'; stats.lastError = null;
    stats.lastListedAt = now(); stats.lastListedCount = items.filter(visible).length;
    if (!initialized) { initialized = true; notify({ kind: 'ready' }); }
    return { rows: [...rows.values()], catalogRevision, coreGeneration };
  }
  async function readCatalog(fresh) {
    // A fresh caller may share a queued read that has not STARTED yet, never an
    // older started read. Serialize catalog work to bound cold concurrent scans.
    if (listFlight && (!fresh || !listFlight.started)) return listFlight.promise;
    const predecessor = catalogTail;
    const flight = { started: false, promise: null };
    flight.promise = predecessor.then(async () => {
      flight.started = true;
      for (let attempt = 0; attempt < 8; attempt++) {
        requireOpen(); const stamp = catalogRevision;
        try { return await baseline(); }
        catch (error) {
          if (disposed || stamp === catalogRevision) { stats.lastError = String(error?.message ?? error); throw error; }
        }
      }
      throw failure('Session catalog is busy; synchronize again');
    });
    catalogTail = flight.promise.then(() => undefined, () => undefined);
    listFlight = flight;
    try { return await flight.promise; } finally { if (listFlight === flight) listFlight = null; }
  }
  async function bounded(work, remaining = listTimeoutMs) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(failure('Session list is rebuilding; retry synchronization')), Math.max(1, remaining)); });
    try { return await Promise.race([work, timeout]); } finally { clearTimeout(timer); }
  }
  function refresh(id) {
    if (disposed || typeof readSessionSummary !== 'function') return;
    if (repairFlight) return; // One repair loop drains the dirty set, not one task per event.
    if (repairTimer) { clearTimeout(repairTimer); repairTimer = null; }
    repairFlight = Promise.resolve().then(async () => {
      for (let pass = 0; pass < 8 && !disposed; pass++) {
        const pending = [...dirty].filter(([key, stamp]) => !migrationRequired.has(key) && repaired.get(key) !== stamp);
        if (!pending.length) break;
        let failed = false;
        for (const [key, stamp] of pending) {
          try {
            await exact(key);
            if (version(key) === stamp) repaired.set(key, stamp);
          } catch (error) { failed = true; stats.lastError = String(error?.message ?? error); }
        }
        if (failed) break; // Retry IO with backoff, not eight immediate replays.
      }
    }).catch(error => { stats.lastError = String(error?.message ?? error); })
      .finally(() => {
        repairFlight = null;
        if (disposed) return;
        if ([...dirty].some(([key, stamp]) => !migrationRequired.has(key) && repaired.get(key) !== stamp)) {
          repairTimer = setTimeout(() => { repairTimer = null; refresh(); }, repairBackoff);
          repairTimer.unref?.(); repairBackoff = Math.min(30_000, repairBackoff * 2);
        } else repairBackoff = 1000;
      });
  }
  function invalidate(id) {
    if (disposed || id && nonTaskIds.has(id)) return;
    bump(id);
    if (id && !migrationRequired.has(id)) refresh(id);
    else if (initialized) void readCatalog(true).catch(error => { stats.lastError = String(error?.message ?? error); });
  }
  const disposers = [];
  if (typeof subscribe === 'function') {
    const on = (name, fn) => disposers.push(subscribe(name, (...args) => { if (!disposed) { try { fn(...args); } catch (error) { stats.lastError = String(error?.message ?? error); } } }));
    on('api-session/added', item => {
      if (typeof item?.sessionId === 'string') knownIds.add(item.sessionId);
      if (ordinary(item)) { nonTaskIds.delete(String(item.sessionId)); catalogRevision++; invalidate(String(item.sessionId)); }
      else if (typeof item?.sessionId === 'string') nonTaskIds.add(item.sessionId);
    });
    on('api-session/removed', id => { if (nonTaskIds.has(String(id))) return; knownIds.add(String(id)); catalogRevision++; invalidate(String(id)); }); // Live disposal is NOT deletion.
    on('api-session/status', (id, running) => {
      invalidate(String(id)); emit(lifecycle, { kind: 'session-status', sessionId: String(id), sequence: 0, phase: running ? 'running' : 'idle' });
    });
    on('api-session/activity', id => { if (!strictCore) invalidate(String(id)); });
    on('api-session/error', id => { emit(lifecycle, { kind: 'session-status', sessionId: String(id), sequence: 0, phase: 'error' }); });
    on('session/event', (session, event) => {
      const id = session?.header?.id ?? session?.id;
      if (!id || session.header?.origin === 'subagent') return;
      if (['session/title', 'user/message', 'turn/start', 'request/header', 'agent/model-selection', 'permissions/changed'].includes(event?.type)) invalidate(id);
      if (['user/message', 'assistant/message', 'tool/result', 'turn/end'].includes(event?.type) || event?.surfaceOp?.op === 'replace') {
        const wanted = demanded.has(id) || evidence.has(id) || evidenceQueue.has(id) || evidenceFlights.has(id);
        invalidateEvidence(id); if (wanted) queueEvidence([id]);
      }
    });
  }
  return {
    listView: true,
    listVersion: () => `${coreGeneration}:${catalogRevision}:${viewRevision}`,
    async listSessions(query = {}, deadline = Date.now() + listTimeoutMs, attempt = 0) {
      requireOpen();
      if (attempt >= 8 || Date.now() >= deadline) throw failure('Session list is rebuilding; retry synchronization');
      const cut = await bounded(readCatalog(query.fresh === true), deadline - Date.now());
      requireOpen();
      if (catalogRevision !== cut.catalogRevision || coreGeneration !== cut.coreGeneration) return this.listSessions(query, deadline, attempt + 1);
      let result = cut.rows.filter(rowVisible).map(row => ({ ...row, ...evidence.get(row.id) }));
      if (typeof query.projectRows === 'function') result = query.projectRows(result);
      result = selectSessionRows(result, query);
      if (query.evidence !== false) queueEvidence(result.map(row => row.id));
      return clone(result);
    },
    async getSession(id) {
      requireOpen();
      if (typeof id !== 'string' || !id) return undefined;
      const deadline = Date.now() + listTimeoutMs;
      for (let attempt = 0; attempt < 8; attempt++) {
        if (Date.now() >= deadline) throw failure('Session core is rebuilding; retry synchronization');
        const stamp = version(id);
        let seed;
        if (typeof readSessionSummary !== 'function') {
          const value = await sessionController.list({}, AbortSignal.timeout(listTimeoutMs));
          seed = value?.items?.find(item => String(item.sessionId) === id);
        }
        try {
          const row = await bounded(exact(id, seed), deadline - Date.now());
          if (version(id) !== stamp) continue;
          if (row) queueEvidence([id]);
          return row ? clone({ ...row, ...evidence.get(id) }) : undefined;
        } catch (error) { if (version(id) === stamp) throw error; }
      }
      throw failure('Session is busy; synchronize again');
    },
    peekSession(id) { const row = rows.get(String(id)); return row && clone({ ...row, ...evidence.get(String(id)) }); },
    snapshotRows() { return clone([...rows.values()].filter(rowVisible).map(row => ({ ...row, ...evidence.get(row.id) }))); },
    invalidateListing() { invalidate(); },
    invalidateMembership() {
      if (disposed) return;
      epoch++; catalogRevision++; // Membership barrier does not invalidate unrelated verified cores.
      if (initialized) void readCatalog(true).catch(error => { stats.lastError = String(error?.message ?? error); });
    },
    invalidateTitle(id) { invalidate(String(id)); },
    invalidateActivityEvidence(id) {
      const had = invalidateEvidence(id); if (demanded.has(id)) queueEvidence([id]); return had;
    },
    invalidateSession: invalidate,
    onListChange(listener) { changes.add(listener); return () => changes.delete(listener); },
    onEvent(listener) { lifecycle.add(listener); return () => lifecycle.delete(listener); },
    async listSessionStates(requestedId) {
      if (typeof readActiveSessions === 'function') {
        try {
          const active = await readActiveSessions();
          if (Array.isArray(active)) {
            stats.activeStateReads++; stats.lastActiveStateError = null;
            const result = active.filter(visible).map(item => ({ id: String(item.sessionId), running: item.running === true,
              updatedAt: Number.isFinite(item.updatedAt) ? new Date(item.updatedAt).toISOString() : null }));
            if (typeof requestedId === 'string' && !result.some(row => row.id === requestedId)) result.push({ id: requestedId, running: false, updatedAt: null });
            return result;
          }
        } catch (error) { stats.lastActiveStateError = String(error?.message ?? error); }
        stats.activeStateFallbacks++;
      }
      const value = await sessionController.list({}, AbortSignal.timeout(listTimeoutMs));
      return (value?.items ?? []).filter(visible).map(item => ({ id: String(item.sessionId), running: item.running === true,
        updatedAt: Number.isFinite(item.updatedAt) ? new Date(item.updatedAt).toISOString() : null }));
    },
    listDiagnostics() { return { ...stats, rows: rows.size, rawRevision: epoch, catalogRevision, coreGeneration, viewRevision, enrichmentRevision, migrationRequired: migrationRequired.size, coreActive, corePending: coreQueue.length,
      evidence: evidence.size, evidencePending: evidenceQueue.size + evidenceWorkers }; },
    cachedTitleCount() { return [...rows.values()].filter(row => typeof row.title === 'string').length; },
    async titlesSettled() { if (repairFlight) await repairFlight; },
    async evidenceSettled() { while (evidenceFlights.size) await Promise.all([...evidenceFlights.values()]); },
    dispose() {
      if (disposed) return; disposed = true; epoch++; catalogRevision++;
      for (const waiting of coreQueue.splice(0)) waiting.reject(failure('Session list source was disposed'));
      for (const off of disposers) { try { off?.(); } catch { /* Release all listeners. */ } }
      if (retryTimer) clearTimeout(retryTimer);
      if (repairTimer) clearTimeout(repairTimer);
      changes.clear(); lifecycle.clear(); evidenceQueue.clear(); rows.clear(); evidence.clear(); headers.clear(); signatures.clear(); dirty.clear();
      repaired.clear(); demanded.clear(); evidenceVersions.clear(); rowFlights.clear(); migrationRequired.clear(); knownIds.clear(); nonTaskIds.clear();
    },
  };
}
