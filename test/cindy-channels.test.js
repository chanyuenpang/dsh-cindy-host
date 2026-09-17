import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelRouter, SUPPORTED_CHANNELS, acceptTopics, refusalError } from '../src/cindy-channels.js';
import { queuedRowFromController } from '../src/host-input-queue.js';
import { createSessionFlags } from '../src/session-flags.js';
import { buildOssRef } from './support/oss-ref.js';

const ROWS = [
  { id: 'a', title: 'Alpha', running: true, updatedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', cwd: '/a' },
  { id: 'b', title: 'Beta', running: false, updatedAt: '2026-01-02T00:00:00.000Z', createdAt: '2026-01-02T00:00:00.000Z', cwd: '/b' },
];

/** Build a router over a fixed listing. */
function makeRouter(rows = ROWS, device = { deviceId: 'dev-host', deviceName: 'DSH Host' }) {
  const subscribers = new Set();
  const router = createChannelRouter({ listSessions: async () => rows, subscribers, getDevice: () => device });
  return { router, subscribers };
}

/** One invoke request, as the relay hands it to a target. */
function request(channel, args = [], src = 'phone-1') {
  return { v: 1, kind: 'invoke', id: 'req-1', src, payload: { channel, args } };
}

test('the supported set is exactly what the router serves', () => {
  assert.deepEqual([...SUPPORTED_CHANNELS].sort(), [
    'device-link:subscribe',
    'device-link:unsubscribe',
    'file-browser:remote-op',
    'device-link:media:fetch',
    'fs:list-dir',
    'fs:stat-path',
    'local-db:messages:list',
    'local-db:messages:view',
    'local-db:messages:view-intent',
    'local-db:messages:work-details',
    'local-db:sessions:get',
    'local-db:sessions:list',
    'local-db:sessions:patch-meta',
    'maker:create-session',
    'maker:get-capabilities',
    'maker:get-context-usage',
    'maker:get-pending-interactions',
    'maker:regenerate-title',
    'maker:git-safety:get',
    'maker:goal:clear',
    'maker:goal:get-status',
    'maker:goal:pause',
    'maker:goal:resume',
    'maker:goal:set',
    'maker:goal:update',
    'maker:input:clear-session',
    'maker:input:enqueue',
    'maker:input:get-projection',
    'maker:input:move',
    'maker:input:remove',
    'maker:input:resume',
    'maker:input:set-edit-lock',
    'maker:input:set-expanded',
    'maker:input:set-interaction-lock',
    'maker:input:steer',
    'maker:input:stop',
    'maker:input:update-content',
    'maker:input:update-text',
    'maker:list-active',
    'maker:session-in-turn',
    'maker:list-agent-commands',
    'maker:list-agent-skills',
    'maker:list-available-agents',
    'maker:list-desktop-commands',
    'maker:resolve-interaction',
    'maker:scan-at-resources',
    'maker:set-permission-mode',
    'maker:set-plan-mode',
    'maker:send',
    'maker:set-effort',
    'maker:set-model',
    'text-file:read-preview',
  ].sort());
});

test('serves the file reads, taking each channel’s own path argument', async () => {
  const asked = [];
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      files: () => ({
        statPath: async (path) => {
          asked.push(['stat', path]);
          return { kind: 'file', resolvedPath: path };
        },
        listDir: async (path) => {
          asked.push(['list', path]);
          return { resolvedPath: path, entries: [], parent: null };
        },
        readTextPreview: async (path) => {
          asked.push(['preview', path]);
          return { success: true, data: 'x', size: 1 };
        },
      }),
    }),
    subscribers: new Set(),
  });

  assert.equal((await router(request('fs:stat-path', [{ path: 'G:\\a' }]))).payload.result.kind, 'file');
  assert.equal((await router(request('fs:list-dir', [{ path: 'G:\\d' }]))).payload.result.resolvedPath, 'G:\\d');
  // `text-file:read-preview` names its argument `filePath`, not `path`.
  assert.equal((await router(request('text-file:read-preview', [{ filePath: 'G:\\b.txt' }]))).payload.result.success, true);
  assert.deepEqual(asked, [['stat', 'G:\\a'], ['list', 'G:\\d'], ['preview', 'G:\\b.txt']]);
});

test('a file read without a path, or without a filesystem, is refused honestly', async () => {
  const withFiles = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({ files: () => ({ statPath: async () => ({}) }) }),
    subscribers: new Set(),
  });
  assert.equal((await withFiles(request('fs:stat-path', [{}]))).payload.error.code, 'BAD_REQUEST');

  const bare = createChannelRouter({ listSessions: async () => ROWS, subscribers: new Set() });
  const result = await bare(request('fs:list-dir', [{ path: 'G:\\' }]));
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.error.code, 'NOT_AVAILABLE', 'a Host with no filesystem must not look like an empty directory');
});

test('serves the approval channels from the runtime, and answers NOT_AVAILABLE without one', async () => {
  const subscribers = new Set();
  const settled = [];
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      listPendingInteractions: (sessionId) => [{ request: { kind: 'permission', requestId: 'r1', sessionId } }],
      resolveInteraction: (requestId, decision) => {
        settled.push([requestId, decision]);
        return { accepted: true };
      },
    }),
    subscribers,
  });

  const listed = await router(request('maker:get-pending-interactions', ['s1']));
  assert.equal(listed.payload.result.length, 1);
  assert.equal(listed.payload.result[0].request.kind, 'permission');

  const answered = await router(request('maker:resolve-interaction', ['r1', { kind: 'permission', behavior: 'allow' }]));
  assert.deepEqual(answered.payload.result, { accepted: true });
  assert.deepEqual(settled, [['r1', { kind: 'permission', behavior: 'allow' }]]);

  // A Host with no approval support must not claim a question was answered.
  const bare = createChannelRouter({ listSessions: async () => ROWS, subscribers: new Set() });
  assert.deepEqual((await bare(request('maker:get-pending-interactions', ['s1']))).payload.result, [], 'no questions is the honest empty answer');
  const refused = await bare(request('maker:resolve-interaction', ['r1', { kind: 'permission', behavior: 'allow' }]));
  assert.equal(refused.payload.ok, false);
  assert.equal(refused.payload.error.code, 'NOT_AVAILABLE');
});

test('renames a session, and reports the row DSH actually holds', async () => {
  const renamed = [];
  const subscribers = new Set();
  const router = createChannelRouter({
    listSessions: async () => (renamed.length > 0
      ? [{ ...ROWS[0], title: renamed[0].title }]
      : ROWS),
    resolveCapabilities: () => ({ renameSession: async (input) => renamed.push(input) }),
    subscribers,
  });

  const result = await router(request('local-db:sessions:patch-meta', ['a', { title: '  New name  ' }]));
  assert.equal(result.payload.ok, true);
  assert.deepEqual(renamed, [{ sessionId: 'a', title: 'New name' }], 'the title is trimmed before it reaches DSH');
  assert.equal(result.payload.result.title, 'New name', 'the answer is the row DSH now holds, not the request echoed back');
});

test('archive, delete and pin are answered with the row the controller will store', async () => {
  // The controller applies only the fields it wrote, taken from this reply
  // (`useSessionListActions`), so a reply that does not carry the new status is not a
  // refusal — it is an instruction to revert the user's edit. That is how these three
  // actions used to look like dead buttons on the phone.
  const flags = createSessionFlags({});
  const pushed = [];
  const subscribers = new Set();
  const router = createChannelRouter({
    // What the runtime's own listing does: fold the flags onto the source rows.
    listSessions: async () => flags.projectAll(ROWS),
    resolveCapabilities: () => ({
      applySessionFlags: (sessionId, patch) => flags.apply(sessionId, patch),
      sessionHidden: (sessionId) => flags.isHidden(sessionId),
      publishSessionMeta: (sessionId, patch) => pushed.push({ sessionId, patch }),
    }),
    subscribers,
  });

  // Exactly the mobile swipe patch for 归档: status plus an unpin.
  const archived = await router(request('local-db:sessions:patch-meta', ['a', { status: 'archived', pinnedAt: null }]));
  assert.equal(archived.payload.ok, true);
  assert.equal(archived.payload.result.status, 'archived');
  assert.deepEqual(pushed, [{ sessionId: 'a', patch: { status: 'archived', pinnedAt: null } }], 'other devices holding the row are patched too');

  // 删除 is the same write with the other status.
  const deleted = await router(request('local-db:sessions:patch-meta', ['b', { status: 'deleted' }]));
  assert.equal(deleted.payload.result.status, 'deleted');

  // A hidden session is also out of the live list: its row is not shown, so an entry
  // for it would light the device's running badge from a session nobody can open.
  const active = await router(request('maker:list-active', []));
  assert.deepEqual(active.payload.result.map((entry) => entry.sessionId), [], 'Alpha runs, but it is archived');

  // 置顶 is a field, not a status, and the row must carry the timestamp the
  // controller stamps its own optimistic patch with.
  const pinned = await router(request('local-db:sessions:patch-meta', ['b', { pinnedAt: '2026-01-01T00:00:00.000Z' }]));
  assert.equal(pinned.payload.result.pinnedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(pinned.payload.result.status, 'deleted', 'the pin does not disturb the status');

  // 恢复 sends `active`, which clears the status flag.
  const restored = await router(request('local-db:sessions:patch-meta', ['a', { status: 'active' }]));
  assert.equal(restored.payload.result.status, 'active');
  // The archive's own unpin is not re-remembered: absent from the store, absent from
  // the row, and the phone never pinned anything here in the first place.
  assert.deepEqual(flags.snapshot(), { b: { status: 'deleted', pinnedAt: '2026-01-01T00:00:00.000Z' } });
  const back = await router(request('maker:list-active', []));
  assert.deepEqual(back.payload.result, [{ sessionId: 'a', isTurnRunning: true }], 'Alpha runs and is visible again');

  const missing = await router(request('local-db:sessions:patch-meta', ['', { title: 'x' }]));
  assert.equal(missing.payload.error.code, 'BAD_REQUEST');
});

test('a Host without the flag store refuses the write rather than reverting it silently', async () => {
  // A profile that composes no flag store (a bare router, as the fail-closed tests
  // build) has no way to honour 删除/归档/置顶. `NOT_AVAILABLE` says "no capability",
  // which the controller surfaces; the old behaviour — answering with an unchanged
  // row — was indistinguishable from a broken button.
  const renamed = [];
  const subscribers = new Set();
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({ renameSession: async (input) => renamed.push(input) }),
    subscribers,
  });

  const pinned = await router(request('local-db:sessions:patch-meta', ['a', { pinnedAt: '2026-01-01T00:00:00.000Z' }]));
  assert.equal(pinned.payload.ok, false);
  assert.equal(pinned.payload.error.code, 'NOT_AVAILABLE');
  assert.deepEqual(renamed, [], 'nothing was sent to DSH');

  // A rename is still served: it is the one action DSH itself owns.
  const title = await router(request('local-db:sessions:patch-meta', ['a', { title: 'Renamed' }]));
  assert.equal(title.payload.ok, true);
  assert.deepEqual(renamed, [{ sessionId: 'a', title: 'Renamed' }]);
});

test('answers the git-safety setting the controller asks for, with the feature off', async () => {
  const { router } = makeRouter();
  const result = await router(request('maker:git-safety:get'));
  assert.equal(result.payload.ok, true);
  // The three booleans are read positionally, and this Host has no auto-snapshot
  // at all: refusing would look like a broken setting rather than an absent one.
  assert.deepEqual(result.payload.result, {
    autoSnapshotEnabled: false,
    isCustomized: false,
    defaultAutoSnapshotEnabled: false,
  });
});

test('enqueue sends the prompt and answers with a projection that already holds it', async () => {
  const sent = [];
  const subscribers = new Set();
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      sendMessage: async (input) => sent.push(input),
      queuedRow: ({ clientId, text }) => ({ clientId, text, chatMessage: { role: 'user' } }),
      // DSH's own queue frame has not landed yet: the projection is empty.
      inputProjection: (sessionId, pending) => ({ sessionId, pendingQueue: pending === null ? [] : [pending], steeringQueueClientIds: [] }),
    }),
    subscribers,
  });

  const result = await router(request('maker:input:enqueue', ['s1', { clientId: 'c1', text: 'hello' }]));
  assert.equal(result.payload.ok, true);
  // The controller's own `clientId` becomes the prompt identity, because DSH
  // persists it as the queued item's `rpcId` — what the controller retires its
  // local echo on, and what DSH dedupes a retried prompt against.
  assert.deepEqual(sent, [{ sessionId: 's1', text: 'hello', requestId: 'c1', mode: 'queue' }]);
  // The composer drops the row when the answer lacks it, so it must be there.
  assert.deepEqual(result.payload.result.pendingQueue.map((row) => row.clientId), ['c1']);
});

test('the enqueue answer still holds the item with the real builder and a source row', async () => {
  // The wiring, not just the builder. The router is handed the real
  // `queuedRowFromController` and the cached row, whose field is `cwd` — the
  // shape `sessionRowFor` actually returns. The stub above hid that mismatch
  // for a whole round: the answer looked correct while every real send dropped
  // its own item, so the composer never settled and the next send repeated the
  // same text.
  const sourceRow = { id: 's1', cwd: 'G:\\w' };
  const router = createChannelRouter({
    listSessions: async () => [sourceRow],
    resolveCapabilities: () => ({
      sendMessage: async () => {},
      queuedRow: ({ clientId, text, sessionId }) => queuedRowFromController({
        clientId,
        text,
        session: { id: sessionId, cwd: 'G:\\w' },
      }),
      inputProjection: (sessionId, pending) => ({ sessionId, pendingQueue: pending === null ? [] : [pending], steeringQueueClientIds: [] }),
    }),
    subscribers: new Set(),
  });

  const result = await router(request('maker:input:enqueue', ['s1', { clientId: 'c1', text: 'hello' }]));
  assert.equal(result.payload.ok, true);
  assert.deepEqual(result.payload.result.pendingQueue.map((row) => row.clientId), ['c1']);
});

test('steer uses the same primitive in steer mode and answers a boolean', async () => {
  const sent = [];
  const subscribers = new Set();
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    // A steer only exists while a turn runs, and the mode now follows the session.
    resolveCapabilities: () => ({ isSessionRunning: () => true, sendMessage: async (input) => sent.push(input) }),
    subscribers,
  });

  const result = await router(request('maker:input:steer', ['s1', 'stop that']));
  assert.equal(result.payload.result, true, 'steer answers a boolean, not a projection');
  assert.equal(sent[0].mode, 'steer', 'a running turn steers instead of queueing');
});

test('an accepted steer is visible as steering before it is durable', async () => {
  // The handset reported 「转圈转圈然后就消失了」: it sent while a turn was running, DSH
  // spliced the prompt into the running turn's next step, and until that became a durable
  // row the projection said nothing about the message — so the controller retired its own
  // bubble and nothing replaced it. DSH's splice lands a moment after `prompt()` returns,
  // so the Host has to say it itself: the client's id belongs in
  // `steeringQueueClientIds`, and the projection has to be pushed, not merely implied.
  const sent = [];
  const steering = [];
  const pushed = [];
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      isSessionRunning: () => true,
      sendMessage: async (input) => { sent.push(input); return { ok: true }; },
      pushInputProjection: (sessionId) => pushed.push(sessionId),
      queueMirror: { markSteering: (sessionId, item) => steering.push({ sessionId, item }) },
    }),
    subscribers: new Set(),
  });

  const result = await router(request('maker:input:steer', ['s1', { clientId: 'c1', text: '插一句' }]));
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.result, true);
  assert.equal(sent[0].requestId, 'c1', 'the controller id is the prompt identity');
  assert.equal(steering.length, 1);
  assert.equal(steering[0].sessionId, 's1');
  assert.deepEqual(steering[0].item.id, 'c1');
  assert.deepEqual(steering[0].item.rpcId, 'c1', 'the row is keyed by the id the controller mints');
  assert.deepEqual(steering[0].item.message.content, [{ type: 'text', text: '插一句' }]);
  assert.deepEqual(pushed, ['s1'], 'and the projection is pushed, so the bubble has an answer');
});

test('the newest window carries prompts the Host has accepted but not yet made durable', async () => {
  // The experience this fixes: send while a turn is running, the row is not in the transcript
  // yet (DSH splices it at the turn's next step boundary — 0.4 s idle, 42 s worst observed),
  // reload the session, and the message looks lost even though it is queued and will arrive.
  // Serving it as a row on the **newest** page makes the Host answer "we have it" — and only
  // there, because a cursor names a durable row and inventing rows behind it would corrupt
  // paging.
  const pendingRow = {
    id: 's1:pending:c1',
    clientId: 'c1',
    sessionId: 's1',
    role: 'user',
    toolUseId: null,
    agentMeta: null,
    createdAt: '2026-01-01T00:00:05.000Z',
    content: { text: '插一句' },
    pendingDelivery: 'steering',
  };
  const durable = [{ id: 's1:m1:0', clientId: 's1:m1:0', role: 'assistant', content: { text: 'hi' }, createdAt: '2026-01-01T00:00:01.000Z' }];
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      readMessages: async () => durable,
      queueMirror: { pendingRows: (sessionId) => (sessionId === 's1' ? [pendingRow] : []) },
    }),
    subscribers: new Set(),
  });

  const newest = await router(request('local-db:messages:list', ['s1', { limit: 20 }]));
  assert.deepEqual(newest.payload.result.map((row) => row.clientId), ['c1', 's1:m1:0'], 'the pending prompt is the newest thing');
  assert.equal(newest.payload.result[0].role, 'user');
  assert.equal(newest.payload.result[0].content.text, '插一句');

  const paged = await router(request('local-db:messages:list', ['s1', { limit: 20, before: 's1:m1:0' }]));
  assert.deepEqual(paged.payload.result.map((row) => row.clientId), ['s1:m1:0'], 'a cursor page is durable rows only');

  // The work-grouped view shows it too, as a readable item on its newest page.
  const viewItems = [{ type: 'messages', key: 's1:m1:0', messages: durable }];
  const viewing = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      historyView: { page: async () => ({ ok: true, result: { version: 1, items: viewItems, nextCursor: 's1:m1:0', hasMore: true } }) },
      queueMirror: { pendingRows: () => [pendingRow] },
    }),
    subscribers: new Set(),
  });
  const page = await viewing(request('local-db:messages:view', ['s1', {}]));
  assert.equal(page.payload.result.items.length, 2);
  assert.equal(page.payload.result.items[1].type, 'messages');
  assert.equal(page.payload.result.items[1].messages[0].clientId, 'c1');
  assert.equal(page.payload.result.nextCursor, 's1:m1:0', 'the cursor still names the last durable item');
  // An older page never carries it: the prompt is the newest thing, not an old one.
  const older = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      historyView: { page: async () => ({ ok: true, result: { version: 1, items: viewItems, nextCursor: null, hasMore: false } }) },
      queueMirror: { pendingRows: () => [pendingRow] },
    }),
    subscribers: new Set(),
  });
  const olderPage = await older(request('local-db:messages:view', ['s1', { before: 's1:m1:0' }]));
  assert.equal(olderPage.payload.result.items.length, 1);
});

test('an empty enqueue is refused rather than accepted with nothing to run', async () => {
  const sent = [];
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({ sendMessage: async (i) => sent.push(i) }),
    subscribers: new Set(),
  });
  for (const args of [['s1', ''], ['s1', { clientId: 'c' }], ['', 'hi']]) {
    const result = await router(request('maker:input:enqueue', args));
    assert.equal(result.payload.ok, false, `${JSON.stringify(args)} must be refused`);
    assert.equal(result.payload.error.code, 'BAD_REQUEST');
  }
  assert.deepEqual(sent, []);
});

test('answers the goal status from the projection stream', async () => {
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({ goalStatus: (sessionId) => ({ sessionId, status: 'active', objective: 'x' }) }),
    subscribers: new Set(),
  });
  const result = await router(request('maker:goal:get-status', ['a']));
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.result.status, 'active');

  // A session whose goal the stream never carried answers "unknown", not
  // `null`. This test used to assert `null` on the belief that the controller
  // read it as "no goal"; reading `applyGoal` shows the opposite — `null` is a
  // *confirmed* absence that wipes the card, and `undefined` is the one that
  // leaves it alone. Answering `null` is why a live goal never appeared.
  const bare = createChannelRouter({ listSessions: async () => ROWS, subscribers: new Set() });
  const empty = await bare(request('maker:goal:get-status', ['a']));
  assert.equal(empty.payload.ok, true);
  assert.equal('result' in JSON.parse(JSON.stringify(empty)).payload, false);

  const missing = await router(request('maker:goal:get-status', ['']));
  assert.equal(missing.payload.error.code, 'BAD_REQUEST');
});

test('answers the goal writes through the goal service, and announces the new state', async () => {
  const calls = [];
  const pushed = [];
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      goalWrite: {
        set: (input) => {
          calls.push(['set', input]);
          return { ok: true, status: { sessionId: input.sessionId, status: 'active' } };
        },
        pause: (sessionId) => {
          calls.push(['pause', sessionId]);
          return { ok: true, status: { sessionId, status: 'paused' } };
        },
      },
      pushGoalStatus: (sessionId, status) => pushed.push([sessionId, status]),
    }),
    subscribers: new Set(),
  });

  const created = await router(request('maker:goal:set', [{ sessionId: 'a', objective: 'ship it', limits: { maxTurns: 10 } }]));
  assert.equal(created.payload.ok, true);
  assert.deepEqual(calls[0], ['set', { sessionId: 'a', objective: 'ship it', limits: { maxTurns: 10 } }]);
  assert.equal(created.payload.result.status, 'active');
  // A second screen watching this session has no reason to refetch.
  assert.deepEqual(pushed[0], ['a', { sessionId: 'a', status: 'active' }]);

  // `pause`/`resume`/`clear` take the bare session id, not an object.
  const paused = await router(request('maker:goal:pause', ['a']));
  assert.equal(paused.payload.ok, true);
  assert.deepEqual(calls[1], ['pause', 'a']);
});

test('a goal write with no goal service refuses instead of pretending', async () => {
  const bare = createChannelRouter({ listSessions: async () => ROWS, subscribers: new Set() });
  for (const channel of ['maker:goal:set', 'maker:goal:pause', 'maker:goal:resume', 'maker:goal:clear', 'maker:goal:update']) {
    const result = await bare(request(channel, [{ sessionId: 'a', objective: 'x' }]));
    assert.equal(result.payload.ok, false, `${channel} must not claim success`);
    assert.equal(result.payload.error.code, 'NOT_AVAILABLE');
  }
});

test("a goal write passes the service's refusal through, and needs a session", async () => {
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      goalWrite: {
        set: () => ({ ok: false, code: 'GOAL_ALREADY_EXISTS', message: 'goal "goal-1" already exists' }),
        pause: () => ({ ok: true, status: null }),
      },
    }),
    subscribers: new Set(),
  });

  const refused = await router(request('maker:goal:set', [{ sessionId: 'a', objective: 'again' }]));
  assert.equal(refused.payload.ok, false);
  // Flattening this into a generic code would hide the reason the user can act on.
  assert.equal(refused.payload.error.code, 'GOAL_ALREADY_EXISTS');
  assert.match(refused.payload.error.message, /already exists/);

  const missing = await router(request('maker:goal:pause', [{ sessionId: '' }]));
  assert.equal(missing.payload.error.code, 'BAD_REQUEST');
});

test('maker:send carries the controllers clientId as the prompt identity', async () => {
  // Both send paths must do this: `rpcId` is how the controller retires its local
  // submission echo, so going through the relay envelope id leaves the message
  // stuck "sending" and then dropped on the next transcript read.
  const sent = [];
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    // A steer only exists while a turn runs, and the mode now follows the session.
    resolveCapabilities: () => ({ isSessionRunning: () => true, sendMessage: async (input) => sent.push(input) }),
    subscribers: new Set(),
  });
  await router(request('maker:send', ['s1', { clientId: 'c1', text: 'hello' }, { clientId: 'c1' }]));
  assert.equal(sent[0].requestId, 'c1');
  assert.equal(sent[0].text, 'hello');
});

test('maker:send without a clientId still sends under the envelope id', async () => {
  const sent = [];
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    // A steer only exists while a turn runs, and the mode now follows the session.
    resolveCapabilities: () => ({ isSessionRunning: () => true, sendMessage: async (input) => sent.push(input) }),
    subscribers: new Set(),
  });
  await router(request('maker:send', ['s1', 'bare text']));
  assert.equal(sent[0].requestId, 'req-1');
});

test('set-model accepts a model without a provider and lets the Host resolve it', async () => {
  // `MobileModelOption` carries no provider id, so a choice usually arrives with
  // the model alone. Refusing that would leave the picker unusable.
  const asked = [];
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      selectModel: async (input) => {
        asked.push(input);
        return { selected: { provider: 'p-resolved', model: input.model } };
      },
    }),
    subscribers: new Set(),
  });

  const result = await router(request('maker:set-model', ['a', 'deepseek-v4-pro']));
  assert.equal(result.payload.ok, true);
  assert.equal(asked[0].provider, undefined, 'the Host resolves it, the channel does not guess');
  assert.equal(asked[0].model, 'deepseek-v4-pro');
  assert.deepEqual(result.payload.result.selected, { provider: 'p-resolved', model: 'deepseek-v4-pro' });

  // When the controller does send one, it is passed through untouched.
  await router(request('maker:set-model', ['a', 'm', 'p-given']));
  assert.equal(asked[1].provider, 'p-given');
});

test('serves effort changes, and refuses the ones it cannot apply', async () => {
  // The capabilities advertise `effortLevels`, so the controller draws the
  // picker and calls this. A Host that lists levels but cannot apply one is the
  // same lie as a model catalog that cannot route.
  const asked = [];
  const pushes = [];
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      setEffort: async (input) => { asked.push(input); return { selected: { provider: 'p', model: 'm' } }; },
      pushInputProjection: (sessionId) => pushes.push(sessionId),
    }),
    subscribers: new Set(),
  });

  const served = await router(request('maker:set-effort', ['a', 'high']));
  assert.equal(served.payload.ok, true);
  assert.deepEqual(asked[0], { sessionId: 'a', effort: 'high' });
  assert.deepEqual(pushes, ['a'], 'the session row the controller holds is now stale');

  const missing = await router(request('maker:set-effort', ['a', '']));
  assert.equal(missing.payload.error.code, 'BAD_REQUEST');

  const unsupported = await createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({}),
    subscribers: new Set(),
  })(request('maker:set-effort', ['a', 'high']));
  assert.equal(unsupported.payload.error.code, 'NOT_AVAILABLE');

  const failing = await createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({ setEffort: async () => { throw new Error('this Host cannot name the model this session runs on'); } }),
    subscribers: new Set(),
  })(request('maker:set-effort', ['a', 'high']));
  assert.equal(failing.payload.error.code, 'THREW');

  // A refusal the seam can name travels as that refusal, not as a crash.
  //
  // Measured live: restoring the effort a session already ran on answered
  // `THREW: provider "openai-codex" model "gpt-5.6-sol" does not support reasoning
  // effort "default"` — the controller reads `THREW` as the Host failing, while the
  // honest answer is "this model offers no such effort" (NOT_AVAILABLE), which is the
  // code it knows how to degrade on.
  const refused = await createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({ setEffort: async () => { throw refusalError('NOT_AVAILABLE', 'model gpt-5.6-sol offers no reasoning effort "default"'); } }),
    subscribers: new Set(),
  })(request('maker:set-effort', ['a', 'default']));
  assert.equal(refused.payload.ok, false);
  assert.equal(refused.payload.error.code, 'NOT_AVAILABLE');
  assert.match(refused.payload.error.message, /offers no reasoning effort/);
});

test('an unanswerable goal read says "unknown", never "no goal"', async () => {
  // The controller reads the difference exactly: a payload with no `result`
  // field means "unknown, leave the card alone", an explicit `null` means
  // "confirmed no goal" and wipes it. Answering `null` when nothing could answer
  // is how a live goal vanished from the phone — the projection read failed or
  // the key was not registered, and a goal that has not changed never pushes
  // again, so nothing brought the card back.
  const unreadable = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      readSessionState: async () => null,
      goalStatus: () => undefined,
    }),
    subscribers: new Set(),
  });
  const unknown = await unreadable(request('maker:goal:get-status', ['a']));
  assert.equal(unknown.payload.ok, true);
  // The wire shape is what matters: `undefined` drops the field entirely, and a
  // missing field is what the controller reads as "unknown".
  const wire = JSON.parse(JSON.stringify(unknown));
  assert.equal('result' in wire.payload, false, 'no result field is the "unknown" the controller keeps its card for');
  assert.equal(wire.payload.result, undefined);

  // A registered goal key answers authoritatively — including a real "no goal".
  const registered = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      readSessionState: async () => ({ hasGoalKey: true, goal: null }),
      goalStatus: () => undefined,
    }),
    subscribers: new Set(),
  });
  const cleared = await registered(request('maker:goal:get-status', ['a']));
  assert.equal(cleared.payload.result, null, 'a registered key with a null value is a confirmed absence');

  // And the stale stream fold is still preferred over "unknown" when it knows.
  const folded = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      readSessionState: async () => null,
      goalStatus: () => ({ sessionId: 'a', status: 'active', objective: 'ship it', turnsUsed: 1, maxTurns: 3 }),
    }),
    subscribers: new Set(),
  });
  const fromFold = await folded(request('maker:goal:get-status', ['a']));
  assert.equal(fromFold.payload.result.objective, 'ship it');
});

test('a send carries every attachment this Host can serve, in both forms', async () => {
  // The controller sends both forms in one list: a host path this Host can read, and
  // an upload transit reference whose bytes this Host fetches with its own credential.
  // Both reach the seam — it is the seam that decides what they become — and a message
  // with no serveable attachment keeps the shape it always had.
  const asked = [];
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      sendMessage: async (input) => { asked.push(input); return { ok: true, accepted: true }; },
      inputProjection: () => ({ sessionId: 's1', pendingQueue: [] }),
    }),
    subscribers: new Set(),
  });
  // The legacy scheme, which is the one phones actually put in `files[].path`.
  const ref = buildOssRef({ ossKey: 'media/u/k.jpg', mimeType: 'image/jpeg' });

  await router(request('maker:input:enqueue', ['s1', {
    clientId: 'c1',
    text: 'look at this',
    files: [
      { path: 'G:\\Projects\\DSH-cindy-host\\package.json', name: 'package.json', category: 'text' },
      { path: ref, name: 'photo.jpg', category: 'image', mimeType: 'image/jpeg' },
      // Neither form: no way for this Host to reach it, so it is not claimed.
      { path: 'vscode-remote://host/file.txt', name: 'file.txt' },
    ],
  }]));

  assert.deepEqual(asked[0].attachments, [
    { path: 'G:\\Projects\\DSH-cindy-host\\package.json', name: 'package.json', mimeType: '', category: 'text' },
    { path: ref, name: 'photo.jpg', mimeType: 'image/jpeg', category: 'image' },
  ]);

  await router(request('maker:input:enqueue', ['s1', { clientId: 'c2', text: 'no files' }]));
  assert.equal('attachments' in asked[1], false, 'an empty list is not sent');
});

test('a photo with no caption is a message, and nothing at all is not', async () => {
  // The phones send `text: ''` with an attachment when the user attaches a picture
  // and types nothing (`buildQueuedTextMessage` → `text: trimmed`). Refusing that was
  // "发照片不成功, 一直转圈" on a real handset, reproduced from its own call.
  const asked = [];
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      sendMessage: async (input) => { asked.push(input); return { ok: true }; },
      inputProjection: () => ({ sessionId: 's1', pendingQueue: [] }),
    }),
    subscribers: new Set(),
  });
  const photo = { path: buildOssRef({ ossKey: 'k', mimeType: 'image/png' }), name: 'photo.png', category: 'image' };

  const sent = await router(request('maker:input:enqueue', ['s1', { clientId: 'c1', text: '', files: [photo] }]));
  assert.equal(sent.payload.ok, true, 'an attachment with no words is still something to run');
  assert.equal(asked[0].text, '');
  assert.deepEqual(asked[0].attachments, [{ path: photo.path, name: 'photo.png', mimeType: '', category: 'image' }]);

  // Whitespace is not text either.
  const blank = await router(request('maker:send', ['s1', { clientId: 'c2', text: '   ', files: [photo] }]));
  assert.equal(blank.payload.ok, true);

  // With neither, there is genuinely nothing to run, and the refusal says so —
  // accepting it would show the user a delivered message DSH never ran.
  const empty = await router(request('maker:input:enqueue', ['s1', { clientId: 'c3', text: '', files: [] }]));
  assert.equal(empty.payload.error.code, 'BAD_REQUEST');
  assert.match(empty.payload.error.message, /no text and no attachment/);
  const emptySend = await router(request('maker:send', ['s1', { clientId: 'c4', text: '  ' }]));
  assert.equal(emptySend.payload.error.code, 'BAD_REQUEST');
});

test('an attachment the seam could not fetch fails the send instead of sending nothing', async () => {
  // A photo-only prompt whose bytes never arrived must not be reported as delivered:
  // the seam answers `ok: false` with the reason, and the channel passes it on.
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      sendMessage: async () => ({ ok: false, code: 'ATTACHMENT_UNAVAILABLE', message: 'could not fetch the attachment: no-credential' }),
    }),
    subscribers: new Set(),
  });
  const photo = { path: buildOssRef({ ossKey: 'k' }), name: 'photo.png' };

  const result = await router(request('maker:input:enqueue', ['s1', { clientId: 'c1', text: '', files: [photo] }]));
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.error.code, 'ATTACHMENT_UNAVAILABLE');
  assert.match(result.payload.error.message, /no-credential/);
});


test('answers the context usage the session menu shows, or says it is unknown', async () => {
  // The controller reads the answer leniently and renders "暂无上下文数据" for
  // anything unusable — so an unknown measurement must be `null`, never a zero,
  // which would read as an empty context.
  const measured = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      contextUsage: async ({ sessionId }) => ({ totalTokens: 12000, maxTokens: 60000, percent: 20, sessionId }),
    }),
    subscribers: new Set(),
  });
  const usage = await measured(request('maker:get-context-usage', ['s1']));
  assert.equal(usage.payload.result.totalTokens, 12000);
  assert.equal(usage.payload.result.percent, 20);

  const unknown = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({ contextUsage: async () => null }),
    subscribers: new Set(),
  });
  assert.equal((await unknown(request('maker:get-context-usage', ['s1']))).payload.result, null);

  // A Host with no meter answers null rather than refusing: the panel is a
  // decoration, not a capability the controller should hide the session for.
  const bare = createChannelRouter({ listSessions: async () => ROWS, subscribers: new Set() });
  assert.equal((await bare(request('maker:get-context-usage', ['s1']))).payload.result, null);

  // A measurement that throws is contained.
  const broken = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({ contextUsage: async () => { throw new Error('meter exploded'); } }),
    subscribers: new Set(),
  });
  assert.equal((await broken(request('maker:get-context-usage', ['s1']))).payload.result, null);
  assert.equal((await broken(request('maker:get-context-usage', ['']))).payload.error.code, 'BAD_REQUEST');
});

test('asks the palette for one session’s skills, not for the global layer', async () => {
  // Skills live in layered registries: a preset's standing mount registers into
  // that preset's layer, and a read with no scope names the global layer alone.
  // Dropping the session id here is what made this menu empty on a Host whose
  // `/` command list was full, so the field is part of the channel's contract.
  const asked = [];
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      palette: {
        skills: async (input) => {
          asked.push(input);
          return [
            { name: 'recheck', description: 'review', invocation: { userInvocable: true } },
            { name: 'internal', description: 'model only', invocation: { userInvocable: false } },
          ];
        },
      },
    }),
    subscribers: new Set(),
  });

  const result = await router(request('maker:list-agent-skills', ['pi', { workingDir: 'G:\\w', sessionId: 's1' }]));
  assert.equal(result.payload.ok, true);
  assert.deepEqual(asked[0], { cwd: 'G:\\w', sessionId: 's1' });
  // The palette's own filter still applies to whatever the registry answers.
  assert.deepEqual(result.payload.result.skills.map((skill) => skill.name), ['recheck']);

  // No cwd and no session is still a legal read — the global layer, unfiltered.
  await router(request('maker:list-agent-skills', ['pi', {}]));
  assert.deepEqual(asked[1], { cwd: undefined, sessionId: '' });

  // A Host composing no skill registry answers an empty success rather than
  // refusing: an empty palette is honest, a refusal reads as a broken composer.
  const bare = createChannelRouter({ listSessions: async () => ROWS, subscribers: new Set() });
  const empty = await bare(request('maker:list-agent-skills', ['pi', { sessionId: 's1' }]));
  assert.equal(empty.payload.ok, true);
  assert.deepEqual(empty.payload.result.skills, []);
});

test('regenerates a title, and says "no title" rather than failing', async () => {
  // The controller's contract is generate-only (`{ title: string | null }`) and it
  // persists whatever it gets through patch-meta, so "nothing to name it with" is a
  // value — and the argument is an object, unlike every other channel here.
  const asked = [];
  const served = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      regenerateTitle: async (input) => { asked.push(input); return { title: 'Fix the relay handshake' }; },
    }),
    subscribers: new Set(),
  });
  const result = await served(request('maker:regenerate-title', [{ sessionId: 's1' }]));
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.result.title, 'Fix the relay handshake');
  assert.deepEqual(asked[0], { sessionId: 's1' }, 'the session id rides inside the argument object');

  // No title, no service, and a throwing provider all answer the same shape.
  const empty = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({ regenerateTitle: async () => ({ title: null }) }),
    subscribers: new Set(),
  });
  assert.equal((await empty(request('maker:regenerate-title', [{ sessionId: 's1' }]))).payload.result.title, null);

  const bare = createChannelRouter({ listSessions: async () => ROWS, subscribers: new Set() });
  assert.equal((await bare(request('maker:regenerate-title', [{ sessionId: 's1' }]))).payload.result.title, null);

  const broken = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({ regenerateTitle: async () => { throw new Error('provider exploded'); } }),
    subscribers: new Set(),
  });
  assert.equal((await broken(request('maker:regenerate-title', [{ sessionId: 's1' }]))).payload.result.title, null);
  assert.equal((await broken(request('maker:regenerate-title', ['s1']))).payload.error.code, 'BAD_REQUEST');
});

test('reads the goal from the session projection, not only from the stream', async () => {
  // The pushed projection frames are not guaranteed to arrive: a goal existed and
  // every status read answered null for twenty seconds. The on-demand read is the
  // answer of record, and this branch must actually execute.
  const projection = {
    goal: { id: 'g1', revision: 3, objective: 'ship it', phase: 'paused', maxGoalRounds: 8 },
    roundsStarted: 2,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
  };
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      readSessionState: async () => ({ goal: projection, hasGoalKey: true }),
      // A stale fold would answer null; the live read must win.
      goalStatus: () => null,
    }),
    subscribers: new Set(),
  });

  const result = await router(request('maker:goal:get-status', ['a']));
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.result.status, 'paused');
  assert.equal(result.payload.result.objective, 'ship it');
  assert.equal(result.payload.result.maxTurns, 8);
  assert.equal(result.payload.result.turnsUsed, 2);
});

test('falls back to the folded goal when the session cannot be read', async () => {
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      readSessionState: async () => null,
      goalStatus: (sessionId) => ({ sessionId, status: 'active' }),
    }),
    subscribers: new Set(),
  });
  const result = await router(request('maker:goal:get-status', ['a']));
  assert.equal(result.payload.result.status, 'active');
});

test('refuses a resolve with no request id', async () => {
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({ resolveInteraction: () => ({ accepted: true }) }),
    subscribers: new Set(),
  });
  const result = await router(request('maker:resolve-interaction', ['', { kind: 'permission', behavior: 'allow' }]));
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.error.code, 'BAD_REQUEST');
});

test('answers the input projection the controller asks for on every session open', async () => {
  const asked = [];
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      inputProjection: (sessionId) => {
        asked.push(sessionId);
        return { sessionId, pendingQueue: [{ clientId: 'q1' }], steeringQueueClientIds: [] };
      },
    }),
    subscribers: new Set(),
  });

  const result = await router(request('maker:input:get-projection', ['a']));
  assert.equal(result.payload.ok, true);
  assert.deepEqual(asked, ['a']);
  assert.equal(result.payload.result.pendingQueue.length, 1);

  // A Host with no queue support still answers with an empty projection: an
  // empty composer is the honest answer, and refusing looks like a broken one.
  const bare = createChannelRouter({ listSessions: async () => ROWS, subscribers: new Set() });
  const empty = await bare(request('maker:input:get-projection', ['a']));
  assert.equal(empty.payload.ok, true);
  assert.deepEqual(empty.payload.result, { sessionId: 'a', pendingQueue: [], steeringQueueClientIds: [] });
});

test('resolves its write capabilities per request, not at construction', async () => {
  // The real Host builds its router before the plugin that supplies these
  // activates; capturing the snapshot would freeze an empty set and answer
  // NOT_AVAILABLE on a Host that can serve the call perfectly well.
  let wired = false;
  const subscribers = new Set();
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => (wired ? { readMessages: async () => [{ id: 'm1' }] } : {}),
    subscribers,
  });

  const before = await router(request('local-db:messages:list', ['a']));
  assert.equal(before.payload.error.code, 'NOT_AVAILABLE');

  wired = true;
  const after = await router(request('local-db:messages:list', ['a']));
  assert.equal(after.payload.ok, true, 'the same router must serve once the capability lands');
  assert.equal(after.payload.result.length, 1);
});

test('a capability provider that throws is reported, not swallowed', async () => {
  const subscribers = new Set();
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => {
      throw new Error('provider exploded');
    },
    subscribers,
  });
  await assert.rejects(() => router(request('local-db:messages:list', ['a'])), /provider exploded/);
});

test('answers the agent roster the phone asks for on every device open', async () => {
  const { router } = makeRouter();

  const agents = await router(request('maker:list-available-agents'));
  // One harness: DSH's own agent drives every session, so there is nothing to
  // choose and the roster, the picker, and the rows all agree.
  assert.deepEqual(agents.payload.result, ['pi']);

  const capabilities = await router(request('maker:get-capabilities', ['pi']));
  assert.equal(capabilities.payload.ok, true);
  // The exact keys the phone validates against (`MobileAgentCapabilities`).
  assert.deepEqual(Object.keys(capabilities.payload.result).sort(), [
    'availableModels', 'effortLevels', 'hasFastMode', 'permissionModes',
    'planModeSupported', 'supportsModelWindowSwitchGuard', 'supportsSessionAgentSwitch',
  ]);

  // `maker:provider:list` is refused on purpose. The controller only falls back
  // to `availableModels` when that channel is explicitly unsupported
  // (`canUseFlatModelFallback` needs `providersUnsupported`, which only
  // CHANNEL_NOT_ALLOWED sets) — an empty *success* reads as an authoritative
  // empty catalog and leaves the picker with nothing to show.
  const providers = await router(request('maker:provider:list'));
  assert.equal(providers.payload.ok, false);
  assert.equal(providers.payload.error.code, 'CHANNEL_NOT_ALLOWED');
});

test('refuses capabilities for a harness this Host does not offer', async () => {
  const { router } = makeRouter();
  for (const kind of ['claude-code', 'codex', 'gemini']) {
    const result = await router(request('maker:get-capabilities', [kind]));
    assert.equal(result.payload.ok, false, `${kind} is not offered`);
    assert.equal(result.payload.error.code, 'NOT_AVAILABLE', 'claiming a capability we lack is worse than refusing');
  }
});

test('serves message history, forwarding the phone paging options', async () => {
  const seen = [];
  const subscribers = new Set();
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    readMessages: async (sessionId, options) => {
      seen.push({ sessionId, options });
      return [{ id: 'm1', clientId: 'm1', sessionId, role: 'assistant', content: { text: 'hi' }, toolUseId: null, agentMeta: null, createdAt: '2026-01-01T00:00:00.000Z' }];
    },
    subscribers,
  });
  const result = await router(request('local-db:messages:list', ['a', { before: '2026-02-01T00:00:00.000Z', limit: 20 }]));
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.result.length, 1);
  assert.deepEqual(seen, [{ sessionId: 'a', options: { before: '2026-02-01T00:00:00.000Z', limit: 20 } }]);
});

test('a Host that cannot read history says so instead of returning an empty transcript', async () => {
  const subscribers = new Set();
  const router = createChannelRouter({ listSessions: async () => ROWS, subscribers });
  const result = await router(request('local-db:messages:list', ['a']));
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.error.code, 'NOT_AVAILABLE', 'an unavailable capability must not look like "no messages"');
});

test('creates a session through DSH and echoes the id the controller preallocated', async () => {
  const seen = [];
  const subscribers = new Set();
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    createSession: async (options) => {
      seen.push(options);
      return { sessionId: options.sessionId ?? 'dsh-generated' };
    },
    subscribers,
  });

  const preallocated = await router(request('maker:create-session', [{ agentKind: 'pi', id: 'client-id-1', workingDir: 'G:\\w' }]));
  assert.equal(preallocated.payload.ok, true);
  assert.equal(preallocated.payload.result.sessionId, 'client-id-1', 'passing the id through avoids a rekey');
  assert.equal(preallocated.payload.result.agentKind, 'pi');

  const generated = await router(request('maker:create-session', [{ agentKind: 'claude-code', model: 'x' }]));
  assert.equal(generated.payload.result.sessionId, 'dsh-generated', 'the picker is ignored; DSH creates the session');

  assert.deepEqual(seen, [
    { sessionId: 'client-id-1', cwd: 'G:\\w' },
    { sessionId: undefined, cwd: undefined },
  ]);
});

test('sends a prompt, accepting both message shapes the controller uses', async () => {
  const sent = [];
  const subscribers = new Set();
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    sendMessage: async (input) => sent.push(input),
    subscribers,
  });

  const plain = await router(request('maker:send', ['s1', 'hello', undefined, undefined]));
  assert.deepEqual(plain.payload.result, { accepted: true });
  const shaped = await router(request('maker:send', ['s1', { type: 'user', content: { text: 'hi there' } }]));
  assert.deepEqual(shaped.payload.result, { accepted: true });

  assert.deepEqual(sent, [
    { sessionId: 's1', text: 'hello', requestId: 'req-1' },
    { sessionId: 's1', text: 'hi there', requestId: 'req-1' },
  ]);
});

test('refuses a prompt with no text rather than claiming it was sent', async () => {
  const sent = [];
  const subscribers = new Set();
  const router = createChannelRouter({ listSessions: async () => ROWS, sendMessage: async (i) => sent.push(i), subscribers });

  for (const args of [['s1', ''], ['s1', '   '], ['s1', { type: 'user', content: {} }], ['s1', null], ['', 'hello']]) {
    const result = await router(request('maker:send', args));
    assert.equal(result.payload.ok, false, `${JSON.stringify(args)} must be refused`);
    assert.equal(result.payload.error.code, 'BAD_REQUEST');
  }
  assert.deepEqual(sent, [], 'nothing reaches DSH');
});

test('write channels answer NOT_AVAILABLE when the Host has no session API', async () => {
  const subscribers = new Set();
  const router = createChannelRouter({ listSessions: async () => ROWS, subscribers });
  for (const [channel, args] of [['maker:create-session', [{}]], ['maker:send', ['s1', 'hi']]]) {
    const result = await router(request(channel, args));
    assert.equal(result.payload.ok, false);
    assert.equal(result.payload.error.code, 'NOT_AVAILABLE');
  }
});

test('subscribing registers the controller and echoes the accepted topics', async () => {
  const { router, subscribers } = makeRouter();
  const result = await router(request('device-link:subscribe', [{ topics: ['sessions', 'session:a', 'nonsense'] }]));
  assert.equal(result.kind, 'invoke-result');
  assert.equal(result.dst, 'phone-1', 'the reply is addressed to the requesting device');
  assert.equal(result.payload.ok, true);
  assert.deepEqual(
    result.payload.result,
    { subscribed: ['sessions', 'session:a'] },
    'session:<id> must be accepted; dropping it silently denied every live push',
  );
  assert.equal(subscribers.has('phone-1'), true);
});

test('attaching announces the live turn state, read from the source and not a cache', async () => {
  // A controller that reconnects into a session learns nothing from silence: its
  // spinner clears only on an explicit terminal event, and a session merely
  // absent from `maker:list-active` is deliberately not read as idle. The state
  // must come from the source read at attach time — the runtime's row cache is
  // only refreshed by list reads, so a `running: true` captured when a turn began
  // outlived the turn that ended it, which is why the phone kept spinning.
  const idle = {
    listSessions: async () => [{ id: 'a', running: false }],
    resolveCapabilities: () => ({
      isSessionRunning: () => true, // a stale cache saying "running"
      pushTurnIdle: (sessionId) => idle.pushed.push(['done', sessionId]),
      pushTurnRunning: (sessionId) => idle.pushed.push(['running', sessionId]),
    }),
    subscribers: new Set(),
  };
  idle.pushed = [];
  await createChannelRouter(idle)(request('device-link:subscribe', [{ topics: ['session:a'] }]));
  assert.deepEqual(idle.pushed, [['done', 'a']], 'the source says idle, so the controller is told it is over');

  const live = {
    listSessions: async () => [{ id: 'a', running: true }],
    resolveCapabilities: () => ({
      isSessionRunning: () => false,
      pushTurnIdle: (sessionId) => live.pushed.push(['done', sessionId]),
      pushTurnRunning: (sessionId) => live.pushed.push(['running', sessionId]),
    }),
    subscribers: new Set(),
  };
  live.pushed = [];
  await createChannelRouter(live)(request('device-link:subscribe', [{ topics: ['session:a'] }]));
  assert.deepEqual(live.pushed, [['running', 'a']], 'a live turn is announced as live, never inferred from silence');

  // With no readable source the cached answer is still better than nothing.
  const unreadable = {
    listSessions: async () => { throw new Error('no corpus'); },
    resolveCapabilities: () => ({
      isSessionRunning: () => true,
      pushTurnIdle: (sessionId) => unreadable.pushed.push(['done', sessionId]),
      pushTurnRunning: (sessionId) => unreadable.pushed.push(['running', sessionId]),
    }),
    subscribers: new Set(),
  };
  unreadable.pushed = [];
  await createChannelRouter(unreadable)(request('device-link:subscribe', [{ topics: ['session:a'] }]));
  assert.deepEqual(unreadable.pushed, [['running', 'a']]);
});

test('a topic-routed subscription records each topic separately', async () => {
  const seen = [];
  const subscribers = new Set();
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    subscribers,
    onSubscribe: (deviceId, topics) => seen.push(['subscribe', deviceId, topics]),
    onUnsubscribe: (deviceId, topics) => seen.push(['unsubscribe', deviceId, topics]),
  });

  await router(request('device-link:subscribe', [{ topics: ['sessions', 'session:a', 'session:b'] }]));
  await router(request('device-link:unsubscribe', [{ topics: ['session:a'] }]));
  assert.deepEqual(seen, [
    ['subscribe', 'phone-1', ['sessions', 'session:a', 'session:b']],
    ['unsubscribe', 'phone-1', ['session:a']],
  ]);
});

test('accepts only the two topic families this Host serves', () => {
  assert.deepEqual(acceptTopics(['sessions', 'session:a', 'session:', 'fs-watch:/tmp', 'nope', 42]), ['sessions', 'session:a']);
  assert.deepEqual(acceptTopics(undefined), []);
});

test('unsubscribing releases the controller', async () => {
  const { router, subscribers } = makeRouter();
  await router(request('device-link:subscribe', [{ topics: ['sessions'] }]));
  const result = await router(request('device-link:unsubscribe', [{ topics: ['sessions'] }]));
  assert.deepEqual(result.payload.result, { unsubscribed: ['sessions'] });
  assert.equal(subscribers.has('phone-1'), false);
});

test('a subscribe with no topic array is tolerated and subscribes nothing', async () => {
  const { router, subscribers } = makeRouter();
  const result = await router(request('device-link:subscribe', []));
  assert.deepEqual(result.payload.result, { subscribed: [] });
  assert.equal(subscribers.size, 1, 'the controller is still registered as a push recipient');
});

test('lists sessions as flat rows the controller stores verbatim', async () => {
  const { router } = makeRouter();
  const result = await router(request('local-db:sessions:list'));
  assert.equal(result.payload.result.length, 2);
  // Flat: the controller never unwraps a `session` envelope.
  assert.equal(result.payload.result[0].id, 'a');
  assert.equal(result.payload.result[1].id, 'b');
  assert.equal('session' in result.payload.result[0], false);
});

test('stamps this Host on every row, or the phone filters them all out', async () => {
  const { router } = makeRouter(ROWS, { deviceId: 'dev-host', deviceName: 'DSH Host' });
  const result = await router(request('local-db:sessions:list'));
  for (const row of result.payload.result) {
    // The phone's home filter is `canonicalDeviceId ?? deviceLinkDeviceId ===
    // selectedDeviceId`; a row naming neither vanishes once the Host is selected.
    assert.equal(row.deviceLinkDeviceId, 'dev-host');
    assert.equal(row.deviceLinkDeviceName, 'DSH Host');
    assert.equal(row.status, 'active', 'the default status filter would drop a row without it');
  }
});

test('gets one session by its top-level id, in the same shape as the list', async () => {
  const { router } = makeRouter();
  const list = await router(request('local-db:sessions:list'));
  const one = await router(request('local-db:sessions:get', ['b']));
  assert.equal(one.payload.ok, true);
  assert.deepEqual(one.payload.result, list.payload.result[1], 'one exit shape, so they cannot drift apart');
});

test('a Host with no relay identity yet still answers with rows', async () => {
  const { router } = makeRouter(ROWS, null);
  const result = await router(request('local-db:sessions:list'));
  assert.equal(result.payload.result.length, 2);
  assert.equal(result.payload.result[0].deviceLinkDeviceId, null);
});

test('reads one session by id, and refuses an unknown one', async () => {
  const { router } = makeRouter();
  const found = await router(request('local-db:sessions:get', ['b']));
  assert.equal(found.payload.ok, true);
  assert.equal(found.payload.result.id, 'b');

  const missing = await router(request('local-db:sessions:get', ['nope']));
  assert.equal(missing.payload.ok, false);
  assert.equal(missing.payload.error.code, 'NOT_FOUND');
});

test('maker:list-active answers its own shape, not session rows', async () => {
  const { router } = makeRouter();
  const result = await router(request('maker:list-active'));
  // `[{ sessionId, isTurnRunning }]` — the controller skips any other shape, so
  // answering with rows would only mean a running badge that never lights up.
  assert.deepEqual(result.payload.result, [{ sessionId: 'a', isTurnRunning: true }]);
});

test('answers the stall watchdog from the source, not from the cached row', async () => {
  // The desktop's `isSessionTurnRunningFor` is a stall watchdog: "verify the host is
  // really still running; only `false` is safe to finish on, never kill a slow turn
  // that is genuinely working". A *missed push* is exactly what it is probing for —
  // and the runtime's cached turn state is fed by those same pushes — so the source is
  // read first and the cache is only the fallback.
  const { router } = makeRouter();
  const stale = createChannelRouter({
    listSessions: async () => ROWS,
    // A cache that believes nothing is running, which is what a lost `done`/`status`
    // push would leave behind.
    resolveCapabilities: () => ({ isSessionRunning: () => false }),
    subscribers: new Set(),
  });
  const live = await stale(request('maker:session-in-turn', ['a']));
  assert.equal(live.payload.result, true, 'the source says running even though the cache says idle');
  assert.equal((await stale(request('maker:session-in-turn', ['b']))).payload.result, false);

  // An unknown session still answers a boolean rather than an error frame: the
  // controller reads only true/false here.
  assert.equal((await stale(request('maker:session-in-turn', ['nope']))).payload.result, false);
  assert.equal((await stale(request('maker:session-in-turn', ['']))).payload.error.code, 'BAD_REQUEST');

  // Source unreadable: the cache is the best remaining answer.
  const cached = createChannelRouter({
    listSessions: async () => { throw new Error('source down'); },
    resolveCapabilities: () => ({ isSessionRunning: (sessionId) => sessionId === 'a' }),
    subscribers: new Set(),
  });
  assert.equal((await cached(request('maker:session-in-turn', ['a']))).payload.result, true);
  void router;
});

test('refuses every channel outside the implemented set, with the code controllers degrade on', async () => {
  const { router } = makeRouter();
  for (const channel of [
    // Queue *commands* are served now; compaction and error recovery are not.
    'maker:input:compact',
    'maker:input:clear-error',
    'maker:input:retry-last-error',
    'maker:worker:list',
    'device-link:remote-desktop:v1',
    // `device-link:media:fetch` is served now: it is how the controller sees a picture
    // that lives on this machine (an image the agent drew).
    'device-link:voice:transcribe',
    'fs:mkdir-p',
    // Goal *writes* are served now; the service's own non-controller operations
    // stay out, and `maker:goal:get-status` is a read, not a write.
    'maker:goal:block',
    'maker:goal:complete',
    'maker:schedule:list',
    'totally:unknown',
  ]) {
    const result = await router(request(channel));
    assert.equal(result.payload.ok, false, `${channel} must not be served yet`);
    assert.equal(result.payload.error.code, 'CHANNEL_NOT_ALLOWED', `${channel} must fail closed`);
  }
});

test('an addressable request with no channel is refused like any unknown channel', async () => {
  const { router } = makeRouter();
  for (const payload of [undefined, {}, { channel: 42 }]) {
    const result = await router({ v: 1, kind: 'invoke', id: 'x', src: 'p', payload });
    assert.equal(result.payload.ok, false);
    assert.equal(result.payload.error.code, 'CHANNEL_NOT_ALLOWED');
  }
});

test('an unaddressable invoke is answered with nothing, never a fabricated frame', async () => {
  const { router } = makeRouter();
  for (const bad of [
    { v: 1, kind: 'invoke', id: 'x', payload: { channel: 'x' } },    // no src: unroutable
    { v: 1, kind: 'invoke', src: 'p', payload: { channel: 'x' } },   // no id: unpaired
    null,
  ]) {
    assert.equal(await router(bad), null, 'a reply the relay cannot route must not be sent');
  }
});

test('media:fetch forwards the fields that decide the answer', async () => {
  // This Host has already been bitten by a channel that built a capability and then did
  // not forward the request to it: `thumbnail` is what makes the reply carry bytes instead
  // of a key, and `skipCache` is the controller saying the staged object is gone.
  const asked = [];
  const router = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({
      fetchLocalMedia: async (input) => { asked.push(input); return { ok: true, result: { ossKey: 'k', mimeType: 'image/png', size: 1 } }; },
    }),
    subscribers: new Set(),
  });

  const plain = await router(request('device-link:media:fetch', [{ url: 'xdt-file://open?path=%2Fw%2Fa.png' }]));
  assert.equal(plain.payload.ok, true);
  assert.deepEqual(asked[0], { url: 'xdt-file://open?path=%2Fw%2Fa.png', thumbnail: false, skipCache: false });

  await router(request('device-link:media:fetch', [{ url: 'xdt-file://open?path=%2Fw%2Fa.png', thumbnail: true, skipCache: true }]));
  assert.deepEqual(asked[1], { url: 'xdt-file://open?path=%2Fw%2Fa.png', thumbnail: true, skipCache: true });

  // A refusal travels with the code the seam named.
  const refusing = createChannelRouter({
    listSessions: async () => ROWS,
    resolveCapabilities: () => ({ fetchLocalMedia: async () => ({ ok: false, code: 'FORBIDDEN', message: 'outside the directory' }) }),
    subscribers: new Set(),
  });
  const refused = await refusing(request('device-link:media:fetch', [{ url: 'xdt-file://open?path=%2Fetc%2Fpasswd' }]));
  assert.equal(refused.payload.error.code, 'FORBIDDEN');

  const absent = await createChannelRouter({ listSessions: async () => ROWS, resolveCapabilities: () => ({}), subscribers: new Set() })(request('device-link:media:fetch', []));
  assert.equal(absent.payload.error.code, 'NOT_AVAILABLE');
});

test('subscribing to a session repairs what a dropped push would have carried', async () => {
  // Measured on the handset: an app returning from the background flickers unsubscribe →
  // resubscribe, a send landed inside the flicker, and the frames carrying "accepted" and "the
  // view changed" were discarded by the relay with nobody to retry them — the bubble spun forever
  // and the transcript stayed stale until the app was restarted. A subscription is the one moment
  // the client is certainly listening, so the repair rides on it: the authoritative input
  // projection (retires a spinning bubble) and a view invalidation (re-read).
  const projections = [];
  const invalidations = [];
  const router = createChannelRouter({
    listSessions: async () => [{ id: 's1', title: 'Alpha', running: false, updatedAt: '2026-01-01T00:00:00.000Z' }],
    resolveCapabilities: () => ({
      isSessionRunning: () => false,
      pushTurnIdle: () => {},
      pushTurnRunning: () => {},
      pushInputProjection: (sessionId) => projections.push(sessionId),
      invalidateHistoryView: (sessionId) => invalidations.push(sessionId),
    }),
    subscribers: new Set(),
  });

  await router(request('device-link:subscribe', [{ topics: ['sessions', 'session:s1'] }]));
  assert.deepEqual(projections, ['s1'], 'the queue is pushed, so a spinning bubble can be retired');
  assert.deepEqual(invalidations, ['s1'], 'and the view is invalidated, so the transcript re-reads');

  // The list topic alone is not a session: nothing to repair.
  projections.length = 0;
  invalidations.length = 0;
  await router(request('device-link:subscribe', [{ topics: ['sessions'] }]));
  assert.deepEqual(projections, []);
  assert.deepEqual(invalidations, []);
});
