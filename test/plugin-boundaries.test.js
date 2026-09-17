/**
 * The plugin's host-facing boundaries, and the diagnostic that says whether they are alive.
 *
 * Two failures this file exists for, both measured:
 *
 * 1. An exception that leaves this plugin does not degrade the plugin — it ends the desktop's
 *    whole `dsh web`. DSH's boot installs an unhandled-rejection handler that writes
 *    `fatal load failure` to stderr and calls `process.exit(1)`, and Cordis dispatches
 *    listeners with no `try`/`catch` of its own. That is not a rule a reviewer can be asked to
 *    remember, so it is scanned for: every `ctx.on(` registration in the plugin must go through
 *    the single guarded entry point.
 * 2. A boundary record with nothing in it reads as health, but a boundary that never fires and
 *    one that was never installed are indistinguishable. The verdict below therefore needs an
 *    uptime, and `silent` is a finding rather than a green light.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BOUNDARY_SILENCE_MS, boundaryVerdict, buildDiagnostics } from '../src/dsh-plugin.js';

const source = readFileSync(new URL('../src/dsh-plugin.js', import.meta.url), 'utf8');

test('every listener this plugin registers goes through the guarded entry point', () => {
  // A doc comment mentions `ctx.on(`; count registrations by their opening shape instead.
  const registrations = [...source.matchAll(/ctx\.on\(\s*['"]/g)].length;
  assert.ok(registrations > 0, 'the scan must actually find registrations, or it proves nothing');

  // Every `ctx.on('event', …` must name `guarded` as the listener factory. The identifier is
  // captured rather than looked ahead for: a negative lookahead lets `\s*` backtrack to zero
  // characters and match the space before `guarded(`.
  const unwrapped = [...source.matchAll(/ctx\.on\(\s*'[^']+',\s*([A-Za-z_$][\w$]*)?/g)]
    .filter((match) => match[1] !== 'guarded')
    .map((match) => match[0].trim());
  assert.deepEqual(unwrapped, [], 'a bare ctx.on registration cannot contain its own failure — wrap it in guarded(...)');

  // The seam's own subscribe passthrough is the one exception: it hands the listener to its
  // caller (the session source), which owns its own containment — and it names its event with an
  // identifier, so it is not one of the quoted registrations counted above.
  const guardedCalls = [...source.matchAll(/guarded\('/g)].length;
  assert.equal(guardedCalls, registrations, `${guardedCalls} guarded wrappers for ${registrations} named registrations`);
  assert.equal(
    [...source.matchAll(/subscribe: \(name, listener\) => ctx\.on\(name, listener\)/g)].length,
    1,
    'the one passthrough is still there, and still the only one',
  );
});

test('the boundary verdict distinguishes contained, silent, and starting', () => {
  // Contained: the boundary fired and the process survived — worth reading, not a failure.
  assert.deepEqual(
    boundaryVerdict({ contained: [{ where: 'session-event' }], uptimeMs: 5_000 }),
    { verdict: 'recovered', contained: 1, uptimeMs: 5_000 },
  );
  // Nothing contained, but the process has not been up long enough for that to mean anything.
  assert.equal(boundaryVerdict({ contained: [], uptimeMs: 1_000 }).verdict, 'starting');
  // Nothing contained after a long run: a boundary that never fires and one that was never
  // installed look the same from here, so this is a finding rather than a green light.
  assert.equal(boundaryVerdict({ contained: [], uptimeMs: BOUNDARY_SILENCE_MS }).verdict, 'silent');
  assert.equal(boundaryVerdict({}).verdict, 'starting', 'a missing input is not a healthy one');
});

test('the diagnostics block carries the boundary verdict and the installed labels', () => {
  const runtime = {
    projectionRunning: true,
    model: { list: () => [] },
    getInvokeLog: () => [],
    getRefusalLog: () => [],
    getPushLog: () => [],
    getPushTotals: () => ({}),
    getInvokeTotals: () => ({}),
    getRefusalTotals: () => ({}),
    getReconnectState: () => ({}),
    getFrameBudget: () => ({}),
    getHandlerErrors: () => [{ where: 'invoke', message: 'boom' }],
    getSubscriptions: () => ({ devices: [], sessions: [] }),
    getUptimeMs: () => 1_000,
  };
  const diagnostics = buildDiagnostics({
    runtime,
    sourceKind: 'session-controller',
    seam: {},
    listingDiagnostics: () => null,
    boundaries: { installed: ['session-event', 'approval-request'] },
  });
  assert.equal(diagnostics.boundaries.verdict, 'recovered');
  assert.deepEqual(diagnostics.boundaries.installed, ['session-event', 'approval-request'], 'what is installed is what tells a silent record apart from a missing boundary');

  // No runtime at all (headless composition): the field still exists, so its absence can never
  // be mistaken for "nothing to report".
  const headless = buildDiagnostics({ runtime: null, sourceKind: 'none', seam: {}, listingDiagnostics: () => null, boundaries: {} });
  assert.equal(headless.boundaries.verdict, 'starting');
  assert.deepEqual(headless.boundaries.installed, []);
});
