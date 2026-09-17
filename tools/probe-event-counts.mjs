/**
 * Count session-event types in one logged session.
 *
 * Usage: node tools/probe-event-counts.mjs [sessionIdFragment] [type...]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const root = 'C:\\Users\\chany\\.dsh\\sessions';
const fragment = process.argv[2] ?? '5b0eef11';
const types = process.argv.slice(3).length > 0
  ? process.argv.slice(3)
  : ['assistant/message', 'user/message', 'turn/start', 'turn/end', 'todo/write', 'tool/result'];

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

const target = logs(root).find((path) => path.includes(fragment));
if (target === undefined) {
  console.log(`no log matching ${fragment}`);
  process.exit(1);
}
const lines = zstdDecompressSync(readFileSync(target)).toString('utf8').split('\n');
console.log(`log: ${target}\nlines: ${lines.filter((line) => line.trim() !== '').length}`);
for (const type of types) {
  const needle = `"${type}"`;
  console.log(`  ${type} = ${lines.filter((line) => line.includes(needle)).length}`);
}
// Any event type the log actually carries, so a zero above can be told apart from a
// wrong needle.
const seen = new Map();
for (const line of lines) {
  const match = /"type":"([^"]+)"/.exec(line);
  if (match !== null) seen.set(match[1], (seen.get(match[1]) ?? 0) + 1);
}
console.log('event types in this log:');
for (const [type, count] of [...seen].sort((a, b) => b[1] - a[1])) console.log(`  ${count}× ${type}`);
