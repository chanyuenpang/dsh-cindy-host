/**
 * `local-db:messages:view` — the work-grouped window whose whole point is that the phone
 * can trust it across re-entries.
 *
 * The client's rules that decide these assertions (`@cindy/maker-shared/message-window`
 * and `apps/mobile/src/session/historyViewController.ts`):
 *  - a page's `items` are **chronological**, and `nextCursor` is the **oldest** id in it;
 *  - `hasMore` is what lights "load older", so an empty or dishonest value loses history;
 *  - an error the client recognises as "unavailable" (`UNSUPPORTED_CAPABILITY`,
 *    `CHANNEL_NOT_ALLOWED`) is **permanent** — its `refresh()` returns immediately and only
 *    `reset()` clears it — so this Host reserves those codes for "no capability at all" and
 *    must never answer one for a property of a single session;
 *  - **prose is not collapsible**: user prompts and assistant answers are top-level
 *    `messages` items, and only the activity between them folds into `work` items.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_PAGE_ITEMS,
  HISTORY_VIEW_VERSION,
  WORK_ITEM_MAX_ROWS,
  createHistoryViewController,
  firstIdOf,
  groupHistoryItems,
} from '../src/host-history-view.js';

/** One row in the shape this Host serves (newest first is the reader's order). */
function row(id, role, seconds, extra = {}) {
  return {
    id: `s1:${id}:0`,
    clientId: `s1:${id}:0`,
    sessionId: 's1',
    role,
    toolUseId: null,
    agentMeta: null,
    // Real rows carry a real time; a fixture that invented `T00:00:240Z` would make every
    // ordering assertion compare NaN.
    createdAt: new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString(),
    content: { text: id },
    ...extra,
  };
}

/** One turn: prompt, three activity rows, answer. */
function turnRows(turn, clock) {
  return [
    row(`u${turn}`, 'user', clock),
    row(`t${turn}`, 'thinking', clock + 1),
    row(`c${turn}`, 'tool_use', clock + 2, { toolUseId: `call-${turn}` }),
    row(`r${turn}`, 'tool_result', clock + 3, { toolUseId: `call-${turn}` }),
    row(`a${turn}`, 'assistant', clock + 4),
  ];
}

/** A whole transcript of `turns` turns, in the reader's order (newest first). */
function transcript(turns, startAt = 0) {
  const rows = [];
  let clock = startAt;
  for (let turn = 0; turn < turns; turn += 1) {
    rows.push(...turnRows(turn, clock));
    clock += 10;
  }
  return rows.reverse();
}

function controller(rows, options = {}) {
  return createHistoryViewController({ rows: async () => rows, ...options });
}

test('prose stays readable and only the activity in between collapses', () => {
  // The reported failure of the first version: grouping a whole turn as one item produced a
  // page of twenty collapsed items and **no** visible rows — 只显示一号折叠的会话.
  const items = groupHistoryItems(transcript(1), { running: false });
  assert.deepEqual(items.map((item) => item.type), ['messages', 'work', 'messages'], 'prompt, activity, answer');
  assert.equal(items[0].messages[0].role, 'user');
  assert.equal(items[2].messages[0].role, 'assistant');

  const work = items[1];
  assert.equal(work.summary.messageCount, 3, 'thinking + tool call + tool result');
  assert.equal(work.summary.toolCount, 1);
  assert.equal(work.summary.firstMessageId, 's1:t0:0');
  assert.equal(work.summary.lastMessageId, 's1:r0:0');
  assert.equal(work.summary.isStreaming, false);
  assert.match(work.summary.revision, /^s1:r0:0:3:\d+$/);

  // A row older than the conversation (a system card) is readable on its own too.
  const withSystem = [row('sys', 'system', 0), ...transcript(1, 10)].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  assert.deepEqual(
    groupHistoryItems(withSystem, { running: false }).map((item) => item.type),
    ['messages', 'messages', 'work', 'messages'],
  );
});

test('a long activity run is split, so expanding one item is one page', () => {
  // A monster turn (this session had one with 329 rows and 138 tools) must not become one
  // collapsed item you wait minutes for: the run is chopped every WORK_ITEM_MAX_ROWS rows.
  const rows = [row('u0', 'user', 0)];
  for (let index = 0; index < 100; index += 1) {
    rows.push(row(`c${index}`, index % 4 === 3 ? 'tool_result' : 'thinking', index + 1));
  }
  rows.push(row('a0', 'assistant', 200));
  const items = groupHistoryItems(rows.reverse(), { running: false });
  assert.equal(items[0].type, 'messages', 'the prompt is visible');
  assert.equal(items[items.length - 1].type, 'messages', 'and so is the answer');
  const work = items.filter((item) => item.type === 'work');
  assert.equal(work.length, Math.ceil(100 / WORK_ITEM_MAX_ROWS));
  for (const item of work) assert.ok(item.summary.messageCount <= WORK_ITEM_MAX_ROWS, `item carried ${item.summary.messageCount}`);
  assert.equal(work.reduce((sum, item) => sum + item.summary.messageCount, 0), 100, 'every row is still reachable');
});

test('only the live activity run is streaming', () => {
  const answered = transcript(2);
  assert.equal(
    groupHistoryItems(answered, { running: false }).some((item) => item.type === 'work' && item.summary.isStreaming),
    false,
    'a transcript that ends in an answer has nothing live',
  );
  // A session reported as running whose transcript still ends in an answer is between
  // turns: the rows of the new turn have not arrived, so no item claims to be live.
  assert.equal(
    groupHistoryItems(answered, { running: true }).some((item) => item.type === 'work' && item.summary.isStreaming),
    false,
  );

  // With nothing to say about the session, the transcript answers for itself: an open turn
  // ends in activity, not in an answer.
  const openTurn = [...transcript(1, 20), row('t9', 'thinking', 12), row('c9', 'tool_use', 13)].reverse();
  const derived = groupHistoryItems(openTurn);
  assert.equal(derived[derived.length - 1].type, 'work');
  assert.equal(derived[derived.length - 1].summary.isStreaming, true);
  // And a session that says it is running marks that same trailing run.
  const told = groupHistoryItems(openTurn, { running: true });
  assert.equal(told.filter((item) => item.type === 'work' && item.summary.isStreaming).length, 1);
});

test('a plan card is a top-level item, never buried in an activity run', () => {
  // With the view as the phone's primary window, a `TodoWrite` row that arrived inside a
  // collapsed work item was unreachable: 「我没有看到你刚刚这个小任务的 to do」. The client
  // lifts those rows into their own item, so the view must hand them over at the top level.
  const rows = [
    row('u0', 'user', 0),
    row('t0', 'thinking', 1),
    row('todo0', 'tool_use', 2, { content: { toolName: 'TodoWrite', input: { todos: [{ content: '修分组', status: 'in_progress' }] } } }),
    row('c0', 'tool_use', 3, { content: { toolName: 'Bash', input: { command: 'ls' } } }),
    row('a0', 'assistant', 4),
  ];
  const items = groupHistoryItems(rows.reverse(), { running: false });
  assert.deepEqual(items.map((item) => item.type), ['messages', 'work', 'messages', 'work', 'messages']);
  const card = items[2];
  assert.equal(card.messages[0].content.toolName, 'TodoWrite');
  assert.deepEqual(card.messages[0].content.input.todos, [{ content: '修分组', status: 'in_progress' }]);
  // And it sits between the two activity runs rather than inside one.
  const work = items.filter((item) => item.type === 'work');
  assert.deepEqual(work.map((item) => item.summary.firstMessageId), ['s1:t0:0', 's1:c0:0']);
});

test('the live group carries a preview, so a long turn is visibly working', () => {
  // 报「一直在思考中转圈」 while this Host pushed 100+ rows: every one of them was inside a
  // collapsed group, so the phone had a spinner and no evidence of progress. The contract
  // has a field for exactly this — `HistoryWorkSummary.preview` — and the reference fills it
  // for the streaming group.
  const rows = [row('u0', 'user', 0)];
  for (let index = 0; index < 12; index += 1) rows.push(row(`c${index}`, 'thinking', index + 1));
  const open = [...rows].reverse(); // an open turn does not end in an answer
  const items = groupHistoryItems(open);
  const live = items[items.length - 1];
  assert.equal(live.type, 'work');
  assert.equal(live.summary.isStreaming, true);
  assert.notEqual(live.summary.preview, undefined, 'the streaming group is previewable');
  assert.equal(live.summary.preview.key, `preview-${live.summary.key}`);
  assert.equal(live.summary.preview.isStreaming, true);
  assert.equal(live.summary.preview.messageCount, 5, 'the tail, not the whole run');
  assert.equal(live.summary.preview.lastMessageId, live.summary.lastMessageId, 'the preview ends where the group does');
  assert.equal(live.summary.preview.firstMessageId, 's1:c7:0');

  // A finished group has no preview: there is nothing live to show.
  const answered = groupHistoryItems([...rows, row('a0', 'assistant', 99)].reverse(), { running: false });
  const finished = answered.filter((item) => item.type === 'work');
  assert.deepEqual(finished.map((item) => item.summary.preview), [undefined], 'only the streaming group previews');
  // ...and a session reported as running keeps previewing its trailing run.
  const told = groupHistoryItems(open, { running: true });
  assert.equal(told[told.length - 1].summary.preview.messageCount, 5);
});

test('a page is chronological, capped, and its cursor walks back without repeats', async () => {
  const rows = transcript(25); // 75 items, one page holds 20
  const view = controller(rows);
  const first = await view.page('s1');
  assert.equal(first.ok, true);
  assert.equal(first.result.version, 1);
  assert.equal(first.result.items.length, HISTORY_PAGE_ITEMS);
  assert.equal(first.result.hasMore, true);
  assert.equal(first.result.nextCursor, firstIdOf(first.result.items[0]), 'the cursor is the page’s oldest id');
  assert.equal(first.result.items.at(-1).type, 'messages', 'the newest page ends at the newest answer');
  assert.equal(first.result.items.at(-1).messages[0].role, 'assistant');

  // The second page is strictly older: no item key repeats, and it stops right before the
  // first page begins.
  const second = await view.page('s1', first.result.nextCursor);
  assert.equal(second.ok, true);
  const firstKeys = new Set(first.result.items.map((item) => item.key));
  assert.deepEqual(second.result.items.filter((item) => firstKeys.has(item.key)), [], 'no repeats');
  const firstPageOldest = Date.parse(first.result.items[0].summary
    ? new Date(first.result.items[0].summary.startedAtMs).toISOString()
    : first.result.items[0].messages[0].createdAt);
  const secondPageNewest = Math.max(...second.result.items.map((item) => item.summary
    ? item.summary.endedAtMs
    : Date.parse(item.messages[0].createdAt)));
  assert.ok(secondPageNewest <= firstPageOldest, 'the next page stops right before the first page');

  // Walking to the start terminates: the last page reports hasMore=false and no cursor.
  let cursor = second.result.nextCursor;
  let guard = 0;
  let last = second;
  while (last.result.hasMore && guard < 10) {
    const next = await view.page('s1', cursor);
    assert.equal(next.ok, true);
    cursor = next.result.nextCursor;
    last = next;
    guard += 1;
  }
  assert.equal(last.result.hasMore, false);
  assert.equal(last.result.nextCursor, null);
});

test('a short conversation arrives whole, which is the point of the channel', async () => {
  const view = controller(transcript(4));
  const page = await view.page('s1');
  assert.equal(page.result.items.length, 12, 'four turns: prompt, activity, answer each');
  assert.equal(page.result.hasMore, false, 'nothing older is left');
  assert.equal(page.result.nextCursor, null);
  assert.ok(page.result.items.some((item) => item.type === 'messages'), 'and something is readable without expanding');
});

test('details walk one work range forward, page by page', async () => {
  const rows = transcript(1);
  const view = controller(rows);
  const page = await view.page('s1');
  const summary = page.result.items.find((item) => item.type === 'work').summary;

  const first = await view.details('s1', summary);
  assert.equal(first.ok, true);
  assert.deepEqual(first.result.messages.map((entry) => entry.role), ['thinking', 'tool_use', 'tool_result']);
  assert.equal(first.result.hasMore, false);
  assert.equal(first.result.nextCursor, null);

  // A tight byte budget splits the same range into pages whose cursor advances.
  const small = controller(rows, { detailBytes: 250 });
  const one = await small.details('s1', summary);
  assert.equal(one.result.hasMore, true);
  assert.ok(one.result.messages.length < 3);
  const two = await small.details('s1', summary, one.result.nextCursor);
  assert.deepEqual(
    two.result.messages.map((entry) => entry.id).filter((id) => one.result.messages.some((entry) => entry.id === id)),
    [],
  );

  // A cursor outside the range is refused rather than silently restarting the range.
  const outside = await small.details('s1', summary, 's1:nowhere:0');
  assert.equal(outside.ok, false);
  assert.equal(outside.code, 'BAD_REQUEST');
  // A range that is not in the transcript any more is a NOT_FOUND the controller can read.
  const gone = await view.details('s1', { firstMessageId: 's1:gone:0', lastMessageId: 's1:also-gone:0' });
  assert.equal(gone.ok, false);
  assert.equal(gone.code, 'NOT_FOUND');
});

test('a transcript past the old scan budget is served, not refused', async () => {
  // Inverted deliberately. This test used to assert `UNSUPPORTED_CAPABILITY` past
  // `HISTORY_SCAN_MAX_ROWS`, on the reasoning that the scan would time out on the phone. Two
  // things were wrong with that, and one of them is permanent:
  //
  // - it saved no scan: `rows` is the reader's own transcript cache (`readMessages.all`), so
  //   the full read has already happened by the time the budget is consulted, and the page is
  //   windowed out of that array in O(page);
  // - it did not degrade, it killed the view. The controller's `refresh()` returns immediately
  //   forever once its error matches `UNSUPPORTED_CAPABILITY` and only `reset()` clears it, and
  //   the row count is a permanent property of the session — so re-entry re-poisons it.
  const view = controller(transcript(4));
  const page = await view.page('s1');
  assert.equal(page.ok, true, 'a long transcript still gets a view');
  assert.equal(page.result.version, HISTORY_VIEW_VERSION, 'and it is the version the client checks');
  assert.ok(page.result.items.length > 0);
  assert.equal(typeof page.result.hasMore, 'boolean');
  if (page.result.hasMore) assert.equal(page.result.nextCursor, firstIdOf(page.result.items[0]), 'the cursor walks older');

  // No transcript accessor at all (a profile without the session API) says NOT_AVAILABLE,
  // which is a different thing from "this session is too big".
  const absent = createHistoryViewController({ rows: undefined });
  assert.equal((await absent.page('s1')).code, 'NOT_AVAILABLE');
  assert.equal((await absent.page('')).code, 'BAD_REQUEST');
});

test('no answer this Host gives can poison the controller view', async () => {
  // The controller's downgrade switch, copied from its own source
  // (`packages/maker-shared/src/historyView.ts:8`, used by `historyViewController.refresh()`):
  // an answer whose code matches this is permanent — `refresh()` returns immediately and only
  // `reset()` clears it, which re-entry does not reliably do. The codes are reserved for "this
  // Host has no projection capability at all", a deployment fact, and a session-specific input
  // must never produce one.
  const poison = /CHANNEL_NOT_ALLOWED|UNSUPPORTED_CAPABILITY|not registered|No handler/i;
  const view = controller(transcript(3));

  const answers = [
    await view.page('s1'),
    await view.page('s1', 's1:gone:0'),
    await view.page(''),
    await view.page('missing-session'),
    await view.details('s1', { firstMessageId: 's1:gone:0', lastMessageId: 's1:also-gone:0' }),
    await view.details('s1', null),
    await view.intent('s1', []),
    await view.intent('s1', 'not a list'),
  ];
  for (const answer of answers) {
    const code = answer?.ok === true ? (answer.result === null ? 'OK' : 'OK') : answer?.code ?? '?';
    assert.doesNotMatch(String(code), poison, `a session-specific answer must stay retryable, got ${code}`);
    assert.doesNotMatch(String(answer?.message ?? ''), poison, 'and its message may not match either');
  }

  // The one genuine capability absence: no projector at all.
  const absent = createHistoryViewController({ rows: undefined });
  assert.equal((await absent.page('s1')).code, 'NOT_AVAILABLE', 'a retryable code, not the poison one');
});

test('expand intent replaces the set wholesale and refuses a shapeless request', async () => {
  const view = controller(transcript(2));
  assert.deepEqual(view.expandedFor('s1'), []);
  assert.deepEqual(await view.intent('s1', [{ key: 'work-a' }, { key: 'preview-work-b' }]), { ok: true, result: true });
  assert.deepEqual(view.expandedFor('s1').sort(), ['work-a', 'work-b'], 'a preview key names the same group');
  await view.intent('s1', []);
  assert.deepEqual(view.expandedFor('s1'), [], 'an empty intent releases everything');
  assert.equal((await view.intent('s1', [{ key: '' }])).code, 'BAD_REQUEST');
  assert.equal((await view.intent('s1', 'nope')).code, 'BAD_REQUEST');
  assert.equal((await view.intent('s1', new Array(101).fill({ key: 'work-a' }))).code, 'BAD_REQUEST');
});

test('a view page hydrates the pictures of the rows it serves — and only those', async () => {
  // The regression this pins: image hydration was wired into `local-db:messages:list` alone, so
  // when the controller moved onto this view every photo the user sent went back to a file entry
  // whose `imageRef` means nothing to the phone — 「我发给你的照片我在信息流里看不到」, with
  // `attachmentReads.attempted = 0` on a live Host. A page is a read path, so it hydrates.
  const handle = (name) => ({ name, size: 1000, mimeType: 'image/jpeg', imageRef: { attachmentId: `sha256:${name}`, mediaType: 'image/jpeg' } });
  // Four turns, so the oldest user row is far outside the newest page.
  const rows = transcript(4);
  const newestUser = rows.find((entry) => entry.role === 'user' && entry.id === 's1:u3:0');
  const olderUser = rows.find((entry) => entry.role === 'user' && entry.id === 's1:u0:0');
  assert.ok(newestUser !== undefined && olderUser !== undefined, 'the fixture must name the two user rows');
  newestUser.content = { text: 'newest', files: [handle('new.jpg')] };
  olderUser.content = { text: 'oldest', files: [handle('old.jpg')] };

  const hydrated = [];
  const view = controller(rows, {
    // A page smaller than the transcript, so the oldest user row is genuinely outside it.
    pageItems: 6,
    hydrate: async (servedRows) => {
      hydrated.push(...servedRows);
      for (const entry of servedRows) {
        const files = Array.isArray(entry.content?.files) ? entry.content.files : [];
        const images = files.filter((file) => file.imageRef !== undefined)
          .map((file) => ({ base64: 'AAAA', mimeType: file.mimeType, originalName: file.name }));
        if (images.length === 0) continue;
        entry.content = { ...entry.content, images, files: undefined };
      }
    },
  });

  const page = await view.page('s1');
  const served = page.result.items.flatMap((item) => (item.type === 'messages' ? item.messages : []));
  const rendered = served.find((entry) => Array.isArray(entry.content?.images));

  assert.ok(rendered !== undefined, 'the served photo must come back renderable');
  assert.equal(rendered.content.images[0].originalName, 'new.jpg');
  assert.equal(rendered.content.files, undefined, 'the handle must not survive into the page');
  assert.ok(hydrated.length > 0, 'the hook must actually be called');
  for (const entry of hydrated) {
    assert.ok(served.includes(entry), 'hydrate must never be handed a row outside the page');
  }
  assert.equal(hydrated.some((entry) => entry.id === olderUser.id), false, 'an unserved row costs no read');
});

test('a page with no hydrator still answers — the picture just stays a chip', async () => {
  const rows = transcript(1);
  const user = rows.find((entry) => entry.role === 'user');
  user.content = { text: 'hi', files: [{ name: 'p.jpg', size: 10, imageRef: { attachmentId: 'sha256:x' } }] };
  const page = await controller(rows).page('s1');
  assert.equal(page.ok, true);
  const served = page.result.items.flatMap((item) => (item.type === 'messages' ? item.messages : []));
  const carried = served.find((entry) => Array.isArray(entry.content?.files));
  assert.equal(carried?.content?.images, undefined, 'no hydrator means no inlined bytes, never a crash');
});
