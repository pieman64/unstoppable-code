import {
  initCursorModels,
  initClaudeModels,
  initCodexModels,
  initOllamaModels,
  initAiGatewayModels,
  resolveKnownModel,
  getExecutionHarnessForModel,
  getModelSource,
  getProviderForModel,
  getCanonicalCursorModel,
  getModelDisplayName,
  getEffectiveSupportedThinkingLevelsForModel,
  getCurrentModelHarnessCatalog,
  buildModelHarnessAssignmentSnapshot,
  applyModelHarnessOverrideMutation,
  initModelHarnessAssignments,
  resolveDefaultChatModel,
  getCursorModelMappings,
} from '../types';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import {
  cursorModelNamesFromAcp,
  cursorModelsFromAcp,
  toCursorModelId,
  getRawCursorModelId,
  getCursorModelVendor,
} from '../lib/cursor-models';

test.each([
  ['claude-sonnet-4-5[thinking=true]', 'anthropic'],
  ['gpt-5.6-luna[reasoning=medium]', 'openai'],
  ['gemini-3.1-pro[]', 'google'],
  ['kimi-k3[]', 'moonshot'],
  ['composer-2.5[]', 'cursor'],
  ['default[]', 'cursor'],
  ['unknown-claude-sonnet[]', undefined],
  ['vendor:模型~variant', undefined],
])(
  'classifies the maker of %s without changing its runtime ID',
  (raw, vendor) => {
    const id = toCursorModelId(raw);
    expect(getCursorModelVendor(id)).toBe(vendor);
    expect(getRawCursorModelId(id)).toBe(raw);
  },
);

test('uses explicit Cursor mappings for native and API models without inventing support', () => {
  initCursorModels([]);
  initClaudeModels([
    Object.assign(
      { id: 'haiku', label: 'Haiku 4.5' },
      {
        cursorModelId: 'claude-haiku-4-5',
      },
    ),
  ]);
  initCodexModels([]);
  initAiGatewayModels(
    [
      Object.assign(
        {
          id: 'moonshot-k3',
          label: 'Kimi K3',
          recommendedHarness: 'codex' as const,
          contextWindow: 200_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard' as const,
        },
        { cursorModelId: 'kimi-k3' },
      ),
    ],
    [],
  );
  const haiku = toCursorModelId('claude-haiku-4-5[]');
  const kimi = toCursorModelId('kimi-k3[]');
  try {
    expect(getCursorModelMappings()).toEqual({});
    initCursorModels([
      {
        id: haiku,
        rawModelId: 'claude-haiku-4-5[]',
        label: 'claude-haiku-4-5',
      },
      { id: kimi, rawModelId: 'kimi-k3[]', label: 'kimi-k3' },
    ]);
    expect(getCursorModelMappings()).toEqual({ haiku, 'moonshot-k3': kimi });
    expect(getModelDisplayName(haiku)).toBe('Haiku 4.5');
    expect(getModelDisplayName(kimi)).toBe('Kimi K3');
    const snapshot = buildModelHarnessAssignmentSnapshot({
      catalog: getCurrentModelHarnessCatalog(),
    });
    expect(
      snapshot.assignments.find((row) => row.modelId === 'moonshot-k3'),
    ).toMatchObject({ availableHarnesses: ['claude', 'codex', 'cursor'] });
    expect(snapshot.assignments.some((row) => row.modelId === kimi)).toBe(
      false,
    );
  } finally {
    initCursorModels([]);
    initClaudeModels([]);
    initAiGatewayModels([], []);
  }
});

test('an explicit Cursor identity takes precedence over an inferred native ID', () => {
  initCodexModels([
    Object.assign(
      { id: 'native-model', label: 'Native Model' },
      { cursorModelId: 'vendor-model' },
    ),
  ]);
  initCursorModels([
    {
      id: 'cursor:native-model',
      rawModelId: 'native-model',
      label: 'Unrelated vendor model',
    },
  ]);
  try {
    expect(getCursorModelMappings()).toEqual({});
    expect(getCanonicalCursorModel('cursor:native-model')).toBe(
      'cursor:native-model',
    );
  } finally {
    initCodexModels([]);
    initCursorModels([]);
  }
});

test('merges a supported Cursor model with the native catalog label and default harness choices', () => {
  initCodexModels([{ id: 'gpt-shared', label: 'GPT Shared' }]);
  const id = toCursorModelId('gpt-shared[reasoning=medium]');
  initCursorModels([
    { id, rawModelId: 'gpt-shared[reasoning=medium]', label: 'Vendor label' },
  ]);
  try {
    expect(getModelDisplayName(id)).toBe('GPT Shared');
    const catalog = getCurrentModelHarnessCatalog();
    const changed = applyModelHarnessOverrideMutation({
      modelId: 'gpt-shared',
      harness: 'cursor',
      catalog,
      overrides: {},
    });
    const snapshot = buildModelHarnessAssignmentSnapshot({
      catalog,
      overrides: changed.overrides,
    });
    initModelHarnessAssignments(snapshot);
    expect(resolveDefaultChatModel('gpt-shared')).toBe(id);
    expect(getExecutionHarnessForModel('gpt-shared')).toBe('codex');
    expect(getExecutionHarnessForModel(id)).toBe('cursor');
    expect(() =>
      applyModelHarnessOverrideMutation({
        modelId: 'gpt-shared',
        harness: 'claude',
        catalog,
        overrides: {},
      }),
    ).toThrow('does not support');
    expect(
      snapshot.assignments.filter((row) => row.modelId === id),
    ).toHaveLength(0);
    expect(
      snapshot.assignments.find((row) => row.modelId === 'gpt-shared'),
    ).toMatchObject({
      harness: 'cursor',
      configurable: true,
      availableHarnesses: ['codex', 'cursor'],
    });
    initCursorModels([]);
    expect(resolveDefaultChatModel('gpt-shared')).toBe('gpt-shared');
    expect(
      buildModelHarnessAssignmentSnapshot({
        catalog: getCurrentModelHarnessCatalog(),
        overrides: changed.overrides,
      }).assignments.find((row) => row.modelId === 'gpt-shared'),
    ).toMatchObject({
      harness: 'codex',
      configurable: false,
    });
  } finally {
    initModelHarnessAssignments({ revision: 0, assignments: [] });
    initCursorModels([]);
    initCodexModels([]);
  }
});

test('reads stable ACP grouped model options and keeps opaque variants distinct', () => {
  const selector: SessionConfigOption = {
    id: 'model',
    name: 'Model',
    type: 'select',
    currentValue: 'default[]',
    options: [
      {
        group: 'vendor',
        name: 'Vendor',
        options: [
          { value: 'default[]', name: 'Auto' },
          { value: 'gpt-test[reasoning=high]', name: 'GPT Test High' },
          { value: 'gpt-test[reasoning=low]', name: 'GPT Test Low' },
        ],
      },
    ],
  };
  const models = cursorModelsFromAcp([selector]);
  expect(models.map((entry) => entry.id)).toEqual([
    'cursor-default',
    'cursor:gpt-test%5Breasoning%3Dhigh%5D',
    'cursor:gpt-test%5Breasoning%3Dlow%5D',
  ]);
  initCursorModels(models);
  expect(getModelDisplayName(models[1].id)).toBe('GPT Test High');
  initCursorModels([]);
  expect(getModelDisplayName(models[1].id)).toBe('gpt-test');
  expect(() => cursorModelsFromAcp([])).toThrow('unavailable');
  expect(() => cursorModelsFromAcp([selector, selector])).toThrow(
    'unavailable',
  );
  expect(() =>
    cursorModelsFromAcp([
      {
        ...selector,
        options: [
          { value: 'default[]', name: 'Auto' },
          { value: 'default[]', name: 'Duplicate' },
        ],
      },
    ]),
  ).toThrow('unavailable');
});

test('matches configured native identities while retaining additional variants', () => {
  initClaudeModels([
    { id: 'sonnet', label: 'Sonnet', gatewayId: 'anthropic/claude-sonnet-4.5' },
  ]);
  const rawModelId = 'claude-sonnet-4-5[thinking=true]';
  const id = toCursorModelId(rawModelId);
  const secondRaw = 'claude-sonnet-4-5[thinking=false]';
  try {
    initCursorModels([{ id, rawModelId, label: 'Cursor Sonnet' }]);
    expect(getModelDisplayName(id)).toBe('Sonnet');
    initCursorModels([
      { id, rawModelId, label: 'Cursor Sonnet Thinking' },
      {
        id: toCursorModelId(secondRaw),
        rawModelId: secondRaw,
        label: 'Cursor Sonnet Fast',
      },
    ]);
    expect(getModelDisplayName(id)).toBe('Sonnet');
    expect(getModelDisplayName(toCursorModelId(secondRaw))).toBe(
      'Cursor Sonnet Fast',
    );
    expect(
      buildModelHarnessAssignmentSnapshot({
        catalog: getCurrentModelHarnessCatalog(),
      }).assignments.find((row) => row.modelId === 'sonnet'),
    ).toMatchObject({ configurable: true });
  } finally {
    initCursorModels([]);
    initClaudeModels([]);
  }
});

describe('Cursor interactive model identity', () => {
  it('keeps Cursor separate from the inference provider and gateway routes', () => {
    expect(getProviderForModel('cursor-default')).toBe('cursor');
    expect(getModelSource('cursor-default')).toBe('cursor-managed');
    expect(getExecutionHarnessForModel('cursor-default')).toBe('cursor');
    expect(getModelDisplayName('cursor-default')).toBe('Cursor default');
    expect(
      getEffectiveSupportedThinkingLevelsForModel('cursor-default', false),
    ).toEqual([]);
  });
});

test('preserves discovered Cursor identity before a catalog has loaded', () => {
  const model = 'cursor:' + encodeURIComponent('gpt-6-luna[reasoning=medium]');
  expect(resolveKnownModel(model)).toBe(model);
  expect(getProviderForModel(model)).toBe('cursor');
  expect(getModelSource(model)).toBe('cursor-managed');
  expect(getExecutionHarnessForModel(model)).toBe('cursor');
  expect(getEffectiveSupportedThinkingLevelsForModel(model, false)).toEqual([]);
});
test.each(['cursor:', 'cursor:%', 'cursor:%0A', 'cursor:%2D%2Dmodel'])(
  'rejects malformed Cursor identity %s',
  (model) => {
    expect(resolveKnownModel(model)).toBeUndefined();
  },
);

test.each([initClaudeModels, initCodexModels, initOllamaModels])(
  'retains Cursor labels when %p refreshes its catalog',
  (refresh) => {
    const rawModelId = 'gpt-test[reasoning=high]';
    const id = toCursorModelId(rawModelId);
    initCursorModels([{ id, rawModelId, label: 'GPT Test High' }]);
    try {
      refresh([]);
      expect(getModelDisplayName(id)).toBe('GPT Test High');
    } finally {
      initCursorModels([]);
    }
  },
);

test.each(['vendor:model', 'model~variant', '模型', 'model🚀', '--model'])(
  'round-trips the opaque advertised model %s',
  (rawModelId) => {
    const models = cursorModelsFromAcp([
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        currentValue: rawModelId,
        options: [{ value: rawModelId, name: 'Vendor model' }],
      },
    ]);
    expect(models).toEqual([
      {
        id: toCursorModelId(rawModelId),
        rawModelId,
        label: 'Vendor model',
      },
    ]);
    expect(getRawCursorModelId(models[0].id)).toBe(rawModelId);
    expect(getExecutionHarnessForModel(models[0].id)).toBe('cursor');
  },
);

test.each([
  '',
  'with space',
  ' leading',
  'trailing ',
  'model\n',
  'model\x00',
  'model\x7f',
  '\ud800',
  'a'.repeat(513),
])('rejects invalid raw model identifiers %j', (rawModelId) => {
  expect(() => toCursorModelId(rawModelId)).toThrow('Invalid Cursor model.');
});

test('bounds the encoded namespace to the shared harness model-ID limit', () => {
  for (const raw of ['a'.repeat(505), '模'.repeat(56)]) {
    expect(getExecutionHarnessForModel(toCursorModelId(raw))).toBe('cursor');
  }
  for (const raw of ['a'.repeat(506), '模'.repeat(57)]) {
    expect(() => toCursorModelId(raw)).toThrow('Invalid Cursor model.');
  }
});

test('preserves a persisted Cursor label and canonical identity without discovery', () => {
  initClaudeModels([
    { id: 'sonnet', label: 'Sonnet', gatewayId: 'anthropic/claude-sonnet-4.5' },
  ]);
  initCursorModels([]);
  const id = toCursorModelId('claude-sonnet-4-5[thinking=true]');
  expect(getCanonicalCursorModel(id)).toBe('sonnet');
  expect(getModelDisplayName(id)).toBe('Sonnet');
});

describe('Cursor raw model labels', () => {
  afterEach(() => {
    initCursorModels([]);
    initClaudeModels([]);
    initCodexModels([]);
    initAiGatewayModels([], []);
  });

  test.each([
    ['gemini-3.1-pro[]', 'gemini-3.1-pro'],
    ['composer-2.5[fast=true]', 'composer-2.5'],
    ['grok-4.6[effort=high,fast=true]', 'grok-4.6'],
  ])(
    'hides execution parameters for the sole advertised %s choice',
    (raw, label) => {
      const id = toCursorModelId(raw);
      initCursorModels([{ id, rawModelId: raw, label: raw }]);
      expect(getModelDisplayName(id)).toBe(label);
      expect(getRawCursorModelId(id)).toBe(raw);
    },
  );

  test('keeps a clean persisted label before discovery', () => {
    initCursorModels([]);
    const id = toCursorModelId('gemini-3.1-pro[]');
    expect(getModelDisplayName(id)).toBe('gemini-3.1-pro');
    expect(resolveKnownModel(id)).toBe(id);
  });

  test('distinguishes raw variants without displaying ACP syntax', () => {
    const entries = ['high', 'low'].map((effort) => {
      const rawModelId = `vendor-model[reasoning=${effort}]`;
      return { id: toCursorModelId(rawModelId), rawModelId, label: rawModelId };
    });
    initCursorModels(entries);
    expect(entries.map((entry) => getModelDisplayName(entry.id))).toEqual([
      'vendor-model (reasoning: high)',
      'vendor-model (reasoning: low)',
    ]);
  });

  test('preserves an actual vendor display name', () => {
    const rawModelId = 'vendor-model[reasoning=high]';
    const id = toCursorModelId(rawModelId);
    initCursorModels([{ id, rawModelId, label: 'Vendor Model [Preview]' }]);
    expect(getModelDisplayName(id)).toBe('Vendor Model [Preview]');
  });

  test('uses the catalog name for a raw additional variant', () => {
    initClaudeModels([
      { id: 'sonnet', label: 'Sonnet', cursorModelId: 'claude-sonnet-4-5' },
    ]);
    const entries = ['true', 'false'].map((thinking) => {
      const rawModelId = `claude-sonnet-4-5[thinking=${thinking}]`;
      return { id: toCursorModelId(rawModelId), rawModelId, label: rawModelId };
    });
    initCursorModels(entries);
    expect(entries.map((entry) => getModelDisplayName(entry.id))).toEqual([
      'Sonnet',
      'Sonnet (thinking: false)',
    ]);
    expect(getCanonicalCursorModel(entries[1].id)).toBe(entries[1].id);
  });

  test('leaves opaque non-parameter suffixes intact', () => {
    const raw = 'vendor:模型[preview]';
    const id = toCursorModelId(raw);
    initCursorModels([{ id, rawModelId: raw, label: raw }]);
    expect(getModelDisplayName(id)).toBe(raw);
    initCursorModels([]);
    expect(getModelDisplayName(id)).toBe(raw);
  });

  // The pinned runtime's variant picker names each option by its bare slug;
  // readable names come only from its model catalog extension.
  test('names slug-labelled options from the Cursor catalog in Canopy style', () => {
    const options = [
      ['default[]', 'Auto'],
      ['claude-opus-4-5[thinking=true]', 'claude-opus-4-5'],
      ['claude-sonnet-4[thinking=false,context=200k]', 'claude-sonnet-4'],
      ['gpt-5.1[reasoning=medium]', 'gpt-5.1'],
      ['gpt-5-mini[]', 'gpt-5-mini'],
      ['gpt-5.3-codex[reasoning=medium,fast=false]', 'gpt-5.3-codex'],
      ['gemini-3.1-pro[]', 'gemini-3.1-pro'],
      ['kimi-k2.7-code[]', 'kimi-k2.7-code'],
    ];
    const names = cursorModelNamesFromAcp({
      models: [
        { value: 'default', name: 'Auto' },
        { value: 'claude-opus-4-5', name: 'Claude Opus 4.5' },
        { value: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
        { value: 'gpt-5.1', name: 'GPT-5.1' },
        { value: 'gpt-5-mini', name: 'GPT-5 Mini' },
        { value: 'gpt-5.3-codex', name: 'Codex 5.3' },
        { value: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
        { value: 'kimi-k2.7-code', name: 'Kimi K2.7 Code' },
      ],
    });
    const models = cursorModelsFromAcp(
      [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'default[]',
          options: options.map(([value, name]) => ({ value, name })),
        },
      ],
      names,
    );
    // Display names never change the opaque execution identity.
    expect(models.map((model) => model.rawModelId)).toEqual(
      options.map(([value]) => value),
    );
    initCursorModels(models);
    expect(models.map((model) => getModelDisplayName(model.id))).toEqual([
      'Cursor default',
      'Opus 4.5',
      'Sonnet 4',
      'GPT 5.1',
      'GPT 5 Mini',
      'Codex 5.3',
      'Gemini 3.1 Pro',
      'Kimi K2.7 Code',
    ]);
  });

  test('disambiguates slug-labelled variants with the catalog name', () => {
    const entries = ['high', 'low'].map((effort) => {
      const rawModelId = `vendor-model[reasoning=${effort}]`;
      return {
        id: toCursorModelId(rawModelId),
        rawModelId,
        label: 'vendor-model',
        catalogName: 'Vendor Model',
      };
    });
    initCursorModels(entries);
    expect(entries.map((entry) => getModelDisplayName(entry.id))).toEqual([
      'Vendor Model (reasoning: high)',
      'Vendor Model (reasoning: low)',
    ]);
  });

  test('disambiguates different models that share a catalog name', () => {
    const entries = ['gpt-5[]', 'gpt5[]'].map((rawModelId) => ({
      id: toCursorModelId(rawModelId),
      rawModelId,
      label: rawModelId.slice(0, -2),
      catalogName: 'GPT 5',
    }));
    initCursorModels(entries);
    expect(entries.map((entry) => getModelDisplayName(entry.id))).toEqual([
      'GPT 5 (gpt-5)',
      'GPT 5 (gpt5)',
    ]);
  });

  test('keeps the Claude prefix before a version and opaque suffixes intact', () => {
    const names = cursorModelNamesFromAcp({
      models: [
        { value: 'claude-4.5-sonnet', name: 'Claude 4.5 Sonnet' },
        { value: 'vendor-x', name: 'Vendor X' },
      ],
    });
    expect(names.get('claude-4.5-sonnet')).toBe('Claude 4.5 Sonnet');
    // `[fast]` is not an ACP parameter list, so the ID has no known base.
    const [, opaque] = cursorModelsFromAcp(
      [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'default[]',
          options: [
            { value: 'default[]', name: 'Auto' },
            { value: 'vendor-x[fast]', name: 'vendor-x' },
          ],
        },
      ],
      names,
    );
    expect(opaque).not.toHaveProperty('catalogName');
    initCursorModels([opaque]);
    expect(getModelDisplayName(opaque.id)).toBe('vendor-x');
  });

  test('keeps the parameter-free slug when the catalog has no name', () => {
    const rawModelId = 'gemini-3.1-pro[]';
    const id = toCursorModelId(rawModelId);
    initCursorModels([{ id, rawModelId, label: 'gemini-3.1-pro' }]);
    expect(getModelDisplayName(id)).toBe('gemini-3.1-pro');
  });

  test('ignores malformed Cursor catalog names', () => {
    expect(cursorModelNamesFromAcp(undefined).size).toBe(0);
    expect(cursorModelNamesFromAcp({ models: 'none' }).size).toBe(0);
    expect(
      cursorModelNamesFromAcp({
        models: Array.from({ length: 1001 }, (_, index) => ({
          value: `model-${index}`,
          name: 'Model',
        })),
      }).size,
    ).toBe(0);
    expect(
      cursorModelNamesFromAcp({
        models: [
          { value: 'empty', name: ' ' },
          { value: 'control', name: 'Bell\u0007' },
          { value: 1, name: 'Numeric' },
          { value: 'long', name: 'x'.repeat(257) },
          { value: 'claude', name: 'Claude' },
          { value: 'claude', name: 'Duplicate' },
        ],
      }),
    ).toEqual(new Map([['claude', 'Claude']]));
  });
});

describe('Cursor thinking support', () => {
  const reasoning: SessionConfigOption = {
    id: 'reasoning',
    name: 'Reasoning',
    category: 'thought_level',
    type: 'select',
    currentValue: 'medium',
    options: ['none', 'low', 'medium', 'high', 'xhigh'].map((value) => ({
      value,
      name: value,
    })),
  };
  const selector: SessionConfigOption = {
    id: 'model',
    name: 'Model',
    type: 'select',
    currentValue: 'default[]',
    options: [
      { value: 'default[]', name: 'Auto' },
      { value: 'gpt-test[reasoning=medium]', name: 'GPT Test' },
      { value: 'plain-test[]', name: 'Plain Test' },
    ],
  };
  afterEach(() => {
    initCursorModels([]);
    initCodexModels([]);
  });

  test('projects each advertised model onto the levels its listing declares', () => {
    const listing = new Map<string, SessionConfigOption[]>([
      ['default', []],
      ['gpt-test', [reasoning]],
    ]);
    expect(cursorModelsFromAcp([selector], new Map(), listing)).toEqual([
      {
        id: 'cursor-default',
        rawModelId: 'default[]',
        label: 'Cursor default',
        supportedThinkingLevels: [],
      },
      {
        id: 'cursor:gpt-test%5Breasoning%3Dmedium%5D',
        rawModelId: 'gpt-test[reasoning=medium]',
        label: 'GPT Test',
        supportedThinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
      },
      // Not in the listing: support stays unknown rather than invented.
      {
        id: 'cursor:plain-test%5B%5D',
        rawModelId: 'plain-test[]',
        label: 'Plain Test',
      },
    ]);
    expect(cursorModelsFromAcp([selector])).toEqual(
      cursorModelsFromAcp([selector]).map((entry) => {
        expect(entry).not.toHaveProperty('supportedThinkingLevels');
        return entry;
      }),
    );
  });

  test('the registry answers thinking support from the discovered entries', () => {
    const gpt = toCursorModelId('gpt-test[reasoning=medium]');
    const plain = toCursorModelId('plain-test[]');
    initCursorModels([
      {
        id: gpt,
        rawModelId: 'gpt-test[reasoning=medium]',
        label: 'GPT Test',
        supportedThinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
      },
      { id: plain, rawModelId: 'plain-test[]', label: 'Plain Test' },
      {
        id: 'cursor-default',
        rawModelId: 'default[]',
        label: 'Cursor default',
        supportedThinkingLevels: [],
      },
    ]);
    expect(getEffectiveSupportedThinkingLevelsForModel(gpt, false)).toEqual([
      'off',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    expect(
      getEffectiveSupportedThinkingLevelsForModel(
        gpt,
        false,
        'cursor',
        'cursor',
      ),
    ).toEqual(['off', 'low', 'medium', 'high', 'xhigh']);
    // Unknown support and Auto both hide the control.
    expect(getEffectiveSupportedThinkingLevelsForModel(plain, false)).toEqual(
      [],
    );
    expect(
      getEffectiveSupportedThinkingLevelsForModel('cursor-default', false),
    ).toEqual([]);
    initCursorModels([]);
    expect(getEffectiveSupportedThinkingLevelsForModel(gpt, false)).toEqual([]);
  });

  test('a native model drafted on the Cursor harness follows its advertised Cursor variant', () => {
    initCodexModels([
      {
        id: 'gpt-test',
        label: 'GPT Test',
        supportedThinkingLevels: ['off', 'max'],
      },
    ]);
    const gpt = toCursorModelId('gpt-test[reasoning=medium]');
    initCursorModels([
      {
        id: gpt,
        rawModelId: 'gpt-test[reasoning=medium]',
        label: 'GPT Test',
        supportedThinkingLevels: ['off', 'medium', 'high'],
      },
    ]);
    expect(
      getEffectiveSupportedThinkingLevelsForModel('gpt-test', false, 'codex'),
    ).toEqual(['off', 'max']);
    expect(
      getEffectiveSupportedThinkingLevelsForModel(
        'gpt-test',
        false,
        'codex',
        'cursor',
      ),
    ).toEqual(['off', 'medium', 'high']);
    initCursorModels([]);
    expect(
      getEffectiveSupportedThinkingLevelsForModel(
        'gpt-test',
        false,
        'codex',
        'cursor',
      ),
    ).toEqual([]);
  });
});
