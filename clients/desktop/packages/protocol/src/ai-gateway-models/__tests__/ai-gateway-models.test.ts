import {
  AI_GATEWAY_MODEL_CATALOG_MAX_BODY_BYTES,
  AI_GATEWAY_MODEL_CATALOG_VERSION,
  isAiGatewayModelCatalogResponse,
  isAiGatewayModelFamily,
  parseAiGatewayModelCatalogResponse,
} from '..';

const valid = {
  version: AI_GATEWAY_MODEL_CATALOG_VERSION,
  models: [
    {
      id: 'model-a',
      gatewayId: 'provider/model-a',
      label: 'Model A',
      family: 'anthropic',
      familyLabel: 'Anthropic',
      recommendedHarness: 'codex',
      contextWindow: 100_000,
      supportsPromptCaching: false,
      requiresLocalHarnessSupport: false,
      showMoreOnly: false,
      supportedThinkingLevels: ['low', 'high'],
      toolSchemaProfile: 'standard',
    },
  ],
};

describe('AI Gateway model catalog contract', () => {
  it('serves catalog version 9', () => {
    expect(AI_GATEWAY_MODEL_CATALOG_VERSION).toBe(9);
  });

  it('promotes a frozen v7 response to the current version', () => {
    expect(
      parseAiGatewayModelCatalogResponse({
        ...valid,
        version: 7,
        models: [{ ...valid.models[0], cursorModelId: 'model-a' }],
      }),
    ).toEqual({
      ...valid,
      models: [{ ...valid.models[0], cursorModelId: 'model-a' }],
    });
  });

  it('accepts any registry family slug, including the reserved org family', () => {
    for (const family of ['mistral', 'x-ai', 'custom', 'a'.repeat(64)]) {
      expect(isAiGatewayModelFamily(family)).toBe(true);
      expect(
        parseAiGatewayModelCatalogResponse({
          ...valid,
          models: [
            { ...valid.models[0], family, familyLabel: `Label ${family}` },
          ],
        }).models[0],
      ).toMatchObject({ family, familyLabel: `Label ${family}` });
    }
  });

  it.each(['', 'Mistral', '-mistral', 'mistral ai', 'a'.repeat(65), 7])(
    'rejects the malformed family %j',
    (family) => {
      expect(isAiGatewayModelFamily(family)).toBe(false);
      expect(
        isAiGatewayModelCatalogResponse({
          ...valid,
          models: [{ ...valid.models[0], family }],
        }),
      ).toBe(false);
    },
  );

  it('promotes a frozen v6 response but rejects v6 with newer fields', () => {
    expect(
      parseAiGatewayModelCatalogResponse({ ...valid, version: 6 }),
    ).toEqual(valid);
    expect(() =>
      parseAiGatewayModelCatalogResponse({
        ...valid,
        version: 6,
        models: [{ ...valid.models[0], cursorModelId: 'model-a' }],
      }),
    ).toThrow();
  });

  it('accepts an explicit Cursor model identity independent of the gateway ID', () => {
    expect(
      isAiGatewayModelCatalogResponse({
        ...valid,
        models: [{ ...valid.models[0], cursorModelId: 'cursor-vendor-model' }],
      }),
    ).toBe(true);
  });

  it.each(['', 'with space', 'model\n', 'a'.repeat(513), null])(
    'rejects invalid Cursor model identity %j',
    (cursorModelId) => {
      expect(
        isAiGatewayModelCatalogResponse({
          ...valid,
          models: [{ ...valid.models[0], cursorModelId }],
        }),
      ).toBe(false);
    },
  );
  it('accepts the exact versioned contract, including false and empty arrays', () => {
    const parsed = parseAiGatewayModelCatalogResponse({
      version: AI_GATEWAY_MODEL_CATALOG_VERSION,
      models: [
        {
          ...valid.models[0],
          supportedThinkingLevels: [],
        },
      ],
    });
    expect(parsed.models[0]).toMatchObject({
      family: 'anthropic',
      familyLabel: 'Anthropic',
      supportsPromptCaching: false,
      requiresLocalHarnessSupport: false,
      showMoreOnly: false,
      supportedThinkingLevels: [],
      toolSchemaProfile: 'standard',
    });
  });

  it('accepts an optional model description', () => {
    expect(
      isAiGatewayModelCatalogResponse({
        ...valid,
        models: [{ ...valid.models[0], description: 'Best for coding.' }],
      }),
    ).toBe(true);
  });

  it.each([
    [{ ...valid, version: AI_GATEWAY_MODEL_CATALOG_VERSION - 1 }],
    [{ ...valid, extra: true }],
    [
      {
        ...valid,
        models: [{ ...valid.models[0], supportsPromptCaching: undefined }],
      },
    ],
    [
      {
        ...valid,
        models: [
          { ...valid.models[0], requiresLocalHarnessSupport: undefined },
        ],
      },
    ],
    [
      {
        ...valid,
        models: [{ ...valid.models[0], showMoreOnly: undefined }],
      },
    ],
    [
      {
        ...valid,
        models: [
          { ...valid.models[0], supportedThinkingLevels: ['high', 'low'] },
        ],
      },
    ],
    [
      {
        ...valid,
        models: [
          { ...valid.models[0], supportedThinkingLevels: ['low', 'low'] },
        ],
      },
    ],
    [
      {
        ...valid,
        models: [{ ...valid.models[0], family: 'Other Family' }],
      },
    ],
    [
      {
        ...valid,
        models: [{ ...valid.models[0], familyLabel: undefined }],
      },
    ],
    [
      {
        ...valid,
        models: [{ ...valid.models[0], internal: true }],
      },
    ],
    [
      {
        ...valid,
        models: [{ ...valid.models[0], contextWindow: '100000' }],
      },
    ],
  ])('rejects invalid or non-exact payload %#', (payload) => {
    expect(isAiGatewayModelCatalogResponse(payload)).toBe(false);
  });

  it('rejects duplicate IDs, duplicate gateway IDs, and oversized bodies', () => {
    expect(
      isAiGatewayModelCatalogResponse({
        ...valid,
        models: [valid.models[0], { ...valid.models[0] }],
      }),
    ).toBe(false);
    expect(
      isAiGatewayModelCatalogResponse(
        valid,
        AI_GATEWAY_MODEL_CATALOG_MAX_BODY_BYTES + 1,
      ),
    ).toBe(false);
  });
});

it('preserves v9 exact-thinking metadata and refuses it in frozen older shapes', () => {
  const exact = {
    ...valid,
    models: [{ ...valid.models[0], thinkingLevelsExact: true }],
  };
  expect(parseAiGatewayModelCatalogResponse(exact)).toEqual(exact);
  for (const version of [6, 7, 8]) {
    expect(() =>
      parseAiGatewayModelCatalogResponse({ ...exact, version }),
    ).toThrow();
    expect(parseAiGatewayModelCatalogResponse({ ...valid, version })).toEqual(
      valid,
    );
  }
  for (const thinkingLevelsExact of [false, 'true', null, 1]) {
    expect(
      isAiGatewayModelCatalogResponse({
        ...valid,
        models: [{ ...valid.models[0], thinkingLevelsExact }],
      }),
    ).toBe(false);
  }
});
