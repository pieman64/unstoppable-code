import {
  initAgentModels,
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
  initCursorModels,
  initModelAliases,
  initOllamaModels,
} from '../types';
import type { AgentModelRegistryEntry } from '../types/agent-models';
import { buildModelCatalogOption } from '../lib/model-catalog-projection';

function inheritingAgent(): AgentModelRegistryEntry {
  return {
    id: 'agent_model_inherit',
    name: 'Inherit',
    baseModel: 'default',
    instructions: '',
    pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
    available: true,
  };
}

describe('buildModelCatalogOption for an Agent that inherits the default', () => {
  beforeEach(() => {
    initModelAliases({});
    initClaudeModels([
      {
        id: 'sonnet',
        label: 'Sonnet 5',
        contextWindow: 500_000,
        supportedThinkingLevels: ['low', 'medium', 'high'],
      },
    ]);
    initCodexModels([
      { id: 'gpt-5.5', label: 'GPT 5.5', contextWindow: 272_000 },
    ]);
    initAiGatewayModels([], []);
    initOllamaModels([]);
    initCursorModels([]);
    initAgentModels([inheritingAgent()]);
  });

  afterEach(() => {
    initAgentModels([]);
  });

  it('describes the row by the default it would run on', () => {
    const codex = buildModelCatalogOption('agent_model_inherit', {
      provider: 'claude',
      agentDefaultModel: 'gpt-5.5',
    });
    expect(codex).toMatchObject({
      id: 'agent_model_inherit',
      label: 'Inherit',
      kind: 'agent',
      provider: 'codex',
      harness: 'codex',
      available: true,
      contextWindow: 272_000,
    });
    expect(codex?.isDefault).toBeUndefined();

    const claude = buildModelCatalogOption('agent_model_inherit', {
      provider: 'claude',
      agentDefaultModel: 'sonnet',
    });
    expect(claude).toMatchObject({
      id: 'agent_model_inherit',
      provider: 'claude',
      harness: 'claude',
      available: true,
      contextWindow: 500_000,
      supportedThinkingLevels: ['low', 'medium', 'high'],
    });
  });

  it("describes the row by its destination's default, not the presentation default", () => {
    expect(
      buildModelCatalogOption('agent_model_inherit', {
        provider: 'claude',
        defaultModel: 'sonnet',
        agentDefaultModel: 'gpt-5.5',
      }),
    ).toMatchObject({ provider: 'codex', harness: 'codex' });
  });

  it('marks the bare Agent as the default when it is the default', () => {
    expect(
      buildModelCatalogOption('agent_model_inherit', {
        provider: 'claude',
        defaultModel: 'agent_model_inherit',
      })?.isDefault,
    ).toBe(true);
  });
});
