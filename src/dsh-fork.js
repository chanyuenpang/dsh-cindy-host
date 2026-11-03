import { foldSurface } from '@deepseek-ai/dsh-session/surface';
import { foldSessionEvent } from './dsh-message-fold.js';
import { refusalError } from './cindy-channels.js';

const unavailable = message => refusalError('NOT_AVAILABLE', message);
const completed = event => event?.data?.reason === 'completed' || event?.data?.reason?.kind === 'completed';

/** Locate by the actual shared row fold, never by parsing a client-controlled ID. */
export function nativeForkCut(events, sessionId, messageClientId, maxEvents = 100_000) {
  if (!Array.isArray(events) || events.length > maxEvents) throw unavailable('Native fork history exceeds the validated observation budget');
  if (events.some((event, seq) => !event || event.seq !== seq)) throw unavailable('Native fork requires a contiguous source prefix');
  let current;
  try { current = new Set(foldSurface(events).nodes); }
  catch (error) { throw unavailable('Native source history cannot be mapped safely: ' + String(error.message)); }
  const matches = new Map();
  for (const event of events) {
    for (const row of foldSessionEvent(event, { sessionId })) {
      if (row.id === messageClientId || row.clientId === messageClientId) matches.set(event.seq, { event, row });
    }
  }
  if (matches.size === 0) throw refusalError('NOT_FOUND', 'No committed source message matches this fork identity');
  if (matches.size !== 1) throw refusalError('BAD_REQUEST', 'Fork message identity is ambiguous');
  const { event: target, row } = matches.values().next().value;
  if (!['user', 'assistant'].includes(row.role) || !['user/message', 'assistant/message'].includes(target.type)) throw unavailable('Only ordinary user or assistant messages can be forked');
  if (!current.has(target.seq)) throw unavailable('A shadowed message cannot select a current fork boundary');
  const turns = []; let open = null;
  for (const event of events) {
    if (event.type === 'turn/start') {
      if (open) throw unavailable('Overlapping native turns cannot be mapped safely');
      open = { start: event.seq, end: null };
    } else if (event.type === 'turn/end') {
      if (!open) throw unavailable('Native turn history has an unmatched ending');
      open.end = event.seq; open.completed = completed(event); turns.push(open); open = null;
    }
  }
  if (row.role === 'assistant') {
    const turn = turns.find(turn => turn.start < target.seq && turn.end > target.seq);
    if (!turn?.completed) throw unavailable('The assistant fork point requires a completed native turn');
    return turn.end;
  }
  if (target.data?.source?.kind !== 'user') throw unavailable('Only a committed human prompt can select a user-before fork');
  const prior = turns.filter(turn => turn.end < target.seq && turn.completed).at(-1);
  if (!prior || !events.some(event => event.seq > prior.start && event.seq < prior.end && event.type === 'assistant/message' && current.has(event.seq))) {
    throw unavailable('NO_PRIOR_ASSISTANT: no completed assistant turn precedes this user prompt');
  }
  // Real DSH logs open turn/start and step/start before admitting a user message.
  // That empty open tail is closed by native fork seed construction. Do not cut
  // a steering prompt through an already-producing assistant/tool step.
  if (events.some(event => event.seq > prior.end && event.seq < target.seq &&
    ['assistant/message', 'tool/call', 'tool/result'].includes(event.type))) {
    throw unavailable('A user-before fork cannot cut through an unfinished assistant/tool turn');
  }
  return target.seq - 1;
}

/** In-process receipt deduplication; native fork has no durable caller idempotency key. */
export function createDshFork({ getController, getQuery, getSession, invalidate = () => {}, isHidden = () => false,
  now = Date.now, maxReceipts = 128, receiptTtlMs = 15 * 60_000 }) {
  const receipts = new Map(); let generation = 0; let disposed = false;
  function check(expected) { if (disposed || generation !== expected) throw unavailable('Native fork source changed before creation'); }
  function run({ sessionId, messageClientId, requestKey }) {
    if (typeof sessionId !== 'string' || !sessionId.trim() || typeof messageClientId !== 'string' || !messageClientId.trim() ||
      typeof requestKey !== 'string' || requestKey.length > 1024) return Promise.reject(refusalError('BAD_REQUEST', 'fork needs exact session, message and request identities'));
    for (const [key, receipt] of receipts) if (!receipt.pending && now() - receipt.at > receiptTtlMs) receipts.delete(key);
    const fingerprint = JSON.stringify([sessionId, messageClientId]);
    const old = receipts.get(requestKey);
    if (old) return old.fingerprint === fingerprint ? old.promise : Promise.reject(refusalError('BAD_REQUEST', 'Fork request identity reused with different arguments'));
    if (disposed) return Promise.reject(unavailable('Native fork source is disposed'));
    while (receipts.size >= maxReceipts) {
      const entry = [...receipts].find(([, value]) => !value.pending);
      if (!entry) return Promise.reject(unavailable('Too many pending native fork requests'));
      receipts.delete(entry[0]);
    }
    const epoch = generation;
    const promise = Promise.resolve().then(() => perform(sessionId, messageClientId, epoch));
    const receipt = { fingerprint, promise, pending: true, at: now() }; receipts.set(requestKey, receipt);
    void promise.then(() => { receipt.pending = false; receipt.at = now(); }, () => { receipt.pending = false; receipt.at = now(); });
    return promise;
  }
  async function perform(sessionId, messageClientId, epoch) {
    check(epoch);
    const controller = getController(); const query = getQuery();
    if (typeof controller?.fork !== 'function' || typeof query?.observeSession !== 'function') throw unavailable('Native DSH fork/observation is not composed');
    if (isHidden(sessionId)) throw unavailable('An archived or hidden source cannot be forked through this Host');
    if (!await getSession(sessionId)) throw refusalError('NOT_FOUND', 'No visible ordinary source session');
    check(epoch);
    let observation; let atSeq;
    try {
      observation = await query.observeSession(sessionId, { projectionMode: 'none' });
      check(epoch);
      if (observation?.header?.id !== sessionId || !Array.isArray(observation.events)) throw unavailable('Native fork observation does not match its source');
      atSeq = nativeForkCut(observation.events, sessionId, messageClientId);
    } finally { observation?.[Symbol.dispose]?.(); }
    check(epoch);
    if (getController() !== controller || getQuery() !== query) throw unavailable('Native fork services changed during observation');
    let childId; let partial;
    try { childId = (await controller.fork({ sessionId, atSeq }))?.sessionId; }
    catch (error) {
      if (error?.code !== 'session/workspace-attach-failed' || typeof error?.data?.sessionId !== 'string') throw error;
      childId = error.data.sessionId;
      partial = 'Native child was created, but Workspace attachment failed';
    }
    if (typeof childId !== 'string' || !childId || childId === sessionId) throw Error('Native fork did not return a distinct created session identity');
    try { invalidate(); }
    catch (error) { partial = 'Native child was created, but listing refresh failed: ' + String(error.message); }
    if (disposed || generation !== epoch || getController() !== controller || getQuery() !== query) partial = 'Native child was created after the source connection changed';
    // Always retain a known created ID. Never throw away creation evidence and
    // automatically repeat fork because attachment or row discovery failed.
    return { sessionId: childId, ...(partial ? { partial } : {}) };
  }
  function cancelAll() { generation++; } // Native fork has no cancellation/rollback API.
  function dispose() { disposed = true; cancelAll(); }
  return { run, cancelAll, dispose };
}
