/** Disposable display projection, never a retry policy, budget or error store.
 * Live delivery and cold replay consume the same committed DSH events. */
const natural = value => Number.isSafeInteger(value) && value >= 0;
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
export const RETRY_PRESENTATION_EVENTS = new Set([
  'turn/start', 'turn/end', 'step/start', 'assistant/message', 'llm/retry', 'llm/retry-started',
]);

export function reduceRetryPresentation(previous, event) {
  if (!RETRY_PRESENTATION_EVENTS.has(event?.type) || !natural(event.seq)
    || event.seq <= (previous?.seq ?? -1) || !natural(event.data?.turn)) return previous;
  const data = event.data;
  if (event.type === 'turn/start') {
    return { seq: event.seq, turn: data.turn, running: true, retry: null };
  }
  if (previous && data.turn !== previous.turn) return previous;
  if (event.type === 'turn/end') {
    return { seq: event.seq, turn: data.turn, running: false, retry: null };
  }
  // A late attempt cannot reopen an ended turn, even if its seq is higher.
  if (previous?.running === false) return previous;
  const next = { seq: event.seq, turn: data.turn, running: true, retry: null };
  if (event.type === 'llm/retry') {
    if (!identity(data.retryId) || !natural(data.step) || !natural(data.retry) || data.retry < 1
      || !['normal', 'always'].includes(data.mode) || !Number.isFinite(data.delayMs) || data.delayMs < 0) return next;
    // Keep only display facts, never provider prose, credentials or arbitrary diagnostics.
    next.retry = { retryId: data.retryId, step: data.step, attempt: data.retry, mode: data.mode,
      maxAttempts: natural(data.maxRetries) && data.maxRetries >= data.retry ? data.maxRetries : null,
      transport: data.failure?.code === 'TRANSPORT', phase: 'waiting' };
  } else if (event.type === 'llm/retry-started') {
    const retry = previous?.retry;
    if (retry && retry.retryId === data.retryId && retry.step === data.step && retry.attempt === data.retry) {
      // Starting a request is not evidence of recovery. Preserve its progress until
      // real step/assistant progress or an authoritative turn boundary clears it.
      next.retry = { ...retry, phase: 'started' };
    }
  }
  return next;
}

/** Cindy's existing finite transport-reconnect text protocol; no persistId/row. */
export function retryPresentationEvent(state) {
  const retry = state?.running && state.retry;
  if (!retry || retry.mode !== 'normal' || !retry.transport || retry.maxAttempts === null) return null;
  return { type: 'error', data: { isTerminal: false, willRetry: true, reason: 'dsh-model-retry',
    message: `Reconnecting... ${retry.attempt}/${retry.maxAttempts}` } };
}
