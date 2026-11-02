import {
  initAiGatewayModels,
  initClaudeModels,
  initModelAliases,
} from '@canopy/desktop-shared/types';
import {
  normalizePersistedUsage,
  resolveTabUsageForModel,
} from '../chatUsageNormalization';

const usage = {
  contextTokens: 10,
  contextWindow: 50_000,
  maxOutputTokens: 4_000,
  totalCostUsd: 0,
  inputTokens: 10,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  durationMs: 0,
  durationApiMs: 0,
  numTurns: 1,
  model: 'native-with-gateway',
};

describe('normalizePersistedUsage', () => {
  beforeEach(() => {
    initModelAliases({});
    initClaudeModels([
      {
        id: 'native-with-gateway',
        label: 'Native with gateway',
        contextWindow: 200_000,
      },
    ]);
    initAiGatewayModels(
      [],
      [
        {
          modelId: 'native-with-gateway',
          gatewayId: 'anthropic/native-with-gateway',
          family: 'anthropic',
          recommendedHarness: 'claude',
          gatewayOnly: false,
          contextWindow: 100_000,
          supportsPromptCaching: true,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
      ],
    );
  });

  it('uses the explicit OpenCode route window even when the source model is native', () => {
    expect(
      normalizePersistedUsage(usage, 'native-with-gateway', false, 'opencode')
        ?.contextWindow,
    ).toBe(100_000);
    expect(
      resolveTabUsageForModel(usage, 'native-with-gateway', false, 'opencode'),
    ).toMatchObject({ contextWindow: 100_000, inputTokens: 10, numTurns: 1 });
  });

  it('does not substitute native capabilities when a captured OpenCode route is withdrawn', () => {
    initAiGatewayModels([], []);
    expect(
      normalizePersistedUsage(usage, 'native-with-gateway', false, 'opencode'),
    ).toBe(usage);
    expect(
      resolveTabUsageForModel(usage, 'native-with-gateway', false, 'opencode')
        ?.contextWindow,
    ).toBe(0);
  });

  it('uses the native context window for subscription sessions', () => {
    expect(
      normalizePersistedUsage(usage, 'native-with-gateway', false)
        ?.contextWindow,
    ).toBe(200_000);
  });

  it('uses the gateway context window for AI-Credits-routed sessions', () => {
    expect(
      normalizePersistedUsage(usage, 'native-with-gateway', true)
        ?.contextWindow,
    ).toBe(100_000);
  });
});

describe('resolveTabUsageForModel', () => {
  beforeEach(() => {
    initModelAliases({});
    initClaudeModels([
      {
        id: 'native-with-gateway',
        label: 'Native with gateway',
        contextWindow: 200_000,
      },
    ]);
    initAiGatewayModels([], []);
  });

  it('follows the new model context window and keeps the running counters', () => {
    expect(
      resolveTabUsageForModel(
        { ...usage, model: 'other-model' },
        'native-with-gateway',
      ),
    ).toEqual({
      ...usage,
      contextWindow: 200_000,
      model: 'native-with-gateway',
    });
  });

  it('drops the previous model window when the new model has none configured', () => {
    // The old window belongs to the old model; carrying it over would show a
    // percentage against the wrong denominator until the next result event.
    // An unknown window renders as no meter, which the indicator handles.
    expect(
      resolveTabUsageForModel(
        { ...usage, contextWindow: 200_000 },
        'ollama/local-model',
      ),
    ).toEqual({ ...usage, contextWindow: 0, model: 'ollama/local-model' });
  });
});
