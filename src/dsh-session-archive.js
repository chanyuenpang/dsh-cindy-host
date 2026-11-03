import { refusalError } from './cindy-channels.js';

/** Adapt the same durable registry operations used by DSH's workspace controller.
 * Registry availability is resolved per call; no private file or shadow archive is written. */
export function createDshSessionArchive({ getRegistry, subscribe }) {
  function ids() {
    const value = getRegistry()?.archivedSessionIds;
    return Array.isArray(value) ? new Set(value.map(String)) : null;
  }
  function isArchived(sessionId) {
    const current = ids();
    return current === null ? null : current.has(String(sessionId));
  }
  async function setArchived(sessionId, archived) {
    const registry = getRegistry();
    const method = archived ? 'archiveSession' : 'unarchiveSession';
    if (typeof registry?.[method] !== 'function' || ids() === null) {
      throw refusalError('NOT_AVAILABLE', 'This DSH profile exposes no native session archive API');
    }
    try {
      // No stopActivity: the existing client gesture does not authorize stopping work.
      await registry[method](sessionId);
    } catch (error) {
      if (error?.name === 'WorkspaceUnknownSessionError' || error?.code === 'session/not-found') {
        throw refusalError('NOT_FOUND', String(error.message));
      }
      if (error?.name === 'WorkspaceActiveSessionError' || error?.code === 'workspace/session-active') {
        throw refusalError('NOT_AVAILABLE', String(error.message));
      }
      throw error; // Persistence/transport failures must never become local-only success.
    }
    if (isArchived(sessionId) !== archived) throw new Error('DSH archive state did not match the completed operation');
    return archived;
  }
  function onChange(listener) {
    if (typeof subscribe !== 'function') return () => {};
    let previous = ids();
    return subscribe('domain/changed', (change) => {
      if (change?.domain !== 'workspace' || change.table !== '' || change.operation !== 'put') return;
      const next = ids();
      if (next === null) return;
      const changed = [...new Set([...(previous ?? []), ...next])]
        .filter(id => previous?.has(id) !== next.has(id));
      previous = next;
      if (changed.length > 0) listener(changed);
    });
  }
  return { snapshot: ids, isArchived, setArchived, onChange };
}
