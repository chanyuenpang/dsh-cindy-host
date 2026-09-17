import test from 'node:test';
import assert from 'node:assert/strict';
import { inject, name, apply, buildDiagnostics, buildDshSource, buildGoalWrite, capabilityProvider, foldTitleSnapshots, sessionFlagsWriter } from '../src/dsh-plugin.js';

test('exports the DSH Host bundle identity and only requires settings', () => {
  assert.equal(name, 'dsh-cindy-host');
  assert.deepEqual(inject, ['settings']);
});

test('the diagnostics block is complete, and one broken field cannot remove it', () => {
  // Measured: the first version of the `listing` field read a variable that is out of scope
  // where the block is assembled, so the producer threw — and the status route answers a
  // throwing producer by **omitting `diagnostics` entirely** (its own test pins that, so a
  // broken producer cannot take the settings page down). The result was a `/status` body that
  // was simply shorter, with no error anywhere: every counter a bug hunt depends on, gone.
  const runtime = {
    projectionRunning: true,
    model: { list: () => [{}, {}] },
    getInvokeLog: () => [{ channel: 'local-db:sessions:list' }],
    getRefusalLog: () => [],
    getPushLog: () => [],
    getPushTotals: () => ({ 'maker:event': 3 }),
    getInvokeTotals: () => ({}),
    getRefusalTotals: () => ({}),
    getReconnectState: () => ({ attempts: 1, pending: false, lastReason: null }),
    getFrameBudget: () => ({ limitBytes: 2 * 1024 * 1024, refusals: 0, recentRefusals: [], degradations: [] }),
    getHandlerErrors: () => [],
    getSubscriptions: () => ({ devices: [], sessions: [] }),
  };
  const diagnostics = buildDiagnostics({
    runtime,
    sourceKind: 'session-controller',
    seam: { attachmentReads: { attempted: 2, served: 2, failed: 0 } },
    listingDiagnostics: () => ({ staleServes: 1, lastStaleReason: 'timeout', lastListedAt: 5, lastListedCount: 9 }),
  });
  for (const key of [
    'dataSource', 'projectionRunning', 'projectedSessions', 'recentInvokes', 'recentRefusals',
    'recentPushes', 'pushTotals', 'invokeTotals', 'refusalTotals', 'attachmentReads', 'reconnect',
    'frameBudget', 'handlerErrors', 'listing', 'subscriptions',
  ]) {
    assert.ok(key in diagnostics, `${key} must be present`);
  }
  assert.equal(diagnostics.projectedSessions, 2);
  assert.deepEqual(diagnostics.listing, { staleServes: 1, lastStaleReason: 'timeout', lastListedAt: 5, lastListedCount: 9 });

  // Every reader throwing is the worst case, and it still answers: the fields that can only be
  // read from the live process degrade to their empty value, the block itself survives.
  const throwing = new Proxy({}, {
    get: () => () => {
      throw new Error('producer exploded');
    },
  });
  const degraded = buildDiagnostics({
    runtime: throwing,
    sourceKind: 'session-controller',
    seam: undefined,
    listingDiagnostics: () => {
      throw new Error('producer exploded');
    },
  });
  assert.equal(degraded.recentInvokes.length, 0);
  assert.equal(degraded.listing, null);
  assert.equal(degraded.attachmentReads.served, 0);
  assert.equal(degraded.dataSource, 'session-controller', 'what does not depend on the process is still reported');
});

test('the flag store is written as a replacement, so un-archiving actually lands', async () => {
  // The live failure this pins: `scope.update` deep-merges a patch into the settings
  // section, so writing "no flags for this session" merged into nothing and left
  // `{ status: 'archived' }` on disk — the next settings commit re-seeded the store
  // from that stale value and the session stayed hidden no matter how often the user
  // hit 恢复. The writer must therefore be a path-addressed `set`.
  const section = { transportEnabled: true, sessionFlags: { probe: { status: 'archived' } } };
  const calls = [];
  const settings = {
    mutate: async (ns, ops) => {
      calls.push({ ns: String(ns), ops });
      for (const op of ops) {
        // A faithful stand-in for "set the value at this path": the field becomes
        // exactly what was handed over, including the removal.
        if (op.path.length === 1 && op.path[0] === 'sessionFlags') section.sessionFlags = op.value;
      }
    },
  };

  const write = sessionFlagsWriter(settings, 'dsh-cindy-host');
  const recorded = { probe: { status: 'archived' } };
  await write(recorded);
  await write({});

  assert.deepEqual(calls.map((call) => call.ops), [
    [{ op: 'set', path: ['sessionFlags'], value: recorded }],
    [{ op: 'set', path: ['sessionFlags'], value: {} }],
  ], 'one set op per snapshot — the removal path update() cannot express');
  assert.deepEqual(section.sessionFlags, {}, 'the archived flag is gone, not merged around');
});

/**
 * A cordis context double that records which services were *injected* (waited
 * for) and which were read synchronously with `get`.
 *
 * This distinction is the whole point: reading `sessionController` with `get` at
 * apply time returned undefined and left the Host with no data source, because
 * the supplying plugin activates later. The wiring must go through `inject`.
 */
function makeCtx(services = {}) {
  const record = { injected: [], effects: [], settingsSchemas: [], eventSubscriptions: [], listenerOptions: [] };
  const ctx = {
    record,
    get: (serviceName) => services[serviceName],
    on: (eventName, listener, options) => {
      record.eventSubscriptions.push(eventName);
      // The registration options are load-bearing for the two answerer
      // waterfalls — see the test below — so the double keeps them.
      record.listenerOptions.push({ eventName, options });
      void listener;
      return () => {};
    },
    effect: (run) => {
      record.effects.push(typeof run);
      return run();
    },
    inject: (names, callback) => {
      record.injected.push(...names);
      // Cordis calls back only once every named service exists; a double that
      // always fires would hide exactly the bug this wiring avoids.
      if (!names.every((serviceName) => services[serviceName] !== undefined)) return () => {};
      callback(ctx);
      return () => {};
    },
    settings: {
      register: (namespace, schema, options) => {
        record.settingsSchemas.push({ namespace, options });
        return { get: () => ({ transportEnabled: false, remoteControlEnabled: false, controllers: {} }), watch: () => () => {} };
      },
    },
  };
  return ctx;
}

test('waits for the session service instead of reading it at apply time', () => {
  const ctx = makeCtx({});
  apply(ctx);
  assert.ok(ctx.record.injected.includes('sessionController'), 'the DSH session service must be injected, never read with get()');
  assert.ok(ctx.record.injected.includes('webServer'), 'the settings-page route waits for the web server too');
});

test('a profile with no session API still mounts its settings page', () => {
  const ctx = makeCtx({});
  // Nothing throws: the inject callbacks never fire, the runtime still mounts,
  // and the page simply reports dataSource "none".
  assert.doesNotThrow(() => apply(ctx));
  assert.equal(ctx.record.settingsSchemas.length, 1);
});

test('both answerer waterfalls register prepended and global', () => {
  // Two independent requirements, and missing either one is invisible from the
  // Host's own diagnostics — the phone simply never sees an approval or a question
  // card while the tool call hangs:
  //
  //  - `global`: DSH dispatches `approval/request` and `user-questions/request` at
  //    the **agent's** scope, and Cordis admits a listener to a filtered dispatch
  //    only when it is global, untagged, or tagged with the dispatch key or an
  //    ancestor. A host-plane observer is none of the latter, so without this flag
  //    it is filtered out entirely.
  //  - `prepend`: the Web bundle composes `dsh-api-remotes`, whose own listener on
  //    these events parks the chain while it waits for a browser client to answer.
  //    Registered after it, this Host never gets a turn.
  //
  // Measured before the fix: a fresh session asked `ask_user_question`, the session
  // stayed `running`, `maker:get-pending-interactions` stayed `[]`, and the model
  // was eventually told its own question had been interrupted. Measured after: the
  // card appeared in 3s and answering it resumed the turn.
  const ctx = makeCtx({});
  apply(ctx);
  for (const eventName of ['approval/request', 'user-questions/request']) {
    const registration = ctx.record.listenerOptions.find((entry) => entry.eventName === eventName);
    assert.ok(registration, `${eventName} must be listened for`);
    assert.equal(registration.options?.prepend, true, `${eventName} must be consulted before the browser forwarder`);
    assert.equal(registration.options?.global, true, `${eventName} is dispatched at agent scope and must not be filtered out`);
  }
});

test('prefers the session controller and reads titles from the query engine', () => {
  const calls = [];
  const ctx = makeCtx({
    sessionController: {
      async list() {
        calls.push('list');
        return { items: [] };
      },
    },
    sessionQuery: { readTitleSnapshots: async () => [] },
  });
  const built = buildDshSource(ctx, 'sessionController');
  assert.equal(built.kind, 'session-controller');
  assert.equal(typeof built.source.listSessions, 'function');
  assert.equal(typeof built.source.onEvent, 'function');
});

test('falls back to the legacy apiProxy seam only when named as such', () => {
  const ctx = makeCtx({ apiProxy: {} });
  assert.equal(buildDshSource(ctx, 'apiProxy').kind, 'api-proxy');
});

test('a controller-created session is registered in its workspace, or DSH never shows it', async () => {
  // The reported defect: a session created from the phone existed, ran, streamed and
  // answered — and was invisible in DSH itself, because `session.create` only calls
  // `workspace.attachSession()` (the registration DSH's own list groups by) when it is
  // handed a `workspaceId`. It accepts `workspaceId` **or** `cwd`, never both.
  const calls = [];
  const workspaces = [];
  const ctx = makeCtx({
    sessionController: {
      async create(request) {
        calls.push(request);
        return { sessionId: request.sessionId ?? 'session-new' };
      },
    },
    workspaceRegistry: {
      async create(path, title) {
        workspaces.push({ path, title });
        return { id: 'ws-1', path };
      },
    },
  });
  const built = buildDshSource(ctx, 'sessionController');

  const created = await built.createSession({ sessionId: 'session-new', cwd: 'G:\\Projects\\DSH-cindy-host' });
  assert.equal(created.sessionId, 'session-new');
  assert.deepEqual(workspaces, [{ path: 'G:\\Projects\\DSH-cindy-host', title: undefined }], 'the directory is resolved to its workspace');
  assert.deepEqual(calls, [{ sessionId: 'session-new', workspaceId: 'ws-1' }], 'the workspace form registers the session — and cwd is never sent alongside it');
});

test('a session is still created when no workspace can own its directory', async () => {
  // Fail-open on purpose: a profile with no workspace registry, or a path that cannot back
  // one (missing, relative, a file), must still produce the session the phone asked for.
  const calls = [];
  const bare = makeCtx({
    sessionController: { async create(request) { calls.push(request); return { sessionId: 's1' }; } },
  });
  await buildDshSource(bare, 'sessionController').createSession({ sessionId: 's1', cwd: 'G:\\nowhere' });
  assert.deepEqual(calls[0], { sessionId: 's1', cwd: 'G:\\nowhere' }, 'no registry: the old bare-cwd behaviour');

  const refusing = makeCtx({
    sessionController: { async create(request) { calls.push(request); return { sessionId: 's2' }; } },
    workspaceRegistry: { create: async () => { throw new Error('workspace/invalid-path'); } },
  });
  await buildDshSource(refusing, 'sessionController').createSession({ sessionId: 's2', cwd: 'not-absolute' });
  assert.deepEqual(calls[1], { sessionId: 's2', cwd: 'not-absolute' }, 'an unplaceable path falls back rather than failing the create');

  // No directory at all: nothing to resolve, and no invented workspaceId either.
  const anonymous = makeCtx({
    sessionController: { async create(request) { calls.push(request); return { sessionId: 's3' }; } },
    workspaceRegistry: { create: async () => ({ id: 'ws-9' }) },
  });
  await buildDshSource(anonymous, 'sessionController').createSession({ sessionId: 's3' });
  assert.deepEqual(calls[2], { sessionId: 's3' });
});

test('passes prompt the signal it requires, or DSH throws before accepting', async () => {
  // `sessionController.prompt(request, signal)` calls `signal.throwIfAborted()`
  // on entry, so omitting it throws a TypeError the controller never sees — the
  // composer just spins forever. Every call to this method must carry a signal.
  const calls = [];
  const ctx = makeCtx({
    sessionController: {
      async prompt(request, signal) {
        calls.push({ request, signal });
        return { accepted: true };
      },
    },
  });
  const built = buildDshSource(ctx, 'sessionController');

  await built.sendMessage({ sessionId: 's1', text: 'hello', requestId: 'r1', mode: 'queue' });
  await built.sendMessage({ sessionId: 's1', text: 'stop', requestId: 'r2', mode: 'steer' });

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(call.signal !== undefined, 'prompt was called without its required signal');
    assert.equal(typeof call.signal.throwIfAborted, 'function', 'the signal must be a real AbortSignal');
  }
  assert.equal(calls[0].request.mode, 'queue');
  assert.equal(calls[1].request.mode, 'steer', 'a running turn steers');
  assert.deepEqual(calls[0].request.content, [{ type: 'text', text: 'hello' }]);
});

test('reads the session title from where it actually lives', () => {
  // The real answer nests the text two levels deep:
  //   result -> value (observation) -> title (snapshot) -> title (string)
  const titles = foldTitleSnapshots([
    { sessionId: 's1', status: 'fulfilled', value: { session: {}, title: { title: 'Fix the relay', eventSeq: 3, updatedAt: 1 } } },
    { sessionId: 's2', status: 'fulfilled', value: { session: {} } },
    { sessionId: 's3', status: 'rejected', reason: new Error('backend down') },
    null,
  ]);
  assert.equal(titles.get('s1'), 'Fix the relay');
  assert.equal(titles.has('s2'), false, 'a session with no title keeps the caller fallback');
  assert.equal(titles.has('s3'), false, 'one rejected entry must not sink the batch');
});

test('trims titles and ignores blank ones', () => {
  const titles = foldTitleSnapshots([
    { sessionId: 'a', status: 'fulfilled', value: { title: { title: '  Hello  ' } } },
    { sessionId: 'b', status: 'fulfilled', value: { title: { title: '   ' } } },
  ]);
  assert.equal(titles.get('a'), 'Hello');
  assert.equal(titles.has('b'), false);
});

test('tolerates a malformed title answer instead of throwing', () => {
  assert.equal(foldTitleSnapshots(undefined).size, 0);
  assert.equal(foldTitleSnapshots([{ sessionId: 's', status: 'fulfilled', value: null }]).size, 0);
  assert.equal(foldTitleSnapshots([{ sessionId: 's', status: 'fulfilled', value: { title: 'a string, not a snapshot' } }]).size, 0);
});

test('builds the goal writer from the contexts that actually supply its services', async () => {
  // The first version of this wiring closed over a `buildDshSource` local, which
  // no longer exists in that scope: every goal write threw
  // `sessionController is not defined`. No unit test of the writer could see it,
  // because the failure only exists once the wiring runs — which is why the
  // wiring itself is a function that can be called with two contexts.
  const created = [];
  const agent = { session: { header: { id: 's1' } } };
  const sourceCtx = { get: (serviceName) => (serviceName === 'sessionController' ? { resolveAgent: async () => ({ agent }) } : undefined) };
  const goalCtx = {
    get: (serviceName) => (serviceName === 'goals' ? {
      get: () => undefined,
      create: (receivedAgent, request) => {
        created.push({ receivedAgent, request });
        return { id: 'goal-1', revision: 1, objective: request.objective, phase: 'active', maxGoalRounds: request.maxGoalRounds, roundsStarted: 0, createdAt: 1, updatedAt: 1 };
      },
    } : undefined),
  };

  const result = await buildGoalWrite(sourceCtx, goalCtx).set({ sessionId: 's1', objective: 'ship it', limits: { maxTurns: 5 } });
  assert.equal(result.ok, true);
  assert.equal(created[0].receivedAgent, agent, 'the write runs on the controller-resolved agent');
  assert.equal(created[0].request.maxGoalRounds, 5);
  assert.equal(result.status.status, 'active');
});

test('a source context with no session controller refuses goal writes', async () => {
  // A composition that supplies a goal service but no way to resolve an agent
  // must answer NOT_AVAILABLE, never throw at the call site.
  const write = buildGoalWrite({ get: () => undefined }, { get: () => ({}) });
  const result = await write.pause('s1');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NOT_AVAILABLE');
});

test('resolves the provider a chosen model belongs to from the catalog', async () => {
  // The controller sends a model id and usually no provider: its model option
  // has no provider field, because the catalog flattens models out of their
  // groups. Guessing the provider would risk switching to another model.
  const selected = [];
  const sourceCtx = makeCtx({
    sessionController: {
      prompt: async () => ({ accepted: true }),
      list: async () => [],
      modelCatalog: async () => ({
        default: { provider: 'p1', model: 'm1' },
        groups: [
          { id: 'p1', name: 'One', models: [{ id: 'm1', name: 'M1' }] },
          { id: 'p2', name: 'Two', models: [{ id: 'm2', name: 'M2' }] },
        ],
      }),
      selectModel: async (input) => {
        selected.push(input);
        return { selected: { provider: input.provider, model: input.model } };
      },
    },
    sessionQuery: { listSessions: async () => [], readSession: async () => undefined },
  });

  const built = buildDshSource(sourceCtx, 'sessionController');
  await built.selectModel({ sessionId: 's1', model: 'm2' });
  assert.equal(selected[0].provider, 'p2', 'the catalog names the provider, not the caller');

  // A model no provider serves is refused rather than sent with a made-up route.
  await assert.rejects(
    () => built.selectModel({ sessionId: 's1', model: 'not-in-catalog' }),
    /serves not-in-catalog/,
  );

  // An explicit provider is honoured as given.
  await built.selectModel({ sessionId: 's1', provider: 'p-explicit', model: 'm1' });
  assert.equal(selected[1].provider, 'p-explicit');
});

test('every capability the seam builds is forwarded to the channel layer', () => {
  // `queueControl` was implemented, wired into `buildDshSource`, and then simply
  // left out of the provider object — so every queue button answered
  // NOT_AVAILABLE while the code sat right there. The seam's output is the
  // contract; the provider must carry all of it.
  const sourceCtx = makeCtx({
    sessionController: { prompt: async () => ({ accepted: true }), list: async () => [] },
    sessionQuery: { listSessions: async () => [], readSession: async () => undefined },
  });
  const built = buildDshSource(sourceCtx, 'sessionController');
  const provided = capabilityProvider(built);

  for (const key of Object.keys(built)) {
    if (key === 'kind' || key === 'source') continue;
    assert.ok(key in provided, `${key} is built by the seam but never reaches the channels`);
  }
  assert.equal(provided.queueControl, built.queueControl);
  assert.equal(typeof provided.queueControl.update, 'function');
});

/**
 * A live agent double whose own context carries the plan-mode controller.
 *
 * This is the shape that matters: the Web bundle disables the base `plan-mode`
 * row, so the controller is mounted by each agent preset inside `agent.ctx` and
 * is invisible from the host context. A double that answered from the host
 * context would hide exactly that.
 */
function makeAgent(sessionId, services = {}) {
  return {
    session: { header: { id: sessionId } },
    ctx: { get: (serviceName) => services[serviceName] },
  };
}

test('switches plan mode through the agent-scoped controller, not the host', async () => {
  const switched = [];
  const agent = makeAgent('s1', {
    planMode: { set: (receivedAgent, active) => { switched.push({ receivedAgent, active }); return 'committed'; } },
  });
  const sourceCtx = makeCtx({
    sessionController: { resolveAgent: async () => ({ agent }) },
    sessionQuery: { listSessions: async () => [], readSession: async () => undefined },
    agents: { list: () => [agent] },
  });
  const built = buildDshSource(sourceCtx, 'sessionController');

  assert.equal(await built.sessionControls.planModeSupported(), true, 'a live agent carrying plan mode is proof it is supported');
  assert.equal(await built.sessionControls.setPlanMode({ sessionId: 's1', enabled: true }), 'committed');
  assert.equal(switched.length, 1);
  assert.equal(switched[0].receivedAgent, agent);
  assert.equal(switched[0].active, true, 'the switch is turned on, not merely toggled');
  assert.equal(await built.sessionControls.setPlanMode({ sessionId: 's1', enabled: 'yes' }), 'committed');
  assert.equal(switched[1].active, false, 'only the literal true turns plan mode on');
});

test('refuses plan mode for a session whose preset mounts none', async () => {
  // `minimal`-style presets exist, so a session can genuinely have no switch.
  // Reporting the refusal beats claiming a switch that has nothing behind it.
  const agent = makeAgent('s1', {});
  const sourceCtx = makeCtx({
    sessionController: { resolveAgent: async () => ({ agent }) },
    sessionQuery: { listSessions: async () => [], readSession: async () => undefined },
  });
  const built = buildDshSource(sourceCtx, 'sessionController');

  assert.equal(await built.sessionControls.planModeSupported(), false);
  await assert.rejects(() => built.sessionControls.setPlanMode({ sessionId: 's1', enabled: true }), /composes no plan mode/);
});

test('switches plan mode through the /plan command the preset registered', async () => {
  // The real deployment composes plan mode inside the agent's preset scope, and
  // the controller is not reachable from the host context — the `/plan` command
  // that preset registered is. Without this route the phone's plan toggle
  // answered "this session composes no plan mode" on a session that plainly has
  // plan mode (verified live: `maker:list-agent-commands` lists `plan`).
  const executed = [];
  const agent = makeAgent('s1', {});
  const sourceCtx = makeCtx({
    sessionController: { resolveAgent: async () => ({ agent }) },
    agents: { list: () => [agent] },
    commands: {
      find: (receivedAgent, commandName) => (receivedAgent === agent && commandName === 'plan' ? { name: 'plan' } : undefined),
      execute: async (receivedAgent, line, attachments, signal) => {
        executed.push({ receivedAgent, line, attachments, signal });
        return { result: { kind: 'success', text: 'Plan mode on. Use /plan off to leave.' } };
      },
    },
  });
  const built = buildDshSource(sourceCtx, 'sessionController');

  assert.equal(await built.sessionControls.planModeSupported(), true, 'the agent-scoped command is the live proof');
  const on = await built.sessionControls.setPlanMode({ sessionId: 's1', enabled: true });
  assert.equal(executed[0].line, '/plan');
  assert.deepEqual(executed[0].attachments, []);
  assert.equal(typeof executed[0].signal?.throwIfAborted, 'function', 'execute requires a caller-owned signal');
  assert.equal(on.outcome, 'accepted');
  assert.equal(on.message, 'Plan mode on. Use /plan off to leave.');

  await built.sessionControls.setPlanMode({ sessionId: 's1', enabled: false });
  assert.equal(executed[1].line, '/plan off', 'leaving plan mode is its own command form');
});

test('a plan command that fails is reported as a failure', async () => {
  const agent = makeAgent('s1', {});
  const sourceCtx = makeCtx({
    sessionController: { resolveAgent: async () => ({ agent }) },
    commands: {
      find: () => ({ name: 'plan' }),
      execute: async () => ({ result: { kind: 'error', text: 'Attachments cannot accompany /plan off.' } }),
    },
  });
  const built = buildDshSource(sourceCtx, 'sessionController');
  await assert.rejects(
    () => built.sessionControls.setPlanMode({ sessionId: 's1', enabled: false }),
    /Attachments cannot accompany/,
  );
});

test('answers plan mode from the default preset when no agent is live yet', async () => {
  // A freshly restarted Host has no agent to inspect. Answering "unsupported"
  // there would take the control away from every controller until somebody
  // opened a session, so the default preset's own composition answers instead.
  const reads = [];
  const sourceCtx = makeCtx({
    sessionController: { resolveAgent: async () => ({}) },
    sessionQuery: { listSessions: async () => [], readSession: async () => undefined },
    agents: { list: () => [] },
    agentPresets: {
      compositionInventory: async () => {
        reads.push('inventory');
        return [
          { id: 'minimal', isDefault: false, rows: [{ moduleName: '@deepseek-ai/dsh-plan-mode', enabled: true }] },
          { id: 'standard', isDefault: true, rows: [{ moduleName: '@deepseek-ai/dsh-tool-fs', enabled: true }, { moduleName: '@deepseek-ai/dsh-plan-mode', enabled: true }] },
        ];
      },
    },
  });
  const built = buildDshSource(sourceCtx, 'sessionController');

  assert.equal(await built.sessionControls.planModeSupported(), true, 'the default composition mounts plan mode');
  // A disabled row is absence, not a switch to offer.
  const disabledCtx = makeCtx({
    sessionController: { resolveAgent: async () => ({}) },
    agents: { list: () => [] },
    agentPresets: { compositionInventory: async () => [{ id: 'standard', isDefault: true, rows: [{ moduleName: '@deepseek-ai/dsh-plan-mode', enabled: false }] }] },
  });
  const disabled = buildDshSource(disabledCtx, 'sessionController');
  assert.equal(await disabled.sessionControls.planModeSupported(), false);

  // And a Host that composes no preset service still answers, without throwing.
  const bareCtx = makeCtx({ sessionController: { resolveAgent: async () => ({}) } });
  const bare = buildDshSource(bareCtx, 'sessionController');
  assert.equal(await bare.sessionControls.planModeSupported(), false);
});

test('changes effort on the model the session already runs, never the catalog default', async () => {
  // DSH carries effort inside the model selection, so the write must re-state
  // the model. Using the catalog default here would move a session onto another
  // model as a side effect of changing effort — a different action than the one
  // the user took.
  const selected = [];
  const sourceCtx = makeCtx({
    sessionController: {
      resolveAgent: async () => ({}),
      selectModel: async (request) => { selected.push(request); return { selected: { provider: request.provider, model: request.model } }; },
      modelCatalog: async () => ({ default: { provider: 'p-default', model: 'm-default' }, groups: [] }),
    },
    sessionQuery: {
      listSessions: async () => [],
      readSession: async () => undefined,
      observeSession: async () => ({ projections: { values: { modelSelection: { lastUsed: { provider: 'p-user', model: 'm-user' }, next: null } } } }),
    },
  });
  const built = buildDshSource(sourceCtx, 'sessionController');

  await built.setEffort({ sessionId: 's1', effort: 'high' });
  assert.deepEqual(selected[0], { sessionId: 's1', provider: 'p-user', model: 'm-user', reasoningEffort: 'high' });

  // A pending selection outranks the consumed one: it is what the next request
  // will use.
  const pendingCtx = makeCtx({
    sessionController: {
      resolveAgent: async () => ({}),
      selectModel: async (request) => { selected.push(request); return { selected: request }; },
    },
    sessionQuery: {
      listSessions: async () => [],
      readSession: async () => undefined,
      observeSession: async () => ({ projections: { values: { modelSelection: { lastUsed: { provider: 'p-old', model: 'm-old' }, next: { provider: 'p-next', model: 'm-next' } } } } }),
    },
  });
  await buildDshSource(pendingCtx, 'sessionController').setEffort({ sessionId: 's1', effort: 'low' });
  assert.equal(selected[1].model, 'm-next');
});

test('effort falls back to the catalog default only for a session that never chose', async () => {
  const selected = [];
  const sourceCtx = makeCtx({
    sessionController: {
      resolveAgent: async () => ({}),
      selectModel: async (request) => { selected.push(request); return { selected: request }; },
      modelCatalog: async () => ({ default: { provider: 'p-default', model: 'm-default' }, groups: [] }),
    },
    sessionQuery: {
      listSessions: async () => [],
      readSession: async () => undefined,
      observeSession: async () => ({ projections: { values: {} } }),
    },
  });
  await buildDshSource(sourceCtx, 'sessionController').setEffort({ sessionId: 's1', effort: 'max' });
  assert.equal(selected[0].model, 'm-default');
  assert.equal(selected[0].reasoningEffort, 'max');

  // With neither a selection nor a catalog, refusing beats writing an effort
  // onto a model this Host cannot name.
  const blind = makeCtx({ sessionController: { resolveAgent: async () => ({}), selectModel: async () => ({}) }, sessionQuery: { observeSession: async () => null } });
  await assert.rejects(
    () => buildDshSource(blind, 'sessionController').setEffort({ sessionId: 's1', effort: 'max' }),
    /cannot name the model/,
  );
});

test('setting the effort a session already runs on is a no-op, not a rejected write', async () => {
  // Measured live, on the effort the controller *reads from the row and restores*:
  // DSH validates effort against the model route, and a route that lists no
  // `default` answers `provider "openai-codex" model "gpt-5.6-sol" does not support
  // reasoning effort "default"` — for a session demonstrably running on it. The
  // controller reads that as the Host crashing (`THREW`).
  const selected = [];
  const ctx = makeCtx({
    sessionController: {
      resolveAgent: async () => ({}),
      selectModel: async (request) => { selected.push(request); return { selected: request }; },
      modelCatalog: async () => ({
        default: { provider: 'p', model: 'm' },
        groups: [{ id: 'openai-codex', models: [{ id: 'gpt-5.6-sol', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }] }],
      }),
    },
    sessionQuery: {
      listSessions: async () => [],
      readSession: async () => undefined,
      observeSession: async () => ({
        projections: { values: { modelSelection: { lastUsed: { provider: 'openai-codex', model: 'gpt-5.6-sol', reasoningEffort: 'default' }, next: null } } },
      }),
    },
  });
  const built = buildDshSource(ctx, 'sessionController');

  const same = await built.setEffort({ sessionId: 's1', effort: 'default' });
  assert.deepEqual(selected, [], 'nothing is written for the value the session already has');
  assert.equal(same.reasoningEffort, 'default', 'and the answer still names the selection');

  // An effort the model does not offer is a named refusal, not a crash: the
  // controller reads NOT_AVAILABLE as "this model has no such level" and keeps its
  // picker honest instead of reporting a broken Host.
  await assert.rejects(
    () => built.setEffort({ sessionId: 's1', effort: 'max' }),
    (error) => error?.refusalCode === 'NOT_AVAILABLE' && /offers no reasoning effort/.test(String(error.message)),
  );
  assert.deepEqual(selected, [], 'the rejected write never reached DSH');

  // A route the catalog does not list is unknown, not unsupported: DSH answers.
  const unknownCtx = makeCtx({
    sessionController: {
      resolveAgent: async () => ({}),
      selectModel: async (request) => { selected.push(request); return { selected: request }; },
      modelCatalog: async () => ({ default: { provider: 'p', model: 'm' }, groups: [] }),
    },
    sessionQuery: {
      listSessions: async () => [],
      readSession: async () => undefined,
      observeSession: async () => ({ projections: { values: { modelSelection: { lastUsed: { provider: 'p-unknown', model: 'm-unknown' }, next: null } } } }),
    },
  });
  await buildDshSource(unknownCtx, 'sessionController').setEffort({ sessionId: 's1', effort: 'max' });
  assert.equal(selected[0].reasoningEffort, 'max', 'an unlisted route is still written through');
});


