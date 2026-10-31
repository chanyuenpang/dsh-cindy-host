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
  the current turn can finish. **The tool checks nothing about consent** — the `ask_user_question`
  gate lives in the skill, see Consequences;
- the relaunch argv — including the subcommand — is copied from the target process, never
  guessed; the tool refuses when it cannot read one, and warns when the target names no
  `--port` and a non-default one was asked for;
- the supervisor is started through **WMI** (`Win32_Process.Create`), so no job of the agent's
  owns it, with a plain `detached` spawn kept as a fallback;
- the new instance is spawned **detached** with its stdout/stderr opened onto
  `.sandbox/dsh-web.log`;
- the log is the only thing that survives the caller: `restart: port …, target …, grace …,
  args …`, one `cleanup: …` line per sweep decision, one line per pid stopped, and finally
  `started pid N`. The dry run is where the plan is *read* — it prints the target pid, the argv it
  would replay, the working directory, the sweep's pids (`cleanupPids`) and this log's path. The
  two read differently on purpose: the log answers "what happened", the dry run "what would";
- the stop half is a **sweep of the tree, not one kill**: after the listener is stopped, the rest
  of this DSH's processes are stopped too — the command subprocesses
  (`dsh-subprocess-local/lib/runner.js`, the process that actually holds a pwsh/cmd/node command),
  its own worker children, and the orphans a previous instance left behind. A process belongs to
  this DSH when its command line carries the installed `@deepseek-ai/dsh/` path marker rather than
  the substring `dsh`; the sweep runs **before** the relaunch; `--keep-sandboxes` limits it to the
  target's own tree.

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
- **Stop only the pid on the port** (with `--keep-sandboxes` as the way back to it): rejected as
  the default — it leaves the command subprocesses and worker children alive as orphans, see the
  2026-09-23 entry above.
- **Match targets with the substring `dsh`**: rejected — `claw`'s CLI takes `--host dsh`, so the
  test would stop the process asking for the restart. The installed path marker
  (`@deepseek-ai/dsh/`) is what tells this DSH's processes from a line that merely mentions it.

## Consequences

- An agent can load its own changes into the live instance without asking the user to type
  anything; the user's cost is one page reload (the relaunch opens the browser tab itself). The
  consent the user does give is given in the conversation, not by the tool: **the skill requires an
  `ask_user_question` answer before `--apply`**, and a script cannot check that answer, so the rule
  is enforced where a person can be asked. `--apply` on its own remains the mechanical act.
- **The restart must be announced before it happens, and the default grace is 60 s for that
  reason.** 「如果有重启的话一定要提前告诉我，不然我不知道你已经掉线了」 — a message that arrives
  together with the disconnect is not a warning. So: say it in the conversation, wait long enough
  for it to be read, and only then fire. The tool's default `--grace` is 60 s, not 20 s, so the
  announcement and the countdown cannot be accidentally coincident. **Announcing is not consenting**:
  a message plus a countdown is not an approval, and a default is never read as one — the skill's
  `ask_user_question` gate is what turns "I am about to restart" into "you agreed to this restart".
- **Stopping the tree has a cost that is paid on the machine, not in this repository.** The default
  sweep stops the command subprocesses of every DSH instance running here, so another session's
  in-flight command dies with it. That is accepted because the alternative — a half-dead tree — is
  what makes the new instance come up wrong; `--keep-sandboxes` is the opt-out, and the dry run's
  `cleanupPids` is what you read before paying it.
- The turn in flight dies with the old process. The session survives (its log is durable), but
  **nothing resumes automatically**: the agent is idle until a message arrives, and a message
  from the phone is the recommended wake-up because it does not depend on the web token.
- If every attempt fails, the instance is **down** and a person must start it. That is the
  failure mode this tool cannot remove, and the log says so explicitly.
- **The two copies have no shared code, so nothing catches a drift.** This repository's
  `tools/restart-host.mjs` is unit-tested; the skill's
  `~/.agents/skills/dsh-restart/scripts/restart-dsh.mjs` is outside the repository and no test here
  reads it. They must be changed in the same pass, and the change is verified by diffing the two
  files rather than by a green test run.
- The instance being restarted must not be the one whose `--dsh-home` provides a different
  device identity: the identity check exists so a wrong `DSH_HOME` cannot silently move the
  Host onto someone else's credentials.
- **The capability is also a global skill** (`~/.agents/skills/dsh-restart`, 2026-09-17), because
  "restart DSH" is not specific to this repository: any agent, in any project, hits the same
  problem — the process it must restart is its own parent, inside a job it cannot escape. The
  skill carries the same measured facts (a WMI supervisor; a detached child with file-backed
  output; a tree sweep before the relaunch) and the same rules (ask and get consent, announce,
  60 s grace, nothing resumes on its own, failure means DSH stays down). It has no repository
  dependency: its logs go to `~/.agents/logs/dsh-restart/`, and the relaunch's working directory is
  the caller's unless `--cwd` says otherwise. The two copies must be changed together — the skill's
  path is not in this repository, so nothing here fails when they drift.

<!-- state: history -->
## Decision evolution

<!-- dated: 2026-09-23 -->
### The stop half became a sweep: one kill leaves orphans

Killing the pid on the port was read as "stopped it", and it is not. The process the harness runs
a command in is `@deepseek-ai/dsh-subprocess-local/lib/runner.js` — a child of that host, but
**not a member of a job object on the way down**, so when the listener is killed the runner
survives as an orphan holding a shell, a pipe and sometimes a handle on the log file the relaunch
is about to open. Measured while preparing this change: 4 such runners alive under one host (pids
47192, 56944, 60512 and the one running the measurement). A tree that is only half dead is the
state that makes the next start look hung, so "stop it" now means stop the tree.

The sweep runs **before** the relaunch — after the relaunch, new and old compete for the same
pipes and log files, which is the symptom being removed. It identifies its targets by the
installed `@deepseek-ai/dsh/` **path marker** in the command line, plus the target's descendants
through `ParentProcessId`. A `*dsh*` substring test was rejected on evidence rather than taste:
`claw`'s own CLI is invoked with `--host dsh`, and the session that asks for a restart is running
inside one — a substring match would have killed the requester. The sweep also excludes its own
pid and its parent's, or it would kill the **supervisor executing the sweep**, which is itself a
descendant of the host being stopped.

Costs and escape hatches: the default sweep stops command subprocesses of **every** DSH instance on
the machine, including commands another session is in the middle of; `--keep-sandboxes` narrows it
to the target's tree. The dry run prints the exact list it would stop (`cleanupPids`), so the list
is read before it is applied. What the sweep does not do is verify: the restart log gets a
`cleanup: stopping N dsh process(es) … — pids …` line and names anything still alive after 2.5 s,
and reading that is still the reader's job.

The same sweep, the same marker and the same flag went into the global skill copy in the same
change (`~/.agents/skills/dsh-restart/scripts/restart-dsh.mjs`); the two copies' sweep code is
byte-identical. The skill additionally requires an `ask_user_question` answer before `--apply` —
consent is enforced where a person can actually be asked, which is not inside a script.
`tools/restart-host.mjs` went from 186 lines to 311 (130 insertions, 5 deletions).

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
