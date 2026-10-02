import test from 'node:test';
import assert from 'node:assert/strict';
import { toAgentCapabilities, toAvailableModels, modelIdFor, toCindyPermissionMode, toDshPermissionMode, toNewMakerDefaults, toPermissionOptions, toProviderList } from '../src/host-models.js';

/** A DSH `ModelCatalog` with two providers. */
function catalog() {
  return {
    default: { provider: 'deepseek', model: 'deepseek-chat' },
    routableProviders: ['deepseek', 'openai'],
    groups: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        models: [
          {
            id: 'deepseek-chat',
            name: 'DeepSeek Chat',
            description: 'fast',
            contextWindow: 128_000,
            reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' },
          },
        ],
      },
      { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-x', name: 'GPT X', contextWindow: 200_000 }] },
    ],
    failures: [],
  };
}

test('names the fields the controller actually reads', () => {
  const [first] = toAvailableModels(catalog());
  // The label wire field is `displayName`; `label` is dropped without a word.
  assert.equal(first.displayName, 'DeepSeek Chat');
  assert.equal(first.id, 'deepseek-chat');
  assert.equal('label' in first, false);
  assert.deepEqual(first.efforts, ['low', 'high']);
  assert.deepEqual(first.effortDisplayNames, { low: 'Low', high: 'High' });
  assert.equal(first.defaultEffort, 'low');
  // DSH has no fast mode, so offering one would be a control that does nothing.
  assert.equal(first.supportsFastMode, false);
});

test('falls back to the id when a model carries no name', () => {
  const [option] = toAvailableModels({ groups: [{ id: 'p', models: [{ id: 'm' }] }] });
  assert.equal(option.displayName, 'm');
  assert.deepEqual(option.efforts, []);
  assert.equal(option.defaultEffort, null);
});

test('skips models with no id instead of emitting an unusable option', () => {
  const models = toAvailableModels({ groups: [{ id: 'p', models: [{ name: 'no id' }, { id: 'ok' }] }] });
  assert.deepEqual(models.map((model) => model.id), ['ok']);
  // A catalog that is missing entirely answers with an empty list, not a crash.
  assert.deepEqual(toAvailableModels(undefined), []);
});

test('builds the flat effort list as a stable union of every model', () => {
  const models = toAvailableModels(catalog());
  const capabilities = toAgentCapabilities(catalog());
  assert.deepEqual(capabilities.effortLevels.map((level) => level.id), ['low', 'high']);
  assert.equal(capabilities.effortLevels[0].displayName, 'Low');
  assert.equal(models.length, 2);
});

test('reports plan mode as the object the controller reads', () => {
  const capabilities = toAgentCapabilities(catalog());
  // `planModeSupported` would be silently ignored: the reader looks at
  // `planMode.supported`.
  assert.equal(capabilities.planMode.supported, false);
  assert.equal('planModeSupported' in capabilities, false);
  assert.deepEqual(capabilities.permissionModes, []);
  assert.equal(capabilities.hasFastMode, false);
});



test('derives only truthful new-session defaults from the DSH catalog', () => {
  assert.deepEqual(toNewMakerDefaults(catalog()), {
    model: 'deepseek-chat', modelChosenByUser: false, effort: 'low', fastMode: false, providerId: 'deepseek',
  });
  assert.deepEqual(toNewMakerDefaults({}), {});
});

test('projects the DSH catalog into Cindy desktop provider views', () => {
  const result = toProviderList(catalog(), ['claude-code', 'codex', 'pi']);
  assert.deepEqual(result.providerOrder, ['deepseek', 'openai']);
  assert.equal(result.providers[0].connected, true);
  assert.deepEqual(result.providers[0].agents, ['claude-code', 'codex', 'pi']);
  assert.deepEqual(Object.keys(result.providers[0].models), ['claude-code', 'codex', 'pi']);
  assert.deepEqual(result.providers[0].models.codex[0], {
    id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 128_000,
    efforts: ['low', 'high'], defaultEffort: 'low', supportsFastMode: false, defaultEnabled: true,
  });
  assert.deepEqual(result.providers[0].routing, { 'claude-code': {}, codex: {}, pi: {} },
    'Cindy requires a runtime presence marker, not execution routing details');
});

test('missing or invalid context capacity never removes a catalog model', () => {
  for (const contextWindow of [undefined, null, 0, -1, NaN, Infinity, 'unknown']) {
    const input = { routableProviders: ['p'], groups: [{ id: 'p', models: [{ id: 'm', name: 'Model', contextWindow }] }] };
    const result = toProviderList(input, ['pi']);
    assert.equal(result.providers.length, 1);
    assert.equal(result.providers[0].connected, true);
    assert.equal(result.providers[0].models.pi[0].id, 'm');
    assert.equal(result.providers[0].models.pi[0].contextWindow, 0);
  }
});

test('provider runtime markers contain no execution details and remain isolated', () => {
  const input = catalog();
  input.groups[0].routing = { codex: { endpoint: 'private-endpoint', auth: 'private-key', headers: { Authorization: 'private-header' } } };
  const result = toProviderList(input, ['codex', 'pi', 'codex', '', null]);
  for (const provider of result.providers) {
    assert.deepEqual(Object.keys(provider).sort(), ['agents', 'connected', 'id', 'models', 'name', 'routing']);
    assert.deepEqual(provider.agents, ['codex', 'pi']);
    assert.deepEqual(provider.routing, { codex: {}, pi: {} });
    assert.deepEqual(Object.keys(provider.models), provider.agents);
  }
  assert.equal(JSON.stringify(result).includes('private-'), false);
  result.providers[0].routing.codex.disabled = true;
  assert.deepEqual(result.providers[0].routing.pi, {});
  assert.deepEqual(result.providers[1].routing.codex, {});
  assert.deepEqual(toProviderList(input, ['codex']).providers[0].routing.codex, {});
});

test('runtime markers do not connect unroutable providers or invent empty catalog models', () => {
  const input = catalog();
  input.routableProviders = ['deepseek'];
  const result = toProviderList(input, ['claude-code', 'codex', 'pi']);
  assert.deepEqual(result.providers.map((p) => p.connected), [true, false]);
  assert.deepEqual(result.providers[1].routing, { 'claude-code': {}, codex: {}, pi: {} });
  assert.deepEqual(toProviderList({ groups: [], routableProviders: [] }, ['pi']), { providers: [], providerOrder: [] });
  assert.deepEqual(toProviderList(undefined, ['pi']), { providers: [], providerOrder: [] });
  assert.deepEqual(toProviderList(input, []).providers[0].routing, {});
});

test('maps permission controls in both directions without leaking DSH preset ids', () => {
  assert.deepEqual(toPermissionOptions(['read-only', 'workspace-write', 'danger-full-access', 'custom']), [
    { id: 'ask', displayName: 'Ask' },
    { id: 'acceptEdits', displayName: 'Accept edits' },
    { id: 'bypassPermissions', displayName: 'Full access' },
  ]);
  assert.equal(toCindyPermissionMode('danger-full-access'), 'bypassPermissions');
  assert.equal(toCindyPermissionMode('future-mode'), 'ask');
  assert.equal(toDshPermissionMode('acceptEdits'), 'workspace-write');
  assert.equal(toDshPermissionMode('workspace-write'), null);
});

test('a session row takes its model from the recorded selection, then the default', () => {
  // The controller finds the current model by id equality against the row, so a
  // placeholder here leaves the picker with nothing selected.
  assert.equal(modelIdFor({ catalog: catalog(), selection: { model: 'gpt-x' } }), 'gpt-x');
  assert.equal(modelIdFor({ catalog: catalog(), selection: null }), 'deepseek-chat');
  assert.equal(modelIdFor({ catalog: catalog(), selection: { model: '' } }), 'deepseek-chat');
  assert.equal(modelIdFor({ catalog: undefined, selection: undefined }), null);
});
