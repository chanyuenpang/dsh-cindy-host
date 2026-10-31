/**
 * The restart helper's decision logic, without touching a process.
 *
 * The dangerous half of `tools/restart-host.mjs` is the argv it relaunches with: the live
 * instance's tail is `… bin.js web` with no flags at all, so a parser that only copied flags
 * would start `dsh` with no subcommand, and one that guessed a port would move the instance the
 * user's page is attached to.
 *
 * The other dangerous half is the cleanup: it stops processes by name, so the test that matters
 * is which command lines it *refuses* to match — `claw`'s CLI passes `--host dsh`, and a loose
 * `*dsh*` match would stop the very process running the restart.
 *
 * What is deliberately *not* here any more — retries, identity checks, token scraping — is not
 * missing coverage: none of it is in the tool. The behaviour that remains (detached spawn,
 * file-backed output, WMI launch, the sweep's kill loop) is process lifecycle, and is verified by
 * running the tool, not by a unit test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDshProcess, launchArgsFrom, parseArgs } from '../tools/restart-host.mjs';

const LIVE = '"D:\\Program Files\\nodejs\\node.exe" C:\\Users\\chany\\AppData\\Roaming\\npm/node_modules/@deepseek-ai/dsh/lib/bin.js web';

test('a dry run is the default, and flags parse with or without values', () => {
  assert.deepEqual(parseArgs([]), { apply: false, graceSeconds: 60, port: 3080, dshHome: null, keepSandboxes: false }, 'the default grace is long enough to warn first');
  assert.equal(parseArgs(['--apply']).apply, true);
  assert.equal(parseArgs(['--apply', '--grace', '45', '--port', '3081']).graceSeconds, 45);
  assert.equal(parseArgs(['--port', '3081']).port, 3081);
  assert.equal(parseArgs(['--dsh-home', 'G:\\sandbox\\dsh-home']).dshHome, 'G:\\sandbox\\dsh-home');
  assert.equal(parseArgs(['--port', '3081']).dshHome, null, 'the home is inherited unless it is named');
  assert.equal(parseArgs([]).keepSandboxes, false, 'the sweep is the default: a half-dead tree is the failure this tool exists to remove');
  assert.equal(parseArgs(['--keep-sandboxes']).keepSandboxes, true);
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

test('the cleanup claims dsh processes and nothing that merely says "dsh"', () => {
  // What it must stop: the host itself, and the subprocess wrappers that hold a command. Both are
  // what "restart DSH" is supposed to take down, and the runner is the one that survives as an
  // orphan when only the listener is killed.
  assert.equal(isDshProcess(LIVE), true, 'the entry point');
  assert.equal(
    isDshProcess('"D:\\Program Files\\nodejs\\node.exe" C:\\Users\\chany\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai\\dsh-subprocess-local\\lib\\runner.js -- "C:\\WINDOWS\\system32\\cmd.exe"'),
    true,
    'a command subprocess (the "sandbox thread")',
  );
  assert.equal(isDshProcess('node C:/x/node_modules/@deepseek-ai/dsh/lib/bin.js web --profile web'), true, 'forward slashes');
  assert.equal(isDshProcess('node .../node_modules/@deepseek-ai/dsh-browser/lib/runner.js'), false, 'a sibling package is not this dsh');

  // What it must not stop. The first one is the reason this test exists: `claw` runs with
  // `--host dsh`, so a substring match would stop the CLI of the session asking for the restart.
  assert.equal(isDshProcess('"D:\\Program Files\\nodejs\\node.exe" C:\\Users\\chany\\AppData\\Roaming\\npm\\node_modules\\@veewo\\claw\\dist\\bin.js session open G:\\Projects\\tiny-world session-abc --host dsh'), false, 'the claw CLI');
  assert.equal(isDshProcess('node tools/restart-host.mjs --apply'), false, 'this script');
  assert.equal(isDshProcess('powershell -NoProfile -Command Get-CimInstance Win32_Process'), false, 'the probe itself');
  assert.equal(isDshProcess('"C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe" --type=renderer --service-scheme=codex-sandbox'), false, 'another product, sandbox or not');
  assert.equal(isDshProcess('node .../node_modules/dsh-better-tasks/lib/index.js'), false, 'an unrelated dsh-prefixed plugin');
  assert.equal(isDshProcess(''), false);
  assert.equal(isDshProcess(undefined), false, 'a command line CIM refused to read is not a licence to kill');
});
