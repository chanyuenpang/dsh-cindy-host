/**
 * The restart helper's decision logic, without touching a process.
 *
 * The dangerous half of `tools/restart-host.mjs` is the argv it relaunches with: the live
 * instance's tail is `… bin.js web` with no flags at all, so a parser that only copied flags
 * would start `dsh` with no subcommand, and one that guessed a port would move the instance the
 * user's page is attached to.
 *
 * What is deliberately *not* here any more — retries, identity checks, token scraping — is not
 * missing coverage: none of it is in the tool. The behaviour that remains (detached spawn,
 * file-backed output, WMI launch, one confirmation after it answers) is process lifecycle, and is
 * verified by running the tool, not by a unit test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { launchArgsFrom, parseArgs } from '../tools/restart-host.mjs';

const LIVE = '"D:\\Program Files\\nodejs\\node.exe" C:\\Users\\chany\\AppData\\Roaming\\npm/node_modules/@deepseek-ai/dsh/lib/bin.js web';

test('a dry run is the default, and flags parse with or without values', () => {
  assert.deepEqual(parseArgs([]), { apply: false, graceSeconds: 60, port: 3080, dshHome: null }, 'the default grace is long enough to warn first');
  assert.equal(parseArgs(['--apply']).apply, true);
  assert.equal(parseArgs(['--apply', '--grace', '45', '--port', '3081']).graceSeconds, 45);
  assert.equal(parseArgs(['--port', '3081']).port, 3081);
  assert.equal(parseArgs(['--dsh-home', 'G:\\sandbox\\dsh-home']).dshHome, 'G:\\sandbox\\dsh-home');
  assert.equal(parseArgs(['--port', '3081']).dshHome, null, 'the home is inherited unless it is named');
});

test('the relaunch copies the subcommand, not just the flags', () => {
  // The real instance: no flags at all. A flag-only copy would run `dsh` bare.
  assert.deepEqual(launchArgsFrom(LIVE), ['web']);
  assert.deepEqual(
    launchArgsFrom('node .../bin.js web --profile web --port 3080'),
    ['web', '--profile', 'web', '--port', '3080'],
  );
  assert.deepEqual(launchArgsFrom('node .../bin.js web --port 3081'), ['web', '--port', '3081']);
  // A quoted profile path must not smuggle its spaces into argv as two entries.
  assert.deepEqual(
    launchArgsFrom('node .../bin.js web --profile "my profile" --port 3080'),
    ['web', '--profile', 'my profile', '--port', '3080'],
  );
  // No `bin.js` at all means this is not a `dsh` entry point, and guessing a subcommand from an
  // arbitrary tail is how a restart turns into `dsh dable`. The tool refuses when this is empty.
  assert.deepEqual(launchArgsFrom('unreadable'), []);
  assert.deepEqual(launchArgsFrom(''), []);
});
