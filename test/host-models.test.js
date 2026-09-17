import test from 'node:test';
import assert from 'node:assert/strict';
import { toAgentCapabilities, toAvailableModels, modelIdFor } from '../src/host-models.js';

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
            reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' },
          },
        ],
      },
      { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-x', name: 'GPT X' }] },
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

test('a session row takes its model from the recorded selection, then the default', () => {
  // The controller finds the current model by id equality against the row, so a
  // placeholder here leaves the picker with nothing selected.
  assert.equal(modelIdFor({ catalog: catalog(), selection: { model: 'gpt-x' } }), 'gpt-x');
  assert.equal(modelIdFor({ catalog: catalog(), selection: null }), 'deepseek-chat');
  assert.equal(modelIdFor({ catalog: catalog(), selection: { model: '' } }), 'deepseek-chat');
  assert.equal(modelIdFor({ catalog: undefined, selection: undefined }), null);
});
