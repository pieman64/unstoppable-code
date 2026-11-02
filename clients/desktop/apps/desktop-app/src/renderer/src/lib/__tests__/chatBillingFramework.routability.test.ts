import {
  initAgentModels,
  initAiGatewayModels,
  initCodexModels,
  resetGatewayCatalogHydrationForTests,
} from '@canopy/desktop-shared/types';
import type { AgentModelRegistryEntry } from '@canopy/desktop-shared/types/agent-models';
import { resolveCreditsModelRoutability } from '../chatBillingFramework';

// Kept apart from chatBillingFramework.test.ts, which mocks the gateway
// capability helpers for the whole module; routability must read the real
// catalog and its hydration flag.

function agentEntry(id: string, baseModel: string): AgentModelRegistryEntry {
  return {
    id,
    name: id,
    baseModel,
    instructions: '',
    pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
    available: true,
  };
}

function hydrateCatalog(): void {
  initCodexModels([
    { id: 'gpt-6-sol', label: 'GPT 6 Sol' },
    { id: 'gpt-6-luna', label: 'GPT 6 Luna' },
  ]);
  initAiGatewayModels(
    [],
    [
      {
        modelId: 'gpt-6-luna',
        family: 'openai',
        gatewayId: 'openai/gpt-6-luna',
        recommendedHarness: 'codex',
        gatewayOnly: false,
        contextWindow: 400_000,
        supportsPromptCaching: true,
        supportedThinkingLevels: ['low', 'medium', 'high'],
        toolSchemaProfile: 'standard',
      },
    ],
  );
}

describe('resolveCreditsModelRoutability', () => {
  afterEach(() => {
    initAgentModels([]);
    initAiGatewayModels([], []);
    initCodexModels([]);
    resetGatewayCatalogHydrationForTests();
  });

  it('is unknown while the gateway catalog is cold', () => {
    initCodexModels([{ id: 'gpt-6-luna', label: 'GPT 6 Luna' }]);

    expect(resolveCreditsModelRoutability('gpt-6-luna')).toBe('unknown');
    expect(resolveCreditsModelRoutability('gpt-6-sol')).toBe('unknown');
  });

  it('is unknown without a model even once the catalog has loaded', () => {
    hydrateCatalog();

    expect(resolveCreditsModelRoutability(undefined)).toBe('unknown');
  });

  it('separates models with and without a gateway route', () => {
    hydrateCatalog();

    expect(resolveCreditsModelRoutability('gpt-6-sol')).toBe('not-routable');
    expect(resolveCreditsModelRoutability('gpt-6-luna')).toBe('routable');
  });

  it('resolves Agent models through their base model', () => {
    hydrateCatalog();
    initAgentModels([
      agentEntry('agent_model_luna', 'gpt-6-luna'),
      agentEntry('agent_model_sol', 'gpt-6-sol'),
    ]);

    expect(resolveCreditsModelRoutability('agent_model_luna')).toBe('routable');
    expect(resolveCreditsModelRoutability('agent_model_sol')).toBe(
      'not-routable',
    );
  });
});
