import {
  ALL_MODELS,
  CODEX_ACCOUNT_MODELS,
  CODEX_MODELS,
  DEFAULT_CLAUDE_MODEL,
  clearCodexAccountModels,
  getExecutionHarnessForModel,
  getModelDisplayName,
  getModelSource,
  getSupportedThinkingLevelsForModel,
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
  initOllamaModels,
  isCodexModel,
  resolveKnownModel,
  setCodexAccountModels,
} from '../types';
import { isGatewayRoutableModel } from '../lib/gateway-model-availability';
import {
  isCodexModelAvailableToAccount,
  repairLaneDefaults,
  type BillingLane,
} from '../lib/default-model-lane';

const SOL = 'gpt-6.1-sol';
const LUNA = 'gpt-6-luna';

function initCatalog(): void {
  initClaudeModels([{ id: DEFAULT_CLAUDE_MODEL, label: 'Opus' }]);
  initCodexModels([
    { id: SOL, label: '6.1 Sol' },
    { id: LUNA, label: 'Luna 6.0' },
  ]);
}

describe('account-only Codex models (CAN-4716)', () => {
  beforeEach(() => {
    initCatalog();
    clearCodexAccountModels();
  });

  it('registers off-catalog, non-hidden entries as native Codex models', () => {
    setCodexAccountModels([
      { id: SOL, model: SOL },
      { id: 'gpt-6-mini', model: 'gpt-6-mini', displayName: 'Mini 6' },
      { id: 'secret', model: 'secret', hidden: true },
      {
        id: 'gpt-6-free',
        model: 'gpt-6-free',
        displayName: 'Free 6',
        isDefault: true,
        reasoningEfforts: ['minimal', 'medium', 'ultra-mega', 'high'],
      },
      { id: 'gpt-6-mini', model: 'gpt-6-mini' },
    ]);

    expect(CODEX_ACCOUNT_MODELS).toEqual(['gpt-6-free', 'gpt-6-mini']);
    expect(CODEX_MODELS).toEqual([SOL, LUNA]);
    expect(resolveKnownModel('gpt-6-free')).toBe('gpt-6-free');
    expect(resolveKnownModel('secret')).toBeUndefined();
    expect(isCodexModel('gpt-6-free')).toBe(true);
    expect(getModelSource('gpt-6-free')).toBe('codex-managed');
    expect(getExecutionHarnessForModel('gpt-6-free')).toBe('codex');
    expect(isGatewayRoutableModel('gpt-6-free')).toBe(false);
    expect(getModelDisplayName('gpt-6-free')).toBe('Free 6');
    expect(getModelDisplayName('gpt-6-mini')).toBe('Mini 6');
    expect(getSupportedThinkingLevelsForModel('gpt-6-free')).toEqual([
      'low',
      'medium',
      'high',
    ]);
    // No efforts listed: the Codex defaults apply.
    expect(getSupportedThinkingLevelsForModel('gpt-6-mini')).toEqual(
      getSupportedThinkingLevelsForModel('unregistered-model', 'codex'),
    );
  });

  it('replaces the whole set and clears on demand', () => {
    setCodexAccountModels([{ id: 'a', model: 'a' }]);
    setCodexAccountModels([{ id: 'b', model: 'b', displayName: 'B' }]);
    expect(CODEX_ACCOUNT_MODELS).toEqual(['b']);
    expect(resolveKnownModel('a')).toBeUndefined();
    expect(getModelDisplayName('a')).toBe('a');

    clearCodexAccountModels();
    expect(CODEX_ACCOUNT_MODELS).toEqual([]);
    expect(resolveKnownModel('b')).toBeUndefined();
    expect(isCodexModel('b')).toBe(false);
  });

  it('survives a later registry re-init', () => {
    setCodexAccountModels([
      { id: 'b', model: 'b', displayName: 'B', reasoningEfforts: ['high'] },
    ]);
    initCatalog();
    initOllamaModels([]);

    expect(CODEX_ACCOUNT_MODELS).toEqual(['b']);
    expect(resolveKnownModel('b')).toBe('b');
    expect(getModelDisplayName('b')).toBe('B');
    expect(getSupportedThinkingLevelsForModel('b')).toEqual(['high']);
  });

  it('never registers a catalog model the registry skipped', () => {
    initCodexModels([
      { id: SOL, label: '6.1 Sol' },
      {
        id: 'gpt-6-flagged',
        label: 'Flagged 6',
        featureFlag: 'canopy-shared-claude-model-fable5',
      },
      { id: 'gpt-6-hidden', label: 'Hidden 6', selectable: false },
    ]);
    setCodexAccountModels([
      { id: 'gpt-6-flagged', model: 'gpt-6-flagged' },
      { id: 'gpt-6-hidden', model: 'gpt-6-hidden' },
      { id: 'gpt-6-free', model: 'gpt-6-free' },
    ]);

    expect(CODEX_ACCOUNT_MODELS).toEqual(['gpt-6-free']);
    expect(isCodexModel('gpt-6-flagged')).toBe(false);
    expect(isCodexModel('gpt-6-hidden')).toBe(false);
  });

  it('hands an id to the catalog once the catalog configures it', () => {
    setCodexAccountModels([{ id: 'gpt-6-free', model: 'gpt-6-free' }]);
    initCodexModels([
      { id: SOL, label: '6.1 Sol' },
      { id: 'gpt-6-free', label: 'Free 6', supportedThinkingLevels: ['low'] },
    ]);

    expect(CODEX_ACCOUNT_MODELS).toEqual([]);
    expect(CODEX_MODELS).toEqual([SOL, 'gpt-6-free']);

    setCodexAccountModels([{ id: 'gpt-6-free', model: 'gpt-6-free' }]);
    clearCodexAccountModels();
    expect(getModelDisplayName('gpt-6-free')).toBe('Free 6');
    expect(getSupportedThinkingLevelsForModel('gpt-6-free')).toEqual(['low']);
  });

  it('hands an id to the gateway catalog whichever hydrates first', () => {
    const gatewayEntry = {
      id: 'gpt-gateway',
      label: 'Gateway GPT',
      recommendedHarness: 'claude' as const,
      contextWindow: 200_000,
      supportsPromptCaching: false,
      supportedThinkingLevels: ['low' as const],
      toolSchemaProfile: 'standard' as const,
    };
    setCodexAccountModels([{ id: 'gpt-gateway', model: 'gpt-gateway' }]);
    try {
      initAiGatewayModels([gatewayEntry], []);

      expect(CODEX_ACCOUNT_MODELS).toEqual([]);
      expect(ALL_MODELS.filter((id) => id === 'gpt-gateway')).toHaveLength(1);
      expect(isCodexModel('gpt-gateway')).toBe(false);

      setCodexAccountModels([{ id: 'gpt-gateway', model: 'gpt-gateway' }]);
      clearCodexAccountModels();
      expect(CODEX_ACCOUNT_MODELS).toEqual([]);
      expect(getModelDisplayName('gpt-gateway')).toBe('Gateway GPT');
      expect(getSupportedThinkingLevelsForModel('gpt-gateway')).toEqual([
        'low',
      ]);
    } finally {
      initAiGatewayModels([], []);
    }
  });

  it('never registers a gateway id that a policy re-init filtered out', () => {
    initAiGatewayModels(
      [
        {
          id: 'gpt-gateway',
          label: 'Gateway GPT',
          recommendedHarness: 'claude',
          contextWindow: 200_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: ['low'],
          toolSchemaProfile: 'standard',
        },
      ],
      [],
    );
    // The renderer's policy pass re-inits without blocked ids but keeps the
    // configured picker identity.
    initAiGatewayModels([], [], true);
    try {
      setCodexAccountModels([{ id: 'gpt-gateway', model: 'gpt-gateway' }]);
      expect(CODEX_ACCOUNT_MODELS).toEqual([]);
      expect(isCodexModel('gpt-gateway')).toBe(false);
    } finally {
      initAiGatewayModels([], []);
    }
  });

  it('falls back to the account default, then list order, when no catalog model is eligible', () => {
    const entries = [
      { id: 'first', model: 'first' },
      { id: 'own-default', model: 'own-default', isDefault: true },
    ];
    setCodexAccountModels(entries);
    const accountModels = new Set(entries.map((entry) => entry.id));
    const hooks = (
      eligible: ReadonlySet<string>,
    ): Parameters<typeof repairLaneDefaults>[1] => ({
      laneCatalog: (lane: BillingLane) =>
        lane === 'codex-native'
          ? [...CODEX_MODELS, ...CODEX_ACCOUNT_MODELS]
          : [],
      isPolicyBlocked: () => false,
      isModelInRegistry: (model) => resolveKnownModel(model) !== undefined,
      isLaneCatalogHydrated: () => true,
      isRunnableOnLane: (lane, model) =>
        lane === 'codex-native' &&
        getExecutionHarnessForModel(model) === 'codex' &&
        isCodexModelAvailableToAccount(model, eligible),
      clampThinkingLevel: (level) => level,
    });
    const defaults = {
      claude: { model: DEFAULT_CLAUDE_MODEL, thinkingLevel: 'high' as const },
      codex: { model: SOL, thinkingLevel: 'high' as const },
      ollama: null,
      aiCredits: null,
    };

    expect(repairLaneDefaults(defaults, hooks(accountModels)).codex.model).toBe(
      'own-default',
    );
    expect(
      repairLaneDefaults(defaults, hooks(new Set(['first']))).codex.model,
    ).toBe('first');
    // A catalog model the account can run still wins.
    expect(
      repairLaneDefaults(defaults, hooks(new Set([...accountModels, LUNA])))
        .codex.model,
    ).toBe(LUNA);
  });
});
