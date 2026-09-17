/**
 * Walk one session's transcript backwards and report the pages that carry an
 * attachment, so an inlined picture can be checked against the real page budget.
 *
 * Usage: node tools/probe-image-page.mjs <sessionId> [steps] [limit]
 */
const [sessionId, stepsArg, limitArg] = process.argv.slice(2);
if (!sessionId) {
  console.error('usage: node tools/probe-image-page.mjs <sessionId> [steps] [limit]');
  process.exit(1);
}
const steps = Number(stepsArg ?? 6);
const limit = Number(limitArg ?? 200);

async function call(args) {
  const started = Date.now();
  const response = await fetch('http://127.0.0.1:3080/api/dsh-cindy-host/selftest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'local-db:messages:list', args }),
  });
  const body = await response.json();
  return { elapsed: Date.now() - started, payload: body?.reply?.payload, bytes: Buffer.byteLength(JSON.stringify(body?.reply ?? {}), 'utf8') };
}

async function counters() {
  const response = await fetch('http://127.0.0.1:3080/api/dsh-cindy-host/status');
  const body = await response.json();
  return body?.diagnostics?.attachmentReads ?? null;
}

let before;
for (let step = 0; step < steps; step += 1) {
  const args = before === undefined ? [sessionId, { limit }] : [sessionId, { limit, before }];
  const { elapsed, payload, bytes } = await call(args);
  if (payload?.ok !== true) {
    console.log(`step ${step}: FAILED ${JSON.stringify(payload?.error)}`);
    break;
  }
  const rows = payload.result;
  const withFiles = rows.filter((row) => Array.isArray(row?.content?.files) && row.content.files.length > 0);
  const withImages = rows.filter((row) => Array.isArray(row?.content?.images) && row.content.images.length > 0);
  const inlined = withImages.reduce((sum, row) => sum + row.content.images.reduce((inner, image) => inner + (image.base64?.length ?? 0), 0), 0);
  console.log(`step ${step}: rows=${rows.length} bytes=${bytes} ${elapsed}ms  rowsWithFiles=${withFiles.length} rowsWithImages=${withImages.length} inlinedBase64=${inlined}`);
  for (const row of withFiles.slice(0, 4)) {
    console.log(`    ${row.createdAt} ${row.role} files=${JSON.stringify(row.content.files.map((entry) => ({ name: entry.name, size: entry.size })))} images=${row.content.images?.length ?? 0}`);
  }
  console.log(`    attachmentReads=${JSON.stringify(await counters())}`);
  const oldest = rows[rows.length - 1];
  if (!oldest) break;
  before = oldest.id;
}
