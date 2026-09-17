/**
 * Fold one logged session's `todo/write` snapshots through the real translation and print
 * the rows the phone would receive.
 *
 * This is the end-to-end shape check for 「claw 流程的 ToDo 在手机上看不到」: the log's own
 * snapshots go in, and the `TodoWrite` tool rows the plan card is built from come out.
 *
 * Usage: node tools/probe-todo-rows.mjs [sessionIdFragment] [howMany]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { entryForTodoWrite } from '../src/dsh-message-fold.js';
import { toCindyMessages } from '../src/cindy-message-row.js';

const root = 'C:\\Users\\chany\\.dsh\\sessions';
const fragment = process.argv[2] ?? 'session-5020c98a';
const howMany = Number(process.argv[3] ?? 3);

function logs(dir, depth = 0, out = []) {
  if (depth > 3) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) logs(path, depth + 1, out);
    else if (entry.name.endsWith('.jsonl.zstd')) out.push(path);
  }
  return out;
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
function readLog(path) {
  const buffer = readFileSync(path);
  const starts = [];
  for (let index = 0; index + 4 <= buffer.length; index += 1) {
    if (buffer[index] === MAGIC[0] && buffer[index + 1] === MAGIC[1] && buffer[index + 2] === MAGIC[2] && buffer[index + 3] === MAGIC[3]) starts.push(index);
  }
  const parts = [];
  starts.forEach((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] : buffer.length;
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'));
    } catch {
      // One undecodable frame costs that frame.
    }
  });
  return parts.join('');
}

const target = logs(root).find((path) => path.includes(fragment));
if (target === undefined) {
  console.log(`no log matching ${fragment}`);
  process.exit(1);
}
const sessionId = target.split('\\').slice(-2)[0];
const events = readLog(target).split('\n')
  .filter((line) => line.includes('"type":"todo/write"'))
  .map((line) => { try { return JSON.parse(line); } catch { return null; } })
  .filter(Boolean);

const rendered = [];
for (const event of events) {
  const entry = entryForTodoWrite(event);
  if (entry === null) continue;
  const rows = toCindyMessages([entry], { sessionId });
  if (rows.length > 0) rendered.push(rows[0]);
}
console.log(`session ${sessionId}`);
console.log(`todo/write snapshots: ${events.length}  →  rows the phone would get: ${rendered.length}`);
for (const row of rendered.slice(-howMany)) {
  const todos = row.content.input?.todos ?? [];
  console.log(`\n${row.createdAt}  row=${row.id}  tool=${row.content.toolName}`);
  for (const todo of todos) console.log(`   [${todo.status}] ${todo.content}`);
}
