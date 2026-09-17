/**
 * Restart the `dsh web` that owns a port — including the one hosting this conversation.
 *
 * The job is two statements: stop it, start it. Everything else here exists because of two
 * measured facts (the reasoning is in ADR-0009), and nothing else is kept:
 *
 * 1. The process running those statements is a **child of the process being stopped**, inside a
 *    Windows job object belonging to the command that started it — so the kill is done by a
 *    supervisor started through **WMI**, which no job of ours owns.
 * 2. The instance it starts must be **detached with its output on a file**: non-detached it dies
 *    with the supervisor, and piped output is an EPIPE that DSH's fail-loud handler turns into
 *    `exit(1)`. Both killed the instance that had just come up.
 *
 * It does not verify anything. Whether the new instance came up is a question for whoever looks
 * next (`/status`, or the log this writes), and a restart a person performs by hand does not
 * verify either.
 *
 * Usage:
 *   node tools/restart-host.mjs                      # dry run: what would happen
 *   node tools/restart-host.mjs --apply --grace 20   # do it, 20s from now
 */
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const logFile = join(repoRoot, '.sandbox', 'host-restart.log');
/** Where the relaunched instance's own output goes: a file, so it outlives the supervisor. */
const childLog = join(repoRoot, '.sandbox', 'dsh-web.log');
const settle = (ms) => new Promise((done) => setTimeout(done, ms));

/** `--apply` is the only thing that changes behaviour; a dry run is the default. */
export function parseArgs(argv) {
  const options = { apply: false, graceSeconds: 20, port: 3080, dshHome: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--apply') options.apply = true;
    else if (flag === '--supervise') options.supervise = true;
    else if (flag === '--grace') { options.graceSeconds = Number(argv[index + 1]); index += 1; }
    else if (flag === '--port') { options.port = Number(argv[index + 1]); index += 1; }
    else if (flag === '--dsh-home') { options.dshHome = argv[index + 1]; index += 1; }
  }
  return options;
}

/**
 * The argv to hand a fresh `dsh`, copied from the target's own command line.
 *
 * Copied, not assumed: a wrong `--profile` costs a login and a wrong `--port` moves the instance
 * away from the page the user is holding. The **subcommand counts** — the live instance's tail is
 * `… bin.js web`, so a flag-only copy would start `dsh` with no command at all.
 * @param commandLine - the target process's command line.
 * @returns the argv for a fresh `dsh` (subcommand first), or `[]` when it cannot be read.
 */
export function launchArgsFrom(commandLine) {
  const text = typeof commandLine === 'string' ? commandLine : '';
  const marker = text.lastIndexOf('bin.js');
  if (marker === -1) return [];
  const tail = text.slice(marker + 'bin.js'.length).trim();
  const args = [];
  const subcommand = tail.match(/^([a-zA-Z][\w-]*)/);
  if (subcommand !== null) args.push(subcommand[1]);
  const profile = tail.match(/--profile\s+("([^"]+)"|(\S+))/);
  const port = tail.match(/--port\s+(\d+)/);
  if (profile !== null) args.push('--profile', profile[2] ?? profile[3]);
  if (port !== null) args.push('--port', port[1]);
  return args;
}

function log(line) {
  mkdirSync(dirname(logFile), { recursive: true });
  appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, 'utf8');
}

/** The pid listening on a local port, via netstat: the truth, with no dependency. */
function listenerPid(port) {
  try {
    const output = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
    for (const line of output.split(/\r?\n/)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 5 || columns[3] !== 'LISTENING' || !columns[1].endsWith(`:${port}`)) continue;
      const pid = Number(columns[4]);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
  } catch {
    // no netstat: the caller decides what to do with null
  }
  return null;
}

function commandLineOf(pid) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** The detached half: stop, then start. Two statements, and a line for each. */
async function supervise({ port, graceSeconds, dshHome }) {
  const oldPid = listenerPid(port);
  const args = oldPid === null ? [] : launchArgsFrom(commandLineOf(oldPid));
  log(`restart: port ${port}, target ${oldPid ?? 'none'}, grace ${graceSeconds}s, args ${JSON.stringify(args)}`);
  if (oldPid !== null && args.length === 0) {
    log('refusing: the target has no readable subcommand, so a relaunch would start `dsh` bare');
    process.exit(1);
  }
  if (oldPid !== null) {
    await settle(Math.max(0, graceSeconds) * 1000);
    try {
      process.kill(oldPid);
    } catch (error) {
      log(`kill failed: ${error.message}`);
    }
    for (let attempt = 0; attempt < 20 && listenerPid(port) !== null; attempt += 1) await settle(250);
  }

  const globalBin = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!existsSync(globalBin)) {
    log(`cannot find ${globalBin}; start the instance by hand`);
    process.exit(1);
  }
  const sink = openSync(childLog, 'a');
  const child = spawn(process.execPath, [globalBin, ...args], {
    cwd: repoRoot,
    env: dshHome === null || dshHome === undefined ? process.env : { ...process.env, DSH_HOME: dshHome },
    stdio: ['ignore', sink, sink],
    detached: true,
  });
  closeSync(sink);
  child.unref();
  log(`started pid ${child.pid}`);
  process.exit(0);
}

// Importing this file for its pure helpers must not run the CLI.
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const options = parseArgs(process.argv.slice(2));
if (!isMain) {
  // imported, not run
} else if (options.supervise) {
  await supervise(options);
} else {
  const pid = listenerPid(options.port);
  console.log(JSON.stringify({
    port: options.port,
    targetPid: pid,
    relaunchArgs: pid === null ? [] : launchArgsFrom(commandLineOf(pid)),
    dshHome: options.dshHome ?? process.env.DSH_HOME ?? '(inherited default)',
    graceSeconds: options.graceSeconds,
    mode: options.apply ? 'APPLY' : 'DRY RUN',
  }, null, 2));
  if (!options.apply) {
    console.log('\ndry run: nothing was touched. --apply kills the target and starts it again.');
  } else {
    // Through WMI: this process is a child of the very pid that is about to die, and a plain
    // `detached` child stays inside the harness's per-command job object (ADR-0009).
    const superviseArgs = [fileURLToPath(import.meta.url), '--supervise', '--port', String(options.port), '--grace', String(options.graceSeconds), ...(options.dshHome === null ? [] : ['--dsh-home', options.dshHome])];
    const commandLine = [process.execPath, ...superviseArgs].map((part) => `"${part}"`).join(' ');
    let via = 'wmi';
    try {
      execFileSync('powershell', ['-NoProfile', '-Command', `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${commandLine.replace(/'/g, "''")}' } | Out-Null`], { encoding: 'utf8' });
    } catch {
      via = 'spawn';
      const helper = spawn(process.execPath, superviseArgs, { cwd: repoRoot, env: process.env, stdio: 'ignore', detached: true });
      helper.unref();
    }
    log(`requested: port ${options.port}, grace ${options.graceSeconds}s, via ${via}`);
    console.log(`\nAPPLY: restarting port ${options.port} in ${options.graceSeconds}s (via ${via}).`);
    console.log(`outcome goes to ${logFile}; this process may be killed in the meantime.`);
  }
}
