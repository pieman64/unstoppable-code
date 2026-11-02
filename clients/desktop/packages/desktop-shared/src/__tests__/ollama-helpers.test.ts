import {
  OLLAMA_MODEL_PREFIX,
  OLLAMA_MODELS,
  REQUIRED_OLLAMA_CAPABILITIES,
  hasRequiredOllamaCapabilities,
  isOllamaModel,
  isSelectableOllamaModel,
  isSupportedOllamaModelEntry,
  stripOllamaModelPrefix,
  toOllamaModelId,
  getProviderForModel,
  getExecutionHarnessForModel,
  getGatewayModelEntry,
  getAiGatewayModelEntry,
  getConfiguredGatewayId,
  getConfiguredSupportedThinkingLevels,
  getConfiguredSupportedThinkingLevelsMap,
  getSupportedThinkingLevelsForModel,
  getThinkingUiOptionsForProvider,
  getModelDescription,
  getListedModelContextWindow,
  getModelContextWindow,
  getRemovedGatewayOnlyModelHarness,
  resolveAgentModelDefinition,
  getModelDisplayName,
  findClaudeModelByLabel,
  getModelBillingMetadata,
  getModelFeatureFlag,
  resolveKnownModel,
  resolveModelAlias,
  requireProviderForModel,
  initOllamaModels,
  initModelAliases,
  initClaudeModels,
  initCodexModels,
  initAiGatewayModels,
  initModelHarnessAssignments,
  inferLegacyExecutionHarness,
  type OllamaModelEntry,
} from '../types';
import {
  OLLAMA_CODEX_PROVIDER_ID,
  buildCodexCompatibleOllamaConfig,
} from '../node/ollama';

describe('Ollama model helpers', () => {
  beforeEach(() => {
    // Reset registries for isolation
    initClaudeModels([
      {
        id: 'claude-fable-5-1',
        label: 'Fable 5.1',
        contextWindow: 1_000_000,
      },
      {
        id: 'claude-fable-5',
        label: 'Fable 5',
        contextWindow: 1_000_000,
      },
      { id: 'opus[1m]', label: 'Opus 5.5' },
      { id: 'claude-opus-5', label: 'Opus 5' },
      { id: 'sonnet', label: 'Sonnet 5', contextWindow: 1_000_000 },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
    ]);
    initCodexModels([
      { id: 'gpt-5.5', label: 'GPT 5.5' },
      { id: 'gpt-6-sol', label: 'GPT 6 Sol' },
    ]);
    initOllamaModels([]);
    initModelAliases({
      fable: 'claude-fable-5-1',
      'fable[1m]': 'claude-fable-5-1',
      opus: 'opus[1m]',
      'claude-opus-5-5': 'opus[1m]',
      'sonnet[1m]': 'sonnet',
      'claude-sonnet-4-5': 'sonnet',
      'claude-sonnet-4-5-20250514': 'sonnet',
      'claude-sonnet-4-5-20250929': 'sonnet',
      'claude-sonnet-4-6': 'sonnet',
      'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
    });
  });

  describe('OLLAMA_MODEL_PREFIX', () => {
    it('is "ollama-"', () => {
      expect(OLLAMA_MODEL_PREFIX).toBe('ollama-');
    });
  });

  describe('Codex-compatible configuration', () => {
    it('builds thread-scoped Responses configuration without API-key state', () => {
      const before = { ...process.env };
      expect(buildCodexCompatibleOllamaConfig(11534, 'qwen3:8b')).toEqual({
        model_provider: 'canopy_ollama',
        model: 'qwen3:8b',
        model_providers: {
          canopy_ollama: {
            name: 'Ollama',
            base_url: 'http://127.0.0.1:11534/v1',
            wire_api: 'responses',
            requires_openai_auth: false,
          },
        },
      });
      expect(process.env).toEqual(before);
    });

    // Codex fails config load when `model_providers` redefines one of its
    // built-in provider IDs (RESERVED_MODEL_PROVIDER_IDS in codex-rs).
    it.each(['openai', 'ollama', 'lmstudio', 'amazon-bedrock'])(
      'does not register the Codex built-in provider ID %s',
      (reservedId) => {
        const config = buildCodexCompatibleOllamaConfig(11534, 'qwen3:8b');
        expect(OLLAMA_CODEX_PROVIDER_ID).not.toBe(reservedId);
        expect(config.model_provider).not.toBe(reservedId);
        expect(config.model_providers).not.toHaveProperty(reservedId);
      },
    );
  });

  describe('legacy harness capture', () => {
    beforeEach(() => {
      initAiGatewayModels(
        [
          {
            id: 'gateway-legacy',
            label: 'Gateway Legacy',
            recommendedHarness: 'claude',
            contextWindow: 100_000,
            supportsPromptCaching: false,
            supportedThinkingLevels: [],
            toolSchemaProfile: 'standard',
          },
        ],
        [
          {
            modelId: 'gateway-legacy',
            gatewayId: 'vendor/gateway-legacy',
            family: 'anthropic',
            recommendedHarness: 'claude',
            gatewayOnly: true,
            contextWindow: 100_000,
            supportsPromptCaching: false,
            supportedThinkingLevels: [],
            toolSchemaProfile: 'standard',
          },
        ],
      );
      initModelHarnessAssignments({
        revision: 1,
        assignments: [
          {
            modelId: 'gateway-legacy',
            source: 'ai-gateway',
            harness: 'codex',
            defaultHarness: 'claude',
            configurable: true,
            overridden: true,
          },
        ],
      });
    });

    it('leaves empty legacy tabs unpinned', () => {
      expect(
        inferLegacyExecutionHarness({
          model: 'ollama-qwen3-coder',
          providerType: 'ollama',
          hasStarted: false,
        }),
      ).toBeUndefined();
    });

    it('migrates historical Ollama sessions to Claude', () => {
      expect(
        inferLegacyExecutionHarness({
          model: 'ollama-qwen3-coder',
          providerType: 'ollama',
          hasStarted: true,
        }),
      ).toBe('claude');
    });

    it('prefers a persisted gateway provider and otherwise uses the old recommendation', () => {
      expect(
        inferLegacyExecutionHarness({
          model: 'gateway-legacy',
          providerType: 'codex',
          hasStarted: true,
        }),
      ).toBe('codex');
      expect(
        inferLegacyExecutionHarness({
          model: 'gateway-legacy',
          hasStarted: true,
        }),
      ).toBe('claude');
    });
  });

  describe('toOllamaModelId', () => {
    it('prefixes a raw model name', () => {
      expect(toOllamaModelId('llama3:8b')).toBe('ollama-llama3:8b');
    });

    it('handles simple model names', () => {
      expect(toOllamaModelId('mistral')).toBe('ollama-mistral');
    });
  });

  describe('isOllamaModel', () => {
    it('returns true for ollama-prefixed strings', () => {
      expect(isOllamaModel('ollama-llama3:8b')).toBe(true);
    });

    it('returns false for non-ollama models', () => {
      expect(isOllamaModel('claude-sonnet-4-6')).toBe(false);
    });

    it('returns false for null', () => {
      expect(isOllamaModel(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isOllamaModel(undefined)).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isOllamaModel('')).toBe(false);
    });
  });

  describe('hasRequiredOllamaCapabilities', () => {
    it('returns true when both required capabilities are present', () => {
      expect(
        hasRequiredOllamaCapabilities([
          ...REQUIRED_OLLAMA_CAPABILITIES,
          'vision',
        ]),
      ).toBe(true);
    });

    it('returns false when a required capability is missing', () => {
      expect(hasRequiredOllamaCapabilities(['completion'])).toBe(false);
    });
  });

  describe('stripOllamaModelPrefix', () => {
    it('removes the prefix from an ollama model', () => {
      expect(stripOllamaModelPrefix('ollama-llama3:8b')).toBe('llama3:8b');
    });

    it('returns the input unchanged for non-ollama models', () => {
      expect(stripOllamaModelPrefix('claude-sonnet-4-6')).toBe(
        'claude-sonnet-4-6',
      );
    });

    it('handles the prefix-only case', () => {
      expect(stripOllamaModelPrefix('ollama-')).toBe('');
    });
  });

  describe('getProviderForModel', () => {
    it('returns "ollama" for ollama-prefixed models', () => {
      expect(getProviderForModel('ollama-llama3:8b')).toBe('ollama');
    });

    it('returns "codex" for codex models', () => {
      expect(getProviderForModel('gpt-5.5')).toBe('codex');
    });

    it('returns "claude" for claude models', () => {
      expect(getProviderForModel('claude-sonnet-4-6')).toBe('claude');
    });

    it('returns "ollama" even if the model is not in the OLLAMA_MODELS list', () => {
      // Prefix-based detection takes priority
      expect(getProviderForModel('ollama-unknown-model')).toBe('ollama');
    });

    it('returns undefined for an unknown non-Ollama model', () => {
      expect(getProviderForModel('some-unknown-model')).toBeUndefined();
    });

    it('routes an explicitly configured historical model directly', () => {
      expect(getProviderForModel('gpt-6-sol')).toBe('codex');
      expect(requireProviderForModel('gpt-6-sol')).toBe('codex');
    });

    it('uses the declared registry instead of guessing from the model id', () => {
      initClaudeModels([{ id: 'gpt-shaped-claude-model', label: 'Claude' }]);
      initCodexModels([{ id: 'claude-shaped-codex-model', label: 'Codex' }]);

      expect(getProviderForModel('gpt-shaped-claude-model')).toBe('claude');
      expect(getProviderForModel('claude-shaped-codex-model')).toBe('codex');
    });

    it('fails explicitly when a caller requires an unknown provider', () => {
      expect(() => requireProviderForModel('some-unknown-model')).toThrow(
        'Unknown model provider: some-unknown-model',
      );
    });

    describe('gateway harness assignments', () => {
      beforeEach(() => {
        initAiGatewayModels(
          [
            {
              id: 'gateway-routed',
              label: 'Gateway Routed',
              recommendedHarness: 'claude',
              contextWindow: 100_000,
              supportsPromptCaching: false,
              supportedThinkingLevels: [],
              toolSchemaProfile: 'standard',
            },
          ],
          [
            {
              modelId: 'gateway-routed',
              gatewayId: 'vendor/gateway-routed',
              family: 'anthropic',
              recommendedHarness: 'claude',
              gatewayOnly: true,
              contextWindow: 100_000,
              supportsPromptCaching: false,
              supportedThinkingLevels: [],
              toolSchemaProfile: 'standard',
            },
          ],
        );
      });

      afterEach(() => {
        initModelHarnessAssignments({ revision: 0, assignments: [] });
      });

      it('prefers the hydrated harness override over the recommendation', () => {
        initModelHarnessAssignments({
          revision: 1,
          assignments: [
            {
              modelId: 'gateway-routed',
              source: 'ai-gateway',
              harness: 'codex',
              defaultHarness: 'claude',
              configurable: true,
              overridden: true,
            },
          ],
        });

        expect(getProviderForModel('gateway-routed')).toBe('codex');
      });

      it('falls back to the gateway recommendation without an override', () => {
        initModelHarnessAssignments({ revision: 1, assignments: [] });

        expect(getProviderForModel('gateway-routed')).toBe('claude');
      });

      it('ignores a captured non-overridden assignment and follows the live recommendation', () => {
        // The hydrated snapshot lists EVERY catalog model with its effective
        // harness, `overridden: false` marking a captured default rather than
        // a user decision. A stale captured default must not shadow a newer
        // catalog recommendation.
        initModelHarnessAssignments({
          revision: 1,
          assignments: [
            {
              modelId: 'gateway-routed',
              source: 'ai-gateway',
              harness: 'claude',
              defaultHarness: 'claude',
              configurable: true,
              overridden: false,
            },
          ],
        });
        initAiGatewayModels(
          [
            {
              id: 'gateway-routed',
              label: 'Gateway Routed',
              recommendedHarness: 'codex',
              contextWindow: 100_000,
              supportsPromptCaching: false,
              supportedThinkingLevels: [],
              toolSchemaProfile: 'standard',
            },
          ],
          [
            {
              modelId: 'gateway-routed',
              gatewayId: 'vendor/gateway-routed',
              family: 'openai',
              recommendedHarness: 'codex',
              gatewayOnly: true,
              contextWindow: 100_000,
              supportsPromptCaching: false,
              supportedThinkingLevels: [],
              toolSchemaProfile: 'standard',
            },
          ],
        );

        expect(getProviderForModel('gateway-routed')).toBe('codex');
      });

      it('fails closed for a hydrated non-overridden model missing from the catalog', () => {
        initModelHarnessAssignments({
          revision: 1,
          assignments: [
            {
              modelId: 'gateway-removed',
              source: 'ai-gateway',
              harness: 'claude',
              defaultHarness: 'claude',
              configurable: true,
              overridden: false,
            },
          ],
        });

        expect(getProviderForModel('gateway-removed')).toBeUndefined();
      });
    });
  });

  describe('unregistered model metadata', () => {
    it.each(['constructor', 'toString', '__proto__'])(
      'safely projects an unregistered saved ID through Settings helpers: %s',
      (model) => {
        expect({
          name: getModelDisplayName(model),
          agent: resolveAgentModelDefinition(model),
          route: getGatewayModelEntry(model),
          gatewayModel: getAiGatewayModelEntry(model),
          gatewayId: getConfiguredGatewayId(model),
          provider: getProviderForModel(model),
          harness: getExecutionHarnessForModel(model),
          description: getModelDescription(model),
          contextWindow: getModelContextWindow(model),
          featureFlag: getModelFeatureFlag(model),
          configuredThinking: getConfiguredSupportedThinkingLevels(model),
          removedHarness: getRemovedGatewayOnlyModelHarness(model),
        }).toEqual({
          name: model,
          agent: null,
          route: undefined,
          gatewayModel: undefined,
          gatewayId: undefined,
          provider: undefined,
          harness: undefined,
          description: undefined,
          contextWindow: undefined,
          featureFlag: undefined,
          configuredThinking: undefined,
          removedHarness: undefined,
        });
        expect(getSupportedThinkingLevelsForModel(model, 'codex')).toEqual(
          getSupportedThinkingLevelsForModel(undefined, 'codex'),
        );
        expect(getThinkingUiOptionsForProvider('codex', model)).toEqual(
          getThinkingUiOptionsForProvider('codex'),
        );
      },
    );

    it.each(['constructor', 'toString', '__proto__'])(
      'retains own registered metadata and clears it on refresh: %s',
      (model) => {
        initCodexModels([
          {
            id: model,
            label: 'Configured model',
            contextWindow: 123456,
            supportedThinkingLevels: ['ultra'],
          },
        ]);
        expect(getModelDisplayName(model)).toBe('Configured model');
        expect(getProviderForModel(model)).toBe('codex');
        // A Codex size only describes the model; the usage meter never reads it.
        expect(getListedModelContextWindow(model)).toBe(123456);
        expect(getModelContextWindow(model)).toBeUndefined();
        expect(getConfiguredSupportedThinkingLevels(model)).toEqual(['ultra']);
        expect(
          Object.keys(getConfiguredSupportedThinkingLevelsMap()),
        ).toContain(model);
        initCodexModels([]);
        expect(getModelDisplayName(model)).toBe(model);
        expect(getListedModelContextWindow(model)).toBeUndefined();
        expect(getConfiguredSupportedThinkingLevels(model)).toBeUndefined();
      },
    );
  });

  describe('resolveModelAlias', () => {
    it.each([
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
      '__proto__',
    ])('keeps an unconfigured prototype-looking ID unchanged: %s', (model) => {
      expect(resolveModelAlias(model)).toBe(model);
      expect(resolveKnownModel(model)).toBeUndefined();
      expect(getExecutionHarnessForModel(model)).toBeUndefined();
    });

    it.each(['constructor', '__proto__'])(
      'resolves an explicitly configured prototype-looking alias: %s',
      (alias) => {
        initModelAliases({ [alias]: 'sonnet' });
        expect(resolveModelAlias(alias)).toBe('sonnet');
        expect(resolveKnownModel(alias)).toBe('sonnet');
        initModelAliases({});
        expect(resolveModelAlias(alias)).toBe(alias);
      },
    );
  });

  describe('getModelDisplayName', () => {
    it('returns the registered label for known ollama models', () => {
      initOllamaModels([
        {
          id: 'ollama-llama3:8b',
          rawModelId: 'llama3:8b',
          label: 'Llama 3 8B',
        },
      ]);
      expect(getModelDisplayName('ollama-llama3:8b')).toBe('Llama 3 8B');
    });

    it('falls back to stripped raw model name for unknown ollama models', () => {
      expect(getModelDisplayName('ollama-mistral:7b')).toBe('mistral:7b');
    });

    it('returns the raw ID for unknown non-ollama models', () => {
      expect(getModelDisplayName('some-unknown-model')).toBe(
        'some-unknown-model',
      );
    });

    it('resolves aliases before using the non-ollama fallback', () => {
      initModelAliases({ 'sonnet[1m]': 'sonnet' });
      expect(getModelDisplayName('sonnet[1m]')).toBe('Sonnet 5');
    });

    it('maps the configured Opus 5.5 alias while preserving Opus 5 directly', () => {
      expect(resolveModelAlias('claude-opus-5-5')).toBe('opus[1m]');
      expect(resolveKnownModel('claude-opus-5-5')).toBe('opus[1m]');
      expect(getModelDisplayName('claude-opus-5-5')).toBe('Opus 5.5');
      expect(resolveModelAlias('claude-opus-5')).toBe('claude-opus-5');
      expect(resolveKnownModel('claude-opus-5')).toBe('claude-opus-5');
      expect(getModelDisplayName('claude-opus-5')).toBe('Opus 5');
    });

    it('maps legacy Sonnet IDs to the current model metadata', () => {
      for (const legacyId of [
        'sonnet[1m]',
        'claude-sonnet-4-5',
        'claude-sonnet-4-5-20250514',
        'claude-sonnet-4-5-20250929',
        'claude-sonnet-4-6',
      ]) {
        expect(resolveModelAlias(legacyId)).toBe('sonnet');
        expect(resolveKnownModel(legacyId)).toBe('sonnet');
        expect(getModelDisplayName(legacyId)).toBe('Sonnet 5');
      }
    });

    it('keeps shorthand Fable aliases on 5.1 while resolving Fable 5 directly', () => {
      for (const legacyId of ['fable', 'fable[1m]']) {
        expect(resolveModelAlias(legacyId)).toBe('claude-fable-5-1');
        expect(resolveKnownModel(legacyId)).toBe('claude-fable-5-1');
        expect(getModelDisplayName(legacyId)).toBe('Fable 5.1');
      }
      expect(resolveModelAlias('claude-fable-5')).toBe('claude-fable-5');
      expect(resolveKnownModel('claude-fable-5')).toBe('claude-fable-5');
      expect(getModelDisplayName('claude-fable-5')).toBe('Fable 5');
    });

    it('maps exact Claude model names to configured model IDs', () => {
      expect(resolveModelAlias('claude-haiku-4-5')).toBe(
        'claude-haiku-4-5-20251001',
      );
      expect(resolveKnownModel('claude-haiku-4-5')).toBe(
        'claude-haiku-4-5-20251001',
      );
      expect(getModelDisplayName('claude-haiku-4-5')).toBe('Haiku 4.5');
    });
  });

  describe('findClaudeModelByLabel', () => {
    it('matches the configured label exactly', () => {
      expect(findClaudeModelByLabel('Opus 5.5')).toBe('opus[1m]');
      expect(findClaudeModelByLabel('Opus 5')).toBe('claude-opus-5');
      expect(findClaudeModelByLabel('sonnet 5')).toBe('sonnet');
    });

    it('matches a label the Claude Code TUI prints with a context-window suffix', () => {
      // CAN-2701: Canopy's own label is the model's identity ("Opus 5.5"), but
      // the TUI's `/model` stdout still prints its context-window variant
      // ("Set model to Opus 5.5 1M"). Terminal-initiated switches must keep
      // resolving, so the suffix is tolerated on the INCOMING label only.
      expect(findClaudeModelByLabel('Opus 5.5 1M')).toBe('opus[1m]');
      expect(findClaudeModelByLabel('Opus 5 1M')).toBe('claude-opus-5');
      expect(findClaudeModelByLabel('Fable 5 1M')).toBe('claude-fable-5');
      expect(findClaudeModelByLabel('Haiku 4.5 200K')).toBe(
        'claude-haiku-4-5-20251001',
      );
    });

    it('keeps two same-family variants resolving to themselves', () => {
      // The registry ships BOTH "Fable 5.1" and "Fable 5". Stripping a suffix
      // must never collapse one into the other, which is why the exact match
      // runs first and the stripped pass only runs after it fails.
      expect(findClaudeModelByLabel('Fable 5.1')).toBe('claude-fable-5-1');
      expect(findClaudeModelByLabel('Fable 5.1 1M')).toBe('claude-fable-5-1');
      expect(findClaudeModelByLabel('Fable 5')).toBe('claude-fable-5');
      expect(findClaudeModelByLabel('Fable 5 1M')).toBe('claude-fable-5');
    });

    it('does not let the suffix rule collapse two distinct models', () => {
      // "Sonnet 5" must never resolve from a label whose base name differs.
      expect(findClaudeModelByLabel('Sonnet 6 1M')).toBeUndefined();
      expect(findClaudeModelByLabel('1M')).toBeUndefined();
      expect(findClaudeModelByLabel('Opus 5 Turbo')).toBeUndefined();
    });

    it('still resolves raw ids and aliases', () => {
      expect(findClaudeModelByLabel('opus[1m]')).toBe('opus[1m]');
      expect(findClaudeModelByLabel('claude-opus-5-5')).toBe('opus[1m]');
      expect(findClaudeModelByLabel('claude-opus-5')).toBe('claude-opus-5');
    });
  });

  describe('getModelBillingMetadata', () => {
    it('returns extra-charge metadata through aliases and clears stale entries', () => {
      initClaudeModels([
        {
          id: 'claude-fable-5-1',
          label: 'Fable 5.1',
          contextWindow: 1_000_000,
          extraChargeOnly: true,
          extraChargeMessage:
            'After June 21 this model will require extra usage credits',
        },
      ]);
      initModelAliases({
        premium: 'claude-fable-5-1',
        'legacy-premium': 'claude-fable-5-1',
      });

      for (const modelId of ['premium', 'legacy-premium']) {
        expect(getModelBillingMetadata(modelId)).toEqual({
          extraChargeOnly: true,
          extraChargeMessage:
            'After June 21 this model will require extra usage credits',
        });
      }

      initClaudeModels([{ id: 'sonnet', label: 'Sonnet 5' }]);

      expect(getModelBillingMetadata('fable')).toBeUndefined();
    });
  });

  describe('feature-flagged configured models', () => {
    it('keeps flagged Claude models out of the active registry until enabled', () => {
      initClaudeModels([
        {
          id: 'flagged-claude',
          label: 'Flagged Claude',
          featureFlag: 'canopy-shared-claude-model-fable5',
        },
        { id: 'stable-claude', label: 'Stable Claude' },
      ]);

      expect(resolveKnownModel('flagged-claude')).toBeUndefined();
      expect(resolveKnownModel('stable-claude')).toBe('stable-claude');

      initClaudeModels(
        [
          {
            id: 'flagged-claude',
            label: 'Flagged Claude',
            featureFlag: 'canopy-shared-claude-model-fable5',
          },
          { id: 'stable-claude', label: 'Stable Claude' },
        ],
        { 'canopy-shared-claude-model-fable5': true },
      );

      expect(resolveKnownModel('flagged-claude')).toBe('flagged-claude');
      expect(getModelFeatureFlag('flagged-claude')).toBe(
        'canopy-shared-claude-model-fable5',
      );
    });

    it('keeps flagged Codex models out of the active registry until enabled', () => {
      initCodexModels([
        {
          id: 'flagged-codex',
          label: 'Flagged Codex',
          featureFlag: 'canopy-shared-claude-model-fable5',
        },
        { id: 'stable-codex', label: 'Stable Codex' },
      ]);

      expect(resolveKnownModel('flagged-codex')).toBeUndefined();
      expect(resolveKnownModel('stable-codex')).toBe('stable-codex');

      initCodexModels(
        [
          {
            id: 'flagged-codex',
            label: 'Flagged Codex',
            featureFlag: 'canopy-shared-claude-model-fable5',
          },
          { id: 'stable-codex', label: 'Stable Codex' },
        ],
        { 'canopy-shared-claude-model-fable5': true },
      );

      expect(resolveKnownModel('flagged-codex')).toBe('flagged-codex');
      expect(getModelFeatureFlag('flagged-codex')).toBe(
        'canopy-shared-claude-model-fable5',
      );
    });
  });

  describe('initOllamaModels', () => {
    it('populates OLLAMA_MODELS with supported entry IDs', () => {
      const entries: OllamaModelEntry[] = [
        {
          id: 'ollama-llama3:8b',
          rawModelId: 'llama3:8b',
          label: 'Llama 3 8B',
          show: {
            capabilities: ['completion', 'tools'],
          },
        },
        {
          id: 'ollama-mistral',
          rawModelId: 'mistral',
          label: 'Mistral',
          show: {
            capabilities: ['completion'],
          },
        },
      ];
      initOllamaModels(entries);
      expect(OLLAMA_MODELS).toEqual(['ollama-llama3:8b']);
    });

    it('clears previous entries on re-init', () => {
      initOllamaModels([
        {
          id: 'ollama-llama3:8b',
          rawModelId: 'llama3:8b',
          label: 'Llama 3 8B',
          show: {
            capabilities: ['completion', 'tools'],
          },
        },
      ]);
      expect(OLLAMA_MODELS).toHaveLength(1);

      initOllamaModels([]);
      expect(OLLAMA_MODELS).toHaveLength(0);
    });

    it('preserves claude and codex display names', () => {
      initOllamaModels([
        {
          id: 'ollama-llama3:8b',
          rawModelId: 'llama3:8b',
          label: 'Llama 3 8B',
          show: {
            capabilities: ['completion', 'tools'],
          },
        },
      ]);
      // Claude and codex models should still have display names
      expect(getModelDisplayName('claude-sonnet-4-6')).toBe('Sonnet 5');
      expect(getModelDisplayName('gpt-5.5')).toBe('GPT 5.5');
    });

    it('keeps unsupported installed models out of OLLAMA_MODELS', () => {
      const entry: OllamaModelEntry = {
        id: 'ollama-llama3:8b',
        rawModelId: 'llama3:8b',
        label: 'Llama 3 8B',
        show: {
          capabilities: ['completion'],
        },
      };

      initOllamaModels([entry]);

      expect(isSupportedOllamaModelEntry(entry)).toBe(false);
      expect(isSelectableOllamaModel('ollama-llama3:8b')).toBe(false);
      expect(OLLAMA_MODELS).toHaveLength(0);
    });
  });
});
