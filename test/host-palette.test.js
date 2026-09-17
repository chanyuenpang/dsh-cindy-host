import test from 'node:test';
import assert from 'node:assert/strict';
import { toAgentSkills, toAgentCommands, toAtResources } from '../src/host-palette.js';

test('lists only the skills a human may invoke', () => {
  // `invocation.userInvocable` is DSH's own statement that a skill belongs in a
  // human-facing catalog; offering one that says no puts an entry in the palette
  // that cannot run.
  const result = toAgentSkills([
    { name: 'recheck', description: 'review things', source: 'project-dsh', invocation: { modelInvocable: true, userInvocable: true } },
    { name: 'internal', description: 'model only', source: 'bundled', invocation: { modelInvocable: true, userInvocable: false } },
    { name: 'mine', description: 'mine', source: 'user-dsh', invocation: { modelInvocable: true, userInvocable: true } },
  ]);
  assert.equal(result.success, true);
  assert.deepEqual(result.skills.map((skill) => skill.name), ['recheck', 'mine']);
  // The controller only asks whether the user put it there.
  assert.deepEqual(result.skills.map((skill) => skill.source), ['skill', 'user']);
  assert.equal(result.skills[0].kind, 'agent-skill');
});

test('a malformed skill catalog yields an empty palette, not a crash', () => {
  assert.deepEqual(toAgentSkills(undefined).skills, []);
  assert.deepEqual(toAgentSkills([null, {}, { name: '' }]).skills, []);
});

test('commands carry the kind the calling channel asked for', () => {
  const result = toAgentCommands([
    { name: 'compact', description: 'Compact the conversation' },
    { name: 'goal', description: 'Run a goal' },
    { name: '' },
  ]);
  assert.equal(result.success, true);
  assert.deepEqual(result.commands, [
    { kind: 'agent-builtin', name: 'compact', description: 'Compact the conversation' },
    { kind: 'agent-builtin', name: 'goal', description: 'Run a goal' },
  ]);
  // A description is required by the controller's row, so it is never omitted.
  assert.equal(toAgentCommands([{ name: 'x' }]).commands[0].description, '');
  assert.deepEqual(toAgentCommands(undefined).commands, []);
});

test('the @ menu is a shallow, sorted, capped listing', () => {
  const result = toAtResources([
    { name: 'zeta.txt', kind: 'file' },
    { name: 'src', kind: 'dir' },
    { name: 'alpha.txt', kind: 'file' },
    { name: 'assets', kind: 'dir' },
  ], { workingDir: 'G:\\w', cap: 3 });
  // Directories first, then by name — what a palette reads as.
  assert.deepEqual(result.items.map((item) => item.name), ['assets', 'src', 'alpha.txt']);
  assert.equal(result.items[1].type, 'dir');
  assert.equal(result.items[2].type, 'file');
  assert.equal(result.items[0].relPath, 'assets', 'the entry is relative to the working directory');
  assert.equal(result.truncated, true, 'the cap is reported, not silently applied');
});

test('the @ menu filters by the query without losing the listing', () => {
  const entries = [{ name: 'readme.md', kind: 'file' }, { name: 'main.ts', kind: 'file' }];
  assert.deepEqual(toAtResources(entries, { query: 'MAIN' }).items.map((item) => item.name), ['main.ts']);
  assert.equal(toAtResources(entries, { query: 'nothing' }).items.length, 0);
  assert.equal(toAtResources(entries, {}).items.length, 2, 'no query lists everything');
  assert.deepEqual(toAtResources(undefined, {}).items, []);
});
