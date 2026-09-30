/**
 * Read the running subset from DSH's live registry, never the persisted corpus.
 *
 * Services are resolved for each call so unload/reload cannot leave cached running
 * flags behind. `null` means this runtime lacks the required API; an empty array
 * is authoritative. Actual read failures propagate to the caller's legacy fallback.
 *
 * DSH's session-controller summary uses Agent.status, Agent.session identity,
 * sessionListMetadata.blank (falling back to Session.seq), and lastPromptAt.
 * Keep the same facts here without controller.list(), persistence, or log copies.
 * snapshot() is current, unlike cachedSnapshot(); a first touch may still lazily
 * materialize in-memory projections, but only for eligible running roots.
 */
export function readActiveSessionSummaries(ctx) {
  if (typeof ctx?.get !== 'function') return null;
  const agents = ctx.get('agents');
  const sessions = ctx.get('sessions');
  const projections = ctx.get('sessionProjections');
  if (typeof agents?.list !== 'function' || typeof agents?.get !== 'function'
    || typeof sessions?.get !== 'function' || typeof projections?.snapshot !== 'function') {
    return null;
  }

  const listed = agents.list();
  if (!Array.isArray(listed)) throw new TypeError('agents.list() must return an array');
  const result = [];
  for (const agent of listed) {
    if (agent?.status !== 'running') continue;
    const id = agent.id;
    if (agents.get(id) !== agent) continue;
    const session = sessions.get(id);
    if (!session || agent.session !== session) continue;
    const header = session.header;
    if (!header || header.id !== id || header.origin === 'subagent'
      || header.parentSession != null || typeof header.cwd !== 'string' || !header.cwd) continue;

    const snapshot = projections.snapshot(session, ['sessionListMetadata']);
    const metadata = snapshot.values.sessionListMetadata;
    const blank = metadata?.blank ?? session.seq === 0;
    if (blank === true) continue;
    // A service may synchronously trigger lifecycle work while deriving a view.
    // Never publish an entry replaced or detached during that read.
    if (agents.get(id) !== agent || agent.status !== 'running'
      || sessions.get(id) !== session || agent.session !== session) continue;
    result.push({
      sessionId: id,
      updatedAt: Math.max(header.createdAt, metadata?.lastPromptAt ?? 0),
      agentAvailable: true,
      running: true,
      blank,
      cwd: header.cwd,
      ...(header.parentSession === undefined ? {} : { parentSessionId: header.parentSession }),
      ...(header.origin === undefined ? {} : { origin: header.origin }),
      projections: snapshot,
    });
  }
  result.sort((left, right) => right.updatedAt - left.updatedAt);
  return result;
}
