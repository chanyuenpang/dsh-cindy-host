/**
 * Show the framing of one logged session file.
 *
 * Usage: node tools/probe-log-shape.mjs [sessionIdFragment] [chars]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const root = 'C:\\Users\\chany\\.dsh\\sessions';
const fragment = process.argv[2] ?? '5b0eef11';
const chars = Number(process.argv[3] ?? 600);

function logs(dir, depth = 0, out = []) {
  if (depth > 3) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true, })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) logs(path, depth + 1, out);
    else if (entry.name.endsWith('.jsonl.zstd')) out.push(path);
  }
  return out;
}

const target = logs(root).find((path) => path.includes(fragment));
const text = zstdDecompressSync(readFileSync(target)).toString('utf8');
console.log(`log: ${target}`);
console.log(`bytes: ${text.length}  newlines: ${(text.match(/\n/g) ?? []).length}`);
console.log('--- head ---');
console.log(text.slice(0, chars));
console.log('--- tail ---');
console.log(text.slice(-chars));
