import { foldSurface, deriveEventMessage } from '@deepseek-ai/dsh-session/surface';
import { toCindyMessageRows } from './cindy-message-row.js';
import { promptRpcIdOf } from './dsh-message-fold.js';
import { refusalError } from './cindy-channels.js';
const bad = text => refusalError('BAD_REQUEST', text);
const no = text => refusalError('NOT_AVAILABLE', text);
const allowed = ['sessionId','workdir','fromMs','toMs','agentKind','roles','includeRewound','limit','cursor','order','contentCharLimit'];
function parse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw bad('Invalid source-history request fields');
  if (typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 256) throw bad('An exact ordinary session identity is required');
  if (value.includeRewound !== false || !Array.isArray(value.roles) || !value.roles.length || value.roles.some(role => !['user','assistant'].includes(role))) throw no('Only current user/assistant source history is mapped; rewound/all-role variants are unsupported');
  if (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 1000 || !['asc','desc'].includes(value.order)) throw bad('Invalid history limit/order');
  for (const key of ['fromMs','toMs']) if (value[key] !== null && !Number.isFinite(value[key])) throw bad(key + ' must be finite or null');
  if (value.workdir !== null && typeof value.workdir !== 'string') throw bad('workdir must be string or null');
  if (value.agentKind !== null && !['cc','codex','pi'].includes(value.agentKind)) throw bad('Invalid source agent alias');
  if (value.contentCharLimit !== undefined && value.contentCharLimit !== null && (!Number.isSafeInteger(value.contentCharLimit) || value.contentCharLimit < 1 || value.contentCharLimit > 8000)) throw bad('contentCharLimit must be null or 1–8000');
  if (value.cursor !== null && (!value.cursor || typeof value.cursor !== 'object' || Array.isArray(value.cursor) || Object.keys(value.cursor).some(key => !['createdAt','id','rowid'].includes(key)) || !Number.isFinite(value.cursor.createdAt) || typeof value.cursor.id !== 'string' || !value.cursor.id || value.cursor.rowid !== undefined && (!Number.isSafeInteger(value.cursor.rowid) || value.cursor.rowid < 1))) throw bad('Invalid source-history cursor');
  return value;
}
export function createDshReferenceHistory({ getQuery, getSession, maxEvents = 100000, maxBytes = 384 * 1024, maxReads = 8 }) {
  let disposed = false; let epoch = 0; const active = new Set();
  async function read(value, { getView, signal: callerSignal } = {}) {
    const request = parse(value); const query = getQuery(); const generation = epoch;
    if (disposed || typeof query?.observeSession !== 'function') throw no('Native source-history observation is not composed');
    if (active.size >= maxReads) throw no('Source-history observation budget is busy');
    const controller = new AbortController(); active.add(controller); const signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal;
    const check = () => { if (disposed || signal.aborted || generation !== epoch || query !== getQuery()) throw no('Source-history request cancelled or source replaced'); };
    let observation;
    try {
      check(); const session = await getSession(request.sessionId, { signal }); check();
      if (!session || session.id !== request.sessionId) throw refusalError('NOT_FOUND', 'No visible ordinary source session');
      const view = getView ? await getView(request.sessionId) : { id: session.id, workingDir: session.cwd, agentKind: session.agentKind, title: session.title }; check();
      if (!view || view.id !== request.sessionId) throw refusalError('NOT_FOUND', 'No authorized source view');
      observation = await query.observeSession(request.sessionId, { signal, projectionMode: 'none' }); check();
      const events = observation.events;
      if (observation.header?.id !== request.sessionId || !Array.isArray(events) || events.length > maxEvents || events.some((event, seq) => !event || event.seq !== seq || !Number.isFinite(event.time))) throw no('Native history prefix is invalid or over budget');
      const current = foldSurface(events).nodes; const rows = []; const alias = view.agentKind === 'claude-code' ? 'cc' : view.agentKind;
      const matches = (request.workdir === null || request.workdir === view.workingDir) && (request.agentKind === null || request.agentKind === alias);
      if (matches) for (const seq of current) {
        const event = events[seq]; if (!['user/message','assistant/message'].includes(event.type)) continue;
        const message = deriveEventMessage(event); if (!message) continue;
        const folded = toCindyMessageRows(message, { sessionId: request.sessionId, createdAt: new Date(event.time).toISOString(), promptClientId: promptRpcIdOf(event) });
        folded.forEach((row, index) => {
          if (!request.roles.includes(row.role) || request.fromMs !== null && event.time < request.fromMs || request.toMs !== null && event.time > request.toMs) return;
          const rowid = seq * 65536 + index + 1; if (!Number.isSafeInteger(rowid)) throw no('Source history order exceeds the safe cursor range');
          let content = row.content; let truncated = false; const limit = request.contentCharLimit;
          if (limit !== undefined && limit !== null) {
            const text = typeof content === 'string' ? content : typeof content?.text === 'string' ? content.text : '';
            truncated = text.length > limit || Object.keys(content ?? {}).some(key => key !== 'text' && (Array.isArray(content[key]) ? content[key].length > 0 : content[key] != null));
            content = text.length > limit ? limit === 1 ? '…' : '…' + text.slice(-(limit - 1)) : text;
          }
          rows.push({ rowid, item: { id: row.id, sessionId: request.sessionId, sessionWorkingDir: view.workingDir ?? null, sessionAgentKind: alias, sessionTitle: view.title ?? '', role: row.role, content, toolUseId: null, agentMeta: truncated ? { remoteContentTruncated: true } : null, createdAt: event.time, rewindAt: null } });
        });
      }
      // SQLite's first-page order uses rowid; legacy cursors without it use id.
      const ordinal = !request.cursor || request.cursor.rowid !== undefined;
      const compare = (a,b) => a.item.createdAt - b.item.createdAt || (ordinal ? a.rowid - b.rowid : a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0);
      rows.sort(compare); if (request.order === 'desc') rows.reverse();
      const after = request.cursor ? rows.filter(row => { const delta = row.item.createdAt - request.cursor.createdAt || (ordinal ? row.rowid - request.cursor.rowid : row.item.id < request.cursor.id ? -1 : row.item.id > request.cursor.id ? 1 : 0); return request.order === 'asc' ? delta > 0 : delta < 0; }) : rows;
      const selected = []; let bytes = 1024;
      for (const row of after.slice(0, request.limit)) {
        const size = Buffer.byteLength(JSON.stringify(row.item));
        if (bytes + size > maxBytes) { if (!selected.length) throw no('Source history row exceeds the response byte budget; request a contentCharLimit'); break; }
        selected.push(row); bytes += size;
      }
      const hasMore = after.length > selected.length; const last = selected.at(-1);
      let terminal = null;
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (event.type === 'turn/start') break;
        if (event.type === 'turn/end') { if ((event.data?.reason?.kind ?? event.data?.reason) === 'error' && (request.fromMs === null || event.time >= request.fromMs)) terminal = { status: 'error', createdAt: event.time }; break; }
      }
      check(); return { items: selected.map(row => row.item), hasMore, nextCursor: hasMore && last ? { createdAt: last.item.createdAt, id: last.item.id, ...(ordinal ? { rowid: last.rowid } : {}) } : null, terminal };
    } finally { try { observation?.[Symbol.dispose]?.(); } finally { active.delete(controller); } }
  }
  function cancelAll() { epoch++; for (const controller of active) controller.abort(); }
  function dispose() { disposed = true; cancelAll(); }
  return { read, cancelAll, dispose };
}
