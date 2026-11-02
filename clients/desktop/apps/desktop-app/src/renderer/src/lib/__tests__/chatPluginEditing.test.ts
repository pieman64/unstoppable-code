/**
 * @jest-environment jsdom
 */
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  type ChatTabPluginSelections,
  type ChatUpdatePluginsRequest,
  type ChatUpdatePluginsResponse,
  type PluginSelectionTombstones,
  type SidebarItem,
} from '@canopy/desktop-shared/types';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { createEmptyTab } from '@/stores/chat/tab-utils';
import { useGlobalPluginDefaultsStore } from '@/stores/globalPluginDefaultsStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useModelCatalogStore } from '@/stores/modelCatalogStore';
import { queueDesktopTryItSelectionUpdate } from '../tryItContinuationRunner';
import { setMcpHttpAuthPreference } from '@canopy/desktop-shared/lib/mcp-http-auth';
import type { McpHttpAuthTarget } from '@canopy/desktop-shared/types/mcp-servers';
import {
  chatPluginEditingState,
  editChatPlugins,
  inheritedDefaultLayers,
  setChatAuthPreferencesFromEffective,
} from '../chatPluginEditing';

const PROJECT_TOOL = { marketplaceId: 'mkt', pluginName: 'project-tool' };
const GLOBAL_TOOL = { marketplaceId: 'mkt', pluginName: 'global-tool' };
const EXTRA_TOOL = { marketplaceId: 'mkt', pluginName: 'extra-tool' };

function selections(
  pluginRefs: ChatTabPluginSelections['pluginRefs'],
): ChatTabPluginSelections {
  return { collectionIds: [], skillRefs: [], pluginRefs, mcpServerRefs: [] };
}

const updatePluginsMock = jest.fn(
  (request: ChatUpdatePluginsRequest): Promise<ChatUpdatePluginsResponse> =>
    Promise.resolve({
      pluginSelections: request.pluginSelections,
      ...(request.deferredToolsAllowed !== undefined
        ? { deferredToolsAllowed: request.deferredToolsAllowed }
        : {}),
      ...(request.disabledGlobalPluginSelections !== undefined
        ? {
            disabledGlobalPluginSelections:
              request.disabledGlobalPluginSelections,
          }
        : {}),
    }),
);

function seedProject(
  defaults: ChatTabPluginSelections | undefined,
  disabledGlobals?: PluginSelectionTombstones,
): void {
  const project: SidebarItem = {
    type: 'single-repo',
    id: 'project',
    name: 'Project',
    repoPath: '/workspace',
    color: '#000000',
    collapsed: false,
    order: 0,
    worktrees: [],
    ...(defaults ? { defaultPluginSelections: defaults } : {}),
    ...(disabledGlobals
      ? { disabledGlobalPluginSelections: disabledGlobals }
      : {}),
  };
  useProjectsStore.setState({ projects: [project] });
}

function seedChat(
  projectId: string,
  worktreeId: string,
  overrides: Partial<ChatTab> = {},
): ChatTab {
  // Chats the app creates now carry the live-defaults stamp.
  const tab: ChatTab = {
    ...createEmptyTab({ inheritedPluginDefaultsVersion: 1 }),
    id: 'chat',
    ...overrides,
  };
  useChatStore.setState({
    worktreeChats: {
      [`${projectId}/${worktreeId}`]: { activeTabId: tab.id, tabs: [tab] },
    },
  });
  return tab;
}

function currentTab(
  projectId: string,
  worktreeId: string,
): ChatTab | undefined {
  return useChatStore.getState().worktreeChats[`${projectId}/${worktreeId}`]
    ?.tabs[0];
}

const target = { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' };

function lastUpdate(): ChatUpdatePluginsRequest | undefined {
  return updatePluginsMock.mock.calls.at(-1)?.[0];
}

beforeEach(() => {
  updatePluginsMock.mockClear();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      chat: { updatePlugins: updatePluginsMock },
      discoverWorktreeEnv: jest.fn(() => Promise.resolve()),
    },
  });
  useGlobalPluginDefaultsStore.setState({
    hydrated: true,
    selections: selections([GLOBAL_TOOL]),
  });
  useChatStore.setState({ worktreeDefaultPlugins: {}, worktreeChats: {} });
  seedProject(selections([PROJECT_TOOL]));
});

describe('chatPluginEditingState', () => {
  it('shows project and global defaults the chat has not turned off', () => {
    seedChat('project', 'worktree', {
      pluginSelections: selections([EXTRA_TOOL]),
    });

    const state = chatPluginEditingState(useChatStore.getState(), target);

    expect(state.projectDefaults?.pluginRefs).toEqual([PROJECT_TOOL]);
    expect(state.effective.pluginRefs).toEqual(
      expect.arrayContaining([PROJECT_TOOL, GLOBAL_TOOL, EXTRA_TOOL]),
    );

    seedChat('project', 'worktree', {
      disabledGlobalPluginSelections: { pluginRefs: [PROJECT_TOOL] },
    });
    expect(
      chatPluginEditingState(useChatStore.getState(), target).effective
        .pluginRefs,
    ).toEqual([GLOBAL_TOOL]);
  });

  it('includes the plugins of an Agent the chat pinned to a route', () => {
    const agentTool = { marketplaceId: 'mkt', pluginName: 'agent-tool' };
    const snapshot = useModelCatalogStore.getState().snapshot;
    useModelCatalogStore.setState({
      snapshot: {
        ...(snapshot ?? {}),
        agents: [
          {
            id: 'agent_model_review',
            pluginSelections: selections([agentTool]),
          },
        ],
      } as unknown as NonNullable<typeof snapshot>,
    });
    try {
      seedChat('project', 'worktree', {
        model: 'agent_model_review@claude-sonnet-4-6',
      });

      const state = chatPluginEditingState(useChatStore.getState(), target);

      expect(state.agent?.pluginRefs).toEqual([agentTool]);
      expect(state.effective.pluginRefs).toEqual(
        expect.arrayContaining([agentTool]),
      );
    } finally {
      useModelCatalogStore.setState({ snapshot });
    }
  });

  it('leaves out a global the project turned off', () => {
    seedProject(selections([PROJECT_TOOL]), { pluginRefs: [GLOBAL_TOOL] });
    seedChat('project', 'worktree');

    const state = chatPluginEditingState(useChatStore.getState(), target);

    expect(state.effective.pluginRefs).toEqual([PROJECT_TOOL]);
    expect(state.projectTombstones).toEqual({ pluginRefs: [GLOBAL_TOOL] });
  });

  it('shows a chat from before live defaults only what it had', () => {
    seedChat('project', 'worktree', {
      pluginSelections: selections([EXTRA_TOOL]),
      inheritedPluginDefaultsVersion: undefined,
    });

    const state = chatPluginEditingState(useChatStore.getState(), target);

    expect(state.projectDefaults).toBeUndefined();
    expect(state.effective.pluginRefs).toEqual([GLOBAL_TOOL, EXTRA_TOOL]);
  });

  it('prefers the scoped project layer the cowork store mirrors', () => {
    useChatStore.setState({
      worktreeDefaultPlugins: { 'project/worktree': selections([EXTRA_TOOL]) },
    });
    seedChat('project', 'worktree');

    expect(
      chatPluginEditingState(useChatStore.getState(), target).projectDefaults
        ?.pluginRefs,
    ).toEqual([EXTRA_TOOL]);
  });

  it('ignores inherited layers on surfaces that do not inherit them', () => {
    useChatStore.setState({
      worktreeDefaultPlugins: {
        [`${APP_ADVISOR_PROJECT_ID}/${APP_ADVISOR_WORKTREE_ID}`]: selections([
          PROJECT_TOOL,
        ]),
      },
    });
    seedChat(APP_ADVISOR_PROJECT_ID, APP_ADVISOR_WORKTREE_ID, {
      pluginSelections: selections([EXTRA_TOOL]),
    });

    const state = chatPluginEditingState(useChatStore.getState(), {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_WORKTREE_ID,
      chatId: 'chat',
    });

    expect(state.projectDefaults).toBeUndefined();
    expect(state.global).toBeUndefined();
    expect(state.effective.pluginRefs).toEqual([EXTRA_TOOL]);
  });
});

describe('inheritedDefaultLayers', () => {
  it('labels only the globals the project keeps as global defaults', () => {
    expect(
      inheritedDefaultLayers({
        projectDefaults: selections([PROJECT_TOOL]),
        global: selections([GLOBAL_TOOL, EXTRA_TOOL]),
        projectTombstones: { pluginRefs: [GLOBAL_TOOL] },
      }),
    ).toEqual({
      project: selections([PROJECT_TOOL]),
      global: selections([EXTRA_TOOL]),
    });
    expect(inheritedDefaultLayers({})).toEqual({});
  });
});

describe('editChatPlugins', () => {
  it('turns off a project default with a chat tombstone and no local copy', async () => {
    seedChat('project', 'worktree', { inheritedPluginDefaultsVersion: 1 });

    await editChatPlugins(useChatStore.getState, target, (current) => ({
      ...current,
      pluginRefs: current.pluginRefs.filter(
        (ref) => ref.pluginName !== PROJECT_TOOL.pluginName,
      ),
    }));

    expect(lastUpdate()?.pluginSelections.pluginRefs).toEqual([]);
    expect(lastUpdate()?.disabledGlobalPluginSelections).toEqual({
      pluginRefs: [PROJECT_TOOL],
    });
    expect(
      currentTab('project', 'worktree')?.disabledGlobalPluginSelections,
    ).toEqual({ pluginRefs: [PROJECT_TOOL] });
  });

  it('keeps a checked non-default as the chat’s own selection', async () => {
    seedChat('project', 'worktree', { inheritedPluginDefaultsVersion: 1 });

    await editChatPlugins(useChatStore.getState, target, (current) => ({
      ...current,
      pluginRefs: [...current.pluginRefs, EXTRA_TOOL],
    }));

    expect(lastUpdate()?.pluginSelections.pluginRefs).toEqual([EXTRA_TOOL]);
    expect(lastUpdate()?.disabledGlobalPluginSelections).toEqual({});
  });

  it('keeps a global the project turned off as the chat’s own when checked', async () => {
    seedProject(selections([PROJECT_TOOL]), { pluginRefs: [GLOBAL_TOOL] });
    seedChat('project', 'worktree');

    await editChatPlugins(useChatStore.getState, target, (current) => ({
      ...current,
      pluginRefs: [...current.pluginRefs, GLOBAL_TOOL],
    }));

    expect(lastUpdate()?.pluginSelections.pluginRefs).toEqual([GLOBAL_TOOL]);
    expect(lastUpdate()?.disabledGlobalPluginSelections).toEqual({});
  });

  it('records no chat choice for a global the project turned off', async () => {
    seedProject(selections([PROJECT_TOOL]), { pluginRefs: [GLOBAL_TOOL] });
    seedChat('project', 'worktree');

    await editChatPlugins(useChatStore.getState, target, (current) => ({
      ...current,
      pluginRefs: current.pluginRefs.filter(
        (ref) => ref.pluginName !== GLOBAL_TOOL.pluginName,
      ),
    }));

    expect(lastUpdate()?.pluginSelections.pluginRefs).toEqual([]);
    expect(lastUpdate()?.disabledGlobalPluginSelections).toEqual({});
  });

  // Until it is normalized, such a chat owns every ref it has, copies of
  // project defaults included, and inherits no project layer.
  it('keeps the copies in a chat written before live defaults as its own', async () => {
    seedChat('project', 'worktree', {
      pluginSelections: selections([PROJECT_TOOL]),
      inheritedPluginDefaultsVersion: undefined,
    });

    await editChatPlugins(useChatStore.getState, target, (current) => ({
      ...current,
      pluginRefs: [...current.pluginRefs, EXTRA_TOOL],
    }));

    expect(lastUpdate()?.pluginSelections.pluginRefs).toEqual([
      PROJECT_TOOL,
      EXTRA_TOOL,
    ]);
    expect(lastUpdate()?.disabledGlobalPluginSelections).toEqual({});
  });

  it('leaves tombstones untouched on surfaces that do not inherit defaults', async () => {
    seedChat(APP_ADVISOR_PROJECT_ID, APP_ADVISOR_WORKTREE_ID);

    await editChatPlugins(
      useChatStore.getState,
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
        chatId: 'chat',
      },
      (current) => ({ ...current, pluginRefs: [EXTRA_TOOL] }),
    );

    expect(lastUpdate()).toBeDefined();
    expect(lastUpdate()).not.toHaveProperty('disabledGlobalPluginSelections');
  });
});

describe('setChatAuthPreferencesFromEffective', () => {
  const PROXIED: McpHttpAuthTarget = {
    kind: 'standalone',
    serverId: 'proxied',
    configId: 'default',
  };
  const DEFAULTED: McpHttpAuthTarget = {
    kind: 'standalone',
    serverId: 'defaulted',
    configId: 'default',
  };

  it('accepts a save whose canonical settings event arrives before its IPC response', async () => {
    seedChat('project', 'worktree', {
      pluginSelections: selections([EXTRA_TOOL]),
    });
    const { effective } = chatPluginEditingState(
      useChatStore.getState(),
      target,
    );
    updatePluginsMock.mockImplementationOnce((request) => {
      // Main publishes the committed settings before replying to updatePlugins.
      useChatStore.setState((state) => ({
        worktreeChats: {
          ...state.worktreeChats,
          'project/worktree': {
            ...state.worktreeChats['project/worktree'],
            tabs: state.worktreeChats['project/worktree'].tabs.map((tab) =>
              tab.id === target.chatId
                ? { ...tab, pluginSelections: request.pluginSelections }
                : tab,
            ),
          },
        },
      }));
      return Promise.resolve({ pluginSelections: request.pluginSelections });
    });

    await expect(
      setChatAuthPreferencesFromEffective(
        useChatStore.getState,
        target,
        setMcpHttpAuthPreference(effective, PROXIED, 'canopy'),
      ),
    ).resolves.toBe(true);
    expect(currentTab('project', 'worktree')?.pluginSelections).toEqual({
      ...selections([EXTRA_TOOL]),
      mcpHttpAuthPreferences: [{ target: PROXIED, handler: 'canopy' }],
    });
  });

  it('refuses a late save response after a different selection was applied', async () => {
    seedChat('project', 'worktree', {
      pluginSelections: selections([EXTRA_TOOL]),
    });
    const { effective } = chatPluginEditingState(
      useChatStore.getState(),
      target,
    );
    updatePluginsMock.mockImplementationOnce((request) => {
      seedChat('project', 'worktree', {
        pluginSelections: selections([PROJECT_TOOL]),
      });
      return Promise.resolve({ pluginSelections: request.pluginSelections });
    });

    await expect(
      setChatAuthPreferencesFromEffective(
        useChatStore.getState,
        target,
        setMcpHttpAuthPreference(effective, PROXIED, 'canopy'),
      ),
    ).resolves.toBe(false);
    expect(currentTab('project', 'worktree')?.pluginSelections).toEqual(
      selections([PROJECT_TOOL]),
    );
  });

  it('stores the handler choice without copying inherited defaults', async () => {
    seedChat('project', 'worktree', {
      pluginSelections: selections([EXTRA_TOOL]),
      inheritedPluginDefaultsVersion: 1,
    });
    const { effective } = chatPluginEditingState(
      useChatStore.getState(),
      target,
    );

    await setChatAuthPreferencesFromEffective(
      useChatStore.getState,
      target,
      setMcpHttpAuthPreference(effective, PROXIED, 'provider'),
    );

    expect(currentTab('project', 'worktree')?.pluginSelections).toEqual({
      ...selections([EXTRA_TOOL]),
      mcpHttpAuthPreferences: [{ target: PROXIED, handler: 'provider' }],
    });
  });

  it('leaves a choice that matches a default to the default', async () => {
    seedProject({
      ...selections([PROJECT_TOOL]),
      mcpHttpAuthPreferences: [{ target: DEFAULTED, handler: 'canopy' }],
    });
    seedChat('project', 'worktree', { inheritedPluginDefaultsVersion: 1 });
    const { effective } = chatPluginEditingState(
      useChatStore.getState(),
      target,
    );

    await setChatAuthPreferencesFromEffective(
      useChatStore.getState,
      target,
      setMcpHttpAuthPreference(effective, PROXIED, 'canopy'),
    );

    expect(
      currentTab('project', 'worktree')?.pluginSelections
        ?.mcpHttpAuthPreferences,
    ).toEqual([{ target: PROXIED, handler: 'canopy' }]);
    expect(
      currentTab('project', 'worktree')?.pluginSelections?.pluginRefs,
    ).toEqual([]);
  });

  it('writes the edited set as is on surfaces that do not inherit defaults', async () => {
    seedChat(APP_ADVISOR_PROJECT_ID, APP_ADVISOR_WORKTREE_ID, {
      pluginSelections: selections([EXTRA_TOOL]),
    });
    const next = setMcpHttpAuthPreference(
      selections([EXTRA_TOOL]),
      PROXIED,
      'provider',
    );

    await setChatAuthPreferencesFromEffective(
      useChatStore.getState,
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
        chatId: 'chat',
      },
      next,
    );

    expect(
      currentTab(APP_ADVISOR_PROJECT_ID, APP_ADVISOR_WORKTREE_ID)
        ?.pluginSelections,
    ).toEqual(next);
  });
});

describe('Activity edits queued behind Try it authorization', () => {
  it.each(['remove', 'auth-inherited', 'auth-owned'])(
    'preserves accepted selections and unrelated preferences for %s',
    async (operation) => {
      if (operation === 'auth-owned') {
        seedProject(undefined);
        useGlobalPluginDefaultsStore.setState({ hydrated: false });
      }
      seedChat('project', 'worktree', {
        pluginSelections: selections([EXTRA_TOOL]),
      });
      const { effective } = chatPluginEditingState(
        useChatStore.getState(),
        target,
      );
      const selectedTarget: McpHttpAuthTarget = {
        kind: 'standalone',
        serverId: 'existing',
        configId: 'default',
      };
      const resolvedTarget: McpHttpAuthTarget = {
        kind: 'standalone',
        serverId: 'resolved',
        configId: 'default',
      };
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const authorization = queueDesktopTryItSelectionUpdate(
        target,
        async () => {
          await gate;
          seedChat('project', 'worktree', {
            pluginSelections: {
              ...selections([EXTRA_TOOL]),
              mcpServerRefs: [{ serverId: 'resolved', configId: 'default' }],
              mcpHttpAuthPreferences: [
                { target: resolvedTarget, handler: 'canopy' },
              ],
            },
          });
        },
      );
      const edit =
        operation === 'remove'
          ? editChatPlugins(useChatStore.getState, target, (current) => ({
              ...current,
              pluginRefs: current.pluginRefs.filter(
                (ref) => ref.pluginName !== EXTRA_TOOL.pluginName,
              ),
            }))
          : setChatAuthPreferencesFromEffective(
              useChatStore.getState,
              target,
              setMcpHttpAuthPreference(effective, selectedTarget, 'provider'),
            );
      release();
      await Promise.all([authorization, edit]);
      expect(lastUpdate()?.pluginSelections).toMatchObject({
        pluginRefs: operation === 'remove' ? [] : [EXTRA_TOOL],
        mcpServerRefs: [{ serverId: 'resolved', configId: 'default' }],
      });
      expect(
        lastUpdate()?.pluginSelections.mcpHttpAuthPreferences,
      ).toContainEqual({
        target: resolvedTarget,
        handler: 'canopy',
      });
      if (operation !== 'remove') {
        expect(
          lastUpdate()?.pluginSelections.mcpHttpAuthPreferences,
        ).toContainEqual({
          target: selectedTarget,
          handler: 'provider',
        });
      }
    },
  );
});
