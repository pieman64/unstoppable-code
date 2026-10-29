/**
 * Scoped-mode coverage for the standalone chat store (App Advisor popout):
 * scoped initialization, lazy first entry, entry switching, synthesized
 * defaults, no project listing/loading, no `lastActiveContext` mutation, and
 * command-created chats (`createWorkEntryChatWithMessage`).
 */
import { create } from 'zustand';
import {
  APP_ADVISOR_PROJECT_ID,
  type CoworkWorkEntryMeta,
} from '@canopy/desktop-shared/types';

interface MockTab {
  id: string;
  title: string;
  messages: Array<{ timestamp: number }>;
}

interface MockWorktreeChatState {
  tabs: MockTab[];
  activeTabId: string;
}

interface MockChatStoreState {
  selectedWorktree: { projectId: string; worktreeId: string } | null;
  worktreeChats: Record<string, MockWorktreeChatState>;
  selectWorktree: (projectId: string, worktreeId: string) => void;
  loadTabs: () => Promise<void>;
  createTab: (target?: {
    projectId: string;
    worktreeId: string;
    id?: string;
    replaceActiveEmpty?: boolean;
  }) => void;
  createTabWithId: (id: string) => void;
  sendMessage: (
    message: string,
    fileReferences?: unknown,
    target?: { projectId: string; worktreeId: string; chatId: string },
    inputMode?: unknown,
    options?: unknown,
  ) => Promise<void>;
  switchTab: (tabId: string) => void;
  closeTab: (tabId: string, options?: unknown) => void;
  setWorktreeDefaultPlugins: (
    projectId: string,
    worktreeId: string,
    selections?: unknown,
  ) => void;
  ensureModelDefaultsLoaded: () => Promise<null>;
  flushWorktreeTabs: (projectId: string, worktreeId: string) => Promise<void>;
  suppressWorktreePersistence: (projectId: string, worktreeId: string) => void;
  resumeWorktreePersistence: (projectId: string, worktreeId: string) => void;
  cleanupWorktree: (projectId: string, worktreeId: string) => void;
  syncActiveEmptyTabToDefaults: () => Promise<void>;
  /** Settings actions used by the Home-to-cowork send path. */
  ensureWorktreeHasChatTab?: (target: {
    projectId: string;
    worktreeId: string;
  }) => Promise<void>;
  setSpeed?: (
    speed: 'standard' | 'fast' | 'ultrafast',
    target?: { projectId: string; worktreeId: string; chatId: string },
  ) => Promise<void>;
  setFastMode?: (
    enabled: boolean,
    target?: { projectId: string; worktreeId: string; chatId: string },
  ) => Promise<void>;
}

const selectWorktreeMock = jest.fn((projectId: string, worktreeId: string) => {
  mockChatStore.setState({ selectedWorktree: { projectId, worktreeId } });
});
const createTabMock = jest.fn(
  (target?: {
    projectId: string;
    worktreeId: string;
    id?: string;
    replaceActiveEmpty?: boolean;
  }) => {
    const selection = target ?? mockChatStore.getState().selectedWorktree;
    if (!selection) return;
    const id = target?.id ?? `tab-${Date.now()}`;
    const key = `${selection.projectId}/${selection.worktreeId}`;
    const worktreeChats = mockChatStore.getState().worktreeChats;
    const existing = worktreeChats[key] ?? { tabs: [], activeTabId: '' };
    mockChatStore.setState({
      worktreeChats: {
        ...worktreeChats,
        [key]: {
          tabs: [
            ...(target?.replaceActiveEmpty
              ? existing.tabs.filter((tab) => tab.id !== existing.activeTabId)
              : existing.tabs),
            { id, title: 'New Chat', messages: [] },
          ],
          activeTabId: id,
        },
      },
    });
  },
);
const sendMessageMock = jest.fn().mockResolvedValue(undefined);
const loadTabsMock = jest.fn().mockResolvedValue(undefined);
const syncActiveEmptyTabToDefaultsMock = jest.fn().mockResolvedValue(undefined);
const ensureModelDefaultsLoadedMock = jest.fn().mockResolvedValue(null);
const setWorktreeDefaultPluginsMock = jest.fn();

function createMockChatStoreState(): MockChatStoreState {
  return {
    selectedWorktree: null,
    worktreeChats: {},
    selectWorktree: selectWorktreeMock,
    loadTabs: loadTabsMock,
    createTab: createTabMock,
    createTabWithId: jest.fn(),
    sendMessage: sendMessageMock,
    switchTab: jest.fn(),
    closeTab: jest.fn(),
    setWorktreeDefaultPlugins: setWorktreeDefaultPluginsMock,
    ensureModelDefaultsLoaded: ensureModelDefaultsLoadedMock,
    flushWorktreeTabs: jest.fn().mockResolvedValue(undefined),
    suppressWorktreePersistence: jest.fn(),
    resumeWorktreePersistence: jest.fn(),
    cleanupWorktree: jest.fn(),
    syncActiveEmptyTabToDefaults: syncActiveEmptyTabToDefaultsMock,
  };
}

const mockChatStore = create<MockChatStoreState>(() =>
  createMockChatStoreState(),
);

jest.mock('@/stores/chatStore', () => ({
  useChatStore: mockChatStore,
}));

const loadProjectsMock = jest.fn().mockResolvedValue(undefined);
jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: {
    getState: (): { loadProjects: jest.Mock } => ({
      loadProjects: loadProjectsMock,
    }),
  },
}));

const disposeLayoutMock = jest.fn();
jest.mock('@/stores/panelLayoutStore', () => ({
  usePanelLayoutStore: {
    getState: (): { disposeLayout: jest.Mock } => ({
      disposeLayout: disposeLayoutMock,
    }),
  },
}));

function makeEntry(
  id: string,
  overrides: Partial<CoworkWorkEntryMeta> = {},
): CoworkWorkEntryMeta {
  return {
    id,
    title: `Entry ${id}`,
    createdAt: '2024-01-01T00:00:00.000Z',
    chatCount: 1,
    ...overrides,
  };
}

const mockApi = {
  appAdvisor: {
    settingsLoad: jest.fn().mockResolvedValue({
      version: 1,
      description: 'Local assistant project',
      archiveRetentionDays: 30,
    }),
  },
  standaloneChat: {
    init: jest.fn().mockResolvedValue(undefined),
    list: jest.fn().mockResolvedValue({ chats: [] }),
    readArchive: jest.fn().mockResolvedValue({
      summary: 'test summary',
      snapshot: null,
      legacySummaryOnly: true,
    }),
  },
  workEntries: {
    list: jest.fn().mockResolvedValue({ entries: [] }),
    create: jest.fn().mockResolvedValue({
      entry: makeEntry('entry-created'),
      reusedExistingEmpty: false,
    }),
    update: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    resolveChat: jest
      .fn()
      .mockResolvedValue({ entryId: null, archivedInEntryId: null }),
  },
  chatProject: {
    list: jest.fn().mockResolvedValue({ projects: [] }),
    update: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  },
  loadPreferences: jest.fn().mockResolvedValue({
    appAdvisorModel: 'claude-opus-4-6',
    appAdvisorThinkingLevel: 'high',
    appAdvisorPluginSelections: {
      collectionIds: ['collection-1'],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    },
  }),
  savePreferences: jest.fn().mockResolvedValue(undefined),
};

Object.defineProperty(globalThis, 'window', {
  value: globalThis,
  writable: true,
});
if (typeof globalThis.crypto?.randomUUID !== 'function') {
  let counter = 0;
  Object.defineProperty(globalThis, 'crypto', {
    value: { randomUUID: (): string => `uuid-${++counter}` },
    writable: true,
  });
}
Object.defineProperty(window, 'api', {
  value: mockApi,
  writable: true,
});

const standaloneChatStoreModulePromise = import('../standaloneChatStore');

type StandaloneChatStoreModule = Awaited<
  typeof standaloneChatStoreModulePromise
>;

let useStandaloneChatStore: StandaloneChatStoreModule['useStandaloneChatStore'];

beforeAll(async () => {
  ({ useStandaloneChatStore } = await standaloneChatStoreModulePromise);
});

beforeEach(() => {
  jest.clearAllMocks();
  mockChatStore.setState(createMockChatStoreState());
  useStandaloneChatStore.setState({
    workEntries: [],
    chatProjects: [],
    activeWorkEntryId: null,
    activeChatProjectId: 'cowork-default',
    scopedWorkspaceId: null,
    initialized: false,
    chatProjectsLoaded: false,
    archiveOverlayChatId: null,
    activeSummary: null,
    activeArchiveData: null,
    sidebarEntriesByProject: {},
    legacyArchivedByProject: {},
  });
  mockApi.workEntries.list.mockResolvedValue({ entries: [] });
  mockApi.workEntries.create.mockResolvedValue({
    entry: makeEntry('entry-created'),
    reusedExistingEmpty: false,
  });
});

describe('initializeScoped', () => {
  it('pins the project, synthesizes config, and never lists chat projects', async () => {
    mockApi.workEntries.list.mockResolvedValue({
      entries: [makeEntry('entry-1'), makeEntry('entry-2')],
    });

    await useStandaloneChatStore
      .getState()
      .initializeScoped(APP_ADVISOR_PROJECT_ID);

    const state = useStandaloneChatStore.getState();
    expect(state.scopedWorkspaceId).toBe(APP_ADVISOR_PROJECT_ID);
    expect(state.activeChatProjectId).toBe(APP_ADVISOR_PROJECT_ID);
    expect(state.initialized).toBe(true);
    expect(state.chatProjectsLoaded).toBe(true);
    expect(state.activeWorkEntryId).toBe('entry-1');
    expect(state.workEntries).toHaveLength(2);

    // Synthesized single workspace configuration.
    expect(state.chatProjects).toHaveLength(1);
    expect(state.chatProjects[0]).toMatchObject({
      id: APP_ADVISOR_PROJECT_ID,
      description: 'Local assistant project',
      archiveRetentionDays: 30,
      defaultModel: 'claude-opus-4-6',
      defaultPluginSelections: expect.objectContaining({
        collectionIds: ['collection-1'],
      }) as unknown,
    });

    // No project listing/loading in scoped mode.
    expect(mockApi.chatProject.list).not.toHaveBeenCalled();
    expect(loadProjectsMock).not.toHaveBeenCalled();

    // Standard chat-store selection path.
    expect(selectWorktreeMock).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
      'entry-1',
    );
    expect(loadTabsMock).toHaveBeenCalled();
    expect(syncActiveEmptyTabToDefaultsMock).toHaveBeenCalled();
    expect(setWorktreeDefaultPluginsMock).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
      'entry-1',
      expect.objectContaining({ collectionIds: ['collection-1'] }),
    );
  });

  it('lazily creates the first entry when none exist', async () => {
    mockApi.workEntries.list.mockResolvedValue({ entries: [] });
    mockApi.workEntries.create.mockResolvedValue({
      entry: makeEntry('entry-first'),
      reusedExistingEmpty: false,
    });

    await useStandaloneChatStore
      .getState()
      .initializeScoped(APP_ADVISOR_PROJECT_ID);

    expect(mockApi.workEntries.create).toHaveBeenCalledWith({
      projectId: APP_ADVISOR_PROJECT_ID,
    });
    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe(
      'entry-first',
    );
  });

  it('is idempotent once initialized for the same project', async () => {
    mockApi.workEntries.list.mockResolvedValue({
      entries: [makeEntry('entry-1')],
    });
    await useStandaloneChatStore
      .getState()
      .initializeScoped(APP_ADVISOR_PROJECT_ID);
    mockApi.workEntries.list.mockClear();

    await useStandaloneChatStore
      .getState()
      .initializeScoped(APP_ADVISOR_PROJECT_ID);
    expect(mockApi.workEntries.list).not.toHaveBeenCalled();
  });

  it('refreshes scoped model and plugin defaults for every known entry', async () => {
    mockApi.workEntries.list.mockResolvedValue({
      entries: [makeEntry('entry-1'), makeEntry('entry-2')],
    });
    await useStandaloneChatStore
      .getState()
      .initializeScoped(APP_ADVISOR_PROJECT_ID);
    setWorktreeDefaultPluginsMock.mockClear();

    const preferences = await window.api.loadPreferences();
    preferences.appAdvisorModel = 'gpt-5.5';
    preferences.appAdvisorPluginSelections = {
      collectionIds: ['collection-refreshed'],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    useStandaloneChatStore.getState().applyScopedPreferences(preferences);

    expect(useStandaloneChatStore.getState().chatProjects[0]).toMatchObject({
      defaultModel: 'gpt-5.5',
      defaultPluginSelections: expect.objectContaining({
        collectionIds: ['collection-refreshed'],
      }) as unknown,
    });
    expect(setWorktreeDefaultPluginsMock).toHaveBeenCalledTimes(2);
    expect(setWorktreeDefaultPluginsMock).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
      'entry-2',
      expect.objectContaining({ collectionIds: ['collection-refreshed'] }),
    );
  });

  it('never writes lastActiveContext during scoped init or entry switching', async () => {
    mockApi.workEntries.list.mockResolvedValue({
      entries: [makeEntry('entry-1'), makeEntry('entry-2')],
    });
    await useStandaloneChatStore
      .getState()
      .initializeScoped(APP_ADVISOR_PROJECT_ID);

    await useStandaloneChatStore.getState().selectWorkEntry('entry-2');
    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe('entry-2');

    for (const call of mockApi.savePreferences.mock.calls as Array<
      [Record<string, unknown>]
    >) {
      expect(call[0]).not.toHaveProperty('lastActiveContext');
    }
  });

  it('initialize() is a no-op while scoped', async () => {
    useStandaloneChatStore.setState({
      scopedWorkspaceId: APP_ADVISOR_PROJECT_ID,
    });
    await useStandaloneChatStore.getState().initialize();
    expect(mockApi.chatProject.list).not.toHaveBeenCalled();
    expect(useStandaloneChatStore.getState().initialized).toBe(false);
  });

  it('switchChatProject throws in development while scoped', async () => {
    useStandaloneChatStore.setState({
      scopedWorkspaceId: APP_ADVISOR_PROJECT_ID,
    });
    await expect(
      useStandaloneChatStore.getState().switchChatProject('cowork-default'),
    ).rejects.toThrow(/forbidden while scoped/);
  });
});

describe('createWorkEntryChatWithMessage', () => {
  beforeEach(async () => {
    mockApi.workEntries.list.mockResolvedValue({
      entries: [makeEntry('entry-1')],
    });
    await useStandaloneChatStore
      .getState()
      .initializeScoped(APP_ADVISOR_PROJECT_ID);
    mockApi.workEntries.create.mockClear();
    mockApi.workEntries.create.mockResolvedValue({
      entry: makeEntry('entry-quick'),
      reusedExistingEmpty: false,
    });
    mockApi.workEntries.list.mockResolvedValue({
      entries: [makeEntry('entry-quick'), makeEntry('entry-1')],
    });
  });

  it('creates a new work entry and preserves the pre-assigned chat id', async () => {
    const chatId = await useStandaloneChatStore
      .getState()
      .createWorkEntryChatWithMessage({
        chatId: 'assigned-chat-id',
        entryId: 'entry-quick',
        removeEntryOnFailure: true,
        replaceActiveEmpty: true,
        message: 'Quick prompt text',
        title: 'Quick prompt',
        config: { model: 'claude-opus-4-6', thinkingLevel: 'high' },
        sendOptions: {
          initiationSource: 'automation' as const,
          userMessageId: 'assigned-user-message-id',
          packageOverlay: {
            packageDigest: `pp:v1:${'a'.repeat(43)}`,
            resources: [],
          },
        },
      });

    expect(chatId).toBe('assigned-chat-id');
    expect(mockApi.workEntries.create).not.toHaveBeenCalled();
    expect(createTabMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-quick',
        id: 'assigned-chat-id',
        replaceActiveEmpty: true,
      }),
    );
    expect(sendMessageMock).toHaveBeenCalledWith(
      'Quick prompt text',
      undefined,
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-quick',
        chatId: 'assigned-chat-id',
      },
      undefined,
      expect.objectContaining({
        initiationSource: 'automation',
        userMessageId: 'assigned-user-message-id',
        packageOverlay: {
          packageDigest: `pp:v1:${'a'.repeat(43)}`,
          resources: [],
        },
        throwOnDispatchFailure: true,
      }),
    );
    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe(
      'entry-quick',
    );
  });

  it('preserves the selected empty chat in a targeted existing entry', async () => {
    const original = {
      id: 'draft-chat',
      title: 'Draft with chosen model',
      messages: [],
    };
    mockChatStore.setState({
      worktreeChats: {
        [`${APP_ADVISOR_PROJECT_ID}/entry-1`]: {
          tabs: [original],
          activeTabId: original.id,
        },
      },
    });

    await useStandaloneChatStore.getState().createWorkEntryChatWithMessage({
      chatId: 'automation-chat',
      entryId: 'entry-1',
      removeEntryOnFailure: false,
      replaceActiveEmpty: false,
      message: 'Automated prompt',
    });

    expect(
      mockChatStore.getState().worktreeChats[
        `${APP_ADVISOR_PROJECT_ID}/entry-1`
      ]?.tabs,
    ).toEqual([
      original,
      { id: 'automation-chat', title: 'New Chat', messages: [] },
    ]);
  });

  it.each([
    ['a newly created', false],
    ['a reused empty', true],
  ])(
    'asks the chat store to replace the starter of %s self-created entry',
    async (_label, reusedExistingEmpty) => {
      mockApi.workEntries.create.mockResolvedValue({
        entry: makeEntry('entry-quick'),
        reusedExistingEmpty,
      });

      await useStandaloneChatStore
        .getState()
        .createWorkEntryChatWithMessage({ chatId: 'self-chat', message: 'hi' });

      expect(createTabMock).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreeId: 'entry-quick',
          id: 'self-chat',
          replaceActiveEmpty: true,
        }),
      );
    },
  );

  it('appends in a targeted existing entry unless replacement is requested', async () => {
    await useStandaloneChatStore.getState().createWorkEntryChatWithMessage({
      chatId: 'targeted-chat',
      entryId: 'entry-1',
      message: 'Automated prompt',
    });

    expect(createTabMock).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'entry-1',
        id: 'targeted-chat',
        replaceActiveEmpty: false,
      }),
    );
  });

  it('keeps a reused self-created entry when the send fails', async () => {
    mockApi.workEntries.create.mockResolvedValue({
      entry: makeEntry('entry-quick'),
      reusedExistingEmpty: true,
    });
    sendMessageMock.mockRejectedValueOnce(new Error('send failed'));

    await expect(
      useStandaloneChatStore.getState().createWorkEntryChatWithMessage({
        chatId: 'failed-chat',
        message: 'x',
      }),
    ).rejects.toThrow('send failed');

    expect(mockChatStore.getState().closeTab).toHaveBeenCalledWith(
      'failed-chat',
      expect.objectContaining({ worktreeId: 'entry-quick', force: true }),
    );
    expect(mockApi.workEntries.delete).not.toHaveBeenCalled();
  });

  it('generates a chat id when none is provided', async () => {
    const chatId = await useStandaloneChatStore
      .getState()
      .createWorkEntryChatWithMessage({ message: 'hello' });
    expect(typeof chatId).toBe('string');
    expect(chatId.length).toBeGreaterThan(0);
  });

  it('rolls back the entry when the send fails', async () => {
    sendMessageMock.mockRejectedValueOnce(new Error('send failed'));

    await expect(
      useStandaloneChatStore.getState().createWorkEntryChatWithMessage({
        chatId: 'failed-chat',
        entryId: 'entry-quick',
        removeEntryOnFailure: true,
        message: 'boom',
      }),
    ).rejects.toThrow('send failed');

    expect(mockApi.workEntries.delete).toHaveBeenCalledWith({
      projectId: APP_ADVISOR_PROJECT_ID,
      entryId: 'entry-quick',
    });
  });

  it('never writes lastActiveContext for command-created chats', async () => {
    await useStandaloneChatStore
      .getState()
      .createWorkEntryChatWithMessage({ message: 'quick' });
    for (const call of mockApi.savePreferences.mock.calls as Array<
      [Record<string, unknown>]
    >) {
      expect(call[0]).not.toHaveProperty('lastActiveContext');
    }
  });

  it('seeds a command-created chat with the exact Codex speed', async () => {
    await useStandaloneChatStore.getState().createWorkEntryChatWithMessage({
      chatId: 'speed-chat',
      entryId: 'entry-quick',
      message: 'quick',
      config: {
        model: 'gpt-5.5',
        modelConfig: { speed: 'ultrafast', fastMode: false },
      },
    });

    expect(createTabMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'speed-chat',
        modelConfig: { speed: 'ultrafast', fastMode: false },
      }),
    );
  });
});

describe('createStandaloneChatWithMessage Codex speed', () => {
  const setSpeedMock = jest.fn(() => Promise.resolve());
  const setFastModeMock = jest.fn(() => Promise.resolve());

  beforeEach(() => {
    mockChatStore.setState({
      ensureWorktreeHasChatTab: jest.fn(() => Promise.resolve()),
      setSpeed: setSpeedMock,
      setFastMode: setFastModeMock,
    });
    useStandaloneChatStore.setState({ initialized: true });
  });

  it('applies an exact staged speed to the created chat', async () => {
    const chatId = await useStandaloneChatStore
      .getState()
      .createStandaloneChatWithMessage({
        chatProjectId: 'cowork-default',
        message: 'ship it',
        config: { model: 'gpt-5.5', speed: 'ultrafast' },
      });

    expect(setSpeedMock).toHaveBeenCalledWith('ultrafast', {
      projectId: 'cowork-default',
      worktreeId: 'entry-created',
      chatId,
    });
    expect(setFastModeMock).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledWith(
      'ship it',
      undefined,
      { projectId: 'cowork-default', worktreeId: 'entry-created', chatId },
      undefined,
      expect.anything(),
    );
  });

  it('keeps a legacy boolean draft on the boolean adapter', async () => {
    await useStandaloneChatStore.getState().createStandaloneChatWithMessage({
      chatProjectId: 'cowork-default',
      message: 'ship it',
      config: { model: 'gpt-5.5', fastMode: true },
    });

    expect(setFastModeMock).toHaveBeenCalledWith(true, expect.anything());
    expect(setSpeedMock).not.toHaveBeenCalled();
  });
});
