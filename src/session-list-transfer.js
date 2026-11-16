import { createHash } from 'node:crypto';
import { gzip as gzipImpl } from 'node:zlib';
import { promisify } from 'node:util';
const gzip = promisify(gzipImpl);
/** Stateless, per-request Cindy invoke transfer. It never caches handler results.
 * Delta is deliberately not implemented; a delta request may receive full content.
 */
export function createSessionListEncoder({ compress = gzip, maxConcurrent = 2 } = {}) {
  let active = 0;
  const stats = { plain: 0, compressed: 0, notModified: 0, capacityFallbacks: 0, failures: 0, inputBytes: 0, outputBytes: 0 };
  return {
    async encode(reply, request) {
      const raw = request?.payload?.transfer;
      if (request?.payload?.channel !== 'local-db:sessions:list' || reply?.payload?.ok !== true
        || !raw || typeof raw !== 'object' || Array.isArray(raw) || reply.payload.transfer) return reply;
      const options = { gzip: raw.gzip === 1,
        tag: typeof raw.ifNoneMatch === 'string' && raw.ifNoneMatch.length > 0 && raw.ifNoneMatch.length <= 128 ? raw.ifNoneMatch : null,
        delta: raw.delta === 1 };
      if (!options.gzip && !options.tag && !options.delta) return reply;
      let text;
      try { text = JSON.stringify(reply.payload.result); } catch { return reply; }
      if (typeof text !== 'string' || text.length > 4 * 1024 * 1024) return reply;
      const bytes = Buffer.byteLength(text);
      stats.inputBytes += bytes;
      const tag = text.length >= 4096 ? createHash('sha256').update(text).digest('hex') : null;
      if (tag && tag === options.tag) {
        stats.notModified++;
        return { ...reply, payload: { ok: true, result: null, transfer: { tag, notModified: true } } };
      }
      const plain = tag ? { ...reply, payload: { ...reply.payload, transfer: { tag } } } : reply;
      if (!options.gzip || bytes < 1024) { stats.plain++; return plain; }
      if (active >= maxConcurrent) { stats.capacityFallbacks++; stats.plain++; return plain; }
      active++;
      try {
        const packed = Buffer.from(await compress(Buffer.from(text))).toString('base64');
        if (packed.length + 48 < bytes * 0.9) {
          stats.compressed++; stats.outputBytes += packed.length;
          return { ...reply, payload: { ok: true, result: null, transfer: { ...(tag ? { tag } : {}), gzipBase64: packed } } };
        }
      } catch { stats.failures++; }
      finally { active--; }
      stats.plain++; stats.outputBytes += bytes;
      return plain;
    },
    diagnostics() { return { ...stats, active }; },
  };
}
