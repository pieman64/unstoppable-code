import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import {
  cursorModelConfigOptionsFromListing,
  cursorThinkingLevelsFromConfigOptions,
  parseCursorModelVariant,
  planCursorThinking,
} from '../lib/cursor-thinking';

function select(
  id: string,
  category: string,
  currentValue: string,
  values: string[],
): SessionConfigOption {
  return {
    id,
    name: id,
    category,
    type: 'select',
    currentValue,
    options: values.map((value) => ({ value, name: value })),
  };
}

const model = select('model', 'model', 'gpt', ['default', 'gpt']);
const context = select('context', 'model_config', '272k', ['272k', '1m']);
const gptReasoning = select('reasoning', 'thought_level', 'medium', [
  'none',
  'low',
  'medium',
  'high',
  'extra-high',
]);
const claudeThinking = select('thinking', 'thought_level', 'true', [
  'false',
  'true',
]);
const claudeEffort = select('effort', 'thought_level', 'high', [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

describe('parseCursorModelVariant', () => {
  test('splits an advertised variant into its base ID and parameters', () => {
    expect(
      parseCursorModelVariant('gpt-5.6-sol[context=272k,reasoning=medium]'),
    ).toEqual({
      base: 'gpt-5.6-sol',
      parameters: [
        { id: 'context', value: '272k' },
        { id: 'reasoning', value: 'medium' },
      ],
    });
  });
  test('maps the Auto identity to the parameterized base and keeps opaque IDs whole', () => {
    expect(parseCursorModelVariant('default[]')).toEqual({
      base: 'default',
      parameters: [],
    });
    expect(parseCursorModelVariant('vendor:模型~variant')).toEqual({
      base: 'vendor:模型~variant',
      parameters: [],
    });
    // A malformed suffix is not interpreted; the whole ID stays the base so
    // an unadvertised identity fails closed at selection time.
    expect(parseCursorModelVariant('gpt[reasoning]')).toEqual({
      base: 'gpt[reasoning]',
      parameters: [],
    });
  });
});

describe('cursorThinkingLevelsFromConfigOptions', () => {
  test('projects a graded reasoning option onto the canonical levels', () => {
    expect(
      cursorThinkingLevelsFromConfigOptions([model, context, gptReasoning]),
    ).toEqual(['off', 'low', 'medium', 'high', 'xhigh']);
  });
  test('combines a thinking toggle with a graded effort option', () => {
    expect(
      cursorThinkingLevelsFromConfigOptions([
        model,
        claudeThinking,
        context,
        claudeEffort,
      ]),
    ).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max']);
  });
  test('offers off and one "on" level for a thinking toggle alone', () => {
    expect(
      cursorThinkingLevelsFromConfigOptions([model, claudeThinking]),
    ).toEqual(['off', 'medium']);
  });
  test('declares no thinking support when a model has no thought-level option', () => {
    expect(cursorThinkingLevelsFromConfigOptions([model, context])).toEqual([]);
    expect(cursorThinkingLevelsFromConfigOptions([])).toEqual([]);
  });
  test('ignores vendor values it cannot express and keeps the declared set exact', () => {
    expect(
      cursorThinkingLevelsFromConfigOptions([
        select('reasoning', 'thought_level', 'high', ['high', 'max', 'turbo']),
      ]),
    ).toEqual(['high', 'max']);
    expect(
      cursorThinkingLevelsFromConfigOptions([
        select('effort', 'thought_level', 'low', ['minimal', 'low', 'medium']),
      ]),
    ).toEqual(['off', 'low', 'medium']);
  });
});

describe('planCursorThinking', () => {
  test('sets the graded option to the requested level', () => {
    expect(planCursorThinking([model, gptReasoning], 'high')).toEqual({
      applied: 'high',
      sets: [{ configId: 'reasoning', value: 'high' }],
    });
    expect(planCursorThinking([model, gptReasoning], 'xhigh')).toEqual({
      applied: 'xhigh',
      sets: [{ configId: 'reasoning', value: 'extra-high' }],
    });
  });
  test('clamps an undeclared level to the nearest declared one', () => {
    expect(planCursorThinking([model, gptReasoning], 'max')).toEqual({
      applied: 'xhigh',
      sets: [{ configId: 'reasoning', value: 'extra-high' }],
    });
    // Matches the shared clamp every host uses: without a declared `off`
    // the weakest composer-visible tier applies (`low` only displays as
    // Medium), so Cursor runs where the chip says it runs.
    expect(planCursorThinking([model, claudeEffort], 'off')).toEqual({
      applied: 'medium',
      sets: [{ configId: 'effort', value: 'medium' }],
    });
    expect(planCursorThinking([model, claudeEffort], 'ultra')).toEqual({
      applied: 'max',
      sets: [{ configId: 'effort', value: 'max' }],
    });
  });
  test('turns thinking off through the toggle and leaves the effort alone', () => {
    expect(
      planCursorThinking([model, claudeThinking, claudeEffort], 'off'),
    ).toEqual({
      applied: 'off',
      sets: [{ configId: 'thinking', value: 'false' }],
    });
    expect(
      planCursorThinking([model, claudeThinking, claudeEffort], 'medium'),
    ).toEqual({
      applied: 'medium',
      sets: [
        { configId: 'thinking', value: 'true' },
        { configId: 'effort', value: 'medium' },
      ],
    });
  });
  test('turns a graded option off through its weakest value', () => {
    expect(planCursorThinking([model, gptReasoning], 'off')).toEqual({
      applied: 'off',
      sets: [{ configId: 'reasoning', value: 'none' }],
    });
  });
  test('maps every non-off level to "on" for a thinking toggle alone', () => {
    expect(planCursorThinking([model, claudeThinking], 'max')).toEqual({
      applied: 'medium',
      sets: [{ configId: 'thinking', value: 'true' }],
    });
    expect(planCursorThinking([model, claudeThinking], 'off')).toEqual({
      applied: 'off',
      sets: [{ configId: 'thinking', value: 'false' }],
    });
  });
  test('has nothing to apply for a model without thought-level options', () => {
    expect(planCursorThinking([model, context], 'high')).toBeUndefined();
  });
});

describe('cursorModelConfigOptionsFromListing', () => {
  test('keys each advertised model by its base ID with validated options', () => {
    const listing = cursorModelConfigOptionsFromListing({
      models: [
        { value: 'default', name: 'Auto', configOptions: [] },
        { value: 'gpt', name: 'GPT', configOptions: [context, gptReasoning] },
      ],
    });
    expect([...listing.keys()]).toEqual(['default', 'gpt']);
    expect(listing.get('gpt')).toEqual([context, gptReasoning]);
  });
  test('rejects a response without a model list', () => {
    expect(() => cursorModelConfigOptionsFromListing(undefined)).toThrow();
    expect(() =>
      cursorModelConfigOptionsFromListing({ models: 'x' }),
    ).toThrow();
  });
  test('skips malformed and duplicate rows so one odd model hides only itself', () => {
    const listing = cursorModelConfigOptionsFromListing({
      models: [
        {
          value: 'broken',
          configOptions: [{ id: 'reasoning', type: 'select' }],
        },
        { value: 'gpt', configOptions: [gptReasoning] },
        { value: 'gpt', configOptions: [] },
        { value: 42, configOptions: [] },
        { value: 'no-options' },
      ],
    });
    expect([...listing.keys()]).toEqual(['gpt']);
    expect(listing.get('gpt')).toEqual([gptReasoning]);
  });
  test('bounds the list like the names parser', () => {
    const models = Array.from({ length: 1001 }, (_, index) => ({
      value: `m${index}`,
      configOptions: [],
    }));
    expect(cursorModelConfigOptionsFromListing({ models }).size).toBe(0);
    expect(
      cursorModelConfigOptionsFromListing({ models: models.slice(0, 1000) })
        .size,
    ).toBe(1000);
  });
  test('flattens grouped select options instead of rejecting the listing', () => {
    const listing = cursorModelConfigOptionsFromListing({
      models: [
        {
          value: 'gpt',
          configOptions: [
            {
              id: 'reasoning',
              name: 'Reasoning',
              category: 'thought_level',
              type: 'select',
              currentValue: 'medium',
              options: [
                {
                  group: 'standard',
                  name: 'Standard',
                  options: [
                    { value: 'low', name: 'Low' },
                    { value: 'medium', name: 'Medium' },
                  ],
                },
                { value: 'max', name: 'Max' },
              ],
            },
          ],
        },
      ],
    });
    expect(
      cursorThinkingLevelsFromConfigOptions(listing.get('gpt') ?? []),
    ).toEqual(['low', 'medium', 'max']);
  });

  test('drops options that are not selects so callers only see settable values', () => {
    const listing = cursorModelConfigOptionsFromListing({
      models: [
        {
          value: 'gpt',
          configOptions: [
            { id: 'beta', name: 'Beta', type: 'boolean', currentValue: true },
            gptReasoning,
          ],
        },
      ],
    });
    expect(listing.get('gpt')).toEqual([gptReasoning]);
  });
});
