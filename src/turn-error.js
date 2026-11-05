/** Display-only native turn diagnostics. DSH owns failure, recovery and retry policy. */
import { advanceInterruptionMetadata } from './diagnostic-presentation.js';
const SAFE_MESSAGES = new Map([
  ['AUTH', 'Model authentication failed. Check the provider configuration.'],
  ['ACCOUNT_SIGNED_OUT', '任务已因退出 DeepSeek 登录而停止。'],
  ['ACCOUNT_SIGN_IN_REQUIRED', '请先登录 DeepSeek，并确认请求地址支持账号认证。'],
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
  const content = safeFailureContent(event.data.reason.error);
  const id = `${sessionId}:turn-error:${event.seq}`;
  return { id, clientId: id, sessionId, role: 'error', toolUseId: null, agentMeta: null,
    createdAt: new Date(event.time).toISOString(), content };
}

/** One safe allowlist for terminal model failures and scheduled retry details. */
export function safeFailureContent(failure) {
  const code = SAFE_MESSAGES.has(failure?.code) ? failure.code : null;
  const status = Number.isInteger(failure?.status) && failure.status >= 100 && failure.status <= 599 ? failure.status : null;
  const detail = [code, status === null ? null : `HTTP ${status}`].filter(Boolean).join('; ');
  const message = (SAFE_MESSAGES.get(code) ?? 'This turn failed. See the local DSH diagnostics for details.')
    + (detail ? ` (${detail})` : '');
  return { message, reason: 'dsh-turn-error', ...(code ? { code } : {}), ...(status === null ? {} : { status }) };
}

/** The maker envelope and the history row share one durable identity. */
export function turnErrorPayload(row) {
  return { sessionId: row.sessionId, persistId: row.clientId, event: { type: 'error',
    data: { ...row.content, isTerminal: true, willRetry: false } } };
}

/** User-visible desktop turn tails, kept separate from model failures. Never
 * infer an interruption from an ordinary aborted turn or an arbitrary string. */
export function turnDiagnosticRow(event, sessionId) {
  const failure = turnErrorRow(event, sessionId);
  if (failure) return failure;
  if (!Number.isSafeInteger(event?.seq) || event.seq < 0 || !Number.isFinite(event.time)
    || !Number.isFinite(new Date(event.time).getTime()) || typeof sessionId !== 'string' || !sessionId) return null;
  let content;
  const data = event.data;
  if (event.type === 'turn/end') {
    const reason = data?.reason;
    switch (reason?.kind) {
      case 'interrupted':
        content = '任务已停止：DSH 进程在本轮完成前退出（例如被强制结束、崩溃或关闭超时），重新启动后本轮已中止。未完成的工具调用结果未知。';
        break;
      case 'max-tokens':
        content = '已达到输出 token 上限。回答被截断，已有输出保留在对话中。发送“继续”可让模型接着输出。';
        break;
      case 'blocked': content = '本轮执行被阻止，未正常完成。原生结束事件未提供更多原因。'; break;
      case 'aborted':
        content = reason.reason?.kind === 'hook' && reason.reason.reason === 'deepseek-account/signed-out'
          ? '任务已因退出 DeepSeek 登录而停止。'
          : reason.reason?.kind === 'user' ? '任务已停止：用户取消了本轮执行。'
          : reason.reason?.kind === 'parent' ? '任务已停止：上级任务取消了本轮执行。'
          : reason.reason?.kind === 'disposed' ? '任务已停止：本轮运行实例已被释放。'
          : '任务已停止：本轮执行已被取消。';
        break;
      default:
        if (!reason || typeof reason.kind !== 'string' || ['completed', 'forked'].includes(reason.kind)) return null;
        content = '本轮已结束。当前 Host 尚不能显示此结束原因的详细信息，请在 DSH 桌面查看。';
        break;
    }
  } else if (event.type === 'llm/retry') {
    if (!['normal', 'always'].includes(data?.mode) || !Number.isSafeInteger(data?.retry) || data.retry < 1 || !Number.isFinite(data.delayMs) || data.delayMs < 0) return null;
    const maximum = data.mode === 'always' ? '不限' : Number.isSafeInteger(data.maxRetries) && data.maxRetries >= data.retry ? data.maxRetries : null;
    if (maximum === null) return null;
    content = `模型请求失败，DSH 已安排重试（${data.retry}/${maximum}），等待 ${Math.max(1, Math.ceil(data.delayMs / 1000))} 秒。${safeFailureContent(data.failure).message}`;
  } else if (event.type === 'llm/retry-started') {
    if (!Number.isSafeInteger(data?.retry) || data.retry < 1) return null;
    content = `DSH 已开始第 ${data.retry} 次模型请求重试。`;
  } else return null;
  const id = `${sessionId}:turn-notice:${event.seq}`;
  return { id, clientId: id, sessionId, role: 'system', toolUseId: null, agentMeta: null,
    createdAt: new Date(event.time).toISOString(), content };
}

/** Notices close the running flag without pretending cancellation is a model failure. */
export function turnDiagnosticPayload(row) {
  if (row.role === 'error' && row.content?.dismissed === true) return { sessionId: row.sessionId, persistId: row.clientId, event: { type: 'done', data: { reason: 'dsh-dismissed-error' } } };
  return row.role === 'error' ? turnErrorPayload(row) : { sessionId: row.sessionId, persistId: row.clientId,
    event: { type: 'done', data: { message: row.content, reason: 'dsh-turn-notice' } } };
}

/** Latest native turn boundary, not the latest error in an arbitrary history page. */
export function turnStateFromEvents(events, sessionId) {
  if (!Array.isArray(events)) throw new TypeError('Native turn recovery requires a session event snapshot');
  let boundary = null;
  let nativeMetadata = null;
  let retryNotice = null;
  let seq = -1;
  for (const event of events) {
    if (!Number.isSafeInteger(event?.seq) || event.seq < 0 || event.seq <= seq
      || (seq >= 0 && event.seq !== seq + 1)) {
      throw new TypeError('Native turn recovery requires ordered unique event sequences');
    }
    seq = event.seq;
    nativeMetadata = advanceInterruptionMetadata(nativeMetadata, event, sessionId);
    if (event.type === 'turn/start' || event.type === 'turn/end') { boundary = event; retryNotice = null; }
    else if (['step/start', 'assistant/message'].includes(event.type)) retryNotice = null;
    else if (boundary?.type === 'turn/start' && boundary.data?.turn === event.data?.turn
      && ['llm/retry', 'llm/retry-started'].includes(event.type)) retryNotice = turnDiagnosticRow(event, sessionId);
  }
  if (!boundary) return null;
  if (boundary.type === 'turn/start') return { seq, boundarySeq: boundary.seq, running: true, error: null, nativeMetadata, ...(retryNotice ? { retryNotice } : {}) };
  const diagnostic = turnDiagnosticRow(boundary, sessionId);
  const error = diagnostic?.role === 'error' ? diagnostic : null;
  // A malformed failure is not evidence of a successful ending.
  if (boundary.data?.reason?.kind === 'error' && !error) throw new TypeError('Invalid native failed-turn identity');
  if (['interrupted', 'max-tokens', 'blocked', 'aborted'].includes(boundary.data?.reason?.kind) && !diagnostic) throw new TypeError('Invalid native turn-notice identity');
  return { seq, boundarySeq: boundary.seq, running: false, error, nativeMetadata, interruption: nativeMetadata?.interruption ?? null, ...(diagnostic?.role === 'system' ? { notice: diagnostic } : {}) };
}
