/**
 * The isolated DSH instance this repository is tested against.
 *
 * Why this exists: the plugin runs **inside** `dsh web`, so verifying a change normally means
 * restarting the process that hosts the conversation — which the agent cannot do to itself
 * (its shells are children of that process, so killing it also kills the ability to observe or
 * repair the result). The sandbox is a second `DSH_HOME` with its own profile and port, whose
 * plugin entry is a link to this repository; restarting it costs nothing and proves the same
 * source. See `README.md` → "Safe isolated DSH smoke test".
 *
 * Usage:
 *   node tools/sandbox.mjs start     # start it (or restart it if the source moved on)
 *   node tools/sandbox.mjs stop
 *   node tools/sandbox.mjs status
 *
 * Only ever touches the pid it recorded and port 3081: the real instance on 3080 is not this
 * tool's business.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sandboxHome = join(repoRoot, '.sandbox', 'dsh-home');
const pidFile = join(repoRoot, '.sandbox', 'sandbox.pid');
const logFile = join(repoRoot, '.sandbox', 'sandbox.log');
const profile = 'cindy-smoke';
const port = 3081;
const base = `http://127.0.0.1:${port}`;

/** Whether a process with this id is alive. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function recordedPid() {
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * The process actually listening on our port.
 *
 * A recorded pid is not enough: the first version of this tool spawned through a shell, so the
 * pid it wrote was the shell's and `stop` killed nothing while the server kept the port. The
 * listener is the truth, and adopting it is also how a hand-started instance becomes stoppable.
 */
function listenerPid() {
  try {
    const output = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
    for (const line of output.split(/\r?\n/)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 5) continue;
      if (columns[1] !== `127.0.0.1:${port}` && columns[1] !== `[::1]:${port}` && columns[1] !== `0.0.0.0:${port}`) continue;
      if (columns[3] !== 'LISTENING') continue;
      const pid = Number(columns[4]);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
  } catch {
    // No netstat (or no permission): fall back to the recorded pid alone.
  }
  return null;
}

/** Ask the sandbox's own status route whether it is up, and what it is serving. */
async function probe(timeoutMs = 1500) {
  try {
    const response = await fetch(`${base}/api/dsh-cindy-host/status`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json();
    return { ok: true, body };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function waitForUp(attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const probed = await probe();
    if (probed.ok) return probed.body;
    await new Promise((done) => setTimeout(done, 500));
  }
  return null;
}

async function stop() {
  for (const pid of [recordedPid(), listenerPid()]) {
    if (pid === null || !alive(pid)) continue;
    process.kill(pid);
    for (let attempt = 0; attempt < 20 && alive(pid); attempt += 1) {
      await new Promise((done) => setTimeout(done, 250));
    }
  }
  rmSync(pidFile, { force: true });
  const probed = await probe();
  console.log(probed.ok ? `port ${port} still answering — another instance owns it` : 'sandbox stopped');
}

async function start() {
  if (!existsSync(join(sandboxHome, 'settings.yaml'))) {
    console.error(`no sandbox home at ${sandboxHome} — see README.md → "Safe isolated DSH smoke test" for the one-time setup`);
    process.exitCode = 1;
    return;
  }
  const running = await probe();
  if (running.ok) {
    // Adopt whatever holds the port, so a hand-started instance is stoppable by this tool.
    const adopted = listenerPid();
    if (adopted !== null) writeFileSync(pidFile, String(adopted), 'utf8');
    console.log(`already running: state=${running.body.status?.state ?? '?'} dataSource=${running.body.diagnostics?.dataSource ?? '?'}`);
    console.log('(the plugin entry is a link to this repo, so a restart is what loads new source: node tools/sandbox.mjs stop && node tools/sandbox.mjs start)');
    return;
  }
  mkdirSync(dirname(logFile), { recursive: true });
  // Prefer the published entry point over the `dsh` shim: spawning a `.cmd` needs a shell, and
  // a shell re-parsing these arguments is both a warning and a needless failure mode. The
  // shim is only a fallback for a machine where the package layout is not the npm default.
  const globalBin = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  const viaNode = existsSync(globalBin);
  const out = viaNode
    ? spawn(process.execPath, [globalBin, '--profile', profile, '--no-open', '--port', String(port)], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: sandboxHome },
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: true,
    })
    : spawn('dsh', ['--profile', profile, '--no-open', '--port', String(port)], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: sandboxHome },
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: true,
      shell: true,
    });
  writeFileSync(pidFile, String(out.pid), 'utf8');
  out.unref();
  const up = await waitForUp();
  if (up === null) {
    console.error(`sandbox did not answer on ${base} — see ${logFile}`);
    process.exitCode = 1;
    return;
  }
  const diagnostics = up.diagnostics ?? {};
  console.log(`sandbox up on ${base} (pid ${out.pid})`);
  console.log(`  state=${up.status?.state ?? '?'}  dataSource=${diagnostics.dataSource ?? '?'}  projectedSessions=${diagnostics.projectedSessions ?? '?'}`);
  console.log(`  diagnostics: handlerErrors=${diagnostics.handlerErrors?.length ?? 'n/a'}  listing=${JSON.stringify(diagnostics.listing ?? null)}`);
  console.log('  transport is off by design: this home has no Cindy login of its own, so it cannot claim the phone link');
}

const command = process.argv[2] ?? 'status';
if (command === 'start') await start();
else if (command === 'stop') await stop();
else {
  const probed = await probe();
  if (!probed.ok) console.log(`sandbox is not answering on ${base} (${probed.reason})`);
  else {
    const body = probed.body;
    console.log(`sandbox ${base}: state=${body.status?.state ?? '?'} dataSource=${body.diagnostics?.dataSource ?? '?'} sessions=${body.diagnostics?.projectedSessions ?? '?'}`);
    console.log(`  handlerErrors=${body.diagnostics?.handlerErrors?.length ?? 'n/a'} listing=${JSON.stringify(body.diagnostics?.listing ?? null)}`);
  }
}
