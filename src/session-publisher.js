/**
 * Send one list-level push to the controllers holding the `sessions` topic.
 *
 * @param ws - the relay socket.
 * @param subscribers - the devices holding the topic.
 * @param channel - the push channel.
 * @param payload - the channel's payload.
 * @param record - called with the channel and its watcher count.
 *
 * `record` exists because these pushes bypass the session-scoped path that keeps
 * `recentPushes`/`pushTotals`. Without it the list-level pushes — the very ones a
 * session list's running badge depends on — were invisible in diagnostics, so
 * "did we tell the controller the turn ended?" could not be answered at all.
 */
export function publish(ws, subscribers, channel, payload, record) {
  if (typeof record === 'function') record(channel, subscribers.size, payload);
  for (const dst of subscribers) ws.send(JSON.stringify({ v: 1, kind: 'push', dst, payload: { channel, payload } }));
}

/**
 * The controller's live-activity phase for one lifecycle item, or null.
 *
 * The mapping is by **kind as well as phase**, because DSH reuses `idle` for two
 * different facts: a turn that just finished (`session-status`) and a session
 * that has simply never run (`session-added`). Only the first is a completion.
 *
 * The fallback matters more than it looks. This used to end in `: 'running'`, so
 * every phase it did not name — `idle` above all — announced a running turn. The
 * controller sets `isRunning: true` for `running` and only converges it to false
 * for `completed`/`error`, so a finished turn left the session list spinning
 * until something else happened to correct it.
 *
 * @param item - one lifecycle item from the projection sink.
 * @returns the controller's phase, or null when the item claims nothing.
 */
export function activityPhaseFor(item) {
  if (item === null || typeof item !== 'object') return null;
  // A session appearing or a subscription opening says nothing about a turn.
  if (item.kind === 'session-added' || item.kind === 'session-removed' || item.kind === 'session-subscribed') return null;
  switch (item.phase) {
    case 'waiting': return 'needs-interaction';
    case 'running': return 'running';
    case 'completed': return 'completed';
    case 'error': return 'error';
    // A turn that ended: the only thing that tells the controller to stop.
    case 'idle': return 'completed';
    // `active` is DSH's bare "something happened" tick, not a statement that a
    // turn is live — `api-session/status` is that authority. Claiming `running`
    // for it meant a tick arriving *after* a turn ended told the controller the
    // session was busy again, with no later terminal event to undo it: the
    // spinner never stopped. An unknown phase is the same kind of non-claim.
    default: return null;
  }
}

export function publishActivity(ws, subscribers, item, record) {
  const phase = activityPhaseFor(item);
  // An item this Host cannot place is not a claim about the session's state.
  if (phase === null) return;
  publish(ws, subscribers, 'local-db:sessions:activity', { sessionId: item.sessionId, phase, compactDetail: '', attention: phase === 'needs-interaction' }, record);
}

/**
 * Publish one lifecycle item to the list subscribers.
 * @param ws - the relay socket.
 * @param subscribers - the devices holding the `sessions` topic.
 * @param item - one lifecycle item from the projection sink.
 * @param record - called with each channel and its watcher count.
 */
export function publishLifecycle(ws, subscribers, item, record) {
  if (item.kind === 'session-added') publish(ws, subscribers, 'local-db:sessions:created', { sessionId: item.sessionId }, record);
  else if (item.kind === 'session-status') publish(ws, subscribers, 'local-db:sessions:patched', { sessionId: item.sessionId, patch: { updatedAt: item.occurredAt } }, record);
  publishActivity(ws, subscribers, item, record);
}

/**
 * The per-session turn event that starts and stops the controller's spinner.
 *
 * The controller clears "thinking" on a terminal `maker:event` and on nothing
 * else: `maker:status-changed` only retires a *closed* session, and the
 * list-level activity push belongs to the `sessions` topic, which a controller
 * viewing a single session does not hold. Without this, a finished turn left the
 * phone spinning forever — the answer had arrived and the composer still said
 * 思考中.
 *
 * `maker:event` is session-scoped, so it must go to `session:<id>` watchers
 * rather than to the list subscribers.
 * @param item - one lifecycle item from the projection sink.
 * @returns the channel and payload, or null when the item says nothing about a turn.
 */
export function turnEventFor(item) {
  const sessionId = item?.sessionId;
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  if (item.kind !== 'session-status') return null;
  switch (item.phase) {
    // A turn (or a wait for the user) is live.
    case 'running':
    case 'waiting':
      return { channel: 'maker:event', payload: { sessionId, event: { type: 'status', data: { isRunning: true } } } };
    // A failure is unambiguous.
    case 'error':
      return { channel: 'maker:event', payload: { sessionId, event: { type: 'done' } } };
    // `idle` is deliberately NOT an ending here.
    //
    // This flag flaps: `api-session/status` reports `running: false` for a moment
    // between a prompt being accepted and its turn really starting, so treating it
    // as the end sent a `done` **31 ms after a live turn began** — the controller
    // finalized its streaming rows and stopped its timer while the agent was still
    // generating. Real endings come from DSH's own `turn/end` event (driven by the
    // plugin), with the durable-message reconcile as the fallback if one is lost.
    //
    // `active` is the same kind of non-claim: it is a bare "something happened"
    // tick, not a statement about a turn.
    default:
      return null;
  }
}
