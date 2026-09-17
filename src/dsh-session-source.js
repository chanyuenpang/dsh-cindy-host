/**
 * The DSH data source for the Cindy Host.
 *
 * The original bundle read DSH through `ctx.apiProxy` (`InProcessApiClient`).
 * Current DSH Web does not mount `apiProxy`, so that source was permanently
 * `undefined` and the projection never started — the phone saw an empty session
 * list. This module reads the same facts from the services the Web profile
 * actually mounts:
 *
 *  - `ctx.sessionController.list()`  → the session list (`SessionSummary`), the
 *    host-side counterpart of the old `client.sessions.list()`;
 *  - cordis `api-session/added|removed|status|activity|error` events → the host
 *    lifecycle stream, the counterpart of the old `events.host()` frames.
 *
 * Both are ordinary host services and events, so nothing here needs Typert
 * codegen or a client carrier.
 *
 * The projection layer above is unchanged: it needs `listSessions()` and
 * `onEvent(listener)`, and that is exactly what this source offers.
 */

/** Activity kinds the projection's allowlist accepts (see `contracts.js`). */
function activity(kind, sessionId, phase, extra = {}) {
  return { kind, sessionId: String(sessionId), sequence: 0, phase, ...extra };
}

/**
 * Whether a session belongs in a controller's session list.
 *
 * **A subagent run is not a task.** DSH marks its delegated sessions in the summary
 * (`origin: 'subagent'`, and a `parentSessionId` when the delegation has a parent), and
 * its own Web list shows only user-facing sessions — which is why a deployment's
 * `~/.dsh/sessions` can hold two hundred subagent logs the user has never seen. This Host
 * listed every one of them as "Untitled DSH task": measured on a real profile, 219 rows of
 * which the visible handful were the actual tasks, and the whole list had to be folded
 * (titles included) on every poll. Filtering here is therefore both the honest row set and
 * most of the latency.
 * @param item - one `SessionSummary` from the session service.
 * @returns true when a controller should see it.
 */
function isControllerVisible(item) {
  if (item === null || typeof item !== 'object') return false;
  if (item.origin === 'subagent') return false;
  return item.parentSessionId === undefined || item.parentSessionId === null;
}

/**
 * @param options - the host session services and the event subscriber to use.
 * @returns a projection source backed by the live Web profile.
 */
export function createSessionControllerSource({
  sessionController,
  subscribe,
  readTitles,
  readSessionMeta,
  listTimeoutMs = 15_000,
  // How old a listing may be when it is served in place of one that failed. Long enough to
  // cover a cold start, short enough that a session created or renamed in the meantime is not
  // hidden for long — and the controller polls this channel every few seconds anyway.
  listStaleMaxMs = 120_000,
  // How many uncached titles one read may fold. The phone's responsiveness probe *is*
  // `local-db:sessions:list`, and a title is a log-backed fold (~50ms each) — folding a
  // few hundred of them per read made the probe answer in ~12s on a real profile, which
  // the handset reads as "the computer is not responding". Bounded, the same read costs
  // one batch and the rest of the titles arrive over the next few polls.
  titleRefreshBudget = 16,
  // A cached title is re-read at most this often, so a title changed by DSH's own
  // regeneration heals without this module needing to hear about it.
  titleTtlMs = 60_000,
  now = () => Date.now(),
}) {
  if (sessionController === undefined) throw new Error('createSessionControllerSource requires sessionController');

  // `SessionSummary` carries no `createdAt`, but the phone's session row requires
  // one. The header read that supplies it is paid once per session id: creation
  // time and working directory are immutable, so a cache can never go stale.
  const createdAtCache = new Map();
  /** sessionId → `{ title: string|null, readAt: number }`; null means "no title yet". */
  const titleCache = new Map();
  /** The in-flight background title warm-up, or null. At most one runs at a time. */
  let warming = null;
  /** The one listing read currently in flight, shared by every concurrent caller. */
  let inFlightList = null;
  /** The last listing that was really read, and when — the stale fallback's whole state. */
  let lastListed = null;
  /** How many listings were answered from that fallback since start. */
  let staleServes = 0;
  let lastStaleReason = null;

  /**
   * Titles for the ids asked about, folding only what is missing or stale.
   *
   * `ids` arrives in the order the session service reports (newest first in practice),
   * so the rows the controller is about to show are the ones that get their title first;
   * a row left out shows as untitled until a later read reaches it.
   */
  async function titlesFor(sessionIds) {
    const out = new Map();
    if (typeof readTitles !== 'function') return out;
    const at = now();
    const stale = [];
    for (const id of sessionIds) {
      const cached = titleCache.get(id);
      if (cached !== undefined && at - cached.readAt < titleTtlMs) {
        if (cached.title !== null) out.set(id, cached.title);
        continue;
      }
      stale.push(id);
    }
    const batch = stale.slice(0, titleRefreshBudget);
    if (batch.length === 0) return out;
    await foldTitles(batch, out);
    // The rest of the titles are warmed **after** the answer is on its way: the
    // controller gets its list in one batch's time, and by its next poll the rest are
    // cached, so a few hundred sessions never sit in front of a handset's timeout.
    // `warmTitles` owns its own rejection path (`…catch(…).finally(…)`) and returns
    // nothing, so this call is already incapable of becoming an unhandled rejection —
    // which matters, because DSH's boot treats one of those as fatal to the whole process.
    if (stale.length > batch.length) void warmTitles(stale.slice(titleRefreshBudget));
    return out;
  }

  /** Fold one batch of titles into the cache (and into `out`, when the caller wants them). */
  async function foldTitles(batch, out) {
    let fetched;
    try {
      fetched = await readTitles(batch);
    } catch {
      // A missing title costs a nicer row label, never the session list. Cached as
      // "no title" so a permanently unreadable log is not re-folded forever.
      for (const id of batch) titleCache.set(id, { title: null, readAt: now() });
      return;
    }
    for (const id of batch) {
      const title = typeof fetched?.get === 'function' ? fetched.get(id) ?? null : null;
      titleCache.set(id, { title, readAt: now() });
      if (title !== null && out !== undefined) out.set(id, title);
    }
  }

  /**
   * Continue filling the title cache in the background.
   *
   * One warm-up at a time: the controller polls the list every few seconds, and a
   * pile-up of warm-ups would put the same log folds back in competition with the reads
   * they are meant to keep cheap.
   */
  function warmTitles(ids) {
    if (warming !== null || ids.length === 0) return;
    warming = (async () => {
      for (let index = 0; index < ids.length; index += titleRefreshBudget) {
        const batch = ids.slice(index, index + titleRefreshBudget);
        const fresh = batch.filter((id) => {
          const cached = titleCache.get(id);
          return cached === undefined || now() - cached.readAt >= titleTtlMs;
        });
        if (fresh.length > 0) await foldTitles(fresh);
      }
    })().catch(() => {
      // A warm-up that fails is a missing label, never a broken list.
    }).finally(() => {
      warming = null;
    });
  }

  /** Fill `createdAtCache` for ids the header reader knows. */
  async function metaFor(sessionIds) {
    const missing = sessionIds.filter((id) => !createdAtCache.has(id));
    if (typeof readSessionMeta !== 'function' || missing.length === 0) return;
    try {
      const meta = await readSessionMeta(missing);
      for (const [id, value] of meta ?? []) createdAtCache.set(id, value);
    } catch {
      // Fall through: an unknown creation time degrades the row, not the list.
    }
  }

  /**
   * One session listing, as the service reports it, minus the sessions a controller
   * must not see (subagent runs).
   *
   * Filtered **here**, at the single point both readers go through, so a future reader
   * cannot accidentally serve them again.
   *
   * Two properties beyond the read itself, both learned from a live failure: seven
   * `local-db:sessions:list` invokes rejected with `TimeoutError` in the thirteen seconds after
   * a restart (the phone reconnecting, plus the two desktop controllers polling, while 45 cold
   * sessions were being read), and a controller renders a failed list as *nothing* — the
   * spinner the user reported.
   *
   * - **Single flight.** Concurrent callers share one read. Three controllers polling during a
   *   cold start do not multiply the work that is already missing its deadline.
   * - **A stale answer beats a failed one.** When the read does miss its deadline, the list read
   *   moments ago is served instead of an error, inside a bound. The data is real and durable —
   *   only its age is in question, and the controller's next poll corrects it — while the
   *   failure mode it replaces is an empty list and a spinner.
   * - **With no previous listing, the read gets one retry.** That is the cold start: a Host that
   *   has just restarted has served nothing yet, so the stale fallback above has nothing to give,
   *   and the first read is the one that pays for caches the second read then finds warm. Measured:
   *   `invoke:local-db:sessions:get` and `invoke:local-db:sessions:list` both recorded
   *   `TimeoutError`s in the boot window, and a failed list read is what the controller renders as
   *   an empty session list. The retry is inside the shared flight, so concurrent callers cost one
   *   retry between them, and it only happens when there is no fallback to serve instead.
   */
  async function listItems() {
    if (inFlightList !== null) return inFlightList;
    const attempt = (async () => {
      let lastError = null;
      const tries = lastListed === null ? 2 : 1;
      for (let index = 0; index < tries; index += 1) {
        try {
          const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(listTimeoutMs) : undefined;
          const value = await sessionController.list({}, signal);
          const items = (Array.isArray(value?.items) ? value.items : []).filter(isControllerVisible);
          lastListed = { items, at: now() };
          return items;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    })();
    inFlightList = attempt;
    try {
      return await attempt;
    } catch (error) {
      if (lastListed !== null && now() - lastListed.at <= listStaleMaxMs) {
        staleServes += 1;
        lastStaleReason = error instanceof Error ? error.message : String(error);
        return lastListed.items;
      }
      throw error;
    } finally {
      inFlightList = null;
    }
  }

  return {
    /**
     * Read the current session list.
     * @returns rows shaped for `contracts.toConversationRow` and the phone's row.
     */
    async listSessions() {
      const items = await listItems();
      const ids = items.map((item) => String(item.sessionId));
      const [titles] = await Promise.all([titlesFor(ids), metaFor(ids)]);
      return items.map((item) => {
        const id = String(item.sessionId);
        const updatedAt = Number.isFinite(item.updatedAt) ? new Date(item.updatedAt).toISOString() : new Date().toISOString();
        const meta = createdAtCache.get(id);
        // The session's own model, when the list already carries the
        // `modelSelection` projection. It is free here — the value rides the
        // list response — and it is what lets the controller's picker show the
        // model the session is actually on rather than the Host default.
        const selection = item.projections?.values?.modelSelection;
        const selectedModel = selection?.next?.model ?? selection?.lastUsed?.model;
        // Effort rides the same selection, so it is free here too. The composer
        // shows it in its model control, and a Host that always answers "default"
        // makes a real `maker:set-effort` look like it did nothing.
        const selectedEffort = selection?.next?.reasoningEffort ?? selection?.lastUsed?.reasoningEffort;
        // The provider that serves that selection, from the same projection. The
        // controller stores the source beside the model (`RemoteSession.providerId`)
        // and its new-chat draft follows the most recent session's runtime, so a row
        // that omits it loses the source the user picked while the model still looks
        // right — and the next conversation is created without one.
        const selectedProvider = selection?.next?.provider ?? selection?.lastUsed?.provider;
        // The current permission preset, when the list already carries the
        // `permissions` projection. Its absence means no permission service is
        // composed, which DSH documents as "clients hide the control".
        const permission = item.projections?.values?.permissions;
        const currentPermission = typeof permission?.currentValue === 'string' && permission.currentValue !== ''
          ? permission.currentValue
          : undefined;
        return {
          id,
          title: titles.get(id),
          running: item.running === true,
          updatedAt,
          // Falls back to the last activity time only when the header read is
          // unavailable; the phone requires a string here.
          createdAt: meta?.createdAt ?? updatedAt,
          cwd: typeof item.cwd === 'string' && item.cwd !== '' ? item.cwd : (meta?.cwd ?? null),
          ...(typeof selectedModel === 'string' && selectedModel !== '' ? { model: selectedModel } : {}),
          ...(typeof selectedProvider === 'string' && selectedProvider !== '' ? { providerId: selectedProvider } : {}),
          ...(typeof selectedEffort === 'string' && selectedEffort !== '' ? { effort: selectedEffort } : {}),
          ...(currentPermission === undefined ? {} : { permissionMode: currentPermission }),
          blank: item.blank === true,
        };
      });
    },

    /**
     * Turn states only: no titles, no header reads.
     *
     * `maker:list-active` and `maker:session-in-turn` ask "is a turn running", and the
     * controller polls them. Answering from the full row fold made the most frequently
     * called channel on this Host pay the most expensive read on this Host — measured at
     * 8.4s on a profile with 219 sessions, against a handset that times out in 15s.
     * @returns `{ id, running, updatedAt }` per session.
     */
    async listSessionStates() {
      const items = await listItems();
      return items.map((item) => ({
        id: String(item.sessionId),
        running: item.running === true,
        updatedAt: Number.isFinite(item.updatedAt) ? new Date(item.updatedAt).toISOString() : null,
      }));
    },

    /**
     * Forget one session's cached title.
     *
     * A rename is the one title change this Host causes itself, and it must not wait out
     * the TTL: the controller reads the row it just wrote back.
     */
    invalidateTitle(sessionId) {
      titleCache.delete(String(sessionId));
    },

    /**
     * Wait for the background title warm-up to finish.
     *
     * The list itself never waits for this — that is the point of the bound — so this
     * exists for callers that want the fully populated cache (tests, and a diagnostic
     * that wants to know how many titles are cached at all).
     */
    async titlesSettled() {
      while (warming !== null) await warming;
    },

    /** How many titles are cached, for diagnostics. */
    cachedTitleCount() {
      return titleCache.size;
    },

    /**
     * How the session listing is doing, for diagnostics.
     *
     * `staleServes` should stay at 0 in ordinary use. It counts listings answered from the
     * previous read because the live one missed its deadline — every one of those is a
     * controller that would otherwise have been shown an empty list (the reported spinner),
     * so a non-zero value is the record of a degradation that was absorbed, not a healthy
     * number to watch grow.
     */
    listDiagnostics() {
      return { staleServes, lastStaleReason, lastListedAt: lastListed === null ? null : lastListed.at, lastListedCount: lastListed === null ? null : lastListed.items.length };
    },

    /**
     * Follow the host's session lifecycle.
     * @param listener - receives activity items; a non-abort throw becomes a stream failure.
     * @returns the disposer removing every subscription.
     */
    onEvent(listener) {
      if (typeof subscribe !== 'function') return () => {};
      /** A listener failure must surface as a rebaseline, not as a broken subscription. */
      const emit = (item) => {
        try {
          listener(item);
        } catch {
          listener({ kind: 'stream-failed' });
        }
      };
      const disposers = [
        subscribe('api-session/added', (summary) => {
          // A subagent appears as a session to the session service, but never in a
          // controller's list — so telling the controller "a session was created" would
          // add a row it can never open, and its next list read would take it away again.
          if (!isControllerVisible(summary)) return;
          emit(activity('session-added', summary?.sessionId, summary?.running === true ? 'running' : 'idle'));
        }),
        subscribe('api-session/removed', (sessionId) => {
          emit(activity('session-removed', sessionId, 'idle'));
        }),
        subscribe('api-session/status', (sessionId, running) => {
          emit(activity('session-status', sessionId, running === true ? 'running' : 'idle'));
        }),
        subscribe('api-session/activity', (sessionId) => {
          emit(activity('session-status', sessionId, 'active'));
        }),
        subscribe('api-session/error', (sessionId) => {
          emit(activity('session-status', sessionId, 'error'));
        }),
      ];
      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            // A disposer that throws must not strand the remaining ones.
          }
        }
      };
    },
  };
}
