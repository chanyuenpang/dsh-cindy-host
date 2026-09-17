import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectionTracker, toGoalStatusPayload, GOAL_PROJECTION_KEY } from '../src/host-goals.js';

/** A DSH `goal` projection value, as `dsh-goal`'s wire schema declares it. */
function goalValue(phase = 'active') {
  return {
    goal: { id: 'g1', revision: 1, objective: 'Ship the adapter', phase, maxGoalRounds: 12 },
    roundsStarted: 3,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
  };
}

test('folds projection frames out of the control stream', () => {
  const tracker = createProjectionTracker();
  tracker.apply({ type: 'baseline', value: { queues: {}, jobs: {}, projections: {} } });
  tracker.apply({ type: 'projection', sessionId: 's1', key: GOAL_PROJECTION_KEY, value: goalValue(), seq: 4 });

  assert.equal(tracker.goalOf('s1').goal.objective, 'Ship the adapter');
  // Anything that is not a projection is none of this tracker's business.
  tracker.apply({ type: 'queue', sessionId: 's2', items: [] });
  tracker.apply(null);
  assert.equal(tracker.goalOf('s2'), undefined);
});

test('reads the goal state the reconnect baseline already carried', () => {
  // A stream opens with one complete baseline and only then sends replacements.
  // The goal service registers its projection before any session runs, so a Host
  // that connects to a DSH process where the bound session already has a goal
  // receives that goal exactly once — inside the baseline. Dropping it leaves the
  // controller showing "no goal" for a goal that exists.
  const tracker = createProjectionTracker();
  tracker.apply({
    type: 'baseline',
    value: {
      queues: {},
      jobs: {},
      projections: { s1: { asOfSeq: 7, values: { [GOAL_PROJECTION_KEY]: goalValue(), title: 'Ship it' } } },
    },
  });

  assert.equal(tracker.goalOf('s1').goal.objective, 'Ship the adapter');
  assert.equal(tracker.goalOf('unknown'), undefined, 'a session the baseline never named is still unknown');
});

test('a baseline replaces state an earlier stream left behind', () => {
  // Frames from a previous generation must not survive a reconnect: a goal
  // cleared while the stream was down is absent from the new baseline, and a
  // stale active card is worse than an empty one.
  const tracker = createProjectionTracker();
  tracker.apply({ type: 'projection', sessionId: 's1', key: GOAL_PROJECTION_KEY, value: goalValue(), seq: 1 });
  tracker.apply({ type: 'baseline', value: { queues: {}, jobs: {}, projections: {} } });

  assert.equal(tracker.goalOf('s1'), undefined);
});

test('a baseline without a projection block does not throw or invent state', () => {
  const tracker = createProjectionTracker();
  tracker.apply({ type: 'baseline', value: { queues: {}, jobs: {} } });
  assert.equal(tracker.goalOf('s1'), undefined);
});

test('replaces one session’s projection without touching another', () => {
  const tracker = createProjectionTracker();
  tracker.apply({ type: 'projection', sessionId: 's1', key: GOAL_PROJECTION_KEY, value: goalValue('paused'), seq: 1 });
  tracker.apply({ type: 'projection', sessionId: 's2', key: GOAL_PROJECTION_KEY, value: goalValue(), seq: 2 });
  assert.equal(tracker.goalOf('s1').goal.phase, 'paused');
  assert.equal(tracker.goalOf('s2').goal.phase, 'active');
});

test('maps a DSH goal onto the controller payload', () => {
  const payload = toGoalStatusPayload('s1', goalValue());
  assert.equal(payload.sessionId, 's1');
  assert.equal(payload.status, 'active');
  assert.equal(payload.objective, 'Ship the adapter');
  assert.equal(payload.turnsUsed, 3, 'DSH counts continuation rounds, which is what the controller shows');
  assert.equal(payload.maxTurns, 12);
  assert.equal(payload.startedAt, 1_700_000_000_000);
  assert.equal(payload.lastReason, null);
});

test('every DSH phase is a phase the controller already knows', () => {
  // The controller's union is `active | paused | blocked | complete |
  // budgetLimited | usageLimited`; DSH's four are a direct subset, so the
  // mapping is the identity and nothing has to be invented.
  for (const phase of ['active', 'paused', 'blocked', 'complete']) {
    assert.equal(toGoalStatusPayload('s1', goalValue(phase)).status, phase);
  }
});

test('reports a blocker reason, and null when there is none', () => {
  const blocked = goalValue('blocked');
  blocked.goal.blockedReason = { code: 'NO_PROGRESS', message: 'no progress for 3 rounds' };
  assert.equal(toGoalStatusPayload('s1', blocked).lastReason, 'no progress for 3 rounds');

  const empty = goalValue('blocked');
  empty.goal.blockedReason = { code: 'NO_PROGRESS', message: '' };
  assert.equal(toGoalStatusPayload('s1', empty).lastReason, null);
});

test('never invents a token budget this Host does not track', () => {
  const payload = toGoalStatusPayload('s1', goalValue());
  // A fabricated zero would render as real usage in the controller's card.
  assert.equal(payload.budgetTokens, null);
  assert.equal(payload.noProgressLimit, null);
  assert.equal(payload.usageResetAt, null);
  assert.equal(payload.tokensUsed, 0);
});

test('keeps "unknown" distinct from "no goal"', () => {
  // The controller treats `undefined` as never-fetched and `null` as fetched-and-
  // absent; flattening them would make the goal card flicker on every open.
  assert.equal(toGoalStatusPayload('s1', undefined), undefined);
  assert.equal(toGoalStatusPayload('s1', null), null);
  assert.equal(toGoalStatusPayload('s1', { goal: null }), null);
  assert.equal(toGoalStatusPayload('s1', { roundsStarted: 0 }), null, 'a malformed value is no goal, not a crash');
});

test('clears on teardown', () => {
  const tracker = createProjectionTracker();
  tracker.apply({ type: 'projection', sessionId: 's1', key: GOAL_PROJECTION_KEY, value: goalValue(), seq: 1 });
  tracker.clear();
  assert.equal(tracker.goalOf('s1'), undefined);
});
