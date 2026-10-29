import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseModelPackageConfig } from '../model-config';
import { mergeAiGatewayModelCatalog } from '../ai-gateway-model-catalog';
import {
  getModelFamily,
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
  initModelAliases,
  resolveKnownModel,
  type AiGatewayModelEntry,
  type GatewayRouteEntry,
} from '../types';
import {
  AI_GATEWAY_MODEL_CATALOG_VERSION,
  type AiGatewayModelFamily,
} from '@canopy/protocol/ai-gateway-models';
import {
  isGatewayOnlyModel,
  isGatewayRoutableModel,
  isRemovedGatewayOnlyModel,
  isUnavailableModelSelection,
  resolveCodexReasoningRouteFamily,
  resolveGatewayModelEntry,
  resolveGatewayToolSchemaProfile,
  resolveModelIdForGatewayId,
} from '../lib/gateway-model-availability';

let initialAiGatewayModels: AiGatewayModelEntry[] = [];
let initialGatewayRoutes: GatewayRouteEntry[] = [];

const FAMILY_BY_GATEWAY_PREFIX: Record<string, AiGatewayModelFamily> = {
  anthropic: 'anthropic',
  openai: 'openai',
  deepseek: 'deepseek',
  moonshotai: 'moonshot',
  minimax: 'minimax',
  zai: 'zai',
};

function familyForGatewayId(gatewayId: string): AiGatewayModelFamily {
  const family = FAMILY_BY_GATEWAY_PREFIX[gatewayId.split('/')[0] ?? ''];
  if (!family) {
    throw new Error(`unmapped gateway prefix in fixture: ${gatewayId}`);
  }
  return family;
}

beforeAll(() => {
  const pkg = JSON.parse(
    readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
  ) as unknown;
  const config = parseModelPackageConfig(pkg);
  const packageModels = [...config.claudeModels, ...config.codexModels].flatMap(
    (entry) =>
      entry.gatewayId
        ? [
            {
              id: `api-${entry.id.replace(/[^\w.-]/g, '-')}`,
              gatewayId: entry.gatewayId,
              family: familyForGatewayId(entry.gatewayId),
              familyLabel: entry.vendor ?? entry.familyLabel ?? 'Test family',
              label: entry.label,
              recommendedHarness: entry.harness ?? 'codex',
              contextWindow: entry.contextWindow ?? 100_000,
              supportsPromptCaching: entry.harness === 'claude',
              requiresLocalHarnessSupport: false,
              showMoreOnly: false,
              supportedThinkingLevels: [],
              toolSchemaProfile: 'standard' as const,
            },
          ]
        : [],
  );
  const apiOnly = [
    ['deepseek-v4-pro', 'deepseek/deepseek-v4-pro'],
    ['kimi-k2-thinking', 'moonshotai/kimi-k2-thinking'],
    ['minimax-m3', 'minimax/minimax-m3'],
    ['deepseek-v4-flash', 'deepseek/deepseek-v4-flash'],
    ['glm-5.2', 'zai/glm-5.2'],
    ['kimi-k3', 'moonshotai/kimi-k3'],
  ].map(([id, gatewayId]) => ({
    id: id ?? '',
    gatewayId: gatewayId ?? '',
    family: familyForGatewayId(gatewayId ?? ''),
    familyLabel: familyForGatewayId(gatewayId ?? ''),
    label: id ?? '',
    recommendedHarness: 'codex' as const,
    contextWindow: 1_000_000,
    supportsPromptCaching: false,
    requiresLocalHarnessSupport: false,
    showMoreOnly: false,
    supportedThinkingLevels: [],
    toolSchemaProfile:
      id === 'kimi-k3' ? ('flat' as const) : ('standard' as const),
  }));
  const merged = mergeAiGatewayModelCatalog({
    packageConfig: config,
    catalog: {
      version: AI_GATEWAY_MODEL_CATALOG_VERSION,
      models: [...packageModels, ...apiOnly],
    },
    featureFlags: { 'canopy-shared-claude-model-fable5': false },
  });
  initClaudeModels(merged.claudeModels);
  initCodexModels(merged.codexModels);
  initAiGatewayModels(merged.aiGatewayModels, merged.gatewayRoutes);
  initialAiGatewayModels = merged.aiGatewayModels;
  initialGatewayRoutes = merged.gatewayRoutes;
  initModelAliases(merged.modelAliases);
});

describe('gateway-model-availability', () => {
  it('exposes the vendor family for gateway-routed models and aliases', () => {
    expect(getModelFamily('opus[1m]')).toBe('anthropic');
    expect(getModelFamily('claude-opus-5')).toBe('anthropic');
    expect(getModelFamily('kimi-k2-thinking')).toBe('moonshot');
    expect(getModelFamily('glm-5.2')).toBe('zai');
    expect(getModelFamily('minimax-m3')).toBe('minimax');
  });

  it('returns no family for a model with no gateway route', () => {
    expect(getModelFamily('definitely-not-a-model')).toBeUndefined();
  });

  it('resolves canonical Claude runtime ids and configured aliases', () => {
    const canonical = resolveGatewayModelEntry('opus[1m]');
    const alias = resolveGatewayModelEntry('claude-opus-5-5');
    const previous = resolveGatewayModelEntry('claude-opus-5');

    expect(canonical?.modelId).toBe('opus[1m]');
    expect(alias).toEqual(canonical);
    expect(canonical?.recommendedHarness).toBe('claude');
    expect(canonical?.gatewayId).toBe('anthropic/claude-opus-5.5');
    expect(canonical?.contextWindow).toBe(1_000_000);
    expect(previous).toMatchObject({
      modelId: 'claude-opus-5',
      gatewayId: 'anthropic/claude-opus-5',
    });

    const fable = resolveGatewayModelEntry('claude-fable-5-1');
    expect(resolveGatewayModelEntry('fable[1m]')).toEqual(fable);
    expect(resolveGatewayModelEntry('claude-fable-5')).toMatchObject({
      modelId: 'claude-fable-5',
      gatewayId: 'anthropic/claude-fable-5',
    });
    expect(fable?.modelId).toBe('claude-fable-5-1');
    expect(fable?.gatewayId).toBe('anthropic/claude-fable-5.1');
  });

  it.each(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])(
    'resolves configured Codex model %s',
    (modelId) => {
      const entry = resolveGatewayModelEntry(modelId);
      expect(entry?.modelId).toBe(modelId);
      expect(entry?.recommendedHarness).toBe('codex');
    },
  );

  it('resolves saved GPT 5.5 selections to GPT 6.1 Sol', () => {
    expect(resolveKnownModel('gpt-5.5')).toBe('gpt-6.1-sol');
    expect(resolveGatewayModelEntry('gpt-5.5')).toBeUndefined();
  });

  it.each([
    'deepseek-v4-pro',
    'kimi-k2-thinking',
    'minimax-m3',
    'deepseek-v4-flash',
    'glm-5.2',
    'kimi-k3',
  ])('routes other model %s through its explicit Codex harness', (modelId) => {
    const entry = resolveGatewayModelEntry(modelId);
    expect(entry?.modelId).toBe(modelId);
    expect(entry?.recommendedHarness).toBe('codex');
    expect(entry?.gatewayOnly).toBe(true);
    expect(isGatewayOnlyModel(modelId)).toBe(true);
  });

  it.each(['gpt-5.5-codex', 'deepseek-v3.2', 'claude-opus-4.8'])(
    'does not retain removed model %s',
    (modelId) => {
      expect(resolveGatewayModelEntry(modelId)).toBeUndefined();
      expect(isGatewayRoutableModel(modelId)).toBe(false);
    },
  );

  it('keeps the Spark model native-only', () => {
    expect(resolveGatewayModelEntry('gpt-5.3-codex-spark')).toBeUndefined();
  });

  it('returns false for unknown or missing ids', () => {
    expect(isGatewayRoutableModel('not-a-real-model')).toBe(false);
    expect(isGatewayRoutableModel(undefined)).toBe(false);
    expect(isGatewayOnlyModel('not-a-real-model')).toBe(false);
    expect(isGatewayOnlyModel(undefined)).toBe(false);
  });

  it('applies tool schema profiles only to gateway-routed sessions', () => {
    expect(resolveGatewayToolSchemaProfile('kimi-k3', true)).toBe('flat');
    expect(resolveGatewayToolSchemaProfile('kimi-k3', false)).toBe('standard');
    expect(resolveGatewayToolSchemaProfile('not-a-real-model', true)).toBe(
      'standard',
    );
  });

  it('resolves the provider-compatible Codex reasoning route family', () => {
    expect(resolveCodexReasoningRouteFamily('gpt-5.6-sol', false)).toBe(
      'native',
    );
    expect(resolveCodexReasoningRouteFamily('deepseek-v4-pro', true)).toBe(
      'gateway:deepseek',
    );
    // Unknown gateway models are keyed by model id. Collapsing them into a
    // shared `gateway:unknown` bucket would make a switch between two
    // different uncatalogued models read as "same family" and skip
    // sanitization.
    expect(resolveCodexReasoningRouteFamily('not-a-real-model', true)).toBe(
      'gateway:unknown:not-a-real-model',
    );
    expect(
      resolveCodexReasoningRouteFamily('another-missing-model', true),
    ).not.toBe(resolveCodexReasoningRouteFamily('not-a-real-model', true));
  });

  it('gives locally hosted Ollama models their own per-model reasoning route family', () => {
    // Ollama runs through the Codex provider without AI-Credits routing and
    // shares the canonical Codex home, so without a distinct family an Ollama
    // thread switched to a native OpenAI model would compare native-to-native,
    // resume, and replay Ollama's provider-private reasoning into OpenAI.
    expect(
      resolveCodexReasoningRouteFamily('llama-3.3-70b', false, 'ollama'),
    ).toBe('ollama:llama-3.3-70b');
    expect(
      resolveCodexReasoningRouteFamily('llama-3.3-70b', false, 'ollama'),
    ).not.toBe(resolveCodexReasoningRouteFamily('gpt-5.6-sol', false));
    // An explicit codex provider type is equivalent to omitting it.
    expect(
      resolveCodexReasoningRouteFamily('gpt-5.6-sol', false, 'codex'),
    ).toBe(resolveCodexReasoningRouteFamily('gpt-5.6-sol', false));
  });

  it('keys each locally hosted Ollama model separately', () => {
    // Every locally hosted model has its own private reasoning encoding, so a
    // single collapsed `ollama` family would make a switch between two
    // different Ollama models read as "same family", skip sanitization, and
    // replay the first model's reasoning into the second.
    expect(
      resolveCodexReasoningRouteFamily('ollama-deepseek-r1', false, 'ollama'),
    ).not.toBe(
      resolveCodexReasoningRouteFamily('ollama-qwen3', false, 'ollama'),
    );
    // The same model is the same family across turns.
    expect(
      resolveCodexReasoningRouteFamily('ollama-qwen3', false, 'ollama'),
    ).toBe(resolveCodexReasoningRouteFamily('ollama-qwen3', false, 'ollama'));
    // The persisted `ollama-` UI id and the raw runtime id a rebuild passes to
    // the app-server must resolve to the same family, or a capability
    // transition would read as a route change and strip its own reasoning.
    expect(
      resolveCodexReasoningRouteFamily('ollama-qwen3', false, 'ollama'),
    ).toBe(resolveCodexReasoningRouteFamily('qwen3', false, 'ollama'));
    // An Ollama chat with no recorded model still has an Ollama-only family.
    expect(resolveCodexReasoningRouteFamily(undefined, false, 'ollama')).toBe(
      'ollama:unspecified',
    );
  });

  it('rejects unresolved restored selections after a cold restart', () => {
    expect(isUnavailableModelSelection('removed-api-only-model', 'codex')).toBe(
      true,
    );
    expect(isUnavailableModelSelection('gpt-5.5', 'codex')).toBe(false);
    expect(isUnavailableModelSelection(undefined, 'codex')).toBe(false);
  });

  it('keeps registered selections available independently of harness', () => {
    expect(isUnavailableModelSelection('opus[1m]', 'codex')).toBe(false);
    expect(isUnavailableModelSelection('opus[1m]', 'claude')).toBe(false);
    expect(isUnavailableModelSelection('gpt-5.5', 'claude')).toBe(false);
    expect(isUnavailableModelSelection('gpt-5.5', 'codex')).toBe(false);
  });

  it('keeps a persisted selection available when a live refresh changes its recommendation', () => {
    const movingModel = initialAiGatewayModels.find(
      (entry) => entry.id === 'deepseek-v4-pro',
    );
    const movingRoute = initialGatewayRoutes.find(
      (entry) => entry.modelId === 'deepseek-v4-pro',
    );
    if (!movingModel || !movingRoute) {
      throw new Error(
        'Expected deepseek-v4-pro in the initial gateway registry',
      );
    }

    try {
      initAiGatewayModels(
        initialAiGatewayModels.map((entry) =>
          entry.id === movingModel.id
            ? { ...entry, recommendedHarness: 'claude' }
            : entry,
        ),
        initialGatewayRoutes.map((entry) =>
          entry.modelId === movingRoute.modelId
            ? { ...entry, recommendedHarness: 'claude' }
            : entry,
        ),
      );

      expect(isRemovedGatewayOnlyModel(movingModel.id, 'codex')).toBe(false);
      expect(resolveGatewayModelEntry(movingModel.id)?.recommendedHarness).toBe(
        'claude',
      );
      expect(isUnavailableModelSelection(movingModel.id, 'codex')).toBe(false);
      expect(isUnavailableModelSelection(movingModel.id, 'claude')).toBe(false);
    } finally {
      initAiGatewayModels(initialAiGatewayModels, initialGatewayRoutes);
    }
  });

  it('resolves the registry model id for a gateway id', () => {
    expect(resolveModelIdForGatewayId('deepseek/deepseek-v4-pro')).toBe(
      'deepseek-v4-pro',
    );
    expect(resolveModelIdForGatewayId('anthropic/claude-haiku-5.5')).toBe(
      'haiku',
    );
    expect(resolveModelIdForGatewayId('openai/gpt-6-luna')).toBe('gpt-6-luna');
    expect(resolveModelIdForGatewayId('openai/not-a-model')).toBeUndefined();
    expect(resolveModelIdForGatewayId('')).toBeUndefined();
  });

  it('prefers the package model when several routes share a gateway id', () => {
    const route = (
      modelId: string,
      overrides: Partial<GatewayRouteEntry> = {},
    ): GatewayRouteEntry => ({
      modelId,
      gatewayId: 'anthropic/claude-haiku-5.5',
      family: 'anthropic',
      recommendedHarness: 'claude',
      gatewayOnly: false,
      contextWindow: 200_000,
      supportsPromptCaching: true,
      supportedThinkingLevels: [],
      toolSchemaProfile: 'standard',
      ...overrides,
    });
    const gatewayOnlyModel = (id: string): AiGatewayModelEntry => ({
      id,
      label: id,
      recommendedHarness: 'claude',
      contextWindow: 200_000,
      supportsPromptCaching: true,
      supportedThinkingLevels: [],
      toolSchemaProfile: 'standard',
    });

    try {
      // Registered ahead of the package model, so registration order alone
      // would pick the Cursor alias.
      initAiGatewayModels(
        [gatewayOnlyModel('api-haiku-twin')],
        [
          route('cursor:claude-haiku-5-5'),
          route('api-haiku-twin', { gatewayOnly: true }),
          route('haiku'),
        ],
      );
      expect(resolveModelIdForGatewayId('anthropic/claude-haiku-5.5')).toBe(
        'haiku',
      );

      // Without a package model, a non-Cursor route still beats the Cursor
      // one, and among equals the first registered wins.
      initAiGatewayModels(
        [gatewayOnlyModel('api-haiku-twin'), gatewayOnlyModel('api-haiku-b')],
        [
          route('cursor:claude-haiku-5-5'),
          route('api-haiku-twin', { gatewayOnly: true }),
          route('api-haiku-b', { gatewayOnly: true }),
        ],
      );
      expect(resolveModelIdForGatewayId('anthropic/claude-haiku-5.5')).toBe(
        'api-haiku-twin',
      );

      // A Cursor route is still an answer when nothing else carries the id.
      initAiGatewayModels([], [route('cursor:claude-haiku-5-5')]);
      expect(resolveModelIdForGatewayId('anthropic/claude-haiku-5.5')).toBe(
        'cursor:claude-haiku-5-5',
      );
    } finally {
      initAiGatewayModels(initialAiGatewayModels, initialGatewayRoutes);
    }
  });

  it('tombstones a gateway-only model removed by a live refresh', () => {
    initAiGatewayModels(
      initialAiGatewayModels.filter((entry) => entry.id !== 'deepseek-v4-pro'),
      initialGatewayRoutes.filter(
        (entry) => entry.modelId !== 'deepseek-v4-pro',
      ),
    );

    expect(resolveGatewayModelEntry('deepseek-v4-pro')).toBeUndefined();
    expect(isRemovedGatewayOnlyModel('deepseek-v4-pro', 'codex')).toBe(true);
    expect(isRemovedGatewayOnlyModel('deepseek-v4-pro', 'claude')).toBe(true);

    initAiGatewayModels(initialAiGatewayModels, initialGatewayRoutes);
    expect(isRemovedGatewayOnlyModel('deepseek-v4-pro', 'codex')).toBe(false);
    expect(resolveGatewayModelEntry('deepseek-v4-pro')).toBeDefined();
  });
});
