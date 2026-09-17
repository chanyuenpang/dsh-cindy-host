import Schema from '@deepseek-ai/schemastery';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import { InProcessApiClient, toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy';
import { DEFAULT_HOST_SETTINGS, SETTINGS_NAMESPACE, validateHostSettings } from './host-settings.js';
import { DshHostSource } from './dsh-host-source.js';
import { createSessionControllerSource } from './dsh-session-source.js';
import { createMessageCounter, createMessageReader, foldSessionEvent, promptRpcIdOf } from './dsh-message-fold.js';
import { createHistoryViewController } from './host-history-view.js';
import { createFileReader } from './host-files.js';
import { createFileBrowser } from './host-file-browser.js';
import { createAttachmentMaterializer } from './host-attachments.js';
import { createGoalWriter } from './host-goals.js';
import { startHost } from './host.js';
import { refusalError } from './cindy-channels.js';
import { API_PREFIX, createHostRoutes } from './host-routes.js';

export const name = 'dsh-cindy-host';
export const inject = ['settings'];
const ControllerSchema = Schema.object({ state: Schema.union(['authorized', 'revoked']), displayName: Schema.string(), grantedAt: Schema.string(), revokedAt: Schema.string(), grantRevision: Schema.natural() });
// The archive/delete/pin flags a controller writes: this Host's own answer to three
// actions DSH has no concept of. `pinnedAt: ''` is a remembered unpin (settings
// reject `null`, and an absent field cannot be told apart from "never pinned").
const SessionFlagSchema = Schema.object({ status: Schema.union(['active', 'archived', 'deleted']), pinnedAt: Schema.string() });
const HostSchema = Schema.object({ transportEnabled: Schema.boolean(), remoteControlEnabled: Schema.boolean(), controllers: Schema.dict(ControllerSchema), deviceId: Schema.string(), sessionFlags: Schema.dict(SessionFlagSchema) });

/**
 * Services that can supply the DSH session read source, in preference order.
 * `sessionController` is what current DSH Web mounts; `apiProxy` was removed
 * from it, so that branch is last and optional.
 */
const SOURCE_SERVICES = ['sessionController', 'apiProxy'];

/**
 * The plan-mode module an agent preset mounts.
 *
 * This deployment does **not** compose plan mode on the host plane: the Web
 * bundle disables the base `plan-mode` row and each preset that wants it mounts
 * this module inside its own agent context. So the presence of the service is a
 * per-preset fact, and the only honest places to read it are the agent's own
 * context and the preset composition.
 */
const PLAN_MODE_MODULE = '@deepseek-ai/dsh-plan-mode';

/** How long a preset-composition read is reused, in milliseconds. */
const PRESET_INVENTORY_TTL_MS = 30_000;

/**
 * Build the DSH read source once its supplying service exists.
 *
 * Both candidates are provided by *other* plugins, so `apply` cannot read them
 * synchronously: doing that is what left the original bundle with a permanently
 * undefined source and an empty session list. `ctx.inject` waits for the service
 * and re-runs on removal, which is the only correct way to consume it.
 * @param ctx - the plugin context that owns the service.
 * @param serviceName - which candidate became available.
 * @returns the source and the label naming its seam.
 */
export function buildDshSource(ctx, serviceName) {
  if (serviceName === 'sessionController') {
    const sessionController = ctx.get('sessionController');
    const sessionQuery = ctx.get('sessionQuery');
    /**
     * The Workspace that owns a new session's directory, or undefined.
     *
     * Read per call and never captured: the registry is another plugin's service and may
     * activate after this seam is built (the same reason every other seam here resolves
     * late). `create` is DSH's own "create or reuse" for a directory, so a known folder
     * reuses its record and a genuinely new one is registered — which is what makes the
     * session appear where the desk expects it.
     */
    async function workspaceForNewSession(cwd) {
      if (cwd === undefined) return undefined;
      const registry = ctx.get('workspaceRegistry');
      if (registry === undefined || registry === null || typeof registry.create !== 'function') return undefined;
      try {
        const workspace = await registry.create(cwd);
        return workspace !== null && workspace !== undefined && typeof workspace.id === 'string' && workspace.id !== ''
          ? workspace
          : undefined;
      } catch {
        // A path that cannot back a Workspace — relative, missing, a file — keeps the
        // session creatable; it simply will not be grouped on the desk.
        return undefined;
      }
    }
    /**
     * The optional session-control services, brought up explicitly.
     *
     * Cordis activates a service when something *injects* it; a plain `get` on a
     * registered-but-idle service answers `undefined`. Reading them that way is
     * how plan mode looked uncomposed on a profile that plainly composes it — the
     * same trap the original `apiProxy` seam fell into. Neither is required, so
     * each keeps its own availability instead of failing the whole Host.
     */
    const controls = { planMode: undefined, permissionPresets: undefined, fileUploads: undefined, tokenMeter: undefined, llm: undefined, sessionTitle: undefined, skills: undefined };
    ctx.inject(['planMode'], (planCtx) => {
      controls.planMode = planCtx.get('planMode');
      return () => { controls.planMode = undefined; };
    });
    ctx.inject(['permissionPresets'], (presetCtx) => {
      controls.permissionPresets = presetCtx.get('permissionPresets');
      return () => { controls.permissionPresets = undefined; };
    });
    // File attachments ride a receipt minted by the Session upload owner; without
    // this service a file can still be read, but it cannot become a prompt part.
    ctx.inject(['fileUploads'], (uploadCtx) => {
      controls.fileUploads = uploadCtx.get('fileUploads');
      return () => { controls.fileUploads = undefined; };
    });
    // The context meter and the model route: one measures the live session, the
    // other discloses the routed model's context window. Both are optional, and
    // each keeps its own absence.
    ctx.inject(['tokenMeter'], (meterCtx) => {
      controls.tokenMeter = meterCtx.get('tokenMeter');
      return () => { controls.tokenMeter = undefined; };
    });
    ctx.inject(['llm'], (llmCtx) => {
      controls.llm = llmCtx.get('llm');
      return () => { controls.llm = undefined; };
    });
    // The title service owns the log-backed title fold and its provider, so the
    // controller's "regenerate title" action goes through it rather than through a
    // second title path of our own.
    ctx.inject(['sessionTitle'], (titleCtx) => {
      controls.sessionTitle = titleCtx.get('sessionTitle');
      return () => { controls.sessionTitle = undefined; };
    });
    // The skill registry. Its answer depends on the *viewing scope*, so merely
    // holding the service is not enough — see `liveAgentFor` below.
    ctx.inject(['skills'], (skillCtx) => {
      controls.skills = skillCtx.get('skills');
      return () => { controls.skills = undefined; };
    });

    /**
     * The viewing scope for one session's registry reads — skills, and the shape
     * the command list beside them already uses.
     *
     * Skills live in layered registries: a preset's standing mount registers into
     * that preset's layer, and a read answers for the viewing scope it is asked
     * about. Reading from this Host's own context therefore names the global layer
     * alone, which is how this menu came to be empty on a profile whose skills are
     * all registered by a preset.
     *
     * The scope key is the **agent object itself**, not a tag read off its context:
     * DSH's own skill tool calls `ctx.skills.list({ scope: agent, cwd })`, and the
     * agent is the scope-carrier key its dispatcher couples the subject to. Asking
     * `scopeOf(agent.ctx)` answers undefined — that context carries no tag — which
     * is exactly how an empty menu survived the first fix attempt.
     *
     * A **live** agent is preferred, and a cold session is then resumed — the same
     * thing the command list next to it does, for the same user action. Measured on
     * this deployment: a cold session answered `skills: 0` and `commands: 6`
     * (resolving the agent is what makes the difference), and the same session
     * answered `skills: 6` once it was live. Both lists describe one session; two
     * different answers there is not purity, it is a missing menu the user sees.
     *
     * A request naming **no** session is the new-task composer, and there the honest
     * answer is what a new session would offer: `agentPresets.standingKeyFor()`,
     * which DSH documents as "the standing scope key of one preset, for a host
     * reader with no agent … ensuring the mount composes plugins but starts no
     * agent, no session, and no turn". A session that *is* named but cannot be
     * resolved answers nothing: inventing the default composition's skills for an
     * unknown session would be a claim about a session this Host cannot see.
     * @param sessionId - the session whose agent to use as a viewing scope, if any.
     * @returns the viewing scope key, or undefined when none can be named.
     */
    async function agentScopeFor(sessionId) {
      const named = typeof sessionId === 'string' && sessionId !== '';
      const live = liveAgentFor(sessionId);
      if (live !== undefined) return live;
      if (named) {
        const resolved = await sessionController.resolveAgent(sessionId);
        return resolved?.error === undefined ? resolved.agent : undefined;
      }
      const presets = ctx.get('agentPresets');
      if (typeof presets?.standingKeyFor !== 'function') return undefined;
      try {
        return await presets.standingKeyFor();
      } catch {
        // An unusable default composition is not a reason to fail a menu; the
        // caller then reads the global layer.
        return undefined;
      }
    }

    /**
     * The live agent for one session, when this Host already has one.
     *
     * `ctx.agents.get(id)` answers for live agents only, which is the cheap first
     * probe: it asks nothing of the session store and resumes nothing.
     * @param sessionId - the session to look up.
     * @returns the live agent, or undefined.
     */
    function liveAgentFor(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined;
      const agents = ctx.get('agents');
      if (typeof agents?.get !== 'function') return undefined;
      try {
        return agents.get(sessionId) ?? undefined;
      } catch {
        // A registry mid-teardown answers nothing; the caller then reads the
        // global layer rather than failing the palette.
        return undefined;
      }
    }

    /**
     * The plan-mode controller that belongs to one agent, when one is reachable.
     *
     * `ctx.planMode` is unreachable from this context by composition, not by
     * accident: the Web bundle disables the base row and each preset composes
     * the controller inside its own agent scope. Best effort only — the command
     * route below is what actually reaches a preset-owned switch.
     * @param agent - the controller-resolved agent, or undefined.
     * @returns the plan-mode controller for that agent, or undefined.
     */
    function planModeFor(agent) {
      const scoped = typeof agent?.ctx?.get === 'function' ? agent.ctx.get('planMode') : undefined;
      return scoped === undefined ? controls.planMode : scoped;
    }

    /**
     * The plan-mode controller mounted inside one agent's own scope.
     * @param agent - the controller-resolved agent.
     * @returns the scoped controller, or undefined when the preset mounts none.
     */
    function planModeInAgentScope(agent) {
      return typeof agent?.ctx?.get === 'function' ? agent.ctx.get('planMode') : undefined;
    }

    /**
     * Whether the agent's own scope registers the `/plan` command.
     *
     * This is the switch that actually exists in this deployment: `dsh-plan-mode`
     * registers `/plan` through the command registry of whatever scope it was
     * mounted in, and the same command list the phone's `/` palette already reads
     * answers for one exact agent. A preset that composes no plan mode registers
     * no such command, so this is the honest per-session test.
     * @param agent - the agent to test.
     * @returns true when `/plan` resolves for that agent.
     */
    function planCommandAvailable(agent) {
      const commands = ctx.get('commands');
      if (typeof commands?.find !== 'function') return false;
      try {
        return commands.find(agent, 'plan') !== undefined;
      } catch {
        return false;
      }
    }

    /** Preset-composition reads are reused; the answer changes only on an edit. */
    let presetInventory = { at: 0, value: null };

    /**
     * Whether the preset a session naming no preset would compose mounts plan
     * mode.
     *
     * Used only when nothing live can answer — a freshly restarted Host has no
     * agent to inspect, and answering "unsupported" there would take the
     * control away from every controller until somebody opened a session. A row
     * reported `'conditional'` (an unevaluated `!!js disabled` expression)
     * counts as mounted: the refusal to evaluate is not evidence of absence.
     * @returns true when the default composition names the plan-mode module.
     */
    async function presetComposesPlanMode() {
      const presets = ctx.get('agentPresets');
      if (typeof presets?.compositionInventory !== 'function') return false;
      const now = Date.now();
      if (presetInventory.value !== null && now - presetInventory.at < PRESET_INVENTORY_TTL_MS) return presetInventory.value;
      let answer = false;
      try {
        const inventory = await presets.compositionInventory();
        const rows = Array.isArray(inventory) ? inventory : [];
        const target = rows.find((preset) => preset?.isDefault === true) ?? null;
        if (Array.isArray(target?.rows)) {
          answer = target.rows.some((row) => row?.moduleName === PLAN_MODE_MODULE && row.enabled !== false);
        }
      } catch {
        // A composition this Host cannot read is not evidence that it mounts
        // plan mode, so the answer stays false and the control stays hidden.
        answer = false;
      }
      presetInventory = { at: now, value: answer };
      return answer;
    }

    /**
     * Read one session's authoritative projection state.
     *
     * The control stream *pushes* projection changes, but a push that never
     * arrives is indistinguishable from "nothing changed": that is how a queue
     * came to hold a phantom row for a message the agent had already answered.
     * `observeSession` computes the registered projections on demand, so this is
     * the read that can be trusted. The lease is always released.
     * @param sessionId - the session to observe.
     * @returns the projection values this Host consumes, or null when unreadable.
     */
    async function readSessionStateNow(sessionId) {
      if (sessionQuery === undefined || typeof sessionQuery.observeSession !== 'function') return null;
      let observation;
      try {
        observation = await sessionQuery.observeSession(sessionId, { projectionMode: 'all' });
        const values = observation?.projections?.values;
        if (values === null || typeof values !== 'object') return null;
        return {
          inbox: Object.prototype.hasOwnProperty.call(values, 'inbox') ? values.inbox : undefined,
          goal: Object.prototype.hasOwnProperty.call(values, 'goal') ? values.goal : undefined,
          hasGoalKey: Object.prototype.hasOwnProperty.call(values, 'goal'),
          // What the session is running on. Effort is part of a model selection
          // in DSH, so changing effort means re-stating the model — and this is
          // where that model comes from.
          modelSelection: Object.prototype.hasOwnProperty.call(values, 'modelSelection') ? values.modelSelection : undefined,
        };
      } catch {
        // A projection read that fails costs a fresher answer, never the call.
        return null;
      } finally {
        try {
          observation?.[Symbol.dispose]?.();
        } catch {
          // Releasing a lease must not mask the answer.
        }
      }
    }

    /**
     * The model one session is running on, for a write that must name it.
     *
     * A selection the user made is the authority; `next` is the one the coming
     * request will use, and `lastUsed` is the fallback for a session whose
     * pending selection was already consumed. The catalog default is the last
     * resort, for a session that has never chosen.
     * @param sessionId - the session to read.
     * @returns `{ provider, model }`, or null when nothing can name it.
     */
    async function currentSelection(sessionId) {
      const state = await readSessionStateNow(sessionId);
      const selection = state?.modelSelection?.next ?? state?.modelSelection?.lastUsed ?? null;
      if (typeof selection?.provider === 'string' && selection.provider !== ''
        && typeof selection?.model === 'string' && selection.model !== '') {
        return {
          provider: selection.provider,
          model: selection.model,
          // The effort the session already runs on belongs here: changing effort means
          // re-stating the whole selection, and "set it to what it already is" has to
          // be recognisable as a no-op (see `setEffort`).
          ...(typeof selection.reasoningEffort === 'string' && selection.reasoningEffort !== ''
            ? { reasoningEffort: selection.reasoningEffort }
            : {}),
        };
      }
      try {
        const catalog = await sessionController.modelCatalog();
        const fallback = catalog?.default;
        if (typeof fallback?.provider === 'string' && fallback.provider !== ''
          && typeof fallback?.model === 'string' && fallback.model !== '') {
          return { provider: fallback.provider, model: fallback.model };
        }
      } catch {
        // A failed catalog read leaves the caller to refuse rather than guess.
      }
      return null;
    }

    /**
     * The reasoning efforts the catalog declares for one model route.
     *
     * `null` means "this Host cannot say" — a catalog that never loaded, or a route it
     * does not list — and the caller then lets DSH answer rather than inventing a
     * refusal for a model it has not read about.
     * @param selection - `{ provider, model }`.
     * @returns the effort ids, or null when unknown.
     */
    async function supportedEfforts(selection) {
      try {
        const catalog = await sessionController.modelCatalog();
        const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
        const group = groups.find((entry) => entry?.id === selection.provider);
        const model = (Array.isArray(group?.models) ? group.models : []).find((entry) => entry?.id === selection.model);
        const efforts = Array.isArray(model?.reasoning?.efforts) ? model.reasoning.efforts : [];
        const ids = efforts.map((effort) => effort?.id).filter((id) => typeof id === 'string' && id !== '');
        return ids.length > 0 ? ids : null;
      } catch {
        return null;
      }
    }

    /**
     * The routed model's context window, when the provider discloses one.
     *
     * `LlmResolvedModelInfo.context` is optional — a provider that lists an id and
     * nothing else leaves it absent. An absent window is reported as null rather
     * than guessed from the request's `maxTokens` (that is an **output** bound, and
     * using it as a context window would show the user a percentage that means
     * nothing).
     * @param sessionId - the session whose selection names the route.
     * @returns the window in tokens, or null when unknown.
     */
    async function contextWindowFor(sessionId) {
      const llm = controls.llm;
      if (typeof llm?.resolveModelInfo !== 'function') return null;
      const selection = await currentSelection(sessionId);
      if (selection === null) return null;
      try {
        const resolved = await llm.resolveModelInfo(selection.provider, selection.model);
        const window = resolved?.context?.contextWindow;
        return Number.isFinite(window) && window > 0 ? window : null;
      } catch {
        return null;
      }
    }
    // Message history comes from the raw log, not the projection: the projection
    // carries list rows, and `sessionController.page()` would need a `throughSeq`
    // the Host has no cheap way to learn.
    //
    // An image the phone sent comes back as a durable DSH attachment, and DSH's own
    // reference for it is content-addressed — deliberately neither a path nor a URL
    // ("never a filesystem path or bearer URL"), so there is nothing to hand the
    // controller for rendering. `ctx.attachments.readImage` is the way back to the
    // bytes, and inlining them is what makes the photo appear in the bubble instead of
    // the 没有可展示的远程路径 placeholder. Read per request, so a profile whose
    // attachment service activates later is picked up without a rebuild; absent, the
    // rows simply keep their file chips.
    //
    // Counted, because "the photo does not render" has three indistinguishable causes
    // from the outside — no handle on the block, no attachment service on this profile,
    // or a read that failed — and the counter is what separates them.
    const attachmentReads = { attempted: 0, served: 0, failed: 0 };
    const readImageAttachment = async (handle) => {
      const store = ctx.get('attachments');
      if (store === undefined || typeof store.readImage !== 'function') {
        attachmentReads.failed += 1;
        return null;
      }
      attachmentReads.attempted += 1;
      try {
        // The descriptor is passed through **whole**: it is the value DSH stored, and
        // the store validates what it is asked to read.
        const stored = await store.readImage(handle, AbortSignal.timeout(5_000));
        const data = stored?.data;
        if (data === undefined || data === null) {
          attachmentReads.failed += 1;
          return null;
        }
        attachmentReads.served += 1;
        return {
          base64: Buffer.from(data).toString('base64'),
          bytes: Number.isFinite(stored?.ref?.bytes) ? stored.ref.bytes : Buffer.from(data).length,
          mediaType: typeof stored?.ref?.mediaType === 'string' ? stored.ref.mediaType : undefined,
        };
      } catch {
        // One unreadable image costs that image, never the page.
        attachmentReads.failed += 1;
        return null;
      }
    };
    const readMessages = sessionQuery === undefined
      ? undefined
      : createMessageReader({ readSessionLog: (sessionId) => sessionQuery.readSession(sessionId), readImageAttachment });
    /**
     * How many rows one session's transcript holds.
     *
     * The controller only lights its "load earlier" entry point when it knows the
     * total and the total exceeds what it has loaded
     * (`hasOlderMessagesByServerCount`: an unknown total is deliberately treated
     * as "no"), and it reads that total from the session row's `_count.messages`.
     * This Host used to answer `_count: null`, so the entry point never lit up.
     * The count is computed on the single-session read rather than the list, which
     * the controller polls: folding every transcript on every poll would trade a
     * paging bug for a latency one.
     */
    const countMessages = sessionQuery === undefined || readMessages === undefined
      ? undefined
      : createMessageCounter({ reader: readMessages });
    /**
     * The work-grouped history window the controller prefers once it has seen
     * `history-view-v1`.
     *
     * Grouping runs over the same cached transcript the raw window pages
     * (`readMessages.all`), so the two views can never disagree about what the session
     * contains — and neither of them re-reads the log to answer.
     */
    const historyView = readMessages === undefined
      ? undefined
      : createHistoryViewController({ rows: (sessionId) => readMessages.all(sessionId) });
    // Bound once, not inline: the rename path has to be able to invalidate this source's
    // cached title, and a property of the object literal below is not in scope here.
    const sessionSource = createSessionControllerSource({
      sessionController,
      subscribe: (name, listener) => ctx.on(name, listener),
      readTitles: sessionQuery === undefined ? undefined : (ids) => readTitles(sessionQuery, ids),
      readSessionMeta: sessionQuery === undefined ? undefined : (ids) => readSessionMeta(sessionQuery, ids),
    });
    return {
      kind: 'session-controller',
      readMessages,
      countMessages,
      historyView,
      // Reported through the status route: "the photo does not render" has three
      // indistinguishable causes from the outside, and this separates them.
      attachmentReads,
      /**
       * Create one session **the way the desk's own UI creates it**.
       *
       * `session.create` takes `workspaceId` **or** `cwd`, never both, and only the
       * workspace form calls `workspace.attachSession()` — the registration that DSH's
       * own session list groups by (the `sessionIds` array in
       * `.dsh/storages/workspace.json`). Creating with a bare `cwd` therefore produces a
       * session that exists, runs, streams and answers, and is **invisible in DSH
       * itself**: reported from the handset as 手机上新建一个对话，dsh 上没看到, and
       * measured — the phone's session was absent from that workspace's `sessionIds`
       * while a Web-created session sat in it.
       *
       * So the requested directory is resolved to its workspace first (reusing the
       * existing record for that canonical path, creating one only when the directory is
       * genuinely new to DSH). A `workspaceRegistry` that cannot place the path — not
       * mounted, relative, missing, a file — falls back to the bare `cwd`, which keeps
       * the old behaviour: the session is created, it just is not grouped on the desk.
       */
      createSession: async (options) => {
        const cwd = typeof options?.cwd === 'string' && options.cwd !== '' ? options.cwd : undefined;
        const workspace = await workspaceForNewSession(cwd);
        return sessionController.create({
          ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
          ...(workspace === undefined ? (cwd === undefined ? {} : { cwd }) : { workspaceId: workspace.id }),
        });
      },
      /**
       * Send one prompt, carrying whatever attachments this Host can serve.
       *
       * The controller's attachments arrive inside the message. An absolute host path
       * is read through the composed filesystem, and an upload transit reference is
       * fetched from the account's media staging area (`resolveAttachmentRef`, which
       * this runtime supplies because the account session is its own). Both become a
       * durable DSH attachment — an image part, or a file receipt.
       *
       * Text-bearing prompts are never refused for an attachment that could not be
       * carried: the text still goes, and the answer says what was left out. A prompt
       * that is **only** an attachment is the one case that must fail loudly, because
       * there is nothing left to send — accepting it would show the user a delivered
       * photo that the agent never saw.
       */
      sendMessage: async ({ sessionId, text, requestId, mode, attachments, resolveAttachmentRef, releaseAttachmentRef }) => {
        const incoming = Array.isArray(attachments) ? attachments : [];
        const body = typeof text === 'string' ? text : '';
        let parts = [];
        let dropped = [];
        let consumed = [];
        if (incoming.length > 0) {
          const fileSystem = ctx.get('fs');
          const materializer = createAttachmentMaterializer({
            fileSystem,
            fileUploads: controls.fileUploads,
            resolveAttachmentRef,
          });
          const resolved = await sessionController.resolveAgent(sessionId);
          if (resolved?.error !== undefined) throw resolved.error;
          ({ parts, dropped, consumed } = await materializer.materialize({
            agent: resolved.agent,
            attachments: incoming,
            signal: AbortSignal.timeout(30_000),
          }));
        }
        if (parts.length === 0 && incoming.length > 0 && body.trim() === '') {
          return {
            ok: false,
            code: 'ATTACHMENT_UNAVAILABLE',
            message: `this Host could not fetch the attachment: ${dropped.map((entry) => entry.reason).join(', ') || 'unknown reason'}`,
            attachmentsDropped: dropped,
          };
        }
        const content = [
          ...(body !== '' ? [{ type: 'text', text: body }] : []),
          ...parts,
        ];
        const result = await sessionController.prompt({
          requestId,
          sessionId,
          // An idle turn queues; a running turn steers. Both are the same DSH
          // primitive, which is why one capability serves both channels.
          mode: mode === 'steer' ? 'steer' : 'queue',
          content,
        // `signal` is REQUIRED here, not optional: the service calls
        // `signal.throwIfAborted()` on entry, so omitting it throws a TypeError
        // that the controller never sees — it just keeps spinning. The timeout is
        // the honest bound: acceptance is fast, and a prompt still unaccepted
        // after 30s is a failure, not a slow success.
        }, AbortSignal.timeout(30_000));
        // The staged object was a **transit** copy, and its bytes are now a durable
        // DSH attachment. Releasing it after the prompt has landed keeps the staging
        // area from accumulating an orphan per photo; a failure here is never worth
        // failing a prompt that already succeeded, so it is best-effort by contract.
        if (typeof releaseAttachmentRef === 'function') {
          for (const ossKey of consumed) void releaseAttachmentRef(ossKey).catch(() => undefined);
        }
        return { ok: true, result, attachmentsServed: parts.length, attachmentsDropped: dropped };
      },
      /**
       * Rename, and drop the cached title the same moment.
       *
       * The row this answers with is built from the list read, which serves titles from a
       * cache (`dsh-session-source.js`); without this the controller would read back the
       * **old** title for up to the cache's TTL and look like the rename failed. A rename
       * is the only title change this Host causes itself, so it is the only one that needs
       * telling.
       */
      renameSession: async ({ sessionId, title }) => {
        const result = await sessionController.rename({ sessionId, title });
        sessionSource.invalidateTitle?.(sessionId);
        return result;
      },
      /**
       * The controller's queue commands.
       *
       * DSH keeps the pending queue in the session's durable inbox, so a queued
       * message is not something this Host can edit on its own: `updateQueue` is
       * the only supported mutation, and it is compare-and-set on the item id
       * the controller already holds.
       */
      queueControl: {
        /**
         * Commit one pending-queue mutation.
         *
         * `updateQueue` mutates the **live agent's** inbox and refuses outright
         * when there is none — with the message "queued item is no longer
         * pending", which reads as a race and is really "this session is not
         * attached". So the agent is resolved first, exactly as the goal writes
         * do; without it every cancel and edit failed on a session nobody had
         * opened, even though the item was plainly still queued.
         */
        update: async ({ sessionId, itemId, action }) => {
          const resolved = await sessionController.resolveAgent(sessionId);
          if (resolved?.error !== undefined) throw resolved.error;
          return sessionController.updateQueue({ sessionId, itemId, action });
        },
        // Cancels the active turn **without** dropping the pending inbox, which
        // is exactly what the controller asks for when it stops with a queue.
        cancel: ({ sessionId }) => sessionController.cancel({ sessionId }),
      },
      /**
       * How full one session's context is.
       *
       * A **read**, so it never resumes a session to answer: `ctx.sessions` holds
       * live sessions only, and a cold session answers `null` (the controller
       * renders that as "暂无上下文数据") rather than paying a resume for a number
       * the user only glances at. That is the same rule the goal read follows.
       *
       * The total comes from `ctx.tokenMeter.measure(session)`; the window comes
       * from the routed model, and is omitted when the provider does not disclose
       * one — the controller then shows the raw count instead of a percentage it
       * would have to invent.
       * @param request - the session to measure.
       * @returns `{ totalTokens, maxTokens?, percent? }`, or null when unknown.
       */
      contextUsage: async ({ sessionId }) => {
        const meter = controls.tokenMeter;
        if (typeof meter?.measure !== 'function') return null;
        const sessions = ctx.get('sessions');
        const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined;
        if (session === undefined) return null;
        let measurement;
        try {
          measurement = meter.measure(session);
        } catch {
          return null;
        }
        const totalTokens = Number.isFinite(measurement?.totalTokens) ? measurement.totalTokens : null;
        if (totalTokens === null) return null;
        const window = await contextWindowFor(sessionId);
        if (window === null || window <= 0) return { totalTokens };
        return { totalTokens, maxTokens: window, percent: Math.min(100, Math.max(0, (totalTokens / window) * 100)) };
      },
      /**
       * Regenerate one session's title.
       *
       * The controller's contract is generate-only — it persists whatever it gets
       * through `local-db:sessions:patch-meta` — and it renders `{ title: null }` as
       * "nothing to name it with". So a service that is absent, a session that is
       * cold, and a provider that fails all answer the same way, and none of them is
       * an error frame.
       *
       * A cold session is deliberately **not** resumed: this is a decoration on a
       * session the user has open, and waking an agent to name it would be a side
       * effect nobody asked for (the rule the goal and context reads follow too).
       * @param request - the session whose title should be regenerated.
       * @returns `{ title }`, null when there is none.
       */
      regenerateTitle: async ({ sessionId }) => {
        const titles = controls.sessionTitle;
        if (typeof titles?.refresh !== 'function') return { title: null };
        const sessions = ctx.get('sessions');
        const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined;
        if (session === undefined) return { title: null };
        const snapshot = await titles.refresh(session, AbortSignal.timeout(25_000));
        const title = typeof snapshot?.title === 'string' && snapshot.title !== '' ? snapshot.title : null;
        return { title };
      },
      /**
       * The model catalog the controller's picker reads.
       *
       * A capability read is the only way it learns this Host's models, and it
       * asks once per device: an empty catalog does not look like a missing
       * feature, it looks like a Host with nothing to offer.
       */
      modelCatalog: () => sessionController.modelCatalog(),
      /**
       * Make sure a session has a live agent, and say whether it does.
       *
       * The inbox — the pending queue — is a property of the **live agent**. A
       * cold session's projection snapshot carries no inbox at all, so a queue
       * that is plainly durable reads as empty until something attaches the
       * session, and a mutation is refused with "queued item is no longer
       * pending". Reading or changing the queue therefore begins by attaching.
       */
      ensureAgent: async (sessionId) => {
        const resolved = await sessionController.resolveAgent(sessionId);
        return resolved?.error === undefined;
      },
      /**
       * Read one session's authoritative projection state.
       *
       * The control stream *pushes* projection changes, but a push that never
       * arrives is indistinguishable from "nothing changed": that is how a queue
       * came to hold a phantom row for a message the agent had already answered.
       * `observeSession` computes the registered projections on demand, so this is
       * the read that can be trusted. The lease is always released.
       */
      readSessionState: readSessionStateNow,
      /** Apply the controller's model choice to one session. */
      selectModel: async ({ sessionId, provider, model, reasoningEffort }) => {
        // The controller's model option carries no provider id — the catalog
        // flattens models out of their provider groups — so a choice usually
        // arrives with the model alone. The catalog is the authority on which
        // provider serves it, and guessing would risk switching to a different
        // model than the user picked.
        let resolved = provider;
        if (typeof resolved !== 'string' || resolved === '') {
          const catalog = await sessionController.modelCatalog();
          const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
          resolved = groups.find((group) => (Array.isArray(group?.models) ? group.models : [])
            .some((entry) => entry?.id === model))?.id;
        }
        if (typeof resolved !== 'string' || resolved === '') {
          throw new Error(`no provider in this Host's catalog serves ${model}`);
        }
        return sessionController.selectModel({
          sessionId,
          provider: resolved,
          model,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        });
      },
      /**
       * Change one session's reasoning effort.
       *
       * Effort is part of a **model selection** in DSH
       * (`SessionSelectModelRequest extends ModelSelection`), so the write has to
       * name the model it applies to. The session's own selection is the
       * authority — re-stating it is not a model switch, and picking the catalog
       * default here would silently move a session onto another model as a side
       * effect of changing effort.
       */
      setEffort: async ({ sessionId, effort }) => {
        const selection = await currentSelection(sessionId);
        if (selection === null) throw new Error('this Host cannot name the model this session runs on');
        // Re-stating the effort a session already runs on is a no-op, not a write.
        //
        // This is not just an optimisation: DSH validates the effort against the model
        // *route*, and a route that lists no `default` rejects the word outright
        // ("provider \"openai-codex\" model \"gpt-5.6-sol\" does not support reasoning
        // effort \"default\"") while the session is demonstrably running on it. The
        // controller restores the value it read from the row, so that combination is
        // the *ordinary* path — and it used to surface as the Host crashing.
        if (selection.reasoningEffort === effort) return selection;
        const supported = await supportedEfforts(selection);
        if (supported !== null && !supported.includes(effort)) {
          throw refusalError('NOT_AVAILABLE', `model ${selection.model} offers no reasoning effort "${effort}"`);
        }
        return sessionController.selectModel({ sessionId, ...selection, reasoningEffort: effort });
      },
      /**
       * The composer's `/` and `@` palettes.
       *
       * All three sources are other plugins' services and may be absent, so each
       * answers with an empty envelope rather than refusing: an empty palette is
       * honest ("nothing to offer"), while a refusal here reads to the controller
       * as a broken composer.
       */
      palette: {
        /**
         * The skills the human-facing `/` menu can offer.
         *
         * **The scope is the whole point.** `ctx.skills.list()` reads the *global*
         * layer when no scope is given, and an agent preset's skills are registered
         * into that preset's own layer — so listing from the host context answered
         * "no skills" on a profile that plainly has them (the phone's `/` menu was
         * empty while its command list was not).
         *
         * The scope comes from the session's own agent, which is the only way a
         * preset's layer is visible at all — see `agentScopeFor`.
         */
        skills: async ({ cwd, sessionId }) => {
          const skills = controls.skills;
          if (skills === undefined || typeof skills.list !== 'function') return [];
          const scope = await agentScopeFor(sessionId);
          return skills.list({
            ...(scope === undefined ? {} : { scope }),
            ...(cwd === undefined ? {} : { cwd }),
          });
        },
        commands: async ({ sessionId }) => {
          const commands = ctx.get('commands');
          if (commands === undefined || typeof commands.list !== 'function') return [];
          const resolved = await sessionController.resolveAgent(sessionId);
          // A cold session still has a command catalog; the agent is only what
          // DSH keys it by, so an unresolvable session yields no commands rather
          // than an error the palette would show as broken.
          return resolved?.error === undefined ? commands.list(resolved.agent) : [];
        },
        resources: async ({ workingDir, query, cap }) => {
          const fileSystem = ctx.get('fs');
          if (fileSystem === undefined || typeof fileSystem.listDir !== 'function') return [];
          const resolved = typeof fileSystem.resolve === 'function' ? await fileSystem.resolve(workingDir) : workingDir;
          const listed = await fileSystem.listDir(resolved);
          return (Array.isArray(listed) ? listed : []).map((entry) => ({
            name: String(entry?.name ?? ''),
            kind: entry?.type === 'directory' || entry?.kind === 'dir' ? 'dir' : 'file',
          })).filter((entry) => entry.name !== '');
        },
      },
      /**
       * The session controls the composer offers: plan mode and the permission
       * preset.
       *
       * Both are other plugins' services and may be absent, and their absence is
       * meaningful: DSH documents that a missing `permissions` projection means
       * "clients hide the control". So the capability list and the channels are
       * built from what is composed, never from what this Host wishes were.
       */
      sessionControls: {
        /**
         * Whether this Host can switch plan mode for a session.
         *
         * Plan mode is preset-owned here, so the question is about the
         * composition a session gets, and it is answered from evidence in order
         * of strength: a host-plane service if one exists, a live agent whose
         * context carries it, then the default preset's composition rows. Only
         * when none of those can be read does this answer false — and false
         * hides the control, which is the same silence DSH itself uses for a
         * missing `permissions` projection.
         * @returns true when a plan-mode switch exists to be driven.
         */
        async planModeSupported() {
          if (typeof controls.planMode?.set === 'function') return true;
          const agents = ctx.get('agents');
          if (typeof agents?.list === 'function') {
            try {
              if (agents.list().some((agent) => planModeFor(agent) !== undefined || planCommandAvailable(agent))) return true;
            } catch {
              // A registry mid-teardown answers nothing; fall through to the
              // composition read rather than treating it as "unsupported".
            }
          }
          return presetComposesPlanMode();
        },
        /**
         * Switch plan mode for one session.
         *
         * The command registry is the real switch here. Plan mode is composed by
         * the agent's preset inside its own scope, so `ctx.planMode` is not
         * reachable from the Host; the `/plan` command that preset registered is,
         * and it is the exact path the Web composer takes. Its own answer travels
         * back to the controller rather than being flattened into a success, so a
         * switch that only lands at the next step is not reported as already on.
         * @param request - the session to switch and the requested state.
         * @returns the outcome word, or the command's own result.
         */
        async setPlanMode({ sessionId, enabled }) {
          const resolved = await sessionController.resolveAgent(sessionId);
          if (resolved?.error !== undefined) throw resolved.error;
          const agent = resolved.agent;
          const scoped = planModeInAgentScope(agent);
          if (typeof scoped?.set === 'function') return scoped.set(agent, enabled === true);
          if (typeof controls.planMode?.set === 'function') return controls.planMode.set(agent, enabled === true);

          const commands = ctx.get('commands');
          // A preset that composes no plan mode registers no `/plan`, so the
          // refusal is per session and about composition, not about this Host.
          if (typeof commands?.execute !== 'function' || !planCommandAvailable(agent)) {
            throw new Error('this session composes no plan mode');
          }
          const execution = await commands.execute(
            agent,
            enabled === true ? '/plan' : '/plan off',
            [],
            // The registry's contract takes a caller-owned signal; an unarmed
            // switch is instant, so a still-unsettled one after 30s is a failure.
            AbortSignal.timeout(30_000),
          );
          if (execution === undefined) throw new Error('the plan command did not resolve');
          const result = execution?.result;
          if (result?.kind === 'error') throw new Error(String(result.text ?? 'plan mode switch failed'));
          return {
            // The command answers with human text ("Plan mode on." vs "applies
            // from the next step"), not with DSH's outcome word, so claiming
            // `committed` here would be a guess. What is known is that the
            // switch was accepted, and the text says when it lands.
            outcome: 'accepted',
            message: typeof result?.text === 'string' ? result.text : undefined,
          };
        },
        /** The advertised preset names, in the preset table's order. */
        permissionNames: () => {
          const presets = controls.permissionPresets;
          return Array.isArray(presets?.names) ? [...presets.names] : [];
        },
        async setPermissionMode({ sessionId, mode }) {
          const presets = controls.permissionPresets;
          if (typeof presets?.set !== 'function') throw new Error('permission presets are not composed on this Host');
          const resolved = await sessionController.resolveAgent(sessionId);
          if (resolved?.error !== undefined) throw resolved.error;
          // The preset is written onto the **session**; the service then drives
          // the sandbox-mode and approval-policy knobs that execution reads.
          presets.set(resolved.agent.session, mode);
        },
      },
      /**
       * The aggregated remote file browser the controller's file screen uses.
       *
       * A factory rather than an instance: the filesystem service can be replaced
       * when its plugin reloads, and the reader has to come from whatever is
       * composed at the moment of the call — the same lesson as every other seam
       * in this Host.
       */
      fileBrowser: () => {
        const fileSystem = ctx.get('fs');
        return fileSystem === undefined ? undefined : createFileBrowser({ fileSystem });
      },
      source: sessionSource,
    };
  }

  const apiProxy = ctx.get('apiProxy');
  return { kind: 'api-proxy', readMessages: undefined, createSession: undefined, sendMessage: undefined, source: new DshHostSource(new InProcessApiClient(toFetchHandler(apiProxy))) };
}

/**
 * The capability provider the channel layer reads.
 *
 * Written as explicit fields rather than a spread of the seam's output so that
 * `kind`/`source` stay out of the channel layer — but that means a capability
 * the seam produces can be built and never forwarded, which is exactly what
 * happened to `queueControl`: every queue button answered NOT_AVAILABLE while
 * the implementation sat right there. `dsh-plugin.test.js` now asserts that
 * every capability the seam builds arrives here.
 * @param sources - the capabilities one source seam produced.
 * @returns the provider `startHost` resolves per request.
 */
export function capabilityProvider(sources) {
  return {
    readMessages: sources.readMessages,
    countMessages: sources.countMessages,
    // The work-grouped history window the controller reaches for once it has seen
    // `history-view-v1`; without this forwarding the three channels would answer
    // NOT_AVAILABLE while the controller sat right here (the `queueControl` failure).
    historyView: sources.historyView,
    attachmentReads: sources.attachmentReads,
    createSession: sources.createSession,
    sendMessage: sources.sendMessage,
    renameSession: sources.renameSession,
    files: sources.files,
    goalWrite: sources.goalWrite,
    queueControl: sources.queueControl,
    modelCatalog: sources.modelCatalog,
    regenerateTitle: sources.regenerateTitle,
    contextUsage: sources.contextUsage,
    selectModel: sources.selectModel,
    setEffort: sources.setEffort,
    readSessionState: sources.readSessionState,
    ensureAgent: sources.ensureAgent,
    palette: sources.palette,
    sessionControls: sources.sessionControls,
    fileBrowser: sources.fileBrowser,
  };
}

/**
 * Build the controller's goal writer from the two contexts that supply it.
 *
 * Both services come from other plugins and activate independently, so this
 * reads them off the injected contexts rather than closing over anything: the
 * first version referenced a `buildDshSource` local, which threw
 * `sessionController is not defined` at call time — a failure no unit test of
 * the writer could see, because it only exists once the wiring runs.
 * @param sourceCtx - the context that carries `sessionController`.
 * @param goalCtx - the context that carries `goals`.
 * @returns the writer the goal channels call.
 */
export function buildGoalWrite(sourceCtx, goalCtx) {
  const controller = sourceCtx.get('sessionController');
  return createGoalWriter({
    goals: goalCtx.get('goals'),
    resolveAgent: typeof controller?.resolveAgent === 'function'
      ? (sessionId) => controller.resolveAgent(sessionId)
      : undefined,
  });
}

/**
 * Read creation times and working directories from the session headers.
 *
 * `SessionSummary` carries neither `createdAt` nor a durable cwd, but the phone's
 * session row requires a creation time.
 */
export async function readSessionMeta(sessionQuery, sessionIds) {
  const records = await sessionQuery.listSessions();
  const wanted = new Set(sessionIds);
  const meta = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const header = record?.header;
    if (header === undefined || !wanted.has(header.id)) continue;
    meta.set(header.id, {
      createdAt: Number.isFinite(header.createdAt) ? new Date(header.createdAt).toISOString() : undefined,
      cwd: typeof header.cwd === 'string' && header.cwd !== '' ? header.cwd : null,
    });
  }
  return meta;
}

/**
 * Fold a batch title read into a `Map<sessionId, title>`.
 *
 * The nesting is the trap: `readTitleSnapshots` answers
 * `{ sessionId, status, value }`, where `value` is a `SessionTitleObservation`
 * whose `title` is a `SessionTitleSnapshot` — so the text is at
 * `value.title.title`, two levels below a field that already reads like a title.
 * Reading `value.title` as a string silently yields an object, which fails a
 * `typeof === 'string'` guard and leaves every session unnamed.
 *
 * A rejected entry is one session's failure, not the batch's: titles are row
 * decoration, so the rest still come through.
 */
export function foldTitleSnapshots(results) {
  const titles = new Map();
  const rows = Array.isArray(results) ? results : [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || row.status !== 'fulfilled') continue;
    const snapshot = row.value?.title;
    const text = typeof snapshot?.title === 'string' ? snapshot.title : null;
    if (typeof row.sessionId === 'string' && text !== null && text.trim() !== '') {
      titles.set(row.sessionId, text.trim());
    }
  }
  return titles;
}

async function readTitles(sessionQuery, sessionIds) {
  return foldTitleSnapshots(await sessionQuery.readTitleSnapshots(sessionIds));
}

/**
 * The settings write for the archive/delete/pin flags.
 *
 * **`mutate` with one `set` op, never `update`.** `update` deep-merges its patch into
 * the namespace's user section, so it cannot express a removal: un-archiving a session
 * writes "no flags for this session", which merges into nothing and leaves the archived
 * flag still on disk — where the next settings commit re-seeds it and the session
 * silently stays hidden. Measured on the live Host: archived → restored → *still*
 * `archived`, with the stale flag reloaded from the file. A path-addressed `set`
 * replaces the field exactly, which is what a snapshot write means.
 *
 * @param settings - the `settings` service.
 * @param ns - this bundle's namespace, as registered.
 * @returns the writer the runtime persists through.
 */
export function sessionFlagsWriter(settings, ns) {
  return (sessionFlags) => settings.mutate(ns, [{ op: 'set', path: ['sessionFlags'], value: sessionFlags }]);
}

export function apply(ctx) {
  const scope = ctx.settings.register(settingsNamespace(SETTINGS_NAMESPACE), HostSchema, { base: DEFAULT_HOST_SETTINGS, applies: 'live', validate: validateHostSettings });
  let runtime;
  // The source can arrive before OR after the runtime: `startHost` awaits a
  // Cindy session before resolving, while `ctx.inject` fires the moment the DSH
  // service activates. Holding it here and re-applying after the await covers
  // both orders — dropping it when `runtime` was still undefined is what left
  // the projection permanently stopped in the first wiring attempt.
  let currentSource;
  /**
   * The whole seam output, forwarded as one object.
   *
   * This used to be a hand-maintained field list, and it was the bug twice:
   * `queueControl` was built and left out (every queue button answered
   * NOT_AVAILABLE), and then `setEffort` was built, forwarded through
   * `capabilityProvider`, and left out here — so the phone's effort picker
   * answered NOT_AVAILABLE on a Host that advertises four effort levels.
   * `capabilityProvider` is the single place that decides what the channel layer
   * may see, so the seam output travels whole.
   */
  let currentSeam = {};
  /** The controller's file reads, once a filesystem service is composed. */
  let currentFiles;
  /** The controller's goal writes, once a goal service is composed. */
  let currentGoalWrite;
  // Which seam supplied the source, for the status route's diagnostics. Without
  // it a silent `none` looks identical to "this profile has no sessions yet".
  let sourceKind = 'none';

  ctx.effect(async () => {
    runtime = await startHost(undefined, scope.get(), {
      // A provider, not a snapshot: these callbacks come from the injected
      // session service, which activates after `startHost` already awaited a
      // Cindy session. Capturing them here would freeze an empty set and make a
      // capable Host answer NOT_AVAILABLE forever.
      resolveCapabilities: () => capabilityProvider({
        ...currentSeam,
        // The two capabilities that come from *other* injections rather than
        // from the seam: the filesystem, and the goal service's writer.
        files: currentFiles,
        goalWrite: currentGoalWrite,
      }),
      // The controller's archive/delete/pin writes go straight to this plugin's
      // settings section, so the whole flag store reloads with the process.
      persistSessionFlags: sessionFlagsWriter(ctx.settings, settingsNamespace(SETTINGS_NAMESPACE)),
    });
    if (currentSource !== undefined) await runtime.setSource(currentSource);
    return () => runtime.stop();
  }, 'dsh-cindy-host runtime');
  ctx.effect(() => scope.watch((settings) => runtime?.updateSettings(settings)), 'dsh-cindy-host settings');

  // Attach the DSH read source whenever a supplier activates, and detach it if
  // that supplier goes away — a reload of the session API must not leave the
  // projection reading a dead service.
  for (const serviceName of SOURCE_SERVICES) {
    ctx.inject([serviceName], (sourceCtx) => {
      const built = buildDshSource(sourceCtx, serviceName);
      // The filesystem is a separate service; the controller's file reads are
      // only wired when this profile composes one.
      const fileSystem = sourceCtx.get('fs');
      if (fileSystem !== undefined) {
        const reader = createFileReader({ fileSystem });
        currentFiles = () => reader;
      }
      // Goal writes need a live `Agent`, which only this controller can hand out.
      // `goals` is a separate plugin that may activate later, so it is injected
      // rather than read here: a missing goal service must leave the channels
      // answering NOT_AVAILABLE, not make this Host look like it has no source.
      sourceCtx.inject(['goals'], (goalCtx) => {
        currentGoalWrite = buildGoalWrite(sourceCtx, goalCtx);
        return () => {
          currentGoalWrite = undefined;
        };
      });
      currentSource = built.source;
      // The seam output travels whole; see `currentSeam`.
      currentSeam = built;
      sourceKind = built.kind;
      // The runtime may not have resolved yet; it applies the pending source
      // after its own await, and picks up the readers at construction.
      void runtime?.setSource(currentSource);
      // The input queue and jobs arrive as an AsyncIterable, not a query:
      // consume it for as long as the service is composed and fold each frame
      // into the runtime, which is what `maker:input:get-projection` reads.
      const controllerAbort = new AbortController();
      void (async () => {
        try {
          for await (const frame of sessionController.control(controllerAbort.signal)) {
            runtime?.applyControlFrame(frame);
          }
        } catch {
          // A broken control stream costs the queue panel, never the session.
        }
      })();
      sourceCtx.effect(() => () => controllerAbort.abort(), `dsh-cindy-host: ${built.kind} control stream`);
      sourceCtx.effect(() => () => {
        if (sourceKind === built.kind) sourceKind = 'none';
        currentSource = undefined;
        currentSeam = {};
        currentFiles = undefined;
        void runtime?.setSource(undefined);
      }, `dsh-cindy-host: ${built.kind} source`);
    });
  }

  // The live session stream. `session/event` fires for every appended event, so
  // it is the push path's source: fold the event into the controller's message
  // rows and hand them to whoever is watching that session.
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    // This handler runs inside Cordis's own dispatch, which has no `try`/`catch`: a throw
    // from here does not fail this plugin, it fails the process — DSH's boot installs an
    // unhandled-rejection handler that writes `fatal load failure` and calls `exit(1)`. The
    // work below reads DSH's session events and folds them, so it is exactly where an
    // unexpected event shape surfaces; it must never be able to take the desktop down.
    try {
      handleSessionEvent(session, event);
    } catch (error) {
      if (typeof runtime?.noteHandlerError === 'function') runtime.noteHandlerError('session-event', error);
    }
  }), 'dsh-cindy-host: live session stream');

  /** Fold one DSH session event into the push path and the transcript cache. */
  function handleSessionEvent(session, event) {
    if (!runtime || typeof runtime.pushSessionMessage !== 'function') return;
    const sessionId = session?.header?.id;
    if (typeof sessionId !== 'string' || sessionId === '') return;
    // DSH's own turn boundaries are the authority for the phone's spinner.
    //
    // The projection's running flag is *not*: `api-session/status` reports
    // `running: false` for a moment between a prompt being accepted and its turn
    // really starting, and announcing that as the end produced a `done` **31 ms
    // after a live turn began** — the controller finalized its streaming rows and
    // stopped its timer while the agent was still generating. `turn/start` and
    // `turn/end` are the boundaries that mean what the phone reads into them.
    if (event?.type === 'turn/start' && typeof runtime.pushTurnRunning === 'function') {
      runtime.pushTurnRunning(sessionId);
    } else if (event?.type === 'turn/end' && typeof runtime.pushTurnIdle === 'function') {
      runtime.pushTurnIdle(sessionId);
    }
    // A real boundary needs no fallback, and arming one here is not harmless: this
    // handler runs *after* the boundary was announced, so it re-armed the very
    // timer the boundary had just cancelled and sent a duplicate `done` 1.5s later.
    const boundaryArrived = event?.type === 'turn/start' || event?.type === 'turn/end';
    // The prompt is now a durable message, so DSH's inbox no longer holds it and
    // the controller's optimistic queue row has to go — otherwise it shows
    // "队列中" for a message the agent already answered.
    const rpcId = promptRpcIdOf(event);
    if (rpcId !== null && typeof runtime.retireQueuedItem === 'function') runtime.retireQueuedItem(sessionId, rpcId);
    // The transcript cache is kept current for **every** session, watched or not.
    //
    // It is what makes paging cheap (`createMessageReader`): one full read seeds it,
    // and each appended event extends it, so a "load earlier" page costs O(page)
    // instead of re-reading and re-folding a whole session log — measured at 216 ms
    // warm and 2.3 s during a live turn on the 17 MB conversation the user reported
    // as 加载更早消息…每次只加载一点点. Skipping unwatched sessions would be wrong: the
    // cache's whole value is that it never needs re-reading, and the controller
    // reaches for a session's history through a fresh subscription, not through a
    // stream this process was already following.
    if (currentSeam !== undefined && currentSeam !== null && typeof currentSeam.readMessages === 'function'
      && typeof currentSeam.readMessages.noteEvent === 'function') {
      currentSeam.readMessages.noteEvent(sessionId, event);
    }
    // Nothing to do unless a controller is watching; the fold is not free.
    if (runtime.watchersFor(sessionId) === 0) return;
    for (const row of foldSessionEvent(event, { sessionId })) runtime.pushSessionMessage(sessionId, row);
    // A durable message is a second witness that something happened, so it also
    // schedules the one check that makes sure the spinner cannot outlive the
    // turn it was watching — unless this event *was* the boundary.
    if (!boundaryArrived && typeof runtime.reconcileTurnState === 'function') runtime.reconcileTurnState(sessionId);
  }

  // DSH raises approvals as a waterfall and the chain's terminal answerer is
  // fail-closed. This answerer only serves questions for sessions a Cindy
  // controller is watching; in every other case it calls `next()` so the local
  // UI — or the fail-closed default — decides. Swallowing a question the user
  // could have answered at the desk would be worse than not answering at all.
  ctx.effect(() => ctx.on('approval/request', async (req, next) => {
    if (!runtime || typeof runtime.askApproval !== 'function') return next();
    const sessionId = req?.agent?.session?.header?.id;
    const outcome = await runtime.askApproval({
      sessionId: typeof sessionId === 'string' ? sessionId : '',
      toolName: typeof req?.toolName === 'string' ? req.toolName : '',
      reason: req?.reason,
      callId: req?.callId,
      signal: req?.signal,
    });
    // `null` means nobody was watching: pass the question down the chain.
    return outcome === null ? next() : outcome;
    // `prepend` and `global` are both REQUIRED, and this is the difference between
    // a phone that can answer a card and one that never sees one.
    //
    // `global`: DSH dispatches these waterfalls at the **agent's** scope
    // (`scopeTarget(agent, agent)`), and Cordis admits a listener to a filtered
    // dispatch only when it is global, untagged, or tagged with the dispatch key or
    // an ancestor (`EventsService.dispatch` → `hook.global || !filter || …`).
    //
    // `prepend`: the Web bundle composes `dsh-api-remotes`, which registers its own
    // listener on this same event and **parks the chain** while it waits for a
    // browser client to answer (`forwardWaterfall` holds a `Promise.withResolvers()`
    // and never calls `next()` until that remote answers). Registered after it, this
    // answerer never got a turn: the tool call simply hung, the session stayed
    // `running`, and the phone showed nothing. Going first means a Cindy controller
    // answers when one is watching; when none is, `next()` hands the question back
    // to the browser path unchanged.
  }, { prepend: true, global: true }), 'dsh-cindy-host: approval answerer');

  // The `ask_user` tool blocks on a different waterfall from approvals, and the
  // controller renders it as its own card. Leaving it unanswered does not degrade
  // the conversation — it stops it: the tool call waits for a human who never saw
  // the question. Same rule as approvals: only claim questions for a session a
  // controller is watching, and pass the rest down the chain.
  ctx.effect(() => ctx.on('user-questions/request', async (request, next) => {
    if (!runtime || typeof runtime.askUserQuestion !== 'function') return next();
    const sessionId = request?.agent?.session?.header?.id;
    const answer = await runtime.askUserQuestion({
      sessionId: typeof sessionId === 'string' ? sessionId : '',
      questions: request?.questions,
      signal: request?.signal,
    });
    // `null` means nobody was watching: let the local UI answer it.
    return answer === null ? next() : answer;
    // Same `prepend` + `global` requirement as the approval answerer above, and the
    // same reason: this waterfall is agent-scoped and the Web bundle's remote
    // forwarding listener parks ahead of a late registration.
  }, { prepend: true, global: true }), 'dsh-cindy-host: user-question answerer');

  // The settings page reaches the Host through this route. `webServer` is absent
  // in headless compositions, so the row is injected optionally: the runtime and
  // its settings still work, only the browser surface is missing.
  const routes = createHostRoutes({
    getRuntime: () => runtime,
    getDiagnostics: () => ({
      dataSource: sourceKind,
      projectionRunning: runtime?.projectionRunning === true,
      projectedSessions: runtime ? runtime.model.list().length : 0,
      // What a controller actually asked for and what it got back, with the
      // asking device. Without attribution, polling from another linked
      // computer reads as if it came from the phone the user is holding.
      recentInvokes: runtime ? runtime.getInvokeLog().slice(-20) : [],
      // Refusals outlive the success ring: a controller polling a transcript
      // evicts everything else within seconds, and the one refused channel is
      // the only entry that explains "host failed to serve this channel".
      recentRefusals: runtime ? runtime.getRefusalLog().slice(-30) : [],
      // What went out, and to how many controllers. A push to zero watchers and
      // a push the controller dropped look identical from the desk, so the
      // destination count is what makes "the phone never updated" attributable.
      recentPushes: runtime ? runtime.getPushLog().slice(-20) : [],
      // Monotonic per-channel totals. The ring churns during a turn, so a count
      // taken from it is not evidence that a push happened.
      pushTotals: runtime ? runtime.getPushTotals() : {},
      // The same for the request direction: which channels have ever been asked
      // for, and which of those answers were refusals. `recentInvokes` is a
      // forty-entry ring and a polling controller evicts it within seconds, so
      // without this "did the phone ever call X" is unanswerable.
      invokeTotals: runtime ? runtime.getInvokeTotals() : {},
      refusalTotals: runtime ? runtime.getRefusalTotals() : {},
      // How the transcript's image inlining is actually doing: `attempted` counts the
      // image handles the reader was handed, `served` the ones whose bytes came back.
      // A photo that renders as a file chip is one of {no handle on the block, no
      // attachment service on this profile, a failed read} and only these numbers tell
      // them apart. `served: 0, attempted: 0` with a photo in the transcript means the
      // handle never reached the reader at all.
      attachmentReads: currentSeam?.attachmentReads ?? { attempted: 0, served: 0, failed: 0 },
      // How the automatic reconnection is doing. "The Host vanished from the phone" and
      // "the Host was briefly offline and came back on its own" look identical from the
      // handset, and only this tells them apart.
      reconnect: runtime ? runtime.getReconnectState() : { attempts: 0, pending: false, lastReason: null },
      // What had to be given up to fit one device-link frame. The relay drops an
      // oversized frame outright, so a degraded page and a page that never arrived
      // are indistinguishable from the handset — this is where they differ.
      frameBudget: runtime && typeof runtime.getFrameBudget === 'function'
        ? runtime.getFrameBudget()
        : { limitBytes: null, refusals: 0, recentRefusals: [], degradations: [] },
      // Errors this Host caught at its own boundaries. Should stay empty: each entry is an
      // exception that would otherwise have left the whole `dsh web` process through DSH's
      // fail-loud unhandled-rejection handler.
      handlerErrors: runtime && typeof runtime.getHandlerErrors === 'function' ? runtime.getHandlerErrors() : [],
      // The topics controllers currently hold. An empty set means the phone
      // never subscribed — the single most likely reason a live reply or a todo
      // card never reaches it.
      subscriptions: runtime ? runtime.getSubscriptions() : { devices: [], sessions: [] },
    }),
    // The Host's own relay identity outlives the credential: a phone links to the
    // *device id*, so it is remembered here and reused when the credential is gone.
    getSettings: () => scope.get(),
    rememberDeviceId: (deviceId) => scope.update({ deviceId }),
  });
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: routes.handle }),
      'dsh-cindy-host: settings-page API',
    );
  });
}
