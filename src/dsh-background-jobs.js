import { refusalError } from './cindy-channels.js';
const unavailable = text => refusalError('NOT_AVAILABLE', text);
const statuses = new Map([['running', 'running'], ['stopping', 'running'], ['completed', 'completed'], ['failed', 'failed'], ['killed', 'stopped']]);
export const jobTaskId = id => 'dsh-job:' + Buffer.from(id, 'utf8').toString('base64url');
function text(value, limit) { return typeof value === 'string' ? value.slice(0, limit) : ''; }
function iso(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8.64e15 ? new Date(value).toISOString() : undefined; }
/** Same public registry list(sessionId) used by native jobController.list. No
 * model-cursor/output reads, kill calls, file-path projections or shadow jobs. */
export function createDshBackgroundJobs({ getRegistry, getSession, maxJobs = 512, maxSessions = 32, maxReads = 32 }) {
  const active = new Set(); const rosters = new Map(); let generation = 0; let disposed = false;
  function validateSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw refusalError('BAD_REQUEST', 'Background task list needs an exact session identity');
  }
  function registryNow() {
    const registry = getRegistry();
    if (disposed || typeof registry?.list !== 'function') throw unavailable('Native DSH job registry is not composed');
    return registry;
  }
  function normalize(sessionId, jobs) {
    if (!Array.isArray(jobs) || jobs.length > maxJobs) throw unavailable('Native job roster is invalid or exceeds the supported snapshot budget');
    const ids = new Set();
    return jobs.map(job => {
      if (job?.owner !== undefined && job.owner !== sessionId) throw refusalError('FORBIDDEN', 'Native job roster violated the session owner fence');
      if (typeof job?.id !== 'string' || !job.id || job.id.length > 256 || ids.has(job.id) || !statuses.has(job.status)) throw unavailable('Native job roster contains an invalid identity or state');
      ids.add(job.id);
      const status = statuses.get(job.status);
      const title = 'DSH ' + (text(job.kind, 32) || 'job') + ': ' + (text(job.label, 160) || job.id) + (job.status === 'stopping' ? ' [stopping]' : '');
      const details = [job.status, text(job.progress, 200), text(job.detail, 200)];
      if (Number.isSafeInteger(job.output?.total) && job.output.total >= 0) details.push('output bytes: ' + job.output.total);
      const data = { taskId: jobTaskId(job.id), status, title, summary: details.filter(Boolean).join('; ').slice(0, 700) };
      const createdAt = iso(job.startedAt); const updatedAt = iso(job.finishedAt);
      if (createdAt) data.createdAt = createdAt;
      if (updatedAt) data.updatedAt = updatedAt;
      if (createdAt && updatedAt && job.finishedAt >= job.startedAt) data.usage = { durationMs: job.finishedAt - job.startedAt };
      // provider/toolUseId/outputFile/taskType are deliberately absent: a native
      // job is not evidence of a vendor Agent, an originating tool-call or a file.
      return { nativeId: job.id, data, active: job.status === 'running' || job.status === 'stopping' };
    });
  }
  async function authorized(sessionId, registry, epoch, signal) {
    let row;
    try { row = await getSession(sessionId, { signal }); }
    catch (error) {
      if (signal.aborted || disposed || generation !== epoch) throw unavailable('Native background task read cancelled');
      throw error;
    }
    if (disposed || signal.aborted || generation !== epoch || getRegistry() !== registry) throw unavailable('Native background task source was cancelled or replaced');
    if (!row) throw refusalError('NOT_FOUND', 'No visible ordinary session for background task access');
  }
  async function withRead(sessionId, work) {
    validateSession(sessionId);
    const registry = registryNow(); const epoch = generation;
    if (active.size >= maxReads) throw unavailable('Too many native background task reads');
    const controller = new AbortController(); active.add(controller);
    try {
      await authorized(sessionId, registry, epoch, controller.signal);
      return work(registry);
    } finally { active.delete(controller); }
  }
  async function read(sessionId) {
    return withRead(sessionId, registry => {
      // This is the exact synchronous, fenced public operation used by DSH's
      // roster stream. No extra long-lived observation generation is opened.
      const normalized = normalize(sessionId, registry.list(sessionId));
      return { tasks: normalized.filter(job => job.active).map(({ data }) => ({ taskId: data.taskId, title: data.title })) };
      // pendingContinuations stays absent (unknown), never a fabricated zero.
      // Cindy list snapshots contain active tasks only; terminal states travel
      // through the existing agent_task_update event, not a fake running row.
    });
  }
  async function updates(sessionId, jobs) {
    validateSession(sessionId);
    registryNow();
    const normalized = normalize(sessionId, jobs); // Validate the whole owner set before emitting anything.
    let entry = rosters.get(sessionId);
    if (!entry) {
      if (rosters.size >= maxSessions) rosters.delete(rosters.keys().next().value);
      entry = { revision: 0, seen: new Map() }; rosters.set(sessionId, entry);
    }
    const revision = ++entry.revision;
    return withRead(sessionId, () => {
      if (rosters.get(sessionId) !== entry || entry.revision !== revision) return [];
      const emitted = []; const next = new Map();
      for (const { nativeId, data } of normalized) {
        const previous = entry.seen.get(nativeId);
        // A terminal native identity cannot be resurrected by a stale frame.
        if (previous && previous.status !== 'running' && data.status === 'running') { next.set(nativeId, previous); continue; }
        const fingerprint = JSON.stringify(data);
        if (previous?.fingerprint !== fingerprint) emitted.push({ type: 'agent_task_update', data });
        next.set(nativeId, { fingerprint, status: data.status });
      }
      // Disappearance alone is not terminal evidence: never synthesize stopped.
      entry.seen = next;
      return emitted;
    });
  }
  function cancelAll() { generation++; for (const controller of active) controller.abort(); rosters.clear(); }
  function dispose() { disposed = true; cancelAll(); }
  return { read, updates, cancelAll, dispose };
}
