/**
 * The inbound half of DSH approvals: a question DSH asks, answered by the Cindy
 * controller instead of the local UI.
 *
 * DSH raises `approval/request` as a **waterfall** event
 * (`@deepseek-ai/dsh-user-approval`), and the chain's terminal answerer is
 * fail-closed. That shape dictates the whole design here:
 *
 *  - if no Cindy controller is watching the asking session, this registry is not
 *    in the chain's business and the answerer must call `next()` so the local UI
 *    (or the fail-closed default) decides — a Host must never swallow a question
 *    the user could have answered at the desk;
 *  - if a controller *is* watching, the question is registered, pushed, and the
 *    answerer waits for the phone's `maker:resolve-interaction`.
 *
 * Outcomes are DSH's own vocabulary (`'allowed-once' | 'rejected' | 'cancelled' |
 * 'unavailable'`), not the controller's: `'allowed-once'` is the only grant DSH
 * defines, so every non-allow answer maps to `'rejected'`.
 */

/** The controller's interaction kind for a permission question. */
export const PERMISSION_KIND = 'permission';

/**
 * Map a controller decision onto a DSH approval outcome.
 *
 * The controller sends `{ kind: 'permission', behavior: 'allow' | … }`.
 * @param decision - the raw `maker:resolve-interaction` decision.
 * @returns the outcome, or null when this is not a permission decision.
 */
export function decisionOutcome(decision) {
  if (decision === null || typeof decision !== 'object') return null;
  if (typeof decision.kind === 'string' && decision.kind !== PERMISSION_KIND) return null;
  const behavior = typeof decision.behavior === 'string'
    ? decision.behavior
    : (typeof decision.decision === 'string' ? decision.decision : null);
  if (behavior === null) return null;
  return behavior === 'allow' ? 'allowed-once' : 'rejected';
}

/**
 * The controller's interaction kind for a structured question.
 *
 * DSH's `user-questions/request` waterfall is a *different* seam from
 * `approval/request`, and the controller renders it as its own card — but the
 * answer travels the same `maker:resolve-interaction` channel, so both share this
 * registry and are told apart by kind. Without an answerer here the tool call
 * waits for a human nobody can answer, and the conversation stops.
 */
export const QUESTION_KIND = 'ask_user_question';

/**
 * Translate the controller's question answer into DSH's shape.
 *
 * The two sides key answers differently, and that is the whole job:
 *  - the controller answers by **question text** (`answerKey` is the question's
 *    own string), one string per question, JSON-encoded as an array when the
 *    question is multi-select;
 *  - DSH answers by question **id**, as `{ id, selected: string[], custom? }`.
 *
 * The questions that were asked are therefore the lookup table, and anything the
 * controller returned that is not one of the offered labels is carried as
 * `custom` rather than silently dropped.
 *
 * @param questions - the DSH questions that were asked.
 * @param decision - the controller's `{ kind, answers }`.
 * @returns DSH's `AskUserQuestionAnswer`.
 */
export function questionAnswerOf(questions, decision) {
  // The decision's own kind must match: a permission decision aimed at a
  // question would otherwise be read as "every question unanswered", which the
  // controller would take as a real answer.
  if (decision?.kind !== undefined && decision.kind !== QUESTION_KIND) return null;
  const given = decision?.answers;
  if (given === null || typeof given !== 'object') return { answers: [] };
  const answers = [];
  for (const question of Array.isArray(questions) ? questions : []) {
    const raw = given[question?.question];
    const labels = new Set((Array.isArray(question?.options) ? question.options : [])
      .map((option) => (typeof option?.label === 'string' ? option.label : ''))
      .filter((label) => label !== ''));
    let chosen = typeof raw === 'string' && raw !== '' ? [raw] : [];
    if (chosen.length > 0 && question?.multiSelect === true) {
      try {
        const parsed = JSON.parse(chosen[0]);
        if (Array.isArray(parsed)) chosen = parsed.filter((entry) => typeof entry === 'string' && entry !== '');
      } catch {
        // Not the encoded array: keep the single string as given.
      }
    }
    const selected = chosen.filter((label) => labels.has(label));
    const free = chosen.filter((label) => !labels.has(label));
    answers.push({
      id: String(question?.id ?? ''),
      selected,
      ...(free.length === 0 ? {} : { custom: free.join(', ') }),
    });
  }
  return { answers };
}

/**
 * Build the pending-interaction registry.
 * @param options - injectable clock and timers.
 * @returns the registry the channels and the answerers share.
 */
export function createApprovalRegistry({
  now = () => new Date(),
  timeoutMs = 120_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onDismissed,
} = {}) {
  /** requestId -> { sessionId, request, settle, timer } */
  const pending = new Map();
  let counter = 0;

  function nextRequestId(prefix = 'dsh-approval') {
    counter += 1;
    return `${prefix}-${counter}`;
  }

  /**
   * Register one pending interaction and hand back its lifetime controls.
   *
   * Both seams go through here so their timeouts, aborts and dismissals behave
   * identically — a question that can hang a turn deserves the same care as an
   * approval that can.
   */
  function register({ sessionId, request, prefix, signal, answerOf }) {
    let settle;
    const answered = new Promise((resolve) => {
      settle = resolve;
    });

    const finish = (outcome) => {
      const entry = pending.get(request.requestId);
      if (entry === undefined) return;
      pending.delete(request.requestId);
      if (entry.timer !== null) clearTimer(entry.timer);
      if (entry.onAbort !== null && signal !== undefined) signal.removeEventListener('abort', entry.onAbort);
      // Every close — answered, timed out, or withdrawn — tells the watching
      // controllers the card is done. Without it a second screen keeps showing a
      // question that no longer exists, and the panel only clears on its next
      // poll.
      if (typeof onDismissed === 'function') {
        try {
          onDismissed({ sessionId, requestId: request.requestId });
        } catch {
          // A broken listener must not strand the answer the asker is waiting on.
        }
      }
      settle(outcome);
    };

    // The asker withdrawing the question settles it immediately, and a late
    // answer from the controller is then discarded by `finish`'s guard.
    const onAbort = signal === undefined ? null : () => finish(answerOf.cancelled);
    if (onAbort !== null) signal.addEventListener('abort', onAbort, { once: true });

    const timer = timeoutMs > 0
      ? setTimer(() => finish(answerOf.cancelled), timeoutMs)
      : null;
    if (typeof timer?.unref === 'function') timer.unref();

    pending.set(request.requestId, { sessionId, request, settle: finish, timer, onAbort, answerOf });
    return { requestId: request.requestId, request, answered };
  }

  /**
   * Register a question and wait for the controller's answer.
   * @param options - the question, the asking session, and the caller's abort signal.
   * @returns DSH's outcome vocabulary.
   */
  async function ask({ sessionId, toolName, reason, callId, signal }) {
    const requestId = nextRequestId();
    const request = {
      kind: PERMISSION_KIND,
      requestId,
      sessionId,
      toolName,
      ...(typeof reason === 'string' && reason !== '' ? { reason } : {}),
      ...(typeof callId === 'string' ? { callId } : {}),
      createdAt: now().toISOString(),
    };
    // DSH's approval vocabulary, and the controller's mapping onto it.
    return register({
      sessionId,
      request,
      signal,
      answerOf: {
        cancelled: 'cancelled',
        from: (decision) => decisionOutcome(decision),
      },
    });
  }

  /**
   * Register a structured question and wait for the controller's answer.
   *
   * DSH's `user-questions/request` waterfall blocks the tool call until this
   * resolves, which is why it cannot be left unanswered: a controller that never
   * sees the card cannot answer it, and the conversation stops there.
   *
   * @param options - the questions, the asking session, and the caller's abort signal.
   * @returns DSH's `AskUserQuestionAnswer`; a cancellation answers every question with nothing.
   */
  async function askUser({ sessionId, questions, signal }) {
    const items = Array.isArray(questions) ? questions : [];
    const requestId = nextRequestId('dsh-question');
    const request = {
      kind: QUESTION_KIND,
      requestId,
      sessionId,
      // The controller reads `questions` and keys its answer by the question text.
      questions: items.map((question) => ({ ...question })),
      createdAt: now().toISOString(),
    };
    const cancelled = { answers: items.map((question) => ({ id: String(question?.id ?? ''), selected: [] })) };
    return register({
      sessionId,
      request,
      signal,
      answerOf: {
        cancelled,
        from: (decision) => questionAnswerOf(items, decision),
      },
    });
  }

  /** The questions still open for one session, in the controller's shape. */
  function list(sessionId) {
    const rows = [];
    for (const entry of pending.values()) {
      if (sessionId !== undefined && entry.sessionId !== sessionId) continue;
      rows.push({ request: { ...entry.request } });
    }
    return rows;
  }

  /**
   * Answer one pending interaction.
   *
   * The mapping comes from the **stored** entry, not from the decision's own
   * kind: the entry knows which seam is waiting, so a permission decision aimed
   * at a question — or the reverse — is refused rather than mistranslated.
   * @param requestId - the id the controller echoes back.
   * @param decision - the controller's decision payload.
   * @returns whether the answer was accepted.
   */
  function settle(requestId, decision) {
    const entry = pending.get(requestId);
    if (entry === undefined) return { accepted: false };
    const outcome = entry.answerOf.from(decision);
    if (outcome === null) return { accepted: false };
    entry.settle(outcome);
    return { accepted: true };
  }

  /** Forget every open question (the switch going off). */
  function clear() {
    for (const requestId of [...pending.keys()]) {
      pending.get(requestId).settle(pending.get(requestId).answerOf.cancelled);
    }
  }

  return { ask, askUser, list, settle, clear, size: () => pending.size };
}
