/** Bounded, in-memory Export jobs. Host owns authorization; uploader owns HTTP/cleanup. */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { extname } from 'node:path';
import { mimeForMediaPath } from './host-media-fetch.js';

const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const MESSAGES = Object.freeze({
  BAD_REQUEST: 'invalid file export request',
  FORBIDDEN: 'file export is not authorized',
  NOT_FOUND: 'the requested file or transfer was not found',
  OVERSIZE: 'the file exceeds the export limit',
  NOT_AVAILABLE: 'file export is busy or unavailable',
  OWNER_UNVERIFIED: 'the export account is no longer verified',
  CANCELLED: 'file export was cancelled',
  SOURCE_CHANGED: 'the export source changed',
  SOURCE_READ_FAILED: 'the export source could not be read',
  AUTH_FAILED: 'file export authentication failed',
  PRESIGN_FAILED: 'file export staging failed',
  PUT_FAILED: 'file export upload failed',
  UPLOAD_FAILED: 'file export upload failed',
  NETWORK: 'file export network request failed',
  TIMEOUT: 'file export timed out',
  STAGE_TIMEOUT: 'file export staging timed out',
  IDLE_TIMEOUT: 'file export upload stalled',
  NETWORK_ERROR: 'file export network request failed',
  SIZE_MISMATCH: 'the export source changed',
  INCOMPLETE_UPLOAD: 'file export upload was incomplete',
  ABORTED: 'file export was cancelled',
  INVALID_ARGUMENT: 'invalid file export request',
});
const STAGES = new Set(['validation', 'open', 'credential', 'presign', 'refresh', 'put', 'verify', 'cleanup', 'close', 'done']);
const UPLOAD_EVENTS = Object.freeze({
  presign: 'presign', presign_start: 'presign', presign_done: 'presign', presign_error: 'error',
  refresh: 'presign', put: 'put', put_start: 'put', put_done: 'put', put_error: 'error',
  complete: 'put', error: 'error', timeout: 'error', source_changed: 'error',
  cleanup_start: 'cleanup', cleanup_done: 'cleanup', cleanup_error: 'cleanup',
  cleanup_failed: 'cleanup', cleanup_skipped_owner: 'cleanup',
});
const safeCode = (code, fallback = 'UPLOAD_FAILED') => typeof code === 'string' && Object.hasOwn(MESSAGES, code) ? code : fallback;
const failure = (code) => ({ ok: false, code, message: MESSAGES[code] });
const sourceError = () => Object.assign(new Error(MESSAGES.SOURCE_CHANGED), { code: 'SOURCE_CHANGED' });
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const regular = (info) => typeof info?.isFile === 'function' && info.isFile();
const sameSnapshot = (actual, expected) => regular(actual)
  && expected.dev !== undefined && expected.ino !== undefined
  && actual.dev === expected.dev && actual.ino === expected.ino
  && actual.size === expected.size && actual.mtimeMs === expected.mtimeMs;

/**
 * Open only the authorized snapshot. O_NONBLOCK prevents a raced FIFO from hanging
 * open on POSIX. Windows lacks O_NOFOLLOW: lstat + fd identity still prevent a
 * substituted target from supplying bytes. No read occurs before fstat.
 */
async function openSafeSource(real, info, { signal }) {
  let fd;
  try {
    signal.throwIfAborted();
    if (!sameSnapshot(await lstat(real), info)) throw sourceError();
    fd = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    signal.throwIfAborted();
    if (!sameSnapshot(await fd.stat(), info)) throw sourceError();
    let closing;
    return {
      size: info.size,
      async read(buffer, position) {
        signal.throwIfAborted();
        if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(position) || position < 0 || position > info.size) throw sourceError();
        const length = Math.min(buffer.length, info.size - position);
        return (await fd.read(buffer, 0, length, position)).bytesRead;
      },
      async verify() {
        signal.throwIfAborted();
        if (!sameSnapshot(await fd.stat(), info)) throw sourceError();
      },
      close() { return closing ??= fd.close(); },
    };
  } catch (error) {
    if (fd) await fd.close().catch(() => {});
    throw error;
  }
}

/**
 * resolveSource(workdir, relPath, {maxBytes, signal}) authorizes a real path + stat.
 * openSource(real, info, {signal}) is a test seam returning size/read/verify/close.
 * upload(source, {owner, signal, ext, contentType, onProgress, onEvent}) must settle
 * only after final source verification and its own bounded cleanup; it must NOT
 * close source (manager owns it). Success may carry an idempotent async discard()
 * for bounded cleanup if cancellation/close failure prevents publishing that key.
 * Owner is an opaque stable object, not credentials. Policy excludes connectivity.
 * start returns one shared Promise per owner/src/RPC id; status is synchronous.
 * Cancellation methods abort synchronously. invalidateOwner/stop also return
 * settlement Promises; callers need not wait before rotating credentials/policy.
 */
export function createExportJobs({
  resolveSource, upload, captureOwner, isOwnerCurrent, isControllerAllowed,
  now = Date.now, emit, identify, maxActive = 2, maxJobs = 64, ttlMs = 600000,
  openSource = openSafeSource,
}) {
  for (const fn of [resolveSource, upload, captureOwner, isOwnerCurrent, isControllerAllowed, now, openSource]) {
    if (typeof fn !== 'function') throw new TypeError('invalid export dependency');
  }
  if (!Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 2
    || !Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 64
    || !Number.isSafeInteger(ttlMs) || ttlMs < 0) throw new TypeError('invalid export limits');
  const jobs = new Map();
  let active = 0;
  let stopped = false;
  let invalidOwner;
  const time = () => Number(now());
  const allowed = (src) => { try { return isControllerAllowed(src) === true; } catch { return false; } };
  const current = (owner) => { try { return owner !== invalidOwner && isOwnerCurrent(owner) === true; } catch { return false; } };
  const ownerNow = () => { try { const owner = captureOwner(); return owner && typeof owner === 'object' ? owner : null; } catch { return null; } };

  const tags = (facts) => {
    try {
      const value = identify?.(facts);
      if (value?.then) { void Promise.resolve(value).catch(() => {}); return {}; }
      return Object.fromEntries(['actorId', 'ownerId', 'sourceId']
        .filter(key => typeof value?.[key] === 'string' && /^[a-f0-9]{64}$/.test(value[key]))
        .map(key => [key, value[key]]));
    } catch { return {}; }
  };
  // Never forward free-form producer fields, paths, owners, credentials or keys.
  function event(job, name, stage, code) {
    try {
      if (!current(job.owner)) return;
      job.tags ??= tags({ actor: job.src, owner: job.owner });
      Promise.resolve(emit?.({ ...job.tags, transport: 'oss', event: name, transferId: job.id,
        stage: STAGES.has(stage) ? stage : 'put', at: time(), size: job.size, uploaded: job.uploaded,
        ...(code ? { code: safeCode(code) } : {}),
      })).catch(() => {});
    } catch { /* Diagnostics must never change transfer outcomes. */ }
  }
  function finishError(job, code) {
    if (job.state !== 'uploading') return;
    job.state = 'error';
    job.code = safeCode(code);
    job.terminalAt = time();
    delete job.key;
    event(job, 'error', job.stage, job.code);
    // Terminalize before synchronous abort listeners can report a late success.
    job.controller.abort();
    if (!job.accepted) job.resolveStart(Object.freeze(failure(job.code)));
  }
  function revoke(job, code) {
    job.revoked = true;
    delete job.key;
    finishError(job, code);
    job.controller.abort();
  }
  function live(job) {
    if (job.state !== 'uploading' || job.revoked) return false;
    if (stopped) { revoke(job, 'CANCELLED'); return false; }
    if (!current(job.owner)) { revoke(job, 'OWNER_UNVERIFIED'); return false; }
    if (!allowed(job.src)) { revoke(job, 'FORBIDDEN'); return false; }
    return true;
  }
  function prune() {
    const at = time();
    for (const [id, job] of jobs) {
      // Terminal-but-cleaning jobs still own BOTH quotas, even beyond their TTL.
      if (!job.active && job.state !== 'uploading' && at - job.terminalAt >= ttlMs) jobs.delete(id);
    }
  }
  function pruneUnauthorized() {
    for (const job of jobs.values()) {
      if (!current(job.owner)) revoke(job, 'OWNER_UNVERIFIED');
      else if (!allowed(job.src)) revoke(job, 'FORBIDDEN');
    }
    prune();
  }

  async function run(job) {
    let source;
    let result;
    try {
      if (!live(job)) return;
      const resolved = await resolveSource(job.args.workdir, job.args.relPath, {
        maxBytes: job.limit, signal: job.controller.signal,
      });
      if (!live(job)) return;
      if (resolved?.ok !== true) { finishError(job, safeCode(resolved?.code, 'SOURCE_READ_FAILED')); return; }
      const info = resolved.info;
      if (!text(resolved.real, 32768) || !regular(info) || !Number.isSafeInteger(info.size) || info.size < 0
        || !Number.isFinite(info.mtimeMs)) { finishError(job, 'BAD_REQUEST'); return; }
      if (info.size > job.limit) { finishError(job, 'OVERSIZE'); return; }
      job.tags = tags({ actor: job.src, owner: job.owner, real: resolved.real, info });
      job.size = info.size;
      job.stage = 'open';
      event(job, 'opening', 'open');
      if (!live(job)) return;
      // Assign before checking cancellation: a late open is still our descriptor.
      source = await openSource(resolved.real, info, { signal: job.controller.signal });
      if (!live(job)) return;
      if (source?.size !== info.size || typeof source?.read !== 'function'
        || typeof source?.verify !== 'function' || typeof source?.close !== 'function') throw sourceError();
      await source.verify();
      if (!live(job)) return;
      const checkedSource = {
        size: source.size,
        async read(buffer, position) {
          try {
            if (!live(job)) throw sourceError();
            if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(position) || position < 0 || position > job.size) throw sourceError();
            const bytes = await source.read(buffer, position);
            if (!live(job)) throw sourceError();
            if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > buffer.length
              || position + bytes > job.size || (bytes === 0 && position < job.size)) throw sourceError();
            return bytes;
          } catch (error) {
            finishError(job, safeCode(error?.code, 'SOURCE_READ_FAILED'));
            throw Object.assign(new Error(MESSAGES[job.code] ?? MESSAGES.SOURCE_READ_FAILED), { code: job.code ?? 'SOURCE_READ_FAILED' });
          }
        },
        async verify() {
          try {
            if (!live(job)) throw sourceError();
            await source.verify();
            if (!live(job)) throw sourceError();
          } catch (error) {
            finishError(job, safeCode(error?.code, 'SOURCE_CHANGED'));
            throw Object.assign(new Error(MESSAGES[job.code] ?? MESSAGES.SOURCE_CHANGED), { code: job.code ?? 'SOURCE_CHANGED' });
          }
        },
        // Only finally closes the real source, including badly behaved uploaders.
        close: async () => {},
      };
      job.accepted = true;
      job.stage = 'put';
      job.resolveStart(Object.freeze({ ok: true, transferId: job.id, size: info.size, mtimeMs: info.mtimeMs }));
      event(job, 'accepted', 'put');
      if (!live(job)) return;
      const extension = extname(resolved.real).slice(1);
      result = await upload(checkedSource, {
        owner: job.owner, signal: job.controller.signal,
        ext: /^[a-zA-Z0-9]{1,32}$/.test(extension) ? extension : 'bin',
        contentType: mimeForMediaPath(resolved.real),
        onProgress(value) {
          if (!live(job)) return;
          const bytes = typeof value === 'number' ? value : value?.uploaded;
          if (Number.isSafeInteger(bytes) && bytes >= 0 && bytes > job.uploaded) {
            job.uploaded = Math.min(job.size, bytes);
            event(job, 'progress', 'put');
          }
        },
        onEvent(value) {
          try {
            const type = value?.type ?? value?.event;
            if (typeof type === 'string' && Object.hasOwn(UPLOAD_EVENTS, type)) {
              const stage = type.startsWith('cleanup') ? 'cleanup' : value.stage === 'validate' ? 'validation' : value.stage;
              event(job, UPLOAD_EVENTS[type], stage, value.code);
            }
          } catch { /* Even malformed producer events are only diagnostics. */ }
        },
      });
      if (!live(job)) return;
      if (result?.ok !== true) { finishError(job, safeCode(result?.code)); return; }
      if (!text(result.key, 4096) || result.size !== job.size
        || typeof result.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(result.sha256)) {
        finishError(job, 'UPLOAD_FAILED'); return;
      }
      // Final verification belongs to upload so every verification failure can
      // clean its unpublished object before returning. Do not verify again here.
    } catch (error) {
      finishError(job, safeCode(error?.code, job.accepted ? 'UPLOAD_FAILED' : 'SOURCE_READ_FAILED'));
    } finally {
      job.stage = 'close';
      if (source) {
        try { await source.close(); }
        catch { finishError(job, 'SOURCE_READ_FAILED'); }
      }
      if (result?.ok === true && live(job)) {
        job.state = 'done';
        job.key = result.key;
        job.uploaded = job.size;
        job.terminalAt = time();
        event(job, 'done', 'done');
      } else if (result?.ok === true) {
        // Upload may win the race with revoke, or fd.close may fail after PUT.
        // Its captured-owner discard is idempotent/bounded; never borrow credentials.
        job.stage = 'cleanup';
        try { await result.discard?.(); }
        catch { event(job, 'cleanup', 'cleanup', 'UPLOAD_FAILED'); }
      }
      job.active = false;
      active--;
      // Failed admission isn't retained or cached after its resource lifetime.
      if (!job.accepted) jobs.delete(job.id);
    }
  }

  function start(input, request) {
    prune();
    const validId = text(request?.id, 256) || (Number.isSafeInteger(request?.id) && request.id >= 0);
    if (!text(request?.src, 256) || !validId || !text(input?.workdir, 4096) || !input.workdir.trim()
      || !text(input?.relPath, 4096) || !input.relPath.trim()
      || /^(?:[a-zA-Z]:|[/\\])/.test(input.relPath)
      || (input.maxBytes !== undefined && (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0))) {
      return Promise.resolve(failure('BAD_REQUEST'));
    }
    if (stopped) return Promise.resolve(failure('NOT_AVAILABLE'));
    const owner = ownerNow();
    if (!owner || !current(owner)) return Promise.resolve(failure('OWNER_UNVERIFIED'));
    if (!allowed(request.src)) return Promise.resolve(failure('FORBIDDEN'));
    const args = { workdir: input.workdir, relPath: input.relPath, maxBytes: input.maxBytes };
    for (const job of jobs.values()) {
      if (job.owner !== owner || job.src !== request.src || job.rpcId !== request.id) continue;
      if (job.revoked) return Promise.resolve(failure('FORBIDDEN'));
      if (Object.keys(args).some((key) => args[key] !== job.args[key])) return Promise.resolve(failure('BAD_REQUEST'));
      return job.startPromise;
    }
    if (active >= maxActive || jobs.size >= maxJobs) return Promise.resolve(failure('NOT_AVAILABLE'));
    const job = {
      id: 'exp_' + randomUUID(), owner, src: request.src, rpcId: request.id, args,
      limit: Math.min(MAX_BYTES, input.maxBytes ?? MAX_BYTES), controller: new AbortController(),
      state: 'uploading', stage: 'validation', size: 0, uploaded: 0, accepted: false, active: true, revoked: false,
    };
    job.startPromise = new Promise((resolve) => { job.resolveStart = resolve; });
    // Reserve BOTH quotas and dedup before invoking any asynchronous dependency.
    jobs.set(job.id, job);
    active++;
    job.settled = Promise.resolve().then(() => run(job));
    event(job, 'start', 'validation');
    return job.startPromise;
  }
  function status(input, request) {
    pruneUnauthorized();
    const job = text(input?.transferId, 128) ? jobs.get(input.transferId) : undefined;
    if (!job || !job.accepted || job.revoked || !text(request?.src, 256) || job.src !== request.src
      || ownerNow() !== job.owner || !current(job.owner) || !allowed(job.src)) return failure('NOT_FOUND');
    return { ok: true, state: job.state, size: job.size, uploaded: job.uploaded,
      ...(job.state === 'done' ? { key: job.key } : {}),
      ...(job.state === 'error' ? { message: MESSAGES[job.code] } : {}),
    };
  }
  function invalidateOwner() {
    invalidOwner = ownerNow();
    for (const job of jobs.values()) revoke(job, 'OWNER_UNVERIFIED');
    return Promise.all([...jobs.values()].map((job) => job.settled)).then(() => {});
  }
  function stop() {
    stopped = true;
    for (const job of jobs.values()) revoke(job, 'CANCELLED');
    return Promise.all([...jobs.values()].map((job) => job.settled)).then(() => {});
  }
  function getStats() {
    prune();
    const stats = { active, records: jobs.size, uploading: 0, done: 0, error: 0 };
    for (const job of jobs.values()) stats[job.state]++;
    return stats;
  }
  return { start, status, pruneUnauthorized, invalidateOwner, stop, getStats };
}
