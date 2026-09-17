/**
 * The restart helper's decision logic, without touching a process.
 *
 * The dangerous half of `tools/restart-host.mjs` is the argv it relaunches with: the live
 * instance's tail is `… bin.js web` with no flags at all, so a parser that only copied flags
 * would start `dsh` with no subcommand, and one that guessed a port would move the instance the
 * user's page is attached to.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { launchArgsFrom, parseArgs, tokenUrlFrom } from '../tools/restart-host.mjs';

const LIVE = '"D:\\Program Files\\nodejs\\node.exe" C:\\Users\\chany\\AppData\\Roaming\\npm/node_modules/@deepseek-ai/dsh/lib/bin.js web';

test('a dry run is the default, and flags parse with or without values', () => {
  assert.deepEqual(parseArgs([]), { apply: false, graceSeconds: 20, port: 3080, retries: 3 });
  assert.equal(parseArgs(['--apply']).apply, true);
  assert.equal(parseArgs(['--apply', '--grace', '45', '--port', '3081', '--retries', '5']).graceSeconds, 45);
  assert.equal(parseArgs(['--port', '3081']).port, 3081);
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
  assert.deepEqual(launchArgsFrom('unreadable'), []);
  assert.deepEqual(launchArgsFrom(''), []);
});

test('the token URL is read from the starting process output, and only for this port', () => {
  const output = 'dsh web: http://127.0.0.1:3080/?token=F8RC7GwUzkU_1QftqW34wXKhYUIx2goKom6SC0nts9U\nand more';
  assert.equal(tokenUrlFrom(output, 3080), 'http://127.0.0.1:3080/?token=F8RC7GwUzkU_1QftqW34wXKhYUIx2goKom6SC0nts9U');
  assert.equal(tokenUrlFrom(output, 3081), null, 'another port means another instance');
  assert.equal(tokenUrlFrom('starting…', 3080), null);
  assert.equal(tokenUrlFrom(undefined, 3080), null);
});
