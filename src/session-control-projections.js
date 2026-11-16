/** Current DSH control frames; retain the old single-key shape for older hosts. */
export function controlProjectionUpdates(frame) {
  if (!frame || typeof frame !== 'object') return [];
  if (frame.type === 'baseline') {
    return Object.entries(frame.value?.projections ?? {}).flatMap(([sessionId, block]) =>
      sessionId && block?.values && typeof block.values === 'object'
        ? [{ sessionId, values: block.values }] : []);
  }
  if (frame.type !== 'projection' || typeof frame.sessionId !== 'string' || !frame.sessionId) return [];
  const changes = Array.isArray(frame.changes) ? frame.changes
    : typeof frame.key === 'string' ? [{ key: frame.key, val: frame.value }] : [];
  const values = Object.create(null);
  for (const change of changes) if (typeof change?.key === 'string' && change.key && Object.hasOwn(change, 'val')) {
    values[change.key] = change.val;
  }
  return [{ sessionId: frame.sessionId, values }];
}
