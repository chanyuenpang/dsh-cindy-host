import { refusalError } from './cindy-channels.js';

// Cindy treats pinnedAt as membership. This fixed wire sentinel is NOT a native
// pin timestamp or native order: DSH owns only an ordered pinned ID set.
export const NATIVE_PIN_MEMBERSHIP_AT = '1970-01-01T00:00:00.000Z';

/** Adapt the same durable registry operations used by DSH's workspace controller.
 * Registry availability is resolved per call; no private file or shadow archive is written. */
export function createDshSessionArchive({ getRegistry, subscribe }) {
  function ids() {
    const value = getRegistry()?.archivedSessionIds;
    return Array.isArray(value) ? new Set(value.map(String)) : null;
  }
  function pinnedIds() {
    const value = getRegistry()?.pinnedSessionIds;
    return Array.isArray(value) ? value.map(String) : null;
  }
  function pinSnapshot() {
    const value = pinnedIds();
    return value === null ? null : new Set(value);
  }
  function isPinned(sessionId) {
    const current = pinSnapshot();
    return current === null ? null : current.has(String(sessionId));
  }
  async function setPinned(sessionId, pinned) {
    const registry = getRegistry();
    const method = pinned ? 'pinSession' : 'unpinSession';
    if (typeof registry?.[method] !== 'function' || pinnedIds() === null) {
      throw refusalError('NOT_AVAILABLE', 'This DSH profile exposes no native session pin API');
    }
    if (isPinned(sessionId) === pinned) return pinned; // A retry must not reorder native pins.
    try {
      await registry[method](sessionId);
    } catch (error) {
      if (error?.name === 'WorkspaceUnknownSessionError' || error?.code === 'session/not-found') {
        throw refusalError('NOT_FOUND', String(error.message));
      }
      if (error?.name === 'WorkspaceArchivedSessionPinError') {
        throw refusalError('BAD_REQUEST', String(error.message));
      }
      throw error;
    }
    if (isPinned(sessionId) !== pinned) throw new Error('DSH pin state did not match the completed operation');
    return pinned;
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
    let previousPins = pinnedIds();
    return subscribe('domain/changed', (change) => {
      if (change?.domain !== 'workspace' || change.table !== '' || change.operation !== 'put') return;
      const next = ids();
      const nextPins = pinnedIds();
      const changed = next === null ? [] : [...new Set([...(previous ?? []), ...next])]
        .filter(id => previous?.has(id) !== next.has(id));
      const pinsChanged = nextPins !== null && (previousPins === null ||
        nextPins.length !== previousPins.length || nextPins.some((id, i) => previousPins[i] !== id));
      const pinIds = pinsChanged ? [...new Set([...(previousPins ?? []), ...nextPins])] : [];
      previous = next;
      previousPins = nextPins;
      const affected = [...new Set([...changed, ...pinIds])];
      if (affected.length > 0) listener(affected, { pinIds });
    });
  }
  return { snapshot: ids, isArchived, setArchived, pinSnapshot, isPinned, setPinned, onChange };
}
