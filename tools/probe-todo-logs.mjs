/**
 * Which logged sessions contain `todo/write` snapshots?
 *
 * The claw adapter maps its plan onto DSH's native todo dock with
 * `session.append('todo/write', { todos })` (fail-open), so this answers whether that
 * sync actually lands — and which sessions carry a todo list a phone could be shown.
 *
 * Usage: node tools/probe-todo-logs.mjs [--list]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const root = 'C:\\Users\\chany\\.dsh\\sessions';
const list = process.argv.includes('--list');

function logs(dir, depth = 0, out = []) {
  if (depth > 3) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) logs(path, depth + 1, out);
    else if (entry.name.endsWith('.jsonl.zstd')) out.push(path);
  }
  return out;
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** The whole log, decoding every concatenated frame. */
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
      // A frame this decoder cannot read costs that frame, never the scan.
    }
  });
  return parts.join('');
}

let withTodos = 0;
let scanned = 0;
for (const path of logs(root)) {
  let text;
  try {
    text = readLog(path);
  } catch {
    continue;
  }
  scanned += 1;
  const writes = text.split('\n').filter((line) => line.includes('"todo/write"'));
  if (writes.length === 0) continue;
  withTodos += 1;
  const sessionId = path.split('\\').slice(-2)[0];
  console.log(`${sessionId}  ${(statSync(path).size / 1024).toFixed(0)}KB  todo/write=${writes.length}`);
  if (list) {
    const last = writes[writes.length - 1];
    const match = /"todos":(\[.*?\])\}/.exec(last);
    console.log(`    last: ${match === null ? last.slice(0, 200) : match[1].slice(0, 240)}`);
  }
}
console.log(`\nscanned ${scanned} logs; ${withTodos} carry todo/write snapshots`);
