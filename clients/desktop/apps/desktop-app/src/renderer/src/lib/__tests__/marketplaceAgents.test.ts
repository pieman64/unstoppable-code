import {
  initAgentModels,
  initClaudeModels,
} from '@canopy/desktop-shared/types';
import type { AgentModelDefinition } from '@canopy/desktop-shared/types/agent-models';
import {
  agentPluginLabels,
  marketplaceLocalAgentInputs,
} from '../marketplaceAgents';

const BASE_MODEL = 'claude-marketplace-test';

function agent(
  overrides: Partial<AgentModelDefinition> = {},
): AgentModelDefinition {
  return {
    id: 'agent_model_reviewer',
    name: 'iOS Reviewer',
    baseModel: BASE_MODEL,
    instructions: '\n  Review Swift changes.\nBe strict.',
    pluginSelections: {
      collectionIds: ['col-1'],
      skillRefs: [{ sourceId: 'custom', skillName: 'swift-style' }],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: 'github', configId: 'default' }],
    },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    ...overrides,
  };
}

beforeAll(() => {
  initClaudeModels([{ id: BASE_MODEL, label: 'Claude Marketplace Test' }]);
});

afterEach(() => {
  initAgentModels([]);
});

describe('marketplaceLocalAgentInputs', () => {
  it('maps a definition with its registry availability and authored name', () => {
    const definition = agent();
    initAgentModels([{ ...definition, available: true }]);
    expect(marketplaceLocalAgentInputs([definition])).toEqual([
      {
        id: 'agent_model_reviewer',
        name: 'iOS Reviewer',
        description: 'Review Swift changes.',
        baseModelLabel: 'Claude Marketplace Test',
        pluginCount: 3,
        updatedAt: '2026-09-02T00:00:00.000Z',
        available: true,
      },
    ]);
  });

  it('keeps an unregistered agent listed as unavailable', () => {
    const [input] = marketplaceLocalAgentInputs([agent()]);
    expect(input?.available).toBe(false);
  });

  it('falls back to the base model when instructions are empty', () => {
    const [input] = marketplaceLocalAgentInputs([
      agent({ instructions: '   ' }),
    ]);
    expect(input?.description).toBe('Claude Marketplace Test');
  });

  it('names the share a local agent was published as or installed from', () => {
    const inputs = marketplaceLocalAgentInputs([
      agent({ id: 'agent_model_a', remoteId: 'shared-a' }),
      agent({ id: 'agent_model_b', importedFromRemoteId: 'shared-b' }),
      agent({ id: 'agent_model_c' }),
    ]);
    expect(inputs.map((input) => input.sharedRemoteId)).toEqual([
      'shared-a',
      'shared-b',
      undefined,
    ]);
  });
});

describe('agentPluginLabels', () => {
  it('labels every selected capability with a stable key', () => {
    expect(agentPluginLabels(agent())).toEqual([
      { key: 'collection:col-1', label: 'Collection: col-1' },
      { key: 'skill:custom:swift-style', label: 'Skill: swift-style' },
      { key: 'mcp:github:default', label: 'MCP server: github' },
    ]);
  });
});
