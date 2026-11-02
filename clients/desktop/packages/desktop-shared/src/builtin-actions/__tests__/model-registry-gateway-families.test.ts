export {};

const ENV_KEYS = [
  'CANOPY_CLAUDE_MODELS',
  'CANOPY_CODEX_MODELS',
  'CANOPY_OLLAMA_MODELS',
  'CANOPY_MODEL_ALIASES',
  'CANOPY_MODEL_THINKING_LEVELS',
  'CANOPY_MODEL_CATALOG',
  'CANOPY_MODEL_HARNESS_ASSIGNMENTS',
] as const;

function gatewayRoute(
  modelId: string,
  family: string,
): Record<string, unknown> {
  return {
    modelId,
    gatewayId: `${family}/${modelId}`,
    family,
    recommendedHarness: 'codex',
    gatewayOnly: true,
    contextWindow: 128_000,
    supportsPromptCaching: false,
    supportedThinkingLevels: ['off', 'low'],
    toolSchemaProfile: 'standard',
  };
}

function modelCatalog(routes: Record<string, unknown>[]): string {
  return JSON.stringify({
    version: 1,
    claudeModels: [],
    codexModels: [],
    ollamaModels: [],
    aiGatewayModels: routes.map((route) => route.modelId),
    gatewayRoutes: routes,
    modelAliases: {},
  });
}

describe('builtin-action model registry gateway families', () => {
  let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;

  beforeEach(() => {
    originalEnv = {};
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    jest.resetModules();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (typeof value === 'string') {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
    jest.resetModules();
  });

  it('keeps every route when the catalog adds a family this build has never seen', async () => {
    process.env.CANOPY_MODEL_CATALOG = modelCatalog([
      gatewayRoute('deepseek-model', 'deepseek'),
      gatewayRoute('mistral-model', 'mistral'),
      gatewayRoute('org-model', 'custom'),
    ]);

    const { hydrateModelRegistryFromEnv } =
      await import('../_lib/model-registry');
    const { getGatewayModelEntry } = await import('../../types');
    hydrateModelRegistryFromEnv();

    expect(getGatewayModelEntry('deepseek-model')?.family).toBe('deepseek');
    expect(getGatewayModelEntry('mistral-model')).toMatchObject({
      family: 'mistral',
      gatewayId: 'mistral/mistral-model',
    });
    expect(getGatewayModelEntry('org-model')?.family).toBe('custom');
  });

  it('still rejects a malformed family key', async () => {
    process.env.CANOPY_MODEL_CATALOG = modelCatalog([
      gatewayRoute('deepseek-model', 'deepseek'),
      gatewayRoute('bad-model', 'Not A Family'),
    ]);

    const { hydrateModelRegistryFromEnv } =
      await import('../_lib/model-registry');
    const { getGatewayModelEntry } = await import('../../types');
    hydrateModelRegistryFromEnv();

    expect(getGatewayModelEntry('deepseek-model')).toBeUndefined();
    expect(getGatewayModelEntry('bad-model')).toBeUndefined();
  });
});
