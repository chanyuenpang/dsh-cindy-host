import { diagnosticPreferenceStore } from '../../src/diagnostic-presentation.js';
/** Fake only the native settings port; the production revision/leaf writer executes. */
export function diagnosticSettings(ns = 'test') {
  const state = { value: {}, revision: 0, writes: 0, conflicts: 0, fail: false, beforeWrite: null };
  const settings = {
    describe: () => [{ ns, revision: state.revision, value: structuredClone(state.value) }],
    mutate: async (namespace, operations, expected) => {
      state.writes++; if (state.beforeWrite) await state.beforeWrite();
      if (state.fail) throw new Error('disk write failed');
      if (state.conflicts > 0) { state.conflicts--; state.revision++; throw Object.assign(new Error('changed'), { code: 'SETTINGS_CONFLICT' }); }
      if (namespace !== ns || expected !== state.revision) throw Object.assign(new Error('changed'), { code: 'SETTINGS_CONFLICT' });
      for (const operation of operations) { let node = state.value; for (const key of operation.path.slice(0, -1)) node = node[key] ??= {}; node[operation.path.at(-1)] = operation.value; }
      state.revision++;
    },
  };
  return { settings, state, preferences: diagnosticPreferenceStore(settings, ns) };
}
