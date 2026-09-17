import test from 'node:test';
import assert from 'node:assert/strict';
import { createInputQueueTracker, toQueuedRemoteMessage, queuedRowFromController, queueItemsFromInbox, goalFromProjections } from '../src/host-input-queue.js';

const SESSION = { id: 's1', workingDir: 'G:\\Projects\\DSH-cindy-host' };
// The shape the queue tracker is actually handed: a *source* row, which names
// the directory `cwd`. Only the wire row calls it `workingDir`.
const SOURCE_SESSION = { id: 's1', cwd: 'G:\\Projects\\DSH-cindy-host' };

/** A DSH `SessionQueuedItem`. */
function item(id, placement, text) {
  return { id, placement, message: { id, content: [{ type: 'text', text }] } };
}

test('emits every field the controller validates a queued row on', () => {
  const row = toQueuedRemoteMessage(item('m1', 'queued', 'hello'), SESSION);
  // `isQueuedRemoteMessage` keeps an entry only when all of these are present
  // and `chatMessage.role === 'user'`.
  assert.equal(row.clientId, 'm1');
  assert.equal(typeof row.text, 'string');
  assert.equal(typeof row.persistedContent, 'string');
  assert.equal(typeof row.model, 'string');
  assert.equal(row.workingDir, 'G:\\Projects\\DSH-cindy-host');
  assert.equal(typeof row.createOpts, 'object');
  assert.equal(row.chatMessage.role, 'user');
  assert.equal(row.text, 'hello');
  assert.equal(row.createOpts.agentKind, 'pi');
});

test('refuses to invent a row the session cannot fill', () => {
  // No working directory: the controller would drop the entry anyway, so saying
  // nothing is more honest than saying something it will discard.
  assert.equal(toQueuedRemoteMessage(item('m1', 'queued', 'x'), { id: 's1' }), null);
  assert.equal(toQueuedRemoteMessage({ placement: 'queued' }, SESSION), null, 'an entry with no id is not addressable');
  assert.equal(toQueuedRemoteMessage(item('m1', 'queued', 'x'), undefined), null);
});

test('reads the working directory from the source row the tracker is handed', () => {
  // Both builders used to read `workingDir` only, while the row in the cache
  // says `cwd` — so every projection came out empty and the item a controller
  // had just sent was missing from its own `maker:input:enqueue` answer. The
  // composer then never settled, and the next send repeated the same text.
  const queued = toQueuedRemoteMessage(item('m1', 'queued', 'hello'), SOURCE_SESSION);
  assert.equal(queued.workingDir, 'G:\\Projects\\DSH-cindy-host');

  const pending = queuedRowFromController({ clientId: 'c1', text: 'hi', session: SOURCE_SESSION });
  assert.equal(pending.workingDir, 'G:\\Projects\\DSH-cindy-host');
  assert.equal(pending.clientId, 'c1');
});

test('folds a just-accepted item into the projection for a source-shaped session', () => {
  const tracker = createInputQueueTracker();
  const pending = queuedRowFromController({ clientId: 'c1', text: 'hi', session: SOURCE_SESSION });
  assert.notEqual(pending, null, 'a fillable session must produce a row');

  const projection = tracker.projectionFor('s1', SOURCE_SESSION, pending);
  assert.deepEqual(projection.pendingQueue.map((row) => row.clientId), ['c1']);
});

test('a just-accepted steering prompt is projected as steering, and only that one', () => {
  // The controller keeps its bubble alive from `steeringQueueClientIds`; a prompt DSH has
  // spliced but not yet made durable has to appear there, without disturbing the queue the
  // session already holds.
  const tracker = createInputQueueTracker();
  tracker.apply({ type: 'queue', sessionId: 's1', items: [item('q1', 'queued', 'queued first')] });

  tracker.markSteering('s1', {
    id: 'c2',
    rpcId: 'c2',
    message: { id: 'c2', content: [{ type: 'text', text: '插一句' }] },
  });

  const projection = tracker.projectionFor('s1', SOURCE_SESSION);
  assert.deepEqual(projection.steeringQueueClientIds, ['c2']);
  assert.deepEqual(projection.pendingQueue.map((row) => row.clientId), ['q1'], 'the real queue is untouched');

  // Marking the same id again replaces that entry rather than duplicating it.
  tracker.markSteering('s1', { id: 'c2', rpcId: 'c2', message: { id: 'c2', content: [] } });
  assert.deepEqual(tracker.projectionFor('s1', SOURCE_SESSION).steeringQueueClientIds, ['c2']);
  assert.equal(tracker.queueFor('s1').filter((entry) => entry.id === 'c2').length, 1);

  // And the durable row retires it, which is what ends the bubble.
  tracker.mirror('s1', 'c2', { kind: 'remove' });
  assert.deepEqual(tracker.projectionFor('s1', SOURCE_SESSION).steeringQueueClientIds, []);
});

test('a prompt accepted but not yet durable is served as a transcript row', () => {
  // Measured gap: a prompt sent while a turn runs waits in DSH's inbox until the turn
  // reaches a step boundary — 0.4 s when idle, 42 s in the worst observed case. With no row
  // in the transcript for it, a controller that reloads shows nothing and the user retypes a
  // message that is still queued (「退出去再进来，它不见了」).
  const tracker = createInputQueueTracker();
  assert.deepEqual(tracker.pendingTranscriptRows('s1'), [], 'nothing accepted, nothing to show');

  tracker.markSteering('s1', {
    id: 'c9',
    rpcId: 'c9',
    message: { id: 'c9', content: [{ type: 'text', text: '插一句' }] },
  });
  const rows = tracker.pendingTranscriptRows('s1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'user');
  assert.equal(rows[0].clientId, 'c9', 'the controller recognises its own message by this id');
  assert.equal(rows[0].content.text, '插一句');
  assert.equal(rows[0].pendingDelivery, 'steering');
  assert.equal(rows[0].id, 's1:pending:c9');
  assert.ok(Number.isFinite(Date.parse(rows[0].createdAt)), 'the row carries when it was accepted');

  // The durable row retires it: the two never coexist, and the controller's own echo
  // reconciliation swaps one for the other.
  tracker.mirror('s1', 'c9', { kind: 'remove' });
  assert.deepEqual(tracker.pendingTranscriptRows('s1'), []);
});

test('folds the baseline, then replaces one session at a time', () => {
  const tracker = createInputQueueTracker();
  tracker.apply({
    type: 'baseline',
    value: { queues: { s1: [item('a', 'queued', 'one')], s2: [item('b', 'queued', 'two')] }, jobs: {} },
  });
  assert.equal(tracker.queueFor('s1').length, 1);
  assert.equal(tracker.queueFor('s2').length, 1);

  tracker.apply({ type: 'queue', sessionId: 's1', items: [item('c', 'queued', 'replaced')] });
  assert.deepEqual(tracker.queueFor('s1').map((entry) => entry.id), ['c'], 'a queue frame replaces that session');
  assert.equal(tracker.queueFor('s2').length, 1, 'and leaves the others alone');

  tracker.apply({ type: 'queue', sessionId: 's1', items: [] });
  assert.deepEqual(tracker.queueFor('s1'), [], 'an empty queue frame clears it');
});

test('separates queued from steering, and projects the rest as empty', () => {
  const tracker = createInputQueueTracker();
  tracker.apply({
    type: 'baseline',
    value: {
      queues: { s1: [item('a', 'queued', 'later'), item('b', 'steering', 'now'), item('c', 'context', 'ctx')] },
      jobs: {},
    },
  });

  const projection = tracker.projectionFor('s1', SESSION);
  assert.equal(projection.sessionId, 's1');
  assert.deepEqual(projection.pendingQueue.map((row) => row.clientId), ['a']);
  assert.deepEqual(projection.steeringQueueClientIds, ['b'], 'a context entry is neither queued nor steering');

  // The error/recovery fields describe a failure inside the controller's own
  // agent; DSH reports those as session events, so they stay at empty.
  assert.equal(projection.error, null);
  assert.equal(projection.errorRetryText, null);
  assert.equal(projection.queueAbortPending, false);
  assert.deepEqual(projection.queueInteractionLocks, []);
});

test('projects an empty queue for a session it has never heard of', () => {
  const tracker = createInputQueueTracker();
  const projection = tracker.projectionFor('unknown', SESSION);
  assert.deepEqual(projection.pendingQueue, []);
  assert.deepEqual(projection.steeringQueueClientIds, []);
  assert.equal(projection.sessionId, 'unknown');
});

test('a session with no working directory yields an empty queue, not broken rows', () => {
  const tracker = createInputQueueTracker();
  tracker.apply({ type: 'baseline', value: { queues: { s1: [item('a', 'queued', 'x')] }, jobs: {} } });
  const projection = tracker.projectionFor('s1', undefined);
  assert.deepEqual(projection.pendingQueue, [], 'rows the controller would discard are not emitted');
});

test('ignores frames this Host does not serve, and clears on teardown', () => {
  const tracker = createInputQueueTracker();
  tracker.apply({ type: 'projection', sessionId: 's1', key: 'k', value: 1, seq: 2 });
  tracker.apply(null);
  tracker.apply({ type: 'baseline', value: { queues: { s1: [item('a', 'queued', 'x')] }, jobs: { s1: [{ id: 'j', kind: 'bash', status: 'running' }] } } });
  assert.equal(tracker.jobsFor('s1').length, 1);

  tracker.clear();
  assert.deepEqual(tracker.queueFor('s1'), []);
  assert.deepEqual(tracker.jobsFor('s1'), []);
});

test('reads the queue out of the inbox projection, in DSHs own placement terms', () => {
  // Ported from the controller's `queueItemsFromInbox`; this is the only
  // reliable queue source, because the pushed `queue` frame is not guaranteed to
  // arrive and a fold cannot tell "empty" from "never heard".
  const items = queueItemsFromInbox({
    'next-turn': [{ id: 'm1', source: { kind: 'user', rpcId: 'c1' }, content: [{ type: 'text', text: 'later' }] }],
    'next-step': [
      { id: 'm2', source: { kind: 'user', rpcId: 'c2' }, content: [] },
      { id: 'm3', source: { kind: 'system' }, content: [] },
    ],
  });
  assert.deepEqual(items.map((item) => [item.id, item.placement, item.rpcId ?? null]), [
    ['m1', 'queued', 'c1'],
    ['m2', 'steering', 'c2'],
    ['m3', 'context', null],
  ]);
  assert.deepEqual(items[0].message, { id: 'm1', content: [{ type: 'text', text: 'later' }] });
});

test('a malformed inbox yields rows only where it can name one', () => {
  assert.deepEqual(queueItemsFromInbox(undefined), []);
  assert.deepEqual(queueItemsFromInbox(null), []);
  assert.deepEqual(queueItemsFromInbox('nonsense'), []);
  // A message with no id cannot be addressed, so it cannot be a row.
  assert.deepEqual(queueItemsFromInbox({ 'next-turn': [{ content: [] }, { id: 'ok' }] }).map((item) => item.id), ['ok']);
});

test('reads a goal from a projection snapshot, and tells absent from unknown', () => {
  const goal = { goal: { id: 'g1', revision: 1, objective: 'x', phase: 'active', maxGoalRounds: 5 }, roundsStarted: 2, createdAt: 1, updatedAt: 2 };
  assert.equal(goalFromProjections({ values: { goal } }), goal);
  // Present and null means "fetched, no goal"; the key being absent is "unknown".
  assert.equal(goalFromProjections({ values: { goal: null } }), null);
  assert.equal(goalFromProjections({ values: { inbox: {} } }), undefined);
  assert.equal(goalFromProjections(undefined), undefined);
});
