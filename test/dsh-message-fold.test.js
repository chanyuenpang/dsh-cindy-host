import test from 'node:test';
import assert from 'node:assert/strict';
import { isHarnessNotice, promptRpcIdOf, foldSessionEvent, pageRows, createMessageCounter, createMessageReader, entryForTodoWrite, NEWEST_WINDOW_ROWS, NEWEST_WINDOW_TEXT_BYTES } from '../src/dsh-message-fold.js';
import { toCindyMessages } from '../src/cindy-message-row.js';

const textOf = (row) => typeof row.content === 'string' ? row.content : row.content?.text;

test('names the controller id of a prompt that just became durable', () => {
  // This is the moment DSH's inbox drops the entry, so it is the moment the
  // controller's optimistic 队列中 row has to be retired.
  assert.equal(promptRpcIdOf({ type: 'user/message', data: { source: { kind: 'user', rpcId: 'c1' } } }), 'c1');
  // A delivery-shaped event carries the source at the top level.
  assert.equal(promptRpcIdOf({ source: { kind: 'user', rpcId: 'c2' } }), 'c2');
});

test('says nothing for events that name no submitted prompt', () => {
  for (const event of [
    undefined,
    null,
    { type: 'assistant/message', data: { source: { kind: 'assistant' } } },
    { data: { source: { kind: 'user' } } },
    { data: { source: { kind: 'user', rpcId: '' } } },
    { data: {} },
  ]) {
    assert.equal(promptRpcIdOf(event), null);
  }
});

test('folding an event still yields rows, so one handler serves both jobs', () => {
  // The retire path must not change what the live stream renders.
  assert.deepEqual(foldSessionEvent(null, { sessionId: 's1' }), []);
});

test('a page never splits one message across two pages', () => {
  // One message's rows share a timestamp, and the controller's cursor is exactly
  // that timestamp. Cutting the group means the next page filters with a strict
  // `< cursor` and drops the rest — those rows become unreachable.
  const AT = '2026-01-01T00:00:00.000Z';
  const older = '2025-12-31T00:00:00.000Z';
  // `toCindyMessages` takes the transcript in log order (oldest first) and
  // answers newest first, which is the controller's paging order.
  const rows = toCindyMessages([
    { message: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'q' }] }, createdAt: older },
    {
      message: {
        id: 'm2',
        role: 'assistant',
        content: [{ type: 'reasoning', text: 't' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
      },
      createdAt: AT,
    },
  ], { sessionId: 's1' });
  assert.deepEqual(rows.map((row) => row.createdAt), [AT, AT, AT, older]);

  // A limit of 1 would otherwise return a single row of the three sharing AT.
  const page = pageRows(rows, { limit: 1 });
  assert.equal(page.length, 3, 'the whole group travels together');
  assert.deepEqual(page.map((row) => row.createdAt), [AT, AT, AT]);

  // The next page resumes strictly after the group, with nothing lost.
  const next = pageRows(rows, { limit: 10, before: page[page.length - 1].createdAt });
  assert.deepEqual(next.map((row) => row.createdAt), [older]);

  // A whole group is never re-served.
  const again = pageRows(rows, { limit: 10, before: AT });
  assert.deepEqual(again.map((row) => row.createdAt), [older]);
});

test('pages back from a row id, which is the cursor the controller really sends', () => {
  // `oldestMessageCursor(loaded)` returns the oldest loaded row's **id**
  // (`apps/mobile/src/session/messagePaging.ts`), and `mergeEarlierMessages`
  // only merges the answer when the controller can still find that exact id in
  // its window. Treating the cursor as a timestamp meant every "load earlier"
  // returned the newest page again — the user's report was that paging never
  // produced anything new.
  const rows = toCindyMessages([
    { message: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'one' }] }, createdAt: '2026-01-01T00:00:00.000Z' },
    { message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'two' }] }, createdAt: '2026-01-01T00:00:01.000Z' },
    { message: { id: 'm3', role: 'user', content: [{ type: 'text', text: 'three' }] }, createdAt: '2026-01-01T00:00:02.000Z' },
    { message: { id: 'm4', role: 'assistant', content: [{ type: 'text', text: 'four' }] }, createdAt: '2026-01-01T00:00:03.000Z' },
  ], { sessionId: 's1' });
  // Newest first, which is the controller's paging order.
  assert.deepEqual(rows.map(textOf), ['four', 'three', 'two', 'one']);

  const first = pageRows(rows, { limit: 2 });
  assert.deepEqual(first.map(textOf), ['four', 'three']);

  const anchor = first[first.length - 1].id;
  const second = pageRows(rows, { limit: 2, before: anchor });
  assert.deepEqual(second.map(textOf), ['two', 'one'], 'strictly older than the named row');
  assert.equal(second.some((row) => first.some((seen) => seen.id === row.id)), false, 'a page is never re-served');

  const third = pageRows(rows, { limit: 2, before: second[second.length - 1].id });
  assert.deepEqual(third, [], 'the transcript start is an empty page, not the newest rows again');

  // An id this Host cannot place must not degrade into "the newest page again":
  // that is exactly the failure the user saw, and it silently re-serves rows.
  const unknown = pageRows(rows, { limit: 2, before: 's1:never-seen:0' });
  assert.deepEqual(unknown.map(textOf), ['two', 'one'], 'the oldest page we have');
});

test('counts rows the same way the transcript read does', async () => {
  // The controller compares this total against the rows it has loaded
  // (`hasOlderMessagesByServerCount` answers false for an unknown total), and it
  // compares **rows**, not events — so the count has to fold identically.
  const count = createMessageCounter({ reader: createMessageReader({ readSessionLog: async () => ({ events: [] }) }) });
  assert.equal(await count('s1'), 0, 'an empty transcript is zero rows, not an error');

  // One row per content block: the unit both sides count.
  const rows = toCindyMessages([
    { message: { id: 'm2', role: 'user', content: [{ type: 'text', text: 'q' }] }, createdAt: '2026-01-01T00:00:00.000Z' },
    {
      message: {
        id: 'm1',
        role: 'assistant',
        content: [{ type: 'reasoning', text: 't' }, { type: 'text', text: 'a' }],
      },
      createdAt: '2026-01-01T00:00:01.000Z',
    },
  ], { sessionId: 's1' });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(textOf), ['t', 'a', 'q']);
});

test('the transcript is folded once, then served from the live stream', async () => {
  // Paging used to re-read and re-fold the whole log per request: 216 ms warm and
  // 2.3 s during a live turn on the 17 MB conversation reported as
  // 加载更早消息…每次只加载一点点, because the controller's page is 20 rows.
  let reads = 0;
  const events = [
    {
      type: 'user/message',
      seq: 7,
      time: 1_000,
      surfaceOp: 'append',
      // `user/message` derives to `event.data` itself; `assistant/message` derives to
      // `event.data.message`. Both shapes are exercised here.
      data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'one' }] },
    },
  ];
  const reader = createMessageReader({
    readSessionLog: async () => {
      reads += 1;
      return { events };
    },
  });
  assert.equal(await reader.count('s1'), 1);
  const first = await reader('s1', { limit: 20 });
  assert.equal(reads, 1, 'the count seeded the cache instead of folding a second time');
  assert.deepEqual(first.map(textOf), ['one']);

  // A second page for the same session must not touch the log again.
  await reader('s1', { limit: 20, before: first[0].id });
  assert.equal(reads, 1);

  // A live event extends the cached transcript, newest first, with no re-read.
  const appended = reader.noteEvent('s1', {
    type: 'assistant/message',
    seq: 8,
    time: 2_000,
    surfaceOp: 'append',
    data: { message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'two' }] } },
  });
  assert.equal(appended, true);
  assert.equal(reads, 1);
  const page = await reader('s1', { limit: 20 });
  assert.deepEqual(page.map(textOf), ['two', 'one'], 'newest first');
  assert.equal(await reader.count('s1'), 2, 'the count sees the appended row');

  // A gap in the stream, a repeated seq (rewind), or an unknown seq drops the cache:
  // one extra full read is cheap, a transcript with a hole is not.
  assert.equal(reader.noteEvent('s1', {
    type: 'assistant/message',
    seq: 12,
    time: 3_000,
    surfaceOp: 'append',
    data: { message: { id: 'm3', role: 'assistant', content: [{ type: 'text', text: 'gap' }] } },
  }), false);
  assert.equal(reader.stats().sessions, 0, 'the stale transcript was dropped, not patched');
  await reader('s1', { limit: 20 });
  assert.equal(reads, 2, 'the drop costs exactly one re-seed');
});

function deferredSeed() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function seedSnapshot(text, seq = 1) {
  return { events: [{ type: 'assistant/message', seq, time: seq * 1_000, surfaceOp: 'append',
    data: { message: { id: `m${seq}`, role: 'assistant', content: [{ type: 'text', text }] } } }] };
}

test('concurrent count, whole view and page share one transcript seed', async () => {
  const seed = deferredSeed();
  let reads = 0;
  const reader = createMessageReader({ readSessionLog: () => { reads++; return seed.promise; } });
  const count = reader.count('s1');
  const whole = reader.all('s1');
  const page = reader('s1', { limit: 20 });
  await Promise.resolve();
  assert.equal(reads, 1, 'three read surfaces share the same full log replay');
  assert.equal(reader.stats().seeding, 1);
  seed.resolve(seedSnapshot('shared'));
  const [total, allRows, pageRows] = await Promise.all([count, whole, page]);
  assert.equal(total, 1);
  assert.deepEqual(allRows.map(textOf), ['shared']);
  assert.deepEqual(pageRows, allRows);
  assert.deepEqual(reader.stats(), { sessions: 1, rows: 1, seeding: 0 });
  await reader.all('s1');
  assert.equal(reads, 1, 'settled rows remain cached, not a settled promise');
  assert.equal(reader.invalidate('s1'), true);
  await reader.all('s1');
  assert.equal(reads, 2, 'invalidation after settlement really re-reads');
});

test('activity evidence uses the folded rows and first durable user timestamp', async () => {
  let reads = 0;
  const reader = createMessageReader({ readSessionLog: async () => {
    reads += 1;
    return { events: [
      { type: 'user/message', seq: 1, time: 1_000, surfaceOp: 'append', data: {
        id: 'u1', role: 'user', source: { kind: 'user', rpcId: 'c1' }, content: [{ type: 'text', text: 'hello' }],
      } },
      { type: 'assistant/message', seq: 2, time: 2_000, surfaceOp: 'append', data: {
        message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'world' }] },
      } },
    ] };
  } });
  assert.deepEqual(await reader.activity('s1'), {
    messageCount: 2,
    userSendAt: new Date(1_000).toISOString(),
  });
  assert.equal(await reader.count('s1'), 2);
  assert.equal(reads, 1, 'activity and count reuse one transcript fold');
});

test('seed singleflight is per session, not a global read lock', async () => {
  const first = deferredSeed();
  const second = deferredSeed();
  const reads = [];
  const reader = createMessageReader({ readSessionLog: (id) => {
    reads.push(id);
    return id === 's1' ? first.promise : second.promise;
  } });
  const pending = reader.all('s1');
  const independent = reader.all('s2');
  await Promise.resolve();
  assert.deepEqual(reads, ['s1', 's2']);
  second.resolve(seedSnapshot('second'));
  assert.equal(textOf((await independent)[0]), 'second', 'another session need not wait');
  assert.equal(reader.stats().seeding, 1);
  first.resolve(seedSnapshot('first'));
  await pending;
  assert.equal(reader.stats().seeding, 0);
});

test('a rejected shared seed fails all readers and releases the flight for retry', async () => {
  const seed = deferredSeed();
  let reads = 0;
  const reader = createMessageReader({ readSessionLog: () => {
    reads++;
    return reads === 1 ? seed.promise : seedSnapshot('recovered');
  } });
  const results = Promise.allSettled([reader.count('s1'), reader.all('s1'), reader('s1')]);
  await Promise.resolve();
  assert.equal(reads, 1);
  const failure = new Error('unknown session');
  seed.reject(failure);
  for (const result of await results) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, failure, 'NOT_FOUND does not become an empty success');
  }
  assert.deepEqual(reader.stats(), { sessions: 0, rows: 0, seeding: 0 });
  const [total, whole] = await Promise.all([reader.count('s1'), reader.all('s1')]);
  assert.equal(total, 1);
  assert.equal(textOf(whole[0]), 'recovered');
  assert.equal(reads, 2, 'retry also shares one flight');
});

test('a live event during a shared seed prevents caching without duplicating the read', async () => {
  const seed = deferredSeed();
  let reads = 0;
  const reader = createMessageReader({ readSessionLog: () => {
    reads++;
    return reads === 1 ? seed.promise : seedSnapshot('after event', 2);
  } });
  const whole = reader.all('s1');
  await Promise.resolve();
  assert.equal(reader.noteEvent('s1', seedSnapshot('after event', 2).events[0]), false);
  const count = reader.count('s1');
  const page = reader('s1');
  seed.resolve(seedSnapshot('before event'));
  await Promise.all([whole, count, page]);
  assert.equal(reads, 1);
  assert.deepEqual(reader.stats(), { sessions: 0, rows: 0, seeding: 0 }, 'raced snapshot is not reused');
  const [fresh, total] = await Promise.all([reader.all('s1'), reader.count('s1')]);
  assert.equal(textOf(fresh[0]), 'after event');
  assert.equal(total, 1);
  assert.equal(reads, 2);
});

test('explicit invalidation during a seed prevents caching even without a replacement read', async () => {
  const seed = deferredSeed();
  let reads = 0;
  const reader = createMessageReader({ readSessionLog: () => {
    reads++;
    return reads === 1 ? seed.promise : seedSnapshot('fresh');
  } });
  const old = reader.all('s1');
  await Promise.resolve();
  assert.equal(reader.invalidate('s1'), false, 'return value still describes cached rows removed');
  seed.resolve(seedSnapshot('old'));
  await old;
  assert.deepEqual(reader.stats(), { sessions: 0, rows: 0, seeding: 0 });
  assert.equal(textOf((await reader.all('s1'))[0]), 'fresh');
  assert.equal(reads, 2);
});

test('an old seed completion cannot clear a replacement seed live-event invalidation', async () => {
  const oldSeed = deferredSeed();
  const newSeed = deferredSeed();
  let reads = 0;
  const reader = createMessageReader({ readSessionLog: () => {
    reads++;
    return reads === 1 ? oldSeed.promise : reads === 2 ? newSeed.promise : seedSnapshot('current', 3);
  } });
  const old = reader.all('s1');
  await Promise.resolve();
  reader.invalidate('s1');
  const replacement = reader.all('s1');
  await Promise.resolve();
  reader.noteEvent('s1', seedSnapshot('current', 3).events[0]);
  oldSeed.resolve(seedSnapshot('old'));
  await old;
  assert.equal(reader.stats().seeding, 1);
  newSeed.resolve(seedSnapshot('raced', 2));
  await replacement;
  assert.deepEqual(reader.stats(), { sessions: 0, rows: 0, seeding: 0 }, 'new flight keeps its own dirty marker');
  assert.equal(textOf((await reader.all('s1'))[0]), 'current');
  assert.equal(reads, 3);
});

for (const oldFails of [false, true]) {
  for (const oldFinishesFirst of [false, true]) {
    test(`invalidated seed cannot own a newer flight (old fails=${oldFails}, finishes first=${oldFinishesFirst})`, async () => {
      const oldSeed = deferredSeed();
      const newSeed = deferredSeed();
      let reads = 0;
      const reader = createMessageReader({ readSessionLog: () => {
        reads++;
        return reads === 1 ? oldSeed.promise : newSeed.promise;
      } });
      const old = reader.all('s1');
      const oldResult = Promise.allSettled([old]);
      await Promise.resolve();
      reader.invalidate('s1');
      const fresh = reader.all('s1');
      await Promise.resolve();
      assert.equal(reads, 2, 'post-invalidation reader must not join the old snapshot');
      const finishOld = () => oldFails
        ? oldSeed.reject(new Error('old read failed'))
        : oldSeed.resolve(seedSnapshot('old'));
      if (oldFinishesFirst) {
        finishOld();
        await oldResult;
        assert.deepEqual(reader.stats(), { sessions: 0, rows: 0, seeding: 1 }, 'old finally cannot delete new flight');
        const joined = reader.count('s1');
        await Promise.resolve();
        assert.equal(reads, 2, 'later caller still joins the newer flight');
        newSeed.resolve(seedSnapshot('fresh', 2));
        assert.equal(await joined, 1);
      } else {
        newSeed.resolve(seedSnapshot('fresh', 2));
        await fresh;
        assert.equal(reader.noteEvent('s1', seedSnapshot('appended', 3).events[0]), true);
        finishOld();
      }
      await fresh;
      const [settled] = await oldResult;
      assert.equal(settled.status, oldFails ? 'rejected' : 'fulfilled');
      const expected = oldFinishesFirst ? ['fresh'] : ['appended', 'fresh'];
      assert.deepEqual((await reader.all('s1')).map(textOf), expected,
        'old completion must not overwrite fresh rows or live append');
      assert.equal(reads, 2);
      assert.equal(reader.stats().seeding, 0);
    });
  }
}

test('a failed transcript seed is retried and successful replay is cached', async () => {
  let reads = 0;
  const reader = createMessageReader({ readSessionLog: async () => {
    if (++reads === 1) throw new Error('transcript is not readable yet');
    return { events: [{ type: 'assistant/message', seq: 1, time: 1_000, surfaceOp: 'append',
      data: { message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'recovered' }] } } }] };
  } });
  await assert.rejects(reader.all('new-session'), /not readable yet/);
  assert.deepEqual(reader.stats(), { sessions: 0, rows: 0, seeding: 0 }, 'failure is not an authoritative empty transcript');
  const recovered = await reader.all('new-session');
  assert.deepEqual(recovered.map(textOf), ['recovered']);
  assert.equal(await reader.count('new-session'), 1);
  assert.equal(reads, 2, 'only the successful replay is reused');
});

test('unknown transcript reads keep rejecting across every cached read surface', async () => {
  let reads = 0;
  const reader = createMessageReader({ readSessionLog: async () => {
    reads++;
    throw new Error('unknown session');
  } });
  await assert.rejects(reader.all('missing'), /unknown session/);
  await assert.rejects(reader('missing', { limit: 20 }), /unknown session/);
  await assert.rejects(reader.count('missing'), /unknown session/);
  assert.equal(reads, 3, 'NOT_FOUND must not become a successful empty read on retry');
  assert.deepEqual(reader.stats(), { sessions: 0, rows: 0, seeding: 0 });
});

test('a successfully read empty transcript is still a cacheable known blank', async () => {
  let reads = 0;
  const reader = createMessageReader({ readSessionLog: async () => { reads++; return { events: [] }; } });
  assert.deepEqual(await reader.all('known-blank'), []);
  assert.deepEqual(await reader('known-blank', { limit: 20 }), []);
  assert.equal(await reader.count('known-blank'), 0);
  assert.equal(reads, 1, 'empty and failed are distinct seed outcomes');
  assert.deepEqual(reader.stats(), { sessions: 1, rows: 0, seeding: 0 });
});

test('an event for a session that was never read is ignored, not cached half-way', async () => {
  let reads = 0;
  const reader = createMessageReader({ readSessionLog: async () => { reads += 1; return { events: [] }; } });
  assert.equal(reader.noteEvent('s1', { type: 'assistant/message', seq: 1, time: 1, surfaceOp: 'append', data: { message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'x' }] } } }), false);
  assert.equal(reader.stats().sessions, 0);
  await reader('s1', { limit: 20 });
  assert.equal(reads, 1);
});

test('a todo snapshot becomes the TodoWrite row the phone draws its plan card from', () => {
  // DSH's todo tool declares `todo/write` as log-only state, so the desk renders it from a
  // projection — and the phone only renders a plan card from a `TodoWrite` **tool row**.
  // A plan that reached DSH only as `todo/write` (which is how the claw workflow mirrors
  // its plan onto the native dock) was therefore invisible on the handset.
  const entry = entryForTodoWrite({
    type: 'todo/write',
    seq: 42,
    time: 1_700_000_000_000,
    data: { todos: [{ content: '第一步', status: 'completed' }, { content: '第二步', status: 'in_progress' }] },
  });
  assert.notEqual(entry, null);
  assert.equal(entry.message.role, 'assistant');
  assert.deepEqual(entry.message.content[0], {
    type: 'tool-call',
    id: 'todo-42',
    name: 'todo_write',
    arguments: JSON.stringify({ todos: [{ content: '第一步', status: 'completed' }, { content: '第二步', status: 'in_progress' }] }),
  });
  assert.equal(entry.createdAt, new Date(1_700_000_000_000).toISOString(), 'the card sits where the write happened');

  // The name mapping is what selects the card on the phone; the input keeps DSH's items.
  const rows = toCindyMessages([entry], { sessionId: 's1' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'tool_use');
  assert.equal(rows[0].content.toolName, 'TodoWrite');
  assert.deepEqual(rows[0].content.input, { todos: [{ content: '第一步', status: 'completed' }, { content: '第二步', status: 'in_progress' }] });

  // An empty snapshot is how the adapter clears the dock: no card, not an empty card.
  assert.equal(entryForTodoWrite({ type: 'todo/write', seq: 43, time: 1, data: { todos: [] } }), null);
  assert.equal(entryForTodoWrite({ type: 'todo/write', seq: 44, time: 1, data: {} }), null);
  // Anything that is not a snapshot is left to the ordinary fold.
  assert.equal(entryForTodoWrite({ type: 'assistant/message', seq: 45, time: 1, surfaceOp: 'append', data: {} }), null);
  assert.equal(entryForTodoWrite(null), null);
});

test('a durable todo snapshot and a live one produce the same row', async () => {
  const snapshot = {
    type: 'todo/write',
    seq: 5,
    time: 1_700_000_000_000,
    data: { todos: [{ content: 'ship it', status: 'pending' }] },
  };
  // The durable read folds it out of the log.
  const durable = createMessageReader({ readSessionLog: async () => ({ events: [snapshot] }) });
  const fromLog = await durable('s1', { limit: 20 });
  assert.equal(fromLog.length, 1);
  assert.equal(fromLog[0].content.toolName, 'TodoWrite');

  // The live path appends the same row, from the same event. The cache has to be seeded at
  // the seq just before the snapshot: a cache that cannot prove contiguity drops itself
  // rather than appending to a guess.
  const live = createMessageReader({ readSessionLog: async () => ({ events: [{ type: 'step/start', seq: 4, time: 1_699_999_999_000, data: {} }] }) });
  await live('s1', { limit: 20 });
  assert.equal(live.noteEvent('s1', snapshot), true);
  const afterEvent = await live('s1', { limit: 20 });
  assert.deepEqual(
    afterEvent.map((row) => ({ id: row.id, tool: row.content.toolName, input: row.content.input })),
    fromLog.map((row) => ({ id: row.id, tool: row.content.toolName, input: row.content.input })),
  );
});

test('the newest page is filled to the controller window, and older pages are not', async () => {
  // The controller opens a session with `limit: 20` and its own cache window is 80
  // rows (`MESSAGE_PAGE_SIZE`). A single agent turn is often 20 rows here, so a
  // 20-row newest page showed 只显示最后一个回复 on a five-turn conversation, and even
  // the 80-row window missed the user's first message on an 81-row transcript.
  const events = Array.from({ length: 250 }, (_, index) => ({
    type: 'assistant/message',
    seq: index + 1,
    time: 1_000 + index * 1_000,
    surfaceOp: 'append',
    data: { message: { id: `m${index}`, role: 'assistant', content: [{ type: 'text', text: `row-${index}` }] } },
  }));
  const reader = createMessageReader({ readSessionLog: async () => ({ events }) });
  const newest = await reader('s1', { limit: 20 });
  assert.equal(newest.length, NEWEST_WINDOW_ROWS, 'the newest page is filled to the row cap');
  assert.equal(textOf(newest[0]), 'row-249', 'and it is still the newest rows');

  const older = await reader('s1', { limit: 20, before: newest[newest.length - 1].id });
  assert.equal(older.length, 20, 'a cursor page is answered with exactly the asked limit');
});

test('a text-heavy newest page is cut to the byte budget, at a message boundary', async () => {
  // Rows are one content block here, so a page can be long in bytes while being short
  // in turns. The controller's own recorded worst case is ~18 s per 200 KB, and this
  // channel is given 30 s — so the newest page carries a text budget, not just a row
  // cap. What is cut stays reachable: the page is still far longer than the twenty
  // rows the controller asked for, which is what keeps 加载更早 lit.
  const events = Array.from({ length: 20 }, (_, index) => ({
    type: 'assistant/message',
    seq: index + 1,
    time: 1_000 + index * 1_000,
    surfaceOp: 'append',
    data: {
      message: {
        id: `m${index}`,
        role: 'assistant',
        content: [{ type: 'text', text: `row-${index}-` + 'x'.repeat(48 * 1024) }],
      },
    },
  }));
  const reader = createMessageReader({ readSessionLog: async () => ({ events }) });
  const page = await reader('s1', { limit: 20 });
  const bytes = Buffer.byteLength(JSON.stringify(page), 'utf8');
  assert.ok(bytes <= NEWEST_WINDOW_TEXT_BYTES, `page carried ${bytes} bytes`);
  assert.ok(page.length < 20, 'the byte budget bound the page before the row cap did');
  assert.equal(textOf(page[0]).startsWith('row-19-'), true, 'the newest row is still first');

  // The rows the budget left behind are exactly what the next cursor page serves, so
  // none of them became unreachable.
  const rest = await reader('s1', { limit: 20, before: page[page.length - 1].id });
  assert.equal(rest.length, 20 - page.length);
  assert.equal(textOf(rest[0]).startsWith(`row-${19 - page.length}-`), true);
});


test('a harness notice is not conversation, and a person still is', () => {
  // Reported from the phone: 「background job pwsh-1 (pwsh: cd G:\Projects\DSH-cindy-host\node
  // tools/acceptance.mjs …) finished [status: completed, exit code: 0]」 arrived as a **user
  // bubble**. It is `tool-jobs` bookkeeping (`source.kind === 'plugin'`), and DSH's own inbox
  // splice can even steer the same text into a running turn, so this Host stopped projecting it.
  // Hidden, not dropped: the caller counts every one (see the runtime's suppressedNotices).
  const notice = { type: 'user/message', seq: 2, time: 1, data: { content: [{ type: 'text', text: 'background job pwsh-1 finished' }], source: { kind: 'plugin', plugin: 'tool-jobs', form: 'notice' } } };
  assert.equal(isHarnessNotice(notice), true, 'harness bookkeeping is hidden');
  assert.deepEqual(foldSessionEvent(notice, { sessionId: 's1' }), [], 'and renders no row at all');

  // Everything else keeps its row — a person's message above all.
  const mine = { type: 'user/message', seq: 3, time: 2, data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user', rpcId: 'c1' } } };
  assert.equal(isHarnessNotice(mine), false);
  for (const other of [null, undefined, {}, { type: 'assistant/message', data: { source: { kind: 'assistant' } } }]) {
    assert.equal(isHarnessNotice(other), false, `not a notice: ${JSON.stringify(other)}`);
  }
});
