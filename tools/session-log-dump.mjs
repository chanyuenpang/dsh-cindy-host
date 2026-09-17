#!/usr/bin/env node
/**
 * Dump one DSH session log's event types and message sources.
 *
 * Why this exists: a `.jsonl.zstd` session log is written as MANY zstd frames —
 * one per append — while `zstdDecompressSync` decodes only the FIRST frame. A
 * synchronous read therefore reports a one-line session and hides everything
 * that was ever said, which reads exactly like "this session is empty". The
 * stream decoder walks every frame.
 *
 * Usage: node tools/session-log-dump.mjs <session-id> [--messages|--types]
 */
import { createZstdDecompress, zstdDecompressSync as decompressSync } from 'node:zlib';
import { createReadStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const sessionId = process.argv[2];
if (sessionId === undefined) {
  console.error('usage: node tools/session-log-dump.mjs <session-id> [--messages|--types]');
  process.exit(2);
}
const mode = process.argv.includes('--types') ? 'types' : 'messages';

const root = path.join(process.cwd(), '.sandbox', 'dsh-home', 'sessions');
const dirs = await readdir(root, { withFileTypes: true });
let file;
for (const dir of dirs) {
  if (!dir.isDirectory()) continue;
  const candidate = path.join(root, dir.name, sessionId, 'session.v3.jsonl.zstd');
  try {
    await readdir(path.dirname(candidate));
    file = candidate;
  } catch {
    // Not this workspace directory.
  }
}
if (file === undefined) {
  console.error(`no session log for ${sessionId}`);
  process.exit(1);
}

const chunks = [];
await new Promise((resolve, reject) => {
  const stream = createReadStream(file).pipe(createZstdDecompress());
  stream.on('data', (chunk) => chunks.push(chunk));
  stream.on('end', resolve);
  stream.on('error', reject);
});
let lines = Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean);

// A session log is appended frame by frame, and the stream decoder stops at the
// first frame boundary — so a session with 163 frames decoded to one line and
// looked empty. Split on the frame magic and decode each frame on its own.
if (lines.length <= 1) {
  const raw = await readFile(file);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const offsets = [];
  for (let i = 0; i + 4 <= raw.length; i += 1) {
    if (raw[i] === magic[0] && raw[i + 1] === magic[1] && raw[i + 2] === magic[2] && raw[i + 3] === magic[3]) offsets.push(i);
  }
  const decoded = [];
  for (let i = 0; i < offsets.length; i += 1) {
    const frame = raw.subarray(offsets[i], i + 1 < offsets.length ? offsets[i + 1] : raw.length);
    try {
      decoded.push(decompressSync(frame).toString('utf8'));
    } catch {
      // A magic-looking byte pair inside a frame's payload splits it in two; the
      // halves that fail simply contribute nothing.
    }
  }
  lines = decoded.join('').split('\n').filter(Boolean);
  console.log(`frames: ${offsets.length}`);
}

const counts = {};
const rows = [];
for (const line of lines) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  counts[event.type] = (counts[event.type] ?? 0) + 1;
  // Message events do not share one payload shape: `assistant/message` nests the
  // message under `data.message`, while `user/message` and `system/message` carry
  // the message fields on `data` itself (`'user/message': UserMessage` in
  // dsh-session). Reading only the nested form is how a session with three user
  // messages dumped as two rows and looked like the human had barely spoken.
  const message = event.data?.message ?? (event.data?.role !== undefined ? event.data : undefined);
  if (message === undefined || typeof message !== 'object') continue;
  const blocks = Array.isArray(message.content) ? message.content : [];
  const preview = blocks
    .map((block) => (typeof block?.text === 'string' ? block.text : `<${block?.type ?? '?'}>`))
    .join(' | ')
    .replace(/\s+/g, ' ')
    .slice(0, 150);
  rows.push({
    type: event.type,
    role: message.role,
    source: JSON.stringify(message.source ?? null),
    preview,
  });
}

console.log(`file: ${file}`);
console.log(`events: ${lines.length}`);
console.log(`types: ${JSON.stringify(counts)}`);
if (mode === 'types') process.exit(0);
console.log('--- messages (role / source / preview) ---');
for (const row of rows) {
  console.log(`${String(row.role).padEnd(9)} ${row.source.padEnd(60)} ${row.preview}`);
}
