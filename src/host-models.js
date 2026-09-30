/**
 * Map DSH's model catalog onto the capability payload the Cindy controller reads.
 *
 * The controller validates every field before it will use any of it
 * (`normalizeMobileAgentCapabilities` in `maker-shared/agentCapabilities.ts`), and
 * two of its names are counter-intuitive enough to be worth stating outright:
 *
 *   - the display label is read from **`displayName`**, not from `label`;
 *   - plan mode is read from **`planMode.supported`**, an object, not from a
 *     boolean of the same meaning.
 *
 * Getting either wrong does not fail loudly: the field is simply dropped, the
 * picker loses its list (or its label), and the surface looks like a Host that
 * offers nothing.
 */

/** One `MobileChoiceOption`, in the wire shape the controller validates. */
function toChoiceOption(id, name) {
  if (typeof id !== 'string' || id === '') return null;
  return {
    id,
    displayName: typeof name === 'string' && name !== '' ? name : id,
  };
}

/**
 * One `MobileModelOption`.
 * @param model - a DSH `ModelCatalogModel`.
 * @returns the wire option, or null when the model has no usable id.
 */
function toModelOption(model) {
  if (typeof model?.id !== 'string' || model.id === '') return null;
  const reasons = Array.isArray(model?.reasoning?.efforts) ? model.reasoning.efforts : [];
  const efforts = [];
  const effortDisplayNames = {};
  for (const effort of reasons) {
    if (typeof effort?.id !== 'string' || effort.id === '') continue;
    efforts.push(effort.id);
    effortDisplayNames[effort.id] = typeof effort.name === 'string' && effort.name !== '' ? effort.name : effort.id;
  }

  return {
    id: model.id,
    displayName: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
    ...(typeof model.description === 'string' && model.description !== '' ? { description: model.description } : {}),
    efforts,
    effortDisplayNames,
    defaultEffort: typeof model?.reasoning?.defaultEffort === 'string' && model.reasoning.defaultEffort !== ''
      ? model.reasoning.defaultEffort
      : null,
    // DSH has no per-model fast mode, so the controller must not offer one.
    supportsFastMode: false,
  };
}

/**
 * Every model the catalog offers, in provider order.
 * @param catalog - a DSH `ModelCatalog`.
 * @returns the controller's `availableModels`.
 */
export function toAvailableModels(catalog) {
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
  const models = [];
  for (const group of groups) {
    for (const model of Array.isArray(group?.models) ? group.models : []) {
      const option = toModelOption(model);
      if (option !== null) models.push(option);
    }
  }
  return models;
}

/**
 * The flat effort list the controller falls back to.
 *
 * DSH declares effort per model route, so this is the union — deduplicated in
 * first-seen order, which keeps the list stable across catalog reads.
 * @param availableModels - the options `toAvailableModels` produced.
 * @returns the controller's `effortLevels`.
 */
export function toEffortLevels(availableModels) {
  const seen = new Map();
  for (const model of availableModels) {
    for (const effort of Array.isArray(model?.efforts) ? model.efforts : []) {
      if (seen.has(effort)) continue;
      const option = toChoiceOption(effort, model?.effortDisplayNames?.[effort]);
      if (option !== null) seen.set(effort, option);
    }
  }
  return [...seen.values()];
}

/**
 * The capability payload for one agent kind.
 * @param catalog - a DSH `ModelCatalog`, or undefined when none loaded.
 * @returns the payload `maker:get-capabilities` answers with.
 */
export function toAgentCapabilities(catalog) {
  const availableModels = toAvailableModels(catalog);
  return {
    availableModels,
    effortLevels: toEffortLevels(availableModels),
    // This Host enforces no permission-mode vocabulary of its own; DSH's
    // presets are not the controller's list, so the honest answer is empty.
    permissionModes: [],
    hasFastMode: false,
    // Read as an object by the controller; a boolean here is silently ignored.
    planMode: { supported: false },
    supportsSessionAgentSwitch: false,
    supportsModelWindowSwitchGuard: false,
  };
}

/**
 * The model id a session row should carry.
 *
 * The controller matches its current model with
 * `availableModels.find(item => item.id === session.model)`, so a row whose
 * `model` is a placeholder selects nothing and the picker shows no current model
 * even when the catalog is correct.
 * @param options - the catalog default and the session's recorded selection.
 * @returns the model id, or null when the catalogue names none.
 */
export function modelIdFor({ catalog, selection }) {
  const selected = selection?.model;
  if (typeof selected === 'string' && selected !== '') return selected;
  const fallback = catalog?.default?.model;
  return typeof fallback === 'string' && fallback !== '' ? fallback : null;
}

/** Cindy's permission vocabulary mapped onto DSH's sandbox presets. */
const CINDY_PERMISSION_BY_DSH = new Map([
  ['read-only', { id: 'ask', displayName: 'Ask' }],
  ['workspace-write', { id: 'acceptEdits', displayName: 'Accept edits' }],
  ['danger-full-access', { id: 'bypassPermissions', displayName: 'Full access' }],
]);
const DSH_PERMISSION_BY_CINDY = new Map([...CINDY_PERMISSION_BY_DSH].map(([dsh, cindy]) => [cindy.id, dsh]));

/** Translate one DSH permission preset to the public Cindy option id. */
export function toCindyPermissionMode(value) {
  return CINDY_PERMISSION_BY_DSH.get(value)?.id ?? 'ask';
}

/** Translate one Cindy permission choice back to the DSH preset name. */
export function toDshPermissionMode(value) {
  return DSH_PERMISSION_BY_CINDY.get(value) ?? null;
}

/** Advertise only DSH presets that have an exact Cindy control meaning. */
export function toPermissionOptions(names) {
  const seen = new Set();
  const options = [];
  for (const name of Array.isArray(names) ? names : []) {
    const option = CINDY_PERMISSION_BY_DSH.get(name);
    if (option === undefined || seen.has(option.id)) continue;
    seen.add(option.id);
    options.push({ ...option });
  }
  return options;
}

/**
 * Project DSH's provider-grouped catalog into Cindy desktop's ProviderView wire shape.
 * Routing credentials never cross this boundary; every Cindy harness alias reaches the
 * same DSH catalog, so each provider exposes the same models under all aliases.
 */
export function toProviderList(catalog, agentKinds = []) {
  const routable = new Set(Array.isArray(catalog?.routableProviders) ? catalog.routableProviders : []);
  const agents = [...new Set((Array.isArray(agentKinds) ? agentKinds : []).filter((kind) => typeof kind === 'string' && kind !== ''))];
  const providers = [];
  for (const group of Array.isArray(catalog?.groups) ? catalog.groups : []) {
    if (typeof group?.id !== 'string' || group.id === '') continue;
    const models = [];
    for (const model of Array.isArray(group.models) ? group.models : []) {
      if (typeof model?.id !== 'string' || model.id === '') continue;
      const contextWindow = Number(model.contextWindow);
      if (!Number.isFinite(contextWindow) || contextWindow <= 0) continue;
      const efforts = Array.isArray(model?.reasoning?.efforts)
        ? model.reasoning.efforts.map((effort) => effort?.id).filter((id) => typeof id === 'string' && id !== '')
        : [];
      const defaultEffort = typeof model?.reasoning?.defaultEffort === 'string'
        && efforts.includes(model.reasoning.defaultEffort)
        ? model.reasoning.defaultEffort
        : (efforts[0] ?? null);
      models.push({
        id: model.id,
        name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
        contextWindow,
        efforts,
        defaultEffort,
        supportsFastMode: false,
        defaultEnabled: true,
      });
    }
    if (models.length === 0) continue;
    providers.push({
      id: group.id,
      name: typeof group.name === 'string' && group.name !== '' ? group.name : group.id,
      agents,
      connected: routable.has(group.id),
      models: Object.fromEntries(agents.map((agent) => [agent, models.map((model) => ({ ...model }))])),
    });
  }
  return { providers, providerOrder: providers.map((provider) => provider.id) };
}
