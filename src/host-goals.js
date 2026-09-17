/**
 * Read DSH's goal state for one session, without waking it.
 *
 * `ctx.goals` is keyed by `Agent`, and the only public way to obtain a session's
 * Agent is `sessionController.resolveAgent(sessionId)` — which **resumes** the
 * session. The controller asks for goal status on *every* session open, so
 * resuming on a status read would be a side effect nobody asked for.
 *
 * It is also unnecessary: `dsh-goal` registers a session projection under the key
 * `goal`, and projection frames ride the same `sessionController.control()`
 * stream this Host already folds for the input queue. So the goal arrives as
 * data, and a status read costs nothing. That stream is a baseline followed by
 * replacements, and both halves matter: a replacement only follows a *change*,
 * so a goal that already existed when the stream opened arrives in the baseline
 * and nowhere else.
 *
 * The two vocabularies line up for free — DSH phases are `active | paused |
 * blocked | complete`, a direct subset of the controller's
 * `… | budgetLimited | usageLimited` (`maker-shared/deviceLinkContract.ts`).
 * This Host has no budget or usage limits for goals, so those two are never
 * emitted rather than invented.
 */

/** Projection key DSH's goal service registers. */
export const GOAL_PROJECTION_KEY = 'goal';

/**
 * Fold projection frames out of the control stream.
 *
 * `undefined` and `null` mean different things to the controller — "never
 * fetched" versus "fetched, no goal" — so an unset key stays `undefined` rather
 * than being flattened to `null`. That distinction only holds for a session the
 * stream never named: a session the baseline named without a `goal` key has been
 * fetched, and reports no goal.
 * @returns the tracker the runtime feeds and the channel reads.
 */
export function createProjectionTracker() {
  /** sessionId -> Map<key, value> */
  const bySession = new Map();

  /** Apply one `SessionControlFrame`; anything that is not a projection is ignored. */
  function apply(frame) {
    if (frame === null || typeof frame !== 'object') return;
    // The stream opens with one complete baseline, and a replacement frame only
    // follows a *change*. A goal created before this Host connected — or while
    // it was disconnected — is therefore carried by the baseline alone, so
    // ignoring it reported "no goal" for a goal that exists. The baseline also
    // replaces the maps rather than merging into them: state folded from a
    // previous stream is not evidence about the current one.
    if (frame.type === 'baseline') {
      bySession.clear();
      const blocks = frame.value?.projections;
      if (blocks === null || typeof blocks !== 'object') return;
      for (const [sessionId, block] of Object.entries(blocks)) {
        if (sessionId === '' || block === null || typeof block !== 'object') continue;
        const values = block.values;
        if (values === null || typeof values !== 'object') continue;
        if (!Object.prototype.hasOwnProperty.call(values, GOAL_PROJECTION_KEY)) continue;
        bySession.set(sessionId, new Map([[GOAL_PROJECTION_KEY, values[GOAL_PROJECTION_KEY]]]));
      }
      return;
    }
    if (frame.type !== 'projection') return;
    if (typeof frame.sessionId !== 'string' || frame.sessionId === '') return;
    if (typeof frame.key !== 'string' || frame.key === '') return;
    const values = bySession.get(frame.sessionId) ?? new Map();
    values.set(frame.key, frame.value);
    bySession.set(frame.sessionId, values);
  }

  /** One projection value, or undefined when the stream has never carried it. */
  function valueOf(sessionId, key) {
    return bySession.get(sessionId)?.get(key);
  }

  /** The raw DSH goal projection for one session. */
  function goalOf(sessionId) {
    return valueOf(sessionId, GOAL_PROJECTION_KEY);
  }

  function clear() {
    bySession.clear();
  }

  return { apply, valueOf, goalOf, clear };
}

/**
 * Normalise the two shapes a goal value arrives in.
 *
 * The `goal` projection is `{ goal: GoalSnapshot, roundsStarted, createdAt, … }`,
 * while a live service view is the snapshot **flattened** with the same counters
 * (`GoalView`). Both describe the same goal, so both must produce the same
 * controller payload — a second mapper for the second shape is exactly the kind
 * of drift that has already cost this Host a day on session rows.
 * @param value - a projection value or a service view.
 * @returns the snapshot and its counters, or null when there is no goal.
 */
function normalizeGoal(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return null;
  // A projection always wraps its snapshot under `goal`; a view never has the key.
  const isProjection = Object.prototype.hasOwnProperty.call(value, 'goal');
  const snapshot = isProjection ? value.goal : value;
  if (snapshot === null || typeof snapshot !== 'object') return null;
  // A flattened view is only a goal when it carries the snapshot's own phase.
  // Without this, any stray object with an `id` — a `clear` tombstone ref, say,
  // or a malformed frame — would be reported to the controller as a live goal,
  // and an "active" card for a goal that no longer exists is worse than none.
  if (typeof snapshot.phase !== 'string') return null;
  return { snapshot, counters: value };
}

/**
 * Map one DSH goal projection onto the controller's status payload.
 *
 * Accepts either the projection value or a live `GoalView`, so a status read and
 * the answer to a write cannot disagree about the same goal.
 * @param sessionId - the session the projection belongs to.
 * @param value - the raw projection value or service view.
 * @returns the controller payload, or null when the session has no goal. An
 *   `undefined` value means "unknown", which is not the same answer.
 */
export function toGoalStatusPayload(sessionId, value) {
  if (value === undefined) return undefined;
  const normalized = normalizeGoal(value);
  if (normalized === null) return null;

  const { snapshot: goal, counters } = normalized;
  const phase = typeof goal.phase === 'string' ? goal.phase : 'active';
  const blockedMessage = goal.blockedReason?.message;
  return {
    sessionId,
    // DSH's four phases are a direct subset of the controller's vocabulary.
    status: phase,
    objective: typeof goal.objective === 'string' ? goal.objective : '',
    // DSH counts continuation rounds, which is what the controller shows.
    turnsUsed: Number.isFinite(counters.roundsStarted) ? counters.roundsStarted : 0,
    // This Host tracks no token budget for a goal, so it reports none rather
    // than a fabricated zero that the controller would render as real usage.
    tokensUsed: 0,
    maxTurns: Number.isFinite(goal.maxGoalRounds) ? goal.maxGoalRounds : null,
    noProgressLimit: null,
    budgetTokens: null,
    usageResetAt: null,
    startedAt: Number.isFinite(counters.createdAt) ? counters.createdAt : 0,
    lastReason: typeof blockedMessage === 'string' && blockedMessage !== '' ? blockedMessage : null,
  };
}

/**
 * DSH's goal has exactly one limit — `maxGoalRounds`. The controller's form
 * offers three.
 *
 * `maxTurns` maps onto it. `budgetTokens` and `noProgressLimit` have no DSH
 * counterpart and are therefore not sent: the status read reports both as null,
 * so the controller's own panel shows them unset. Silently accepting them would
 * let the user believe a guard exists that this Host never enforces — the same
 * rule that keeps this Host from inventing a token count.
 * @param limits - the controller's `MobileGoalLimitsInput`.
 * @returns the round cap to send, or undefined to let DSH apply its default.
 */
function roundsFromLimits(limits) {
  const value = limits?.maxTurns;
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Map a DSH `GoalError` onto a code the controller can show. */
function goalWriteFailure(error) {
  const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'THREW';
  const message = typeof error?.message === 'string' && error.message !== '' ? error.message : String(error);
  return { ok: false, code, message };
}

/**
 * Perform the controller's goal write commands against DSH's own goal service.
 *
 * Reads stay projection-based (see the module note above); writes cannot. A
 * mutation is compare-and-set on a live `Agent`, so this **resumes** the session
 * through `sessionController.resolveAgent` — a side effect that is acceptable
 * for an action the user just took, and unacceptable for a status read, which is
 * why the two paths are separate.
 *
 * @param options - the DSH goal service and the agent resolver.
 * @returns the writer the channel layer calls, one method per channel.
 */
export function createGoalWriter({ goals, resolveAgent }) {
  /** Resolve the live agent a mutation needs, or a stable failure. */
  async function agentFor(sessionId) {
    if (typeof resolveAgent !== 'function') {
      return { ok: false, code: 'NOT_AVAILABLE', message: 'This DSH Host cannot resolve a session agent' };
    }
    let resolved;
    try {
      resolved = await resolveAgent(sessionId);
    } catch (error) {
      return goalWriteFailure(error);
    }
    if (resolved?.agent !== undefined) return { ok: true, agent: resolved.agent };
    const message = resolved?.error?.message;
    return { ok: false, code: 'NOT_FOUND', message: typeof message === 'string' ? message : `No live DSH agent for ${sessionId}` };
  }

  /**
   * The current goal's compare-and-set identity.
   *
   * Every DSH mutation carries the revision it expects, so this read is not
   * optional bookkeeping: it is the concurrency token, and it must come from the
   * live service rather than the folded projection, which can trail a mutation.
   */
  function refFor(agent, sessionId) {
    let view;
    try {
      view = goals.get(agent);
    } catch (error) {
      return goalWriteFailure(error);
    }
    if (view === undefined || view === null) {
      return { ok: false, code: 'NOT_FOUND', message: `No goal on ${sessionId}` };
    }
    return { ok: true, ref: { id: view.id, revision: view.revision } };
  }

  /** Run one mutation and answer the controller with the goal's new state. */
  async function mutate(sessionId, run, { needsGoal = true } = {}) {
    if (typeof goals !== 'object' || goals === null) {
      return { ok: false, code: 'NOT_AVAILABLE', message: 'This DSH Host composes no goal service' };
    }
    const found = await agentFor(sessionId);
    if (!found.ok) return found;

    let ref;
    if (needsGoal) {
      const current = refFor(found.agent, sessionId);
      if (!current.ok) return current;
      ref = current.ref;
    }

    let view;
    try {
      view = run(found.agent, ref);
    } catch (error) {
      return goalWriteFailure(error);
    }
    // A clear leaves no goal; the controller reads that as `null`, not as absent.
    let after;
    try {
      after = goals.get(found.agent);
    } catch {
      after = undefined;
    }
    return { ok: true, status: toGoalStatusPayload(sessionId, after ?? view ?? null) };
  }

  return {
    /** `maker:goal:set` — the controller's create form. */
    async set({ sessionId, objective, limits }) {
      const text = typeof objective === 'string' ? objective.trim() : '';
      if (text === '') return { ok: false, code: 'BAD_REQUEST', message: 'maker:goal:set needs an objective' };
      const rounds = roundsFromLimits(limits);
      return mutate(sessionId, (agent) => goals.create(agent, {
        objective: text,
        ...(rounds === undefined ? {} : { maxGoalRounds: rounds }),
      }), { needsGoal: false });
    },
    pause: (sessionId) => mutate(sessionId, (agent, ref) => goals.pause(agent, ref)),
    resume: (sessionId) => mutate(sessionId, (agent, ref) => goals.resume(agent, ref)),
    clear: (sessionId) => mutate(sessionId, (agent, ref) => goals.clear(agent, ref)),
    /** `maker:goal:update` — objective and/or round cap, phase untouched. */
    async update({ sessionId, patch }) {
      const request = {};
      const objective = typeof patch?.objective === 'string' ? patch.objective.trim() : '';
      if (objective !== '') request.objective = objective;
      const rounds = roundsFromLimits(patch?.limits);
      if (rounds !== undefined) request.maxGoalRounds = rounds;
      if (request.objective === undefined && request.maxGoalRounds === undefined) {
        // DSH rejects an edit with nothing to change; say so locally instead of
        // surfacing the service's own wording for an input it never saw.
        return { ok: false, code: 'BAD_REQUEST', message: 'maker:goal:update needs an objective or a round limit' };
      }
      return mutate(sessionId, (agent, ref) => goals.edit(agent, ref, request));
    },
  };
}
