/** Display-only projection of a durable failed turn. DSH owns failure and retry policy. */
const SAFE_MESSAGES = new Map([
  ['AUTH', 'Model authentication failed. Check the provider configuration.'],
  ['MISSING_CREDENTIAL', 'Model credentials are missing. Check the provider configuration.'],
  ['INVALID_CREDENTIAL', 'Model credentials are invalid. Check the provider configuration.'],
  ['RATE_LIMIT', 'The model request was rate limited.'],
  ['QUOTA', 'The model account quota is exhausted.'],
  ['ACCOUNT_QUOTA', 'The model account quota is exhausted.'],
  ['CONTEXT_WINDOW_EXCEEDED', 'The model context window was exceeded.'],
  ['TIMEOUT', 'The model request timed out.'],
  ['TRANSPORT', 'The model connection failed.'],
  ['SERVER', 'The model service failed.'],
  ['EMPTY_RESPONSE', 'The model returned an empty response.'],
  ['NO_ADAPTER', 'The selected model route is unavailable.'],
]);

/** Never copy provider prose, unknown codes, request IDs or nested diagnostic objects. */
export function turnErrorRow(event, sessionId) {
  if (event?.type !== 'turn/end' || event.data?.reason?.kind !== 'error') return null;
  if (typeof sessionId !== 'string' || !sessionId || !Number.isSafeInteger(event.seq) || event.seq < 0) return null;
  // No wall-clock fallback: cold replay and live delivery must produce identical rows.
  if (!Number.isFinite(event.time) || !Number.isFinite(new Date(event.time).getTime())) return null;
  const failure = event.data.reason.error;
  const code = SAFE_MESSAGES.has(failure?.code) ? failure.code : null;
  const status = Number.isInteger(failure?.status) && failure.status >= 100 && failure.status <= 599 ? failure.status : null;
  const detail = [code, status === null ? null : `HTTP ${status}`].filter(Boolean).join('; ');
  const message = (SAFE_MESSAGES.get(code) ?? 'This turn failed. See the local DSH diagnostics for details.')
    + (detail ? ` (${detail})` : '');
  const id = `${sessionId}:turn-error:${event.seq}`;
  return { id, clientId: id, sessionId, role: 'error', toolUseId: null, agentMeta: null,
    createdAt: new Date(event.time).toISOString(),
    content: { message, reason: 'dsh-turn-error', ...(code ? { code } : {}), ...(status === null ? {} : { status }) } };
}

/** The maker envelope and the history row share one durable identity. */
export function turnErrorPayload(row) {
  return { sessionId: row.sessionId, persistId: row.clientId, event: { type: 'error',
    data: { ...row.content, isTerminal: true, willRetry: false } } };
}

/** Latest native turn boundary, not the latest error in an arbitrary history page. */
export function turnStateFromEvents(events, sessionId) {
  if (!Array.isArray(events)) throw new TypeError('Native turn recovery requires a session event snapshot');
  let boundary = null;
  let seq = -1;
  for (const event of events) {
    if (!Number.isSafeInteger(event?.seq) || event.seq < 0 || event.seq <= seq
      || (seq >= 0 && event.seq !== seq + 1)) {
      throw new TypeError('Native turn recovery requires ordered unique event sequences');
    }
    seq = event.seq;
    if (event.type === 'turn/start' || event.type === 'turn/end') boundary = event;
  }
  if (!boundary) return null;
  if (boundary.type === 'turn/start') return { seq, boundarySeq: boundary.seq, running: true, error: null };
  const error = turnErrorRow(boundary, sessionId);
  // A malformed failure is not evidence of a successful ending.
  if (boundary.data?.reason?.kind === 'error' && !error) throw new TypeError('Invalid native failed-turn identity');
  return { seq, boundarySeq: boundary.seq, running: false, error };
}
