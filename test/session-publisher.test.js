import test from 'node:test'; import assert from 'node:assert/strict'; import { publishActivity, turnEventFor, activityPhaseFor } from '../src/session-publisher.js';
test('sends safe activity only to subscribers',()=>{const sent=[]; publishActivity({send:(x)=>sent.push(JSON.parse(x))},new Set(['a']),{sessionId:'s',phase:'waiting'}); assert.deepEqual(sent[0],{v:1,kind:'push',dst:'a',payload:{channel:'local-db:sessions:activity',payload:{sessionId:'s',phase:'needs-interaction',compactDetail:'',attention:true}}});});

test('a finished turn tells the session watchers to stop spinning', () => {
  // The controller clears "thinking" on a terminal `maker:event` only, and it is
  // session-scoped: a controller viewing one session never holds `sessions`, so
  // the list-level activity push cannot reach it.
  //
  // A real ending is driven by DSH's `turn/end` event now. This projection-level
  // path keeps the unambiguous cases: a failure ends the turn, and `idle` is
  // deliberately not one of them — that flag flaps *inside* a turn (the source
  // emits `running: false` between a prompt being accepted and its turn really
  // starting), and reading it as the end sent a `done` 31 ms into a live turn.
  // The measured sequence was `status isRunning:true` at 04.589 and `done` at
  // 04.620, with the agent still generating.
  assert.equal(
    turnEventFor({ sessionId: 's1', kind: 'session-status', phase: 'idle' }),
    null,
    'a flapping running flag must not be allowed to end a turn',
  );
  assert.deepEqual(turnEventFor({ sessionId: 's1', kind: 'session-status', phase: 'error' }).payload.event, { type: 'done' });
});

test('a live turn tells the session watchers to spin', () => {
  assert.deepEqual(turnEventFor({ sessionId: 's1', kind: 'session-status', phase: 'running' }), {
    channel: 'maker:event',
    payload: { sessionId: 's1', event: { type: 'status', data: { isRunning: true } } },
  });
  assert.equal(turnEventFor({ sessionId: 's1', kind: 'session-status', phase: 'waiting' }).payload.event.data.isRunning, true);
});

test('items that say nothing about a turn produce no event', () => {
  // `session-added` and friends are list-level facts; inventing a `done` for them
  // would clear a spinner for a turn that is still running.
  for (const item of [
    { sessionId: 's1', kind: 'session-added', phase: 'running' },
    { sessionId: 's1', kind: 'session-subscribed', phase: 'subscribed' },
    { sessionId: '', kind: 'session-status', phase: 'idle' },
    undefined,
  ]) {
    assert.equal(turnEventFor(item), null);
  }
});

test('a finished turn is announced as finished, never as running', () => {
  // `idle` is DSH's word for "nothing running" and it is what the source emits
  // when a turn ends. The mapping used to fall back to `running`, so the session
  // list kept spinning after the answer had landed: the controller sets
  // isRunning true for `running` and only converges it on `completed`/`error`.
  assert.equal(activityPhaseFor({ sessionId: 's1', kind: 'session-status', phase: 'idle' }), 'completed');
  assert.equal(activityPhaseFor({ sessionId: 's1', kind: 'session-status', phase: 'running' }), 'running');
  assert.equal(activityPhaseFor({ sessionId: 's1', kind: 'session-status', phase: 'waiting' }), 'needs-interaction');
  assert.equal(activityPhaseFor({ sessionId: 's1', kind: 'session-status', phase: 'error' }), 'error');
  // `active` is DSH's bare "something happened" tick, not a claim that a turn is
  // live — `api-session/status` is that authority. Reading it as `running` meant a
  // tick arriving *after* a turn ended told the controller the session was busy
  // again, with nothing later to undo it, so the spinner never stopped.
  assert.equal(activityPhaseFor({ sessionId: 's1', kind: 'session-status', phase: 'active' }), null);
  // The session-scoped view must agree: a tick is not a turn *ending* either, or
  // the spinner would clear in the middle of live work.
  assert.equal(turnEventFor({ sessionId: 's1', kind: 'session-status', phase: 'active' }), null);
});

test('an item that claims nothing about a turn announces nothing', () => {
  // A new session is not a completed turn, and a subscription is not activity.
  // An unknown phase must not become a claim either.
  for (const item of [
    { sessionId: 's1', kind: 'session-added', phase: 'idle' },
    { sessionId: 's1', kind: 'session-removed', phase: 'idle' },
    { sessionId: 's1', kind: 'session-subscribed', phase: 'subscribed' },
    { sessionId: 's1', kind: 'session-status', phase: 'unknown' },
    undefined,
  ]) {
    assert.equal(activityPhaseFor(item), null);
  }
});

test('the activity push carries the phase the controller acts on', () => {
  const sent = [];
  publishActivity({ send: (x) => sent.push(JSON.parse(x)) }, new Set(['a']), { sessionId: 's', kind: 'session-status', phase: 'idle' });
  assert.equal(sent[0].payload.payload.phase, 'completed');
  assert.equal(sent[0].payload.payload.attention, false);

  // An item that says nothing is not pushed at all.
  const none = [];
  publishActivity({ send: (x) => none.push(JSON.parse(x)) }, new Set(['a']), { sessionId: 's', kind: 'session-added', phase: 'idle' });
  assert.deepEqual(none, []);
});
