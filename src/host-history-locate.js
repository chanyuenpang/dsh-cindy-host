/** Latest Cindy around/around-client-id contract over the one committed transcript. */
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
export function historyLocateOptions(options = {}) {
  const value = Number(options?.radius);
  const radius = !Number.isFinite(value) || value < 0 ? 60 : Math.min(Math.floor(value), 200);
  const limit = options?.contentCharLimit ?? null;
  if (limit !== null && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 8000)) fail('INVALID_PARAMS', 'contentCharLimit must be an integer between 1 and 8000 or null');
  return { radius, contentCharLimit: limit };
}
export function locateCommittedMessages(rows, { sessionId, identity, byClientId, radius, clearBoundaryMs = null }) {
  if (!Array.isArray(rows)) fail('NOT_AVAILABLE', 'Committed message history is unavailable');
  const ordered = rows.map((row, index) => ({ row, rank: Number.isFinite(row?.rowid) ? row.rowid : rows.length - index }))
    .filter(({row}) => row && (row.sessionId === undefined || row.sessionId === sessionId) && row.rewindAt == null && (clearBoundaryMs === null || Date.parse(row.createdAt) > clearBoundaryMs))
    .sort((a,b) => Date.parse(a.row.createdAt) - Date.parse(b.row.createdAt) || a.rank - b.rank);
  const at = ordered.findIndex(({row}) => (byClientId ? row.clientId : row.id) === identity);
  if (at < 0) fail('NOT_FOUND', 'Message does not exist in this session');
  return ordered.slice(Math.max(0, at-radius), at+radius+1).map(({row})=>row);
}
function preview(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => typeof part === 'string' ? part : part?.type === 'text' && typeof part.text === 'string' ? part.text : '').filter(Boolean).join(String.fromCharCode(10));
  if (content && typeof content === 'object') { if(typeof content.text === 'string')return content.text; if(typeof content.content === 'string')return content.content; }
  return JSON.stringify(content) ?? '';
}
function omitsData(content) {
  if (Array.isArray(content)) return content.some(part => typeof part !== 'string' && !(part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string'));
  if (!content || typeof content !== 'object') return false;
  if (typeof content.text !== 'string' && typeof content.content !== 'string') return true;
  return content.quotesEncoded === true || ['images','files','sessionReferences','pastedTextRanges','slashCommandRanges'].some(key=>Array.isArray(content[key]) && content[key].length>0);
}
export function capReferenceRows(rows, limit) {
  if(limit === null)return rows;
  return rows.map(row=>{const text=preview(row.content);const lossy=text.length>limit || omitsData(row.content);
    if(!lossy)return typeof row.content === 'string' ? row : {...row,content:text};
    const content=text.length<=limit ? text : limit===1 ? '…' : '…'+text.slice(-(limit-1));
    const prior=row.agentMeta && typeof row.agentMeta==='object' && !Array.isArray(row.agentMeta) ? row.agentMeta : {};
    return {...row,content,agentMeta:{...prior,remoteContentTruncated:true}};
  });
}
