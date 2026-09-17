/**
 * Decode a DSH session log that is a **concatenation of independent zstd frames**.
 *
 * One-shot and stream decoders both stop after the first frame, which is why a 145 KB log
 * reads back as its 195-byte header. Each append is its own frame, so the frames are split
 * on the zstd magic number and decoded one at a time.
 *
 * Usage: node tools/probe-log-frames.mjs [sessionIdFragment] [--grep <text>]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const root = 'C:\\Users\\chany\\.dsh\\sessions';
const fragment = process.argv[2] ?? '5b0eef11';
const grepIndex = process.argv.indexOf('--grep');
const needle = grepIndex >= 0 ? process.argv[grepIndex + 1] : null;

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
const target = logs(root).find((path) => path.includes(fragment));
const buffer = readFileSync(target);
const starts = [];
for (let index = 0; index + 4 <= buffer.length; index += 1) {
  if (buffer[index] === MAGIC[0] && buffer[index + 1] === MAGIC[1] && buffer[index + 2] === MAGIC[2] && buffer[index + 3] === MAGIC[3]) {
    starts.push(index);
  }
}
const parts = [];
let failed = 0;
starts.forEach((start, index) => {
  const end = index + 1 < starts.length ? starts[index + 1] : buffer.length;
  try {
    parts.push(zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'));
  } catch {
    failed += 1;
  }
});
const text = parts.join('');
const events = text.split('\n').filter((line) => line.includes('"type"'));
console.log(`log: ${target}`);
console.log(`frames: ${starts.length} (decoded ${parts.length}, failed ${failed})  events: ${events.length}`);
const types = new Map();
for (const line of events) {
  const match = /"type":"([^"]+)"/.exec(line);
  if (match !== null) types.set(match[1], (types.get(match[1]) ?? 0) + 1);
}
for (const [type, count] of [...types].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${count}× ${type}`);
if (needle !== null) {
  const hits = events.filter((line) => line.includes(needle));
  console.log(`\nlines containing ${needle}: ${hits.length}`);
  for (const line of hits.slice(-4)) console.log(`  ${line.slice(0, 300)}`);
}
