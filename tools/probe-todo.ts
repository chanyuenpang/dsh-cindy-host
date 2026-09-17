/**
 * Todo probe: does a DSH `todo_write` call actually produce a todo card on the
 * controller, through the message rows this Host already emits?
 *
 * Why a probe rather than a new channel: the controller does not receive todos
 * over any channel. It reads them out of a message. Two things must hold, and
 * an earlier version of this probe checked only the second:
 *
 *   1. the card is selected **by name** — `extractPlanTodos` returns todos for
 *      `TodoWrite` (and `update_plan`) and `null` for every other name;
 *   2. the input carries `{ todos: [{ content, status, activeForm? }] }`.
 *
 * This probe used to call `extractTodosFromSourceMessage` directly, which skips
 * step 1 and so passed while the phone rendered nothing: DSH names the tool
 * `todo_write`, and the controller never selected the card. Going through
 * `extractPlanTodos` is what makes this probe able to fail.
 *
 * Run with the controller's own tsx (it imports their TypeScript sources):
 *   G:\Projects\Cindy\node_modules\.bin\tsx.cmd tools\probe-todo.ts
 *
 * Exits non-zero if the todo card would not render.
 */
import { extractPlanTodos } from 'file:///G:/Projects/Cindy/packages/maker-shared/src/messageRender.ts';
import { toCindyMessageRows } from '../src/cindy-message-row.js';

/** The DSH tool parameters, exactly as `dsh-tool-todo` declares them. */
const DSH_TODO_ARGUMENTS = JSON.stringify({
  todos: [
    { content: 'Read the relay protocol', status: 'completed' },
    { content: 'Implement the channel router', status: 'in_progress' },
    { content: 'Verify on a real phone', status: 'pending' },
  ],
});

/** One DSH assistant message that only calls `todo_write`. */
const DSH_MESSAGE = {
  id: 'm1',
  role: 'assistant',
  content: [{ type: 'tool-call', id: 'call-1', name: 'todo_write', arguments: DSH_TODO_ARGUMENTS }],
};

const rows = toCindyMessageRows(DSH_MESSAGE, {
  sessionId: 'session-1',
  createdAt: '2026-01-01T00:00:00.000Z',
});

console.log('--- the row this Host emits for the tool call ---');
console.log(JSON.stringify(rows, null, 2));

// The controller's own entry point, name gate included.
let todos = null;
for (const row of rows) {
  const content = (row as { content?: { toolName?: string; input?: unknown } }).content;
  const extracted = extractPlanTodos(content?.toolName, content?.input);
  if (extracted !== null) todos = extracted;
}

console.log('--- what the controller extracts from it ---');
console.log(JSON.stringify(todos, null, 2));

const failures = [];
const emittedName = (rows[0] as { content?: { toolName?: string } } | undefined)?.content?.toolName;
if (emittedName !== 'TodoWrite') {
  failures.push(`the card is selected by name, and this row says ${JSON.stringify(emittedName)} — the controller only selects TodoWrite/update_plan`);
}
if (todos === null) failures.push('the controller extracted no todo list from the row');
else {
  if (todos.length !== 3) failures.push(`expected 3 todos, got ${todos.length}`);
  const statuses = todos.map((todo) => todo.status);
  if (JSON.stringify(statuses) !== JSON.stringify(['completed', 'in_progress', 'pending'])) {
    failures.push(`statuses did not survive: ${JSON.stringify(statuses)}`);
  }
  if (todos[0]?.content !== 'Read the relay protocol') failures.push('todo text did not survive');
}

if (failures.length > 0) {
  console.error('\nTODO PROBE FAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\ntodo probe passed: a DSH todo_write renders as a todo card with no extra channel.');
