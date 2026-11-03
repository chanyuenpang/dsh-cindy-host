import { refusalError } from './cindy-channels.js';

const COMPACT_DEFINITION = '@deepseek-ai/dsh-command-compact';

/** Native scoped command execution, not a model prompt or a shadow compaction engine. */
export function createDshManualCompact({ getCommands, getSession, resolveAgent, isHidden = () => false,
  onSettled = () => {}, now = Date.now, maxReceipts = 128, receiptTtlMs = 15 * 60_000 }) {
  const active = new Map();
  const receipts = new Map();
  let disposed = false;
  const unavailable = text => refusalError('NOT_AVAILABLE', text);
  function check(signal) {
    if (disposed || signal.aborted) throw unavailable('Manual compaction cancelled; native state may already have committed');
  }
  function run({ sessionId, instructions, requestKey, signal }) {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') return Promise.reject(refusalError('BAD_REQUEST', 'compact-session needs a session id'));
    if (instructions !== undefined && typeof instructions !== 'string') return Promise.reject(refusalError('BAD_REQUEST', 'instructions must be a string'));
    if (instructions?.trim()) return Promise.reject(unavailable('Native DSH /compact does not accept custom instructions'));
    if (requestKey !== undefined && (typeof requestKey !== 'string' || requestKey.length > 1024)) return Promise.reject(refusalError('BAD_REQUEST', 'Invalid compaction request identity'));
    if (disposed) return Promise.reject(unavailable('Manual compaction is no longer composed'));
    for (const [key, receipt] of receipts) if (!receipt.pending && now() - receipt.at > receiptTtlMs) receipts.delete(key);
    const previous = requestKey === undefined ? undefined : receipts.get(requestKey);
    if (previous) {
      if (previous.sessionId !== sessionId) return Promise.reject(refusalError('BAD_REQUEST', 'Compaction request identity was reused for another session'));
      return previous.promise;
    }
    if (active.size >= maxReceipts) return Promise.reject(unavailable('Too many active manual compaction requests'));
    while (receipts.size >= maxReceipts) {
      const oldest = [...receipts].find(([, receipt]) => !receipt.pending);
      if (!oldest) return Promise.reject(unavailable('Too many pending manual compaction requests'));
      receipts.delete(oldest[0]);
    }
    const promise = Promise.resolve().then(() => perform(sessionId, signal));
    if (requestKey !== undefined) {
      const receipt = { sessionId, promise, pending: true, at: now() };
      receipts.set(requestKey, receipt);
      void promise.then(() => { receipt.pending = false; receipt.at = now(); }, () => { receipt.pending = false; receipt.at = now(); });
    }
    return promise;
  }
  async function perform(sessionId, callerSignal) {
    if (active.size >= maxReceipts) throw unavailable('Too many active manual compaction requests');
    if (active.has(sessionId)) throw unavailable('A manual compaction request is already active for this session');
    const controller = new AbortController();
    const signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal;
    active.set(sessionId, controller);
    let entered = false;
    let failed = false;
    try {
      check(signal);
      const commands = getCommands();
      if (typeof commands?.find !== 'function' || typeof commands?.execute !== 'function' || typeof resolveAgent !== 'function') {
        throw unavailable('Native scoped commands are not composed on this DSH profile');
      }
      if (isHidden(sessionId)) throw unavailable('An archived or hidden session cannot be compacted');
      const row = await getSession(sessionId);
      check(signal);
      if (!row) throw refusalError('NOT_FOUND', 'No visible ordinary DSH session to compact');
      const resolved = await resolveAgent(sessionId);
      check(signal);
      if (resolved?.error !== undefined) throw resolved.error;
      if (!resolved?.agent) throw unavailable('Native DSH could not resolve the receiving agent');
      if (getCommands() !== commands) throw unavailable('Native command service changed during compaction admission');
      const definition = commands.find(resolved.agent, 'compact');
      if (definition?.definitionId !== COMPACT_DEFINITION) throw unavailable('The target preset does not expose native DSH /compact');
      entered = true;
      const execution = await commands.execute(resolved.agent, '/compact', [], signal);
      check(signal);
      if (execution?.result?.kind !== 'success') {
        throw unavailable(execution?.result?.text ?? 'Native /compact did not complete successfully');
      }
      // Only the verified native command has this contract: actual compaction
      // reports summarySeq; benign no-history success omits it. Never parse prose.
      const seq = execution.result.sourceEventSeq;
      if (seq !== undefined && (!Number.isSafeInteger(seq) || seq < 0)) throw new Error('Native compact returned an invalid summary sequence');
      return seq === undefined ? { noop: true } : {};
    } catch (error) {
      failed = true;
      if (signal.aborted) throw unavailable('Manual compaction cancelled; native state may already have committed');
      throw error;
    } finally {
      active.delete(sessionId);
      // A failed command may already have appended/checkpointed events. Refresh
      // on either outcome; do not hide a persistence error or promise a rollback.
      if (entered) {
        try { await onSettled(sessionId); } catch (error) { if (!failed) throw error; }
      }
    }
  }
  function cancelSession(sessionId, reason = 'Manual compaction stopped') {
    active.get(sessionId)?.abort(new Error(reason));
  }
  function cancelAll(reason = 'Manual compaction source disconnected') {
    for (const controller of active.values()) controller.abort(new Error(reason));
  }
  function dispose() { disposed = true; cancelAll(); receipts.clear(); }
  return { run, cancelSession, cancelAll, dispose };
}
