# Projection read probe

How the projection *read* path behaves against a live Host, and the one defect
the probe found. The read path is the only part of the controller surface that
must never wake a session: `maker:goal:get-status` and
`maker:input:get-projection` are answered from state folded out of
`sessionController.control()`, and `local-db:sessions:list` is the phone's
device-responsiveness probe.

## Running the probes

They talk to the loopback selftest route of a running smoke Host (README, *Safe
isolated DSH smoke test*) and write nothing outside `.sandbox/`:

```powershell
pwsh -NoProfile -File .sandbox/probe-projection-read.ps1    # reads + the goal round trip
pwsh -NoProfile -File .sandbox/probe-queue-round-trip.ps1   # read -> enqueue -> read
pwsh -NoProfile -File .sandbox/probe-first-send.ps1         # create -> maker:send -> answer
pwsh -NoProfile -File .sandbox/probe-projection-frames.ps1  # does a live frame land at all
```

The round-trip probes send real prompts to a throwaway session they create
themselves, or to the `session-selftest-*` session, never to the user's own
transcript.

## Measured on a live Host

| Channel | Observed |
| --- | --- |
| `local-db:sessions:list` | 8–11 ms, two rows, full controller row shape |
| `maker:goal:get-status` | 1–2 ms |
| `maker:input:get-projection` | 1–3 ms |
| `maker:input:enqueue` | 5–8 ms, and the answer already carries the accepted item |
| `maker:send` on a fresh session | 5–7 ms accepted; prompt in the log within 1.5 s |

Reading a projection does not resume a session: a cold session's `running` flag
and `updatedAt` were both unchanged after a burst of goal and queue reads, and
its goal status stayed `null`.

The enqueue round trip closes in order. The Host's answer carries the accepted
item because it is folded from local state, which proves the **write**; the next
read no longer has it, which proves the **stream** — nothing else writes that
state, so only DSH's own queue frame can have replaced it. The marker prompt then
appears in the session log and the session answers it.

## Defect found: the goal read ignored the stream baseline

`sessionController.control()` is *a baseline followed by replacements*, and a
replacement frame only follows a **change**. `createProjectionTracker` in
`src/host-goals.js` matched `frame.type === 'projection'` and nothing else, so
the entire baseline was discarded — including every goal that existed before the
Host connected, or that was created while it was disconnected. The controller
showed "no goal" for a goal that existed, and no live frame would ever correct
it, because the goal had not changed since.

The probe showed the symptom before the cause: `maker:goal:set` was accepted and
the write returned an active goal, while six consecutive
`maker:goal:get-status` reads over 4.2 s all returned `null`. The sibling tracker
for the input queue (`src/host-input-queue.js`) already consumed the baseline,
which is what made the omission in the goal tracker visible.

`apply` now folds the baseline — `frame.value.projections[sessionId].values.goal`
— and **replaces** the folded state rather than merging into it, so frames from a
previous stream generation cannot survive a reconnect. Three tests in
`test/host-goals.test.js` cover it: the baseline carries a goal, the baseline
clears stale state, and a baseline without a projection block neither throws nor
invents a goal. After the Host restarted with the fix, the same probe read the
goal back 400 ms after the write.

## Contract note

`toGoalStatusPayload` distinguishes `undefined` ("never fetched") from `null`
("fetched, no goal"), but the channel replies with `goalStatus(sessionId) ?? null`,
so the wire never carries the distinction: unknown and absent look identical. That
is deliberate — a relay reply has to carry a value — but it means the
"never fetched" branch in the mapper is only observable in unit tests, not by the
controller.
