import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelRouter } from '../src/cindy-channels.js';
import { createInputQueueTracker, queuedRowFromController, toQueuedRemoteMessage } from '../src/host-input-queue.js';

const ROWS = [{ id: 's1', title: 'Alpha', running: true, updatedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', cwd: '/a' }];
const SESSION = { id: 's1', cwd: '/a' };

/** One invoke request, as the relay hands it to a target. */
function request(channel, args = []) {
  return { v: 1, kind: 'invoke', id: 'req-1', src: 'phone-1', payload: { channel, args } };
}

/** A DSH `SessionQueuedItem`; `rpcId` is the controller's own identity for it. */
function item(id, rpcId, text, placement = 'queued') {
  return { id, rpcId, placement, message: { id, content: [{ type: 'text', text }] } };
}

/**
 * A router over the **real** tracker.
 *
 * The mirror is the thing under test: DSH's own queue frame trails a commit, so
 * the answer to a removal must come from the mirrored fold. A stubbed mirror
 * would let a "removed" row come straight back and the test would not notice.
 */
function makeRouter({ items = [], control = {} } = {}) {
  const tracker = createInputQueueTracker();
  if (items.length > 0) tracker.apply({ type: 'queue', sessionId: 's1', items });
  const calls = [];
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      // A steer is only meaningful while a turn runs, and this file's routers describe that case.
      isSessionRunning: () => true,
      queueControl: {
        // **Async on purpose, because the real one is.** The seam's `update` resolves the
        // session's agent first, so DSH's refusal arrives as a *rejection*, not a throw. A
        // synchronous fixture made a `try`/`catch` around an un-awaited call look correct,
        // and the real thing ended the whole `dsh web` process instead
        // (`fatal load failure: RemoteError: queued item is no longer pending`).
        update: async (payload) => {
          calls.push(payload);
          if (control.throwOnUpdate) throw new Error('inbox rejected the item');
          if (control.rejectWith !== undefined) throw control.rejectWith;
        },
        cancel: (payload) => calls.push({ cancelled: payload }),
      },
      queueMirror: {
        has: (sessionId, itemId) => tracker.hasItem(sessionId, itemId),
        dshItemId: (sessionId, controllerId) => tracker.dshItemId(sessionId, controllerId),
        mirror: (sessionId, itemId, action) => tracker.mirror(sessionId, itemId, action),
        markSteering: (sessionId, payload) => tracker.markSteering(sessionId, payload),
        markQueued: (sessionId, payload) => tracker.markQueued(sessionId, payload),
        itemFor: (sessionId, itemId) => tracker.itemFor(sessionId, itemId),
        moveItem: (sessionId, itemId, index) => tracker.moveItem(sessionId, itemId, index),
        setExpanded: (sessionId, expanded) => tracker.setExpanded(sessionId, expanded),
        setEditLock: (sessionId, itemId, locked) => tracker.setEditLock(sessionId, itemId, locked),
        setInteractionLock: (sessionId, lockId, locked) => tracker.setInteractionLock(sessionId, lockId, locked),
        clearSession: (sessionId) => tracker.clearSession(sessionId),
        itemIds: (sessionId) => tracker.itemIds(sessionId),
      },
      inputProjection: (sessionId) => tracker.projectionFor(sessionId, SESSION),
      sendMessage: (payload) => calls.push({ sent: payload }),
    }),
    subscribers: new Set(),
  });
  return { router, tracker, calls };
}

test('stop cancels the turn and answers the projection the controller expects', async () => {
  const { router, calls } = makeRouter({ items: [item('m1', 'c1', 'later')] });
  const result = await router(request('maker:input:stop', ['s1', { keepQueue: true, pauseQueue: true }]));
  assert.equal(result.payload.ok, true);
  // DSH's cancel keeps the pending inbox, which is what the controller asks for.
  assert.deepEqual(calls[0], { cancelled: { sessionId: 's1' } });
  assert.deepEqual(result.payload.result.pendingQueue.map((row) => row.clientId), ['c1']);
});

test('remove answers a projection that no longer holds the row', async () => {
  const { router, tracker, calls } = makeRouter({ items: [item('m1', 'c1', 'first'), item('m2', 'c2', 'second')] });
  const result = await router(request('maker:input:remove', ['s1', 'c1']));
  assert.equal(result.payload.ok, true);
  // DSH is keyed on its own MessageId; the controller spoke in clientId.\n  assert.deepEqual(calls[0], { sessionId: 's1', itemId: 'm1', action: { kind: 'remove' } });
  // The mirrored fold is what keeps the deleted row from reappearing.
  assert.deepEqual(result.payload.result.pendingQueue.map((row) => row.clientId), ['c2']);
  assert.equal(tracker.hasItem('s1', 'c1'), false);
});

test('update-text replaces the queued item content', async () => {
  const { router, calls } = makeRouter({ items: [item('m1', 'c1', 'old text')] });
  const result = await router(request('maker:input:update-text', ['s1', 'c1', 'new text']));
  assert.equal(result.payload.ok, true);
  assert.deepEqual(calls[0], { sessionId: 's1', itemId: 'm1', action: { kind: 'edit', content: [{ type: 'text', text: 'new text' }] } });
  assert.equal(result.payload.result.pendingQueue[0].text, 'new text');
});

test('update-content reads the text out of the row the controller sends', async () => {
  const { router, calls } = makeRouter({ items: [item('m1', 'c1', 'old')] });
  await router(request('maker:input:update-content', ['s1', 'c1', { clientId: 'c1', text: 'from the row' }]));
  assert.deepEqual(calls[0].action, { kind: 'edit', content: [{ type: 'text', text: 'from the row' }] });
});

test('steer promotes an item DSH already holds instead of sending its text again', async () => {
  // This is the 插话 button on a queued row. Treating it as a fresh prompt would
  // send the same text twice, which is the bug it exists to avoid.
  const { router, calls } = makeRouter({ items: [item('m1', 'c1', 'queued text')] });
  const result = await router(request('maker:input:steer', ['s1', { clientId: 'c1', text: 'queued text' }], ));
  assert.equal(result.payload.result, true, 'steer answers a boolean');
  assert.deepEqual(calls[0], { sessionId: 's1', itemId: 'm1', action: { kind: 'steer' } });
  assert.equal(calls.some((call) => call.sent !== undefined), false, 'nothing was re-sent');
});

test('steer with text DSH is not holding is still a new message', async () => {
  // The composer's steer while a turn runs sends a brand-new message.
  const { router, calls } = makeRouter();
  const result = await router(request('maker:input:steer', ['s1', { clientId: 'fresh', text: 'brand new' }]));
  assert.equal(result.payload.result, true);
  assert.deepEqual(calls[0], { sent: { sessionId: 's1', text: 'brand new', requestId: 'fresh', mode: 'steer' } });
});

test('a promoted steer keeps the text of the bubble the user is looking at', async () => {
  // The reported symptom: 插入的气泡也马上插入了，但是插入之后里面的文字被清空了. The promotion
  // upserts the item so `steeringQueueClientIds` goes true at once, and the first version
  // restated it as `{ id, rpcId, message: { content: [] } }` — only the id was needed for the
  // projection to name it, and the *content* is what the controller renders. So the bubble
  // appeared empty, and the same empty item produced an empty pending transcript row.
  const { router, tracker } = makeRouter({ items: [item('m1', 'c1', 'queued text')] });

  const result = await router(request('maker:input:steer', ['s1', { clientId: 'c1' }]));
  assert.equal(result.payload.ok, true);
  // The controller answers a steer with a boolean and refetches, which is where the moved row
  // shows up.
  const projection = await router(request('maker:input:get-projection', ['s1']));
  assert.deepEqual(projection.payload.result.steeringQueueClientIds, ['c1'], 'the row moved to steering');
  assert.equal((projection.payload.result.pendingQueue ?? []).length, 0, 'and is no longer queued');

  // What the phone renders the bubble from: the fold's record for that id.
  const held = tracker.itemFor('s1', 'c1');
  assert.deepEqual(held.message.content, [{ type: 'text', text: 'queued text' }], 'the bubble still has its text');
});

test('a promoted steer the fold never knew still carries the text the controller sent', async () => {
  // The other half: the authoritative read that follows an enqueue can race DSH's splice, so
  // the fold may not hold the item at promotion time. The controller sends the row back, and
  // that text is the only honest source left — an empty bubble here is the same defect.
  const { router, tracker } = makeRouter();

  const result = await router(request('maker:input:steer', ['s1', { clientId: 'c9', text: 'what the user typed' }]));
  assert.equal(result.payload.ok, true);
  assert.deepEqual(tracker.itemFor('s1', 'c9').message.content, [{ type: 'text', text: 'what the user typed' }]);
});

test('an insert that arrives after the turn ended is a normal prompt, not a refusal', async () => {
  // Measured: the second 插入 of a session whose turn had already ended came back as
  // `session/steer-unavailable` and the phone showed 「current turn no longer running」 — for a
  // request that only wanted to say something. DSH's steer primitive needs a live agent; a normal
  // prompt is the same intent one step later, and it starts the turn the steer would have joined.
  const sent = [];
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      // The turn is over: that is the whole point of this case.
      isSessionRunning: () => false,
      queueMirror: { dshItemId: () => null },
      readSessionState: async () => ({ inbox: { 'next-turn': [], 'next-step': [] }, hasGoalKey: false }),
      sendMessage: async (input) => sent.push(input),
    }),
    subscribers: new Set(),
  });

  const result = await router(request('maker:input:steer', ['s1', { clientId: 'late', text: 'sent a moment too late' }]));
  assert.equal(result.payload.ok, true);
  assert.equal(sent[0].mode, 'queue', 'a steer with no turn to steer into is sent as a prompt');
  assert.equal(sent[0].text, 'sent a moment too late', 'and the words are not lost');
});

test('a steer DSH refuses mid-turn is retried as a prompt, and the words survive', async () => {
  // The error the handset showed: 「current turn no longer accepts steering」. The turn *was*
  // running, so the session-state check passes, and DSH refuses anyway because the turn moved past
  // its steerable point. That gap is a race, and the user's message must not be what loses it.
  const sent = [];
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      isSessionRunning: () => true,
      queueMirror: { dshItemId: () => null, markSteering: () => {} },
      readSessionState: async () => ({ inbox: { 'next-turn': [], 'next-step': [] }, hasGoalKey: false }),
      pushInputProjection: () => {},
      sendMessage: async (input) => {
        sent.push(input.mode);
        if (input.mode === 'steer') throw new Error('current turn no longer accepts steering');
        return { ok: true };
      },
    }),
    subscribers: new Set(),
  });

  const result = await router(request('maker:input:steer', ['s1', { clientId: 'raced', text: 'said too late' }]));
  assert.equal(result.payload.ok, true, 'the insert is not answered with an error');
  assert.deepEqual(sent, ['steer', 'queue'], 'the refused steer is retried as a plain prompt');
});

test('a failure that is not about steering still travels', async () => {
  // The retry is for one specific refusal. Swallowing every error would turn a real failure — a
  // dead attachment, a model that cannot take images — into a silent success.
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      isSessionRunning: () => true,
      queueMirror: { dshItemId: () => null },
      readSessionState: async () => ({ inbox: { 'next-turn': [], 'next-step': [] }, hasGoalKey: false }),
      sendMessage: async () => {
        throw new Error('session/model-unavailable: no adapter serves provider "x"');
      },
    }),
    subscribers: new Set(),
  });

  await assert.rejects(
    () => router(request('maker:input:steer', ['s1', { clientId: 'bad', text: 'x' }])),
    /model-unavailable/,
  );
});

test('the queue UI flags are recorded, not ignored', async () => {
  // The controller sets these here and reads them back out of the projection, so
  // dropping them makes its panel forget what the user just did.
  const { router } = makeRouter({ items: [item('m1', 'c1', 'x')] });

  const expanded = await router(request('maker:input:set-expanded', ['s1', true]));
  assert.equal(expanded.payload.result.queueExpanded, true);

  const editLock = await router(request('maker:input:set-edit-lock', ['s1', 'c1', true]));
  assert.deepEqual(editLock.payload.result.queueEditLocks, ['c1']);
  const unlocked = await router(request('maker:input:set-edit-lock', ['s1', 'c1', false]));
  assert.deepEqual(unlocked.payload.result.queueEditLocks, []);

  const interaction = await router(request('maker:input:set-interaction-lock', ['s1', 'i1', true]));
  assert.deepEqual(interaction.payload.result.queueInteractionLocks, ['i1']);
});

test('clear-session removes every queued item one by one', async () => {
  const { router, calls } = makeRouter({ items: [item('m1', 'c1', 'a'), item('m2', 'c2', 'b')] });
  const result = await router(request('maker:input:clear-session', ['s1']));
  assert.equal(result.payload.ok, true);
  // DSH owns the inbox, so emptying it means one supported mutation per item —
  // addressed by DSH's own `MessageId`, which is what `updateQueue` is keyed on
  // (the controller's `clientId` is a different value).
  assert.deepEqual(calls.map((call) => call.itemId).sort(), ['m1', 'm2']);
  assert.deepEqual(result.payload.result.pendingQueue, []);
});

test('clear-session keeps going past an item DSH has already admitted', async () => {
  // The acceptance suite's only two failures once refusals stopped being swallowed: it emptied
  // a queue holding two items and got `session/queue-item-not-found: queued item is no longer
  // pending` for one of them. That code is the *outcome this channel asks for* — the item is
  // gone — but returning it as an error also aborted the loop, so the items behind it stayed
  // queued while the controller was told the clear had failed.
  const gone = Object.assign(new Error('queued item is no longer pending'), { code: 'session/queue-item-not-found' });
  const attempts = [];
  const tracker = createInputQueueTracker();
  tracker.apply({ type: 'queue', sessionId: 's1', items: [item('m1', 'c1', 'first'), item('m2', 'c2', 'second'), item('m3', 'c3', 'third')] });
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      // A steer is only meaningful while a turn runs, and this file's routers describe that case.
      isSessionRunning: () => true,
      queueControl: {
        // The first item was already admitted: DSH refuses it, and the other two must still be
        // attempted. Awaited on purpose — the real seam method is async.
        update: async (payload) => {
          attempts.push(payload.itemId);
          if (payload.itemId === 'm1') throw gone;
        },
        cancel: () => {},
      },
      queueMirror: {
        dshItemId: (sessionId, controllerId) => tracker.dshItemId(sessionId, controllerId),
        mirror: (sessionId, itemId, action) => tracker.mirror(sessionId, itemId, action),
        clearSession: (sessionId) => tracker.clearSession(sessionId),
        itemIds: (sessionId) => tracker.itemIds(sessionId),
      },
      inputProjection: (sessionId) => tracker.projectionFor(sessionId, SESSION),
    }),
    subscribers: new Set(),
  });

  const result = await router(request('maker:input:clear-session', ['s1']));
  assert.deepEqual(attempts, ['m1', 'm2', 'm3'], 'an admitted item does not abandon the rest');
  assert.equal(result.payload.ok, true, 'a queue that is now empty is not a failure');
  assert.deepEqual(result.payload.result.pendingQueue, []);
});

test('a clear-session that really fails says so, and does not claim the queue is empty', async () => {
  // The counterpart: a refusal that is not "already gone" is still an error, and the fold is
  // left alone so the rows DSH still holds do not vanish on a false promise.
  const refusal = Object.assign(new Error('no live agent'), { code: 'session/not-found' });
  const tracker = createInputQueueTracker();
  tracker.apply({ type: 'queue', sessionId: 's1', items: [item('m1', 'c1', 'first')] });
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      // A steer is only meaningful while a turn runs, and this file's routers describe that case.
      isSessionRunning: () => true,
      queueControl: { update: async () => { throw refusal; }, cancel: () => {} },
      queueMirror: {
        itemIds: (sessionId) => tracker.itemIds(sessionId),
        clearSession: (sessionId) => tracker.clearSession(sessionId),
      },
      inputProjection: (sessionId) => tracker.projectionFor(sessionId, SESSION),
    }),
    subscribers: new Set(),
  });

  const result = await router(request('maker:input:clear-session', ['s1']));
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.error.code, 'session/not-found');
  assert.equal(tracker.hasItem('s1', 'c1'), true, 'the row it could not remove is still shown');
});

test('the enqueue answer reports the queue DSH holds, not an optimistic guess', async () => {
  // A prompt sent to an idle session is admitted immediately and never enters
  // the inbox. Synthesising a pending row for it left the phone showing 队列中
  // for a message the agent had already answered, and nothing could clear it.
  const send = async () => {};
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      sendMessage: send,
      // DSH admitted the prompt: its inbox is empty.
      readSessionState: async () => ({ inbox: { 'next-turn': [], 'next-step': [] }, hasGoalKey: false }),
      projectionFromItems: (sessionId, items) => ({ sessionId, pendingQueue: items, steeringQueueClientIds: [] }),
      // The old synth path would answer with this row instead.
      queuedRow: ({ clientId, text }) => ({ clientId, text, chatMessage: { role: 'user' } }),
    }),
    subscribers: new Set(),
  });

  const result = await router(request('maker:input:enqueue', ['s1', { clientId: 'c1', text: 'hello' }]));
  assert.equal(result.payload.ok, true);
  assert.deepEqual(result.payload.result.pendingQueue, [], 'an admitted prompt is not a queued one');
});

test('the enqueue answer carries the item when DSH really queued it', async () => {
  const adopted = [];
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      sendMessage: async () => {},
      // DSH is holding it: the session was busy when the prompt arrived.
      readSessionState: async () => ({
        inbox: { 'next-turn': [{ id: 'm1', source: { kind: 'user', rpcId: 'c1' }, content: [{ type: 'text', text: 'hello' }] }] },
        hasGoalKey: false,
      }),
      queueMirror: { adopt: (sessionId, items) => adopted.push([sessionId, items]) },
      projectionFromItems: (sessionId, items) => ({
        sessionId,
        pendingQueue: items.map((entry) => toQueuedRemoteMessage(entry, SESSION)),
        steeringQueueClientIds: [],
      }),
    }),
    subscribers: new Set(),
  });

  const result = await router(request('maker:input:enqueue', ['s1', { clientId: 'c1', text: 'hello' }]));
  assert.equal(result.payload.ok, true);
  // The row is addressed by the controller's own id, which is what its echo uses.
  assert.deepEqual(result.payload.result.pendingQueue.map((row) => row.clientId), ['c1']);
  // And the fold now knows the durable id, so a later edit resolves at once.
  assert.deepEqual(adopted[0][1].map((entry) => entry.id), ['m1']);
});

test('a queue command tells the other watchers what the queue looks like now', async () => {
  // The reply settles the controller that asked; a second screen watching the
  // same session has no reason to ask again, so it needs the push or it keeps
  // rendering a row the user just deleted.
  const pushed = [];
  const tracker = createInputQueueTracker();
  tracker.apply({ type: 'queue', sessionId: 's1', items: [item('m1', 'c1', 'x')] });
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      // A steer is only meaningful while a turn runs, and this file's routers describe that case.
      isSessionRunning: () => true,
      queueControl: { update: () => {}, cancel: () => {} },
      queueMirror: {
        dshItemId: (sessionId, controllerId) => tracker.dshItemId(sessionId, controllerId),
        mirror: (sessionId, itemId, action) => tracker.mirror(sessionId, itemId, action),
      },
      inputProjection: (sessionId) => tracker.projectionFor(sessionId, SESSION),
      pushInputProjection: (sessionId) => pushed.push(sessionId),
    }),
    subscribers: new Set(),
  });

  await router(request('maker:input:remove', ['s1', 'c1']));
  assert.deepEqual(pushed, ['s1'], 'the removal is announced, not only answered');
});

test('an item the fold never learned is still addressable through the inbox', async () => {
  // The fold only learns items from pushed `queue` frames, and those are not
  // guaranteed to arrive. Resolving from the fold alone reported NOT_FOUND for an
  // item the Host itself had just accepted — found by `npm run acceptance`.
  const updated = [];
  const tracker = createInputQueueTracker();
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      // A steer is only meaningful while a turn runs, and this file's routers describe that case.
      isSessionRunning: () => true,
      queueControl: { update: (payload) => updated.push(payload), cancel: () => {} },
      // The fold is permanently empty, exactly as it is when no frame arrives.
      queueMirror: { dshItemId: () => null, mirror: () => {} },
      // The inbox is the authority, and it knows the controller's id.
      readSessionState: async () => ({
        inbox: { 'next-turn': [{ id: 'm1', source: { kind: 'user', rpcId: 'c1' }, content: [] }] },
        hasGoalKey: false,
      }),
      inputProjection: (sessionId) => tracker.projectionFor(sessionId, SESSION),
    }),
    subscribers: new Set(),
  });

  const result = await router(request('maker:input:remove', ['s1', 'c1']));
  assert.equal(result.payload.ok, true);
  // DSH is keyed on its own MessageId, which is what the inbox entry carries.
  assert.deepEqual(updated[0], { sessionId: 's1', itemId: 'm1', action: { kind: 'remove' } });
});

test('steer with a new message does not wait on a queue lookup', async () => {
  // The common steer is a brand-new message; it must decide immediately, not
  // after a bounded wait for an item that was never going to appear.
  const sent = [];
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      isSessionRunning: () => true,
      queueMirror: { dshItemId: () => null },
      readSessionState: async () => ({ inbox: { 'next-turn': [], 'next-step': [] }, hasGoalKey: false }),
      sendMessage: async (input) => sent.push(input),
    }),
    subscribers: new Set(),
  });

  const started = Date.now();
  const result = await router(request('maker:input:steer', ['s1', { clientId: 'fresh', text: 'hello' }]));
  assert.equal(result.payload.result, true);
  assert.ok(Date.now() - started < 500, 'no queue wait on the new-message path');
  assert.equal(sent[0].mode, 'steer');
});

test('a queue command reports what DSH said when it refuses', async () => {
  const { router } = makeRouter({ items: [item('m1', 'c1', 'x')], control: { throwOnUpdate: true } });
  const result = await router(request('maker:input:remove', ['s1', 'c1']));
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.error.code, 'THREW');
  assert.match(result.payload.error.message, /inbox rejected/);
});

test('a refusal that arrives as a rejection is reported, not left floating', async () => {
  // The measured outage, in one assertion. `queueControl.update` is async, so DSH's refusal
  // to mutate an inbox it has already admitted arrives as a **rejected promise** — and a
  // `try`/`catch` around an un-awaited call sees nothing. Two consequences, both fixed:
  // the controller was told the mutation succeeded (so a cancelled row came straight back),
  // and the unhandled rejection reached DSH's fail-loud handler, which printed
  // `fatal load failure: RemoteError: queued item is no longer pending` and exited the whole
  // `dsh web` process — taking the phone's relay link down with it.
  const refusal = Object.assign(new Error('queued item is no longer pending'), { code: 'session/queue-item-not-found' });
  const { router } = makeRouter({ items: [item('m1', 'c1', 'x')], control: { rejectWith: refusal } });

  // A floating rejection would surface here (or, in the real process, kill it) rather than in
  // the answer, so the answer is the only assertion that can prove the await happened.
  const result = await router(request('maker:input:remove', ['s1', 'c1']));
  assert.equal(result.payload.ok, false, 'a refused mutation is not reported as done');
  assert.equal(result.payload.error.code, 'session/queue-item-not-found', 'and DSH’s own code travels');
  assert.equal(result.payload.error.message, 'queued item is no longer pending');
});

test('the same refusal from a steer is reported instead of answered with true', async () => {
  const refusal = Object.assign(new Error('queued item is no longer pending'), { code: 'session/queue-item-not-found' });
  const { router } = makeRouter({ items: [item('m1', 'c1', 'queued text')], control: { rejectWith: refusal } });
  const result = await router(request('maker:input:steer', ['s1', { clientId: 'c1' }]));
  assert.equal(result.payload.ok, false, 'the promotion did not happen, and must not claim it did');
  assert.equal(result.payload.error.code, 'session/queue-item-not-found');
});

test('a Host with no queue control refuses the queue commands it cannot perform', async () => {
  const router = createChannelRouter({ listSessions: async () => ROWS, subscribers: new Set() });
  for (const [channel, args] of [
    ['maker:input:remove', ['s1', 'c1']],
    ['maker:input:update-text', ['s1', 'c1', 'x']],
    ['maker:input:stop', ['s1']],
    ['maker:input:clear-session', ['s1']],
  ]) {
    const result = await router(request(channel, args));
    assert.equal(result.payload.ok, false, `${channel} must not claim success`);
    assert.equal(result.payload.error.code, 'NOT_AVAILABLE');
  }
});

test('a queued row is identified by the controllers own clientId, not DSHs id', () => {
  // `rpcId` is minted by the controller and is what its submission echo retires
  // on. Reporting DSH's MessageId made the confirmed row look like a different
  // message, so the composer kept the draft and the next input was appended.
  const row = toQueuedRemoteMessage(item('msg-1', 'client-1', 'hello'), SESSION);
  assert.equal(row.clientId, 'client-1');
  assert.equal(row.chatMessage.clientId, 'client-1');

  // An older Host that never sent an rpcId still yields a usable row.
  const legacy = toQueuedRemoteMessage({ id: 'msg-2', placement: 'queued', message: { id: 'msg-2', content: [{ type: 'text', text: 'hi' }] } }, SESSION);
  assert.equal(legacy.clientId, 'msg-2');
});

test('the locally accepted row carries the identity the controller sent', () => {
  const row = queuedRowFromController({ clientId: 'client-9', text: 'hi', session: SESSION });
  assert.equal(row.clientId, 'client-9');
  assert.equal(row.chatMessage.role, 'user');
});

test('a mutation waits for the queue frame that carries the durable id', async () => {
  // The controller can press 取消 on a row it can already see — moments before
  // DSH's own `queue` frame arrives with the durable `MessageId`. Answering
  // NOT_FOUND inside that window made the button look broken on a message the
  // user had just sent, so the id resolution waits for the frame.
  const updated = [];
  const tracker = createInputQueueTracker();
  let polls = 0;
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      // A steer is only meaningful while a turn runs, and this file's routers describe that case.
      isSessionRunning: () => true,
      queueControl: { update: (payload) => updated.push(payload), cancel: () => {} },
      queueMirror: {
        dshItemId: (sessionId, controllerId) => {
          polls += 1;
          if (polls < 3) return null;
          // The frame lands between two polls.
          tracker.apply({ type: 'queue', sessionId, items: [item('m1', controllerId, 'x')] });
          return tracker.dshItemId(sessionId, controllerId);
        },
        mirror: (sessionId, itemId, action) => tracker.mirror(sessionId, itemId, action),
      },
      inputProjection: (sessionId) => tracker.projectionFor(sessionId, SESSION),
    }),
    subscribers: new Set(),
  });

  const result = await router(request('maker:input:remove', ['s1', 'c1']));
  assert.equal(result.payload.ok, true, 'the removal is not refused just because the frame was late');
  assert.equal(updated[0].itemId, 'm1', 'and it commits against the durable id');
});

test('an item that never appears is still refused, not retried forever', async () => {
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      // A steer is only meaningful while a turn runs, and this file's routers describe that case.
      isSessionRunning: () => true,
      queueControl: { update: () => {}, cancel: () => {} },
      queueMirror: { dshItemId: () => null },
    }),
    subscribers: new Set(),
  });
  const started = Date.now();
  const result = await router(request('maker:input:remove', ['s1', 'ghost']));
  assert.equal(result.payload.error.code, 'NOT_FOUND');
  // Bounded: the button must still answer promptly for a row that is really gone.
  assert.ok(Date.now() - started >= 1400, 'it waited for the frame before refusing');
});
