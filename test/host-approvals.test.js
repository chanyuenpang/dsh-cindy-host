import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovalRegistry, decisionOutcome, questionAnswerOf, PERMISSION_KIND } from '../src/host-approvals.js';

test('maps only the controller permission vocabulary onto DSH outcomes', () => {
  assert.equal(decisionOutcome({ kind: 'permission', behavior: 'allow' }), 'allowed-once', 'DSH defines exactly one grant');
  assert.equal(decisionOutcome({ kind: 'permission', behavior: 'deny' }), 'rejected');
  assert.equal(decisionOutcome({ kind: 'permission', behavior: 'reject' }), 'rejected');
  assert.equal(decisionOutcome({ behavior: 'allow' }), 'allowed-once', 'the kind is optional in the controller payload');
});

test('refuses a decision this Host cannot map', () => {
  // Other interaction kinds belong to flows this Host does not serve.
  assert.equal(decisionOutcome({ kind: 'ask_user_question', answers: {} }), null);
  assert.equal(decisionOutcome({ kind: 'plan_review', behavior: 'allow' }), null);
  assert.equal(decisionOutcome({ kind: 'permission' }), null, 'no behaviour is not an answer');
  assert.equal(decisionOutcome(null), null);
  assert.equal(decisionOutcome('allow'), null);
});

test('registers a question, lists it, and settles it with the controller answer', async () => {
  const registry = createApprovalRegistry();
  const { requestId, request, answered } = await registry.ask({ sessionId: 's1', toolName: 'write_file', reason: 'needs write' });

  assert.equal(request.kind, PERMISSION_KIND);
  assert.equal(request.sessionId, 's1');
  assert.equal(request.toolName, 'write_file');
  assert.equal(request.reason, 'needs write');
  assert.equal(registry.size(), 1);

  // What `maker:get-pending-interactions` hands the phone.
  const listed = registry.list('s1');
  assert.deepEqual(listed, [{ request: { ...request } }]);
  assert.deepEqual(registry.list('other'), [], 'a question is scoped to its asking session');

  assert.deepEqual(registry.settle(requestId, { kind: 'permission', behavior: 'allow' }), { accepted: true });
  assert.equal(await answered, 'allowed-once');
  assert.equal(registry.size(), 0, 'an answered question leaves the registry');
});

test('an unknown id or an unmappable decision is refused, not acknowledged', async () => {
  const registry = createApprovalRegistry();
  const { requestId, answered } = await registry.ask({ sessionId: 's1', toolName: 'x' });

  assert.deepEqual(registry.settle('nope', { kind: 'permission', behavior: 'allow' }), { accepted: false });
  assert.deepEqual(registry.settle(requestId, { kind: 'plan_review', behavior: 'allow' }), { accepted: false });
  assert.equal(registry.size(), 1, 'the question stays open so the card is not falsely cleared');

  registry.settle(requestId, { kind: 'permission', behavior: 'deny' });
  assert.equal(await answered, 'rejected');
});

test('the asker withdrawing the question cancels it and discards a late answer', async () => {
  const registry = createApprovalRegistry();
  const controller = new AbortController();
  const { requestId, answered } = await registry.ask({ sessionId: 's1', toolName: 'x', signal: controller.signal });

  controller.abort();
  assert.equal(await answered, 'cancelled');
  assert.equal(registry.size(), 0);
  assert.deepEqual(registry.settle(requestId, { kind: 'permission', behavior: 'allow' }), { accepted: false }, 'a late answer cannot resurrect it');
});

test('an unanswered question times out as cancelled rather than hanging the turn', async () => {
  const timers = [];
  const registry = createApprovalRegistry({
    timeoutMs: 5_000,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return { unref() {} };
    },
    clearTimer: () => {},
  });
  const { answered } = await registry.ask({ sessionId: 's1', toolName: 'x' });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 5_000);
  timers[0].fn();
  assert.equal(await answered, 'cancelled');
});

test('clearing settles every open question, which is what releases DSH', async () => {
  const registry = createApprovalRegistry();
  const first = await registry.ask({ sessionId: 's1', toolName: 'a' });
  const second = await registry.ask({ sessionId: 's2', toolName: 'b' });

  registry.clear();
  assert.equal(await first.answered, 'cancelled');
  assert.equal(await second.answered, 'cancelled');
  assert.equal(registry.size(), 0);
});

test('each question gets its own id', async () => {
  const registry = createApprovalRegistry();
  const a = await registry.ask({ sessionId: 's1', toolName: 'a' });
  const b = await registry.ask({ sessionId: 's1', toolName: 'b' });
  assert.notEqual(a.requestId, b.requestId);
  assert.equal(registry.list('s1').length, 2);
  registry.clear();
});

test('every close of a question tells the watching controllers', async () => {
  // Answered, timed out, or withdrawn — the card is gone either way, and a
  // second screen would otherwise keep rendering a question that no longer
  // exists until its next poll.
  const dismissed = [];
  const registry = createApprovalRegistry({ onDismissed: (info) => dismissed.push(info) });

  const answered = await registry.ask({ sessionId: 's1', toolName: 'pwsh' });
  registry.settle(answered.requestId, { kind: 'permission', behavior: 'allow' });
  assert.deepEqual(dismissed[0], { sessionId: 's1', requestId: answered.requestId });
  assert.equal(await answered.answered, 'allowed-once');

  // A timeout closes it too.
  const timedOut = await registry.ask({ sessionId: 's2', toolName: 'pwsh' });
  registry.clear();
  assert.equal(dismissed.length, 2, 'the switch going off closes open questions and says so');
  assert.equal(dismissed[1].sessionId, 's2');
  assert.equal(await timedOut.answered, 'cancelled');

  // A dismissal is announced once, not on every later answer attempt.
  registry.settle(answered.requestId, { kind: 'permission', behavior: 'allow' });
  assert.equal(dismissed.length, 2);
});

test('a throwing dismissal listener cannot strand the waiting answerer', async () => {
  const registry = createApprovalRegistry({ onDismissed: () => { throw new Error('listener broke'); } });
  const asked = await registry.ask({ sessionId: 's1', toolName: 'pwsh' });
  registry.settle(asked.requestId, { kind: 'permission', behavior: 'allow' });
  assert.equal(await asked.answered, 'allowed-once', 'the answer still reaches DSH');
});

test('maps the controllers answer onto DSHs question ids', () => {
  // The controller keys its answer by question **text** and sends one string per
  // question; DSH wants question **id** and a selected array. Getting that
  // translation wrong does not error — it answers the wrong question.
  const questions = [
    { id: 'q1', question: 'Which fruit?', options: [{ label: 'apple' }, { label: 'pear' }] },
    { id: 'q2', question: 'Which toppings?', multiSelect: true, options: [{ label: 'cheese' }, { label: 'basil' }, { label: 'ham' }] },
  ];
  const answer = questionAnswerOf(questions, {
    kind: 'ask_user_question',
    answers: {
      'Which fruit?': 'pear',
      'Which toppings?': JSON.stringify(['cheese', 'extra pineapple']),
    },
  });
  assert.deepEqual(answer.answers[0], { id: 'q1', selected: ['pear'] });
  // A multi-select keeps the offered labels and carries the rest as free text.
  assert.deepEqual(answer.answers[1], { id: 'q2', selected: ['cheese'], custom: 'extra pineapple' });
});

test('an unanswered question is answered with nothing, not dropped', () => {
  // DSH's answer shape is per question, so omitting one would leave the tool
  // unable to match its own questions to answers.
  const answer = questionAnswerOf(
    [{ id: 'q1', question: 'First?', options: [{ label: 'a' }] }, { id: 'q2', question: 'Second?' }],
    { kind: 'ask_user_question', answers: { 'First?': 'a' } },
  );
  assert.deepEqual(answer.answers, [{ id: 'q1', selected: ['a'] }, { id: 'q2', selected: [] }]);
  assert.deepEqual(questionAnswerOf([], {}).answers, []);
});

test('a structured question settles with the controllers answer', async () => {
  const registry = createApprovalRegistry();
  const asked = await registry.askUser({
    sessionId: 's1',
    questions: [{ id: 'q1', question: 'Pick one', options: [{ label: 'yes' }, { label: 'no' }] }],
  });
  assert.equal(asked.request.kind, 'ask_user_question');
  assert.equal(asked.request.questions[0].question, 'Pick one');
  assert.deepEqual(registry.list('s1').map((row) => row.request.kind), ['ask_user_question']);

  assert.deepEqual(registry.settle(asked.requestId, { kind: 'ask_user_question', answers: { 'Pick one': 'yes' } }), { accepted: true });
  assert.deepEqual(await asked.answered, { answers: [{ id: 'q1', selected: ['yes'] }] });
});

test('a decision aimed at the wrong kind is refused, not mistranslated', async () => {
  // A permission decision sent for a question would otherwise be read as "no
  // answer", and a question decision sent for an approval has no outcome at all.
  const registry = createApprovalRegistry();
  const asked = await registry.askUser({ sessionId: 's1', questions: [{ id: 'q1', question: 'Pick one', options: [{ label: 'yes' }] }] });
  assert.deepEqual(registry.settle(asked.requestId, { kind: 'permission', behavior: 'allow' }), { accepted: false });

  const approval = await registry.ask({ sessionId: 's1', toolName: 'pwsh' });
  assert.deepEqual(registry.settle(approval.requestId, { kind: 'ask_user_question', answers: {} }), { accepted: false });
  assert.deepEqual(registry.settle(approval.requestId, { kind: 'permission', behavior: 'allow' }), { accepted: true });
});

test('a question that is never answered releases DSH with empty answers', async () => {
  // The waterfall blocks the tool call, so a timeout has to resolve it rather
  // than leave the turn waiting forever.
  const registry = createApprovalRegistry({ timeoutMs: 0 });
  const asked = await registry.askUser({ sessionId: 's1', questions: [{ id: 'q1', question: 'Pick one' }] });
  registry.clear();
  assert.deepEqual(await asked.answered, { answers: [{ id: 'q1', selected: [] }] });
});
