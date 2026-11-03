const carriers = new Set(['options', 'input', 'request', 'payload', 'body', 'message', 'content', 'persistedContent', 'chatMessage']);
/** A frozen Cindy snapshot is not native current-surface reference admission. */
export function assertNoStructuredSessionReferences(...values) {
  const seen = new Set(); let count = 0;
  function visit(value, depth = 0) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    if (depth > 12 || ++count > 2048) throw Object.assign(new Error('Reference carrier nesting exceeds the input budget'), { code: 'BAD_REQUEST', refusalCode: 'BAD_REQUEST' });
    seen.add(value);
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    for (const key of ['sessionRefs', 'sessionReferences', 'trustedSessionReferenceContexts', 'sessionReferencesRequireTrustedSnapshot', 'requireTrustedSnapshot']) {
      const item = value[key];
      const empty = item === undefined || item === null || Array.isArray(item) && item.length === 0 || key.includes('Snapshot') && item === false;
      if (!empty) throw Object.assign(new Error('SESSION_REFERENCE_UNSUPPORTED: native admission cannot atomically consume the supplied frozen/anchored reference context; no input was admitted'), { code: 'NOT_AVAILABLE', refusalCode: 'NOT_AVAILABLE' });
    }
    for (const key of carriers) {
      let item = value[key];
      if (key === 'persistedContent' && typeof item === 'string' && item.trim().startsWith('{')) { try { item = JSON.parse(item); } catch { continue; } }
      visit(item, depth + 1);
    }
  }
  for (const value of values) visit(value);
}
