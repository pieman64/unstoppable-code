import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import { initAgentModels } from '@canopy/desktop-shared/types';
import type { AgentModelRegistryEntry } from '@canopy/desktop-shared/types/agent-models';
import {
  mergeChatPluginSelections,
  resolveAgentChatPluginSelections,
  stripAgentOnlyChatPluginSelections,
} from '../chatPluginSelections';

const AGENT_ID = 'agent_model_plugin_test';

function selections(
  overrides: Partial<ChatTabPluginSelections> = {},
): ChatTabPluginSelections {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
    ...overrides,
  };
}

describe('Agent chat plugin selections', () => {
  afterEach(() => {
    initAgentModels([]);
  });

  it('keeps plugins apart whose ids only collide when joined with a slash', () => {
    const merged = mergeChatPluginSelections(
      {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [{ marketplaceId: 'demo/market', pluginName: 'x' }],
      },
      {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [{ marketplaceId: 'demo', pluginName: 'market/x' }],
      },
    );
    expect(merged.pluginRefs).toEqual([
      { marketplaceId: 'demo/market', pluginName: 'x' },
      { marketplaceId: 'demo', pluginName: 'market/x' },
    ]);
  });

  it('merges a legacy bundleIds-only selection without requiring collectionIds', () => {
    const merged = mergeChatPluginSelections(
      {
        collectionIds: [],
        bundleIds: ['legacy-collection'],
        skillRefs: [],
        pluginRefs: [],
      },
      selections({ collectionIds: ['canonical-collection'] }),
    );

    expect(merged.collectionIds).toEqual([
      'legacy-collection',
      'canonical-collection',
    ]);
    expect(merged).not.toHaveProperty('bundleIds');
  });

  it('normalizes legacy bundle aliases in tab and Agent selections', () => {
    const agent: AgentModelRegistryEntry = {
      id: AGENT_ID,
      name: 'Plugin Test',
      baseModel: 'sonnet',
      instructions: 'Test plugin selection resolution.',
      pluginSelections: {
        collectionIds: [],
        bundleIds: ['agent-collection'],
        skillRefs: [],
        pluginRefs: [],
      },
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
      available: true,
    };
    initAgentModels([agent]);

    expect(
      resolveAgentChatPluginSelections(AGENT_ID, {
        collectionIds: [],
        bundleIds: ['tab-collection'],
        skillRefs: [],
        pluginRefs: [],
      }),
    ).toEqual({
      collectionIds: ['tab-collection', 'agent-collection'],
      skillRefs: [],
      pluginRefs: [],
    });
  });

  it('strips only Agent-exclusive selections before persisting the tab', () => {
    const sharedPlugin = { marketplaceId: 'mkt', pluginName: 'shared' };
    const agentOnlyPlugin = { marketplaceId: 'mkt', pluginName: 'agent-only' };
    const userPlugin = { marketplaceId: 'mkt', pluginName: 'user-added' };

    expect(
      stripAgentOnlyChatPluginSelections(
        selections({
          pluginRefs: [sharedPlugin, agentOnlyPlugin, userPlugin],
        }),
        selections({ pluginRefs: [sharedPlugin, agentOnlyPlugin] }),
        selections({ pluginRefs: [sharedPlugin] }),
      ),
    ).toEqual({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [sharedPlugin, userPlugin],
    });
  });
});
