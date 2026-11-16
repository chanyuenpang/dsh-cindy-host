/** Cindy's historyWorkLines wire shape, without importing its desktop/TS engine.
 * Direct file/search/web facts use the official descriptor vocabulary. Commands,
 * MCP and complex/split actions deliberately remain generic: no guessed intent.
 */
export const HISTORY_WORK_LINE_LIMIT = 5;
export const HISTORY_WORK_LINE_TEXT_CHARS = 160;
export const HISTORY_WORK_LINES_MAX_BYTES = 6 * 1024;
const LINE_BYTES = Math.floor((HISTORY_WORK_LINES_MAX_BYTES - HISTORY_WORK_LINE_LIMIT - 1) / HISTORY_WORK_LINE_LIMIT);
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const cut = (text, n = HISTORY_WORK_LINE_TEXT_CHARS) => text.length > n ? `${text.slice(0, n - 1)}…` : text;
const string = value => typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** Normalize only the visible opening, not an ever-growing complete thinking body. */
function thinkingOpening(text) {
  let opening = '';
  let space = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (/\s/.test(char)) { space = opening.length > 0; continue; }
    if (space) opening += ' ';
    space = false;
    opening += char;
    if (opening.length > HISTORY_WORK_LINE_TEXT_CHARS) return { text: cut(opening), truncated: true };
  }
  return { text: opening };
}

function describe(toolName, input) {
  const generic = { kind: 'generic', toolName: cut(toolName) };
  const action = ({ Read: 'read', read: 'read', ls: 'read', Edit: 'edit', MultiEdit: 'edit', edit: 'edit', Write: 'create', write: 'create' })[toolName];
  if (action) {
    const path = string(input?.file_path) ?? string(input?.path);
    if (!path) return generic;
    const name = path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || path;
    return { kind: 'file', toolName: cut(toolName), action, filePath: cut(path), fileName: cut(name) };
  }
  if (['Grep', 'Glob', 'grep', 'find'].includes(toolName)) {
    const pattern = string(input?.pattern);
    if (!pattern) return generic;
    return { kind: 'search', toolName: cut(toolName), mode: toolName === 'Grep' || toolName === 'grep' ? 'grep' : 'glob', pattern: cut(pattern),
      ...(string(input?.path) ? { path: cut(string(input.path)) } : {}),
      ...(string(input?.glob) ? { glob: cut(string(input.glob)) } : {}) };
  }
  if (['WebFetch', 'WebSearch', 'web_search'].includes(toolName)) {
    const fetch = toolName === 'WebFetch';
    const target = string(fetch ? input?.url : input?.query);
    return target ? { kind: 'web', toolName: cut(toolName), mode: fetch ? 'fetch' : 'search', target: cut(target) } : generic;
  }
  if (toolName === 'TodoWrite' || toolName === 'update_plan') return { kind: 'todo', toolName: cut(toolName) };
  return generic;
}

/** Latest-N direct activities; child-agent and redacted thinking bodies never escape. */
export function projectHistoryWorkLines(rows, isStreaming, limit = HISTORY_WORK_LINE_LIMIT) {
  limit = Math.max(0, Math.min(HISTORY_WORK_LINE_LIMIT, Math.floor(limit)));
  if (!limit) return [];
  const calls = new Map();
  const activities = [];
  for (const row of rows) {
    if (row?.agentMeta?.parentUuid) continue;
    const key = row.clientId || row.id;
    if (typeof key !== 'string' || !key) continue;
    if (row.role === 'thinking') {
      if (row.content?.isRedacted === true) continue;
      const text = typeof row.content === 'string' ? row.content : row.content?.text;
      const opening = thinkingOpening(typeof text === 'string' ? text : '');
      if (opening.text) activities.push({ kind: 'thinking', key, ...opening });
    } else if (row.role === 'tool_use') {
      const toolName = typeof row.content?.toolName === 'string' ? row.content.toolName : '';
      const input = row.content?.input;
      const line = { kind: 'tool', key, toolName: cut(toolName), descriptor: describe(toolName, input), status: isStreaming ? 'running' : 'done' };
      // ghost identity is a display fact, not the wrapper's complete arbitrary input.
      if (/(?:^|:|__)ghost_call$/.test(toolName) && typeof input?.ghost_id === 'string') {
        line.ghost = { id: cut(input.ghost_id), tool: cut(typeof input.tool === 'string' ? input.tool : '') };
      }
      activities.push(line);
      const callId = row.toolUseId || row.content?.toolUseId;
      if (callId) calls.set(callId, line);
    } else if (row.role === 'tool_result') {
      const line = calls.get(row.toolUseId || row.content?.toolUseId);
      if (line) {
        line.status = 'done';
        if (row.content?.isError === true || row.isError === true) line.hasError = true;
      }
    }
  }
  const lines = [];
  for (const activity of activities.slice(-limit)) {
    let line = activity;
    if (bytes(line) > LINE_BYTES && line.kind === 'tool') {
      line = { kind: 'tool', key: line.key, toolName: cut(line.toolName, 40), descriptor: { kind: 'generic', toolName: cut(line.toolName, 40) }, status: line.status,
        ...(line.hasError ? { hasError: true } : {}) };
    }
    // Do not truncate identity or send an over-budget line, even for adversarial IDs.
    if (bytes(line) <= LINE_BYTES) lines.push(line);
  }
  while (lines.length && bytes(lines) > HISTORY_WORK_LINES_MAX_BYTES) lines.shift();
  return lines;
}
