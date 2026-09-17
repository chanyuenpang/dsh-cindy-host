/**
 * Read one logged session's events and count what it contains.
 *
 * The log is a **concatenated zstd stream**: every append is its own frame, so a one-shot
 * `zstdDecompressSync` silently returns only the first frame (the 195-byte header) and every
 * count comes back zero. Decoding must go through the stream API.
 *
 * Usage: node tools/probe-log-events.mjs [sessionIdFragment] [type...]
 */
import { createReadStream, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createZstdDecompress } from 'node:zlib';

const root = 'C:\\Users\\chany\\.dsh\\sessions';
const fragment = process.argv[2] ?? '5b0eef11';
const wanted = process.argv.slice(3);

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

/** The whole log, as text, through the streaming decoder. */
function readLog(path) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    createReadStream(path)
      .pipe(createZstdDecompress())
      .on('data', (chunk) => chunks.push(chunk))
      .on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      .on('error', reject);
  });
}

const target = logs(root).find((path) => path.includes(fragment));
if (target === undefined) {
  console.log(`no log matching ${fragment}`);
  process.exit(1);
}
const text = await readLog(target);
const lines = text.split('\n').filter((line) => line.trim() !== '');
console.log(`log: ${target}\nlines: ${lines.length}`);
const seen = new Map();
for (const line of lines) {
  const match = /"type":"([^"]+)"/.exec(line);
  if (match !== null) seen.set(match[1], (seen.get(match[1]) ?? 0) + 1);
}
for (const type of wanted) console.log(`  ${type} = ${seen.get(type) ?? 0}`);
console.log('event types:');
for (const [type, count] of [...seen].sort((a, b) => b[1] - a[1])) console.log(`  ${count}× ${type}`);
for (const line of lines.filter((entry) => entry.includes('"todo/write"'))) {
  console.log(`todo/write event: ${line.slice(0, 500)}`);
}
