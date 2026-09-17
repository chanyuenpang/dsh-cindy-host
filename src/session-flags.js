/**
 * The three session actions DSH itself has no concept of: archive, delete, pin.
 *
 * A controller's session list offers 删除 / 归档 / 置顶 / 重命名, and all four are
 * the *same* write (`local-db:sessions:patch-meta`, see
 * `Cindy/apps/desktop/src/renderer/lib/sessionService.ts` and
 * `Cindy/apps/mobile/src/session/useSessionListActions.ts`). Only 重命名 has a DSH
 * counterpart — DSH sessions are a log-backed store with no archived, hidden or
 * pinned state — so this module is the Host's own bookkeeping for the other three.
 *
 * Three consequences are deliberate and must stay visible:
 *
 * 1. **删除 hides, it does not destroy.** The session is removed from what this
 *    Host's controllers see; DSH's log and the desk's own DSH UI are untouched. A
 *    Host that deleted DSH data on a phone tap would be a far worse failure than a
 *    hidden row, and the user can always restore from the archive view.
 * 2. **The flags outlive the process.** They live in this plugin's settings section
 *    (`sessionFlags`), so an archived session does not silently reappear on the
 *    next start — a hide that forgets is worse than no hide at all.
 * 3. **An unknown session id can still be flagged.** The controller's write is
 *    authoritative about what it wants; its own cached row is what it is editing.
 */

/** The statuses the controller's filter understands. */
const STATUSES = new Set(['active', 'archived', 'deleted']);

/**
 * Normalize one stored entry, dropping anything malformed.
 *
 * Settings survive upgrades and hand edits, so a bad entry must cost one row's
 * flag rather than the whole list.
 */
function normalizeEntry(value) {
  if (value === null || typeof value !== 'object') return null;
  const entry = {};
  if (typeof value.status === 'string' && STATUSES.has(value.status) && value.status !== 'active') entry.status = value.status;
  // An empty string is not a pin. Settings round-trips can hand one back (a `null`
  // written by an older build becomes `''` in YAML), and keeping it would leave an
  // entry behind for every session the user ever unpinned.
  if (typeof value.pinnedAt === 'string' && value.pinnedAt !== '') entry.pinnedAt = value.pinnedAt;
  return Object.keys(entry).length === 0 ? null : entry;
}

/**
 * Build the flag store over a settings-backed snapshot.
 *
 * @param options - `initial` is the settings section's value; `persist` is awaited
 *   with the whole snapshot after every change (the settings service owns the write,
 *   so this module never touches storage itself).
 * @returns the flag store the channel layer and the row projection share.
 */
export function createSessionFlags({ initial, persist } = {}) {
  /** sessionId -> `{ status?: 'archived'|'deleted', pinnedAt?: string }`. */
  const entries = new Map();

  /**
   * Adopt the settings section's value as the truth.
   *
   * Called whenever settings change (including once at start). It deliberately does
   * **not** persist: the settings service is the writer here, and a replace that
   * wrote back would loop through `scope.watch`.
   */
  function replace(value) {
    entries.clear();
    if (value === null || typeof value !== 'object') return;
    for (const [sessionId, raw] of Object.entries(value)) {
      const entry = normalizeEntry(raw);
      if (entry !== null && sessionId !== '') entries.set(sessionId, entry);
    }
  }

  replace(initial);

  /** The stored flags for one session, or undefined when it carries none. */
  function flagsFor(sessionId) {
    return entries.get(String(sessionId));
  }

  /** The whole store, in the shape the settings section stores. */
  function snapshot() {
    const out = {};
    for (const [sessionId, entry] of entries) out[sessionId] = { ...entry };
    return out;
  }

  /**
   * Record one metadata write and hand back what it did.
   *
   * @param sessionId - the session the controller is editing.
   * @param patch - the controller's `{ status?, pinnedAt? }`, verbatim.
   * @returns `{ status, pinnedAt }` — the effective values the reply row must carry.
   *   `pinnedAt` is null for an unpinned session, and the caller echoes it only when
   *   the controller asked for it (an unpin is a real patch: it is what clears the
   *   pin on every other device).
   */
  async function apply(sessionId, patch) {
    const id = String(sessionId);
    const next = { ...(entries.get(id) ?? {}) };

    if (patch.status !== undefined) {
      if (typeof patch.status !== 'string' || !STATUSES.has(patch.status)) throw new Error(`unsupported session status ${String(patch.status)}`);
      // `active` is the absence of a flag, not a flag: restoring a session must
      // leave nothing behind, or the store would grow an entry per restored row.
      if (patch.status === 'active') delete next.status;
      else next.status = patch.status;
    }

    if (patch.pinnedAt !== undefined) {
      // `null` is the controller's unpin — `swipeActionPatch('archive')` sends
      // `{ status: 'archived', pinnedAt: null }`, and 取消置顶 sends the same field
      // alone. Deleting the key is the whole unpin: this store is the *only* source
      // of a pin (DSH has none), so there is no stale value to come back.
      if (patch.pinnedAt === null || patch.pinnedAt === '') delete next.pinnedAt;
      else if (typeof patch.pinnedAt === 'string') next.pinnedAt = patch.pinnedAt;
      else throw new Error('pinnedAt must be an ISO string or null');
    }

    if (Object.keys(next).length === 0) entries.delete(id);
    else entries.set(id, next);

    if (typeof persist === 'function') await persist(snapshot());

    return { status: next.status ?? 'active', pinnedAt: next.pinnedAt ?? null };
  }

  /**
   * Fold the flags onto one source row.
   *
   * The source row is deliberately **not** copied when it carries no flags: the
   * overwhelming majority of rows do not, and `toCindySessionListRow` is the single
   * place that decides the wire shape.
   */
  function project(row) {
    if (row === null || typeof row !== 'object') return row;
    const entry = entries.get(String(row.id));
    if (entry === undefined) return row;
    const next = { ...row };
    if (entry.status !== undefined) next.status = entry.status;
    if (typeof entry.pinnedAt === 'string' && entry.pinnedAt !== '') next.pinnedAt = entry.pinnedAt;
    return next;
  }

  function projectAll(rows) {
    const list = Array.isArray(rows) ? rows : [];
    return list.map((row) => project(row));
  }

  /**
   * Whether a row is hidden from this Host's controllers.
   *
   * Archived and deleted both drop out of the live surfaces (`maker:list-active`):
   * a row the phone does not show must not be able to light its running badge.
   */
  function isHidden(sessionId) {
    const entry = entries.get(String(sessionId));
    return entry?.status === 'archived' || entry?.status === 'deleted';
  }

  return { replace, apply, project, projectAll, isHidden, snapshot, flagsFor };
}
