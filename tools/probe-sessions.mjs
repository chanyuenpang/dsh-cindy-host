/**
 * Print the session rows' model/effort/agentKind, so a probe can pick a real target.
 * Usage: node tools/probe-sessions.mjs [--full]
 */
const full = process.argv.includes('--full');
const response = await fetch('http://127.0.0.1:3080/api/dsh-cindy-host/selftest', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ channel: 'local-db:sessions:list', args: [] }),
});
const body = await response.json();
const rows = body?.reply?.payload?.result ?? [];
for (const row of rows) {
  console.log([
    row.id,
    `kind=${row.agentKind ?? '?'}`,
    `model=${row.model ?? '?'}`,
    `effort=${row.effort ?? '?'}`,
    `perm=${row.permissionMode ?? '?'}`,
    `status=${row.status ?? '?'}`,
    `running=${row.running === true}`,
    full ? `title=${row.title}` : '',
  ].filter(Boolean).join('  '));
}
