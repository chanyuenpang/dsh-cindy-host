import { foldSurface } from '@deepseek-ai/dsh-session/surface';
import { foldSessionEvent } from './dsh-message-fold.js';
import { refusalError } from './cindy-channels.js';
const bad = text => refusalError('BAD_REQUEST', text);
const unavailable = text => refusalError('NOT_AVAILABLE', text);
const BS = String.fromCharCode(92);
const DAY = 86_400_000;
const BUDGET = Symbol('search budget');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function only(value, keys) { if (Object.keys(value).some(key => !keys.includes(key))) throw bad('Unsupported search field'); }
function choice(value, values, name, fallback) {
  if (value === undefined) return fallback;
  if (!values.includes(value)) throw bad('Invalid ' + name);
  return value;
}
export function parseKeywordSearch(input) {
  if (!object(input)) throw bad('Search needs a request object');
  only(input, ['query', 'limit', 'sortBy', 'semanticMode', 'includeArchived', 'filters', 'unnamedLabel']);
  if (typeof input.query !== 'string' || !input.query.trim()) throw bad('Search query is required');
  if (input.query.length > 512) throw unavailable('Native keyword query exceeds the 512-character budget');
  const limit = input.limit ?? 24;
  if (!Number.isSafeInteger(limit) || limit < 1) throw bad('Search limit must be a positive integer');
  if (limit > 200) throw unavailable('This native keyword subset supports limits up to 200');
  const semanticMode = choice(input.semanticMode, ['keyword', 'hybrid'], 'semanticMode', 'keyword');
  if (semanticMode !== 'keyword') throw unavailable('No verified native semantic backend is composed; select keyword search');
  if (input.includeArchived !== undefined && typeof input.includeArchived !== 'boolean') throw bad('includeArchived must be boolean');
  if (input.unnamedLabel != null && (typeof input.unnamedLabel !== 'string' || input.unnamedLabel.length > 120)) throw bad('unnamedLabel must be at most 120 characters');
  const filters = input.filters ?? {};
  if (!object(filters)) throw bad('Search filters must be an object');
  only(filters, ['status', 'agentKind', 'lastActivity', 'sessionIds', 'workingDirs']);
  function ids(value, name) {
    if (value == null) return null;
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) throw bad(name + ' must contain nonempty strings');
    if (value.length > 1000) throw unavailable(name + ' exceeds the supported filter budget');
    return value.map(item => item.trim());
  }
  return { query: input.query.trim(), limit,
    sortBy: choice(input.sortBy, ['relevance', 'activityDesc', 'activityAsc'], 'sortBy', 'relevance'),
    status: choice(filters.status, ['all', 'active', 'archived'], 'filters.status', input.includeArchived === false ? 'active' : 'all'),
    agentKind: choice(filters.agentKind, ['all', 'cc', 'codex', 'pi'], 'filters.agentKind', 'all'),
    lastActivity: choice(filters.lastActivity, ['all', '1d', '3d', '7d', '30d'], 'filters.lastActivity', 'all'),
    sessionIds: ids(filters.sessionIds, 'sessionIds'), workingDirs: ids(filters.workingDirs, 'workingDirs'),
    unnamedLabel: input.unnamedLabel?.trim() ? input.unnamedLabel : undefined };
}
/** Pure Cindy grouping semantics, not a filesystem path or native Workspace identity. */
export function searchWorkingDir(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let path = value.trim();
  const prefix = BS + BS + '?' + BS;
  if (path.startsWith(prefix + 'UNC' + BS)) path = BS + BS + path.slice((prefix + 'UNC' + BS).length);
  else if (path.startsWith(prefix)) path = path.slice(prefix.length);
  if ((/^[A-Za-z]:/.test(path) && [BS, '/'].includes(path[2])) || path.startsWith(BS + BS) || path.startsWith('//')) path = path.split(BS).join('/');
  while (path.length > 1 && path.endsWith('/') && !(path.length === 3 && /^[A-Za-z]:/.test(path))) path = path.slice(0, -1);
  const segments = [...path.matchAll(new RegExp('[^/]+', 'g'))];
  for (let i = 0; i < segments.length; i++) {
    const name = segments[i][0];
    const count = ['.cindy-worktrees', '.xdt-worktrees', '.worktrees'].includes(name) ? 1
      : name === '.claude' && segments[i + 1]?.[0] === 'worktrees' ? 2 : 0;
    if (count && i + count < segments.length && segments[i].index > 0) {
      const base = path.slice(0, segments[i].index).replace(new RegExp('/+$'), '') || '/';
      return /^[A-Za-z]:$/.test(base) ? base + '/' : base;
    }
  }
  return path;
}
function matcher(query) {
  const special = '.*+?^' + '$' + '{}()|[]' + BS;
  const pieces = query.split(new RegExp(BS + 's+', 'u')).map(part => [...part].map(c => special.includes(c) ? BS + c : c).join(''));
  return new RegExp(pieces.join(BS + 's+'), 'iu');
}
function activity(row) { return Math.max(Date.parse(row.userSendAt) || 0, Date.parse(row.updatedAt) || 0); }
function alias(value) { return value === 'claude-code' || value === 'cc' ? 'cc' : value; }
function title(row, label) { return row.title === 'New Maker' && label ? label : row.title; }
function preview(text, index) {
  let start = Math.max(0, index - 80); let end = Math.min(text.length, start + 300);
  if (start && text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff) start--;
  if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
  return text.slice(start, end);
}
/** Literal filterEvents is a native capability even when global FTS is disabled.
 * Candidate rows come only from the Host's authorized, ordinary-session projection. */
export function createDshKeywordSearch({ getQuery, getSession, now = Date.now, maxSessions = 200,
  maxEvents = 100_000, maxBytes = 2 * 1024 * 1024, durationMs = 8000, maxResponseBytes = 512 * 1024, maxConcurrent = 4, maxOutstandingReads = 8 }) {
  const active = new Set(); const pendingReads = new Set(); let generation = 0; let disposed = false;
  async function run(input, { getCandidates, signal: callerSignal } = {}) {
    const request = parseKeywordSearch(input);
    const query = getQuery(); const epoch = generation;
    if (disposed || typeof query?.filterEvents !== 'function' || typeof query?.observeSession !== 'function') throw unavailable('Native literal event search is not composed');
    if (active.size >= maxConcurrent) throw unavailable('Too many concurrent native keyword searches');
    const controller = new AbortController(); active.add(controller);
    const signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal;
    const deadline = now() + durationMs;
    function check() {
      if (signal.aborted || disposed || generation !== epoch || getQuery() !== query) throw unavailable('Native keyword search source was cancelled or replaced');
    }
    async function bounded(promise) {
      check(); const remaining = deadline - now();
      if (remaining <= 0) throw BUDGET;
      if (pendingReads.size >= maxOutstandingReads) throw unavailable('Native keyword reads are still pending; retry after the owner settles');
      const work = typeof promise === 'function' ? Promise.resolve().then(promise) : promise;
      pendingReads.add(work);
      void work.then(() => pendingReads.delete(work), () => pendingReads.delete(work));
      let timer; let abort;
      const guard = new Promise((_, reject) => {
        timer = setTimeout(() => reject(BUDGET), remaining);
        abort = () => reject(unavailable('Native keyword search cancelled'));
        signal.addEventListener('abort', abort, { once: true });
      });
      try { const value = await Promise.race([work, guard]); check(); return value; }
      finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
    }
    const response = { query: request.query, results: [], vectorUsed: false,
      vectorSkipReason: 'Native DSH literal keyword backend; no semantic search attempted', poolCapped: false };
    let bytes = 0;
    try {
      const rows = await bounded(() => getCandidates());
      if (!Array.isArray(rows)) throw unavailable('Native session projection is unavailable');
      const pattern = matcher(request.query);
      const ids = request.sessionIds === null ? null : new Set(request.sessionIds);
      const dirs = request.workingDirs?.length ? new Set(request.workingDirs.map(searchWorkingDir)) : null;
      const cutoff = request.lastActivity === 'all' ? null : now() - parseInt(request.lastActivity, 10) * DAY;
      let candidates = rows.filter(row => row.status !== 'deleted' && row.orcaRole !== 'worker' &&
        (request.status === 'all' || row.status === request.status) &&
        (request.agentKind === 'all' || alias(row.agentKind) === request.agentKind) &&
        (!ids || ids.has(row.id)) && (!dirs || dirs.has(searchWorkingDir(row.workingDir))) &&
        (cutoff === null || activity(row) >= cutoff));
      candidates.sort((a, b) => request.sortBy === 'activityAsc' ? activity(a) - activity(b) || a.id.localeCompare(b.id)
        : request.sortBy === 'activityDesc' ? activity(b) - activity(a) || a.id.localeCompare(b.id)
        : Number(pattern.test(title(b, request.unnamedLabel))) - Number(pattern.test(title(a, request.unnamedLabel))) || activity(b) - activity(a) || a.id.localeCompare(b.id));
      if (candidates.length > maxSessions) { response.poolCapped = true; candidates = candidates.slice(0, maxSessions); }
      for (const candidate of candidates) {
        check(); if (now() >= deadline || bytes >= maxBytes) { response.poolCapped = true; break; }
        if (!await bounded(() => getSession(candidate.id))) throw unavailable('An authorized search candidate is no longer readable');
        const documents = await bounded(() => query.filterEvents(candidate.id, [
          { kind: 'type', values: ['user/message', 'assistant/message'] },
          { kind: 'surface', values: ['current'] }, { kind: 'text', text: request.query },
        ]));
        if (!Array.isArray(documents) || documents.some(doc => doc.sessionId !== candidate.id || !Number.isSafeInteger(doc.seq) || doc.seq < 0)) throw unavailable('Native search returned invalid event identities');
        const shownTitle = title(candidate, request.unnamedLabel); const titleMatch = pattern.exec(shownTitle);
        if (!titleMatch && documents.length === 0) continue;
        let observation;
        try {
          // A timed-out observation still owns a lease when it settles; release it.
          let pending;
          try { observation = await bounded(() => {
            pending = Promise.resolve().then(() => query.observeSession(candidate.id, { projectionMode: 'none' }));
            return pending;
          }); }
          catch (error) { if (pending) void pending.then(value => { try { value?.[Symbol.dispose]?.(); } catch {} }, () => {}); throw error; }
          const events = observation?.events;
          if (observation?.header?.id !== candidate.id || !Array.isArray(events)) throw unavailable('Native search observation does not match its source');
          if (events.length > maxEvents) { response.poolCapped = true; continue; }
          if (events.some((event, i) => event.seq !== i)) throw unavailable('Native search requires a contiguous source observation');
          const current = new Set(foldSurface(events).nodes);
          const hitSeqs = new Set(documents.map(doc => doc.seq)); const hits = []; let count = 0;
          for (const event of events) {
            if (event.seq % 512 === 0) {
              await new Promise(resolve => setImmediate(resolve));
              check(); if (now() >= deadline) throw BUDGET;
            }
            const folded = foldSessionEvent(event, { sessionId: candidate.id }); count += folded.length;
            for (const row of folded) {
              const text = typeof row.content === 'string' ? row.content : row.content?.text ?? '';
              bytes += Buffer.byteLength(text);
              if (bytes > maxBytes) break;
              if (!current.has(event.seq) || !hitSeqs.has(event.seq) || !['user', 'assistant'].includes(row.role)) continue;
              const match = pattern.exec(text); if (!match) continue;
              hits.push({ messageId: row.id, messageClientId: row.clientId, role: row.role, createdAt: row.createdAt,
                snippet: null, preview: preview(text, match.index), score: 1, ftsRank: null, vectorRank: null });
            }
            if (bytes > maxBytes) break;
          }
          if (bytes > maxBytes) { response.poolCapped = true; break; }
          hits.reverse(); const contentHits = hits.slice(0, 3);
          if (!titleMatch && contentHits.length === 0) continue;
          const indices = titleMatch ? Array.from({ length: titleMatch[0].length }, (_, i) => titleMatch.index + i) : [];
          const kind = titleMatch ? contentHits.length ? 'both' : 'title' : 'content';
          const titleScore = titleMatch ? titleMatch[0].length === shownTitle.length ? 3 : 2 : null;
          response.results.push({ session: { id: candidate.id, title: candidate.title, workingDir: candidate.workingDir,
            workspaceKind: candidate.workspaceKind, agentKind: alias(candidate.agentKind), status: candidate.status,
            source: candidate.source ?? null, orcaRole: candidate.orcaRole ?? null, parentSessionId: candidate.parentSessionId ?? null,
            userSendAt: candidate.userSendAt, updatedAt: candidate.updatedAt, createdAt: candidate.createdAt,
            _count: { messages: count }, deviceLinkDeviceId: candidate.deviceLinkDeviceId ?? null, deviceLinkDeviceName: candidate.deviceLinkDeviceName ?? null },
            matchKind: kind, titleMatchIndices: indices, titleScore, contentHit: contentHits[0] ?? null, contentHits,
            rankScore: (titleScore ?? 0) + (contentHits.length ? 1 : 0) });
        } finally { observation?.[Symbol.dispose]?.(); }
      }
    } catch (error) { if (error === BUDGET) response.poolCapped = true; else throw error; }
    finally { active.delete(controller); }
    response.results.sort((a, b) => {
      const relevance = Number(b.matchKind !== 'content') - Number(a.matchKind !== 'content') || b.rankScore - a.rankScore || activity(b.session) - activity(a.session) || a.session.id.localeCompare(b.session.id);
      return request.sortBy === 'activityAsc' ? activity(a.session) - activity(b.session) || relevance
        : request.sortBy === 'activityDesc' ? activity(b.session) - activity(a.session) || relevance : relevance;
    });
    response.results = response.results.slice(0, request.limit);
    while (response.results.length && Buffer.byteLength(JSON.stringify(response)) > maxResponseBytes) { response.results.pop(); response.poolCapped = true; }
    return response;
  }
  function cancelAll() { generation++; for (const controller of active) controller.abort(); }
  function dispose() { disposed = true; cancelAll(); }
  return { run, cancelAll, dispose };
}
