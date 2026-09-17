/**
 * Print the last N logged events of one session, with their timestamps.
 *
 * The log is a **concatenated zstd stream**: every append is its own frame. Two consequences
 * this tool handles:
 *   - a one-shot `zstdDecompressSync` returns only the first frame, so the buffer is split on
 *     the zstd magic number and each frame is decoded on its own;
 *   - the file is being appended to while it is read, so the trailing frame is usually
 *     incomplete — a frame that fails to decode is dropped, never fatal.
 *
 * Usage: node tools/probe-log-tail.mjs [sessionIdFragment] [count]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const root = 'C:\\Users\\chany\\.dsh\\sessions';
const fragment = process.argv[2] ?? '5b0eef11';
const want = Number(process.argv[3] ?? 40);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

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
    else if (entry.name.endsWith('.jsonl.zstd') && path.includes(fragment)) out.push(path);
  }
  return out;
}

const found = logs(root).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
if (found.length === 0) {
  console.log(`no log matching ${fragment}`);
  process.exit(0);
}
const path = found[0];
const size = statSync(path).size;
console.log(`${path}\n${(size / 1024 / 1024).toFixed(1)} MiB\n`);

// Only the tail is wanted, and a frame is far smaller than this: 4 MiB of the file's end holds
// hundreds of frames, and the first partial one is simply dropped by the decoder.
const raw = readFileSync(path);
const from = Math.max(0, raw.length - 4 * 1024 * 1024);
const buffer = raw.subarray(from);
const starts = [];
for (let index = buffer.indexOf(MAGIC); index !== -1; index = buffer.indexOf(MAGIC, index + 4)) starts.push(index);

const rows = [];
for (let index = 0; index < starts.length; index += 1) {
  const end = index + 1 < starts.length ? starts[index + 1] : buffer.length;
  let text;
  try {
    text = zstdDecompressSync(buffer.subarray(starts[index], end)).toString('utf8');
  } catch {
    continue; // a frame still being written, or the head of the tail window
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') rows.push(trimmed);
  }
}

const stamp = (row) => {
  const match = row.match(/"(?:at|timestamp|time|createdAt|occurredAt)":"?([0-9T:.\-+Z]+)"?/);
  if (match === null) return '                   ';
  const value = match[1];
  const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '                   ';
};
const kind = (row) => {
  try {
    const parsed = JSON.parse(row);
    return parsed.type ?? parsed.kind ?? parsed.event?.type ?? Object.keys(parsed).slice(0, 3).join(',');
  } catch {
    return 'unparsed';
  }
};

console.log(`${rows.length} rows in the tail window\n`);
for (const row of rows.slice(-want)) {
  console.log(`${stamp(row)}  ${String(kind(row)).padEnd(20)}  ${row.slice(0, 130)}`);
}
