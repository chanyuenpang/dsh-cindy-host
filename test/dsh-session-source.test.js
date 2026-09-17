import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionControllerSource } from '../src/dsh-session-source.js';

/** A `sessionController` double: only `list` is used by the source. */
function makeController(items, onList) {
  return {
    async list(request, signal) {
      onList?.(request, signal);
      return { items };
    },
  };
}

/** A cordis-like event hub that records subscriptions and can emit. */
function makeSubscribe() {
  const handlers = new Map();
  const subscribe = (name, listener) => {
    handlers.set(name, [...(handlers.get(name) ?? []), listener]);
    return () => {
      handlers.set(name, (handlers.get(name) ?? []).filter((entry) => entry !== listener));
    };
  };
  subscribe.emit = (name, ...args) => {
    for (const listener of [...(handlers.get(name) ?? [])]) listener(...args);
  };
  subscribe.count = (name) => (handlers.get(name) ?? []).length;
  return subscribe;
}

test('requires the session controller service', () => {
  assert.throws(() => createSessionControllerSource({ subscribe: () => () => {} }), /requires sessionController/);
});

test('maps the host session list into conversation rows', async () => {
  let request;
  const source = createSessionControllerSource({
    sessionController: makeController(
      [
        { sessionId: 's1', updatedAt: 1_700_000_000_000, running: true, blank: false },
        { sessionId: 's2', updatedAt: 1_700_000_001_000, running: false, blank: true },
      ],
      (value, signal) => {
        request = { value, hasSignal: signal !== undefined };
      },
    ),
    subscribe: makeSubscribe(),
  });

  const rows = await source.listSessions();
  assert.deepEqual(request.value, {}, 'the host list request is empty');
  assert.equal(request.hasSignal, true, 'the list read is cancellable');
  assert.deepEqual(rows, [
    { id: 's1', title: undefined, running: true, updatedAt: new Date(1_700_000_000_000).toISOString(), createdAt: new Date(1_700_000_000_000).toISOString(), cwd: null, blank: false },
    { id: 's2', title: undefined, running: false, updatedAt: new Date(1_700_000_001_000).toISOString(), createdAt: new Date(1_700_000_001_000).toISOString(), cwd: null, blank: true },
  ]);
});

test('carries the working directory and a real creation time when available', async () => {
  const source = createSessionControllerSource({
    sessionController: makeController([{ sessionId: 's1', updatedAt: 1_700_000_001_000, running: false, cwd: 'G:\\work' }]),
    subscribe: makeSubscribe(),
    readSessionMeta: async (ids) => new Map(ids.map((id) => [id, { createdAt: '2020-01-01T00:00:00.000Z', cwd: 'G:\\other' }])),
  });
  const [row] = await source.listSessions();
  assert.equal(row.cwd, 'G:\\work', 'the summary cwd wins over the header');
  assert.equal(row.createdAt, '2020-01-01T00:00:00.000Z', 'creation time comes from the header, not from updatedAt');
});

test('pays for a session header once, not on every listing', async () => {
  let reads = 0;
  const source = createSessionControllerSource({
    sessionController: makeController([{ sessionId: 's1', updatedAt: 1_700_000_000_000, running: false }]),
    subscribe: makeSubscribe(),
    readSessionMeta: async (ids) => {
      reads += 1;
      return new Map(ids.map((id) => [id, { createdAt: '2020-01-01T00:00:00.000Z' }]));
    },
  });
  await source.listSessions();
  await source.listSessions();
  await source.listSessions();
  assert.equal(reads, 1, 'creation time is immutable, so one read per session id is enough');
});

test('subagent runs are not controller sessions', async () => {
  // The reported defect: a real profile listed 219 rows, nearly all of them subagent logs
  // the user had never seen in DSH's own UI, every one of them labelled "Untitled DSH
  // task". DSH marks them (`origin: 'subagent'`, `parentSessionId`), so they are filtered
  // at the single point both readers share.
  const source = createSessionControllerSource({
    sessionController: makeController([
      { sessionId: 'task-1', updatedAt: 3, running: false },
      { sessionId: 'sub-1', updatedAt: 2, running: false, origin: 'subagent' },
      { sessionId: 'sub-2', updatedAt: 1, running: true, parentSessionId: 'task-1' },
    ]),
    subscribe: makeSubscribe(),
    readTitles: async (ids) => new Map(ids.map((id) => [id, 'a title'])),
  });

  assert.deepEqual((await source.listSessions()).map((row) => row.id), ['task-1']);
  // The cheap read is the same listing, so it inherits the filter — and a subagent's turn
  // must not light the controller's running badge either.
  assert.deepEqual((await source.listSessionStates()).map((row) => row.id), ['task-1']);

  // And the push side: a subagent appearing is not "a session was created".
  const subscribe = makeSubscribe();
  const events = [];
  const pushed = createSessionControllerSource({ sessionController: makeController([]), subscribe });
  const dispose = pushed.onEvent((item) => events.push(item));
  subscribe.emit('api-session/added', { sessionId: 'sub-9', origin: 'subagent', running: true });
  subscribe.emit('api-session/added', { sessionId: 'sub-10', parentSessionId: 'task-1' });
  subscribe.emit('api-session/added', { sessionId: 'task-9', running: false });
  assert.deepEqual(events.map((item) => item.sessionId), ['task-9']);
  dispose();
});

test('a listing folds one bounded batch of titles and warms the rest behind it', async () => {
  // The latency defect behind "电脑暂时没有回应请求": a title is a log-backed fold (~50ms),
  // and the phone's responsiveness probe is this very call. Measured on a real profile:
  // 219 titles inside one read = ~12s, against a 15s handset timeout.
  const items = Array.from({ length: 100 }, (_, index) => ({ sessionId: `s${index}`, updatedAt: 100 - index, running: false }));
  const batches = [];
  // A gate, so the read's own fold can be observed before the background warm-up moves:
  // without it the whole sequence resolves in microtasks and the assertion races it.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const source = createSessionControllerSource({
    sessionController: makeController(items),
    subscribe: makeSubscribe(),
    titleRefreshBudget: 8,
    readTitles: async (ids) => {
      batches.push(ids.length);
      await gate;
      return new Map(ids.map((id) => [id, `title ${id}`]));
    },
  });

  const pending = source.listSessions();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(batches, [8], 'the read folded exactly one bounded batch, then stopped to answer');
  release();
  const rows = await pending;

  // The answer carries the newest batch — the rows the controller shows first — and every
  // visible session is still in the list.
  assert.equal(rows.filter((row) => row.title !== undefined).length, 8);
  assert.equal(rows.length, 100);
  assert.equal(rows[0].title, 'title s0', 'the newest rows are the ones that get a title first');

  // The rest arrive behind the answer, and the next read folds nothing at all.
  await source.titlesSettled();
  assert.equal(source.cachedTitleCount(), 100);
  const second = await source.listSessions();
  // The invariant, not a literal: no batch ever exceeded the budget, and every title was
  // folded exactly once (one batch for the read, the rest behind it).
  assert.ok(batches.every((size) => size <= 8), `no batch exceeds the budget: ${batches.join(',')}`);
  assert.equal(batches.reduce((sum, size) => sum + size, 0), 100, 'every title was folded exactly once');
  assert.equal(second.filter((row) => row.title !== undefined).length, 100, 'the second read serves every cached title');
  await source.listSessions();
  assert.equal(batches.length, 13, 'a warm cache folds nothing');
});

test('one warm-up at a time, and a rename drops its cached title', async () => {
  const items = Array.from({ length: 40 }, (_, index) => ({ sessionId: `s${index}`, updatedAt: 40 - index, running: false }));
  let reads = 0;
  const source = createSessionControllerSource({
    sessionController: makeController(items),
    subscribe: makeSubscribe(),
    titleRefreshBudget: 4,
    readTitles: async (ids) => {
      reads += 1;
      return new Map(ids.map((id) => [id, `t-${id}`]));
    },
  });

  // Two reads in flight must not start two warm-ups over the same ids.
  await Promise.all([source.listSessions(), source.listSessions()]);
  await source.titlesSettled();
  const afterWarm = reads;
  assert.ok(afterWarm <= 1 + 40 / 4, `warm-up batches stay bounded (${afterWarm} reads)`);

  // A rename must not wait out the TTL: the controller reads back the row it just wrote.
  source.invalidateTitle('s0');
  const rows = await source.listSessions();
  assert.equal(rows[0].title, 't-s0', 'the renamed session is re-folded on the next read');
});

test('survives a list answer with no items', async () => {
  const source = createSessionControllerSource({ sessionController: makeController(undefined), subscribe: makeSubscribe() });
  assert.deepEqual(await source.listSessions(), []);
});

test('attaches titles when a reader is supplied', async () => {
  const source = createSessionControllerSource({
    sessionController: makeController([{ sessionId: 's1', updatedAt: 1, running: false }]),
    subscribe: makeSubscribe(),
    readTitles: async (ids) => new Map(ids.map((id) => [id, 'Fix the relay'])),
  });
  const [row] = await source.listSessions();
  assert.equal(row.title, 'Fix the relay');
});

test('a failing title reader costs the title, not the list', async () => {
  const source = createSessionControllerSource({
    sessionController: makeController([{ sessionId: 's1', updatedAt: 1, running: false }]),
    subscribe: makeSubscribe(),
    readTitles: async () => {
      throw new Error('title backend down');
    },
  });
  const rows = await source.listSessions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, undefined);
});

test('translates every host lifecycle event into an activity item', () => {
  const subscribe = makeSubscribe();
  const source = createSessionControllerSource({ sessionController: makeController([]), subscribe });
  const seen = [];
  const dispose = source.onEvent((item) => seen.push(item));

  subscribe.emit('api-session/added', { sessionId: 's1', running: true });
  subscribe.emit('api-session/added', { sessionId: 's2', running: false });
  subscribe.emit('api-session/status', 's1', false);
  subscribe.emit('api-session/activity', 's1', 123);
  subscribe.emit('api-session/error', 's2', 'boom');
  subscribe.emit('api-session/removed', 's1');

  assert.deepEqual(seen, [
    { kind: 'session-added', sessionId: 's1', sequence: 0, phase: 'running' },
    { kind: 'session-added', sessionId: 's2', sequence: 0, phase: 'idle' },
    { kind: 'session-status', sessionId: 's1', sequence: 0, phase: 'idle' },
    { kind: 'session-status', sessionId: 's1', sequence: 0, phase: 'active' },
    { kind: 'session-status', sessionId: 's2', sequence: 0, phase: 'error' },
    { kind: 'session-removed', sessionId: 's1', sequence: 0, phase: 'idle' },
  ]);

  dispose();
  for (const name of ['api-session/added', 'api-session/removed', 'api-session/status', 'api-session/activity', 'api-session/error']) {
    assert.equal(subscribe.count(name), 0, `${name} must be released on dispose`);
  }
});

test('turns a listener failure into a stream failure instead of an escape', () => {
  const subscribe = makeSubscribe();
  const source = createSessionControllerSource({ sessionController: makeController([]), subscribe });
  const seen = [];
  source.onEvent((item) => {
    if (item.kind === 'session-added') throw new Error('sink exploded');
    seen.push(item);
  });
  subscribe.emit('api-session/added', { sessionId: 's1', running: true });
  assert.deepEqual(seen, [{ kind: 'stream-failed' }]);
});

test('a disposer that throws does not strand the others', () => {
  const released = [];
  const subscribe = (name, listener) => {
    void listener;
    return () => {
      released.push(name);
      if (name === 'api-session/added') throw new Error('disposer exploded');
    };
  };
  const source = createSessionControllerSource({ sessionController: makeController([]), subscribe });
  const dispose = source.onEvent(() => {});
  assert.doesNotThrow(() => dispose(), 'one bad disposer must not escape');
  assert.deepEqual(released, [
    'api-session/added',
    'api-session/removed',
    'api-session/status',
    'api-session/activity',
    'api-session/error',
  ], 'every subscription is still released after the throwing one');
});

test('with no event hub the source still lists and disposes cleanly', async () => {
  const source = createSessionControllerSource({ sessionController: makeController([{ sessionId: 's1', updatedAt: 1, running: false }]) });
  assert.equal(typeof source.onEvent(() => {}), 'function');
  assert.equal((await source.listSessions()).length, 1);
});
