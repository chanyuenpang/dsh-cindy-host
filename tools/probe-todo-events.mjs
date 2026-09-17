/**
 * Look for `todo/write` snapshots in the logged sessions.
 *
 * DSH's todo tool declares its payload as a **log-only** event ("never derived history"),
 * so a todo list an agent wrote is not something the transcript fold turns into rows — and
 * the phone renders its plan card from a `TodoWrite` tool row. This answers the question
 * that decides where the fix belongs: are there todo snapshots at all, in which session,
 * and are their payloads shaped like a plan?
 *
 * Usage: node tools/probe-todo-events.mjs [--contains <text>] [--all]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const root = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : 'C:\\Users\\chany\\.dsh\\sessions';
const containsIndex = process.argv.indexOf('--contains');
const contains = containsIndex >= 0 ? process.argv[containsIndex + 1] : null;
const all = process.argv.includes('--all');

/** Every `session.v3.jsonl.zstd` under the sessions root, with its workspace slug. */
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
    else if (entry.name.endsWith('.jsonl.zstd')) out.push({ path, slug: dir.split('\\').slice(-2)[0] });
  }
  return out;
}

let scanned = 0;
for (const { path, slug } of logs(root)) {
  let text;
  try {
    text = zstdDecompressSync(readFileSync(path)).toString('utf8');
  } catch (error) {
    console.log(`skip ${path}: ${String(error?.message ?? error)}`);
    continue;
  }
  scanned += 1;
  const writes = text.split('\n').filter((line) => line.includes('"todo/write"'));
  const matches = contains === null ? true : text.includes(contains);
  if (!matches) continue;
  if (writes.length === 0 && !all) {
    console.log(`${slug}/${path.split('\\').pop()}  ${(statSync(path).size / 1024).toFixed(0)}KB  todo/write=0`);
    continue;
  }
  console.log(`\n=== ${slug}  ${path}  ${(statSync(path).size / 1024).toFixed(0)}KB  todo/write=${writes.length} ===`);
  for (const line of writes.slice(-3)) {
    try {
      const event = JSON.parse(line);
      console.log(JSON.stringify(event.data ?? event).slice(0, 400));
    } catch {
      console.log(line.slice(0, 200));
    }
  }
  if (contains !== null) console.log(`contains "${contains}": yes`);
}
console.log(`\nscanned ${scanned} logs`);
