/**
 * Request-scoped display enrichment, not a second model registry.
 * DSH's catalog owns membership/defaults; llm.resolveModelInfo owns exact-route
 * context capacity. Keep metadata failures separate from catalog failures.
 */
export const MODEL_CONTEXT_CONCURRENCY = 4;
// Mobile device-link uses a 15s invoke deadline. Spend at most 3s of that on
// optional enrichment, leaving the existing catalog/transport their own budget.
export const MODEL_CONTEXT_TIMEOUT_MS = 3_000;
const positiveWindow = (value) => Number.isSafeInteger(value) && value > 0;

export async function enrichModelCatalog(catalog, resolveModelInfo, {
  timeoutMs = MODEL_CONTEXT_TIMEOUT_MS, signal,
} = {}) {
  if (!Array.isArray(catalog?.groups)) return catalog;
  const groups = catalog.groups.map((group) => ({ ...group,
    models: (Array.isArray(group?.models) ? group.models : []).map((model) => ({ ...model })),
  }));
  const routes = new Map();
  for (const group of groups) {
    if (typeof group.id !== 'string' || !group.id) continue;
    for (const model of group.models) {
      if (typeof model.id !== 'string' || !model.id || positiveWindow(model.contextWindow)) continue;
      const key = JSON.stringify([group.id, model.id]);
      if (!routes.has(key)) routes.set(key, { provider: group.id, id: model.id, models: [] });
      routes.get(key).models.push(model);
    }
  }
  const pending = [...routes.values()];
  const contextFailures = [];
  const failed = (route, code) => contextFailures.push({ provider: route.provider, model: route.id, code });
  if (typeof resolveModelInfo !== 'function') {
    for (const route of pending) failed(route, 'metadata-service-unavailable');
    return { ...catalog, groups, contextFailures };
  }
  if (!pending.length) return { ...catalog, groups, contextFailures };
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  let expire;
  const expired = new Promise((resolve) => { expire = resolve; });
  const aborted = () => expire({ code: signal?.aborted ? 'metadata-cancelled' : 'metadata-deadline' });
  controller.signal.addEventListener('abort', aborted, { once: true });
  if (controller.signal.aborted) aborted();
  const timer = setTimeout(cancel, timeoutMs);
  let cursor = 0;
  async function worker() {
    while (cursor < pending.length) {
      const route = pending[cursor++];
      if (controller.signal.aborted) {
        failed(route, signal?.aborted ? 'metadata-cancelled' : 'metadata-deadline');
        continue;
      }
      // Observe rejection even if a non-cooperative resolver outlives the deadline.
      const lookup = Promise.resolve()
        .then(() => resolveModelInfo(route.provider, route.id, controller.signal))
        .then((value) => ({ value }), () => ({ code: 'metadata-read-failed' }));
      const result = await Promise.race([lookup, expired]);
      if (result.code) { failed(route, result.code); continue; }
      const info = result.value;
      if (info?.provider !== route.provider || info?.id !== route.id) {
        failed(route, 'metadata-identity-mismatch'); continue;
      }
      const window = info?.context?.contextWindow;
      if (!positiveWindow(window)) { failed(route, 'metadata-unknown'); continue; }
      for (const model of route.models) model.contextWindow = window;
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(MODEL_CONTEXT_CONCURRENCY, pending.length) }, worker));
    return { ...catalog, groups, contextFailures };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', aborted);
  }
}
