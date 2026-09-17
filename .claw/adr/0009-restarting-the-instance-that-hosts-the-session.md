# ADR: Restarting the instance that hosts the session

## Context

This plugin runs **inside** `dsh web`, and an agent's shells are children of that process. So
"restart DSH to load the new code" means killing the tree the agent is standing in, and every
attempt to do it from an ordinary command has failed in a different way:

- The agent's command runs inside a **Windows job object** the harness creates per command. A
  child spawned with `detached: true` does **not** escape a job without
  `CREATE_BREAKAWAY_FROM_JOB`, so the process that was supposed to do the restart is reaped when
  the command ends. Measured: two of three live restarts worked and the third did nothing at
  all, which from the user's side is indistinguishable from having not tried.
- The relaunched instance must be started **detached**; with `detached: false` it answered for
  20 s and died seconds after the helper exited.
- Its output must go to a **file**, not a pipe. Destroying the pipes before exiting the helper
  killed the instance it had just started: DSH writes to stdout, a destroyed pipe is an EPIPE,
  and DSH's fail-loud handler turns that into `exit(1)`.
- A fresh `dsh web` prints a **new** token URL, so the page holding the old one cannot reconnect
  on its own.
- A single liveness probe is not a verdict: the first version logged `NOT ALIVE 20s after it came
  up` for an instance that then served for two more minutes, because a 1.5 s probe during the
  boot window (cost-meter backfill, session replay) times out.

## Decision

`tools/restart-host.mjs` restarts an instance by **reading the target's own command line** and
replaying it:

- dry run by default (`npm run restart`); `--apply` fires it, `--grace <seconds>` holds off so
  the current turn can finish;
- the relaunch argv — including the subcommand — is copied from the target process, never
  guessed; the tool refuses when it cannot read one, and warns when the target names no
  `--port` and a non-default one was asked for;
- the supervisor is started through **WMI** (`Win32_Process.Create`), so no job of the agent's
  owns it, with a plain `detached` spawn kept as a fallback;
- the new instance is spawned **detached** with its stdout/stderr opened onto
  `.sandbox/dsh-web.log`;
- the outcome — new pid, the token URL to reopen, `state`, `identity`, `boundaries`,
  `handlerErrors` — is appended to `.sandbox/host-restart.log`, because the process that asked
  for the restart is dead by the time there is anything to read;
- liveness is confirmed by repeated probes after a settle window, not one sample, and a death is
  reported with the launch output attached;
- identity is compared before and after (`status.host.deviceId`) and an inconclusive answer is
  reported as inconclusive rather than as a change.

<!-- state: history -->
## Decision evolution

<!-- dated: 2026-09-17 -->
### The tool got smaller twice, and the second time it stopped verifying

The first version carried retries, an identity comparison, token scraping and a plan dump; the
user's response was 「你的脚本很简单，就是关闭掉DSH再启动DSH就可以了」, and it was right — 327 lines
became 198 with only the reasons above kept.

Then the same user, after watching it work: 「重启脚本可以搞简单一点，我自己手动重启的话也是很简单，
不会验证什么」. The `up: state=…` and `alive 20s later` lines were the last of the verification
machinery, and they are gone: 173 lines, two log lines per restart (`restart: …`, then
`started pid …`). The repeated probe those lines were built on earned its place once — it caught
the instance that died because it had not been detached — but once that failure mode is understood
and the spawn is detached, re-asserting it on every run buys nothing the next `/status` read does
not already give. Whether the instance came up is a question for whoever looks next, which is how
a by-hand restart works too.

## Alternatives

- **"Just two statements in one command"** — kill, then start: rejected. The second statement's
  process lives in the tree being killed and inside a job that is closed with the command;
  measured to be reaped.
- **Keep the supervisor as a `detached` child of the agent's command**: rejected as unreliable —
  1 in 3 measured failures, silent.
- **A Windows scheduled task run on demand**: workable and rejected only because it is heavier
  than WMI for the same effect — it needs task creation, cleanup, and system state that a
  one-shot helper does not.
- **Stream the new instance's output through pipes to capture the token**: rejected — measured
  fatal (EPIPE) once the helper exits.
- **One liveness probe, or none**: rejected — the probe is the only thing that distinguishes
  "the server answered once" from "the server is running", and the earlier versions of this tool
  each reported a wrong verdict at least once.

## Consequences

- An agent can load its own changes into the live instance without asking the user to type
  anything; the user's cost is one page reload (the relaunch opens the browser tab itself).
- **The restart must be announced before it happens, and the default grace is 60 s for that
  reason.** 「如果有重启的话一定要提前告诉我，不然我不知道你已经掉线了」 — a message that arrives
  together with the disconnect is not a warning. So: say it in the conversation, wait long enough
  for it to be read, and only then fire. The tool's default `--grace` is 60 s, not 20 s, so the
  announcement and the countdown cannot be accidentally coincident.
- The turn in flight dies with the old process. The session survives (its log is durable), but
  **nothing resumes automatically**: the agent is idle until a message arrives, and a message
  from the phone is the recommended wake-up because it does not depend on the web token.
- If every attempt fails, the instance is **down** and a person must start it. That is the
  failure mode this tool cannot remove, and the log says so explicitly.
- The instance being restarted must not be the one whose `--dsh-home` provides a different
  device identity: the identity check exists so a wrong `DSH_HOME` cannot silently move the
  Host onto someone else's credentials.
- **The capability is also a global skill** (`~/.agents/skills/dsh-restart`, 2026-09-17), because
  "restart DSH" is not specific to this repository: any agent, in any project, hits the same
  problem — the process it must restart is its own parent, inside a job it cannot escape. The
  skill carries the same two measured facts (a WMI supervisor; a detached child with file-backed
  output) and the same rules (announce first, 60 s grace, nothing resumes on its own, failure
  means DSH stays down). It has no repository dependency: its logs go to
  `~/.agents/logs/dsh-restart/`, and the relaunch's working directory is the caller's unless
  `--cwd` says otherwise.
