import { win32, posix } from 'node:path';
import { searchWorkingDir } from './dsh-keyword-search.js';
import { refusalError } from './cindy-channels.js';
const fail = (code, text) => refusalError(code, text);
const unavailable = () => ({ authoritative: false, available: false, manualProjectOrder: [], projectOrder: 'activity' });
const sameOwner = (a, b) => !!a && !!b && a.dataOwnerId === b.dataOwnerId && a.ownerGeneration === b.ownerGeneration;
export function projectOrderKey(path) {
  if (typeof path !== 'string' || !path.trim() || (!win32.isAbsolute(path) && !posix.isAbsolute(path))) throw fail('NOT_AVAILABLE', 'Only registered local absolute Workspace paths are supported');
  // Do not guess an extended-path alias unsupported by the phone grouping contract.
  if (path.startsWith(String.fromCharCode(92, 92, 63, 92))) throw fail('NOT_AVAILABLE', 'Extended Workspace paths require an unambiguous existing phone key');
  const grouped = searchWorkingDir(path);
  const windows = /^[A-Za-z]:/.test(path) || path.startsWith(String.fromCharCode(92)) || path.startsWith('//');
  return 'local:' + (windows ? grouped.toLowerCase() : grouped);
}
/** Registry order is the only durable state. The queue is not a replace/CAS transaction. */
export function createDshProjectOrder({ getRegistry, getController, getOwner, subscribeChanged, maxWorkspaces = 500 }) {
  let disposed = false; let epoch = 0; let queued = 0; let tail = Promise.resolve(); const observers = new Set();
  function capture() {
    const registry = getRegistry(); const controller = getController(); const owner = getOwner?.();
    if (disposed || typeof registry?.list !== 'function' || typeof controller?.insertBefore !== 'function' || typeof owner?.dataOwnerId !== 'string' || !owner.dataOwnerId || !Number.isSafeInteger(owner.ownerGeneration) || owner.ownerGeneration < 0) return undefined;
    const stamp = { dataOwnerId: owner.dataOwnerId, ownerGeneration: owner.ownerGeneration }; const generation = epoch;
    const check = () => { if (disposed || generation !== epoch || registry !== getRegistry() || controller !== getController() || !sameOwner(stamp, getOwner?.())) throw fail('NOT_AVAILABLE', 'PRECONDITION_FAILED: account/device/source ownership changed'); };
    return { registry, controller, stamp, check };
  }
  function inspect(context) {
    context.check(); const rows = context.registry.list();
    if (!Array.isArray(rows) || rows.length > maxWorkspaces) throw fail('NOT_AVAILABLE', 'Native Workspace registry is invalid or over budget');
    const keys = new Map(); const ids = new Set();
    for (const row of rows) {
      if (typeof row?.id !== 'string' || !row.id || ids.has(row.id)) throw fail('NOT_AVAILABLE', 'Invalid native Workspace identity');
      ids.add(row.id); const key = projectOrderKey(row.path);
      if (keys.has(key)) throw fail('NOT_AVAILABLE', 'Ambiguous phone project grouping maps multiple registered Workspaces to ' + key);
      keys.set(key, row.id);
    }
    const snapshot = { authoritative: true, available: true, manualProjectOrder: [...keys.keys()], projectOrder: 'custom', ownerStamp: context.stamp };
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 256 * 1024) throw fail('NOT_AVAILABLE', 'Native project-order snapshot exceeds the response byte budget');
    return { rows, keys, signature: JSON.stringify(rows.map(row => [row.id, row.path])), ids: rows.map(row => row.id), snapshot };
  }
  function read() { const context = capture(); return context ? inspect(context).snapshot : unavailable(); }
  async function apply(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['manualProjectOrder', 'projectOrder', 'dataOwnerId', 'ownerGeneration'].includes(key))) throw fail('BAD_REQUEST', 'Invalid project-order request fields');
    if (value.projectOrder !== 'custom') throw fail('NOT_AVAILABLE', 'UNSUPPORTED_CAPABILITY: native registry order has no activity mode');
    if (!Array.isArray(value.manualProjectOrder) || value.manualProjectOrder.length > maxWorkspaces || value.manualProjectOrder.some(key => typeof key !== 'string' || !key.startsWith('local:'))) throw fail('BAD_REQUEST', 'Only explicit local project keys are accepted; no device/dialogue/mixed ledger');
    const context = capture(); if (!context || !sameOwner(context.stamp, value)) throw fail('NOT_AVAILABLE', 'PRECONDITION_FAILED: a current verified owner stamp is required');
    const keys = value.manualProjectOrder.map(key => projectOrderKey(key.slice(6))); if (new Set(keys).size !== keys.length) throw fail('BAD_REQUEST', 'Duplicate normalized project keys');
    if (queued >= 32) throw fail('NOT_AVAILABLE', 'Project-order write queue is busy'); queued++;
    const work = async () => {
      context.check(); let current = inspect(context); const requested = keys.map(key => { const id = current.keys.get(key); if (!id) throw fail('NOT_AVAILABLE', 'Unknown/unregistered project key: ' + key); return id; });
      const desired = [...requested, ...current.ids.filter(id => !requested.includes(id))]; let attempted = false;
      try {
        for (let i = 0; i < desired.length; i++) {
          context.check(); const actual = inspect(context);
          if (actual.signature !== current.signature) throw fail('NOT_AVAILABLE', 'CONFLICT: desktop Workspace set/order changed');
          if (current.ids[i] === desired[i]) continue;
          const predicted = current.ids.filter(id => id !== desired[i]); predicted.splice(i, 0, desired[i]);
          attempted = true; const result = await context.controller.insertBefore({ workspaceId: desired[i], beforeWorkspaceId: current.ids[i] }); context.check();
          const next = inspect(context);
          if (JSON.stringify(result?.workspaceIds) !== JSON.stringify(predicted) || JSON.stringify(next.ids) !== JSON.stringify(predicted)) throw fail('NOT_AVAILABLE', 'CONFLICT: native move returned a concurrent/unexpected order');
          current = next;
        }
        return inspect(context).snapshot;
      } catch (error) {
        let actual; try { context.check(); actual = inspect(context).snapshot; } catch { /* never expose another owner snapshot */ }
        throw fail('NOT_AVAILABLE', (attempted ? 'PARTIAL_FAILURE' : 'CONFLICT') + ': ' + String(error?.message ?? error) + (actual ? '; actual=' + JSON.stringify(actual) : '; owner changed; refresh under the current owner; no rollback is implied'));
      }
    };
    const result = tail.then(work); tail = result.then(() => {}, () => {});
    try { return await result; } finally { queued--; }
  }
  function onChange(listener) {
    if (disposed || typeof subscribeChanged !== 'function') return () => {};
    let closed = false; let previous; try { previous = JSON.stringify(read()); } catch { previous = undefined; }
    const stop = subscribeChanged(() => {
      if (closed || disposed) return;
      try { const snapshot = read(); const next = JSON.stringify(snapshot); if (snapshot.available && next !== previous) { previous = next; listener(snapshot); } } catch { /* readers get the real error; do not announce fabricated order */ }
    });
    const close = () => { if (!closed) { closed = true; observers.delete(close); if (typeof stop === 'function') stop(); } }; observers.add(close); return close;
  }
  function cancelAll() { epoch++; }
  function dispose() { disposed = true; cancelAll(); for (const close of [...observers]) close(); }
  return { read, apply, onChange, cancelAll, dispose };
}
