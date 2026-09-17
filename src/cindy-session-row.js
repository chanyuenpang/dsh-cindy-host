/**
 * Fold a DSH session row into the wire shape the Cindy controller stores.
 *
 * THE CONTRACT IS FLAT. `local-db:sessions:list` returns `RemoteSession[]` —
 * one flat session object per row, identity and status at the top level — and
 * `local-db:sessions:get` returns exactly one such object. The controller does
 * NOT unwrap anything: it hands the invoke result straight to
 * `remoteSessionStore.setDeviceSessions`, which de-dupes on `session.id`.
 *
 * `RemoteSessionListItem` (the `{ session: {...}, subtitle, detail, … }` view
 * model) is built *inside* the controller's own renderers
 * (`maker-shared/sessionList.ts`, `mobileHome.ts`) and must never cross the wire.
 * An earlier revision of this file emitted that view model, citing a
 * `mobileMakerTransport.listSessions()` that does not exist in the Cindy tree;
 * the result was a silently empty list — `id`, `status` and `deviceLinkDeviceId`
 * all arrived as `undefined`, so the controller's status filter, device filter,
 * and de-dupe key each discarded every row without raising anything.
 *
 * Only the wire shape belongs here. Anything the controller derives for display
 * (subtitle, detail, live activity, pending counts, schedule info) is its own
 * business and is deliberately absent.
 */

/**
 * The harness this Host reports for every session.
 *
 * DSH's internal agent identity is erased at this boundary. The wire value is
 * `pi`, Cindy's native agent: the controller's `MobileAgentKind` is a closed
 * union (`'claude-code' | 'codex' | 'pi'`), and a kind outside it has no label,
 * no capabilities entry, and no picker entry on the phone. The roster in
 * `cindy-channels.js` names the same single kind.
 */
const DSH_AGENT_KIND = 'pi';
const DSH_MODEL = 'pi';
const DSH_EFFORT = 'default';
const DSH_PERMISSION_MODE = 'default';
const UNTITLED = 'Untitled DSH task';
const MAX_TITLE = 160;

/** Trim a title the way the local read model does, so both surfaces agree. */
function titleOf(value) {
  const title = typeof value === 'string' ? value.trim() : '';
  return title.slice(0, MAX_TITLE) || UNTITLED;
}

/**
 * Build one wire session row.
 * @param item - a source row: `{ id, title, running, updatedAt, createdAt, cwd, blank }`.
 * @param options - injectable clock and this Host's relay identity.
 * @returns the flat `RemoteSession` the controller stores.
 */
export function toCindySessionListRow(item, { now = () => new Date(), device, defaultModel } = {}) {
  const id = String(item.id);
  const updatedAt = item.updatedAt ?? now().toISOString();
  const createdAt = item.createdAt ?? updatedAt;
  const title = titleOf(item.title);
  const workingDir = typeof item.cwd === 'string' && item.cwd !== '' ? item.cwd : null;

  return {
    id,
    title,
    createdAt,
    updatedAt,
    // `'active' | 'archived' | 'deleted'`; the controller's default status filter
    // is `'active'`, so this field decides whether a row is visible at all.
    //
    // DSH has no archived or deleted state, so the value can only come from this
    // Host's own flags (`session-flags.js`), folded onto the source row before it
    // reaches here. A row that carries none is active, which is what every row was
    // before the flags existed.
    status: item.status === 'archived' || item.status === 'deleted' ? item.status : 'active',
    agentKind: DSH_AGENT_KIND,
    // The controller looks the current model up by id in the catalog it fetched
    // (`availableModels.find(item => item.id === session.model)`), so a
    // placeholder here leaves the picker with nothing selected even when the
    // catalog is right. The session's own selection wins; the Host default is
    // the honest fallback while it is unknown.
    model: typeof item.model === 'string' && item.model !== ''
      ? item.model
      : (typeof defaultModel === 'string' && defaultModel !== '' ? defaultModel : DSH_MODEL),
    // The source that serves that model, when the session recorded one. The
    // controller keeps `providerId` beside the model and derives its new-chat draft
    // runtime from the most recent session (`pickRecentSessionRuntime`), so a row that
    // drops it hands the next conversation a model with no source. Absent — not null —
    // when nothing recorded one: the controller reads a missing field as "the Host's
    // default route", which is exactly what such a session runs.
    ...(typeof item.providerId === 'string' && item.providerId !== '' ? { providerId: item.providerId } : {}),
    // The session's own effort, which DSH carries as part of its model
    // selection. The placeholder is only for a session that has not chosen yet:
    // answering "default" after a successful `maker:set-effort` would make the
    // write look like it never landed.
    effort: typeof item.effort === 'string' && item.effort !== '' ? item.effort : DSH_EFFORT,
    // The session's own preset when the list carried the `permissions`
    // projection, so the composer shows the mode actually in force rather than a
    // placeholder that no picker entry matches.
    permissionMode: typeof item.permissionMode === 'string' && item.permissionMode !== ''
      ? item.permissionMode
      : DSH_PERMISSION_MODE,
    fastMode: false,
    workingDir,
    // The controller groups by this: `workspaceKind === 'dialogue' || !workingDir`
    // puts a row in the "chats" bucket, everything else under its project.
    workspaceKind: workingDir === null ? 'dialogue' : 'project',
    // A blank session has no user turn yet; the controller shows it as a draft.
    preview: null,
    _count: null,
    // Not part of the stored row's contract, but harmless and honest: the
    // controller reads running state from `maker:list-active`, not from here.
    running: item.running === true,
    // Which device this row came from. The controller's home aggregates sessions
    // from every linked computer and filters with
    // `canonicalDeviceId ?? deviceLinkDeviceId === selectedDeviceId`
    // (`maker-shared/mobileHome.ts`), so a row that names neither is dropped the
    // moment the user selects this Host — which is the only way to see it.
    deviceLinkDeviceId: device?.deviceId ?? null,
    deviceLinkDeviceName: device?.deviceName ?? null,
    // Present only when a controller pinned this session here (the flag store's
    // doing, not DSH's). The controller reads a missing field as "not pinned" — and
    // on a write reply it reads a missing field as "keep what I have", which is
    // exactly how an unpin stays applied without this row asserting `null`.
    ...(typeof item.pinnedAt === 'string' && item.pinnedAt !== '' ? { pinnedAt: item.pinnedAt } : {}),
  };
}

/**
 * Fold a whole listing.
 * @param items - source rows.
 * @param options - injectable clock and this Host's relay identity.
 * @returns the flat array the controller stores.
 */
export function toCindySessionList(items, options = {}) {
  const list = Array.isArray(items) ? items : [];
  return list.map((item) => toCindySessionListRow(item, options));
}

/**
 * Build the `maker:list-active` answer.
 *
 * This channel has its own shape — `[{ sessionId, isTurnRunning }]` — and is
 * neither a session row nor a list item. Answering it with session rows makes
 * the controller skip every entry, which shows up only as a running badge that
 * never lights up.
 * @param items - source rows.
 * @returns one entry per session that is currently in a turn.
 */
export function toCindyActiveSessions(items) {
  const list = Array.isArray(items) ? items : [];
  return list
    .filter((item) => item?.running === true)
    .map((item) => ({ sessionId: String(item.id), isTurnRunning: true }));
}
