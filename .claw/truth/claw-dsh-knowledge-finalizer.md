# DSH claw knowledge finalizer collector contract

<!-- state: current -->
## Current behavior

A DSH claw knowledge finalizer can write Truth/ADR only after `knowledge.claim` captures the parent session report through the project-scoped `dsh` report collector. The collector descriptor is canonical at `.claw/runtime/report-collectors/dsh.json`; its executable and first script argument must exist and match the adapter package currently loaded by the DSH Profile.

The 2026-10-01 incident affected seven closeouts in parent session `session-2c6245d7-ddd0-4a0f-818c-38ce2af000d2`. DSH did start workers (18 one-shot children including retries), but every worker failed at `knowledge.claim` with `REPORT_COLLECTOR_FAILED: dsh`. Every canonical job remained `reportCapture.pending / queued / attempts: 0`, with no claim token, assignments, `knowledge.done`, or Truth/ADR write. This distinguishes the incident from dispatch failure, an empty knowledge result, and writer file failure.

The immediate fault was a stale descriptor registered as collector version `0.2.39-rc.3` whose script pointed to the removed package path `profiles/web/node_modules/@veewo/dsh-claw-kit/lib/report-collector-cli.js`; the installed adapters were `@veewo/dsh-claw-kit-dev`. Claim-time `collectReport` attempted the stale command, collapsed spawn error/status/stderr into `REPORT_COLLECTOR_FAILED`, and aborted before the durable claim transition. Session-start re-registration errors were swallowed by an empty catch, so the stale descriptor neither self-healed nor produced a diagnostic.

An empty DSH report journal is not this failure: the collector contract deliberately turns missing history or `events: []` into a valid empty capture. Knowledge may still be derived from the canonical plan closeout. Collector failure must therefore be diagnosed from descriptor validity, claim errors, and canonical job state—not from “Truth did not change.”

Required repair properties:

- atomically register or refresh the collector at adapter activation/session start and immediately before queued dispatch;
- validate the executable and script path against the currently loaded adapter identity;
- retain spawn error code, exit status, and stderr in durable diagnostics;
- record a failed/retryable claim attempt instead of leaving jobs forever at `queued / attempts: 0`;
- deduplicate retries by finalizeId and reconcile expired queued jobs;
- verify both a conclusion-bearing report and `events: []` through `claim → assignments → done`.

Implementation/evidence anchors:

- project descriptor: `.claw/runtime/report-collectors/dsh.json`;
- adapter registration and swallowed error: active `@veewo/dsh-claw-kit-dev/lib/index.js`, session-start collector registration;
- claim-time capture: global `@veewo/claw/src/knowledge-command.ts` and `report-collector-registry.ts`;
- DSH report collector empty-history behavior: `@veewo/dsh-claw-kit-dev/lib/report-collector-cli.js`;
- worker failure evidence: `~/.dsh/storages/session_projcache/sessions/<worker-id>.json`.

<!-- state: history -->
## Evolution history

<!-- dated: 2026-09-23 -->
### Last verified successful capture before the stale descriptor incident

Finalizer `97a487b…` captured a 3173-byte DSH report with collector `0.2.39.2`, claimed once, wrote assignments, and completed successfully. It is the comparison proving that the finalization schema and Truth writer can work when report capture succeeds.
