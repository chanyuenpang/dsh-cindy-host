/** Offline core-contract smoke against an isolated, explicitly installed DSH SDK.
 * Not a Web/relay/handset end-to-end test; no profile is installed or modified.
 * node tools/dsh-compat-smoke.mjs --runtime <npm-project> --plugin <unpacked-package>
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

function argument(name) {
  const index = process.argv.indexOf(name);
  assert.ok(index >= 0 && process.argv[index + 1], `Required argument: ${name}`);
  return resolve(process.argv[index + 1]);
}
const runtimeDir = argument('--runtime');
const pluginDir = argument('--plugin');
const fixtureDir = await mkdtemp(join(runtimeDir, 'compat-smoke-'));
process.env.DSH_HOME = join(fixtureDir, 'home');
process.env.DSH_PROFILE_DIR = join(fixtureDir, 'profile');
process.env.DSH_PROFILE = 'compat-smoke';
const anchor = pathToFileURL(join(runtimeDir, 'package.json'));
const requireRuntime = createRequire(anchor);
const load = name => import(pathToFileURL(requireRuntime.resolve(`@deepseek-ai/${name}`)));
const version = JSON.parse(await readFile(requireRuntime.resolve('@deepseek-ai/dsh-session/package.json'), 'utf8')).version;
assert.ok(['0.2.2-alpha.2', '0.2.2-rc.1'].includes(version), 'This fixture matrix targets reviewed DSH 0.2.2 carriers only');
const manifest = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8'));
const requirePlugin = createRequire(pathToFileURL(join(pluginDir, 'package.json')));
for (const peer of ['dsh-session', 'schemastery']) {
  assert.equal(requirePlugin.resolve(`@deepseek-ai/${peer}/package.json`), requireRuntime.resolve(`@deepseek-ai/${peer}/package.json`), `Plugin must resolve the isolated ${version} ${peer}, not a development/production copy`);
}
const { evaluatePluginCompatibility } = await load('dsh-app-boot');
let count = 0;
function passed(name) { count++; console.log(`PASS ${name}`); }
for (const supported of ['0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5', version]) {
  assert.equal(evaluatePluginCompatibility(manifest, {}, supported), undefined);
}
for (const unsupported of ['0.2.2-alpha.1', '0.2.2-alpha.3', '0.2.2', '0.3.0']) {
  assert.ok(evaluatePluginCompatibility(manifest, {}, unsupported));
}
passed('actual DSH compatibility evaluator admits reviewed carriers and rejects unreviewed ones');
const semver = requireRuntime('semver');
const schemaVersion = JSON.parse(await readFile(requireRuntime.resolve('@deepseek-ai/schemastery/package.json'), 'utf8')).version;
assert.ok(semver.satisfies(schemaVersion, manifest.peerDependencies['@deepseek-ai/schemastery']));
assert.ok(!semver.satisfies('3.18.6-alpha.2', manifest.peerDependencies['@deepseek-ai/schemastery']));
passed('the actual DSH Schemastery satisfies the plugin peer, without admitting future alphas');
for (const [module, exportName, methods] of [
  ['dsh-api-session-controller', 'SessionController', ['list', 'create', 'resolveAgent', 'selectModel', 'modelCatalog', 'prompt', 'updateQueue', 'cancel']],
  ['dsh-settings', 'SettingsForms', ['describe', 'update', 'replace', 'mutate']],
  ['dsh-workspace', 'WorkspaceRegistry', ['archiveSession', 'unarchiveSession']],
]) {
  const exports = await load(module);
  for (const method of methods) assert.equal(typeof exports[exportName].prototype[method], 'function', `${exportName}.${method}`);
}
passed('DSH controller/settings/archive method contracts remain present (signature check, not behavioral acceptance)');

// Resolve the unpacked plugin through the isolated SDK's node_modules, never the
// Desktop installation or the checkout's older development peer graph.
const plugin = await import(pathToFileURL(join(pluginDir, 'src/dsh-plugin.js')));
const { foldSessionEvent, promptRpcIdOf } = await import(pathToFileURL(join(pluginDir, 'src/dsh-message-fold.js')));
const { durableInputEvidence } = await import(pathToFileURL(join(pluginDir, 'src/dsh-input-delivery.js')));
const { Session, SessionId } = await load('dsh-session');
const { createUserMessage, createAssistantMessage } = await load('dsh-llm');
const session = Session.create(SessionId('compat-alpha'));
const user = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'alpha prompt' }], source: { kind: 'user', rpcId: 'alpha-input' } }), { surfaceOp: 'append' });
assert.equal(promptRpcIdOf(user), 'alpha-input');
assert.equal(foldSessionEvent(user, { sessionId: session.id }).length, 1);
const assistant = session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: 'alpha answer' }] }), stream: [] }, { surfaceOp: 'append' });
assert.equal(foldSessionEvent(assistant, { sessionId: session.id }).length, 1);
assert.equal(durableInputEvidence(session.snapshotEvents(), session.id).users[0].clientId, 'alpha-input');
passed('real DSH Session events fold into Cindy rows and preserve durable input identity');

const { Context } = await load('cordis');
const { default: Loader } = await load('cordis-plugin-loader');
const root = new Context();
try {
  await root.plugin(Loader, { baseUrl: anchor.href });
  for (const [id, name, config] of [
    ['sessions', 'dsh-session'],
    ['session-projections', 'dsh-session-projection'],
    ['agents', 'dsh-agent'],
    ['skills', 'dsh-skill'],
    ['presets', 'dsh-agent-preset-registry', { default: 'compat' }],
  ]) await root.loader.create({ id, name: pathToFileURL(requireRuntime.resolve(`@deepseek-ai/${name}`)).href, ...(config ? { config } : {}) });
  await root.loader.await();
  for (const name of ['sessions', 'sessionProjections', 'agents', 'skills', 'agentPresets']) assert.ok(root.get(name), `Missing live alpha service: ${name}`);
  passed('real DSH Cordis Loader activates Session, projections, Agents, skills and preset registry');

  const providerFile = join(fixtureDir, 'skill-provider.mjs');
  await writeFile(providerFile, `export const inject = ['skills'];\nexport function apply(ctx) { ctx.effect(() => ctx.skills.register({ name: 'alpha-scoped', description: 'Scoped smoke skill', content: 'Test only', source: 'runtime' })); }\n`);
  const unregister = await root.agentPresets.register({ id: 'compat', plugins: [{ name: pathToFileURL(providerFile).href }] });
  try {
    assert.equal(typeof root.agentPresets.standingKeyFor, 'undefined');
    assert.ok(!(await root.skills.list()).some(skill => skill.name === 'alpha-scoped'), 'preset skill must not leak globally');
    root.provide('sessionController', { resolveAgent() { assert.fail('draft lookup must not activate an Agent'); } });
    const seam = plugin.buildDshSource(root, 'sessionController');
    const skills = await seam.palette.skills({ cwd: fixtureDir });
    assert.ok(skills.some(skill => skill.name === 'alpha-scoped'), 'draft must see default preset skills through acquireScope');
    assert.equal(root.agents.list().length, 0);
    passed('packed plugin reads an actual DSH preset-scoped skill without starting an Agent');
  } finally { await unregister(); }

  // Settings provider is deliberately a port fixture: this tests actual Loader
  // Config parsing and plugin mount, not profile persistence or Web rendering.
  root.provide('settings', { configure: () => () => {}, describe: () => [] });
  const id = await root.loader.create({ id: 'dsh-cindy-host', name: pathToFileURL(join(pluginDir, 'src/dsh-plugin.js')).href, config: { transportEnabled: false } });
  await root.loader.await();
  const entry = root.loader.resolve(id);
  assert.ok(entry.fiber);
  assert.equal(entry.fiber.error, undefined);
  assert.equal(entry.fiber.state, 2, 'plugin must be ACTIVE, not merely registered');
  passed('packed plugin Config parses and mounts under actual DSH Cordis/Schemastery');
} finally {
  await root.fiber.dispose();
}
console.log(`${count}/${count} ${version} core-contract checks passed (no Web, profile persistence, relay or handset acceptance claimed)`);
