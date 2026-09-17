import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoalWriter, toGoalStatusPayload } from '../src/host-goals.js';

/** One live `GoalView`, exactly as `dsh-goal` returns it: the snapshot flattened. */
function view(overrides = {}) {
  return {
    id: 'goal-1',
    revision: 1,
    objective: 'ship it',
    phase: 'active',
    maxGoalRounds: 256,
    roundsStarted: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    activation: 'armed',
    ...overrides,
  };
}

/**
 * A fake `ctx.goals` that records the exact calls made.
 *
 * Every DSH mutation is compare-and-set on a revision, so the fake returns a
 * fresh revision per mutation: a writer that reused a stale ref would be visible
 * here rather than only against the real service.
 */
function fakeGoals(options = {}) {
  const calls = [];
  // `current: undefined` is meaningful here — it is exactly what DSH returns
  // when no goal is set — so the default must not swallow an explicit undefined.
  let live = Object.prototype.hasOwnProperty.call(options, 'current') ? options.current : view();
  const fail = options.fail ?? null;
  const bump = (patch, operation) => {
    calls.push({ operation, patch });
    live = { ...live, ...patch, revision: live.revision + 1 };
    return live;
  };
  return {
    calls,
    current: () => live,
    get: () => live,
    create: (agent, request) => {
      if (fail) throw fail;
      calls.push({ operation: 'create', agent, request });
      live = view({ objective: request.objective, maxGoalRounds: request.maxGoalRounds ?? 256 });
      return live;
    },
    pause: () => {
      if (fail) throw fail;
      return bump({ phase: 'paused' }, 'pause');
    },
    resume: () => {
      if (fail) throw fail;
      return bump({ phase: 'active' }, 'resume');
    },
    clear: () => {
      if (fail) throw fail;
      calls.push({ operation: 'clear' });
      live = undefined;
      return { id: 'goal-1', revision: 2 };
    },
    edit: (agent, ref, request) => {
      if (fail) throw fail;
      calls.push({ operation: 'edit', ref, request });
      live = { ...live, ...request, revision: live.revision + 1 };
      return live;
    },
  };
}

/** A writer over the given service, resolving to a live agent. */
function writer(goals, resolveResult = { agent: { session: { header: { id: 's1' } } } }) {
  return createGoalWriter({ goals, resolveAgent: async () => resolveResult });
}

test('set passes the objective and maps maxTurns onto DSHs one round cap', async () => {
  const goals = fakeGoals();
  const result = await writer(goals).set({
    sessionId: 's1',
    objective: '  ship it  ',
    limits: { maxTurns: 10, budgetTokens: 500_000, noProgressLimit: 3 },
  });

  assert.equal(result.ok, true);
  const create = goals.calls.find((call) => call.operation === 'create');
  assert.equal(create.request.objective, 'ship it', 'the objective is trimmed');
  assert.equal(create.request.maxGoalRounds, 10);
  // DSH has no token budget or no-progress guard for goals. Sending a field the
  // service ignores would be silent pretence, so only the real limit is sent —
  // and the status read below reports the other two as null.
  assert.equal('budgetTokens' in create.request, false);
  assert.equal('noProgressLimit' in create.request, false);
  assert.equal(result.status.maxTurns, 10);
  assert.equal(result.status.budgetTokens, null);
  assert.equal(result.status.noProgressLimit, null);
});

test('an unlimited form omits the cap instead of inventing a number', async () => {
  const goals = fakeGoals();
  // `null` is the controller's "no limit"; DSH's service applies its own default
  // only when the field is absent, so a fabricated 0 or 256 would be a change to
  // a setting the user never made.
  const result = await writer(goals).set({ sessionId: 's1', objective: 'go', limits: { maxTurns: null } });
  assert.equal(result.ok, true);
  assert.equal('maxGoalRounds' in goals.calls.find((call) => call.operation === 'create').request, false);
});

test('set refuses an empty objective rather than creating a blank goal', async () => {
  const goals = fakeGoals();
  for (const objective of [undefined, '', '   ']) {
    const result = await writer(goals).set({ sessionId: 's1', objective });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'BAD_REQUEST');
  }
  assert.equal(goals.calls.length, 0, 'nothing reached the service');
});

test('pause, resume and clear mutate the goal the service currently holds', async () => {
  for (const [method, expected] of [['pause', 'pause'], ['resume', 'resume'], ['clear', 'clear']]) {
    const goals = fakeGoals();
    const result = await writer(goals)[method]('s1');
    assert.equal(result.ok, true, `${method} must succeed`);
    assert.equal(goals.calls[0].operation, expected);
  }
});

test('a mutation carries the current revision as its compare-and-set token', async () => {
  const goals = fakeGoals({ current: view({ revision: 7 }) });
  await writer(goals).pause('s1');
  // The ref is not bookkeeping: DSH rejects a mutation whose revision is stale.
  assert.deepEqual(goals.calls[0].patch, { phase: 'paused' });
  assert.equal(goals.current().revision, 8, 'the service advanced the revision');
});

test('a command with no goal to act on says so instead of throwing', async () => {
  const goals = fakeGoals({ current: undefined });
  const result = await writer(goals).pause('s1');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NOT_FOUND');
  assert.equal(goals.calls.length, 0);
});

test("the service's own refusal code reaches the controller intact", async () => {
  const failure = Object.assign(new Error('goal "goal-1" already exists with phase "active"'), { code: 'GOAL_ALREADY_EXISTS' });
  const goals = fakeGoals({ fail: failure });
  const result = await writer(goals).set({ sessionId: 's1', objective: 'again' });
  // The controller shows this message, so the reason must not be flattened into
  // a generic failure the user cannot act on.
  assert.equal(result.ok, false);
  assert.equal(result.code, 'GOAL_ALREADY_EXISTS');
  assert.match(result.message, /already exists/);
});

test('an unresolvable session is reported as not found, not as a crash', async () => {
  const goals = fakeGoals();
  const result = await writer(goals, { error: { message: 'session/not-found' } }).pause('s1');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NOT_FOUND');
  assert.equal(result.message, 'session/not-found');
});

test('a Host with no goal service refuses all five commands', async () => {
  // The goal service is a separate plugin; without it the honest answer is
  // "not available", which the controller degrades on.
  const withoutService = createGoalWriter({ goals: undefined, resolveAgent: async () => ({ agent: {} }) });
  for (const call of [
    () => withoutService.set({ sessionId: 's1', objective: 'x' }),
    () => withoutService.pause('s1'),
    () => withoutService.resume('s1'),
    () => withoutService.clear('s1'),
    () => withoutService.update({ sessionId: 's1', patch: { objective: 'x' } }),
  ]) {
    const result = await call();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NOT_AVAILABLE');
  }
});

test('update edits what it is given and refuses an empty patch', async () => {
  const goals = fakeGoals();
  const edited = await writer(goals).update({ sessionId: 's1', patch: { objective: 'new goal', limits: { maxTurns: 20 } } });
  assert.equal(edited.ok, true);
  const call = goals.calls.find((entry) => entry.operation === 'edit');
  assert.deepEqual(call.request, { objective: 'new goal', maxGoalRounds: 20 });

  const empty = await writer(fakeGoals()).update({ sessionId: 's1', patch: {} });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'BAD_REQUEST');
});

test('clear answers null, which the controller reads as "no goal"', async () => {
  const goals = fakeGoals();
  const result = await writer(goals).clear('s1');
  assert.equal(result.ok, true);
  assert.equal(result.status, null, 'a cleared goal is fetched-and-absent, never unknown');
});

test('a live service view and a projection value produce the same payload', () => {
  // One goal, two shapes: the write path answers with a view while the status
  // read answers with the projection. Two mappers would drift, and the drift
  // would show as a goal card that changes when it is merely refetched.
  const flat = view({ roundsStarted: 3, blockedReason: { code: 'X', message: 'stuck' }, phase: 'blocked' });
  const projection = { goal: { id: flat.id, revision: flat.revision, objective: flat.objective, phase: flat.phase, maxGoalRounds: flat.maxGoalRounds, blockedReason: flat.blockedReason }, roundsStarted: 3, createdAt: flat.createdAt, updatedAt: flat.updatedAt };
  assert.deepEqual(toGoalStatusPayload('s1', flat), toGoalStatusPayload('s1', projection));
});
