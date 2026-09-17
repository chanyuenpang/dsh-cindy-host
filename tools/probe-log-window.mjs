/**
 * Print the session events in one time window, so "the phone's message vanished" can be
 * told apart from "it arrived and was consumed".
 *
 * Usage: node tools/probe-log-window.mjs <sessionIdFragment> <fromEpochMs> <toEpochMs>
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const root = 'C:\\Users\\chany\\.dsh\\sessions';
const fragment = process.argv[2] ?? 'session-5020c98a';
const from = Number(process.argv[3] ?? 0);
const to = Number(process.argv[4] ?? Date.now());

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
      // one bad frame costs that frame
    }
  });
  return parts.join('');
}

const target = logs(root).find((path) => path.includes(fragment));
if (target === undefined) {
  console.log(`no log matching ${fragment}`);
  process.exit(1);
}
const events = readLog(target).split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => { try { return JSON.parse(line); } catch { return null; } })
  .filter((event) => event !== null && Number.isFinite(event.time))
  .filter((event) => event.time >= from && event.time <= to)
  .sort((a, b) => a.time - b.time);

console.log(`${target}\nevents in [${new Date(from).toISOString()} … ${new Date(to).toISOString()}]: ${events.length}`);
for (const event of events) {
  const time = new Date(event.time).toISOString().slice(11, 23);
  const data = event.data ?? {};
  let summary = '';
  if (event.type === 'user/message') {
    const text = Array.isArray(data.content) ? data.content.map((part) => part?.text ?? '').join('') : '';
    summary = `source=${JSON.stringify(data.source ?? null).slice(0, 90)} text=${JSON.stringify(String(text).slice(0, 80))}`;
  } else if (event.type.includes('inbox')) {
    summary = JSON.stringify(data).slice(0, 260);
  } else if (event.type.includes('queue') || event.type.includes('steer') || event.type.includes('prompt')) {
    summary = JSON.stringify(data).slice(0, 260);
  } else if (event.type.startsWith('turn/') || event.type.startsWith('step/')) {
    summary = JSON.stringify(data).slice(0, 120);
  }
  console.log(`${time} ${event.seq ?? '?'} ${event.type} ${summary}`);
}
