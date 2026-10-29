import { create } from 'zustand';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
const mockProfileCleanupToast = jest.fn();
const mockMarkStartPageSuppressed = jest.fn<void, [string]>();
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: {
    getState: (): { addToast: typeof mockProfileCleanupToast } => ({
      addToast: mockProfileCleanupToast,
    }),
  },
}));
jest.mock('@/lib/panels/start-page-suppression', () => ({
  markStartPageSuppressed: (worktreeKey: string): void =>
    mockMarkStartPageSuppressed(worktreeKey),
}));
import {
  DEFAULT_COWORK_WORKSPACE_ID,
  orgDefaultCoworkWorkspaceId,
  type ApprovalMode,
  type WorkspaceContext,
  type ChatModel,
  type ChatTabPluginSelections,
  type CoworkWorkEntryMeta,
} from '@canopy/desktop-shared/types';

interface MockTab {
  id: string;
  title: string;
  description?: string;
  messages: Array<{ timestamp: number }>;
  providerType?: 'claude' | 'codex';
}

interface MockWorktreeChatState {
  tabs: MockTab[];
  activeTabId: string;
}

interface MockChatStoreState {
  ensureWorktreeHasChatTab: () => Promise<void>;
  addPendingAttachments: jest.Mock;
  togglePlanMode: jest.Mock;
  setFastMode: jest.Mock;
  setModelSelectionMode: jest.Mock;
  setScheduledSendDraft: jest.Mock;
  selectedWorktree: { projectId: string; worktreeId: string } | null;
  worktreeChats: Record<string, MockWorktreeChatState>;
  worktreeDefaultPlugins: Record<string, unknown>;
  selectWorktree: (projectId: string, worktreeId: string) => void;
  deselectWorktree: () => void;
  loadTabs: () => Promise<void>;
  createTab: (target?: {
    projectId: string;
    worktreeId: string;
    id?: string;
    replaceActiveEmpty?: boolean;
    model?: string;
    thinkingLevel?: string;
    pluginSelections?: ChatTabPluginSelections;
  }) => void;
  createTabWithId: (id: string) => void;
  sendMessage: (
    message: string,
    attachments?: unknown,
    target?: { projectId: string; worktreeId: string; chatId: string },
  ) => Promise<void>;
  switchTab: (tabId: string) => void;
  closeTab: (
    tabId: string,
    options?: { projectId: string; worktreeId: string; force?: boolean },
  ) => void;
  setWorktreeDefaultPlugins: (
    projectId: string,
    worktreeId: string,
    selections?: unknown,
  ) => void;
  ensureModelDefaultsLoaded: () => Promise<null>;
  flushWorktreeTabs: (projectId: string, worktreeId: string) => Promise<void>;
  suppressWorktreePersistence: (projectId: string, worktreeId: string) => void;
  resumeWorktreePersistence: (projectId: string, worktreeId: string) => void;
  reloadWorktreeTabs: (projectId: string, worktreeId: string) => Promise<void>;
  cleanupWorktree: (projectId: string, worktreeId: string) => void;
  setPluginSelections: (selections?: unknown) => void;
  setTabApprovalMode: (
    target: { projectId: string; worktreeId: string; chatId: string },
    mode: ApprovalMode,
  ) => void;
  syncActiveEmptyTabToDefaults: () => Promise<void>;
  queueWorktreeTabDiscoveryRefresh: (
    projectId: string,
    worktreeId: string,
  ) => void;
  insertClonedStandaloneTab: (
    workspaceId: string,
    entryId: string,
    tab: MockTab,
    makeActive?: boolean,
    replaceActiveEmpty?: boolean,
  ) => Promise<void>;
}

const selectWorktreeMock = jest.fn((projectId: string, worktreeId: string) => {
  mockChatStore.setState({ selectedWorktree: { projectId, worktreeId } });
});
const deselectWorktreeMock = jest.fn(() => {
  mockChatStore.setState({ selectedWorktree: null });
});
const loadTabsMock = jest.fn().mockResolvedValue(undefined);
const createTabMock = jest.fn(
  (target?: {
    projectId: string;
    worktreeId: string;
    id?: string;
    replaceActiveEmpty?: boolean;
    model?: string;
    thinkingLevel?: string;
    pluginSelections?: ChatTabPluginSelections;
  }) => {
    const selection = target ?? mockChatStore.getState().selectedWorktree;
    if (!selection) {
      return;
    }

    const id = target?.id ?? `tab-${Date.now()}`;
    const key = `${selection.projectId}/${selection.worktreeId}`;
    const worktreeChats = mockChatStore.getState().worktreeChats;
    const existing = worktreeChats[key] ?? { tabs: [], activeTabId: '' };
    const nextTab = { id, title: 'New Chat', messages: [] };
    const activeTab = existing.tabs.find(
      (tab) => tab.id === existing.activeTabId,
    );
    const tabs =
      target?.replaceActiveEmpty === true &&
      activeTab !== undefined &&
      activeTab.messages.length === 0
        ? existing.tabs.map((tab) => (tab.id === activeTab.id ? nextTab : tab))
        : [...existing.tabs, nextTab];
    mockChatStore.setState({
      worktreeChats: {
        ...worktreeChats,
        [key]: {
          tabs,
          activeTabId: id,
        },
      },
    });
  },
);
const createTabWithIdMock = jest.fn((id: string) => {
  const selection = mockChatStore.getState().selectedWorktree;
  if (!selection) {
    return;
  }

  const key = `${selection.projectId}/${selection.worktreeId}`;
  const worktreeChats = mockChatStore.getState().worktreeChats;
  const existing = worktreeChats[key] ?? { tabs: [], activeTabId: '' };
  mockChatStore.setState({
    worktreeChats: {
      ...worktreeChats,
      [key]: {
        tabs: [...existing.tabs, { id, title: 'New Chat', messages: [] }],
        activeTabId: id,
      },
    },
  });
});
const sendMessageMock = jest.fn().mockResolvedValue(undefined);
const switchTabMock = jest.fn((tabId: string) => {
  const selection = mockChatStore.getState().selectedWorktree;
  if (!selection) {
    return;
  }

  const key = `${selection.projectId}/${selection.worktreeId}`;
  const worktreeChats = mockChatStore.getState().worktreeChats;
  const worktreeChat = worktreeChats[key];
  if (!worktreeChat) {
    return;
  }

  mockChatStore.setState({
    worktreeChats: {
      ...worktreeChats,
      [key]: { ...worktreeChat, activeTabId: tabId },
    },
  });
});
const closeTabMock = jest.fn(
  (
    tabId: string,
    options?: { projectId: string; worktreeId: string; force?: boolean },
  ) => {
    const selection = options ?? mockChatStore.getState().selectedWorktree;
    if (!selection) {
      return;
    }

    const key = `${selection.projectId}/${selection.worktreeId}`;
    const worktreeChats = mockChatStore.getState().worktreeChats;
    const worktreeChat = worktreeChats[key];
    if (!worktreeChat) {
      return;
    }

    const tabs = worktreeChat.tabs.filter((tab) => tab.id !== tabId);
    mockChatStore.setState({
      worktreeChats: {
        ...worktreeChats,
        [key]: {
          tabs,
          activeTabId: tabs[0]?.id ?? '',
        },
      },
    });
  },
);
const setWorktreeDefaultPluginsMock = jest.fn();
const ensureModelDefaultsLoadedMock = jest.fn().mockResolvedValue(null);
const flushWorktreeTabsMock = jest.fn().mockResolvedValue(undefined);
const suppressWorktreePersistenceMock = jest.fn();
const resumeWorktreePersistenceMock = jest.fn();
const reloadWorktreeTabsMock = jest.fn().mockResolvedValue(undefined);
const cleanupWorktreeMock = jest.fn();
const setPluginSelectionsMock = jest.fn();
const setTabApprovalModeMock = jest.fn(() => Promise.resolve());
const setModelSelectionModeMock = jest.fn(() => Promise.resolve());
const syncActiveEmptyTabToDefaultsMock = jest.fn().mockResolvedValue(undefined);
const queueWorktreeTabDiscoveryRefreshMock = jest.fn();
const insertClonedStandaloneTabMock = jest.fn(
  (
    workspaceId: string,
    entryId: string,
    tab: MockTab,
    makeActive = true,
    replaceActiveEmpty = false,
  ): Promise<void> => {
    const key = `${workspaceId}/${entryId}`;
    const worktreeChats = mockChatStore.getState().worktreeChats;
    const existing = worktreeChats[key] ?? { tabs: [], activeTabId: '' };
    mockChatStore.setState({
      worktreeChats: {
        ...worktreeChats,
        [key]: {
          tabs:
            replaceActiveEmpty &&
            existing.tabs.find(
              (candidate) => candidate.id === existing.activeTabId,
            )?.messages.length === 0
              ? existing.tabs.map((candidate) =>
                  candidate.id === existing.activeTabId ? tab : candidate,
                )
              : [...existing.tabs, tab],
          activeTabId: makeActive ? tab.id : existing.activeTabId,
        },
      },
    });
    return Promise.resolve();
  },
);

function createMockChatStoreState(): MockChatStoreState {
  return {
    ensureWorktreeHasChatTab: jest.fn().mockResolvedValue(undefined),
    addPendingAttachments: jest.fn(),
    togglePlanMode: jest.fn(),
    setFastMode: jest.fn(),
    setModelSelectionMode: setModelSelectionModeMock,
    setScheduledSendDraft: jest.fn().mockResolvedValue(undefined),
    selectedWorktree: null,
    worktreeChats: {},
    worktreeDefaultPlugins: {},
    selectWorktree: selectWorktreeMock,
    deselectWorktree: deselectWorktreeMock,
    loadTabs: loadTabsMock,
    createTab: createTabMock,
    createTabWithId: createTabWithIdMock,
    sendMessage: sendMessageMock,
    switchTab: switchTabMock,
    closeTab: closeTabMock,
    setWorktreeDefaultPlugins: setWorktreeDefaultPluginsMock,
    ensureModelDefaultsLoaded: ensureModelDefaultsLoadedMock,
    flushWorktreeTabs: flushWorktreeTabsMock,
    suppressWorktreePersistence: suppressWorktreePersistenceMock,
    resumeWorktreePersistence: resumeWorktreePersistenceMock,
    reloadWorktreeTabs: reloadWorktreeTabsMock,
    cleanupWorktree: cleanupWorktreeMock,
    setPluginSelections: setPluginSelectionsMock,
    setTabApprovalMode: setTabApprovalModeMock,
    syncActiveEmptyTabToDefaults: syncActiveEmptyTabToDefaultsMock,
    queueWorktreeTabDiscoveryRefresh: queueWorktreeTabDiscoveryRefreshMock,
    insertClonedStandaloneTab: insertClonedStandaloneTabMock,
  };
}

const mockChatStore = create<MockChatStoreState>(() =>
  createMockChatStoreState(),
);

jest.mock('@/stores/chatStore', () => ({
  useChatStore: mockChatStore,
}));

const mockGetSidebarScopingContext = jest.fn<WorkspaceContext | undefined, []>(
  () => undefined,
);
jest.mock('@/components/sidebar/useSidebarScopingContext', () => ({
  getSidebarScopingContext: (): WorkspaceContext | undefined =>
    mockGetSidebarScopingContext(),
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
  standaloneChat: {
    init: jest.fn().mockResolvedValue(undefined),
    list: jest.fn().mockResolvedValue({ chats: [] }),
    readSummary: jest.fn().mockResolvedValue({ summary: 'test summary' }),
    readArchive: jest.fn().mockResolvedValue({
      summary: 'test summary',
      snapshot: null,
      legacySummaryOnly: true,
    }),
    resumeArchive: jest.fn(),
    loadWorkspace: jest.fn().mockResolvedValue({
      project: {
        version: 1,
        id: DEFAULT_COWORK_WORKSPACE_ID,
        name: 'Default',
        createdAt: '2024-01-01',
      },
      archives: [],
    }),
    exportProject: jest.fn(),
    importProject: jest.fn(),
    onMetaUpdated: jest.fn().mockReturnValue(jest.fn()),
  },
  workEntries: {
    list: jest.fn().mockResolvedValue({ entries: [] }),
    create: jest.fn().mockResolvedValue({
      entry: makeEntry('entry-created'),
      reusedExistingEmpty: false,
    }),
    update: jest.fn().mockResolvedValue(undefined),
    reorder: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    resolveChat: jest
      .fn()
      .mockResolvedValue({ entryId: null, archivedInEntryId: null }),
  },
  chatProject: {
    list: jest.fn().mockResolvedValue({
      projects: [
        {
          id: DEFAULT_COWORK_WORKSPACE_ID,
          name: 'Default',
          createdAt: '2024-01-01',
        },
      ],
    }),
    ensureOrgDefaultCoworkWorkspace: jest.fn().mockResolvedValue(undefined),
    getOrgDefaultCoworkEligibility: jest.fn().mockResolvedValue('eligible'),
    createOrgCowork: jest.fn(),
    create: jest.fn(),
    update: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    loadClaudeMd: jest.fn().mockResolvedValue(''),
    saveClaudeMd: jest.fn().mockResolvedValue(undefined),
  },
  chat: {
    saveTabs: jest.fn().mockResolvedValue(undefined),
    loadTabs: jest
      .fn()
      .mockResolvedValue({ version: 1, tabs: [], activeTabId: '' }),
    onChatEvent: jest.fn().mockReturnValue(jest.fn()),
    onMcpAskUser: jest.fn().mockReturnValue(jest.fn()),
    onPlanExitRequest: jest.fn().mockReturnValue(jest.fn()),
    onTabDescriptionUpdated: jest.fn().mockReturnValue(jest.fn()),
    changeModel: jest.fn().mockResolvedValue(true),
    updatePlugins: jest.fn(
      (request: {
        pluginSelections: ChatTabPluginSelections;
        disabledGlobalPluginSelections?: unknown;
      }) =>
        Promise.resolve({
          pluginSelections: request.pluginSelections,
          disabledGlobalPluginSelections:
            request.disabledGlobalPluginSelections,
        }),
    ),
  },
  loadPreferences: jest.fn().mockResolvedValue({
    defaultChatProvider: 'claude',
    defaultChatModelByProvider: {
      claude: {
        model: 'claude-sonnet-4-20250514',
        thinkingLevel: 'high',
      },
      codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
      ollama: null,
    },
    defaultWorktreeProvider: 'claude',
    defaultWorktreeModelByProvider: {
      claude: {
        model: 'claude-sonnet-4-20250514',
        thinkingLevel: 'high',
      },
      codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
      ollama: null,
    },
  }),
  savePreferences: jest.fn().mockResolvedValue(undefined),
};

Object.defineProperty(globalThis, 'window', {
  value: globalThis,
  writable: true,
});

Object.defineProperty(globalThis, 'requestAnimationFrame', {
  configurable: true,
  value: (callback: FrameRequestCallback): number => {
    callback(0);
    return 1;
  },
});

const dispatchEventMock = jest.fn(() => true);
Object.defineProperty(globalThis, 'dispatchEvent', {
  configurable: true,
  value: dispatchEventMock,
});

if (typeof globalThis.crypto?.randomUUID !== 'function') {
  let counter = 0;
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      randomUUID: (): string => `uuid-${++counter}`,
    },
    writable: true,
  });
}

Object.defineProperty(window, 'api', {
  value: mockApi,
  writable: true,
});

const standaloneChatStoreModulePromise = import('../standaloneChatStore');
const projectsStoreModulePromise = import('../projectsStore');

type StandaloneChatStoreModule = Awaited<
  typeof standaloneChatStoreModulePromise
>;

let useStandaloneChatStore: StandaloneChatStoreModule['useStandaloneChatStore'];
let useProjectsStore: Awaited<
  typeof projectsStoreModulePromise
>['useProjectsStore'];

function createStandaloneState(): Partial<
  ReturnType<typeof useStandaloneChatStore.getState>
> {
  return {
    scopedWorkspaceId: null,
    workEntries: [],
    chatProjects: [
      {
        id: DEFAULT_COWORK_WORKSPACE_ID,
        name: 'Default',
        createdAt: '2024-01-01',
      },
    ],
    activeWorkEntryId: null,
    activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
    initialized: false,
    chatProjectsLoaded: false,
    archiveOverlayChatId: null,
    activeSummary: null,
    activeArchiveData: null,
    sidebarEntriesByProject: {},
    legacyArchivedByProject: {},
  };
}

beforeAll(async () => {
  ({ useStandaloneChatStore } = await standaloneChatStoreModulePromise);
  ({ useProjectsStore } = await projectsStoreModulePromise);
});

beforeEach(() => {
  useArchivedContainersStore.setState({ pendingByWorkspace: {} });
  jest.clearAllMocks();
  mockChatStore.setState(createMockChatStoreState());
  useStandaloneChatStore.setState(createStandaloneState());
  useProjectsStore.setState({ projects: [] });

  mockApi.standaloneChat.list.mockResolvedValue({ chats: [] });
  mockApi.workEntries.list.mockResolvedValue({ entries: [] });
  mockApi.workEntries.create.mockResolvedValue({
    entry: makeEntry('entry-created'),
    reusedExistingEmpty: false,
  });
  mockApi.workEntries.resolveChat.mockResolvedValue({
    entryId: null,
    archivedInEntryId: null,
  });
  mockApi.chatProject.ensureOrgDefaultCoworkWorkspace.mockResolvedValue(
    undefined,
  );
  mockApi.chatProject.getOrgDefaultCoworkEligibility.mockResolvedValue(
    'eligible',
  );
  mockApi.standaloneChat.loadWorkspace.mockResolvedValue({
    project: {
      version: 1,
      id: DEFAULT_COWORK_WORKSPACE_ID,
      name: 'Default',
      createdAt: '2024-01-01',
    },
    archives: [],
  });
  mockApi.standaloneChat.resumeArchive.mockResolvedValue({
    tab: {
      id: 'resumed-1',
      title: 'Archived chat',
      description: 'Recovered thread',
      messages: [],
      createdAt: '2024-01-02T00:00:00.000Z',
      providerType: 'codex',
      planMode: false,
      proposalMode: 'optional',
      thinkingLevel: 'high',
    },
  });
});

describe('standaloneChatStore createOrgCoworkProject (CAN-3453)', () => {
  it('creates through main and reloads the project list on success', async () => {
    mockApi.chatProject.createOrgCowork.mockResolvedValueOnce({
      ok: true,
      organizationProjectId: 'project-1',
      localWorkspaceId: 'cowork-project-project-1',
      attachedGitRepository: false,
    });
    mockApi.chatProject.list.mockClear();
    const request = {
      organizationId: '11111111-1111-4111-8111-111111111111',
      name: 'Q4 research',
    };
    const result = await useStandaloneChatStore
      .getState()
      .createOrgCoworkProject(request);
    expect(mockApi.chatProject.createOrgCowork).toHaveBeenCalledWith(request);
    expect(result.ok).toBe(true);
    expect(mockApi.chatProject.list).toHaveBeenCalled();
  });

  it('returns the successful create result when the project-list refresh fails', async () => {
    const created = {
      ok: true as const,
      organizationProjectId: 'project-1',
      localWorkspaceId: 'cowork-project-project-1',
      attachedGitRepository: false,
    };
    mockApi.chatProject.createOrgCowork.mockResolvedValueOnce(created);
    mockApi.chatProject.list.mockRejectedValueOnce(new Error('Refresh failed'));

    await expect(
      useStandaloneChatStore.getState().createOrgCoworkProject({
        organizationId: '11111111-1111-4111-8111-111111111111',
        name: 'Q4 research',
      }),
    ).resolves.toEqual(created);
  });

  it('returns a failure without reloading the project list', async () => {
    mockApi.chatProject.createOrgCowork.mockResolvedValueOnce({
      ok: false,
      code: 'setup-failed',
      organizationProjectId: 'project-1',
      attachedGitRepository: false,
    });
    mockApi.chatProject.list.mockClear();
    const result = await useStandaloneChatStore
      .getState()
      .createOrgCoworkProject({
        organizationId: '11111111-1111-4111-8111-111111111111',
        name: 'Q4 research',
      });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, code: 'setup-failed' }),
    );
    expect(mockApi.chatProject.list).not.toHaveBeenCalled();
  });
});

describe('standaloneChatStore cowork project settings', () => {
  it('updates every saved field in the cached project used when settings reopen', async () => {
    const initialPluginSelections: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    const nextPluginSelections: ChatTabPluginSelections = {
      collectionIds: ['research'],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    useStandaloneChatStore.setState({
      scopedWorkspaceId: 'alpha',
      chatProjects: [
        {
          id: 'alpha',
          name: 'Alpha',
          createdAt: '2024-01-01',
          color: '#111111',
          description: 'Old description',
          defaultModel: 'old-model',
          defaultPresetId: 'old-preset',
          presets: [],
          defaultPluginSelections: initialPluginSelections,
          archiveRetentionDays: 7,
          autoArchiveDays: null,
          alwaysShow: true,
        },
      ],
    });

    const nextPresets = [
      {
        id: 'next-preset',
        name: 'Next preset',
        pluginSelections: nextPluginSelections,
      },
    ];
    await useStandaloneChatStore.getState().updateChatProject({
      projectId: 'alpha',
      name: 'Renamed Alpha',
      color: '#336699',
      description: 'Saved description',
      defaultModel: 'next-model',
      defaultPresetId: 'next-preset',
      presets: nextPresets,
      defaultPluginSelections: nextPluginSelections,
      archiveRetentionDays: 30,
      autoArchiveDays: 14,
      alwaysShow: false,
    });

    expect(mockApi.chatProject.update).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'alpha' }),
    );
    expect(useStandaloneChatStore.getState().chatProjects).toEqual([
      {
        id: 'alpha',
        name: 'Renamed Alpha',
        createdAt: '2024-01-01',
        color: '#336699',
        description: 'Saved description',
        defaultModel: 'next-model',
        defaultPresetId: 'next-preset',
        presets: nextPresets,
        defaultPluginSelections: nextPluginSelections,
        archiveRetentionDays: 30,
        autoArchiveDays: 14,
        alwaysShow: false,
      },
    ]);
  });
});

describe('standaloneChatStore cowork project plugin defaults', () => {
  it('keeps new defaults as a live layer instead of copying them into the empty chat', async () => {
    const previousDefaults: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    const nextDefaults: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: 'curated-slack', configId: 'default' }],
    };
    useStandaloneChatStore.setState({
      activeChatProjectId: 'alpha',
      activeWorkEntryId: 'entry-a',
      chatProjects: [
        {
          id: 'alpha',
          name: 'Alpha',
          createdAt: '2024-01-01',
          defaultPluginSelections: previousDefaults,
        },
      ],
    });
    mockChatStore.setState({
      selectedWorktree: { projectId: 'alpha', worktreeId: 'entry-a' },
      worktreeChats: {
        'alpha/entry-a': {
          activeTabId: 'chat',
          tabs: [{ id: 'chat', title: 'Chat', messages: [] }],
        },
      },
    });

    await useStandaloneChatStore.getState().updateChatProject({
      projectId: 'alpha',
      defaultPluginSelections: nextDefaults,
    });

    expect(setWorktreeDefaultPluginsMock).toHaveBeenCalledWith(
      'alpha',
      'entry-a',
      nextDefaults,
    );
    expect(setPluginSelectionsMock).not.toHaveBeenCalled();
    expect(queueWorktreeTabDiscoveryRefreshMock).toHaveBeenCalledWith(
      'alpha',
      'entry-a',
    );
  });
});

describe('standaloneChatStore work entries', () => {
  it('keeps the cowork sidebar work-entry count current for hidden-workspace visibility', async () => {
    useProjectsStore.setState({
      projects: [
        {
          id: DEFAULT_COWORK_WORKSPACE_ID,
          name: 'Default',
          type: 'cowork',
          color: '#123456',
          collapsed: false,
          order: 0,
          alwaysShow: false,
          workEntryCount: 1,
        },
      ],
    });
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      workEntries: [makeEntry('entry-a')],
    });
    mockApi.workEntries.list.mockResolvedValue({ entries: [] });

    await useStandaloneChatStore.getState().refreshWorkEntries();

    expect(useProjectsStore.getState().projects[0]).toMatchObject({
      workEntryCount: 0,
    });
  });

  it('keeps a saved layout customization visible in active and sidebar entries', () => {
    const entry = makeEntry('entry-a');
    useStandaloneChatStore.setState({
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      workEntries: [entry],
      sidebarEntriesByProject: { [DEFAULT_COWORK_WORKSPACE_ID]: [entry] },
    });

    useStandaloneChatStore
      .getState()
      .markWorkEntryCustomized(DEFAULT_COWORK_WORKSPACE_ID, entry.id);

    expect(
      useStandaloneChatStore.getState().workEntries[0].hasUserChanges,
    ).toBe(true);
    expect(
      useStandaloneChatStore.getState().sidebarEntriesByProject[
        DEFAULT_COWORK_WORKSPACE_ID
      ][0].hasUserChanges,
    ).toBe(true);
  });

  it('initialize auto-selects the most recent work entry', async () => {
    mockApi.workEntries.list.mockResolvedValue({
      entries: [
        makeEntry('entry-recent', {
          lastMessageAt: '2024-01-03T00:00:00.000Z',
        }),
        makeEntry('entry-older'),
      ],
    });

    await useStandaloneChatStore.getState().initialize();

    const state = useStandaloneChatStore.getState();
    expect(state.initialized).toBe(true);
    expect(state.activeWorkEntryId).toBe('entry-recent');
    expect(state.workEntries.map((entry) => entry.id)).toEqual([
      'entry-recent',
      'entry-older',
    ]);
    expect(selectWorktreeMock).toHaveBeenCalledWith(
      DEFAULT_COWORK_WORKSPACE_ID,
      'entry-recent',
    );
    expect(mockApi.workEntries.create).not.toHaveBeenCalled();
    expect(loadTabsMock.mock.invocationCallOrder[0]).toBeLessThan(
      syncActiveEmptyTabToDefaultsMock.mock.invocationCallOrder[0],
    );
  });

  it('initialize creates a work entry when none exist', async () => {
    useProjectsStore.setState({
      projects: [
        {
          id: DEFAULT_COWORK_WORKSPACE_ID,
          name: 'Default',
          type: 'cowork',
          color: '#123456',
          collapsed: false,
          order: 0,
          alwaysShow: false,
          workEntryCount: 0,
        },
      ],
    });
    mockApi.workEntries.list.mockResolvedValue({ entries: [] });
    mockApi.workEntries.create.mockResolvedValue({
      entry: makeEntry('entry-fresh'),
      reusedExistingEmpty: false,
    });

    await useStandaloneChatStore.getState().initialize();

    const state = useStandaloneChatStore.getState();
    expect(mockApi.workEntries.create).toHaveBeenCalledWith({
      projectId: DEFAULT_COWORK_WORKSPACE_ID,
    });
    expect(state.activeWorkEntryId).toBe('entry-fresh');
    expect(state.workEntries.map((entry) => entry.id)).toEqual(['entry-fresh']);
    expect(useProjectsStore.getState().projects[0]).toMatchObject({
      workEntryCount: 1,
    });
  });

  it('concurrent initialize calls share one run and honor the preferred entry', async () => {
    mockApi.workEntries.list.mockResolvedValue({
      entries: [
        makeEntry('entry-recent', {
          lastMessageAt: '2024-01-03T00:00:00.000Z',
        }),
        makeEntry('entry-older'),
      ],
    });

    // A sidebar click into an older entry racing the cowork page mount's own
    // initialize: both must share one run, and the explicit target must win
    // over the default most-recent pick (a duplicated run used to re-select
    // the most recent entry and clobber the click).
    const store = useStandaloneChatStore.getState();
    await Promise.all([
      store.initialize({
        projectId: DEFAULT_COWORK_WORKSPACE_ID,
        entryId: 'entry-older',
      }),
      store.initialize(),
    ]);

    const state = useStandaloneChatStore.getState();
    expect(state.initialized).toBe(true);
    expect(state.activeWorkEntryId).toBe('entry-older');
    expect(mockApi.workEntries.list).toHaveBeenCalledTimes(1);
    expect(selectWorktreeMock).toHaveBeenCalledTimes(1);
    expect(selectWorktreeMock).toHaveBeenCalledWith(
      DEFAULT_COWORK_WORKSPACE_ID,
      'entry-older',
    );
  });

  it('honors a preferred entry from a caller joining an unpreferred initialize', async () => {
    mockApi.workEntries.list.mockResolvedValue({
      entries: [
        makeEntry('entry-recent', {
          lastMessageAt: '2024-01-03T00:00:00.000Z',
        }),
        makeEntry('entry-older'),
      ],
    });
    let resolveProjects: (value: {
      projects: Array<{
        id: string;
        name: string;
        createdAt: string;
      }>;
    }) => void = () => {
      throw new Error('Project-list resolver was not initialized');
    };
    mockApi.chatProject.list.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveProjects = resolve;
      }),
    );

    const store = useStandaloneChatStore.getState();
    const pageInitialize = store.initialize();
    const sidebarInitialize = store.initialize({
      projectId: DEFAULT_COWORK_WORKSPACE_ID,
      entryId: 'entry-older',
    });
    resolveProjects({
      projects: [
        {
          id: DEFAULT_COWORK_WORKSPACE_ID,
          name: 'Default',
          createdAt: '2024-01-01',
        },
      ],
    });

    await Promise.all([pageInitialize, sidebarInitialize]);

    expect(selectWorktreeMock).toHaveBeenCalledTimes(1);
    expect(selectWorktreeMock).toHaveBeenCalledWith(
      DEFAULT_COWORK_WORKSPACE_ID,
      'entry-older',
    );
  });

  it('redirects initialization when a cross-workspace target arrives late', async () => {
    const otherProjectId = 'cowork-other';
    mockApi.chatProject.list.mockResolvedValueOnce({
      projects: [
        {
          id: DEFAULT_COWORK_WORKSPACE_ID,
          name: 'Default',
          createdAt: '2024-01-01',
        },
        {
          id: otherProjectId,
          name: 'Other',
          createdAt: '2024-01-02',
        },
      ],
    });
    mockApi.workEntries.list.mockImplementation(({ projectId }) =>
      Promise.resolve({
        entries:
          projectId === otherProjectId
            ? [makeEntry('entry-other')]
            : [makeEntry('entry-default')],
      }),
    );

    let resolveModelDefaults: (value: null) => void = () => {
      throw new Error('Model-default resolver was not initialized');
    };
    let notifyModelDefaultsStarted: () => void = () => {
      throw new Error('Model-default start notifier was not initialized');
    };
    const modelDefaultsStarted = new Promise<void>((resolve) => {
      notifyModelDefaultsStarted = resolve;
    });
    ensureModelDefaultsLoadedMock.mockReturnValueOnce(
      new Promise<null>((resolve) => {
        resolveModelDefaults = resolve;
        notifyModelDefaultsStarted();
      }),
    );

    const store = useStandaloneChatStore.getState();
    const pageInitialize = store.initialize();
    await modelDefaultsStarted;
    const sidebarInitialize = store.initialize({
      projectId: otherProjectId,
      entryId: 'entry-other',
    });
    resolveModelDefaults(null);

    await Promise.all([pageInitialize, sidebarInitialize]);

    expect(mockApi.standaloneChat.init).toHaveBeenCalledTimes(1);
    expect(mockApi.standaloneChat.init).toHaveBeenCalledWith(otherProjectId);
    expect(mockApi.workEntries.list).toHaveBeenCalledTimes(1);
    expect(mockApi.workEntries.list).toHaveBeenCalledWith({
      projectId: otherProjectId,
    });
    expect(selectWorktreeMock).toHaveBeenCalledTimes(1);
    expect(selectWorktreeMock).toHaveBeenCalledWith(
      otherProjectId,
      'entry-other',
    );
    expect(useStandaloneChatStore.getState()).toMatchObject({
      activeChatProjectId: otherProjectId,
      activeWorkEntryId: 'entry-other',
    });
  });

  it('cold initialization honors a preferred entry in another project', async () => {
    const otherProjectId = 'cowork-other';
    mockApi.chatProject.list.mockResolvedValueOnce({
      projects: [
        {
          id: DEFAULT_COWORK_WORKSPACE_ID,
          name: 'Default',
          createdAt: '2024-01-01',
        },
        {
          id: otherProjectId,
          name: 'Other',
          createdAt: '2024-01-02',
        },
      ],
    });
    mockApi.workEntries.list.mockImplementation(({ projectId }) =>
      Promise.resolve({
        entries:
          projectId === otherProjectId
            ? [makeEntry('entry-other')]
            : [makeEntry('entry-default')],
      }),
    );

    await useStandaloneChatStore.getState().initialize({
      projectId: otherProjectId,
      entryId: 'entry-other',
    });

    const state = useStandaloneChatStore.getState();
    expect(state.activeChatProjectId).toBe(otherProjectId);
    expect(state.activeWorkEntryId).toBe('entry-other');
    expect(mockApi.standaloneChat.init).toHaveBeenCalledTimes(1);
    expect(mockApi.standaloneChat.init).toHaveBeenCalledWith(otherProjectId);
    expect(mockApi.workEntries.list).toHaveBeenCalledTimes(1);
    expect(mockApi.workEntries.list).toHaveBeenCalledWith({
      projectId: otherProjectId,
    });
    expect(selectWorktreeMock).toHaveBeenCalledTimes(1);
    expect(selectWorktreeMock).toHaveBeenCalledWith(
      otherProjectId,
      'entry-other',
    );
  });

  it('cancels a pending openWorkEntryFromSidebar after initialization', async (): Promise<void> => {
    let finishInitialize: () => void = (): void => {
      throw new Error('Initialization did not start');
    };
    const pendingInitialize = new Promise<void>((resolve): void => {
      finishInitialize = resolve;
    });
    const store = useStandaloneChatStore.getState();
    const initialize = jest.fn(async (): Promise<void> => {
      await pendingInitialize;
    });
    const selectWorkEntry = jest.fn((entryId: string): Promise<void> => {
      useStandaloneChatStore.setState({ activeWorkEntryId: entryId });
      return Promise.resolve();
    });
    useStandaloneChatStore.setState({
      initialized: false,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: null,
      workEntries: [makeEntry('entry-pending')],
      initialize,
      selectWorkEntry,
    });
    try {
      const opening = store.openWorkEntryFromSidebar(
        DEFAULT_COWORK_WORKSPACE_ID,
        'entry-pending',
      );
      expect(initialize).toHaveBeenCalledTimes(1);
      store.cancelPendingWorkEntryNavigation();
      finishInitialize();
      await opening;

      expect(selectWorkEntry).not.toHaveBeenCalled();
      expect(useStandaloneChatStore.getState().activeWorkEntryId).toBeNull();
    } finally {
      useStandaloneChatStore.setState({
        initialize: store.initialize,
        selectWorkEntry: store.selectWorkEntry,
      });
    }
  });

  it('releases the target a cold initialization committed when the open was cancelled meanwhile', async (): Promise<void> => {
    const projectId = DEFAULT_COWORK_WORKSPACE_ID;
    const entryId = 'entry-pending';
    let finishInitialize: () => void = (): void => {
      throw new Error('Initialization did not start');
    };
    const pendingInitialize = new Promise<void>((resolve): void => {
      finishInitialize = resolve;
    });
    const store = useStandaloneChatStore.getState();
    const initialize = jest.fn(async (): Promise<void> => {
      await pendingInitialize;
      useStandaloneChatStore.setState({
        initialized: true,
        activeChatProjectId: projectId,
        activeWorkEntryId: entryId,
      });
      mockChatStore.setState({
        selectedWorktree: { projectId, worktreeId: entryId },
      });
    });
    const selectWorkEntry = jest.fn((): Promise<void> => Promise.resolve());
    useStandaloneChatStore.setState({
      initialized: false,
      activeWorkEntryId: null,
      workEntries: [makeEntry(entryId)],
      initialize,
      selectWorkEntry,
    });
    try {
      const opening = store.openWorkEntryFromSidebar(projectId, entryId);
      expect(initialize).toHaveBeenCalledWith({ projectId, entryId });
      store.cancelPendingWorkEntryNavigation();
      finishInitialize();
      await opening;

      expect(useStandaloneChatStore.getState().activeWorkEntryId).toBeNull();
      expect(mockChatStore.getState().selectedWorktree).toBeNull();
      expect(selectWorkEntry).not.toHaveBeenCalled();
    } finally {
      useStandaloneChatStore.setState({
        initialize: store.initialize,
        selectWorkEntry: store.selectWorkEntry,
      });
    }
  });

  it('openWorkEntryFromSidebar cold-open never selects the default entry', async () => {
    mockApi.workEntries.list.mockResolvedValue({
      entries: [
        makeEntry('entry-recent', {
          lastMessageAt: '2024-01-03T00:00:00.000Z',
        }),
        makeEntry('entry-older'),
      ],
    });

    const store = useStandaloneChatStore.getState();
    await Promise.all([
      store.openWorkEntryFromSidebar(
        DEFAULT_COWORK_WORKSPACE_ID,
        'entry-older',
      ),
      // The page mount effect fires initialize concurrently.
      store.initialize(),
    ]);

    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe(
      'entry-older',
    );
    expect(mockChatStore.getState().selectedWorktree).toEqual({
      projectId: DEFAULT_COWORK_WORKSPACE_ID,
      worktreeId: 'entry-older',
    });
    // The most recent entry must never have been (even transiently)
    // selected into the chat store.
    expect(selectWorktreeMock).not.toHaveBeenCalledWith(
      DEFAULT_COWORK_WORKSPACE_ID,
      'entry-recent',
    );
  });

  it('refreshes the active entry list before opening a newly restored entry', async () => {
    const restoredEntry = makeEntry('entry-restored');
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: null,
      workEntries: [],
    });
    mockApi.workEntries.list.mockResolvedValue({ entries: [restoredEntry] });

    await useStandaloneChatStore
      .getState()
      .openWorkEntryFromSidebar(DEFAULT_COWORK_WORKSPACE_ID, restoredEntry.id);

    expect(mockApi.workEntries.list).toHaveBeenCalledWith({
      projectId: DEFAULT_COWORK_WORKSPACE_ID,
    });
    expect(useStandaloneChatStore.getState().workEntries).toEqual([
      restoredEntry,
    ]);
    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe(
      restoredEntry.id,
    );
  });

  it('does not select a restored entry after the active project changes during refresh', async () => {
    const restoredEntry = makeEntry('entry-restored');
    const otherProjectId = 'cowork-other';
    const otherEntry = makeEntry('entry-other');
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: null,
      workEntries: [],
    });

    let resolveList: (value: {
      entries: CoworkWorkEntryMeta[];
    }) => void = () => {
      throw new Error('Work-entry list resolver was not initialized');
    };
    let notifyListStarted: () => void = () => {
      throw new Error('Work-entry list start notifier was not initialized');
    };
    const listStarted = new Promise<void>((resolve) => {
      notifyListStarted = resolve;
    });
    mockApi.workEntries.list.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveList = resolve;
        notifyListStarted();
      }),
    );

    const openPromise = useStandaloneChatStore
      .getState()
      .openWorkEntryFromSidebar(DEFAULT_COWORK_WORKSPACE_ID, restoredEntry.id);
    await listStarted;
    useStandaloneChatStore.setState({
      activeChatProjectId: otherProjectId,
      activeWorkEntryId: otherEntry.id,
      workEntries: [otherEntry],
    });
    resolveList({ entries: [restoredEntry] });
    await openPromise;

    expect(useStandaloneChatStore.getState()).toMatchObject({
      activeChatProjectId: otherProjectId,
      activeWorkEntryId: otherEntry.id,
      workEntries: [otherEntry],
    });
    expect(selectWorktreeMock).not.toHaveBeenCalledWith(
      otherProjectId,
      restoredEntry.id,
      { deferTabLoad: true },
    );
  });

  it('does not select a restored entry after switching away and back during refresh', async () => {
    const restoredEntry = makeEntry('entry-restored');
    const defaultEntry = makeEntry('entry-default');
    const otherEntry = makeEntry('entry-other');
    useStandaloneChatStore.setState({
      initialized: true,
      chatProjects: [
        {
          id: DEFAULT_COWORK_WORKSPACE_ID,
          name: 'Default',
          createdAt: '2024-01-01',
        },
        { id: 'other', name: 'Other', createdAt: '2024-01-01' },
      ],
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: null,
      workEntries: [],
    });

    let resolveRefresh: (value: {
      entries: CoworkWorkEntryMeta[];
    }) => void = () => {
      throw new Error('Work-entry refresh resolver was not initialized');
    };
    let notifyRefreshStarted: () => void = () => {
      throw new Error('Work-entry refresh start notifier was not initialized');
    };
    const refreshStarted = new Promise<void>((resolve) => {
      notifyRefreshStarted = resolve;
    });
    let defaultListCalls = 0;
    mockApi.workEntries.list.mockImplementation(
      ({ projectId }: { projectId: string }) => {
        if (projectId === DEFAULT_COWORK_WORKSPACE_ID) {
          defaultListCalls += 1;
          if (defaultListCalls === 1) {
            return new Promise((resolve) => {
              resolveRefresh = resolve;
              notifyRefreshStarted();
            });
          }
          return Promise.resolve({ entries: [defaultEntry] });
        }
        return Promise.resolve({ entries: [otherEntry] });
      },
    );

    const openPromise = useStandaloneChatStore
      .getState()
      .openWorkEntryFromSidebar(DEFAULT_COWORK_WORKSPACE_ID, restoredEntry.id);
    await refreshStarted;
    await useStandaloneChatStore.getState().switchChatProject('other');
    await useStandaloneChatStore
      .getState()
      .switchChatProject(DEFAULT_COWORK_WORKSPACE_ID);
    resolveRefresh({ entries: [restoredEntry] });
    await openPromise;

    expect(useStandaloneChatStore.getState()).toMatchObject({
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: defaultEntry.id,
      workEntries: [defaultEntry],
    });
    expect(selectWorktreeMock).not.toHaveBeenCalledWith(
      DEFAULT_COWORK_WORKSPACE_ID,
      restoredEntry.id,
      { deferTabLoad: true },
    );
  });

  it('does not select a restored entry after a newer same-workspace entry selection', async () => {
    const restoredEntry = makeEntry('entry-restored');
    const newerEntry = makeEntry('entry-newer');
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: null,
      workEntries: [newerEntry],
    });

    let resolveRefresh: (value: {
      entries: CoworkWorkEntryMeta[];
    }) => void = () => {
      throw new Error('Work-entry refresh resolver was not initialized');
    };
    let notifyRefreshStarted: () => void = () => {
      throw new Error('Work-entry refresh start notifier was not initialized');
    };
    const refreshStarted = new Promise<void>((resolve) => {
      notifyRefreshStarted = resolve;
    });
    mockApi.workEntries.list.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRefresh = resolve;
        notifyRefreshStarted();
      }),
    );

    const staleOpen = useStandaloneChatStore
      .getState()
      .openWorkEntryFromSidebar(DEFAULT_COWORK_WORKSPACE_ID, restoredEntry.id);
    await refreshStarted;
    await useStandaloneChatStore.getState().selectWorkEntry(newerEntry.id);
    resolveRefresh({ entries: [restoredEntry, newerEntry] });
    await staleOpen;

    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe(
      newerEntry.id,
    );
    expect(mockChatStore.getState().selectedWorktree).toEqual({
      projectId: DEFAULT_COWORK_WORKSPACE_ID,
      worktreeId: newerEntry.id,
    });
  });

  it('does not select a restored entry after a newer same-workspace archive selection', async () => {
    const restoredEntry = makeEntry('entry-restored');
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: null,
      workEntries: [],
    });

    let resolveRefresh: (value: {
      entries: CoworkWorkEntryMeta[];
    }) => void = () => {
      throw new Error('Work-entry refresh resolver was not initialized');
    };
    let notifyRefreshStarted: () => void = () => {
      throw new Error('Work-entry refresh start notifier was not initialized');
    };
    const refreshStarted = new Promise<void>((resolve) => {
      notifyRefreshStarted = resolve;
    });
    mockApi.workEntries.list.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRefresh = resolve;
        notifyRefreshStarted();
      }),
    );

    const staleOpen = useStandaloneChatStore
      .getState()
      .openWorkEntryFromSidebar(DEFAULT_COWORK_WORKSPACE_ID, restoredEntry.id);
    await refreshStarted;
    await useStandaloneChatStore
      .getState()
      .openArchivedChatFromSidebar(
        DEFAULT_COWORK_WORKSPACE_ID,
        'archived-chat',
      );
    resolveRefresh({ entries: [restoredEntry] });
    await staleOpen;

    expect(useStandaloneChatStore.getState()).toMatchObject({
      activeWorkEntryId: null,
      archiveOverlayChatId: 'archived-chat',
    });
    expect(mockChatStore.getState().selectedWorktree).toBeNull();
  });

  it('createWorkEntry selects the reused empty entry from the create IPC', async () => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: 'entry-a',
      workEntries: [makeEntry('entry-a')],
    });
    mockApi.workEntries.create.mockResolvedValue({
      entry: makeEntry('entry-empty'),
      reusedExistingEmpty: true,
    });
    mockApi.workEntries.list.mockResolvedValue({
      entries: [makeEntry('entry-empty'), makeEntry('entry-a')],
    });

    await useStandaloneChatStore.getState().createWorkEntry();

    const state = useStandaloneChatStore.getState();
    expect(state.activeWorkEntryId).toBe('entry-empty');
    expect(selectWorktreeMock).toHaveBeenCalledWith(
      DEFAULT_COWORK_WORKSPACE_ID,
      'entry-empty',
      { deferTabLoad: true },
    );
    expect(state.workEntries.map((entry) => entry.id)).toEqual([
      'entry-empty',
      'entry-a',
    ]);
  });

  it('creates in the requested group and confirms membership before publishing rows', async () => {
    const { useSidebarItemGroupsStore } =
      await import('../sidebarItemGroupsStore');
    const scope = { workspaceLocalId: DEFAULT_COWORK_WORKSPACE_ID };
    useSidebarItemGroupsStore.setState({
      byScope: {
        [`workspace:${DEFAULT_COWORK_WORKSPACE_ID}`]: [
          {
            id: 'grp-notes',
            name: 'Notes',
            color: 'neutral',
            collapsed: true,
            memberIds: ['entry-a'],
          },
        ],
      },
    });
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      workEntries: [makeEntry('entry-a')],
    });
    mockApi.workEntries.create.mockResolvedValue({
      entry: makeEntry('entry-new'),
      reusedExistingEmpty: false,
    });
    mockApi.workEntries.list.mockImplementation(() => {
      expect(
        useSidebarItemGroupsStore.getState().byScope[
          `workspace:${scope.workspaceLocalId}`
        ][0].memberIds,
      ).toContain('entry-new');
      return Promise.resolve({
        entries: [makeEntry('entry-new'), makeEntry('entry-a')],
      });
    });
    await useStandaloneChatStore
      .getState()
      .createWorkEntry({ sidebarItemGroupId: 'grp-notes' });
    expect(mockApi.workEntries.create).toHaveBeenCalledWith({
      projectId: DEFAULT_COWORK_WORKSPACE_ID,
      sidebarItemGroupId: 'grp-notes',
    });
    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe(
      'entry-new',
    );
  });

  it('deleteWorkEntry reselects the next most-recent entry', async () => {
    const loadArchivedContainers = jest
      .spyOn(useArchivedContainersStore.getState(), 'loadForWorkspace')
      .mockResolvedValue();
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: 'entry-a',
      workEntries: [makeEntry('entry-a'), makeEntry('entry-b')],
    });
    mockApi.workEntries.list.mockResolvedValue({
      entries: [makeEntry('entry-b')],
    });
    mockApi.workEntries.delete.mockResolvedValueOnce({
      browserCleanupPending: true,
    });

    await useStandaloneChatStore.getState().deleteWorkEntry('entry-a');

    expect(mockProfileCleanupToast).toHaveBeenCalledWith(
      'Browser profile retired; physical storage cleanup is pending.',
      'info',
      undefined,
      expect.objectContaining({ title: 'Browser cleanup', forceInApp: true }),
    );

    expect(flushWorktreeTabsMock).toHaveBeenCalledWith(
      DEFAULT_COWORK_WORKSPACE_ID,
      'entry-a',
    );
    expect(mockApi.workEntries.delete).toHaveBeenCalledWith({
      projectId: DEFAULT_COWORK_WORKSPACE_ID,
      entryId: 'entry-a',
    });
    expect(suppressWorktreePersistenceMock).toHaveBeenCalledWith(
      DEFAULT_COWORK_WORKSPACE_ID,
      'entry-a',
    );
    expect(flushWorktreeTabsMock.mock.invocationCallOrder[0]).toBeLessThan(
      suppressWorktreePersistenceMock.mock.invocationCallOrder[0],
    );
    expect(
      suppressWorktreePersistenceMock.mock.invocationCallOrder[0],
    ).toBeLessThan(mockApi.workEntries.delete.mock.invocationCallOrder[0]);
    expect(cleanupWorktreeMock).toHaveBeenCalledWith(
      DEFAULT_COWORK_WORKSPACE_ID,
      'entry-a',
    );
    expect(loadArchivedContainers).toHaveBeenCalledWith(
      DEFAULT_COWORK_WORKSPACE_ID,
      { trailing: true },
    );
    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe('entry-b');
    // The removal is announced to the "Archived and deleted" surfaces before
    // main is asked to capture it, so the list and counters react at once.
    expect(
      useArchivedContainersStore.getState().pendingByWorkspace[
        DEFAULT_COWORK_WORKSPACE_ID
      ],
    ).toEqual([
      expect.objectContaining({
        containerId: 'entry-a',
        kind: 'work-entry',
        name: 'Entry entry-a',
        state: 'deleted',
      }),
    ]);
    loadArchivedContainers.mockRestore();
  });

  it('deleteWorkEntry with lockAfterArchive announces an Archived placeholder', async () => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: 'entry-a',
      workEntries: [makeEntry('entry-a'), makeEntry('entry-b')],
    });
    mockApi.workEntries.list.mockResolvedValue({
      entries: [makeEntry('entry-b')],
    });

    await useStandaloneChatStore
      .getState()
      .deleteWorkEntry('entry-a', undefined, { lockAfterArchive: true });

    expect(mockApi.workEntries.delete).toHaveBeenCalledWith({
      projectId: DEFAULT_COWORK_WORKSPACE_ID,
      entryId: 'entry-a',
      lockAfterArchive: true,
    });
    expect(
      useArchivedContainersStore.getState().pendingByWorkspace[
        DEFAULT_COWORK_WORKSPACE_ID
      ]?.[0],
    ).toMatchObject({ containerId: 'entry-a', state: 'archived' });
  });

  it('deleteWorkEntry creates a fresh entry when none remain', async () => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: 'entry-a',
      workEntries: [makeEntry('entry-a')],
    });
    mockApi.workEntries.list.mockResolvedValue({ entries: [] });
    mockApi.workEntries.create.mockResolvedValue({
      entry: makeEntry('entry-replacement'),
      reusedExistingEmpty: false,
    });

    await useStandaloneChatStore.getState().deleteWorkEntry('entry-a');

    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe(
      'entry-replacement',
    );
  });

  it('reconciles an automatically deleted selected Work Entry', async () => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: 'entry-a',
      workEntries: [makeEntry('entry-a'), makeEntry('entry-b')],
    });
    mockChatStore.setState({
      selectedWorktree: {
        projectId: DEFAULT_COWORK_WORKSPACE_ID,
        worktreeId: 'entry-a',
      },
    });
    mockApi.workEntries.list.mockResolvedValue({
      entries: [makeEntry('entry-b')],
    });

    await useStandaloneChatStore
      .getState()
      .reconcileArchivedWorkEntry(DEFAULT_COWORK_WORKSPACE_ID, 'entry-a');

    expect(suppressWorktreePersistenceMock).toHaveBeenCalledWith(
      DEFAULT_COWORK_WORKSPACE_ID,
      'entry-a',
    );
    expect(cleanupWorktreeMock).toHaveBeenCalledWith(
      DEFAULT_COWORK_WORKSPACE_ID,
      'entry-a',
    );
    expect(deselectWorktreeMock).toHaveBeenCalled();
    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe('entry-b');
    expect(mockApi.workEntries.delete).not.toHaveBeenCalled();
  });

  it('resumes work-entry persistence when deletion fails', async () => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: 'entry-a',
      workEntries: [makeEntry('entry-a')],
    });
    mockApi.workEntries.delete.mockRejectedValueOnce(
      new Error('delete failed'),
    );

    await expect(
      useStandaloneChatStore.getState().deleteWorkEntry('entry-a'),
    ).rejects.toThrow('delete failed');

    expect(suppressWorktreePersistenceMock).toHaveBeenCalledWith(
      DEFAULT_COWORK_WORKSPACE_ID,
      'entry-a',
    );
    expect(resumeWorktreePersistenceMock).toHaveBeenCalledWith(
      DEFAULT_COWORK_WORKSPACE_ID,
      'entry-a',
    );
    expect(cleanupWorktreeMock).not.toHaveBeenCalled();
    // A failed removal must not leave a phantom placeholder behind.
    expect(
      useArchivedContainersStore.getState().pendingByWorkspace[
        DEFAULT_COWORK_WORKSPACE_ID
      ],
    ).toBeUndefined();
  });

  it('clears the pending archive placeholder when the pre-delete flush fails', async () => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: 'entry-a',
      workEntries: [makeEntry('entry-a')],
    });
    flushWorktreeTabsMock.mockRejectedValueOnce(new Error('flush failed'));

    await expect(
      useStandaloneChatStore.getState().deleteWorkEntry('entry-a'),
    ).rejects.toThrow('flush failed');

    expect(mockApi.workEntries.delete).not.toHaveBeenCalled();
    expect(suppressWorktreePersistenceMock).not.toHaveBeenCalled();
    expect(resumeWorktreePersistenceMock).not.toHaveBeenCalled();
    expect(
      useArchivedContainersStore.getState().pendingByWorkspace[
        DEFAULT_COWORK_WORKSPACE_ID
      ],
    ).toBeUndefined();
  });

  it('renameWorkEntry updates the entry and refreshes the list', async () => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      workEntries: [makeEntry('entry-a')],
    });
    mockApi.workEntries.list.mockResolvedValue({
      entries: [makeEntry('entry-a', { title: 'Renamed' })],
    });

    await useStandaloneChatStore
      .getState()
      .renameWorkEntry('entry-a', 'Renamed');

    expect(mockApi.workEntries.update).toHaveBeenCalledWith({
      projectId: DEFAULT_COWORK_WORKSPACE_ID,
      entryId: 'entry-a',
      title: 'Renamed',
    });
    expect(useStandaloneChatStore.getState().workEntries[0]?.title).toBe(
      'Renamed',
    );
  });

  it('renameWorkEntry awaits a trailing refresh after an older read', async () => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      workEntries: [makeEntry('entry-a')],
    });
    const resolvers: Array<
      (value: { entries: ReturnType<typeof makeEntry>[] }) => void
    > = [];
    mockApi.workEntries.list.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const olderRefresh = useStandaloneChatStore
      .getState()
      .refreshWorkEntries(DEFAULT_COWORK_WORKSPACE_ID);
    const rename = useStandaloneChatStore
      .getState()
      .renameWorkEntry('entry-a', 'Renamed');
    await Promise.resolve();
    expect(mockApi.workEntries.list).toHaveBeenCalledTimes(1);

    resolvers[0]?.({ entries: [makeEntry('entry-a')] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockApi.workEntries.list).toHaveBeenCalledTimes(2);
    resolvers[1]?.({
      entries: [makeEntry('entry-a', { title: 'Renamed' })],
    });
    await Promise.all([olderRefresh, rename]);

    expect(useStandaloneChatStore.getState().workEntries[0]?.title).toBe(
      'Renamed',
    );
  });

  it('setWorkEntryStatus sends a status-only update and refreshes the list', async () => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      workEntries: [makeEntry('entry-a')],
    });
    mockApi.workEntries.list.mockResolvedValue({
      entries: [makeEntry('entry-a', { status: 'done' })],
    });

    await useStandaloneChatStore
      .getState()
      .setWorkEntryStatus('entry-a', 'done');

    // No `title` key at all: a status-only update must not clear the rename
    // override (main-side treats `title: null` as "clear").
    expect(mockApi.workEntries.update).toHaveBeenCalledWith({
      projectId: DEFAULT_COWORK_WORKSPACE_ID,
      entryId: 'entry-a',
      status: 'done',
    });
    expect(useStandaloneChatStore.getState().workEntries[0]?.status).toBe(
      'done',
    );
  });

  it('setWorkEntryPinned sends a pinned-only update and refreshes the list', async () => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      workEntries: [makeEntry('entry-a')],
    });
    mockApi.workEntries.list.mockResolvedValue({
      entries: [makeEntry('entry-a', { pinned: true })],
    });

    await useStandaloneChatStore.getState().setWorkEntryPinned('entry-a', true);

    expect(mockApi.workEntries.update).toHaveBeenCalledWith({
      projectId: DEFAULT_COWORK_WORKSPACE_ID,
      entryId: 'entry-a',
      pinned: true,
    });
    expect(useStandaloneChatStore.getState().workEntries[0]?.pinned).toBe(true);
  });

  it('optimistically reorders work entries and persists their ids', async () => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      workEntries: [
        makeEntry('entry-a'),
        makeEntry('entry-b'),
        makeEntry('entry-c'),
      ],
    });

    await useStandaloneChatStore
      .getState()
      .reorderWorkEntries(DEFAULT_COWORK_WORKSPACE_ID, 'entry-c', 'entry-a');

    expect(
      useStandaloneChatStore.getState().workEntries.map((entry) => entry.id),
    ).toEqual(['entry-c', 'entry-a', 'entry-b']);
    expect(mockApi.workEntries.reorder).toHaveBeenCalledWith({
      projectId: DEFAULT_COWORK_WORKSPACE_ID,
      entryIds: ['entry-c', 'entry-a', 'entry-b'],
    });
  });

  it('selectChat resolves the owning work entry and switches to the tab', async () => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: 'entry-a',
      workEntries: [makeEntry('entry-a'), makeEntry('entry-b')],
    });
    mockApi.workEntries.resolveChat.mockResolvedValue({
      entryId: 'entry-b',
      archivedInEntryId: null,
    });
    mockChatStore.setState({
      worktreeChats: {
        [`${DEFAULT_COWORK_WORKSPACE_ID}/entry-b`]: {
          tabs: [{ id: 'chat-9', title: 'Chat 9', messages: [] }],
          activeTabId: 'chat-9',
        },
      },
    });

    await useStandaloneChatStore.getState().selectChat('chat-9');

    expect(mockApi.workEntries.resolveChat).toHaveBeenCalledWith({
      projectId: DEFAULT_COWORK_WORKSPACE_ID,
      chatId: 'chat-9',
    });
    expect(selectWorktreeMock).toHaveBeenCalledWith(
      DEFAULT_COWORK_WORKSPACE_ID,
      'entry-b',
      { deferTabLoad: true },
    );
    expect(switchTabMock).toHaveBeenCalledWith('chat-9');
    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe('entry-b');
  });

  it('keeps a newer chat selection when an older lookup resolves last', async () => {
    const resolutions = new Map<
      string,
      (value: {
        entryId: string | null;
        archivedInEntryId: string | null;
      }) => void
    >();
    mockApi.workEntries.resolveChat.mockImplementation(
      ({ chatId }: { chatId: string }) =>
        new Promise((resolve) => {
          resolutions.set(chatId, resolve);
        }),
    );
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: 'entry-a',
      workEntries: [
        makeEntry('entry-a'),
        makeEntry('entry-b'),
        makeEntry('entry-c'),
      ],
    });

    const olderSelection = useStandaloneChatStore
      .getState()
      .selectChat('chat-old');
    const newerSelection = useStandaloneChatStore
      .getState()
      .selectChat('chat-new');

    resolutions.get('chat-new')?.({
      entryId: 'entry-b',
      archivedInEntryId: null,
    });
    await newerSelection;
    resolutions.get('chat-old')?.({
      entryId: 'entry-c',
      archivedInEntryId: null,
    });
    await olderSelection;

    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe('entry-b');
    expect(switchTabMock).toHaveBeenCalledTimes(1);
    expect(switchTabMock).toHaveBeenCalledWith('chat-new');
  });

  it('abandons an archived chat lookup after the active project changes', async () => {
    let resolveLookup:
      | ((value: {
          entryId: string | null;
          archivedInEntryId: string | null;
        }) => void)
      | undefined;
    mockApi.workEntries.resolveChat.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        }),
    );
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: 'entry-a',
      workEntries: [makeEntry('entry-a'), makeEntry('entry-b')],
    });

    const staleSelection = useStandaloneChatStore
      .getState()
      .selectChat('archived-chat');
    useStandaloneChatStore.setState({
      activeChatProjectId: 'new-workspace',
      activeWorkEntryId: 'new-entry',
      workEntries: [makeEntry('new-entry')],
    });
    resolveLookup?.({
      entryId: null,
      archivedInEntryId: 'entry-b',
    });
    await staleSelection;

    expect(selectWorktreeMock).not.toHaveBeenCalled();
    expect(dispatchEventMock).not.toHaveBeenCalled();
    expect(useStandaloneChatStore.getState()).toMatchObject({
      activeChatProjectId: 'new-workspace',
      activeWorkEntryId: 'new-entry',
    });
  });

  it('stops selectChat when its Work Entry selection is superseded', async () => {
    let resolveLoad: (() => void) | undefined;
    loadTabsMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: 'entry-a',
      workEntries: [makeEntry('entry-a'), makeEntry('entry-b')],
    });
    mockChatStore.setState({
      selectedWorktree: {
        projectId: DEFAULT_COWORK_WORKSPACE_ID,
        worktreeId: 'entry-a',
      },
    });
    mockApi.workEntries.resolveChat.mockResolvedValue({
      entryId: 'entry-b',
      archivedInEntryId: null,
    });

    const staleChatSelection = useStandaloneChatStore
      .getState()
      .selectChat('chat-9');
    await Promise.resolve();
    expect(loadTabsMock).toHaveBeenCalledTimes(1);
    await useStandaloneChatStore.getState().selectArchivedChat('newer-chat');
    resolveLoad?.();
    await staleChatSelection;

    expect(switchTabMock).not.toHaveBeenCalled();
    expect(useStandaloneChatStore.getState()).toMatchObject({
      activeWorkEntryId: 'entry-a',
      archiveOverlayChatId: 'newer-chat',
    });
  });

  it('discards a stale Work Entry selection that completes after a newer selection', async () => {
    let resolveFirstLoad: (() => void) | undefined;
    const firstLoad = new Promise<void>((resolve) => {
      resolveFirstLoad = resolve;
    });
    loadTabsMock
      .mockImplementationOnce(() => firstLoad)
      .mockResolvedValueOnce(undefined);
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: 'entry-a',
      workEntries: [makeEntry('entry-a'), makeEntry('entry-b')],
    });
    mockChatStore.setState({
      selectedWorktree: {
        projectId: DEFAULT_COWORK_WORKSPACE_ID,
        worktreeId: 'entry-a',
      },
    });

    const staleSelection = useStandaloneChatStore
      .getState()
      .selectWorkEntry('entry-b');
    const latestSelection = useStandaloneChatStore
      .getState()
      .selectWorkEntry('entry-a');
    await latestSelection;
    resolveFirstLoad?.();
    await staleSelection;

    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe('entry-a');
    expect(mockChatStore.getState().selectedWorktree).toEqual({
      projectId: DEFAULT_COWORK_WORKSPACE_ID,
      worktreeId: 'entry-a',
    });
    expect(mockApi.savePreferences).toHaveBeenLastCalledWith({
      lastActiveContext: {
        kind: 'cowork',
        workspaceId: DEFAULT_COWORK_WORKSPACE_ID,
        workEntryId: 'entry-a',
      },
    });
  });

  it('does not roll back a newer selection of the same Work Entry', async () => {
    let resolveFirstLoad: (() => void) | undefined;
    const firstLoad = new Promise<void>((resolve) => {
      resolveFirstLoad = resolve;
    });
    loadTabsMock
      .mockImplementationOnce(() => firstLoad)
      .mockResolvedValueOnce(undefined);
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: 'entry-a',
      workEntries: [makeEntry('entry-a'), makeEntry('entry-b')],
    });
    mockChatStore.setState({
      selectedWorktree: {
        projectId: DEFAULT_COWORK_WORKSPACE_ID,
        worktreeId: 'entry-a',
      },
    });

    const staleSelection = useStandaloneChatStore
      .getState()
      .selectWorkEntry('entry-b');
    const latestSelection = useStandaloneChatStore
      .getState()
      .selectWorkEntry('entry-b');
    await latestSelection;
    resolveFirstLoad?.();
    await staleSelection;

    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe('entry-b');
    expect(mockChatStore.getState().selectedWorktree).toEqual({
      projectId: DEFAULT_COWORK_WORKSPACE_ID,
      worktreeId: 'entry-b',
    });
    expect(mockApi.savePreferences).toHaveBeenLastCalledWith({
      lastActiveContext: {
        kind: 'cowork',
        workspaceId: DEFAULT_COWORK_WORKSPACE_ID,
        workEntryId: 'entry-b',
      },
    });
  });

  it('does not let a stale same-entry selection roll back before the newer selection finishes', async () => {
    let resolveFirstLoad: (() => void) | undefined;
    let resolveSecondLoad: (() => void) | undefined;
    loadTabsMock
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirstLoad = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSecondLoad = resolve;
          }),
      );
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: 'entry-a',
      workEntries: [makeEntry('entry-a'), makeEntry('entry-b')],
    });
    mockChatStore.setState({
      selectedWorktree: {
        projectId: DEFAULT_COWORK_WORKSPACE_ID,
        worktreeId: 'entry-a',
      },
    });

    const staleSelection = useStandaloneChatStore
      .getState()
      .selectWorkEntry('entry-b');
    const latestSelection = useStandaloneChatStore
      .getState()
      .selectWorkEntry('entry-b');
    resolveFirstLoad?.();
    await staleSelection;
    resolveSecondLoad?.();
    await latestSelection;

    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe('entry-b');
    expect(mockChatStore.getState().selectedWorktree).toEqual({
      projectId: DEFAULT_COWORK_WORKSPACE_ID,
      worktreeId: 'entry-b',
    });
    expect(mockApi.savePreferences).toHaveBeenLastCalledWith({
      lastActiveContext: {
        kind: 'cowork',
        workspaceId: DEFAULT_COWORK_WORKSPACE_ID,
        workEntryId: 'entry-b',
      },
    });
  });

  it('preserves a newer archive selection while a Work Entry selection loads tabs', async () => {
    let resolveLoad: (() => void) | undefined;
    loadTabsMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: 'entry-a',
      workEntries: [makeEntry('entry-a'), makeEntry('entry-b')],
    });
    mockChatStore.setState({
      selectedWorktree: {
        projectId: DEFAULT_COWORK_WORKSPACE_ID,
        worktreeId: 'entry-a',
      },
    });

    const staleSelection = useStandaloneChatStore
      .getState()
      .selectWorkEntry('entry-b');
    await useStandaloneChatStore.getState().selectArchivedChat('archived-chat');
    resolveLoad?.();
    await staleSelection;

    expect(useStandaloneChatStore.getState()).toMatchObject({
      activeWorkEntryId: 'entry-a',
      archiveOverlayChatId: 'archived-chat',
    });
    expect(mockChatStore.getState().selectedWorktree).toEqual({
      projectId: DEFAULT_COWORK_WORKSPACE_ID,
      worktreeId: 'entry-a',
    });
    expect(mockApi.savePreferences).toHaveBeenLastCalledWith({
      lastSelectedWorktreeProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      lastSelectedWorktreeId: 'entry-a',
      lastActiveContext: {
        kind: 'cowork',
        workspaceId: DEFAULT_COWORK_WORKSPACE_ID,
        workEntryId: 'entry-a',
      },
    });
  });

  it('clears persisted startup context when an initial Work Entry selection is superseded', async () => {
    let resolveLoad: (() => void) | undefined;
    loadTabsMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: null,
      workEntries: [makeEntry('entry-b')],
    });
    mockChatStore.setState({ selectedWorktree: null });

    const staleSelection = useStandaloneChatStore
      .getState()
      .selectWorkEntry('entry-b');
    await useStandaloneChatStore.getState().selectArchivedChat('newer-chat');
    resolveLoad?.();
    await staleSelection;

    expect(mockChatStore.getState().selectedWorktree).toBeNull();
    expect(mockApi.savePreferences).toHaveBeenLastCalledWith({
      lastActiveContext: null,
      lastSelectedWorktreeProjectId: '',
      lastSelectedWorktreeId: '',
    });
  });

  it('restores the stable Work Entry after chained selections are superseded by an archive', async () => {
    let resolveFirstLoad: (() => void) | undefined;
    let resolveSecondLoad: (() => void) | undefined;
    loadTabsMock
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirstLoad = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSecondLoad = resolve;
          }),
      );
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: 'entry-a',
      workEntries: [
        makeEntry('entry-a'),
        makeEntry('entry-b'),
        makeEntry('entry-c'),
      ],
    });
    mockChatStore.setState({
      selectedWorktree: {
        projectId: DEFAULT_COWORK_WORKSPACE_ID,
        worktreeId: 'entry-a',
      },
    });

    const firstSelection = useStandaloneChatStore
      .getState()
      .selectWorkEntry('entry-b');
    const secondSelection = useStandaloneChatStore
      .getState()
      .selectWorkEntry('entry-c');
    await useStandaloneChatStore.getState().selectArchivedChat('archived-chat');
    resolveFirstLoad?.();
    resolveSecondLoad?.();
    await Promise.all([firstSelection, secondSelection]);

    expect(useStandaloneChatStore.getState()).toMatchObject({
      activeWorkEntryId: 'entry-a',
      archiveOverlayChatId: 'archived-chat',
    });
    expect(mockChatStore.getState().selectedWorktree).toEqual({
      projectId: DEFAULT_COWORK_WORKSPACE_ID,
      worktreeId: 'entry-a',
    });
  });

  it('selectChat opens an archived chat in its Work Entry transcript viewer', async () => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: 'entry-a',
      workEntries: [makeEntry('entry-a'), makeEntry('entry-b')],
    });
    mockApi.workEntries.resolveChat.mockResolvedValue({
      entryId: null,
      archivedInEntryId: 'entry-b',
    });

    await useStandaloneChatStore.getState().selectChat('archived-chat');

    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe('entry-b');
    expect(switchTabMock).not.toHaveBeenCalled();
    expect(dispatchEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: {
          projectId: DEFAULT_COWORK_WORKSPACE_ID,
          worktreeId: 'entry-b',
          chatId: 'archived-chat',
        },
      }),
    );
  });

  it('selectChat falls back to the legacy archive overlay when no Work Entry owns it', async () => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: 'entry-a',
      workEntries: [makeEntry('entry-a')],
    });

    await useStandaloneChatStore.getState().selectChat('missing-chat');

    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe('entry-a');
    expect(switchTabMock).not.toHaveBeenCalled();
    expect(mockApi.standaloneChat.readArchive).toHaveBeenCalledWith({
      projectId: DEFAULT_COWORK_WORKSPACE_ID,
      chatId: 'missing-chat',
    });
    expect(useStandaloneChatStore.getState().archiveOverlayChatId).toBe(
      'missing-chat',
    );
  });

  it('startNewChat reuses the active entry empty tab instead of creating a duplicate', async () => {
    mockChatStore.setState({
      selectedWorktree: {
        projectId: DEFAULT_COWORK_WORKSPACE_ID,
        worktreeId: 'entry-a',
      },
      worktreeChats: {
        [`${DEFAULT_COWORK_WORKSPACE_ID}/entry-a`]: {
          tabs: [{ id: 'empty-chat', title: 'New Chat', messages: [] }],
          activeTabId: 'empty-chat',
        },
      },
    });
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: 'entry-a',
      workEntries: [makeEntry('entry-a')],
    });

    await useStandaloneChatStore.getState().startNewChat();

    expect(ensureModelDefaultsLoadedMock).toHaveBeenCalledTimes(1);
    expect(syncActiveEmptyTabToDefaultsMock).toHaveBeenCalledTimes(1);
    expect(createTabWithIdMock).not.toHaveBeenCalled();
  });

  it('startNewChat creates a new tab in the active entry when the active tab is used', async () => {
    mockChatStore.setState({
      selectedWorktree: {
        projectId: DEFAULT_COWORK_WORKSPACE_ID,
        worktreeId: 'entry-a',
      },
      worktreeChats: {
        [`${DEFAULT_COWORK_WORKSPACE_ID}/entry-a`]: {
          tabs: [
            { id: 'used-chat', title: 'Used', messages: [{ timestamp: 1 }] },
          ],
          activeTabId: 'used-chat',
        },
      },
    });
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: 'entry-a',
      workEntries: [makeEntry('entry-a')],
    });

    await useStandaloneChatStore.getState().startNewChat();

    expect(ensureModelDefaultsLoadedMock).toHaveBeenCalledTimes(1);
    expect(createTabWithIdMock).toHaveBeenCalledTimes(1);
    expect(
      ensureModelDefaultsLoadedMock.mock.invocationCallOrder[0],
    ).toBeLessThan(createTabWithIdMock.mock.invocationCallOrder[0]);
  });

  it('does not rewrite the entry list when a refresh returns identical metas', async () => {
    const entry = makeEntry('entry-a', {
      lastMessageAt: '2024-01-02T00:00:00.000Z',
      providerType: 'codex',
    });
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      workEntries: [entry],
    });
    mockApi.workEntries.list.mockResolvedValue({
      entries: [{ ...entry }],
    });
    const subscriber = jest.fn();
    const unsubscribe = useStandaloneChatStore.subscribe(subscriber);

    await useStandaloneChatStore
      .getState()
      .refreshWorkEntries(DEFAULT_COWORK_WORKSPACE_ID);

    unsubscribe();
    expect(subscriber).not.toHaveBeenCalled();
    expect(useStandaloneChatStore.getState().workEntries[0]).toBe(entry);
  });

  it('rewrites the entry list when only the activity watermark changes', async () => {
    const entry = makeEntry('entry-a');
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      workEntries: [entry],
    });
    mockApi.workEntries.list.mockResolvedValue({
      entries: [{ ...entry, lastTouchedAt: '2026-09-02T12:00:00.000Z' }],
    });

    await useStandaloneChatStore
      .getState()
      .refreshWorkEntries(DEFAULT_COWORK_WORKSPACE_ID);

    expect(useStandaloneChatStore.getState().workEntries[0]).toEqual({
      ...entry,
      lastTouchedAt: '2026-09-02T12:00:00.000Z',
    });
  });

  it('coalesces followers into one trailing work-entry refresh', async () => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      workEntries: [],
    });
    const resolvers: Array<
      (value: { entries: ReturnType<typeof makeEntry>[] }) => void
    > = [];
    mockApi.workEntries.list.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const first = useStandaloneChatStore
      .getState()
      .refreshWorkEntries(DEFAULT_COWORK_WORKSPACE_ID);
    const second = useStandaloneChatStore
      .getState()
      .refreshWorkEntries(DEFAULT_COWORK_WORKSPACE_ID);
    expect(mockApi.workEntries.list).toHaveBeenCalledTimes(1);

    resolvers[0]?.({ entries: [makeEntry('stale-entry')] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockApi.workEntries.list).toHaveBeenCalledTimes(2);
    resolvers[1]?.({ entries: [makeEntry('fresh-entry')] });
    await Promise.all([first, second]);
    expect(useStandaloneChatStore.getState().workEntries).toEqual([
      makeEntry('fresh-entry'),
    ]);
  });

  it('does not commit a refresh generation after a newer generation supersedes it', async () => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      workEntries: [makeEntry('initial-entry')],
    });
    const resolvers: Array<
      (value: { entries: ReturnType<typeof makeEntry>[] }) => void
    > = [];
    mockApi.workEntries.list.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const superseded = useStandaloneChatStore
      .getState()
      .refreshWorkEntries(DEFAULT_COWORK_WORKSPACE_ID);
    const current = useStandaloneChatStore
      .getState()
      .refreshWorkEntries(DEFAULT_COWORK_WORKSPACE_ID, () => true);

    let supersededResolved = false;
    void superseded.then(() => {
      supersededResolved = true;
    });
    resolvers[0]?.({ entries: [makeEntry('stale-entry')] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(supersededResolved).toBe(false);
    expect(useStandaloneChatStore.getState().workEntries).toEqual([
      makeEntry('initial-entry'),
    ]);

    resolvers[1]?.({ entries: [makeEntry('fresh-entry')] });
    await Promise.all([superseded, current]);
    expect(supersededResolved).toBe(true);
    expect(useStandaloneChatStore.getState().workEntries).toEqual([
      makeEntry('fresh-entry'),
    ]);
  });

  it('defers a superseded refresh error to the successful trailing generation', async () => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      workEntries: [makeEntry('initial-entry')],
    });
    const resolvers: Array<
      (value: { entries: ReturnType<typeof makeEntry>[] }) => void
    > = [];
    const rejecters: Array<(reason: Error) => void> = [];
    mockApi.workEntries.list.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          resolvers.push(resolve);
          rejecters.push(reject);
        }),
    );

    const superseded = useStandaloneChatStore
      .getState()
      .refreshWorkEntries(DEFAULT_COWORK_WORKSPACE_ID);
    const supersededOutcome = superseded.then(
      () => 'resolved',
      () => 'rejected',
    );
    const current = useStandaloneChatStore
      .getState()
      .refreshWorkEntries(DEFAULT_COWORK_WORKSPACE_ID);

    rejecters[0]?.(new Error('superseded refresh failed'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockApi.workEntries.list).toHaveBeenCalledTimes(2);
    expect(
      await Promise.race([supersededOutcome, Promise.resolve('pending')]),
    ).toBe('pending');

    resolvers[1]?.({ entries: [makeEntry('fresh-entry')] });
    await expect(Promise.all([superseded, current])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(useStandaloneChatStore.getState().workEntries).toEqual([
      makeEntry('fresh-entry'),
    ]);
  });

  it('uses each coalesced refresh generation ownership predicate', async () => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      workEntries: [makeEntry('initial-entry')],
    });
    const resolvers: Array<
      (value: { entries: ReturnType<typeof makeEntry>[] }) => void
    > = [];
    mockApi.workEntries.list.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const superseded = useStandaloneChatStore
      .getState()
      .refreshWorkEntries(DEFAULT_COWORK_WORKSPACE_ID, () => false);
    const current = useStandaloneChatStore
      .getState()
      .refreshWorkEntries(DEFAULT_COWORK_WORKSPACE_ID, () => true);

    resolvers[0]?.({ entries: [makeEntry('stale-entry')] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolvers[1]?.({ entries: [makeEntry('fresh-entry')] });
    await Promise.all([superseded, current]);

    expect(useStandaloneChatStore.getState().workEntries).toEqual([
      makeEntry('fresh-entry'),
    ]);
  });

  it('commits for an unconditional waiter when the trailing conditional refresh loses ownership', async () => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      workEntries: [makeEntry('initial-entry')],
    });
    const resolvers: Array<
      (value: { entries: ReturnType<typeof makeEntry>[] }) => void
    > = [];
    mockApi.workEntries.list.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const unconditional = useStandaloneChatStore
      .getState()
      .refreshWorkEntries(DEFAULT_COWORK_WORKSPACE_ID);
    const conditional = useStandaloneChatStore
      .getState()
      .refreshWorkEntries(DEFAULT_COWORK_WORKSPACE_ID, () => false);

    resolvers[0]?.({ entries: [makeEntry('stale-entry')] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useStandaloneChatStore.getState().workEntries).toEqual([
      makeEntry('initial-entry'),
    ]);

    resolvers[1]?.({ entries: [makeEntry('fresh-entry')] });
    await Promise.all([unconditional, conditional]);

    expect(useStandaloneChatStore.getState().workEntries).toEqual([
      makeEntry('fresh-entry'),
    ]);
  });

  it('queues another pass when a refresh arrives during the trailing pass', async () => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      workEntries: [],
    });
    const resolvers: Array<
      (value: { entries: ReturnType<typeof makeEntry>[] }) => void
    > = [];
    mockApi.workEntries.list.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const first = useStandaloneChatStore
      .getState()
      .refreshWorkEntries(DEFAULT_COWORK_WORKSPACE_ID);
    const second = useStandaloneChatStore
      .getState()
      .refreshWorkEntries(DEFAULT_COWORK_WORKSPACE_ID);
    resolvers[0]?.({ entries: [makeEntry('first-entry')] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockApi.workEntries.list).toHaveBeenCalledTimes(2);

    const third = useStandaloneChatStore
      .getState()
      .refreshWorkEntries(DEFAULT_COWORK_WORKSPACE_ID);
    resolvers[1]?.({ entries: [makeEntry('second-entry')] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockApi.workEntries.list).toHaveBeenCalledTimes(3);

    resolvers[2]?.({ entries: [makeEntry('third-entry')] });
    await Promise.all([first, second, third]);
    expect(useStandaloneChatStore.getState().workEntries).toEqual([
      makeEntry('third-entry'),
    ]);
  });

  it('keeps refreshes single-flight across the completed-request microtask handoff', async () => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      workEntries: [],
    });
    const resolvers: Array<
      (value: { entries: ReturnType<typeof makeEntry>[] }) => void
    > = [];
    let firstRawRequest:
      | Promise<{ entries: ReturnType<typeof makeEntry>[] }>
      | undefined;
    let activeRequests = 0;
    let maxActiveRequests = 0;
    mockApi.workEntries.list.mockImplementation(() => {
      const request = new Promise<{ entries: ReturnType<typeof makeEntry>[] }>(
        (resolve) => {
          activeRequests += 1;
          maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
          resolvers.push((value) => {
            activeRequests -= 1;
            resolve(value);
          });
        },
      );
      firstRawRequest ??= request;
      return request;
    });

    const first = useStandaloneChatStore
      .getState()
      .refreshWorkEntries(DEFAULT_COWORK_WORKSPACE_ID);
    if (!firstRawRequest) {
      throw new Error('Expected the first work-entry refresh to start');
    }
    const handoff = firstRawRequest.then(() =>
      useStandaloneChatStore
        .getState()
        .refreshWorkEntries(DEFAULT_COWORK_WORKSPACE_ID),
    );
    const second = useStandaloneChatStore
      .getState()
      .refreshWorkEntries(DEFAULT_COWORK_WORKSPACE_ID);

    resolvers[0]?.({ entries: [makeEntry('first-entry')] });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockApi.workEntries.list).toHaveBeenCalledTimes(2);
    expect(maxActiveRequests).toBe(1);

    resolvers[1]?.({ entries: [makeEntry('second-entry')] });
    await Promise.all([first, second, handoff]);
    expect(mockApi.workEntries.list).toHaveBeenCalledTimes(2);
    expect(maxActiveRequests).toBe(1);
    expect(useStandaloneChatStore.getState().workEntries).toEqual([
      makeEntry('second-entry'),
    ]);
  });

  it.each(['', '   \n '])(
    'creates an empty work entry without sending blank text %j',
    async (message) => {
      useStandaloneChatStore.setState({
        initialized: true,
        activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      });
      mockApi.workEntries.create.mockResolvedValue({
        entry: makeEntry('entry-empty'),
        reusedExistingEmpty: false,
      });
      mockApi.workEntries.list.mockResolvedValue({
        entries: [makeEntry('entry-empty')],
      });

      await useStandaloneChatStore
        .getState()
        .createStandaloneChatWithMessage({ message });

      expect(mockApi.workEntries.create).toHaveBeenCalled();
      expect(createTabMock).toHaveBeenCalled();
      expect(sendMessageMock).not.toHaveBeenCalled();
      expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe(
        'entry-empty',
      );
      expect(useStandaloneChatStore.getState().coldStartDismissed).toBe(true);
    },
  );

  describe('project-less chats in an organization scope', () => {
    const orgId = '11111111-1111-4111-8111-111111111111';
    const orgDefaultId = orgDefaultCoworkWorkspaceId(orgId);

    beforeEach(() => {
      mockGetSidebarScopingContext.mockReturnValue({
        kind: 'organization',
        organizationId: orgId,
      });
    });

    afterEach(() => {
      mockGetSidebarScopingContext.mockReturnValue(undefined);
    });

    it("lands in the organization's Chats workspace", async () => {
      const orgProject = {
        id: orgDefaultId,
        name: 'Chats',
        createdAt: '2024-01-01',
      };
      useStandaloneChatStore.setState({
        initialized: true,
        activeChatProjectId: orgDefaultId,
        chatProjects: [
          ...useStandaloneChatStore.getState().chatProjects,
          orgProject,
        ],
      });
      mockApi.workEntries.create.mockResolvedValue({
        entry: makeEntry('entry-org'),
        reusedExistingEmpty: false,
      });
      mockApi.workEntries.list.mockResolvedValue({
        entries: [makeEntry('entry-org')],
      });

      await useStandaloneChatStore
        .getState()
        .createStandaloneChatWithMessage({ message: 'hello org' });

      expect(mockApi.workEntries.create).toHaveBeenCalledWith({
        projectId: orgDefaultId,
      });
    });

    it('fails closed instead of falling back to Personal when the org default is missing', async () => {
      useStandaloneChatStore.setState({
        initialized: true,
        activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      });
      mockApi.chatProject.list.mockResolvedValueOnce({
        projects: [
          {
            id: DEFAULT_COWORK_WORKSPACE_ID,
            name: 'Chats',
            createdAt: '2024-01-01',
          },
        ],
      });

      await expect(
        useStandaloneChatStore
          .getState()
          .createStandaloneChatWithMessage({ message: 'hello org' }),
      ).rejects.toMatchObject({ name: 'OrgDefaultChatsUnavailableError' });
      expect(mockApi.workEntries.create).not.toHaveBeenCalled();
      expect(sendMessageMock).not.toHaveBeenCalled();
    });

    it('fails closed when a listed org default is known to be ineligible', async () => {
      useStandaloneChatStore.setState({
        initialized: true,
        activeChatProjectId: orgDefaultId,
        chatProjects: [
          { id: orgDefaultId, name: 'Chats', createdAt: '2024-01-01' },
        ],
      });
      mockApi.chatProject.getOrgDefaultCoworkEligibility.mockResolvedValueOnce(
        'ineligible',
      );

      await expect(
        useStandaloneChatStore
          .getState()
          .createStandaloneChatWithMessage({ message: 'blocked org chat' }),
      ).rejects.toMatchObject({ name: 'OrgDefaultChatsUnavailableError' });
      expect(mockApi.workEntries.create).not.toHaveBeenCalled();
      expect(sendMessageMock).not.toHaveBeenCalled();
    });

    it('commits the org destination before first-use binding completes', async () => {
      useStandaloneChatStore.setState({ initialized: true });
      let releaseEnsure!: () => void;
      const ensureGate = new Promise<void>((resolve) => {
        releaseEnsure = resolve;
      });
      mockApi.chatProject.ensureOrgDefaultCoworkWorkspace.mockImplementationOnce(
        () => ensureGate,
      );
      mockApi.chatProject.list.mockResolvedValueOnce({
        projects: [
          {
            id: orgDefaultId,
            name: 'Chats',
            createdAt: '2024-01-01',
          },
        ],
      });
      const pending = useStandaloneChatStore
        .getState()
        .createWorkEntryInProject(orgDefaultId);

      expect(useStandaloneChatStore.getState()).toMatchObject({
        activeChatProjectId: orgDefaultId,
        activeWorkEntryId: null,
        workEntries: [],
      });

      releaseEnsure();
      await pending;
      expect(mockApi.workEntries.create).toHaveBeenCalledWith({
        projectId: orgDefaultId,
      });
    });

    it('keeps the org destination and exposes a retryable inline error when binding fails', async () => {
      useStandaloneChatStore.setState({ initialized: true });
      mockApi.chatProject.ensureOrgDefaultCoworkWorkspace.mockRejectedValueOnce(
        new Error('offline'),
      );

      await expect(
        useStandaloneChatStore
          .getState()
          .createWorkEntryInProject(orgDefaultId),
      ).rejects.toMatchObject({ name: 'OrgDefaultChatsUnavailableError' });

      expect(useStandaloneChatStore.getState()).toMatchObject({
        activeChatProjectId: orgDefaultId,
        orgDefaultChatsError: {
          projectId: orgDefaultId,
          message: 'This organization’s chats aren’t ready yet. Try again.',
        },
      });
      expect(mockApi.workEntries.create).not.toHaveBeenCalled();
    });
  });

  it('commits Auto mode before sending a Cowork Home message', async () => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
    });
    mockApi.workEntries.create.mockResolvedValue({
      entry: makeEntry('entry-auto'),
      reusedExistingEmpty: false,
    });
    mockApi.workEntries.list.mockResolvedValue({
      entries: [makeEntry('entry-auto')],
    });
    const config = { modelSelectionMode: 'auto' as const };

    const chatId = await useStandaloneChatStore
      .getState()
      .createStandaloneChatWithMessage({ message: 'route this', config });

    const target = {
      projectId: DEFAULT_COWORK_WORKSPACE_ID,
      worktreeId: 'entry-auto',
      chatId,
    };
    expect(setModelSelectionModeMock).toHaveBeenCalledWith('auto', target);
    expect(setModelSelectionModeMock.mock.invocationCallOrder[0]).toBeLessThan(
      sendMessageMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('turns off the workspace defaults a Home draft removed before the first send', async () => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
    });
    mockApi.workEntries.create.mockResolvedValue({
      entry: makeEntry('entry-plugins'),
      reusedExistingEmpty: false,
    });
    mockApi.workEntries.list.mockResolvedValue({
      entries: [makeEntry('entry-plugins')],
    });
    const pluginSelections: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: 'slack', configId: 'default' }],
    };
    const disabledGlobalPluginSelections = {
      mcpServerRefs: [{ serverId: 'linear', configId: 'default' }],
    };

    const chatId = await useStandaloneChatStore
      .getState()
      .createStandaloneChatWithMessage({
        message: 'hello',
        config: { pluginSelections, disabledGlobalPluginSelections },
      });

    const target = {
      projectId: DEFAULT_COWORK_WORKSPACE_ID,
      worktreeId: 'entry-plugins',
      chatId,
    };
    expect(createTabMock).toHaveBeenCalledWith(
      expect.objectContaining({ pluginSelections }),
    );
    expect(mockApi.chat.updatePlugins).toHaveBeenCalledWith({
      ...target,
      pluginSelections,
      disabledGlobalPluginSelections,
    });
    expect(setPluginSelectionsMock).toHaveBeenCalledWith(
      pluginSelections,
      target,
      undefined,
      { runtimeAlreadyUpdated: true, disabledGlobalPluginSelections },
    );
    expect(mockApi.chat.updatePlugins.mock.invocationCallOrder[0]).toBeLessThan(
      sendMessageMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('does not touch plugins when a Home draft keeps every workspace default', async () => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
    });
    mockApi.workEntries.create.mockResolvedValue({
      entry: makeEntry('entry-plain'),
      reusedExistingEmpty: false,
    });
    mockApi.workEntries.list.mockResolvedValue({
      entries: [makeEntry('entry-plain')],
    });

    await useStandaloneChatStore
      .getState()
      .createStandaloneChatWithMessage({ message: 'hello' });

    expect(mockApi.chat.updatePlugins).not.toHaveBeenCalled();
  });

  it('retains an attachment-only cowork draft in its work entry', async () => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
    });
    mockApi.workEntries.create.mockResolvedValue({
      entry: makeEntry('entry-draft'),
      reusedExistingEmpty: false,
    });
    mockApi.workEntries.list.mockResolvedValue({
      entries: [makeEntry('entry-draft')],
    });
    const attachment = {
      filename: 'ticket.md',
      absolutePath: '/tmp/ticket.md',
      promptKind: 'linear-ticket' as const,
    };
    const chatId = await useStandaloneChatStore
      .getState()
      .createStandaloneChatWithMessage({
        message: '',
        config: { attachments: [attachment], fastMode: true },
      });
    const target = {
      projectId: DEFAULT_COWORK_WORKSPACE_ID,
      worktreeId: 'entry-draft',
      chatId,
    };
    expect(mockChatStore.getState().addPendingAttachments).toHaveBeenCalledWith(
      [attachment],
      target,
    );
    expect(mockChatStore.getState().setFastMode).toHaveBeenCalledWith(
      true,
      target,
    );
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('asks the chat store to replace the starter when Home reuses its work entry', async () => {
    // Entry reuse only governs ownership. Whether the reused entry's starter
    // tab is pristine (or holds a draft to keep) is decided by the real chat
    // store; see the guarded starter-tab replacement tests in chatStore.test.
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
    });
    mockApi.workEntries.create.mockResolvedValue({
      entry: makeEntry('entry-drafts'),
      reusedExistingEmpty: true,
    });
    mockApi.workEntries.list.mockResolvedValue({
      entries: [makeEntry('entry-drafts')],
    });

    const chatId = await useStandaloneChatStore
      .getState()
      .createStandaloneChatWithMessage({ message: 'first prompt' });

    expect(createTabMock).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'entry-drafts',
        id: chatId,
        replaceActiveEmpty: true,
      }),
    );
  });

  it('keeps a reused Home entry selected when the initial send fails', async () => {
    const chatId = '00000000-0000-4000-8000-00000000c0de';
    const randomUuidSpy = jest
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue(chatId);
    try {
      useStandaloneChatStore.setState({
        initialized: true,
        activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
        activeWorkEntryId: null,
        workEntries: [makeEntry('entry-reused')],
      });
      mockApi.workEntries.create.mockResolvedValue({
        entry: makeEntry('entry-reused'),
        reusedExistingEmpty: true,
      });
      mockApi.workEntries.list.mockResolvedValue({
        entries: [makeEntry('entry-reused')],
      });
      sendMessageMock.mockRejectedValueOnce(new Error('send failed'));

      await expect(
        useStandaloneChatStore
          .getState()
          .createStandaloneChatWithMessage({ message: 'first prompt' }),
      ).rejects.toThrow('send failed');

      expect(closeTabMock).toHaveBeenCalledWith(chatId, {
        projectId: DEFAULT_COWORK_WORKSPACE_ID,
        worktreeId: 'entry-reused',
        force: true,
      });
      expect(mockApi.workEntries.delete).not.toHaveBeenCalled();
      expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe(
        'entry-reused',
      );
    } finally {
      randomUuidSpy.mockRestore();
    }
  });

  it('creates a fresh work entry with an initial message send', async () => {
    const chatId = '00000000-0000-4000-8000-000000000001';
    const randomUuidSpy = jest
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue(chatId);
    try {
      useStandaloneChatStore.setState({
        initialized: true,
        activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
        activeWorkEntryId: 'entry-a',
        workEntries: [makeEntry('entry-a')],
      });
      mockApi.workEntries.create.mockResolvedValue({
        entry: makeEntry('entry-send'),
        reusedExistingEmpty: false,
      });
      mockApi.workEntries.list.mockResolvedValue({
        entries: [makeEntry('entry-send'), makeEntry('entry-a')],
      });
      loadTabsMock.mockImplementationOnce(() => {
        const key = `${DEFAULT_COWORK_WORKSPACE_ID}/entry-send`;
        mockChatStore.setState({
          worktreeChats: {
            ...mockChatStore.getState().worktreeChats,
            [key]: {
              tabs: [{ id: 'default-empty', title: 'New Chat', messages: [] }],
              activeTabId: 'default-empty',
            },
          },
        });
        return Promise.resolve();
      });

      const result = await useStandaloneChatStore
        .getState()
        .createStandaloneChatWithMessage({ message: 'debug this' });

      expect(result).toBe(chatId);
      expect(mockApi.workEntries.create).toHaveBeenCalledWith({
        projectId: DEFAULT_COWORK_WORKSPACE_ID,
      });
      expect(mockMarkStartPageSuppressed).toHaveBeenCalledWith(
        `${DEFAULT_COWORK_WORKSPACE_ID}/entry-send`,
      );
      expect(createTabMock).toHaveBeenCalledWith({
        projectId: DEFAULT_COWORK_WORKSPACE_ID,
        worktreeId: 'entry-send',
        id: chatId,
        replaceActiveEmpty: true,
        model: undefined,
        // Round-2 finding 5: provenance is explicit; a pinned effective default
        // from Home is NOT a user pick.
        modelExplicitlyChosen: false,
        thinkingLevel: undefined,
        pluginSelections: undefined,
      });
      expect(sendMessageMock).toHaveBeenCalledWith(
        'debug this',
        undefined,
        {
          projectId: DEFAULT_COWORK_WORKSPACE_ID,
          worktreeId: 'entry-send',
          chatId,
        },
        undefined,
        { attachmentPaths: undefined, attachmentPromptContexts: undefined },
      );
      expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe(
        'entry-send',
      );
      expect(
        mockChatStore
          .getState()
          .worktreeChats[
            `${DEFAULT_COWORK_WORKSPACE_ID}/entry-send`
          ]?.tabs.map((tab) => tab.id),
      ).toEqual([chatId]);
      expect(createTabMock.mock.invocationCallOrder[0]).toBeLessThan(
        sendMessageMock.mock.invocationCallOrder[0] ?? 0,
      );
    } finally {
      randomUuidSpy.mockRestore();
    }
  });

  it('creates configured cowork chats before sending the first message', async () => {
    const chatId = '00000000-0000-4000-8000-0000000000c0';
    const model: ChatModel = 'claude-sonnet-4-5';
    const pluginSelections: ChatTabPluginSelections = {
      collectionIds: ['collection-a'],
      skillRefs: [],
      pluginRefs: [],
    };
    const randomUuidSpy = jest
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue(chatId);
    try {
      useStandaloneChatStore.setState({
        initialized: true,
        activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      });
      mockApi.workEntries.create.mockResolvedValue({
        entry: makeEntry('entry-send'),
        reusedExistingEmpty: false,
      });
      mockApi.workEntries.list.mockResolvedValue({
        entries: [makeEntry('entry-send')],
      });

      await useStandaloneChatStore.getState().createStandaloneChatWithMessage({
        message: 'debug this',
        config: {
          model,
          thinkingLevel: 'medium',
          pluginSelections,
        },
      });

      expect(createTabMock).toHaveBeenCalledWith({
        projectId: DEFAULT_COWORK_WORKSPACE_ID,
        worktreeId: 'entry-send',
        id: chatId,
        replaceActiveEmpty: true,
        model,
        modelExplicitlyChosen: false,
        thinkingLevel: 'medium',
        pluginSelections,
      });
      expect(createTabWithIdMock).not.toHaveBeenCalled();
      expect(createTabMock.mock.invocationCallOrder[0]).toBeLessThan(
        sendMessageMock.mock.invocationCallOrder[0] ?? 0,
      );
    } finally {
      randomUuidSpy.mockRestore();
    }
  });

  it('pins an explicit config.approvalMode onto the created tab before sending', async () => {
    const chatId = '00000000-0000-4000-8000-0000000000c1';
    const randomUuidSpy = jest
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue(chatId);
    try {
      useStandaloneChatStore.setState({
        initialized: true,
        activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      });
      mockApi.workEntries.create.mockResolvedValue({
        entry: makeEntry('entry-send'),
        reusedExistingEmpty: false,
      });
      mockApi.workEntries.list.mockResolvedValue({
        entries: [makeEntry('entry-send')],
      });

      await useStandaloneChatStore.getState().createStandaloneChatWithMessage({
        message: 'debug this',
        config: { approvalMode: 'full-access' },
      });

      expect(setTabApprovalModeMock).toHaveBeenCalledWith(
        {
          projectId: DEFAULT_COWORK_WORKSPACE_ID,
          worktreeId: 'entry-send',
          chatId,
        },
        'full-access',
      );
      // The tab pin must land before the first send so the turn dispatch
      // reads the pinned mode rather than the tab's unset default.
      expect(setTabApprovalModeMock.mock.invocationCallOrder[0]).toBeLessThan(
        sendMessageMock.mock.invocationCallOrder[0] ?? 0,
      );
    } finally {
      randomUuidSpy.mockRestore();
    }
  });

  it('does not pin an approval mode when config.approvalMode is untouched', async () => {
    const chatId = '00000000-0000-4000-8000-0000000000c2';
    const randomUuidSpy = jest
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue(chatId);
    try {
      useStandaloneChatStore.setState({
        initialized: true,
        activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      });
      mockApi.workEntries.create.mockResolvedValue({
        entry: makeEntry('entry-send'),
        reusedExistingEmpty: false,
      });
      mockApi.workEntries.list.mockResolvedValue({
        entries: [makeEntry('entry-send')],
      });

      await useStandaloneChatStore
        .getState()
        .createStandaloneChatWithMessage({ message: 'debug this' });

      expect(setTabApprovalModeMock).not.toHaveBeenCalled();
    } finally {
      randomUuidSpy.mockRestore();
    }
  });

  it('switches to the default project before creating a debug chat', async () => {
    const chatId = '00000000-0000-4000-8000-000000000002';
    const randomUuidSpy = jest
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue(chatId);
    try {
      useStandaloneChatStore.setState({
        initialized: true,
        chatProjects: [
          {
            id: DEFAULT_COWORK_WORKSPACE_ID,
            name: 'Default',
            createdAt: '2024-01-01',
          },
          { id: 'other', name: 'Other', createdAt: '2024-01-01' },
        ],
        activeChatProjectId: 'other',
      });
      mockApi.workEntries.list.mockResolvedValue({ entries: [] });
      mockApi.workEntries.create.mockResolvedValue({
        entry: makeEntry('entry-default'),
        reusedExistingEmpty: false,
      });

      await useStandaloneChatStore
        .getState()
        .createStandaloneChatWithMessage({ message: 'debug default' });

      expect(mockApi.standaloneChat.init).toHaveBeenCalledWith(
        DEFAULT_COWORK_WORKSPACE_ID,
      );
      expect(useStandaloneChatStore.getState().activeChatProjectId).toBe(
        DEFAULT_COWORK_WORKSPACE_ID,
      );
      expect(sendMessageMock).toHaveBeenCalledWith(
        'debug default',
        undefined,
        {
          projectId: DEFAULT_COWORK_WORKSPACE_ID,
          worktreeId: 'entry-default',
          chatId,
        },
        undefined,
        { attachmentPaths: undefined, attachmentPromptContexts: undefined },
      );
    } finally {
      randomUuidSpy.mockRestore();
    }
  });

  it('propagates send failures from debug chat creation', async () => {
    const failure = new Error('send failed');
    sendMessageMock.mockRejectedValueOnce(failure);
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
    });

    await expect(
      useStandaloneChatStore
        .getState()
        .createStandaloneChatWithMessage({ message: 'debug this' }),
    ).rejects.toThrow('send failed');
  });

  it('retains the exact repair chat when its initial dispatch fails', async () => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
    });
    mockApi.workEntries.create.mockResolvedValue({
      entry: makeEntry('entry-repair'),
      reusedExistingEmpty: false,
    });
    mockApi.workEntries.list.mockResolvedValue({
      entries: [makeEntry('entry-repair')],
    });
    sendMessageMock.mockRejectedValueOnce(new Error('repair dispatch failed'));
    const onCreated = jest.fn<
      void,
      [{ projectId: string; worktreeId: string; chatId: string }]
    >();
    const onSubmitted = jest.fn();
    await expect(
      useStandaloneChatStore.getState().createStandaloneChatWithMessage({
        message: 'repair this',
        recovery: {
          onCreated,
          onSubmitted,
          userMessageId: 'repair-first-message',
        },
      }),
    ).rejects.toThrow('repair dispatch failed');
    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: DEFAULT_COWORK_WORKSPACE_ID,
        worktreeId: 'entry-repair',
      }),
    );
    const target = onCreated.mock.calls[0]?.[0];
    if (!target) throw new Error('Expected the created repair target');
    expect(
      mockChatStore
        .getState()
        .worktreeChats[
          `${DEFAULT_COWORK_WORKSPACE_ID}/entry-repair`
        ]?.tabs.some((tab) => tab.id === target.chatId),
    ).toBe(true);
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(mockApi.workEntries.delete).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledWith(
      'repair this',
      undefined,
      target,
      undefined,
      expect.objectContaining({ throwOnDispatchFailure: true }),
    );
  });

  it('retains a recoverable Try it chat after an uncertain first-send response', async () => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
    });
    mockApi.workEntries.create.mockResolvedValue({
      entry: makeEntry('entry-recovery'),
      reusedExistingEmpty: false,
    });
    mockApi.workEntries.list.mockResolvedValue({
      entries: [makeEntry('entry-recovery')],
    });
    sendMessageMock.mockRejectedValueOnce(new Error('response lost'));
    const journal = jest.fn();
    await expect(
      useStandaloneChatStore.getState().createStandaloneChatWithMessage({
        message: 'Try the capability',
        chatId: 'recoverable-chat',
        ...{ initialMessageId: 'recoverable-turn' },
        onChatCreated: journal,
      }),
    ).rejects.toThrow('response lost');
    expect(journal).toHaveBeenCalledWith({
      projectId: DEFAULT_COWORK_WORKSPACE_ID,
      worktreeId: 'entry-recovery',
      chatId: 'recoverable-chat',
    });
    expect(sendMessageMock).toHaveBeenCalledWith(
      'Try the capability',
      undefined,
      expect.objectContaining({ chatId: 'recoverable-chat' }),
      undefined,
      expect.objectContaining({
        userMessageId: 'recoverable-turn',
        throwOnDispatchFailure: true,
      }),
    );
    expect(mockApi.workEntries.delete).not.toHaveBeenCalled();
    expect(
      mockChatStore
        .getState()
        .worktreeChats[
          `${DEFAULT_COWORK_WORKSPACE_ID}/entry-recovery`
        ]?.tabs.some((tab) => tab.id === 'recoverable-chat'),
    ).toBe(true);
  });
  it.each(['onPreDispatchRejected', 'onDispatchRejected'] as const)(
    'retains the repair chat when %s resolves without submitting',
    async (rejection) => {
      useStandaloneChatStore.setState({
        initialized: true,
        activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      });
      mockApi.workEntries.create.mockResolvedValue({
        entry: makeEntry('entry-repair'),
        reusedExistingEmpty: false,
      });
      mockApi.workEntries.list.mockResolvedValue({
        entries: [makeEntry('entry-repair')],
      });
      sendMessageMock.mockImplementationOnce((...args: unknown[]) => {
        const options = args[4] as Record<string, (() => void) | undefined>;
        options[rejection]?.();
        return Promise.resolve();
      });
      const onCreated = jest.fn();
      const onSubmitted = jest.fn();
      await expect(
        useStandaloneChatStore.getState().createStandaloneChatWithMessage({
          message: 'repair this',
          recovery: {
            onCreated,
            onSubmitted,
            userMessageId: 'repair-first-message',
          },
        }),
      ).rejects.toThrow('not accepted');
      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(onSubmitted).not.toHaveBeenCalled();
      expect(mockApi.workEntries.delete).not.toHaveBeenCalled();
    },
  );

  it('rolls back the fresh work entry when the initial send fails', async () => {
    const chatId = '00000000-0000-4000-8000-00000000beef';
    const randomUuidSpy = jest
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue(chatId);
    try {
      mockChatStore.setState({
        selectedWorktree: {
          projectId: DEFAULT_COWORK_WORKSPACE_ID,
          worktreeId: 'entry-prev',
        },
        worktreeChats: {
          [`${DEFAULT_COWORK_WORKSPACE_ID}/entry-prev`]: {
            tabs: [{ id: 'previous-chat', title: 'Previous', messages: [] }],
            activeTabId: 'previous-chat',
          },
        },
      });
      useStandaloneChatStore.setState({
        initialized: true,
        activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
        activeWorkEntryId: 'entry-prev',
        workEntries: [makeEntry('entry-prev')],
      });
      mockApi.workEntries.create.mockResolvedValue({
        entry: makeEntry('entry-send'),
        reusedExistingEmpty: false,
      });
      // First list (after create) includes the new entry; the list after the
      // rollback delete no longer does.
      mockApi.workEntries.list
        .mockResolvedValueOnce({
          entries: [makeEntry('entry-send'), makeEntry('entry-prev')],
        })
        .mockResolvedValue({ entries: [makeEntry('entry-prev')] });

      sendMessageMock.mockRejectedValueOnce(new Error('send failed'));

      await expect(
        useStandaloneChatStore
          .getState()
          .createStandaloneChatWithMessage({ message: 'debug this' }),
      ).rejects.toThrow('send failed');

      // The orphaned chat tab should have been removed.
      const tabs =
        mockChatStore.getState().worktreeChats[
          `${DEFAULT_COWORK_WORKSPACE_ID}/entry-send`
        ]?.tabs;
      expect(tabs?.some((tab) => tab.id === chatId)).toBeFalsy();

      // The freshly created (still-empty) entry is deleted again.
      expect(mockApi.workEntries.delete).toHaveBeenCalledWith({
        projectId: DEFAULT_COWORK_WORKSPACE_ID,
        entryId: 'entry-send',
      });

      // The previous selection is restored.
      expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe(
        'entry-prev',
      );
    } finally {
      randomUuidSpy.mockRestore();
    }
  });

  it('rolls back the fresh work entry when Fast-mode persistence fails', async () => {
    const chatId = '00000000-0000-4000-8000-00000000fade';
    const randomUuidSpy = jest
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue(chatId);
    try {
      mockChatStore.setState({
        selectedWorktree: {
          projectId: DEFAULT_COWORK_WORKSPACE_ID,
          worktreeId: 'entry-prev',
        },
        worktreeChats: {
          [`${DEFAULT_COWORK_WORKSPACE_ID}/entry-prev`]: {
            tabs: [{ id: 'previous-chat', title: 'Previous', messages: [] }],
            activeTabId: 'previous-chat',
          },
        },
      });
      useStandaloneChatStore.setState({
        initialized: true,
        activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
        activeWorkEntryId: 'entry-prev',
        workEntries: [makeEntry('entry-prev')],
      });
      mockApi.workEntries.create.mockResolvedValue({
        entry: makeEntry('entry-fast-mode'),
        reusedExistingEmpty: false,
      });
      mockApi.workEntries.list
        .mockResolvedValueOnce({
          entries: [makeEntry('entry-fast-mode'), makeEntry('entry-prev')],
        })
        .mockResolvedValue({ entries: [makeEntry('entry-prev')] });
      mockChatStore
        .getState()
        .setFastMode.mockRejectedValueOnce(new Error('Fast mode failed'));

      await expect(
        useStandaloneChatStore.getState().createStandaloneChatWithMessage({
          message: '',
          config: { fastMode: true },
        }),
      ).rejects.toThrow('Fast mode failed');

      const tabs =
        mockChatStore.getState().worktreeChats[
          `${DEFAULT_COWORK_WORKSPACE_ID}/entry-fast-mode`
        ]?.tabs;
      expect(tabs?.some((tab) => tab.id === chatId)).toBeFalsy();
      expect(mockApi.workEntries.delete).toHaveBeenCalledWith({
        projectId: DEFAULT_COWORK_WORKSPACE_ID,
        entryId: 'entry-fast-mode',
      });
      expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe(
        'entry-prev',
      );
    } finally {
      randomUuidSpy.mockRestore();
    }
  });

  it('selects archived chats in the legacy archive overlay', async () => {
    mockApi.standaloneChat.readArchive.mockResolvedValue({
      summary: 'archived summary',
      legacySummaryOnly: false,
      snapshot: {
        version: 1,
        projectId: 'default',
        chatId: 'archived-1',
        archivedAt: '2024-01-02T00:00:00.000Z',
        tab: {
          id: 'archived-1',
          title: 'Archived Thread',
          description: 'archived summary',
          messages: [],
          createdAt: '2024-01-01T00:00:00.000Z',
          planMode: false,
          proposalMode: 'optional',
          thinkingLevel: 'high',
        },
      },
    });

    await useStandaloneChatStore.getState().selectArchivedChat('archived-1');

    expect(mockApi.standaloneChat.readArchive).toHaveBeenCalledWith({
      chatId: 'archived-1',
      projectId: DEFAULT_COWORK_WORKSPACE_ID,
    });
    expect(useStandaloneChatStore.getState().archiveOverlayChatId).toBe(
      'archived-1',
    );
    expect(useStandaloneChatStore.getState().activeSummary).toBe(
      'archived summary',
    );
    const activeArchiveData =
      useStandaloneChatStore.getState().activeArchiveData;
    expect(activeArchiveData).toMatchObject({
      summary: 'archived summary',
      legacySummaryOnly: false,
    });
    expect(activeArchiveData?.tab?.id).toBe('archived-1');
  });

  it('closeArchiveOverlay clears the legacy overlay state', async () => {
    await useStandaloneChatStore.getState().selectArchivedChat('archived-1');
    expect(
      useStandaloneChatStore.getState().archiveOverlayChatId,
    ).not.toBeNull();

    useStandaloneChatStore.getState().closeArchiveOverlay();

    expect(useStandaloneChatStore.getState().archiveOverlayChatId).toBeNull();
    expect(useStandaloneChatStore.getState().activeSummary).toBeNull();
    expect(useStandaloneChatStore.getState().activeArchiveData).toBeNull();
  });

  it('resumes archived chats into a fresh work entry', async () => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: 'entry-a',
      workEntries: [makeEntry('entry-a')],
      archiveOverlayChatId: 'archived-1',
    });
    mockApi.workEntries.create.mockResolvedValue({
      entry: makeEntry('entry-resumed'),
      reusedExistingEmpty: false,
    });
    mockApi.workEntries.list.mockResolvedValue({
      entries: [makeEntry('entry-resumed'), makeEntry('entry-a')],
    });
    mockChatStore.setState({
      worktreeChats: {
        [`${DEFAULT_COWORK_WORKSPACE_ID}/entry-resumed`]: {
          activeTabId: 'fallback-empty',
          tabs: [{ id: 'fallback-empty', title: 'New Chat', messages: [] }],
        },
      },
    });

    await useStandaloneChatStore.getState().resumeArchivedChat('archived-1');

    expect(mockApi.standaloneChat.resumeArchive).toHaveBeenCalledWith({
      projectId: DEFAULT_COWORK_WORKSPACE_ID,
      chatId: 'archived-1',
      mode: 'resume',
      // Main installs the resumed tab into the new entry's canonical scope.
      destinationEntryId: 'entry-resumed',
    });
    expect(mockApi.workEntries.create).toHaveBeenCalledWith({
      projectId: DEFAULT_COWORK_WORKSPACE_ID,
    });
    expect(insertClonedStandaloneTabMock).toHaveBeenCalledTimes(1);
    expect(insertClonedStandaloneTabMock.mock.calls[0][0]).toBe(
      DEFAULT_COWORK_WORKSPACE_ID,
    );
    expect(insertClonedStandaloneTabMock.mock.calls[0][1]).toBe(
      'entry-resumed',
    );
    expect(insertClonedStandaloneTabMock.mock.calls[0][4]).toBe(true);
    expect(
      mockChatStore.getState().worktreeChats[
        `${DEFAULT_COWORK_WORKSPACE_ID}/entry-resumed`
      ]?.tabs,
    ).toHaveLength(1);
    expect(
      mockChatStore.getState().worktreeChats[
        `${DEFAULT_COWORK_WORKSPACE_ID}/entry-resumed`
      ]?.tabs[0]?.id,
    ).toBe('resumed-1');
    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe(
      'entry-resumed',
    );
    expect(useStandaloneChatStore.getState().archiveOverlayChatId).toBeNull();
  });

  it('loads legacy archived chats into the per-project slice', async () => {
    mockApi.standaloneChat.list.mockResolvedValue({
      chats: [
        {
          id: 'live-ish',
          title: 'Live',
          description: 'Live',
          createdAt: '2024-01-01T00:00:00.000Z',
        },
        {
          id: 'archived-1',
          title: 'Archived',
          description: 'Archived',
          createdAt: '2024-01-01T00:00:00.000Z',
          archived: true,
          archivedAt: '2024-01-02T00:00:00.000Z',
        },
      ],
    });

    await useStandaloneChatStore
      .getState()
      .loadLegacyArchivedChats(DEFAULT_COWORK_WORKSPACE_ID);

    expect(
      useStandaloneChatStore
        .getState()
        .legacyArchivedByProject[
          DEFAULT_COWORK_WORKSPACE_ID
        ]?.map((chat) => chat.id),
    ).toEqual(['archived-1']);
  });

  describe('deleteChatProject', () => {
    it('cleans up every known entry and always deletes', async () => {
      useStandaloneChatStore.setState({
        chatProjects: [
          {
            id: DEFAULT_COWORK_WORKSPACE_ID,
            name: 'Default',
            createdAt: '2024-01-01',
          },
          { id: 'alpha', name: 'Alpha', createdAt: '2024-01-02' },
        ],
        activeChatProjectId: 'alpha',
        workEntries: [makeEntry('entry-x'), makeEntry('entry-y')],
      });
      mockApi.workEntries.list.mockResolvedValue({ entries: [] });
      mockApi.workEntries.create.mockResolvedValue({
        entry: makeEntry('entry-default'),
        reusedExistingEmpty: false,
      });

      await useStandaloneChatStore.getState().deleteChatProject('alpha');

      // Every known entry of the deleted project is flushed and cleaned.
      expect(flushWorktreeTabsMock).toHaveBeenCalledWith('alpha', 'entry-x');
      expect(flushWorktreeTabsMock).toHaveBeenCalledWith('alpha', 'entry-y');
      expect(cleanupWorktreeMock).toHaveBeenCalledWith('alpha', 'entry-x');
      expect(cleanupWorktreeMock).toHaveBeenCalledWith('alpha', 'entry-y');
      expect(mockApi.chatProject.delete).toHaveBeenCalledWith({
        projectId: 'alpha',
        chatDisposition: 'delete',
      });
      expect(
        useStandaloneChatStore
          .getState()
          .chatProjects.some((project) => project.id === 'alpha'),
      ).toBe(false);
      expect(useStandaloneChatStore.getState().activeChatProjectId).toBe(
        DEFAULT_COWORK_WORKSPACE_ID,
      );
    });
  });
});

describe('standaloneChatStore sidebar multi-project', () => {
  const otherEntry = makeEntry('other-entry-1', { title: 'Other Entry' });

  beforeEach(() => {
    useStandaloneChatStore.setState({
      chatProjects: [
        { id: 'default', name: 'Default', createdAt: '2024-01-01' },
        { id: 'other', name: 'Other', createdAt: '2024-01-01' },
      ],
      activeChatProjectId: 'default',
      initialized: true,
      workEntries: [],
      sidebarEntriesByProject: {},
      legacyArchivedByProject: {},
    });
  });

  it('derives the active project entry list from `workEntries` and reads the map for others', async () => {
    const { getSidebarProjectEntries } = await standaloneChatStoreModulePromise;
    const activeEntry = makeEntry('active-entry-1');
    useStandaloneChatStore.setState({
      workEntries: [activeEntry],
      sidebarEntriesByProject: { other: [otherEntry] },
    });

    const state = useStandaloneChatStore.getState();
    // Active project derives from the live `workEntries` array.
    expect(getSidebarProjectEntries(state, 'default')).toBe(state.workEntries);
    // Non-active project reads the lazily loaded map.
    expect(getSidebarProjectEntries(state, 'other')).toEqual([otherEntry]);
    // Unknown project yields an empty list.
    expect(getSidebarProjectEntries(state, 'missing')).toEqual([]);
  });

  it('loads a non-active project entry list and never shadows the active one', async () => {
    mockApi.workEntries.list.mockResolvedValue({ entries: [otherEntry] });

    await useStandaloneChatStore.getState().loadSidebarProjectEntries('other');
    expect(mockApi.workEntries.list).toHaveBeenCalledWith({
      projectId: 'other',
    });
    expect(
      useStandaloneChatStore.getState().sidebarEntriesByProject.other,
    ).toEqual([otherEntry]);

    // Active project is never stored in the sidebar map (derived from
    // `workEntries`).
    mockApi.workEntries.list.mockClear();
    await useStandaloneChatStore
      .getState()
      .loadSidebarProjectEntries('default');
    expect(mockApi.workEntries.list).not.toHaveBeenCalled();
    expect(
      useStandaloneChatStore.getState().sidebarEntriesByProject.default,
    ).toBeUndefined();
  });

  it('caches the outgoing active project entries when switching projects', async () => {
    const activeEntry = makeEntry('active-entry-1');
    useStandaloneChatStore.setState({ workEntries: [activeEntry] });
    mockApi.workEntries.list.mockResolvedValue({ entries: [otherEntry] });

    await useStandaloneChatStore.getState().switchChatProject('other');

    expect(
      useStandaloneChatStore.getState().sidebarEntriesByProject.default,
    ).toEqual([activeEntry]);
    expect(useStandaloneChatStore.getState().activeChatProjectId).toBe('other');
    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe(
      'other-entry-1',
    );
    expect(useStandaloneChatStore.getState().initialized).toBe(true);
  });

  it('prefers a persisted entry when switching projects and falls back when stale', async () => {
    const persistedEntry = makeEntry('other-entry-2');
    mockApi.workEntries.list.mockResolvedValue({
      entries: [otherEntry, persistedEntry],
    });

    await useStandaloneChatStore
      .getState()
      .switchChatProject('other', persistedEntry.id);
    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe(
      persistedEntry.id,
    );

    useStandaloneChatStore.setState({ initialized: false });
    await useStandaloneChatStore
      .getState()
      .switchChatProject('other', 'deleted-entry');
    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe(
      otherEntry.id,
    );
  });

  it('does not let an older project switch commit after tab loading', async () => {
    let releaseOtherTabs: () => void = () => {};
    const otherTabsLoaded = new Promise<void>((resolve) => {
      releaseOtherTabs = resolve;
    });
    mockApi.workEntries.list.mockImplementation(
      ({ projectId }: { projectId: string }) =>
        Promise.resolve({
          entries:
            projectId === 'other'
              ? [otherEntry]
              : [makeEntry('default-entry-1')],
        }),
    );
    loadTabsMock
      .mockImplementationOnce(() => otherTabsLoaded)
      .mockResolvedValueOnce(undefined);

    const olderSwitch = useStandaloneChatStore
      .getState()
      .switchChatProject('other');
    await Promise.resolve();
    await Promise.resolve();
    const newerSwitch = useStandaloneChatStore
      .getState()
      .switchChatProject('default');
    await newerSwitch;
    releaseOtherTabs();
    await olderSwitch;

    const state = useStandaloneChatStore.getState();
    expect(state.activeChatProjectId).toBe('default');
    expect(state.activeWorkEntryId).toBe('default-entry-1');
    expect(state.workEntries.map((entry) => entry.id)).toEqual([
      'default-entry-1',
    ]);
  });

  it('aborts a sidebar continuation when its project switch is superseded', async () => {
    let releaseOtherTabs: () => void = () => {};
    const otherTabsLoaded = new Promise<void>((resolve) => {
      releaseOtherTabs = resolve;
    });
    mockApi.workEntries.list.mockImplementation(
      ({ projectId }: { projectId: string }) =>
        Promise.resolve({
          entries:
            projectId === 'other'
              ? [otherEntry]
              : [makeEntry('default-entry-1')],
        }),
    );
    loadTabsMock
      .mockImplementationOnce(() => otherTabsLoaded)
      .mockResolvedValueOnce(undefined);

    const staleOpen = useStandaloneChatStore
      .getState()
      .openWorkEntryFromSidebar('other', otherEntry.id);
    await Promise.resolve();
    await Promise.resolve();
    await useStandaloneChatStore.getState().switchChatProject('default');
    releaseOtherTabs();
    await staleOpen;

    expect(useStandaloneChatStore.getState().activeChatProjectId).toBe(
      'default',
    );
    expect(
      selectWorktreeMock.mock.calls.some(
        ([projectId, entryId]) =>
          projectId === 'default' && entryId === otherEntry.id,
      ),
    ).toBe(false);
  });

  it('switches project before selecting when opening a non-active entry', async () => {
    mockApi.workEntries.list.mockResolvedValue({ entries: [otherEntry] });

    await useStandaloneChatStore
      .getState()
      .openWorkEntryFromSidebar('other', 'other-entry-1');

    // switchChatProject ran (init called with the target project) before the
    // entry selection landed.
    expect(mockApi.standaloneChat.init).toHaveBeenCalledWith('other');
    expect(useStandaloneChatStore.getState().activeChatProjectId).toBe('other');
    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe(
      'other-entry-1',
    );
    expect(selectWorktreeMock).toHaveBeenCalledWith('other', 'other-entry-1');
  });

  it('opens a legacy archived chat from the sidebar in the overlay', async () => {
    mockApi.workEntries.list.mockResolvedValue({ entries: [otherEntry] });
    mockApi.standaloneChat.readArchive.mockResolvedValue({
      summary: 'archived summary',
      snapshot: null,
      legacySummaryOnly: true,
    });

    await useStandaloneChatStore
      .getState()
      .openArchivedChatFromSidebar('other', 'other-chat-1');

    expect(mockApi.standaloneChat.init).toHaveBeenCalledWith('other');
    expect(mockApi.standaloneChat.readArchive).toHaveBeenCalledWith({
      chatId: 'other-chat-1',
      projectId: 'other',
    });
    expect(useStandaloneChatStore.getState().archiveOverlayChatId).toBe(
      'other-chat-1',
    );
  });

  it('switches to a non-active project before creating a work entry', async () => {
    mockApi.workEntries.list.mockResolvedValue({ entries: [otherEntry] });
    mockApi.workEntries.create.mockResolvedValue({
      entry: makeEntry('other-entry-new'),
      reusedExistingEmpty: false,
    });
    mockApi.standaloneChat.init.mockClear();

    await useStandaloneChatStore.getState().createWorkEntryInProject('other');

    expect(mockApi.standaloneChat.init).toHaveBeenCalledWith('other');
    expect(useStandaloneChatStore.getState().activeChatProjectId).toBe('other');
    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe(
      'other-entry-new',
    );
  });

  it('creates a work entry in the already-active project without switching', async () => {
    mockApi.workEntries.create.mockResolvedValue({
      entry: makeEntry('default-entry-new'),
      reusedExistingEmpty: false,
    });
    mockApi.workEntries.list.mockResolvedValue({
      entries: [makeEntry('default-entry-new')],
    });
    mockApi.standaloneChat.init.mockClear();

    await useStandaloneChatStore.getState().createWorkEntryInProject('default');

    // No project switch; delegates straight to createWorkEntry (whose
    // main-side reuse of an empty entry prevents duplicate empties).
    expect(mockApi.standaloneChat.init).not.toHaveBeenCalled();
    expect(useStandaloneChatStore.getState().activeChatProjectId).toBe(
      'default',
    );
    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe(
      'default-entry-new',
    );
  });

  it('activates a newly created Cowork project with an expanded visible entry', async () => {
    mockApi.chatProject.list.mockResolvedValue({
      projects: [
        {
          id: DEFAULT_COWORK_WORKSPACE_ID,
          name: 'Default',
          createdAt: '2024-01-01',
        },
        {
          id: 'cowork-new',
          name: 'New Cowork',
          createdAt: '2026-07-07',
        },
      ],
    });
    mockApi.workEntries.list.mockResolvedValue({ entries: [] });
    mockApi.workEntries.create.mockResolvedValue({
      entry: makeEntry('cowork-new-entry'),
      reusedExistingEmpty: false,
    });

    await useStandaloneChatStore
      .getState()
      .activateCreatedCoworkWorkspace('cowork-new');

    const state = useStandaloneChatStore.getState();
    expect(state.activeChatProjectId).toBe('cowork-new');
    expect(state.activeWorkEntryId).toBe('cowork-new-entry');
    expect(selectWorktreeMock).toHaveBeenCalledWith(
      'cowork-new',
      'cowork-new-entry',
    );
  });

  // A shared-container fork has main create the Cowork workspace directly, so
  // unlike `createChatProject` nothing appends it to the renderer's
  // `chatProjects`. Before the self-heal in `switchChatProject`, the forked
  // workspace was unreachable until an app restart.
  it('lists chat projects again before refusing a workspace main created after the last listing', async () => {
    mockApi.chatProject.list.mockResolvedValue({
      projects: [
        { id: 'default', name: 'Default', createdAt: '2024-01-01' },
        { id: 'other', name: 'Other', createdAt: '2024-01-01' },
        {
          id: 'forked-cowork',
          name: 'Customer follow-up',
          createdAt: '2026-07-07',
        },
      ],
    });
    mockApi.workEntries.list.mockResolvedValue({
      entries: [makeEntry('forked-entry')],
    });

    await expect(
      useStandaloneChatStore
        .getState()
        .openWorkEntryFromSidebar('forked-cowork', 'forked-entry'),
    ).resolves.toBeUndefined();

    const state = useStandaloneChatStore.getState();
    expect(state.activeChatProjectId).toBe('forked-cowork');
    expect(state.activeWorkEntryId).toBe('forked-entry');
  });

  it('refuses a workspace still absent after a fresh listing', async () => {
    mockApi.chatProject.list.mockResolvedValue({
      projects: [
        { id: 'default', name: 'Default', createdAt: '2024-01-01' },
        { id: 'other', name: 'Other', createdAt: '2024-01-01' },
      ],
    });

    await expect(
      useStandaloneChatStore
        .getState()
        .openWorkEntryFromSidebar('ghost-cowork', 'ghost-entry'),
    ).rejects.toThrow('Chat project not found');

    // Self-heal once, not a loop: a fresh listing without the workspace is
    // proof it is genuinely absent.
    expect(mockApi.chatProject.list).toHaveBeenCalledTimes(1);
  });

  it('does not re-list when the target workspace is already known', async () => {
    mockApi.workEntries.list.mockResolvedValue({
      entries: [makeEntry('other-entry-1')],
    });

    await useStandaloneChatStore
      .getState()
      .openWorkEntryFromSidebar('other', 'other-entry-1');

    expect(useStandaloneChatStore.getState().activeChatProjectId).toBe('other');
    expect(mockApi.chatProject.list).not.toHaveBeenCalled();
  });

  // The self-heal listing awaits *before* `switchChatProjectRequestId` is
  // bumped, so without its own supersession check an older switch would come
  // back from the listing, bump the id past the newer switch, and overwrite the
  // workspace the user actually clicked last. The newer switch's
  // `stillOwnsSwitch()` only makes it return `false`; nothing repairs the
  // clobber.
  it('abandons a self-heal listing that a newer project switch superseded', async () => {
    let releaseListing: () => void = () => undefined;
    const listingStarted = new Promise<void>((resolveStarted) => {
      mockApi.chatProject.list.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseListing = (): void =>
              resolve({
                projects: [
                  { id: 'default', name: 'Default', createdAt: '2024-01-01' },
                  { id: 'other', name: 'Other', createdAt: '2024-01-01' },
                  {
                    id: 'forked-cowork',
                    name: 'Customer follow-up',
                    createdAt: '2026-07-07',
                  },
                ],
              });
            resolveStarted();
          }),
      );
    });
    mockApi.workEntries.list.mockResolvedValue({
      entries: [makeEntry('other-entry-1')],
    });

    // Older switch blocks inside the self-heal listing.
    const stalled = useStandaloneChatStore
      .getState()
      .switchChatProject('forked-cowork');
    await listingStarted;

    // The user clicks a workspace the renderer already knows, so this switch
    // takes no await before the bump and completes first.
    await expect(
      useStandaloneChatStore.getState().switchChatProject('other'),
    ).resolves.toBe(true);
    expect(useStandaloneChatStore.getState().activeChatProjectId).toBe('other');

    releaseListing();

    // `false` is the established "superseded, abort" return, and unlike a
    // throw it does not fire the caller's failure toast.
    await expect(stalled).resolves.toBe(false);
    expect(useStandaloneChatStore.getState().activeChatProjectId).toBe('other');
  });

  // `loadChatProjects` resets `activeChatProjectId` to the default workspace
  // when the active one vanished, but leaves `workEntries` alone. Capturing the
  // outgoing pair after the listing would file the old workspace's entries
  // under the default workspace's sidebar row.
  it('caches outgoing entries under the workspace they belong to across a self-heal listing', async () => {
    const goneEntry = makeEntry('gone-entry-1', { title: 'Gone Entry' });
    useStandaloneChatStore.setState({
      chatProjects: [
        { id: 'default', name: 'Default', createdAt: '2024-01-01' },
        { id: 'gone', name: 'Gone', createdAt: '2024-01-01' },
      ],
      activeChatProjectId: 'gone',
      workEntries: [goneEntry],
    });
    // The fresh listing drops `gone` and adds the forked workspace.
    mockApi.chatProject.list.mockResolvedValue({
      projects: [
        { id: 'default', name: 'Default', createdAt: '2024-01-01' },
        {
          id: 'forked-cowork',
          name: 'Customer follow-up',
          createdAt: '2026-07-07',
        },
      ],
    });
    mockApi.workEntries.list.mockResolvedValue({
      entries: [makeEntry('forked-entry')],
    });

    await useStandaloneChatStore.getState().switchChatProject('forked-cowork');

    const { sidebarEntriesByProject } = useStandaloneChatStore.getState();
    expect(sidebarEntriesByProject.gone).toEqual([goneEntry]);
    // The default workspace never owned those entries; rendering them on its
    // row is the failure this guards.
    expect(
      sidebarEntriesByProject[DEFAULT_COWORK_WORKSPACE_ID],
    ).toBeUndefined();
  });
});

describe('standaloneChatStore createWorkEntry stale completions', () => {
  /** Holds the create IPC open; call the returned function to let it resolve. */
  function holdCreate(): () => void {
    let release: () => void = () => undefined;
    const pending = new Promise<{
      entry: CoworkWorkEntryMeta;
      reusedExistingEmpty: boolean;
    }>((resolve) => {
      release = (): void =>
        resolve({ entry: makeEntry('entry-new'), reusedExistingEmpty: false });
    });
    mockApi.workEntries.create.mockImplementation(() => pending);
    return (): void => release();
  }

  beforeEach(() => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: 'entry-a',
      workEntries: [makeEntry('entry-a'), makeEntry('entry-b')],
      chatProjects: [
        {
          id: DEFAULT_COWORK_WORKSPACE_ID,
          name: 'Default',
          createdAt: '2024-01-01',
        },
        { id: 'other', name: 'Other', createdAt: '2024-01-01' },
      ],
    });
    mockChatStore.setState({
      selectedWorktree: {
        projectId: DEFAULT_COWORK_WORKSPACE_ID,
        worktreeId: 'entry-a',
      },
    });
    mockApi.workEntries.list.mockResolvedValue({
      entries: [
        makeEntry('entry-new'),
        makeEntry('entry-a'),
        makeEntry('entry-b'),
      ],
    });
  });

  it('still selects the created entry when nothing newer happened', async () => {
    mockApi.workEntries.create.mockResolvedValue({
      entry: makeEntry('entry-new'),
      reusedExistingEmpty: false,
    });

    await useStandaloneChatStore.getState().createWorkEntry();

    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe(
      'entry-new',
    );
  });

  it('does not override a Cowork entry the user opened while the create was in flight', async () => {
    const release = holdCreate();
    const creating = useStandaloneChatStore.getState().createWorkEntry();
    await Promise.resolve();
    await useStandaloneChatStore.getState().selectWorkEntry('entry-b');
    release();
    await creating;

    // The newer, explicit choice wins over the stale create.
    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe('entry-b');
  });

  it('does not select into a Cowork project the user switched to meanwhile', async () => {
    const release = holdCreate();
    const creating = useStandaloneChatStore.getState().createWorkEntry();
    await Promise.resolve();
    useStandaloneChatStore.setState({
      activeChatProjectId: 'other',
      activeWorkEntryId: 'entry-other',
    });
    release();
    await creating;

    // The created entry belongs to the project the user left; pairing it with
    // 'other' would also be persisted as the MRU context.
    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe(
      'entry-other',
    );
    expect(selectWorktreeMock).not.toHaveBeenCalledWith(
      'other',
      'entry-new',
      expect.anything(),
    );
  });

  it('does not pull the user off a Code worktree they opened meanwhile', async () => {
    const release = holdCreate();
    const creating = useStandaloneChatStore.getState().createWorkEntry();
    await Promise.resolve();
    // Code worktree selection goes through chatStore only; it never touches
    // the Cowork destination counter.
    mockChatStore.setState({
      selectedWorktree: { projectId: 'code-project', worktreeId: 'wt-1' },
    });
    release();
    await creating;

    expect(mockChatStore.getState().selectedWorktree).toEqual({
      projectId: 'code-project',
      worktreeId: 'wt-1',
    });
  });
});

describe('standaloneChatStore createWorkEntry page re-assert', () => {
  /** Holds the create IPC open; call the returned function to let it resolve. */
  function holdCreate(): () => void {
    let release: () => void = () => undefined;
    const pending = new Promise<{
      entry: CoworkWorkEntryMeta;
      reusedExistingEmpty: boolean;
    }>((resolve) => {
      release = (): void =>
        resolve({ entry: makeEntry('entry-new'), reusedExistingEmpty: false });
    });
    mockApi.workEntries.create.mockImplementation(() => pending);
    return (): void => release();
  }

  beforeEach(() => {
    useStandaloneChatStore.setState({
      initialized: true,
      activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
      activeWorkEntryId: 'entry-a',
      workEntries: [makeEntry('entry-a'), makeEntry('entry-b')],
    });
    mockApi.workEntries.list.mockResolvedValue({
      entries: [
        makeEntry('entry-new'),
        makeEntry('entry-a'),
        makeEntry('entry-b'),
      ],
    });
  });

  // The "+" clicked from the New task page: leaving the chat page cleared the
  // chat selection, then navigate('chat') remounts StandaloneChatPage, whose
  // mount effect puts the retained Cowork entry back. That is setup, not a
  // newer user choice, so the create must still open its new task.
  it('still opens the new task when the chat page re-asserts the retained entry (from nothing selected)', async () => {
    mockChatStore.setState({ selectedWorktree: null });
    const release = holdCreate();
    const creating = useStandaloneChatStore.getState().createWorkEntry();
    await Promise.resolve();
    mockChatStore.setState({
      selectedWorktree: {
        projectId: DEFAULT_COWORK_WORKSPACE_ID,
        worktreeId: 'entry-a',
      },
    });
    release();
    await creating;

    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe(
      'entry-new',
    );
  });

  // Same, clicked from a Code page: leaving the chat page restored the Code
  // worktree, and the remount swaps it for the retained Cowork entry.
  it('still opens the new task when the chat page re-asserts the retained entry (from a Code worktree)', async () => {
    mockChatStore.setState({
      selectedWorktree: { projectId: 'code-project', worktreeId: 'wt-1' },
    });
    const release = holdCreate();
    const creating = useStandaloneChatStore.getState().createWorkEntry();
    await Promise.resolve();
    mockChatStore.setState({
      selectedWorktree: {
        projectId: DEFAULT_COWORK_WORKSPACE_ID,
        worktreeId: 'entry-a',
      },
    });
    release();
    await creating;

    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe(
      'entry-new',
    );
  });
});
