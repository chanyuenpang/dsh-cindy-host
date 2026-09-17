import test from 'node:test';
import assert from 'node:assert/strict';
import { toCindyMessageRows, toCindyMessages, hydrateImageAttachments } from '../src/cindy-message-row.js';

const SESSION = 'session-1';
const AT = '2026-01-01T00:00:00.000Z';

/** One DSH model message. */
function message(id, role, content) {
  return { message: { id, role, content }, createdAt: AT };
}

test('splits one DSH message into one row per renderable block, in order', () => {
  const rows = toCindyMessageRows(
    {
      id: 'm1',
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'thinking about it' },
        { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"a.ts"}' },
        { type: 'text', text: 'Done.' },
      ],
    },
    { sessionId: SESSION, createdAt: AT },
  );

  assert.deepEqual(rows.map((row) => row.role), ['thinking', 'tool_use', 'assistant']);
  // Thought → tool → answer: the order the user reads.
  assert.deepEqual(rows[0].content, { text: 'thinking about it' });
  assert.equal(rows[1].toolUseId, 'call-1');
  assert.deepEqual(rows[1].content, { toolName: 'read_file', input: { path: 'a.ts' }, toolUseId: 'call-1' });
  assert.deepEqual(rows[2].content, { text: 'Done.' });
});

test('renames the plan tool to the one name the phone renders a todo card for', () => {
  // The phone picks its plan/todo card by name: `extractPlanTodos` reads
  // `input.todos` only for `TodoWrite`. DSH calls the same tool `todo_write`
  // with the identical input, so without this the agent's plan never appeared.
  const rows = toCindyMessageRows(
    {
      id: 'm1',
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          id: 'call-1',
          name: 'todo_write',
          arguments: JSON.stringify({
            todos: [
              { content: 'first', status: 'completed' },
              { content: 'second', status: 'pending' },
            ],
          }),
        },
      ],
    },
    { sessionId: SESSION, createdAt: AT },
  );

  assert.equal(rows[0].content.toolName, 'TodoWrite');
  // The input is passed through untouched: the phone reads its own fields.
  assert.deepEqual(rows[0].content.input.todos.map((todo) => todo.status), ['completed', 'pending']);
});

test('leaves every other tool name alone', () => {
  const rows = toCindyMessageRows(
    {
      id: 'm1',
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call-1', name: 'todo_read', arguments: '{}' }],
    },
    { sessionId: SESSION, createdAt: AT },
  );
  // Only the exact tool whose input shape was verified is translated.
  assert.equal(rows[0].content.toolName, 'todo_read');
});

test('every row carries the identity the phone keys and dedupes by', () => {
  const rows = toCindyMessageRows(
    { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
    { sessionId: SESSION, createdAt: AT },
  );
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.sessionId, SESSION);
    assert.equal(row.createdAt, AT);
    assert.equal(row.clientId, row.id, 'the phone pairs echoes by clientId');
    assert.equal(row.agentMeta, null);
  }
  assert.notEqual(rows[0].id, rows[1].id, 'ids must be unique across blocks of one message');
});

test('a user message keeps the user role', () => {
  const rows = toCindyMessageRows({ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }] }, { sessionId: SESSION, createdAt: AT });
  assert.equal(rows[0].role, 'user');
});

test('a tool result pairs to its call and flattens its nested text', () => {
  const rows = toCindyMessageRows(
    {
      id: 'm1',
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'line 1' }, { type: 'text', text: 'line 2' }] }],
    },
    { sessionId: SESSION, createdAt: AT },
  );
  assert.equal(rows[0].role, 'tool_result');
  assert.equal(rows[0].toolUseId, 'call-1');
  assert.deepEqual(rows[0].content, { text: 'line 1\nline 2', isError: false });
});

test('drops blocks the phone has no representation for', () => {
  const rows = toCindyMessageRows(
    {
      id: 'm1',
      role: 'user',
      content: [
        { type: 'image', attachment: { id: 'a' } },
        { type: 'file', attachment: { id: 'b' } },
        { type: 'text', text: 'caption' },
        { type: 'unknown-future-block', text: 'x' },
      ],
    },
    { sessionId: SESSION, createdAt: AT },
  );
  assert.equal(rows.length, 1, 'media has no channel in this slice, so it is skipped rather than emitted empty');
  assert.equal(rows[0].content.text, 'caption');
});

test('drops empty text and reasoning blocks, which exist only to host usage', () => {
  const rows = toCindyMessageRows(
    { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '' }, { type: 'reasoning', text: '' }] },
    { sessionId: SESSION, createdAt: AT },
  );
  assert.deepEqual(rows, []);
});

test('a malformed tool argument string survives as its raw text', () => {
  const rows = toCindyMessageRows(
    { id: 'm1', role: 'assistant', content: [{ type: 'tool-call', id: 'c', name: 'x', arguments: '{not json' }] },
    { sessionId: SESSION, createdAt: AT },
  );
  assert.equal(rows[0].content.input, '{not json');
});

test('reverses message order but never block order within a message', () => {
  const rows = toCindyMessages(
    [
      message('m1', 'user', [{ type: 'text', text: 'first' }]),
      message('m2', 'assistant', [{ type: 'reasoning', text: 'then' }, { type: 'text', text: 'second' }]),
    ],
    { sessionId: SESSION },
  );
  // Newest message first (the phone's DESC paging contract) …
  assert.deepEqual(rows.map((row) => row.content.text), ['then', 'second', 'first']);
  // … but within the newest message, thought still precedes the answer.
  assert.deepEqual(rows.slice(0, 2).map((row) => row.role), ['thinking', 'assistant']);
});

test('a tool_use row keeps the parsed arguments where the controller reads them', () => {
  // The controller does not receive todos over any channel: it extracts them
  // from a message with `message.content.input.todos`
  // (`maker-shared/messageRender.ts` -> `extractTodosFromSourceMessage`), and
  // DSH's `todo_write` takes exactly `{ todos: [{ content, status }] }`
  // (`dsh-tool-todo`). So this shape IS the todo feature — breaking it here
  // silently removes the todo card. `tools/probe-todo.ts` proves the end-to-end
  // read against the controller's own extractor.
  //
  // The input is necessary but not sufficient: the phone selects the card by
  // name, so the row must carry `TodoWrite`, not DSH's `todo_write`. Asserting
  // the raw name here is what let a correct-looking shape render nothing.
  const rows = toCindyMessageRows(
    { id: 'm1', role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'todo_write', arguments: '{"todos":[{"content":"a","status":"pending"}]}' }] },
    { sessionId: SESSION, createdAt: AT },
  );
  assert.equal(rows[0].content.toolName, 'TodoWrite');
  assert.deepEqual(rows[0].content.input.todos, [{ content: 'a', status: 'pending' }]);
});

test('fold an empty or malformed transcript without throwing', () => {
  assert.deepEqual(toCindyMessages(undefined, { sessionId: SESSION }), []);
  assert.deepEqual(toCindyMessages([], { sessionId: SESSION }), []);
  assert.deepEqual(toCindyMessageRows({ id: 'm', role: 'assistant' }, { sessionId: SESSION }), []);
});

test('a user row carries the controllers own prompt id, so its echo is retired', () => {
  // The controller shows a message the moment it sends it and retires that copy
  // by matching `clientId` against the durable row's
  // (`projectOptimisticUserMessages` splices out the echo on exactly that field).
  // With a synthetic id here the echo is never recognised, so the user saw the
  // message twice — once spinning, once real.
  const echoed = toCindyMessageRows(
    { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { sessionId: SESSION, createdAt: AT, promptClientId: 'phone-client-1' },
  );
  assert.equal(echoed[0].clientId, 'phone-client-1');
  assert.equal(echoed[0].id, `${SESSION}:m1:0`, 'the row keeps its own stable id');

  // An assistant row is not a prompt echo and keeps the synthetic id.
  const assistant = toCindyMessageRows(
    { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    { sessionId: SESSION, createdAt: AT, promptClientId: 'phone-client-1' },
  );
  assert.equal(assistant[0].clientId, `${SESSION}:m2:0`);

  // A user row with no known prompt id still gets a usable id.
  const plain = toCindyMessageRows(
    { id: 'm3', role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { sessionId: SESSION, createdAt: AT },
  );
  assert.equal(plain[0].clientId, `${SESSION}:m3:0`);
});

test('a system prompt injection produces no rows at all', () => {
  // DSH logs its prompt injection as a `system/message` whose source must be
  // `{kind: 'plugin'}` (dsh-session's own shape invariant; the plugin is
  // `@deepseek-ai/dsh-system-prompt`). The old role test was
  // `role === 'user' ? 'user' : 'assistant'`, so the whole system prompt arrived
  // on the phone as an ordinary assistant reply — reported live by the user.
  const rows = toCindyMessageRows(
    {
      id: 'm1',
      role: 'system',
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
      content: [{ type: 'text', text: 'You are an AI agent powered by DeepSeek Harness.' }],
    },
    { sessionId: SESSION, createdAt: AT, promptClientId: 'phone-1' },
  );
  assert.deepEqual(rows, []);
});

test('an unknown role is silence, not an assistant turn', () => {
  // The default must never be "assistant": a role this Host has never seen is
  // not evidence that the model said something.
  for (const role of ['tool', 'function', 'hook', 'developer']) {
    const rows = toCindyMessageRows(
      { id: 'm1', role, content: [{ type: 'text', text: 'injected' }] },
      { sessionId: SESSION, createdAt: AT },
    );
    assert.deepEqual(rows, [], `${role} must not render as a message`);
  }
});

test('a plugin-sourced injection renders nothing, whatever role it carries', () => {
  // The per-turn runtime-context snapshot is logged as a **user/message** whose
  // source is `{kind:'plugin', plugin:'@deepseek-ai/dsh-system-prompt',
  // form:'snapshot'}` — so a role-only filter let a "Current runtime context.
  // This snapshot supersedes…" bubble through as something the user had said,
  // every single turn.
  const snapshot = toCindyMessageRows(
    {
      id: 'm1',
      role: 'user',
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections: [] },
      content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }],
    },
    { sessionId: SESSION, createdAt: AT, promptClientId: 'phone-1' },
  );
  assert.deepEqual(snapshot, []);

  // A one-line notice is injected the same way and is equally not a message.
  const notice = toCindyMessageRows(
    {
      id: 'm2',
      role: 'assistant',
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-compaction', form: 'notice', summary: 'Compacted 12 messages' },
      content: [{ type: 'text', text: 'Compacted 12 messages' }],
    },
    { sessionId: SESSION, createdAt: AT },
  );
  assert.deepEqual(notice, []);

  // The skills catalog is the case that proved `plugin` was the wrong test: it
  // is a **user** message whose source kind is its own (`@deepseek-ai/dsh-tool-skill`
  // builds `{kind:'skill-catalog', form:'catalog'}`, or `form:'catalog', update:true`
  // for a replacement), so a plugin-only denylist let "<system-reminder> …the
  // following skills are available…" arrive as something the user had said.
  const catalog = toCindyMessageRows(
    {
      id: 'm4',
      role: 'user',
      source: { kind: 'skill-catalog', form: 'catalog', entries: [] },
      content: [{ type: 'text', text: '<system-reminder>\n<available_skills>\n…\n</available_skills>\n</system-reminder>' }],
    },
    { sessionId: SESSION, createdAt: AT, promptClientId: 'phone-1' },
  );
  assert.deepEqual(catalog, []);

  const catalogUpdate = toCindyMessageRows(
    {
      id: 'm5',
      role: 'user',
      source: { kind: 'skill-catalog', form: 'catalog', update: true, entries: [] },
      content: [{ type: 'text', text: '<system-reminder>This complete catalog replaces every earlier available-skills list…' }],
    },
    { sessionId: SESSION, createdAt: AT },
  );
  assert.deepEqual(catalogUpdate, []);

  // The participants themselves still render.
  const model = toCindyMessageRows(
    {
      id: 'm3',
      role: 'assistant',
      source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
      content: [{ type: 'text', text: 'hello' }],
    },
    { sessionId: SESSION, createdAt: AT },
  );
  assert.deepEqual(model.map((row) => row.role), ['assistant']);
});

test('a user message with attachments restates them on its text row', () => {
  // The phone reads an attachment from the message's content JSON and matches its
  // own optimistic bubble by `clientId`, so an attachment that is not restated here
  // disappears from the user's message the moment the authoritative row lands.
  const rows = toCindyMessageRows(
    {
      id: 'm1',
      role: 'user',
      source: { kind: 'user' },
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'file', attachment: { attachmentId: 'a1', name: 'spec.pdf', bytes: 4096 } },
        { type: 'image', attachment: { attachmentId: 'a2', name: 'shot.png', bytes: 512, mediaType: 'image/png', width: 4, height: 4 } },
      ],
    },
    { sessionId: SESSION, createdAt: AT, promptClientId: 'phone-1' },
  );

  assert.equal(rows.length, 1, 'attachments ride the text row, not rows of their own');
  assert.equal(rows[0].role, 'user');
  assert.equal(rows[0].clientId, 'phone-1');
  assert.deepEqual(rows[0].content.files, [
    { name: 'spec.pdf', size: 4096 },
    // The image carries its durable descriptor until the page is hydrated: DSH's
    // reference is content-addressed and explicitly not a path or URL, so it is the
    // only way back to the bytes. **The whole descriptor**, because the store validates
    // the reference it is asked to read — a subset silently failed every read.
    // `hydrateImageAttachments` turns it into `images[]` and removes it.
    { name: 'shot.png', size: 512, mimeType: 'image/png', imageRef: { attachmentId: 'a2', name: 'shot.png', bytes: 512, mediaType: 'image/png', width: 4, height: 4 } },
  ]);
});

test('an image attachment is inlined from the DSH attachment store, and its handle never ships', async () => {
  // The reported bug, exactly: the phone rendered "没有可展示的远程路径" because the
  // image arrived as a `files[]` entry with no `path`. The phone renders an image only
  // from `images[]` with a `url` or `base64`, and `data:image/...` counts as previewable
  // — so the bytes DSH already stores are what make the bubble show the photo.
  const rows = toCindyMessageRows(
    {
      id: 'm1',
      role: 'user',
      source: { kind: 'user' },
      content: [
        { type: 'text', text: '' },
        { type: 'file', attachment: { attachmentId: 'a1', name: 'notes.txt', bytes: 12 } },
        { type: 'image', attachment: { attachmentId: 'a2', name: '368492.jpg', bytes: 311456, mediaType: 'image/jpeg', width: 8, height: 8 } },
      ],
    },
    { sessionId: SESSION, createdAt: AT, promptClientId: 'phone-1' },
  );
  const asked = [];
  await hydrateImageAttachments(rows, {
    readImage: async (handle) => {
      asked.push(handle);
      return { base64: 'AAEC', bytes: 3, mediaType: 'image/jpeg' };
    },
  });

  assert.deepEqual(asked, [{ attachmentId: 'a2', name: '368492.jpg', bytes: 311456, mediaType: 'image/jpeg', width: 8, height: 8 }], 'only the image is read, and with the descriptor DSH stored');
  assert.deepEqual(rows[0].content.images, [{ base64: 'AAEC', mimeType: 'image/jpeg', originalName: '368492.jpg' }]);
  assert.deepEqual(rows[0].content.files, [{ name: 'notes.txt', size: 12 }], 'the document keeps its file entry');
  assert.equal(JSON.stringify(rows).includes('imageRef'), false, 'the internal handle must never reach the wire');
});

test('an image that cannot be read, or is too large, stays an honest file chip', async () => {
  const build = (bytes) => toCindyMessageRows(
    { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: 'a2', name: 'big.png', bytes, mediaType: 'image/png' } }, { type: 'text', text: 'x' }] },
    { sessionId: SESSION, createdAt: AT },
  );

  // A reader that throws costs that image, never the page.
  const throwing = build(64);
  await hydrateImageAttachments(throwing, { readImage: async () => { throw new Error('store offline'); } });
  assert.equal('images' in throwing[0].content, false);
  assert.deepEqual(throwing[0].content.files, [{ name: 'big.png', size: 64, mimeType: 'image/png' }]);
  assert.equal(JSON.stringify(throwing).includes('imageRef'), false);

  // Past the inline budget, the same degradation — a 4MB image inlined per row is a
  // memory budget problem, not a rendering win.
  const oversize = build(9 * 1024 * 1024);
  await hydrateImageAttachments(oversize, { readImage: async () => ({ base64: 'AAEC', bytes: 9 * 1024 * 1024, mediaType: 'image/png' }), maxBytes: 4 * 1024 * 1024 });
  assert.equal('images' in oversize[0].content, false);
  assert.deepEqual(oversize[0].content.files, [{ name: 'big.png', size: 9 * 1024 * 1024, mimeType: 'image/png' }]);
  // No attachment service composed: the rows keep the file chips and are still clean.
  const noStore = build(64);
  await hydrateImageAttachments(noStore);
  assert.equal('images' in noStore[0].content, false);
  assert.equal(JSON.stringify(noStore).includes('imageRef'), false);
});

test('the page budget decides before anything is read, newest picture first', async () => {
  // Reading bytes only to discard them is work the page does not owe anyone, and it
  // made the inlining counters claim the page had tried to serve an image it never
  // could. A declared size is therefore judged up front; only an undeclared one can
  // surprise the reader.
  const rows = toCindyMessageRows(
    {
      id: 'm1',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'image', attachment: { attachmentId: 'big', name: 'huge.png', bytes: 3 * 1024 * 1024, mediaType: 'image/png' } }],
    },
    { sessionId: SESSION, createdAt: AT },
  );
  const asked = [];
  await hydrateImageAttachments(rows, {
    readImage: async (handle) => { asked.push(handle.attachmentId); return { base64: 'AAEC', bytes: 3 * 1024 * 1024 }; },
  });
  assert.deepEqual(asked, [], 'an image over the per-image cap is never read');
  assert.equal('images' in rows[0].content, false);

  // Two images share one page budget: the newest row's picture is the one that fits,
  // and the older one stays a chip rather than pushing the page over the ceiling.
  const older = toCindyMessageRows(
    { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: 'old', name: 'old.png', bytes: 400 * 1024, mediaType: 'image/png' } }] },
    { sessionId: SESSION, createdAt: '2026-01-01T00:00:00.000Z' },
  );
  const newer = toCindyMessageRows(
    { id: 'm2', role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: 'new', name: 'new.png', bytes: 400 * 1024, mediaType: 'image/png' } }] },
    { sessionId: SESSION, createdAt: '2026-01-01T00:00:01.000Z' },
  );
  // Newest first, as the controller pages it.
  const page = [newer[0], older[0]];
  const pageAsked = [];
  await hydrateImageAttachments(page, {
    maxTotalBytes: 600 * 1024,
    readImage: async (handle) => {
      pageAsked.push(handle.attachmentId);
      return { base64: 'A'.repeat(400 * 1024), bytes: 400 * 1024, mediaType: 'image/png' };
    },
  });
  assert.deepEqual(pageAsked, ['new'], 'only the newest picture is read');
  assert.equal(page[0].content.images.length, 1, 'the newest picture renders');
  assert.equal('images' in page[1].content, false, 'the older one stays a chip');
  assert.deepEqual(page[1].content.files, [{ name: 'old.png', size: 400 * 1024, mimeType: 'image/png' }]);
});

test('a message that is nothing but attachments still shows them', () => {
  const rows = toCindyMessageRows(
    {
      id: 'm1',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'file', attachment: { attachmentId: 'a1', name: 'notes.txt', bytes: 12 } }],
    },
    { sessionId: SESSION, createdAt: AT, promptClientId: 'phone-2' },
  );

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].content.files, [{ name: 'notes.txt', size: 12 }]);
  assert.equal(rows[0].clientId, 'phone-2', 'the row the controller retires its echo on is still the prompt id');
});

test("an assistant message's file block is not mistaken for the user's attachment", () => {
  const rows = toCindyMessageRows(
    {
      id: 'm1',
      role: 'assistant',
      source: { kind: 'model', provider: 'p', model: 'm' },
      content: [{ type: 'file', attachment: { attachmentId: 'a1', name: 'generated.txt', bytes: 1 } }, { type: 'text', text: 'done' }],
    },
    { sessionId: SESSION, createdAt: AT },
  );
  assert.deepEqual(rows.map((row) => row.content.files), [undefined]);
});

test('a tool-result message renders only its result block', () => {  // DSH records a tool result as a `user`-role message with a `{kind: 'tool'}`
  // source. Its text is not the user speaking, even if a text block appears on
  // the same message.
  const rows = toCindyMessageRows(
    {
      id: 'm1',
      role: 'user',
      source: { kind: 'tool', callId: 'call-1' },
      content: [
        { type: 'text', text: 'not the user speaking' },
        { type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'file contents' }] },
      ],
    },
    { sessionId: SESSION, createdAt: AT },
  );
  assert.deepEqual(rows.map((row) => row.role), ['tool_result']);
  assert.equal(rows[0].content.text, 'file contents');

  // A genuine user message still renders as one.
  const said = toCindyMessageRows(
    { id: 'm2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] },
    { sessionId: SESSION, createdAt: AT },
  );
  assert.deepEqual(said.map((row) => row.role), ['user']);
});

