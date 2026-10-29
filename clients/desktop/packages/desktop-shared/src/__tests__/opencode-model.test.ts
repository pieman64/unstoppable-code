import { resolveKnownModel, isBaseModelSelectableForAgent } from '../types';
import {
  enrichOpenCodeModels,
  getRawOpenCodeModelId,
  isOpenCodeModel,
  openCodeModelsFromConfig,
  toOpenCodeModelId,
} from '../lib/opencode-models';

describe('OpenCode model identities', () => {
  test('enriches v2 model entries without adding unadvertised models', () => {
    const entries = [
      {
        id: toOpenCodeModelId('fixture/model'),
        rawModelId: 'fixture/model',
        label: 'Fixture',
        supportsVision: false,
        supportedThinkingLevels: [],
      },
    ];
    expect(
      enrichOpenCodeModels(entries, [
        {
          providerID: 'fixture',
          id: 'model',
          limit: { context: 32000 },
          capabilities: { input: ['text', 'image'] },
          variants: [{ id: 'high' }],
        },
      ]),
    ).toEqual([
      {
        ...entries[0],
        contextWindow: 32000,
        supportsVision: true,
        supportedThinkingLevels: ['high'],
      },
    ]);
  });
  test('preserves provider-qualified identities without aliasing another harness', () => {
    const raw = 'anthropic/claude-sonnet-4-5';
    expect(toOpenCodeModelId(raw)).toBe(
      'opencode:anthropic%2Fclaude-sonnet-4-5',
    );
    expect(getRawOpenCodeModelId(toOpenCodeModelId(raw))).toBe(raw);
    expect(isOpenCodeModel('claude-sonnet-4-5')).toBe(false);
    expect(isOpenCodeModel('copilot:claude-sonnet-4-5')).toBe(false);
  });

  test.each([
    'opencode:',
    'opencode:%',
    'opencode:anthropic/model',
    'opencode:bad%20model',
  ])('rejects malformed or noncanonical identity %s', (id) => {
    expect(isOpenCodeModel(id)).toBe(false);
  });

  test('discovers only explicitly advertised ACP model options', () => {
    expect(
      openCodeModelsFromConfig([
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'test/model',
          options: [
            { value: 'test/model', name: 'Test / Model' },
            {
              group: 'Other',
              options: [{ value: 'other/model', name: 'Other model' }],
            },
          ],
        },
      ]),
    ).toEqual([
      {
        id: 'opencode:test%2Fmodel',
        rawModelId: 'test/model',
        label: 'Test / Model',
        supportsVision: false,
        supportedThinkingLevels: [],
      },
      {
        id: 'opencode:other%2Fmodel',
        rawModelId: 'other/model',
        label: 'Other model',
        supportsVision: false,
        supportedThinkingLevels: [],
      },
    ]);
  });

  test('rejects malformed and duplicated vendor catalog entries', () => {
    expect(() =>
      openCodeModelsFromConfig([
        {
          id: 'model',
          type: 'select',
          options: [
            { value: 'test/model', name: 'One' },
            { value: 'test/model', name: 'Two' },
          ],
        },
      ]),
    ).toThrow();
    expect(() =>
      openCodeModelsFromConfig([
        {
          id: 'model',
          type: 'select',
          options: [{ value: 'test/model', name: 'Misleading\nlabel' }],
        },
      ]),
    ).toThrow();
  });

  test('uses native provider capabilities without adding unadvertised models', () => {
    const entries = openCodeModelsFromConfig([
      {
        id: 'model',
        type: 'select',
        options: [{ value: 'test/model', name: 'Test model' }],
      },
    ]);
    expect(
      enrichOpenCodeModels(entries, {
        all: [
          {
            id: 'test',
            models: {
              model: {
                limit: { context: 200000 },
                capabilities: { input: { image: true } },
                variants: { high: {}, custom: {} },
              },
              hidden: { capabilities: { input: { image: true } } },
            },
          },
        ],
      }),
    ).toEqual([
      {
        ...entries[0],
        contextWindow: 200000,
        supportsVision: true,
        supportedThinkingLevels: ['high'],
      },
    ]);
  });
});

it('accepts canonical OpenCode IDs for model changes and configured Agents before discovery', () => {
  expect(resolveKnownModel('opencode:fixture%2Fmodel')).toBe(
    'opencode:fixture%2Fmodel',
  );
  expect(isBaseModelSelectableForAgent('opencode:fixture%2Fmodel')).toBe(true);
});
