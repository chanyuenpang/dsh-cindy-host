/**
 * The composer's `/` and `@` palettes, in the controller's vocabulary.
 *
 * Three channels feed them and they are easy to conflate:
 *
 *  - `maker:list-agent-commands` — the agent's own slash commands, e.g. `/compact`;
 *  - `maker:list-agent-skills`   — user-invocable skills, listed separately so the
 *    palette can offer them without pretending they are built-ins;
 *  - `maker:scan-at-resources`   — the `@` menu, which lists paths, not commands.
 *
 * `maker:list-desktop-commands` is a fourth: commands that only the controlling
 * desktop can run (Cindy's `/learn`). This Host owns none, and answering with an
 * empty *success* is correct there — unlike the provider catalog, an empty list
 * here means "nothing to offer", not "there is no such feature".
 *
 * Every list result is an envelope (`{ success, commands|skills|items }`), not a
 * bare array: the controller reads the envelope, so an array would be dropped in
 * silence.
 */

/**
 * Map one DSH skill source onto the controller's `'user' | 'skill'`.
 *
 * DSH names where a skill came from; the controller only asks whether the user
 * put it there.
 */
function skillSourceOf(source) {
  return source === 'user-dsh' || source === 'user-agents' || source === 'custom' ? 'user' : 'skill';
}

/**
 * Build the `maker:list-agent-skills` answer.
 *
 * Only skills a human may invoke are listed: `invocation.userInvocable` is DSH's
 * own statement that a skill belongs in a human-facing catalog, and offering one
 * that says no would put an entry in the palette that cannot run.
 *
 * @param summaries - `ctx.skills.list()` output.
 * @returns the controller's `MobileAgentSkillListResult`.
 */
export function toAgentSkills(summaries) {
  const skills = [];
  for (const skill of Array.isArray(summaries) ? summaries : []) {
    if (typeof skill?.name !== 'string' || skill.name === '') continue;
    if (skill?.invocation?.userInvocable !== true) continue;
    skills.push({
      kind: 'agent-skill',
      name: skill.name,
      description: typeof skill.description === 'string' ? skill.description : undefined,
      source: skillSourceOf(skill.source),
    });
  }
  return { success: true, skills };
}

/**
 * Build the `maker:list-agent-commands` / `maker:list-desktop-commands` answer.
 * @param descriptors - `ctx.commands.list(agent)` output, or nothing.
 * @param kind - the controller's command kind for this channel.
 * @returns the controller's command list result.
 */
export function toAgentCommands(descriptors, kind = 'agent-builtin') {
  const commands = [];
  for (const command of Array.isArray(descriptors) ? descriptors : []) {
    if (typeof command?.name !== 'string' || command.name === '') continue;
    commands.push({
      kind,
      name: command.name,
      description: typeof command.description === 'string' ? command.description : '',
    });
  }
  return { success: true, commands };
}

/** Sort entries the way a palette reads: directories first, then by name. */
function compareEntries(a, b) {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * Build the `maker:scan-at-resources` answer for one working directory.
 *
 * The `@` menu lists what a message can reference, so this is a shallow listing
 * of one directory rather than a tree: the controller re-scans with a deeper
 * `relPath` when the user descends, and a tree would be both slower and larger
 * than the palette can show.
 *
 * @param entries - directory entries: `{ name, kind }` where `kind` is `'dir'` or `'file'`.
 * @param options - the base directory the entries are relative to, a cap, and a query filter.
 * @returns the controller's `MobileAtResourceScanResult`.
 */
export function toAtResources(entries, { workingDir = '', cap = 200, query = '' } = {}) {
  const wanted = typeof query === 'string' ? query.trim().toLowerCase() : '';
  const items = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry?.name !== 'string' || entry.name === '') continue;
    const isDir = entry.kind === 'dir';
    if (wanted !== '' && !entry.name.toLowerCase().includes(wanted)) continue;
    items.push({
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      // Relative to the working directory, which is the coordinate the
      // controller sends back when the user picks the entry.
      relPath: entry.name,
    });
  }
  items.sort(compareEntries);
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 200;
  return { success: true, items: items.slice(0, limit), truncated: items.length > limit };
}
