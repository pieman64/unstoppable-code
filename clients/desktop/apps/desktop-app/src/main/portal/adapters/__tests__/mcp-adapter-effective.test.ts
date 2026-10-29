import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';

const mockResolveEffective = jest.fn<
  Promise<ChatTabPluginSelections>,
  [ChatTabPluginSelections | undefined, object, unknown]
>();
const mockListInventory = jest.fn<
  Promise<{ servers: never[] }>,
  [ChatTabPluginSelections]
>(() => Promise.resolve({ servers: [] }));

jest.mock('../../../plugins/global-plugin-overlay', () => ({
  resolveEffectiveChatPluginSelections: (
    local: ChatTabPluginSelections | undefined,
    target: object,
    overlay: unknown,
  ): Promise<ChatTabPluginSelections> =>
    mockResolveEffective(local, target, overlay),
}));
jest.mock('../../../plugins/mcp-inventory', () => ({
  listDetectedMcpServersForSelections: (
    selections: ChatTabPluginSelections,
  ): Promise<{ servers: never[] }> => mockListInventory(selections),
}));
jest.mock('../../portal-event-bus', () => ({
  createPortalEvent: jest.fn(),
  enqueuePortalEvent: jest.fn(),
  isCanopyPortalActive: (): boolean => true,
}));
jest.mock('../../../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(),
}));
jest.mock('../../../services/portal-chat-tabs-cache', () => ({
  portalChatTabsCache: { read: jest.fn() },
}));

import { projectWorktreeMcpServersForChat } from '../mcp-adapter';

const local: ChatTabPluginSelections = {
  collectionIds: [],
  skillRefs: [],
  pluginRefs: [],
  mcpServerRefs: [{ serverId: 'github', configId: 'default' }],
};
const effective: ChatTabPluginSelections = {
  ...local,
  mcpServerRefs: [
    { serverId: 'linear', configId: 'default' },
    { serverId: 'github', configId: 'default' },
  ],
};

describe('projectWorktreeMcpServersForChat', () => {
  it('projects the active chat effective selection with its own tombstones', async () => {
    mockResolveEffective.mockResolvedValue(effective);
    const tombstones = { mcpServerRefs: [{ serverId: 'x', configId: 'y' }] };

    await projectWorktreeMcpServersForChat(
      { workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1' },
      {
        id: 'chat-1',
        pluginSelections: local,
        disabledGlobalPluginSelections: tombstones,
      },
    );

    expect(mockResolveEffective).toHaveBeenCalledWith(
      local,
      { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'chat-1' },
      { chatTombstones: tombstones, inheritsProjectDefaults: false },
    );
    expect(mockListInventory).toHaveBeenCalledWith(effective);
  });

  // The projection agrees with the chat's turns about the project layer.
  it('passes the chat layering stamp along', async () => {
    mockResolveEffective.mockResolvedValue(effective);

    await projectWorktreeMcpServersForChat(
      { workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1' },
      {
        id: 'chat-1',
        pluginSelections: local,
        inheritedPluginDefaultsVersion: 1,
      },
    );

    expect(mockResolveEffective).toHaveBeenCalledWith(
      local,
      { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'chat-1' },
      { chatTombstones: {}, inheritsProjectDefaults: true },
    );
  });
});
