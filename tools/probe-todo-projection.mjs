/**
 * Report which sessions have a non-empty `todos` projection.
 *
 * The projection cache is where DSH keeps the folded projection state, so a todo list that
 * an agent (or the claw adapter, via `session.append('todo/write', …)`) wrote shows up here
 * even when the session's own log file cannot be read cheaply.
 *
 * Usage: node tools/probe-todo-projection.mjs [path]
 */
import { readFileSync } from 'node:fs';

const path = process.argv[2] ?? 'C:\\Users\\chany\\.dsh\\storages\\session_projcache.json';
const parsed = JSON.parse(readFileSync(path, 'utf8'));

/** Every `todos`-shaped value anywhere in the document, with its path. */
function walk(value, trail, out) {
  if (value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, `${trail}[${index}]`, out));
    return out;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'todos') out.push({ path: `${trail}.${key}`, value: entry });
    else walk(entry, `${trail}.${key}`, out);
  }
  return out;
}

const found = walk(parsed, '', []);
console.log(`path: ${path}`);
console.log(`top-level keys: ${Object.keys(parsed).join(', ')}`);
console.log(`todos-shaped values: ${found.length}`);
const populated = found.filter((entry) => Array.isArray(entry.value) ? entry.value.length > 0 : entry.value !== null && entry.value !== undefined);
console.log(`populated: ${populated.length}`);
for (const entry of populated.slice(0, 8)) {
  console.log(`\n${entry.path} =`);
  console.log(JSON.stringify(entry.value, null, 2).slice(0, 600));
}
// How many are explicitly null (a projection that was registered but never written)?
const nulls = found.filter((entry) => entry.value === null);
console.log(`\nexplicit null: ${nulls.length}`);
for (const entry of found.slice(0, 3)) console.log(`  sample path: ${entry.path} → ${JSON.stringify(entry.value)?.slice(0, 80)}`);
