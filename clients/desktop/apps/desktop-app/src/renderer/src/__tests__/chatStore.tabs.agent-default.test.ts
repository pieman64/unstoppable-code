// A new chat created on an Agent that inherits the default must start pinned
// to that chat's default, so a later Settings change cannot reroute it.
import type * as DesktopSharedTypes from '@canopy/desktop-shared/types';
import type * as ChatStoreModule from '../stores/chatStore';

const KEY = 'project/worktree';
const noop = jest.fn();

function loadStore(): typeof ChatStoreModule {
  jest.resetModules();
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: {
      location: { search: '' },
      api: {
        chat: {
          sendMessage: jest.fn().mockResolvedValue(undefined),
          cancel: jest.fn().mockResolvedValue(undefined),
          loadTabs: jest.fn().mockResolvedValue({ tabs: [] }),
          saveTabs: jest.fn().mockResolvedValue(undefined),
          activeSessions: jest
            .fn()
            .mockResolvedValue({ activeChatIds: [], sessions: [] }),
          command: jest.fn().mockResolvedValue({
            revision: 2,
            outcome: 'applied',
          }),
          preparePlanFileSystemInstruction: noop,
        },
        getDiffStatsBatch: jest.fn().mockResolvedValue([]),
        discoverWorktreeEnv: jest.fn().mockResolvedValue(undefined),
        github: {
          setForegroundWorktree: noop,
          requestFastRefresh: noop,
          requestKnownPrFastRefresh: jest.fn().mockResolvedValue(false),
        },
        activity: {
          plans: {
            create: noop,
            update: noop,
            list: jest.fn().mockResolvedValue([]),
            get: jest.fn().mockResolvedValue(null),
          },
        },
        showOsNotification: jest.fn().mockResolvedValue({ shown: false }),
        onOsNotificationClicked: jest.fn(() => (): void => {}),
        onOsNotificationClosed: jest.fn(() => (): void => {}),
        appAdvisor: { openWindow: jest.fn().mockResolvedValue(undefined) },
        savePreferences: noop,
        loadPreferences: jest.fn().mockResolvedValue({}),
      },
    },
  });
  return jest.requireActual<typeof ChatStoreModule>('../stores/chatStore');
}

describe('createTab with an Agent that inherits the default', () => {
  it('stores the route to the chat default', () => {
    const { useChatStore } = loadStore();
    const { initAgentModels, initClaudeModels, initCodexModels } =
      jest.requireActual<typeof DesktopSharedTypes>(
        '@canopy/desktop-shared/types',
      );
    initClaudeModels([{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }]);
    initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
    initAgentModels([
      {
        id: 'agent_model_inherit',
        name: 'Inherit',
        baseModel: 'default',
        instructions: '',
        pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
        createdAt: '2026-10-12T00:00:00.000Z',
        updatedAt: '2026-10-12T00:00:00.000Z',
        available: true,
      },
    ]);
    useChatStore.setState({
      modelDefaults: {
        chatProvider: 'claude',
        chatModelByProvider: {
          claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
          codex: { model: 'gpt-5.5', thinkingLevel: 'medium' },
          ollama: null,
        },
        worktreeProvider: 'codex',
        worktreeModelByProvider: {
          claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
          codex: { model: 'gpt-5.5', thinkingLevel: 'medium' },
          ollama: null,
        },
      },
    });

    useChatStore.getState().createTab({
      projectId: 'project',
      worktreeId: 'worktree',
      model: 'agent_model_inherit',
      modelExplicitlyChosen: true,
    });

    const tabs = useChatStore.getState().worktreeChats[KEY]?.tabs ?? [];
    expect(tabs.at(-1)).toMatchObject({
      model: 'agent_model_inherit@gpt-5.5',
      providerType: 'codex',
    });
    initAgentModels([]);
  });
});
