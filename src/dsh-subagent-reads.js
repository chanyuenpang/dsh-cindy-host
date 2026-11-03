import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { foldSessionEvent } from './dsh-message-fold.js';
import { refusalError } from './cindy-channels.js';
const unavailable = text => refusalError('NOT_AVAILABLE', text);
const bad = text => refusalError('BAD_REQUEST', text);
const runIdentity = (parent, child) => 'dsh-child:' + Buffer.from(JSON.stringify([parent, child])).toString('base64url');
let nativeAgentModule;
async function nativeConsumedWork(events) {
  // Optional SDK helper, not an Agent constructor or a second work-accounting engine.
  try {
    nativeAgentModule ??= import('@deepseek-ai/dsh-agent');
    const module = await nativeAgentModule;
    if (typeof module.foldConsumedWork !== 'function') throw Error('missing native foldConsumedWork');
    return module.foldConsumedWork(events);
  } catch { throw unavailable('This DSH runtime exposes no native consumed-work reader'); }
}
function parse(method, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad('Subagent read needs one request object');
  const allowed = method === 'list' ? ['sessionId', 'cursor', 'limit'] : method === 'detail' ? ['sessionId', 'provider', 'runIdOrAlias'] : ['sessionId', 'provider', 'runIdOrAlias', 'cursor', 'limit'];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw bad('Unsupported subagent read field');
  if (typeof value.sessionId !== 'string' || !value.sessionId.trim() || value.sessionId.length > 256) throw bad('An exact parent session identity is required');
  if (method !== 'list' && (!['pi', 'claude-code', 'codex'].includes(value.provider) || typeof value.runIdOrAlias !== 'string' || !value.runIdOrAlias.trim() || value.runIdOrAlias.length > 1024)) throw bad('A provider and exact run identity are required');
  if (value.cursor !== undefined && (typeof value.cursor !== 'string' || !value.cursor || value.cursor.length > 2048)) throw bad('Invalid subagent cursor');
  const limit = value.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1) throw bad('Subagent page limit must be a positive integer');
  if (limit > 25) throw unavailable('This read-only remote subset supports pages up to 25 entries');
  return { ...value, limit };
}
function reasonStatus(reason) {
  const kind = reason?.kind;
  if (kind === 'completed') return 'completed';
  if (kind === 'error') return 'failed';
  if (['aborted', 'interrupted', 'blocked', 'max-tokens'].includes(kind)) return 'stopped';
  throw unavailable('Native child outcome has no truthful remote status mapping');
}
function publicText(value) {
  if (typeof value === 'string') return value;
  if (typeof value?.text === 'string') return value.text;
  if (Array.isArray(value)) return value.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');
  return '';
}
/** Read-only descendants are authorized by the parent's durable catalog on EVERY
 * request. No resolveAgent, resume, steering, interruption or private file access. */
export function createDshSubagentReads({ getSubagents, getQuery, getAgents = () => undefined, getParent,
  readConsumedWork = nativeConsumedWork, maxChildren = 128, maxEvents = 100_000, maxBytes = 2 * 1024 * 1024, maxReads = 8, maxPageBytes = 192 * 1024 }) {
  const key = randomBytes(32); const active = new Set(); let epoch = 0; let disposed = false;
  function encode(scope, stamp, position) {
    const body = Buffer.from(JSON.stringify({ scope, stamp, epoch, position })).toString('base64url');
    return body + '.' + createHmac('sha256', key).update(body).digest('base64url');
  }
  function decode(cursor, scope, stamp, fallback) {
    if (cursor === undefined) return fallback;
    try {
      const parts = cursor.split('.'); if (parts.length !== 2) throw Error();
      const signature = Buffer.from(parts[1], 'base64url'); const expected = createHmac('sha256', key).update(parts[0]).digest();
      if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw Error();
      const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      if (data.scope !== scope || data.stamp !== stamp || data.epoch !== epoch) throw unavailable('Subagent source/catalog changed; restart this read without a cursor');
      if (!Number.isSafeInteger(data.position) || data.position < -1) throw Error();
      return data.position;
    } catch (error) { if (error?.refusalCode) throw error; throw bad('Invalid or foreign subagent cursor'); }
  }
  async function withScope(request, work, signal) {
    if (disposed || active.size >= maxReads) throw unavailable('Native subagent reads are unavailable or busy');
    const subagents = getSubagents(); const query = getQuery(); const agents = getAgents();
    if ((typeof subagents?.listDescendants !== 'function' && typeof subagents?.listChildren !== 'function') || typeof query?.observeSession !== 'function') throw unavailable('Native durable child catalog/session observation is not composed');
    const controller = new AbortController(); active.add(controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal; const generation = epoch;
    const check = () => { if (disposed || combined.aborted || epoch !== generation || getSubagents() !== subagents || getQuery() !== query || getAgents() !== agents) throw unavailable('Native subagent read was cancelled or its source changed'); };
    try {
      check(); const parent = await getParent(request.sessionId, { signal: combined });
      if (!parent || parent.id !== request.sessionId) throw refusalError('NOT_FOUND', 'No visible ordinary parent session'); check();
      const descendants = typeof subagents.listDescendants === 'function';
      const raw = await (descendants ? subagents.listDescendants(request.sessionId, combined) : subagents.listChildren(request.sessionId, combined)); check();
      if (!Array.isArray(raw) || raw.length > maxChildren) throw unavailable('Native child catalog is invalid or exceeds the supported read budget');
      const catalog = raw.map(row => ({ ...row, parentId: descendants ? row.parentId : request.sessionId }));
      const byId = new Map();
      for (const row of catalog) {
        if (typeof row?.id !== 'string' || !row.id.trim() || row.id.length > 256 || byId.has(row.id) || row.id === request.sessionId || typeof row.parentId !== 'string' || (row.label !== undefined && typeof row.label !== 'string')) throw unavailable('Native child catalog contains an invalid identity/relation');
        byId.set(row.id, row);
      }
      for (const row of catalog) {
        let parent = row.parentId; const visited = new Set([row.id]);
        while (parent !== request.sessionId) { if (visited.has(parent) || !byId.has(parent)) throw unavailable('Native child catalog is not rooted at the authorized parent'); visited.add(parent); parent = byId.get(parent).parentId; }
      }
      const stamp = createHash('sha256').update(JSON.stringify(catalog.map(({ id, parentId, mode, label, reason, kind, createdAt }) => [id, parentId, mode, label, reason, kind, createdAt]))).digest('base64url');
      return await work({ catalog, byId, stamp, query, agents, check, signal: combined });
    } catch (error) { if (combined.aborted || epoch !== generation || disposed) throw unavailable('Native subagent read cancelled'); throw error; }
    finally { active.delete(controller); }
  }
  function requireLocal(row) {
    if (row.kind === 'diagnostic' || !['one-shot', 'continuable'].includes(row.mode)) throw unavailable('Native child ' + row.id + ' is external, unknown or unreadable; no local run state is invented');
  }
  async function snapshot(row, context) {
    requireLocal(row); let lease;
    try {
      lease = await context.query.observeSession(row.id, { signal: context.signal, projectionMode: 'all' }); context.check();
      const events = lease?.events; const inherited = lease?.inheritedEventCount;
      if (lease?.header?.id !== row.id || !Array.isArray(events) || events.length > maxEvents || !Number.isSafeInteger(inherited) || inherited < 0 || inherited > events.length || events.some((event, i) => event.seq !== i || !Number.isFinite(event.time))) throw unavailable('Native child observation is invalid or over budget');
      return { header: lease.header, inherited, own: events.slice(inherited), values: lease.projections?.values ?? {} };
    } finally { lease?.[Symbol.dispose]?.(); }
  }
  async function runInfo(parent, row, state, context) {
    if (typeof context.agents?.get !== 'function') throw unavailable('Native live-Agent lookup is not composed');
    const live = context.agents.get(row.id); let status; let ending; let cancelled;
    if (live?.status === 'running') status = 'running';
    else {
      const inbox = state.values.inbox;
      if (!inbox || !Array.isArray(inbox['next-turn']) || !Array.isArray(inbox['next-step'])) throw unavailable('Native child pending-work state is unknown');
      if (inbox['next-turn'].length || inbox['next-step'].length) throw unavailable('Native child has pending input but no observed live execution');
      const consumed = await readConsumedWork(state.own); context.check();
      if (!consumed || typeof consumed.droppedUnrun !== 'boolean') throw unavailable('Native consumed-work accounting is unavailable');
      if (consumed.droppedUnrun) {
        cancelled = state.own.findLast(event => event.type === 'agent/inbox/spliced' && event.data?.outcome === 'canceled');
        if (!cancelled) throw unavailable('Native discarded-work evidence is inconsistent');
        status = 'stopped';
      } else {
        ending = state.own.find(event => event.seq === consumed.end?.seq && event.type === 'turn/end');
        if (!ending) throw unavailable('Inactive child has no consumed terminal work; no completed state is inferred');
        if (state.own.some(event => event.seq > ending.seq && ['assistant/message', 'step/start'].includes(event.type))) throw unavailable('Native child has unfinished work after its last consumed ending');
        status = reasonStatus(ending.data?.reason);
      }
    }
    const startedAt = state.header.createdAt ?? row.createdAt;
    if (!Number.isFinite(startedAt) || startedAt < 0) throw unavailable('Native child creation time is unavailable');
    if (row.createdAt !== undefined && state.header.createdAt !== undefined && row.createdAt !== state.header.createdAt) throw unavailable('Native child catalog/header creation evidence conflicts');
    const updatedAt = state.own.reduce((latest, event) => Math.max(latest, event.time), startedAt);
    const activity = state.own.filter(event => event.type === 'turn/start').map(event => ({ sequence: (event.seq - state.inherited) * 16777216,
      kind: 'started', status: 'running', summary: 'DSH turn started', occurredAt: event.time }));
    if (ending) activity.push({ sequence: (ending.seq - state.inherited) * 16777216, kind: status, status, summary: 'DSH native ' + ending.data.reason.kind, occurredAt: ending.time });
    if (cancelled) activity.push({ sequence: (cancelled.seq - state.inherited) * 16777216, kind: 'stopped', status: 'stopped', summary: 'DSH discarded unrun input', occurredAt: cancelled.time });
    const id = runIdentity(parent, row.id);
    const run = { id, parentSessionId: parent, provider: 'pi', logicalAgentId: row.id, identityAliases: [row.id], providerRunIds: [row.id], status,
      title: ('DSH: ' + (row.label || row.id)).slice(0, 180), description: 'DSH ' + row.mode + ' child of ' + row.parentId + '; read-only protocol alias, not a Pi engine',
      capabilities: { viewActivity: activity.length > 0, viewReturnedResult: false, viewFullTranscript: true, resume: false, steer: false, stop: false,
        parentContext: row.parentId === parent && state.header.parentSession === parent && state.inherited > 0 ? 'snapshot' : 'unknown' },
      startedAt, updatedAt, ...(status === 'running' ? {} : { endedAt: (cancelled ?? ending).time }) };
    const selection = state.values.modelSelection;
    if (typeof selection?.model === 'string') run.model = selection.model;
    if (typeof selection?.reasoningEffort === 'string') run.reasoningEffort = selection.reasoningEffort;
    return { run, activity: activity.sort((a, b) => a.sequence - b.sequence).slice(-25) };
  }
  function find(request, context) {
    const row = context.catalog.find(row => row.id === request.runIdOrAlias || runIdentity(request.sessionId, row.id) === request.runIdOrAlias);
    if (!row) throw refusalError('NOT_FOUND', 'No child in this parent catalog matches the requested run');
    return row;
  }
  async function list(input, options = {}) {
    const request = parse('list', input);
    return withScope(request, async context => {
      const scope = 'list:' + request.sessionId; const offset = decode(request.cursor, scope, context.stamp, 0);
      if (offset > context.catalog.length) throw bad('Subagent list cursor exceeds its catalog');
      // Validate unsupported/diagnostic branches explicitly, never silently omit one.
      context.catalog.forEach(requireLocal);
      const selected = context.catalog.slice(offset, offset + request.limit); const runs = [];
      for (const row of selected) { const state = await snapshot(row, context); runs.push((await runInfo(request.sessionId, row, state, context)).run); }
      context.check(); const next = offset + selected.length;
      return { supported: true, runs, ...(next < context.catalog.length ? { nextCursor: encode(scope, context.stamp, next) } : {}) };
    }, options.signal);
  }
  async function detail(input, options = {}) {
    const request = parse('detail', input); if (request.provider !== 'pi') return { supported: false, run: null };
    return withScope(request, async context => { const row = find(request, context); const state = await snapshot(row, context);
      const info = await runInfo(request.sessionId, row, state, context); context.check();
      return { supported: true, run: { ...info.run, activity: info.activity } }; // Never relabel last assistant text as a returned-to-parent result.
    }, options.signal);
  }
  function entries(state, childId) {
    const result = []; const toolNames = new Map(); let bytes = 0; let enteredOwnTurn = false;
    for (const event of state.own) {
      if (event.type === 'turn/start') enteredOwnTurn = true;
      if (!enteredOwnTurn) continue; // Seed's synthetic closers are not independent child work.
      if (event.type === 'user/message' && !['user', 'agent', 'subagent'].includes(event.data?.source?.kind)) continue;
      const rows = foldSessionEvent(event, { sessionId: childId });
      if (rows.length > 65536) throw unavailable('Native child message block budget exceeded');
      for (const [rowIndex, row] of rows.entries()) {
        const tool = row.role === 'tool_use' || row.role === 'tool_result';
        if (!['user', 'assistant'].includes(row.role) && !tool) continue;
        const toolCallId = row.toolUseId;
        if (tool && (typeof toolCallId !== 'string' || !toolCallId)) throw unavailable('Native child tool entry has no stable call identity');
        const nativeCall = event.data?.message?.content?.find(block => block.type === 'tool-call' && block.id === toolCallId);
        if (tool && typeof nativeCall?.name === 'string') toolNames.set(toolCallId, nativeCall.name);
        const toolName = toolNames.get(toolCallId);
        const content = tool ? row.role === 'tool_use' ? 'DSH tool call' : publicText(row.content) || 'DSH structured tool result (non-text payload omitted)'
          : publicText(row.content) || (Array.isArray(row.content?.files) && row.content.files.length ? 'DSH attachment-only input (text transcript)' : '');
        if (!content) continue;
        bytes += Buffer.byteLength(content); if (bytes > maxBytes) throw unavailable('Native child public transcript exceeds the supported byte budget');
        let position = 0; let chunk = 0;
        while (position < content.length) {
          let end = Math.min(content.length, position + 8000);
          if (end < content.length && content.charCodeAt(end - 1) >= 0xd800 && content.charCodeAt(end - 1) <= 0xdbff) end--;
          if (chunk > 255) throw unavailable('Native child message exceeds the supported chunk budget');
          const sequence = (event.seq - state.inherited) * 16777216 + rowIndex * 256 + chunk;
          if (!Number.isSafeInteger(sequence)) throw unavailable('Native child transcript sequence exceeds the protocol range');
          result.push({ id: runIdentity(childId, String(sequence)), sequence, role: tool ? 'tool' : row.role === 'user' ? 'parent' : 'subagent',
            content: content.slice(position, end), occurredAt: event.time,
            ...(tool ? { toolCallId, toolPhase: row.role === 'tool_use' ? 'start' : 'end', ...(toolName ? { toolName } : {}), ...(row.content?.isError === true ? { isError: true } : {}) } : {}) });
          position = end; chunk++;
        }
      }
    }
    return result;
  }
  async function transcript(input, options = {}) {
    const request = parse('transcript', input); if (request.provider !== 'pi') return { supported: false, entries: [] };
    return withScope(request, async context => {
      const row = find(request, context); const state = await snapshot(row, context);
      const scope = 'transcript:' + request.sessionId + ':' + row.id + ':' + state.inherited + ':' + state.header.createdAt;
      const after = decode(request.cursor, scope, context.stamp, -1);
      const all = entries(state, row.id); const available = all.filter(entry => entry.sequence > after);
      const page = []; let pageBytes = 0;
      for (const entry of available.slice(0, request.limit)) {
        const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
        if (pageBytes + size > maxPageBytes - 8192) {
          if (!page.length) throw unavailable('Native child transcript item exceeds the response byte budget');
          break;
        }
        page.push(entry); pageBytes += size;
      }
      const position = page.at(-1)?.sequence ?? after;
      context.check();
      return { supported: true, entries: page, ...(available.length > page.length ? { nextCursor: encode(scope, context.stamp, position) } : {}), tailCursor: encode(scope, context.stamp, position) };
    }, options.signal);
  }
  function cancelAll() { epoch++; for (const controller of active) controller.abort(); }
  function dispose() { disposed = true; cancelAll(); }
  return { list, detail, transcript, cancelAll, dispose };
}
