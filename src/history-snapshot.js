import { createReasoningStream } from './reasoning-stream.js';

/** Internal source-order projection. Cut metadata/retired bodies stay local; raw rowid is an existing wire field. */
export function createHistoryProjection(sessionId) {
  const reasoning = createReasoningStream(sessionId);
  const stored = new Map();
  const retired = new Map();
  let ordinal = 0;
  let liveBase = 0;
  let scope = null;
  let live = [];
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1];

  function consume(event, rows = []) {
    const position = ordinal++;
    const before = live;
    reasoning.consume(event);
    const entries = reasoning.entries();
    const nextScope = entries[0]?.scope ?? null;
    if (entries.length && scope !== nextScope) liveBase = position;
    scope = nextScope;
    live = entries.map(({ row, index }) => ({ row, position: [liveBase, index] }));
    const current = new Set(live.map(entry => entry.row.clientId));
    for (const entry of before) {
      if (!current.has(entry.row.clientId)) retired.set(entry.row.clientId, entry.position);
    }
    rows.forEach((row, index) => stored.set(row.id, { row, position: [position, index] }));
  }

  function snapshot({ rowids = false } = {}) {
    const entries = [...stored.values(), ...live].sort((a, b) => compare(a.position, b.position));
    const rows = entries.map(entry => {
      if (!rowids) return entry.row;
      const rowid = entry.position[0] * 65536 + entry.position[1];
      if (!Number.isSafeInteger(rowid) || entry.position[1] >= 65536) throw Object.assign(new Error('Message order exceeds the safe protocol range'), { code: 'DELIVERY_EVIDENCE_CORRUPT' });
      return { ...entry.row, rowid };
    });
    const ids = new Map();
    rows.forEach((row, index) => {
      ids.set(row.id, index);
      if (row.role === 'thinking') {
        ids.set(`history-live:${row.clientId}`, index);
        // Pre-upgrade reasoning-stream IDs are the logical clientId itself.
        ids.set(row.clientId, index);
      }
    });
    const retiredCuts = new Map(retired);
    return { rows, resolve(id, { cut = false } = {}) {
      if (ids.has(id)) return ids.get(id);
      const key = typeof id === 'string' && id.startsWith('history-live:') ? id.slice(13) : id;
      const position = cut ? retiredCuts.get(key) : undefined;
      if (!position) return -1;
      const index = entries.findIndex(entry => compare(entry.position, position) >= 0);
      return index < 0 ? rows.length : index;
    } };
  }
  return { consume, snapshot, reasoning };
}
