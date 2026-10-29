import {
  AGENT_MODELS,
  ALL_MODELS,
  DEFAULT_COMMIT_GENERATION_MODEL,
  DEFAULT_PR_GENERATION_MODEL,
  clampThinkingLevelForModel,
  getAgentModelAvailability,
  getAgentModelSelectionId,
  getEffectiveModelContextWindow,
  getEffectiveSupportedThinkingLevelsForModel,
  getModelBillingMetadata,
  getModelContextWindow,
  getModelDisplayName,
  getProviderForModel,
  getExecutionHarnessForModel,
  initAiGatewayModels,
  initAgentModels,
  initClaudeModels,
  initCodexModels,
  initCursorModels,
  initModelAliases,
  initOllamaModels,
  inferLegacyExecutionHarness,
  isAgentModel,
  isBaseModelSelectableForAgent,
  isInheritingAgentModel,
  resolveAgentModelDefinition,
  resolveKnownModel,
  resolveRuntimeModel,
} from '../types';
import {
  AGENT_MODEL_PREFIX,
  DEFAULT_HELPER_MODEL,
  agentModelIdFromSlug,
  deriveAgentModelSlug,
  deriveAgentModelId,
  isValidAgentModelSlug,
  normalizeAgentModelSlug,
  resolveAgentModelIdCollision,
  type AgentModelRegistryEntry,
} from '../types/agent-models';
import { isGatewayRoutableModel } from '../lib/gateway-model-availability';
import { buildModelCatalogOption } from '../lib/model-catalog-projection';
import {
  AGENT_DEFAULT_BASE_MODEL,
  AGENT_MODEL_PREFIX as PROTOCOL_AGENT_MODEL_PREFIX,
  formatAgentRouteModelId,
} from '@canopy/protocol/agents';
import { getModelHarnessSource } from '../model-harnesses';
import { getCurrentModelHarnessCatalog } from '../types';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function makeEntry(
  id: string,
  baseModel: string,
  overrides: Partial<AgentModelRegistryEntry> = {},
): AgentModelRegistryEntry {
  return {
    id,
    name: id,
    baseModel,
    instructions: '',
    pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    createdAt: '2026-07-03T00:00:00.000Z',
    updatedAt: '2026-07-03T00:00:00.000Z',
    available: true,
    ...overrides,
  };
}

describe('Agent model contracts', () => {
  beforeEach(() => {
    initModelAliases({});
    initClaudeModels([
      {
        id: 'opus[1m]',
        label: 'Opus 4.8 1M',
        contextWindow: 1_000_000,
        supportedThinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        extraChargeOnly: true,
        extraChargeMessage: 'Premium',
      },
      { id: 'sonnet', label: 'Sonnet 5', contextWindow: 500_000 },
    ]);
    initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
    initAiGatewayModels(
      [],
      [
        {
          modelId: 'opus[1m]',
          gatewayId: 'anthropic/claude-opus-5',
          recommendedHarness: 'claude',
          gatewayOnly: false,
          contextWindow: 400_000,
          supportsPromptCaching: true,
          supportedThinkingLevels: ['low', 'medium'],
          toolSchemaProfile: 'standard',
        },
      ],
    );
    initOllamaModels([]);
    initCursorModels([]);
    initAgentModels([]);
  });

  describe('Agent model ID helpers', () => {
    it('re-exports the protocol-owned model id prefix', () => {
      expect(AGENT_MODEL_PREFIX).toBe(PROTOCOL_AGENT_MODEL_PREFIX);
    });

    it('derives durable slugs for the canonical cases', () => {
      expect(deriveAgentModelSlug('Code Reviewer')).toBe('code_reviewer');
      expect(agentModelIdFromSlug('code_reviewer')).toBe(
        'agent_model_code_reviewer',
      );
      expect(deriveAgentModelId('Code Reviewer')).toBe(
        'agent_model_code_reviewer',
      );
      expect(deriveAgentModelId('  GPT-5 Pro! ')).toBe('agent_model_gpt_5_pro');
      expect(deriveAgentModelId('!!!')).toBe('agent_model_agent');
    });

    it('is deterministic and always prefixed', () => {
      expect(deriveAgentModelId('Code Reviewer')).toBe(
        deriveAgentModelId('Code Reviewer'),
      );
      expect(
        deriveAgentModelId('anything').startsWith(AGENT_MODEL_PREFIX),
      ).toBe(true);
    });

    it('normalizes editable slug input and validates strict slugs', () => {
      expect(normalizeAgentModelSlug('  Code Reviewer!! ')).toBe(
        'code_reviewer',
      );
      expect(normalizeAgentModelSlug('!!!')).toBe('agent');
      expect(isValidAgentModelSlug('code_reviewer_2')).toBe(true);
      expect(isValidAgentModelSlug('code__reviewer')).toBe(false);
      expect(isValidAgentModelSlug('code_')).toBe(false);
      expect(isValidAgentModelSlug('')).toBe(false);
    });
  });

  it('provides one helper model default to preferences and Git settings', () => {
    expect(DEFAULT_HELPER_MODEL).toBe('sonnet');
    expect(DEFAULT_PR_GENERATION_MODEL).toBe(DEFAULT_HELPER_MODEL);
    expect(DEFAULT_COMMIT_GENERATION_MODEL).toBe(DEFAULT_HELPER_MODEL);

    const preferencesSource = readFileSync(
      resolve(
        process.cwd(),
        'apps/desktop-app/src/main/lib/preferences-store.ts',
      ),
      'utf8',
    );
    expect(preferencesSource).toContain(
      'prGenerationModel: DEFAULT_PR_GENERATION_MODEL',
    );
    expect(preferencesSource).toContain(
      'commitGenerationModel: DEFAULT_COMMIT_GENERATION_MODEL',
    );

    const gitTabFallbackSource = readFileSync(
      resolve(
        process.cwd(),
        'apps/desktop-app/src/renderer/src/components/settings/git-tab-fallback-preferences.ts',
      ),
      'utf8',
    );
    expect(gitTabFallbackSource).toContain(
      "import { DEFAULT_HELPER_MODEL } from '@canopy/desktop-shared/types/agent-models';",
    );
    expect(gitTabFallbackSource).toContain(
      'prGenerationModel: DEFAULT_HELPER_MODEL',
    );
    expect(gitTabFallbackSource).toContain(
      'commitGenerationModel: DEFAULT_HELPER_MODEL',
    );
  });

  it('resolves native and AI-Credits context windows independently', () => {
    expect(getEffectiveModelContextWindow('opus[1m]', false)).toBe(1_000_000);
    expect(getEffectiveModelContextWindow('opus[1m]', true)).toBe(400_000);

    initAgentModels([makeEntry('agent_model_routed', 'opus[1m]')]);
    expect(getEffectiveModelContextWindow('agent_model_routed', false)).toBe(
      1_000_000,
    );
    expect(getEffectiveModelContextWindow('agent_model_routed', true)).toBe(
      400_000,
    );
  });

  it('describes a Codex model by its listed context window without sizing the usage meter by it', () => {
    // Codex reports its effective window at runtime, 95% of the listed one,
    // and the usage meter follows that report.
    initCodexModels([
      { id: 'gpt-5.5', label: 'GPT 5.5', contextWindow: 272_000 },
    ]);
    initAgentModels([makeEntry('agent_model_codex', 'gpt-5.5')]);

    expect(
      buildModelCatalogOption('gpt-5.5', { provider: 'codex' })?.contextWindow,
    ).toBe(272_000);
    expect(
      buildModelCatalogOption('agent_model_codex', { provider: 'codex' })
        ?.contextWindow,
    ).toBe(272_000);
    expect(getModelContextWindow('gpt-5.5')).toBeUndefined();
    expect(getEffectiveModelContextWindow('gpt-5.5', false)).toBeUndefined();
  });

  it('resolves native and AI-Credits thinking levels independently', () => {
    expect(
      getEffectiveSupportedThinkingLevelsForModel('opus[1m]', false),
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(
      getEffectiveSupportedThinkingLevelsForModel('opus[1m]', true),
    ).toEqual(['low', 'medium']);
    expect(clampThinkingLevelForModel('max', 'opus[1m]', 'claude', true)).toBe(
      'medium',
    );

    initAgentModels([makeEntry('agent_model_routed', 'opus[1m]')]);
    expect(
      getEffectiveSupportedThinkingLevelsForModel('agent_model_routed', true),
    ).toEqual(['low', 'medium']);
  });

  describe('resolveAgentModelIdCollision', () => {
    it('returns the base ID when free and appends _2, _3, … on collision', () => {
      expect(
        resolveAgentModelIdCollision('agent_model_code_reviewer', []),
      ).toBe('agent_model_code_reviewer');
      expect(
        resolveAgentModelIdCollision('agent_model_code_reviewer', [
          'agent_model_code_reviewer',
        ]),
      ).toBe('agent_model_code_reviewer_2');
      expect(
        resolveAgentModelIdCollision('agent_model_code_reviewer', [
          'agent_model_code_reviewer',
          'agent_model_code_reviewer_2',
        ]),
      ).toBe('agent_model_code_reviewer_3');
    });
  });

  it('keeps the existing ID stable while the friendly name changes on rename', () => {
    // The derived ID is generated once from the original name; renaming updates
    // only the friendly `name`, never the persisted `id`.
    const id = deriveAgentModelId('Code Reviewer');
    initAgentModels([makeEntry(id, 'sonnet', { name: 'Senior Reviewer' })]);

    expect(id).toBe('agent_model_code_reviewer');
    expect(resolveKnownModel(id)).toBe(id);
    expect(getModelDisplayName(id)).toBe('Senior Reviewer');
  });

  describe('shape helpers', () => {
    it('detects Agent model IDs by prefix', () => {
      expect(isAgentModel('agent_model_x')).toBe(true);
      expect(isAgentModel('sonnet')).toBe(false);
      expect(isAgentModel(undefined)).toBe(false);
    });

    it('accepts real provider models as bases and rejects Agents/unknowns', () => {
      expect(isBaseModelSelectableForAgent('sonnet')).toBe(true);
      expect(isBaseModelSelectableForAgent('gpt-5.5')).toBe(true);
      expect(isBaseModelSelectableForAgent('agent_model_x')).toBe(false);
      expect(isBaseModelSelectableForAgent('removed-model')).toBe(false);
      expect(isBaseModelSelectableForAgent('cursor:%ZZ')).toBe(false);
    });
  });

  it.each(['cursor-default', 'cursor:review-model%5B%5D'])(
    'keeps a saved Cursor Agent usable before discovery: %s',
    (baseModel) => {
      expect(isBaseModelSelectableForAgent(baseModel)).toBe(true);
      initAgentModels([makeEntry('agent_model_cursor', baseModel)]);
      expect(getAgentModelAvailability('agent_model_cursor')).toEqual({
        available: true,
      });
      expect(getProviderForModel('agent_model_cursor')).toBe('cursor');
      expect(getExecutionHarnessForModel('agent_model_cursor')).toBe('cursor');
      expect(resolveRuntimeModel('agent_model_cursor')).toBe(baseModel);
    },
  );

  it('resolves the provider and runtime model from the base model', () => {
    initAgentModels([
      makeEntry('agent_model_codex', 'gpt-5.5'),
      makeEntry('agent_model_claude', 'sonnet'),
    ]);

    expect(getProviderForModel('agent_model_codex')).toBe('codex');
    expect(getProviderForModel('agent_model_claude')).toBe('claude');
    expect(resolveRuntimeModel('agent_model_codex')).toBe('gpt-5.5');
    expect(resolveRuntimeModel('agent_model_claude')).toBe('sonnet');
  });

  it('inherits context window and billing metadata from the base model', () => {
    initAgentModels([makeEntry('agent_model_premium', 'opus[1m]')]);

    expect(getModelContextWindow('agent_model_premium')).toBe(1_000_000);
    expect(getModelBillingMetadata('agent_model_premium')).toEqual({
      extraChargeOnly: true,
      extraChargeMessage: 'Premium',
    });
  });

  it('skips structurally invalid entries (agent base, missing base, bad ID)', () => {
    initAgentModels([
      makeEntry('agent_model_valid', 'sonnet'),
      makeEntry('agent_model_nested', 'agent_model_valid'),
      makeEntry('agent_model_missing_base', ''),
      makeEntry('not_prefixed', 'sonnet'),
    ]);

    expect(resolveAgentModelDefinition('agent_model_valid')).not.toBeNull();
    expect(resolveAgentModelDefinition('agent_model_nested')).toBeNull();
    expect(resolveAgentModelDefinition('agent_model_missing_base')).toBeNull();
    expect(resolveAgentModelDefinition('not_prefixed')).toBeNull();
    expect(AGENT_MODELS).toEqual(['agent_model_valid']);
  });

  it('retains a stale-base Agent flagged unavailable', () => {
    initAgentModels([
      makeEntry('agent_model_stale', 'removed-model', { name: 'Stale' }),
    ]);

    const def = resolveAgentModelDefinition('agent_model_stale');
    expect(def).not.toBeNull();
    expect(def?.available).toBe(false);
    expect(def?.unavailableReason).toBe('base_model_unavailable');
    expect(getAgentModelAvailability('agent_model_stale')).toEqual({
      available: false,
      reason: 'base_model_unavailable',
    });

    // Still selectable/renderable in the registry…
    expect(AGENT_MODELS).toContain('agent_model_stale');
    expect(ALL_MODELS).toContain('agent_model_stale');
    expect(getModelDisplayName('agent_model_stale')).toBe('Stale');

    // …but it does NOT inherit base metadata while unavailable.
    expect(getModelContextWindow('agent_model_stale')).toBeUndefined();
    expect(getModelBillingMetadata('agent_model_stale')).toBeUndefined();
    expect(getProviderForModel('agent_model_stale')).toBeUndefined();

    // resolveRuntimeModel still unwraps to the declared base so callers can
    // surface an explicit stale-base error instead of shipping agent_model_*.
    expect(resolveRuntimeModel('agent_model_stale')).toBe('removed-model');
  });

  it('unwraps Agent models before checking gateway routability', () => {
    initAgentModels([
      makeEntry('agent_model_routable', 'opus[1m]'),
      makeEntry('agent_model_stale', 'removed-model'),
    ]);

    expect(isGatewayRoutableModel('agent_model_routable')).toBe(true);
    expect(isGatewayRoutableModel('agent_model_stale')).toBe(false);
  });

  it('preserves the Agent overlay when base registries re-initialize', () => {
    initAgentModels([makeEntry('agent_model_keep', 'sonnet')]);
    expect(ALL_MODELS).toContain('agent_model_keep');

    // Re-initializing a provider registry must not drop the overlay, and
    // rebuildAllModels must re-append AGENT_MODELS.
    initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
    initClaudeModels([{ id: 'sonnet', label: 'Sonnet 5' }]);

    expect(resolveAgentModelDefinition('agent_model_keep')).not.toBeNull();
    expect(ALL_MODELS).toContain('agent_model_keep');
  });

  describe('inherited default base model', () => {
    beforeEach(() => {
      initAgentModels([
        makeEntry('agent_model_inherit', AGENT_DEFAULT_BASE_MODEL, {
          name: 'Inherit',
        }),
        makeEntry('agent_model_pinned', 'sonnet'),
      ]);
    });

    it('registers an inheriting Agent as available without a provider', () => {
      expect(getAgentModelAvailability('agent_model_inherit')).toEqual({
        available: true,
      });
      expect(isInheritingAgentModel('agent_model_inherit')).toBe(true);
      expect(isInheritingAgentModel('agent_model_pinned')).toBe(false);
      expect(getModelDisplayName('agent_model_inherit')).toBe('Inherit');
      // Unresolved, it has no route: callers must materialize it first.
      expect(getProviderForModel('agent_model_inherit')).toBeUndefined();
      expect(isBaseModelSelectableForAgent(AGENT_DEFAULT_BASE_MODEL)).toBe(
        false,
      );
    });

    it('judges a chat route id by its retained concrete base model', () => {
      const codexRoute = formatAgentRouteModelId(
        'agent_model_inherit',
        'gpt-5.5',
      );
      const claudeRoute = formatAgentRouteModelId(
        'agent_model_inherit',
        'opus[1m]',
      );

      expect(isAgentModel(codexRoute)).toBe(true);
      expect(isInheritingAgentModel(codexRoute)).toBe(false);
      expect(resolveKnownModel(codexRoute)).toBe(codexRoute);
      expect(resolveRuntimeModel(codexRoute)).toBe('gpt-5.5');
      expect(getProviderForModel(codexRoute)).toBe('codex');
      expect(getExecutionHarnessForModel(codexRoute)).toBe('codex');
      expect(getProviderForModel(claudeRoute)).toBe('claude');
      expect(getExecutionHarnessForModel(claudeRoute)).toBe('claude');
      expect(getModelContextWindow(claudeRoute)).toBe(1_000_000);
      expect(getModelDisplayName(claudeRoute)).toBe('Inherit');
      expect(getAgentModelSelectionId(claudeRoute)).toBe('agent_model_inherit');
      expect(getAgentModelSelectionId('sonnet')).toBe('sonnet');
      expect(getAgentModelAvailability(claudeRoute)).toEqual({
        available: true,
      });
      expect(
        getModelHarnessSource(claudeRoute, getCurrentModelHarnessCatalog()),
      ).toBe('claude-managed');
      expect(
        inferLegacyExecutionHarness({ model: codexRoute, hasStarted: true }),
      ).toBe('codex');
    });

    it("runs a route id for a pinned Agent on that Agent's own base", () => {
      const forged = formatAgentRouteModelId('agent_model_pinned', 'gpt-5.5');
      expect(resolveRuntimeModel(forged)).toBe('sonnet');
      expect(getProviderForModel(forged)).toBe('claude');
      expect(getExecutionHarnessForModel(forged)).toBe('claude');
    });

    it('keeps a route unavailable when its Agent or base model is gone', () => {
      const staleBase = formatAgentRouteModelId(
        'agent_model_inherit',
        'removed-model',
      );
      expect(getAgentModelAvailability(staleBase)).toEqual({
        available: false,
        reason: 'base_model_unavailable',
      });
      expect(getProviderForModel(staleBase)).toBeUndefined();

      const deletedAgent = formatAgentRouteModelId(
        'agent_model_gone',
        'sonnet',
      );
      expect(resolveKnownModel(deletedAgent)).toBeUndefined();
      expect(getAgentModelAvailability(deletedAgent)).toEqual({
        available: false,
        reason: 'not_found',
      });
    });
  });

  it('clears prior Agent state on re-init', () => {
    initAgentModels([makeEntry('agent_model_first', 'sonnet')]);
    initAgentModels([makeEntry('agent_model_second', 'sonnet')]);

    expect(resolveAgentModelDefinition('agent_model_first')).toBeNull();
    expect(resolveAgentModelDefinition('agent_model_second')).not.toBeNull();
    expect(AGENT_MODELS).toEqual(['agent_model_second']);
  });
});
