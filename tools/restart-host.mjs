/**
 * Restart the `dsh web` instance that owns a port — including the one hosting the conversation.
 *
 * Why this needs a script rather than a command: the agent's shells are **children** of that
 * process, so killing it also kills the shell that would do the verifying, and the turn dies
 * half-written. Everything after the kill therefore has to happen in a process that is not in
 * that tree: this file re-launches itself detached, and the detached half does the killing,
 * starting, waiting and reporting.
 *
 * What it cannot fix: a fresh `dsh web` prints a **new** token URL, so the page holding the old
 * one has to be reopened. That is true of a manual restart too — the script saves the typing,
 * not the reconnect.
 *
 * Usage:
 *   node tools/restart-host.mjs                      # dry run: print exactly what would happen
 *   node tools/restart-host.mjs --apply --grace 30   # do it, 30s from now
 *   node tools/restart-host.mjs --apply --grace 0 --port 3081
 *
 * The outcome (new pid, the token URL to open, the status and diagnostics snapshot) is appended
 * to `.sandbox/host-restart.log`, because the process that asked for the restart is dead by the
 * time there is anything to read.
 */
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const logFile = join(repoRoot, '.sandbox', 'host-restart.log');

/** Parse `--flag value` pairs, with a dry run as the default. */
export function parseArgs(argv) {
  const options = { apply: false, graceSeconds: 20, port: 3080, retries: 3, dshHome: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--apply') options.apply = true;
    else if (flag === '--supervise') options.supervise = true;
    else if (flag === '--grace') { options.graceSeconds = Number(value); index += 1; }
    else if (flag === '--port') { options.port = Number(value); index += 1; }
    else if (flag === '--retries') { options.retries = Number(value); index += 1; }
    else if (flag === '--dsh-home') { options.dshHome = value; index += 1; }
  }
  return options;
}

/**
 * The arguments the target was started with, read from its own command line.
 *
 * Restarting with different ones would silently move the instance — a `--profile` typo costs a
 * login, a wrong `--port` costs the page the user is holding — so they are copied, not assumed,
 * and the **subcommand** is part of them: the live instance's tail is `… bin.js web`, so a
 * relaunch that copied only the flags would start `dsh` with no command at all.
 *
 * @param commandLine - the target process's command line.
 * @returns the argv to hand a fresh `dsh` (subcommand first).
 */
export function launchArgsFrom(commandLine) {
  const text = typeof commandLine === 'string' ? commandLine : '';
  const marker = text.lastIndexOf('bin.js');
  // No `bin.js` at all means this is not a `dsh` entry point, and guessing a subcommand from an
  // arbitrary tail is how a restart turns into `dsh dable`.
  if (marker === -1) return [];
  const tail = text.slice(marker + 'bin.js'.length).trim();
  const args = [];
  // The subcommand is the first bare token after bin.js; flags may follow it in any order.
  const subcommand = tail.match(/^([a-zA-Z][\w-]*)/);
  if (subcommand !== null) args.push(subcommand[1]);
  const profile = tail.match(/--profile\s+("([^"]+)"|(\S+))/);
  const port = tail.match(/--port\s+(\d+)/);
  if (profile !== null) args.push('--profile', profile[2] ?? profile[3]);
  if (port !== null) args.push('--port', port[1]);
  return args;
}

/** The token URL a starting `dsh web` prints, or null while it has not printed one yet. */
export function tokenUrlFrom(output, port = 3080) {
  const match = String(output ?? '').match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[A-Za-z0-9_-]+`));
  return match === null ? null : match[0];
}

function log(line) {
  mkdirSync(dirname(logFile), { recursive: true });
  appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, 'utf8');
}

/** The pid listening on a local port, via netstat (no dependency, and it is the truth). */
function listenerPid(port) {
  try {
    const output = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
    for (const line of output.split(/\r?\n/)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 5 || columns[3] !== 'LISTENING') continue;
      if (!columns[1].endsWith(`:${port}`)) continue;
      const pid = Number(columns[4]);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
  } catch {
    // no netstat: caller decides what to do with null
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

async function probe(port, timeoutMs = 1500) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/dsh-cindy-host/status`, { signal: AbortSignal.timeout(timeoutMs) });
    return await response.json();
  } catch {
    return null;
  }
}

/** The detached half: kill, start, wait, report. */
async function supervise({ port, graceSeconds, retries, dshHome }) {
  log(`supervise: start (port ${port}, grace ${graceSeconds}s)`);
  const oldPid = listenerPid(port);
  log(`supervise: target pid=${oldPid ?? 'none'}`);
  const before = await probe(port);
  const beforeDeviceId = before?.status?.host?.deviceId ?? null;
  log(`supervise: identity before = ${beforeDeviceId ?? 'unknown'}`);
  if (oldPid !== null) {
    const args = launchArgsFrom(commandLineOf(oldPid));
    log(`supervise: relaunch args = ${JSON.stringify(args)}`);
    await new Promise((done) => setTimeout(done, Math.max(0, graceSeconds) * 1000));

    const old = await probe(port);
    if (old !== null) {
      try {
        process.kill(oldPid);
      } catch (error) {
        log(`supervise: kill failed: ${error.message}`);
      }
    } else {
      log('supervise: nothing answered the probe, not killing anything');
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (listenerPid(port) === null) break;
      await new Promise((done) => setTimeout(done, 250));
    }

    for (let attempt = 0; attempt < Math.max(1, retries); attempt += 1) {
      const globalBin = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (!existsSync(globalBin)) {
        log(`supervise: cannot find ${globalBin}; the instance must be started by hand`);
        return;
      }
      const child = spawn(process.execPath, [globalBin, ...args], {
        cwd: repoRoot,
        env: dshHome === null || dshHome === undefined ? process.env : { ...process.env, DSH_HOME: dshHome },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
      let output = '';
      child.stdout.on('data', (chunk) => { output += String(chunk); });
      child.stderr.on('data', (chunk) => { output += String(chunk); });
      log(`supervise: attempt ${attempt + 1}, new pid ${child.pid}`);

      let up = null;
      for (let poll = 0; poll < 120; poll += 1) {
        await new Promise((done) => setTimeout(done, 500));
        up = await probe(port);
        if (up !== null) break;
        if (child.exitCode !== null) break;
      }
      if (up !== null) {
        log(`supervise: up after attempt ${attempt + 1}`);
        log(`supervise: reopen ${tokenUrlFrom(output, port) ?? '(token not captured — check the terminal)'}`);
        // The identity check needs the relay handshake, and the status route answers before it:
        // the first probe of a fresh instance says `state=authenticating deviceId=?`. Reporting
        // that as IDENTITY CHANGED is a false accusation, and a check that cries wolf is worse
        // than no check — so wait for a device id, and say "inconclusive" if it never comes.
        let afterDeviceId = up.status?.host?.deviceId ?? null;
        for (let poll = 0; poll < 60 && (afterDeviceId === null || afterDeviceId === ''); poll += 1) {
          await new Promise((done) => setTimeout(done, 500));
          up = (await probe(port)) ?? up;
          afterDeviceId = up.status?.host?.deviceId ?? null;
        }
        log(`supervise: state=${up.status?.state ?? '?'} deviceId=${afterDeviceId ?? '?'}`);
        if (afterDeviceId === null || afterDeviceId === '') {
          log('supervise: identity inconclusive — the instance is up but has not reached the relay yet');
        } else if (beforeDeviceId === null || beforeDeviceId === '') {
          log(`supervise: identity ${afterDeviceId} (the old instance never reported one)`);
        } else {
          log(afterDeviceId === beforeDeviceId
            ? `supervise: identity preserved (${afterDeviceId})`
            : `supervise: IDENTITY CHANGED ${beforeDeviceId} -> ${afterDeviceId} — this relaunched against a different DSH_HOME`);
        }
        log(`supervise: boundaries=${JSON.stringify(up.diagnostics?.boundaries ?? null)}`);
        log(`supervise: handlerErrors=${up.diagnostics?.handlerErrors?.length ?? 'n/a'}`);
        log(`supervise: launch output tail: ${output.trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 600)}`);
        // Let go of the new instance and go away. The pipes were only held to read the token URL,
        // and leaving them attached keeps this process alive for as long as the server runs —
        // measured: two supervisors from two tests were still resident minutes later. One stray
        // process per restart is exactly the kind of leak a restart loop accumulates.
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        log('supervise: done, supervisor exiting');
        process.exit(0);
      }
      log(`supervise: attempt ${attempt + 1} did not answer; output tail: ${output.trim().slice(-600)}`);
    }
    log('supervise: every attempt failed — the instance is DOWN and needs a hand');
    process.exit(1);
  }
  log('supervise: no listener found; nothing to restart');
  process.exit(0);
}

// Importing this file for its pure helpers must not run the CLI — and with process.exit calls
// below, an unguarded block would exit a test process that only wanted parseArgs.
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const options = parseArgs(process.argv.slice(2));
if (!isMain) {
  // imported, not run
} else if (options.supervise) {
  await supervise(options);
} else {
  const pid = listenerPid(options.port);
  const commandLine = pid === null ? '' : commandLineOf(pid);
  const plan = {
    port: options.port,
    targetPid: pid,
    targetCommandLine: commandLine.slice(0, 300),
    relaunchArgs: launchArgsFrom(commandLine),
    dshHome: options.dshHome ?? process.env.DSH_HOME ?? '(inherited default)',
    graceSeconds: options.graceSeconds,
    logFile,
    mode: options.apply ? 'APPLY' : 'DRY RUN',
  };
  console.log(JSON.stringify(plan, null, 2));
  if (options.apply) {
    if (plan.relaunchArgs.length === 0 && pid !== null) {
      console.log('\nrefusing: the target has no readable subcommand, so a relaunch would start `dsh` bare.');
      process.exitCode = 1;
    } else if (!plan.relaunchArgs.includes('--port') && options.port !== 3080) {
      console.log(`\nwarning: the target names no --port, so the relaunch will come up on the default (3080), not ${options.port}.`);
    }
  }
  if (!options.apply) {
    console.log('\ndry run: nothing was touched. Re-run with --apply to kill and relaunch the target.');
    console.log('note: a fresh dsh web prints a NEW token URL — read it from the log above after the restart.');
  } else {
    // Detached and unref'd: this process is a child of the very pid that is about to die.
    const helper = spawn(process.execPath, [fileURLToPath(import.meta.url), '--supervise', '--port', String(options.port), '--grace', String(options.graceSeconds), '--retries', String(options.retries), ...(options.dshHome === null ? [] : ['--dsh-home', options.dshHome])], {
      cwd: repoRoot,
      env: process.env,
      stdio: 'ignore',
      detached: true,
    });
    helper.unref();
    log(`requested: port ${options.port}, target pid ${pid ?? 'none'}, grace ${options.graceSeconds}s, helper pid ${helper.pid}`);
    console.log(`\nAPPLY: supervisor pid ${helper.pid} will restart port ${options.port} in ${options.graceSeconds}s.`);
    console.log(`outcome and the new token URL go to ${logFile}`);
    console.log('this process (and the conversation it hosts) may be killed in the meantime.');
  }
}
