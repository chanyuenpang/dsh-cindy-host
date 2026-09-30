import { createHmac, randomBytes } from 'node:crypto';

/** Bounded observation only: never authority, work scheduling, credentials or file contents. */
export function createTransferDiagnostics({ now = Date.now, limit = 128 } = {}) {
  const capacity = Number.isSafeInteger(limit) && limit > 0 ? Math.min(128, limit) : 128;
  const events = [];
  const counts = Object.create(null);
  const progress = new Map();
  let salt = randomBytes(32);
  const digest = (kind, value) => createHmac('sha256', salt).update(JSON.stringify([kind, value])).digest('hex');
  const identify = ({ actor, owner, real, info } = {}) => ({
    ...(typeof actor === 'string' && actor.length <= 256 ? { actorId: digest('actor', actor) } : {}),
    ...(owner ? { ownerId: digest('owner', [owner.runtimeId, owner.epoch, owner.realm, owner.userId]) } : {}),
    ...(typeof real === 'string' && real.length <= 32768 && info ?
      { sourceId: digest('source', [real, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]) } : {}),
  });
  const names = new Set(['start', 'accepted', 'opening', 'presign', 'put', 'progress', 'cleanup', 'done', 'error', 'cancelled', 'offer-answer', 'dc-open', 'file-open', 'bytes-queued', 'eof-queued', 'closed']);
  function record(input = {}) {
    const transport = input.transport === 'peer' ? 'peer' : 'oss';
    const event = names.has(input.event) ? input.event : 'other';
    const key = transport + ':' + event;
    counts[key] = Math.min(Number.MAX_SAFE_INTEGER, (counts[key] ?? 0) + 1);
    const at = Number(now());
    const identity = typeof input.transferId === 'string' ? input.transferId : input.connection;
    if (event === 'progress' || event === 'bytes-queued') {
      if (at - (progress.get(identity) ?? -Infinity) < 1000) return;
      if (progress.size >= 64) progress.delete(progress.keys().next().value);
      progress.set(identity, at);
    }
    const row = { transport, event, at };
    const stages = new Set(['validate', 'validation', 'opening', 'verify', 'credential', 'presign', 'refresh', 'put', 'upload', 'close', 'cleanup', 'terminal']);
    const codes = new Set(['INVALID_ARGUMENT', 'OVERSIZE', 'SOURCE_CHANGED', 'OWNER_UNVERIFIED', 'PRESIGN_FAILED', 'AUTH_FAILED', 'SOURCE_READ_FAILED', 'SIZE_MISMATCH', 'PUT_FAILED', 'INCOMPLETE_UPLOAD', 'NETWORK_ERROR', 'ABORTED', 'STAGE_TIMEOUT', 'IDLE_TIMEOUT', 'CANCELLED', 'UPLOAD_FAILED', 'FORBIDDEN', 'NOT_FOUND', 'FILE_PEER_CLOSED', 'FILE_PEER_TIMEOUT', 'FILE_PEER_CHANGED', 'FILE_PEER_REVOKED', 'FILE_PEER_BLOCK', 'FILE_PEER_DENIED']);
    if (stages.has(input.stage)) row.stage = input.stage;
    if (codes.has(input.code)) row.code = input.code;
    for (const field of ['actorId', 'ownerId', 'sourceId']) {
      if (typeof input[field] === 'string' && /^[a-f0-9]{64}$/.test(input[field])) row[field] = input[field];
    }
    // All caller-provided free text is excluded. IDs are opaque generated UUIDs, not actor IDs.
    for (const field of ['transferId', 'connection']) {
      if (typeof input[field] === 'string' && /^(exp_)?[a-f0-9-]{16,64}$/.test(input[field])) row[field] = input[field];
    }
    for (const field of ['size', 'uploaded', 'queuedBytes', 'status']) {
      if (Number.isSafeInteger(input[field]) && input[field] >= 0) row[field] = input[field];
    }
    events.push(row);
    if (events.length > capacity) events.splice(0, events.length - capacity);
  }
  return { record, identify, clear() { salt = randomBytes(32); events.length = 0; progress.clear(); for (const k of Object.keys(counts)) delete counts[k]; },
    snapshot: () => ({ counters: { ...counts }, events: events.map(row => ({ ...row })) }) };
}
