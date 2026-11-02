/**
 * Coverage for the file-tab additions to chatStore: `openFileTab`, the
 * kind-aware guards in lifecycle paths (`syncActiveEmptyTabToDefaults`,
 * `switchTab` via `shouldRequestVisibleTabDiscovery`), and persistence
 * round-tripping of `kind` / `filePath` through `loadTabs`.
 */
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import type {
  AdhocMultiRepoCombineResponse,
  CanopyApi,
  ChatAdhocMigrateTabsResponse,
  ChatForkOpenWorktreeTabsResponse,
  ChatTabsFile,
} from '@canopy/desktop-shared/types';
import type {
  CanopyClient,
  CommandMap,
  CommandName,
  QueryMap,
  QueryName,
  Unsubscribe,
} from '@canopy/app-core';
import { buildPipelineRunArtifactReceipt } from '@canopy/desktop-shared/lib/agent-artifacts';
import type * as AppAdvisorWatchersStoreModule from '../appAdvisorWatchersStore';
import type * as ChatStoreModule from '../chatStore';
import type * as ClaudeTerminalStoreModule from '../claudeTerminalStore';
import type { ChatTab } from '../chatStore';
import type * as ControllerModule from '../../lib/file-viewer/desktop-file-session-controller';
import type * as FileTabUiModule from '../fileTabUiStore';
import type * as AppStateModule from '@canopy/app-state';
import type * as NavigationStoreModule from '../navigationStore';
import type * as TabScrollPositionsModule from '../../lib/tab-scroll-positions';
import type * as LastViewModeModule from '../../lib/file-viewer/last-view-mode';

const flushScopeMock = jest.fn<Promise<void>, [unknown]>();
const forkOpenWorktreeTabsMock = jest.fn<
  Promise<ChatForkOpenWorktreeTabsResponse>,
  [unknown]
>();
const adhocMigrateTabsMock = jest.fn<
  Promise<ChatAdhocMigrateTabsResponse>,
  [unknown]
>();
const loadTabsApiMock = jest.fn<Promise<ChatTabsFile>, [unknown]>();
const sendMessageApiMock = jest.fn<Promise<void>, [unknown]>();
const activeSessionsMock = jest.fn<
  Promise<{ activeChatIds: string[]; sessions: unknown[] }>,
  [unknown]
>();
const discoverWorktreeEnvMock = jest.fn<Promise<void>, [unknown]>();
const getDiffStatsBatchMock = jest.fn<Promise<unknown[]>, [unknown]>();
const loadPreferencesMock = jest.fn<Promise<Record<string, unknown>>, []>();
const savePreferencesMock = jest.fn<Promise<void>, [unknown]>();
const setForegroundWorktreeMock = jest.fn<Promise<void>, [unknown]>();
const requestFastRefreshMock = jest.fn<Promise<void>, [unknown]>();
const requestKnownPrFastRefreshMock = jest.fn<Promise<boolean>, [unknown]>();
const terminalWriteMock = jest.fn<Promise<void>, [unknown]>();
const terminalOnExitMock = jest.fn<() => void, [unknown]>();
const claudeTerminalCleanupMock = jest.fn<Promise<void>, [unknown]>();
const claudeTerminalGetStateMock = jest.fn<
  Promise<unknown>,
  [string, string, string]
>();
const claudeTerminalSyncTranscriptMock = jest.fn(() =>
  Promise.resolve({ chatId: 'chat', importedEventCount: 0 }),
);
const claudeTerminalOnStateChangedMock = jest.fn<() => void, [unknown]>();
const claudeTerminalOnSyncCompletedMock = jest.fn<() => void, [unknown]>();
const claudeTerminalOnErrorMock = jest.fn<() => void, [unknown]>();
const saveFileContentMock = jest.fn<
  Promise<{ filename: string; sizeBytes: number; modifiedAtMs: number }>,
  [unknown]
>();
const getWorktreePathMock = jest.fn<Promise<string>, [unknown]>();
const forkCodexThreadMock = jest.fn<
  Promise<{ forkedThreadId: string }>,
  [unknown]
>();

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface Global {
      window: { api: CanopyApi };
    }
  }
}

function loadChatStore(): typeof ChatStoreModule {
  jest.resetModules();
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: {
      api: {
        chat: {
          flushScope: flushScopeMock,
          forkOpenWorktreeTabs: forkOpenWorktreeTabsMock,
          adhocMigrateTabs: adhocMigrateTabsMock,
          loadTabs: loadTabsApiMock,
          sendMessage: sendMessageApiMock,
          activeSessions: activeSessionsMock,
          forkCodexThread: forkCodexThreadMock,
        },
        github: {
          setForegroundWorktree: setForegroundWorktreeMock,
          requestFastRefresh: requestFastRefreshMock,
          requestKnownPrFastRefresh: requestKnownPrFastRefreshMock,
        },
        terminal: {
          write: terminalWriteMock,
          onExit: terminalOnExitMock,
        },
        claudeTerminal: {
          cleanup: claudeTerminalCleanupMock,
          getState: claudeTerminalGetStateMock,
          syncTranscript: claudeTerminalSyncTranscriptMock,
          onStateChanged: claudeTerminalOnStateChangedMock,
          onSyncCompleted: claudeTerminalOnSyncCompletedMock,
          onError: claudeTerminalOnErrorMock,
        },
        getDiffStatsBatch: getDiffStatsBatchMock,
        discoverWorktreeEnv: discoverWorktreeEnvMock,
        loadPreferences: loadPreferencesMock,
        savePreferences: savePreferencesMock,
        saveFileContent: saveFileContentMock,
        getWorktreePath: getWorktreePathMock,
      },
    },
  });

  return jest.requireActual<typeof ChatStoreModule>('../chatStore');
}

const PROJECT_ID = 'project';
const WORKTREE_ID = 'worktree';
const KEY = `${PROJECT_ID}/${WORKTREE_ID}`;

function makeChatTab(id: string, overrides?: Partial<ChatTab>): ChatTab {
  return {
    id,
    title: `Chat ${id}`,
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-04-25T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
    ...overrides,
  };
}

function makeFileTab(
  id: string,
  filePath: string,
  overrides?: Partial<ChatTab>,
): ChatTab {
  const filename = filePath.split('/').pop();
  if (!filename) {
    throw new Error(`Expected a filename in path: ${filePath}`);
  }

  return makeChatTab(id, {
    kind: 'file',
    title: filename,
    filePath,
    description: filePath,
    ...overrides,
  });
}

function emptyTabsFile(): ChatTabsFile {
  return { version: 1, tabs: [], activeTabId: '' };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolvePromise: ((value: T) => void) | null = null;
  let rejectPromise: ((error: Error) => void) | null = null;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  if (!resolvePromise || !rejectPromise) {
    throw new Error('Deferred promise handlers were not initialized');
  }

  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

beforeEach(() => {
  jest.useFakeTimers();
  flushScopeMock.mockReset();
  flushScopeMock.mockResolvedValue(undefined);
  forkOpenWorktreeTabsMock.mockReset();
  forkOpenWorktreeTabsMock.mockResolvedValue({ tabBindings: {} });
  adhocMigrateTabsMock.mockReset();
  adhocMigrateTabsMock.mockResolvedValue({ migratedTabIds: [] });
  loadTabsApiMock.mockReset();
  loadTabsApiMock.mockResolvedValue(emptyTabsFile());
  sendMessageApiMock.mockReset();
  sendMessageApiMock.mockResolvedValue(undefined);
  activeSessionsMock.mockReset();
  activeSessionsMock.mockResolvedValue({ activeChatIds: [], sessions: [] });
  discoverWorktreeEnvMock.mockReset();
  discoverWorktreeEnvMock.mockResolvedValue(undefined);
  getDiffStatsBatchMock.mockReset();
  getDiffStatsBatchMock.mockResolvedValue([]);
  loadPreferencesMock.mockReset();
  loadPreferencesMock.mockResolvedValue({
    defaultChatProvider: 'claude',
    defaultChatModelByProvider: {
      claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
    },
    defaultWorktreeProvider: 'claude',
    defaultWorktreeModelByProvider: {
      claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
    },
  });
  savePreferencesMock.mockReset();
  savePreferencesMock.mockResolvedValue(undefined);
  setForegroundWorktreeMock.mockReset();
  setForegroundWorktreeMock.mockResolvedValue(undefined);
  requestFastRefreshMock.mockReset();
  requestFastRefreshMock.mockResolvedValue(undefined);
  requestKnownPrFastRefreshMock.mockReset();
  requestKnownPrFastRefreshMock.mockResolvedValue(true);
  terminalWriteMock.mockReset();
  terminalWriteMock.mockResolvedValue(undefined);
  terminalOnExitMock.mockReset();
  terminalOnExitMock.mockReturnValue(() => undefined);
  claudeTerminalCleanupMock.mockReset();
  claudeTerminalCleanupMock.mockResolvedValue(undefined);
  claudeTerminalGetStateMock.mockReset();
  claudeTerminalGetStateMock.mockResolvedValue({
    terminalId: 'terminal-1',
    turnState: 'idle',
    readyForInput: true,
  });
  claudeTerminalSyncTranscriptMock.mockReset();
  claudeTerminalSyncTranscriptMock.mockResolvedValue({
    chatId: 'chat',
    importedEventCount: 0,
  });
  claudeTerminalOnStateChangedMock.mockReset();
  claudeTerminalOnStateChangedMock.mockReturnValue(() => undefined);
  claudeTerminalOnSyncCompletedMock.mockReset();
  claudeTerminalOnSyncCompletedMock.mockReturnValue(() => undefined);
  claudeTerminalOnErrorMock.mockReset();
  claudeTerminalOnErrorMock.mockReturnValue(() => undefined);
  saveFileContentMock.mockReset();
  saveFileContentMock.mockResolvedValue({
    filename: 'notes.md',
    sizeBytes: 1,
    modifiedAtMs: 2000,
  });
  getWorktreePathMock.mockReset();
  getWorktreePathMock.mockResolvedValue('/worktrees/worktree');
  forkCodexThreadMock.mockReset();
  forkCodexThreadMock.mockResolvedValue({ forkedThreadId: 'forked-thread' });
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  jest.resetModules();
});

describe('openFileTab', () => {
  it('targets an explicit worktree even when another worktree is selected', () => {
    const { useChatStore } = loadChatStore();
    const target = { projectId: 'project-2', worktreeId: 'worktree-2' };
    const targetKey = `${target.projectId}/${target.worktreeId}`;

    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [KEY]: { tabs: [], activeTabId: '' },
        [targetKey]: { tabs: [], activeTabId: '' },
      },
    });

    const tabId = useChatStore.getState().openFileTab(
      {
        absolutePath: '/target/path/notes.md',
        filename: 'notes.md',
      },
      target,
    );
    expect(tabId).not.toBeNull();
    expect(useChatStore.getState().worktreeChats[KEY].tabs).toHaveLength(0);
    expect(useChatStore.getState().worktreeChats[targetKey].tabs).toHaveLength(
      1,
    );

    useChatStore.getState().setFileTabViewMode(tabId ?? '', 'preview', target);
    expect(
      useChatStore.getState().worktreeChats[targetKey].tabs[0].fileViewMode,
    ).toBe('preview');
  });

  it('creates only the file tab when worktree chats have not loaded yet', () => {
    const { useChatStore } = loadChatStore();

    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
    });

    useChatStore.getState().openFileTab({
      absolutePath: '/abs/path/notes.md',
      filename: 'notes.md',
    });

    const wc = useChatStore.getState().worktreeChats[KEY];
    expect(wc.tabs).toHaveLength(1);
    expect(wc.tabs[0].kind).toBe('file');
    expect(wc.tabs[0].title).toBe('notes.md');
    expect(wc.tabs[0].description).toBe('/abs/path/notes.md');
    expect(wc.activeTabId).toBe(wc.tabs[0].id);
    expect(
      wc.tabs.some(
        (tab) => tab.kind !== 'file' && tab.title === `New ${CHAT_UNIT_LABEL}`,
      ),
    ).toBe(false);
    expect(discoverWorktreeEnvMock).not.toHaveBeenCalled();
  });

  it('creates a new file tab with kind/filePath/title and switches to it', () => {
    const { useChatStore } = loadChatStore();

    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: { [KEY]: { tabs: [], activeTabId: '' } },
    });

    useChatStore.getState().openFileTab({
      absolutePath: '/abs/path/notes.md',
      filename: 'notes.md',
    });

    const wc = useChatStore.getState().worktreeChats[KEY];
    expect(wc.tabs).toHaveLength(1);
    const tab = wc.tabs[0];
    expect(tab.kind).toBe('file');
    expect(tab.filePath).toBe('/abs/path/notes.md');
    expect(tab.title).toBe('notes.md');
    expect(tab.description).toBe('/abs/path/notes.md');
    expect(tab.messages).toEqual([]);
    expect(tab.status).toBe('idle');
    expect(wc.activeTabId).toBe(tab.id);

    expect(discoverWorktreeEnvMock).not.toHaveBeenCalled();
  });

  it('preserves the remembered editable chat when opening a new file tab', () => {
    const { useChatStore } = loadChatStore();
    const chatTab: ChatTab = {
      id: 'chat-1',
      title: 'Chat',
      messages: [],
      status: 'idle',
      error: null,
      createdAt: '2026-07-24T00:00:00.000Z',
      queuedMessages: [],
      planMode: false,
      proposalMode: 'optional',
      thinkingLevel: 'high',
      modelConfig: {
        thinkingLevel: 'high',
        speed: 'standard',
        fastMode: false,
      },
      fastModeExplicit: false,
    };

    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [KEY]: {
          tabs: [chatTab],
          activeTabId: chatTab.id,
          lastActiveEditableChatId: chatTab.id,
        },
      },
    });

    useChatStore.getState().openFileTab({
      absolutePath: '/abs/path/notes.md',
      filename: 'notes.md',
    });

    const wc = useChatStore.getState().worktreeChats[KEY];
    expect(wc.activeTabId).not.toBe(chatTab.id);
    expect(wc.lastActiveEditableChatId).toBe(chatTab.id);
  });

  it('remembers a newly created chat after opening a file tab', () => {
    const { useChatStore } = loadChatStore();
    const originalChat = makeChatTab('chat-1');

    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [KEY]: {
          tabs: [originalChat],
          activeTabId: originalChat.id,
          lastActiveEditableChatId: originalChat.id,
        },
      },
    });

    useChatStore.getState().createTab();
    const createdChatId =
      useChatStore.getState().worktreeChats[KEY].activeTabId;

    useChatStore.getState().openFileTab({
      absolutePath: '/abs/path/notes.md',
      filename: 'notes.md',
    });

    const wc = useChatStore.getState().worktreeChats[KEY];
    expect(wc.activeTabId).not.toBe(createdChatId);
    expect(wc.lastActiveEditableChatId).toBe(createdChatId);
  });

  it('remembers a newly forked chat after opening a file tab', () => {
    const { useChatStore } = loadChatStore();
    const sourceChat = makeChatTab('chat-1', {
      messages: [
        {
          id: 'message-1',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'Fork this chat' }],
        },
      ],
    });

    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [KEY]: {
          tabs: [sourceChat],
          activeTabId: sourceChat.id,
          lastActiveEditableChatId: sourceChat.id,
        },
      },
    });

    useChatStore.getState().forkTab(sourceChat.id);
    const forkedChatId = useChatStore.getState().worktreeChats[KEY].activeTabId;

    useChatStore.getState().openFileTab({
      absolutePath: '/abs/path/notes.md',
      filename: 'notes.md',
    });

    const wc = useChatStore.getState().worktreeChats[KEY];
    expect(forkedChatId).not.toBe(sourceChat.id);
    expect(wc.activeTabId).not.toBe(forkedChatId);
    expect(wc.lastActiveEditableChatId).toBe(forkedChatId);
  });

  it('dedups by absolutePath — second call switches to the existing tab', () => {
    const { useChatStore } = loadChatStore();

    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: { [KEY]: { tabs: [], activeTabId: '' } },
    });

    useChatStore.getState().openFileTab({
      absolutePath: '/abs/path/notes.md',
      filename: 'notes.md',
    });
    const firstId = useChatStore.getState().worktreeChats[KEY].tabs[0].id;

    // Switch focus to a different tab so we can verify the second open
    // re-activates the existing file tab rather than no-oping.
    useChatStore.setState((state) => ({
      worktreeChats: {
        ...state.worktreeChats,
        [KEY]: {
          ...state.worktreeChats[KEY],
          activeTabId: '',
        },
      },
    }));

    useChatStore.getState().openFileTab({
      absolutePath: '/abs/path/notes.md',
      filename: 'notes.md',
    });

    const wc = useChatStore.getState().worktreeChats[KEY];
    expect(wc.tabs).toHaveLength(1);
    expect(wc.tabs[0].id).toBe(firstId);
    expect(wc.activeTabId).toBe(firstId);

    expect(discoverWorktreeEnvMock).not.toHaveBeenCalled();
  });

  it('seeds initialViewMode on the tab it creates', () => {
    const { useChatStore } = loadChatStore();

    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: { [KEY]: { tabs: [], activeTabId: '' } },
    });

    useChatStore.getState().openFileTab({
      absolutePath: '/abs/path/notes.md',
      filename: 'notes.md',
      initialViewMode: 'preview',
    });
    useChatStore.getState().openFileTab({
      absolutePath: '/abs/path/rows.csv',
      filename: 'rows.csv',
      initialViewMode: 'table',
    });
    useChatStore.getState().openFileTab({
      absolutePath: '/abs/path/index.ts',
      filename: 'index.ts',
    });

    const tabs = useChatStore.getState().worktreeChats[KEY].tabs;
    expect(tabs.map((tab) => tab.fileViewMode)).toEqual([
      'preview',
      'table',
      undefined,
    ]);
  });

  it('ignores initialViewMode when the file is already open', () => {
    const { useChatStore } = loadChatStore();

    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: { [KEY]: { tabs: [], activeTabId: '' } },
    });

    const tabId = useChatStore.getState().openFileTab({
      absolutePath: '/abs/path/notes.md',
      filename: 'notes.md',
      initialViewMode: 'preview',
    });
    // The user switched the open tab back to source.
    useChatStore.getState().setFileTabViewMode(tabId ?? '', 'raw');

    const reopenedId = useChatStore.getState().openFileTab({
      absolutePath: '/abs/path/notes.md',
      filename: 'notes.md',
      initialViewMode: 'preview',
    });

    const tabs = useChatStore.getState().worktreeChats[KEY].tabs;
    expect(reopenedId).toBe(tabId);
    expect(tabs).toHaveLength(1);
    expect(tabs[0].fileViewMode).toBe('raw');
  });

  it('hydrates persisted chats even when a file tab already exists locally', async () => {
    const { useChatStore } = loadChatStore();

    loadTabsApiMock.mockResolvedValueOnce({
      version: 1,
      tabs: [
        {
          id: 'chat-1',
          title: 'Chat',
          messages: [],
          createdAt: '2026-04-25T00:00:00.000Z',
        },
      ],
      activeTabId: 'chat-1',
    });

    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
    });

    useChatStore.getState().openFileTab({
      absolutePath: '/abs/path/notes.md',
      filename: 'notes.md',
    });

    await useChatStore.getState().loadTabs();

    const wc = useChatStore.getState().worktreeChats[KEY];
    expect(wc.tabs.map((tab) => tab.id)).toEqual(
      expect.arrayContaining(['chat-1']),
    );
    expect(
      wc.tabs.some(
        (tab) => tab.kind === 'file' && tab.filePath === '/abs/path/notes.md',
      ),
    ).toBe(true);
    expect(wc.activeTabId).not.toBe('chat-1');
  });

  it('preserves unresolved persisted Agent model ids during hydration', async () => {
    const { useChatStore } = loadChatStore();

    loadTabsApiMock.mockResolvedValueOnce({
      version: 1,
      tabs: [
        {
          id: 'chat-1',
          title: 'Chat',
          messages: [],
          createdAt: '2026-04-25T00:00:00.000Z',
          model: 'agent_model_deleted_reviewer',
        },
      ],
      activeTabId: 'chat-1',
    });

    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
    });

    await useChatStore.getState().loadTabs();

    const wc = useChatStore.getState().worktreeChats[KEY];
    expect(wc.tabs[0].model).toBe('agent_model_deleted_reviewer');
  });

  it('merges a file tab opened while hydration is in flight', async () => {
    const { useChatStore } = loadChatStore();
    const deferredTabs = createDeferred<ChatTabsFile>();

    loadTabsApiMock.mockReturnValueOnce(deferredTabs.promise);
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
    });

    const loadPromise = useChatStore.getState().loadTabs();

    useChatStore.getState().openFileTab({
      absolutePath: '/abs/path/notes.md',
      filename: 'notes.md',
    });

    deferredTabs.resolve({
      version: 1,
      tabs: [
        {
          id: 'chat-1',
          title: 'Chat',
          messages: [],
          createdAt: '2026-04-25T00:00:00.000Z',
        },
      ],
      activeTabId: 'chat-1',
    });
    await loadPromise;

    const wc = useChatStore.getState().worktreeChats[KEY];
    expect(wc.tabs).toHaveLength(2);
    expect(
      wc.tabs.some(
        (tab) => tab.kind === 'file' && tab.filePath === '/abs/path/notes.md',
      ),
    ).toBe(true);
    expect(wc.tabs.some((tab) => tab.id === 'chat-1')).toBe(true);
  });

  it('adds path context when duplicate filenames are open', () => {
    const { useChatStore } = loadChatStore();

    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: { [KEY]: { tabs: [], activeTabId: '' } },
    });

    useChatStore.getState().openFileTab({
      absolutePath: '/repo/src/index.ts',
      filename: 'index.ts',
    });
    useChatStore.getState().openFileTab({
      absolutePath: '/repo/tests/index.ts',
      filename: 'index.ts',
    });

    const fileTabs = useChatStore
      .getState()
      .worktreeChats[KEY].tabs.filter((tab) => tab.kind === 'file');
    expect(fileTabs.map((tab) => tab.title)).toEqual([
      'src/index.ts',
      'tests/index.ts',
    ]);
    expect(fileTabs.map((tab) => tab.description)).toEqual([
      '/repo/src/index.ts',
      '/repo/tests/index.ts',
    ]);
  });
});

// The deep migration semantics (clone dedupe across retries, selectedRepoId
// remaps, file-path rewrites, Codex thread forks, destination merges) are
// main-owned now and covered by the main-process adhoc-migrate-tabs tests.
// These wrapper tests cover the renderer store action: the IPC request it
// sends and the local source-scope cleanup + destination reload it performs.
describe('createEmptyFileTab / assignFileTab', () => {
  it('creates an empty file tab (no dedupe) and activates it', () => {
    const { useChatStore } = loadChatStore();

    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: { [KEY]: { tabs: [], activeTabId: '' } },
    });

    const first = useChatStore.getState().createEmptyFileTab();
    const second = useChatStore.getState().createEmptyFileTab();

    const wc = useChatStore.getState().worktreeChats[KEY];
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(wc.tabs).toHaveLength(2);
    expect(wc.tabs[0].kind).toBe('file');
    expect(wc.tabs[0].filePath).toBe('');
    expect(wc.tabs[0].title).toBe('Open file');
    expect(wc.activeTabId).toBe(second);
  });

  it('assigns a file into an empty tab in place', () => {
    const { useChatStore } = loadChatStore();

    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: { [KEY]: { tabs: [], activeTabId: '' } },
    });

    const tabId = useChatStore.getState().createEmptyFileTab();
    const assigned = useChatStore.getState().assignFileTab(tabId ?? '', {
      absolutePath: '/abs/path/notes.md',
      filename: 'notes.md',
    });

    expect(assigned).toBe(tabId);
    const wc = useChatStore.getState().worktreeChats[KEY];
    expect(wc.tabs).toHaveLength(1);
    expect(wc.tabs[0].filePath).toBe('/abs/path/notes.md');
    expect(wc.tabs[0].title).toBe('notes.md');
    expect(wc.tabs[0].description).toBe('/abs/path/notes.md');
    expect(wc.activeTabId).toBe(tabId);
  });

  it('activates an existing tab instead of assigning an already-open file', () => {
    const { useChatStore } = loadChatStore();

    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: { [KEY]: { tabs: [], activeTabId: '' } },
    });

    const existingId = useChatStore.getState().openFileTab({
      absolutePath: '/abs/path/notes.md',
      filename: 'notes.md',
    });
    const emptyId = useChatStore.getState().createEmptyFileTab();
    const assigned = useChatStore.getState().assignFileTab(emptyId ?? '', {
      absolutePath: '/abs/path/notes.md',
      filename: 'notes.md',
    });

    expect(assigned).toBe(existingId);
    const wc = useChatStore.getState().worktreeChats[KEY];
    // The empty tab stays empty; the existing tab becomes active.
    const emptyTab = wc.tabs.find((tab) => tab.id === emptyId);
    expect(emptyTab?.filePath).toBe('');
    expect(wc.activeTabId).toBe(existingId);
  });

  it('returns null for an unknown or non-file tab', () => {
    const { useChatStore } = loadChatStore();

    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: { [KEY]: { tabs: [], activeTabId: '' } },
    });

    expect(
      useChatStore.getState().assignFileTab('missing-tab', {
        absolutePath: '/abs/path/notes.md',
        filename: 'notes.md',
      }),
    ).toBeNull();
  });
});

describe('file view mode defaults and session memory (CAN-4955)', () => {
  function open(
    useChatStore: (typeof ChatStoreModule)['useChatStore'],
    absolutePath: string,
    initialViewMode?: ChatTab['fileViewMode'],
    target?: { projectId: string; worktreeId: string },
  ): ChatTab | undefined {
    const filename = absolutePath.split('/').pop() ?? absolutePath;
    const tabId = useChatStore.getState().openFileTab(
      {
        absolutePath,
        filename,
        ...(initialViewMode ? { initialViewMode } : {}),
      },
      target,
    );
    const key = target ? `${target.projectId}/${target.worktreeId}` : KEY;
    return useChatStore
      .getState()
      .worktreeChats[key]?.tabs.find((tab) => tab.id === tabId);
  }

  function setup(): (typeof ChatStoreModule)['useChatStore'] {
    const { useChatStore } = loadChatStore();
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [KEY]: { tabs: [makeChatTab('chat-1')], activeTabId: 'chat-1' },
      },
    });
    return useChatStore;
  }

  it('opens fresh files in their kind default', () => {
    const useChatStore = setup();
    expect(open(useChatStore, '/abs/notes.md')?.fileViewMode).toBe('preview');
    expect(open(useChatStore, '/abs/page.htm')?.fileViewMode).toBe('preview');
    expect(open(useChatStore, '/abs/rows.csv')?.fileViewMode).toBe('table');
    expect(open(useChatStore, '/abs/index.ts')?.fileViewMode).toBeUndefined();
  });

  it('restores Source and Formatted choices after close from any entry point', () => {
    const useChatStore = setup();
    const first = open(useChatStore, '/abs/notes.md');
    useChatStore.getState().setFileTabViewMode(first?.id ?? '', 'raw');
    useChatStore.getState().closeTab(first?.id ?? '');

    const reopened = open(useChatStore, '/abs/notes.md');
    expect(reopened?.fileViewMode).toBe('raw');
    useChatStore.getState().setFileTabViewMode(reopened?.id ?? '', 'preview');
    useChatStore.getState().closeTab(reopened?.id ?? '');

    expect(open(useChatStore, '/abs/notes.md')?.fileViewMode).toBe('preview');
  });

  it('lets an explicit mode beat memory without changing an open tab', () => {
    const useChatStore = setup();
    const first = open(useChatStore, '/abs/notes.md');
    useChatStore.getState().setFileTabViewMode(first?.id ?? '', 'raw');
    // Already open: the supplied mode is ignored.
    expect(open(useChatStore, '/abs/notes.md', 'preview')?.fileViewMode).toBe(
      'raw',
    );
    useChatStore.getState().closeTab(first?.id ?? '');
    expect(open(useChatStore, '/abs/notes.md', 'preview')?.fileViewMode).toBe(
      'preview',
    );
  });

  it('restores the last reading mode after a detour through Diff', () => {
    const useChatStore = setup();
    const chosen = open(useChatStore, '/abs/notes.md');
    useChatStore.getState().setFileTabViewMode(chosen?.id ?? '', 'raw');
    useChatStore.getState().setFileTabViewMode(chosen?.id ?? '', 'diff');
    useChatStore.getState().closeTab(chosen?.id ?? '');
    expect(open(useChatStore, '/abs/notes.md')?.fileViewMode).toBe('raw');

    const fresh = open(useChatStore, '/abs/other.md');
    useChatStore.getState().setFileTabViewMode(fresh?.id ?? '', 'diff');
    useChatStore.getState().closeTab(fresh?.id ?? '');
    expect(open(useChatStore, '/abs/other.md')?.fileViewMode).toBe('preview');
  });

  it('remembers restored modes from an individual and a bulk close', () => {
    const { useChatStore } = loadChatStore();
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [KEY]: {
          tabs: [
            makeChatTab('chat-1'),
            makeFileTab('file-a', '/abs/a.md', { fileViewMode: 'raw' }),
            makeFileTab('file-b', '/abs/b.md', { fileViewMode: 'raw' }),
            makeFileTab('file-c', '/abs/c.csv', { fileViewMode: 'raw' }),
          ],
          activeTabId: 'chat-1',
        },
      },
    });

    useChatStore.getState().closeTab('file-a');
    useChatStore.getState().closeTabs(['file-b', 'file-c']);

    expect(open(useChatStore, '/abs/a.md')?.fileViewMode).toBe('raw');
    expect(open(useChatStore, '/abs/b.md')?.fileViewMode).toBe('raw');
    expect(open(useChatStore, '/abs/c.csv')?.fileViewMode).toBe('raw');
  });

  it('keeps a restored Source mode through Diff without requiring another toggle', () => {
    const useChatStore = setup();
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          tabs: [
            makeChatTab('chat-1'),
            makeFileTab('restored-file', '/abs/restored.md', {
              fileViewMode: 'raw',
            }),
          ],
          activeTabId: 'restored-file',
        },
      },
    });
    useChatStore.getState().setFileTabViewMode('restored-file', 'diff');
    useChatStore.getState().closeTab('restored-file');
    expect(open(useChatStore, '/abs/restored.md')?.fileViewMode).toBe('raw');
  });

  it('keeps memory separate per worktree', () => {
    const useChatStore = setup();
    const first = open(useChatStore, '/abs/notes.md');
    useChatStore.getState().setFileTabViewMode(first?.id ?? '', 'raw');
    useChatStore.getState().closeTab(first?.id ?? '');

    expect(
      open(useChatStore, '/abs/notes.md', undefined, {
        projectId: PROJECT_ID,
        worktreeId: 'other-worktree',
      })?.fileViewMode,
    ).toBe('preview');
  });

  it('resolves an assigned file afresh instead of keeping the empty tab mode', () => {
    const useChatStore = setup();
    const first = open(useChatStore, '/abs/notes.md');
    useChatStore.getState().setFileTabViewMode(first?.id ?? '', 'raw');
    useChatStore.getState().closeTab(first?.id ?? '');

    const assign = (absolutePath: string): ChatTab | undefined => {
      const emptyId = useChatStore.getState().createEmptyFileTab() ?? '';
      useChatStore.getState().setFileTabViewMode(emptyId, 'table');
      useChatStore.getState().assignFileTab(emptyId, {
        absolutePath,
        filename: absolutePath.split('/').pop() ?? absolutePath,
      });
      return useChatStore
        .getState()
        .worktreeChats[KEY]?.tabs.find((tab) => tab.id === emptyId);
    };

    expect(assign('/abs/notes.md')?.fileViewMode).toBe('raw');
    expect(assign('/abs/fresh.md')?.fileViewMode).toBe('preview');
    const code = assign('/abs/index.ts');
    expect(code).toBeDefined();
    expect(code).not.toHaveProperty('fileViewMode');
  });
});

describe('migrateWorktreeTabsToAdhocWorkspace', () => {
  function makeCombineResponse(
    overrides?: Partial<AdhocMultiRepoCombineResponse>,
  ): AdhocMultiRepoCombineResponse {
    return {
      sourceWorkspaceId: 'source',
      sourceWorktreeId: 'source-wt',
      destinationWorkspaceId: 'dest',
      destinationWorktreeId: 'dest-wt',
      destinationWorkspace: {
        type: 'multi-repo',
        id: 'dest',
        name: 'Destination',
        color: '#123456',
        repos: [],
        worktrees: [],
        collapsed: false,
        order: 0,
      },
      destinationWorktree: {
        id: 'dest-wt',
        branchName: 'feature',
        createdAt: '2026-04-25T00:00:00.000Z',
        setupPhase: 'git-ready',
      },
      repoMappings: [],
      selectedRepoIdRewrites: { 'old-repo': 'new-repo' },
      filePathRewrites: [
        {
          fromRoot: '/worktrees/source-wt',
          toRoot: '/worktrees/dest-wt/repos/source',
        },
      ],
      compatibilitySymlinks: [],
      createdTemporaryWorkspace: false,
      reusedWorkspace: true,
      removedSourceWorktree: true,
      ...overrides,
    };
  }

  it('sends the combine response fields to main, cleans up the source scope, and reloads a newly selected destination', async () => {
    const { useChatStore } = loadChatStore();
    const response = makeCombineResponse({
      sourceRootRepoIdRewrite: 'root-repo',
    });
    const sourceKey = `${response.sourceWorkspaceId}/${response.sourceWorktreeId}`;
    const sourceTab = makeChatTab('source-tab', {
      title: 'Existing investigation',
    });

    useChatStore.setState({
      selectedWorktree: {
        projectId: response.sourceWorkspaceId,
        worktreeId: response.sourceWorktreeId,
      },
      worktreeChats: {
        [sourceKey]: { tabs: [sourceTab], activeTabId: sourceTab.id },
      },
      tabDrafts: { [sourceTab.id]: [{ text: 'unsent draft' }] },
      pendingQuestions: {
        'req-1': {
          requestId: 'req-1',
          projectId: response.sourceWorkspaceId,
          worktreeId: response.sourceWorktreeId,
          chatId: sourceTab.id,
          questions: [],
        },
      },
    });

    await useChatStore.getState().migrateWorktreeTabsToAdhocWorkspace(response);

    expect(adhocMigrateTabsMock).toHaveBeenCalledTimes(1);
    expect(adhocMigrateTabsMock).toHaveBeenCalledWith({
      sourceWorkspaceId: response.sourceWorkspaceId,
      sourceWorktreeId: response.sourceWorktreeId,
      destinationWorkspaceId: response.destinationWorkspaceId,
      destinationWorktreeId: response.destinationWorktreeId,
      filePathRewrites: response.filePathRewrites,
      selectedRepoIdRewrites: response.selectedRepoIdRewrites,
      sourceRootRepoIdRewrite: 'root-repo',
    });

    const state = useChatStore.getState();
    expect(state.worktreeChats[sourceKey]).toBeUndefined();
    expect(state.tabDrafts[sourceTab.id]).toBeUndefined();
    expect(state.pendingQuestions['req-1']).toBeUndefined();
    expect(state.selectedWorktree).toEqual({
      projectId: response.destinationWorkspaceId,
      worktreeId: response.destinationWorktreeId,
    });
    // The destination became the selection, so its canonical tabs reload.
    expect(loadTabsApiMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: response.destinationWorkspaceId,
        worktreeId: response.destinationWorktreeId,
      }),
    );
  });

  it('omits sourceRootRepoIdRewrite and keeps an unrelated selection while reloading a cached destination', async () => {
    const { useChatStore } = loadChatStore();
    const response = makeCombineResponse();
    const sourceKey = `${response.sourceWorkspaceId}/${response.sourceWorktreeId}`;
    const destKey = `${response.destinationWorkspaceId}/${response.destinationWorktreeId}`;
    const sourceTab = makeChatTab('source-tab');

    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [sourceKey]: { tabs: [sourceTab], activeTabId: sourceTab.id },
        [destKey]: { tabs: [], activeTabId: '' },
      },
    });

    await useChatStore.getState().migrateWorktreeTabsToAdhocWorkspace(response);

    const request = adhocMigrateTabsMock.mock.calls[0]?.[0];
    expect(isRecord(request)).toBe(true);
    expect(isRecord(request) && 'sourceRootRepoIdRewrite' in request).toBe(
      false,
    );
    const state = useChatStore.getState();
    expect(state.worktreeChats[sourceKey]).toBeUndefined();
    expect(state.selectedWorktree).toEqual({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    // The destination scope was cached locally, so it reloads in the background.
    expect(loadTabsApiMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: response.destinationWorkspaceId,
        worktreeId: response.destinationWorktreeId,
      }),
    );
  });

  it('preserves the local source when the main-side migration fails', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { useChatStore } = loadChatStore();
      const response = makeCombineResponse();
      const sourceKey = `${response.sourceWorkspaceId}/${response.sourceWorktreeId}`;
      const sourceTab = makeChatTab('source-tab');

      adhocMigrateTabsMock.mockRejectedValueOnce(new Error('migration failed'));
      useChatStore.setState({
        worktreeChats: {
          [sourceKey]: { tabs: [sourceTab], activeTabId: sourceTab.id },
        },
      });

      await expect(
        useChatStore.getState().migrateWorktreeTabsToAdhocWorkspace(response),
      ).rejects.toThrow('migration failed');

      expect(useChatStore.getState().worktreeChats[sourceKey]).toBeDefined();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// The deep fork semantics (transcript cloning, Codex thread forks, Claude
// session continuity, file-path rewrites, archived-chat exclusion) are
// main-owned now and covered by the main-process worktree-open-tabs-fork
// tests. These wrapper tests cover the renderer store action: the IPC request
// it sends, the binding map it returns, and the post-hydration presentation
// state it applies.
describe('forkOpenTabsToWorktree', () => {
  it('requests the main-side fork, hydrates the destination, and marks forked file tabs for recheck', async () => {
    const { useChatStore } = loadChatStore();
    const sourceKey = 'project/source-wt';
    const destinationKey = 'project/destination-wt';
    const sourceChat = makeChatTab('chat-1', { title: 'Investigation' });
    const sourceFile = makeFileTab(
      'file-1',
      '/worktrees/source-wt/src/index.ts',
    );

    forkOpenWorktreeTabsMock.mockResolvedValue({
      tabBindings: {
        'chat-1': { destinationTabId: 'chat-1-fork' },
        'file-1': {
          destinationTabId: 'file-1-fork',
          destinationFilePath: '/worktrees/destination-wt/src/index.ts',
        },
      },
    });
    loadTabsApiMock.mockImplementation((request: unknown) => {
      if (isRecord(request) && request.worktreeId === 'destination-wt') {
        return Promise.resolve({
          version: 1,
          tabs: [
            {
              id: 'chat-1-fork',
              title: 'Investigation',
              messages: [],
              createdAt: '2026-04-25T00:00:00.000Z',
              pluginSelections: {
                collectionIds: ['collection-1'],
                skillRefs: [],
                pluginRefs: [],
              },
            },
            {
              id: 'file-1-fork',
              title: 'index.ts',
              kind: 'file',
              filePath: '/worktrees/destination-wt/src/index.ts',
              messages: [],
              createdAt: '2026-04-25T00:00:00.000Z',
            },
          ],
          activeTabId: 'file-1-fork',
        });
      }
      return Promise.resolve(emptyTabsFile());
    });
    useChatStore.setState({
      worktreeChats: {
        [sourceKey]: {
          tabs: [sourceChat, sourceFile],
          activeTabId: sourceFile.id,
        },
      },
    });

    const tabBindings = await useChatStore.getState().forkOpenTabsToWorktree({
      projectId: 'project',
      sourceWorktreeId: 'source-wt',
      destinationWorktreeId: 'destination-wt',
    });

    expect(forkOpenWorktreeTabsMock).toHaveBeenCalledTimes(1);
    expect(forkOpenWorktreeTabsMock).toHaveBeenCalledWith({
      projectId: 'project',
      sourceWorktreeId: 'source-wt',
      destinationWorktreeId: 'destination-wt',
    });

    expect(tabBindings.size).toBe(2);
    expect(tabBindings.get('chat-1')).toEqual({
      destinationTabId: 'chat-1-fork',
    });
    expect(tabBindings.get('file-1')).toEqual({
      destinationTabId: 'file-1-fork',
      destinationFilePath: '/worktrees/destination-wt/src/index.ts',
    });

    const destination = useChatStore.getState().worktreeChats[destinationKey];
    expect(destination.tabs.map((tab) => tab.id)).toEqual([
      'chat-1-fork',
      'file-1-fork',
    ]);
    const hydratedFileTab = destination.tabs.find(
      (tab) => tab.id === 'file-1-fork',
    );
    expect(hydratedFileTab).toEqual(
      expect.objectContaining({
        kind: 'file',
        filePath: '/worktrees/destination-wt/src/index.ts',
        recheckAfterWorktreeSetup: true,
      }),
    );
    const hydratedChatTab = destination.tabs.find(
      (tab) => tab.id === 'chat-1-fork',
    );
    expect(hydratedChatTab?.recheckAfterWorktreeSetup).toBeUndefined();
    // Hydrated chat tabs with plugin selections re-request discovery.
    expect(discoverWorktreeEnvMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project',
        worktreeId: 'destination-wt',
        chatId: 'chat-1-fork',
      }),
    );
    // Source projection is untouched — main owns the durable fork.
    expect(useChatStore.getState().worktreeChats[sourceKey].tabs).toEqual([
      sourceChat,
      sourceFile,
    ]);
  });

  it('returns an empty map without hydrating when main reports no forked tabs', async () => {
    const { useChatStore } = loadChatStore();
    const sourceKey = 'project/source-wt';
    const destinationKey = 'project/destination-wt';

    forkOpenWorktreeTabsMock.mockResolvedValue({ tabBindings: {} });
    useChatStore.setState({
      worktreeChats: {
        [sourceKey]: { tabs: [makeChatTab('chat-1')], activeTabId: 'chat-1' },
      },
    });

    const tabBindings = await useChatStore.getState().forkOpenTabsToWorktree({
      projectId: 'project',
      sourceWorktreeId: 'source-wt',
      destinationWorktreeId: 'destination-wt',
    });

    expect(tabBindings.size).toBe(0);
    expect(loadTabsApiMock).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().worktreeChats[destinationKey],
    ).toBeUndefined();
  });
});

describe('switchTab on a file tab', () => {
  it('retains the previous chat provider without discovery', () => {
    const { useChatStore } = loadChatStore();

    const fileTab: ChatTab = makeChatTab('file-1', {
      title: 'notes.md',
      kind: 'file',
      filePath: '/abs/path/notes.md',
    });
    const chatTab: ChatTab = makeChatTab('chat-1', { providerType: 'codex' });
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [KEY]: {
          tabs: [chatTab, fileTab],
          activeTabId: 'chat-1',
        },
      },
    });

    useChatStore.getState().switchTab('file-1');

    expect(useChatStore.getState().worktreeChats[KEY].activeTabId).toBe(
      'file-1',
    );
    expect(
      useChatStore.getState().worktreeChats[KEY].lastActiveChatProvider,
    ).toBe('codex');
    expect(
      useChatStore.getState().worktreeChats[KEY].lastActiveEditableChatId,
    ).toBe('chat-1');
    expect(discoverWorktreeEnvMock).not.toHaveBeenCalled();
  });
});

describe('handleChatEvent unread state', () => {
  it('clears stale unread state when a finished turn resumes with new agent output', () => {
    const { useChatStore } = loadChatStore();
    const otherKey = `${PROJECT_ID}/other-worktree`;
    const chatTab = makeChatTab('chat-1', {
      providerType: 'claude',
      status: 'streaming',
    });

    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: 'other-worktree' },
      worktreeChats: {
        [KEY]: { tabs: [chatTab], activeTabId: 'chat-1' },
        [otherKey]: {
          tabs: [makeChatTab('other-chat')],
          activeTabId: 'other-chat',
        },
      },
    });

    useChatStore.getState().handleChatEvent({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      chatId: 'chat-1',
      data: {
        type: 'result',
        is_error: false,
        result: 'done',
        usage: {},
      },
    });

    let tab = useChatStore
      .getState()
      .worktreeChats[KEY].tabs.find((candidate) => candidate.id === 'chat-1');
    expect(tab?.status).toBe('idle');
    expect(tab?.unread).toBe(true);
    expect(useChatStore.getState().unreadWorktreeKeys.has(KEY)).toBe(true);

    useChatStore.getState().handleChatEvent({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      chatId: 'chat-1',
      data: {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Actually, one more update.' }],
        },
      },
    });

    tab = useChatStore
      .getState()
      .worktreeChats[KEY].tabs.find((candidate) => candidate.id === 'chat-1');
    expect(tab?.status).toBe('streaming');
    expect(tab?.unread).toBe(false);
    expect(useChatStore.getState().unreadWorktreeKeys.has(KEY)).toBe(false);

    useChatStore.getState().handleChatEvent({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      chatId: 'chat-1',
      data: {
        type: 'result',
        is_error: false,
        result: 'done for real',
        usage: {},
      },
    });

    tab = useChatStore
      .getState()
      .worktreeChats[KEY].tabs.find((candidate) => candidate.id === 'chat-1');
    expect(tab?.status).toBe('idle');
    expect(tab?.unread).toBe(true);
    expect(useChatStore.getState().unreadWorktreeKeys.has(KEY)).toBe(true);
  });
});

describe('worktree attention acknowledgement', () => {
  it('keeps a collapsed active chat unread when selecting its worktree', () => {
    const { useChatStore } = loadChatStore();
    const { useNavigationStore } =
      jest.requireActual<typeof NavigationStoreModule>('../navigationStore');
    const chatTab = makeChatTab('chat-1', { unread: true });

    useNavigationStore.setState({ activePage: 'main' });
    useChatStore.setState({
      worktreeChats: {
        [KEY]: { tabs: [chatTab], activeTabId: 'chat-1' },
      },
      unreadWorktreeKeys: new Set([KEY]),
      hiddenChatTabIds: new Set(['chat-1']),
    });

    useChatStore.getState().selectWorktree(PROJECT_ID, WORKTREE_ID);

    const tab = useChatStore
      .getState()
      .worktreeChats[KEY].tabs.find((candidate) => candidate.id === 'chat-1');
    expect(tab?.unread).toBe(true);
    expect(useChatStore.getState().unreadWorktreeKeys.has(KEY)).toBe(true);
  });

  it('keeps a collapsed active chat unread when acknowledging selected worktree attention', () => {
    const { useChatStore } = loadChatStore();
    const { useNavigationStore } =
      jest.requireActual<typeof NavigationStoreModule>('../navigationStore');
    const chatTab = makeChatTab('chat-1', { unread: true });

    useNavigationStore.setState({ activePage: 'main' });
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [KEY]: { tabs: [chatTab], activeTabId: 'chat-1' },
      },
      unreadWorktreeKeys: new Set([KEY]),
      hiddenChatTabIds: new Set(['chat-1']),
    });

    useChatStore.getState().acknowledgeSelectedWorktreeAttention();

    const tab = useChatStore
      .getState()
      .worktreeChats[KEY].tabs.find((candidate) => candidate.id === 'chat-1');
    expect(tab?.unread).toBe(true);
    expect(useChatStore.getState().unreadWorktreeKeys.has(KEY)).toBe(true);
  });
});

describe('sendMessage on a file tab', () => {
  it('waits for an in-flight canonical refresh instead of dropping the send', async () => {
    const { useChatStore } = loadChatStore();
    const chatTab = makeChatTab('chat-1');
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [KEY]: { tabs: [chatTab], activeTabId: 'chat-1' },
      },
      chatStateSync: {
        [KEY]: { phase: 'refreshing', revision: 1 },
      },
    });

    const send = useChatStore.getState().sendMessage('Do not lose this');
    await Promise.resolve();
    expect(sendMessageApiMock).not.toHaveBeenCalled();

    useChatStore.setState({
      chatStateSync: {
        [KEY]: { phase: 'live', revision: 2 },
      },
    });
    await send;

    expect(sendMessageApiMock).toHaveBeenCalledTimes(1);
    expect(sendMessageApiMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Do not lose this' }),
    );
  });

  it('routes to an existing chat tab when the active tab is a file tab', async () => {
    const { useChatStore } = loadChatStore();

    const fileTab: ChatTab = makeFileTab('file-1', '/abs/path/notes.md');
    const chatTab: ChatTab = makeChatTab('chat-1');
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [KEY]: { tabs: [chatTab, fileTab], activeTabId: 'file-1' },
      },
    });

    await useChatStore.getState().sendMessage('Follow up on the plan');

    const wc = useChatStore.getState().worktreeChats[KEY];
    const updatedChat = wc.tabs.find((tab) => tab.id === 'chat-1');
    const updatedFile = wc.tabs.find((tab) => tab.id === 'file-1');

    expect(wc.activeTabId).toBe('chat-1');
    expect(sendMessageApiMock).toHaveBeenCalledTimes(1);
    expect(updatedChat?.messages).toHaveLength(2);
    expect(updatedFile?.messages).toEqual([]);
  });

  it('creates a writable chat tab when only a file tab exists', async () => {
    const { useChatStore } = loadChatStore();

    const fileTab: ChatTab = makeFileTab('file-1', '/abs/path/notes.md');
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [KEY]: { tabs: [fileTab], activeTabId: 'file-1' },
      },
    });

    await useChatStore
      .getState()
      .sendMessage('Review this report: /tmp/report.md');

    const wc = useChatStore.getState().worktreeChats[KEY];
    expect(wc.tabs).toHaveLength(2);
    expect(wc.activeTabId).not.toBe('file-1');
    expect(sendMessageApiMock).toHaveBeenCalledTimes(1);
    expect(discoverWorktreeEnvMock).toHaveBeenCalled();
    expect(
      wc.tabs.some((tab) => tab.kind !== 'file' && tab.messages.length === 2),
    ).toBe(true);
  });

  it('sends hidden watcher context into Claude Code terminal mode', async () => {
    const { useChatStore } = loadChatStore();

    const chatTab = makeChatTab('chat-1', {
      interfaceMode: 'claude-code',
      claudeTerminal: {
        terminalId: 'terminal-1',
        turnState: 'idle',
      },
      providerType: 'claude',
    });
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [KEY]: { tabs: [chatTab], activeTabId: 'chat-1' },
      },
    });

    const sendPromise = useChatStore.getState().sendMessage(
      'Canopy watcher fired.\nPipeline completed',
      undefined,
      {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        chatId: 'chat-1',
      },
      undefined,
      {
        hiddenContext: {
          kind: 'canopy-watcher-event',
          text: '<system_instruction>watcher payload</system_instruction>',
        },
        throwOnDispatchFailure: true,
      },
    );
    await jest.advanceTimersByTimeAsync(600);
    await sendPromise;

    expect(sendMessageApiMock).not.toHaveBeenCalled();
    // 3 clear-sequence keystrokes (Esc, Space, Esc) precede the paste write,
    // and the submitting Enter follows as a separate delayed write.
    expect(terminalWriteMock).toHaveBeenCalledTimes(5);
    const writeRequest = terminalWriteMock.mock.calls[3]?.[0];
    expect(writeRequest).toEqual(
      expect.objectContaining({ terminalId: 'terminal-1' }),
    );
    const data = isRecord(writeRequest) ? writeRequest.data : undefined;
    expect(data).toEqual(expect.stringContaining('watcher payload'));
    expect(data).toEqual(expect.stringContaining('Canopy watcher fired.'));
    expect(data).toEqual(expect.stringContaining('Pipeline completed'));
    expect(terminalWriteMock.mock.calls[4]?.[0]).toEqual(
      expect.objectContaining({ terminalId: 'terminal-1', data: '\r' }),
    );
  });

  it('does not resume a preallocated Claude terminal session from a fresh Canopy tab', async () => {
    const { useChatStore } = loadChatStore();
    const { useClaudeTerminalStore } = jest.requireActual<
      typeof ClaudeTerminalStoreModule
    >('../claudeTerminalStore');

    const chatTab = makeChatTab('chat-1', {
      interfaceMode: 'canopy',
      providerType: 'claude',
      model: 'claude-sonnet-4-6',
      sdkSessionId: 'preallocated-terminal-session',
      claudeTerminal: {
        terminalId: 'terminal-1',
        sdkSessionId: 'preallocated-terminal-session',
        turnState: 'idle',
      },
    });
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [KEY]: { tabs: [chatTab], activeTabId: 'chat-1' },
      },
    });
    useClaudeTerminalStore.setState({
      byChat: {
        [`${KEY}/chat-1`]: {
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          chatId: 'chat-1',
          terminalId: 'terminal-1',
          sdkSessionId: 'preallocated-terminal-session',
          turnState: 'idle',
          launchStatus: 'ready',
        },
      },
      terminalIdIndex: {
        'terminal-1': `${KEY}/chat-1`,
      },
      inFlightLaunch: {},
    });

    await useChatStore.getState().sendMessage('Start in Canopy', undefined, {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      chatId: 'chat-1',
    });

    expect(claudeTerminalCleanupMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      chatId: 'chat-1',
      reason: 'switch-to-native-send',
    });
    expect(sendMessageApiMock).toHaveBeenCalledTimes(1);
    expect(sendMessageApiMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        providerType: 'claude',
        sdkSessionId: undefined,
      }),
    );
    const updatedTab = useChatStore.getState().worktreeChats[KEY].tabs[0];
    expect(updatedTab.sdkSessionId).toBeUndefined();
    expect(updatedTab.claudeTerminal).toBeUndefined();
  });
});

describe('sendMessage watched-run carry', () => {
  it('does not carry a watched run the chat launched into the new turn', async () => {
    const { useChatStore } = loadChatStore();
    const { useAppAdvisorWatchersStore } = jest.requireActual<
      typeof AppAdvisorWatchersStoreModule
    >('../appAdvisorWatchersStore');
    const launchedRun = buildPipelineRunArtifactReceipt({
      operation: 'pipeline.run',
      executionId: 'exec-chat',
      pipelineId: 'pipe-chat',
      pipelineName: 'Chat build',
      initialStatus: 'running',
      queuedAt: '2026-04-25T00:00:01.000Z',
      createdAt: '2026-04-25T00:00:01.000Z',
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      navigationTarget: {
        kind: 'pipeline_execution',
        executionId: 'exec-chat',
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
      },
    });
    const destination = {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      chatId: 'chat-1',
    };
    useAppAdvisorWatchersStore.setState({
      watchers: [
        {
          id: 'watch-chat',
          trigger: 'worktree_pipeline_completion',
          status: 'active',
          label: 'Chat build watcher',
          target: {
            kind: 'worktree_pipeline',
            projectId: PROJECT_ID,
            worktreeId: WORKTREE_ID,
            pipelineId: 'pipe-chat',
            executionId: 'exec-chat',
          },
          destination,
          createdAt: '2026-04-25T00:00:02.000Z',
        },
      ],
    });
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [KEY]: {
          tabs: [
            makeChatTab('chat-1', {
              messages: [
                {
                  id: 'turn-1',
                  role: 'user',
                  blocks: [{ type: 'text', text: 'Run the build' }],
                  timestamp: 1,
                },
                {
                  id: 'assistant-1',
                  role: 'assistant',
                  blocks: [
                    {
                      type: 'tool_use',
                      toolUseId: 'tool-1',
                      toolName: 'DispatchAction',
                      input: '{}',
                    },
                  ],
                  timestamp: 2,
                },
                {
                  id: 'result-1',
                  role: 'assistant',
                  blocks: [
                    {
                      type: 'tool_result',
                      toolUseId: 'tool-1',
                      toolName: 'DispatchAction',
                      output: JSON.stringify({
                        ok: true,
                        result: { agentArtifacts: [launchedRun] },
                      }),
                      isError: false,
                    },
                  ],
                  timestamp: 3,
                },
              ],
            }),
          ],
          activeTabId: 'chat-1',
        },
      },
    });

    await useChatStore.getState().sendMessage('What next?');

    // The launching turn already lists the run; carrying it into the new
    // turn would list it again once that turn completes (CAN-4690).
    const tab = useChatStore.getState().worktreeChats[KEY].tabs[0];
    expect(sendMessageApiMock).toHaveBeenCalledTimes(1);
    expect(
      tab.messages.filter((message) => message.role === 'user'),
    ).toHaveLength(2);
    expect(tab.agentArtifactCarryByTurn).toBeUndefined();
  });
});

describe('syncActiveEmptyTabToDefaults on a file tab', () => {
  it('is a no-op — no model/providerType/thinkingLevel mutation, no discovery', async () => {
    const { useChatStore } = loadChatStore();

    const fileTab: ChatTab = makeChatTab('file-1', {
      title: 'notes.md',
      kind: 'file',
      filePath: '/abs/path/notes.md',
    });
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [KEY]: { tabs: [fileTab], activeTabId: 'file-1' },
      },
    });

    await useChatStore.getState().syncActiveEmptyTabToDefaults();

    const tab = useChatStore.getState().worktreeChats[KEY].tabs[0];
    expect(tab.model).toBeUndefined();
    expect(tab.providerType).toBeUndefined();
    expect(tab.thinkingLevel).toBe('high');
    expect(discoverWorktreeEnvMock).not.toHaveBeenCalled();
  });
});

// The renderer no longer serializes tabs — the persisted round trip lives in
// the main-process chat repository tests. This describe keeps the load-side
// hydration coverage plus the in-memory view-mode behavior.
describe('file tab hydration and view mode', () => {
  it('restores kind/filePath verbatim and does not trigger discovery on activation', async () => {
    const { useChatStore } = loadChatStore();

    loadTabsApiMock.mockResolvedValueOnce({
      version: 1,
      tabs: [
        {
          id: 'file-1',
          title: 'notes.md',
          kind: 'file',
          filePath: '/abs/path/notes.md',
          fileViewMode: 'preview',
          messages: [],
          createdAt: '2026-04-25T00:00:00.000Z',
        },
      ],
      activeTabId: 'file-1',
      lastActiveChatProvider: 'claude',
    });

    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
    });

    await useChatStore.getState().loadTabs();

    const wc = useChatStore.getState().worktreeChats[KEY];
    expect(wc.tabs).toHaveLength(1);
    const tab = wc.tabs[0];
    expect(tab.kind).toBe('file');
    expect(tab.filePath).toBe('/abs/path/notes.md');
    expect(tab.fileViewMode).toBe('preview');
    expect(tab.title).toBe('notes.md');
    expect(tab.description).toBe('/abs/path/notes.md');
    expect(wc.activeTabId).toBe('file-1');
    expect(wc.lastActiveChatProvider).toBe('claude');
    expect(discoverWorktreeEnvMock).not.toHaveBeenCalled();
  });

  it('applies file tab raw/preview mode changes to the selected worktree', () => {
    const { useChatStore } = loadChatStore();

    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [KEY]: {
          tabs: [makeFileTab('file-1', '/abs/path/notes.md')],
          activeTabId: 'file-1',
        },
      },
    });

    useChatStore.getState().setFileTabViewMode('file-1', 'preview');

    const tab = useChatStore.getState().worktreeChats[KEY].tabs[0];
    expect(tab.fileViewMode).toBe('preview');
  });
});

describe('closeTab before hydration', () => {
  it('does not preserve a synthetic empty chat after the last file tab closes', async () => {
    const { useChatStore } = loadChatStore();
    const deferredTabs = createDeferred<ChatTabsFile>();

    loadTabsApiMock.mockReturnValueOnce(deferredTabs.promise);
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
    });

    const loadPromise = useChatStore.getState().loadTabs();

    useChatStore.getState().openFileTab({
      absolutePath: '/abs/path/notes.md',
      filename: 'notes.md',
    });
    const fileTabId = useChatStore.getState().worktreeChats[KEY].activeTabId;

    useChatStore.getState().closeTab(fileTabId);
    expect(useChatStore.getState().worktreeChats[KEY]).toBeUndefined();

    deferredTabs.resolve({
      version: 1,
      tabs: [
        {
          id: 'chat-1',
          title: 'Chat',
          messages: [],
          createdAt: '2026-04-25T00:00:00.000Z',
        },
      ],
      activeTabId: 'chat-1',
    });
    await loadPromise;

    const wc = useChatStore.getState().worktreeChats[KEY];
    expect(wc.tabs).toHaveLength(1);
    expect(wc.tabs[0].id).toBe('chat-1');
    expect(wc.activeTabId).toBe('chat-1');
  });
});

describe('createTab before hydration', () => {
  it('does not duplicate the default empty chat when persisted state is empty', async () => {
    const { useChatStore } = loadChatStore();
    const deferredTabs = createDeferred<ChatTabsFile>();

    loadTabsApiMock.mockReturnValueOnce(deferredTabs.promise);
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: { [KEY]: { tabs: [], activeTabId: '' } },
    });

    const loadPromise = useChatStore.getState().loadTabs();
    useChatStore.getState().createTab();

    deferredTabs.resolve(emptyTabsFile());
    await loadPromise;

    const wc = useChatStore.getState().worktreeChats[KEY];
    expect(wc.tabs).toHaveLength(1);
    expect(wc.tabs[0].title).toBe(`New ${CHAT_UNIT_LABEL}`);
  });
});

/**
 * Wire the shared file-viewer store (single owner) to the desktop session
 * controller singleton after a `loadChatStore()` module reset. `client.command`
 * for `file.save` delegates to `saveFileContentMock` so existing per-test save
 * success/failure/deferred behavior is preserved; `file.read` returns a
 * baseline preview with a parseable mtime so saves are not fail-closed.
 */
function attachSharedFileStore(): {
  controller: (typeof ControllerModule)['desktopFileSessionController'];
  fileTabUi: typeof FileTabUiModule;
  store: ReturnType<typeof AppStateModule.createFileViewerStore>;
  appState: typeof AppStateModule;
  detach: () => void;
} {
  const controllerModule = jest.requireActual<typeof ControllerModule>(
    '../../lib/file-viewer/desktop-file-session-controller',
  );
  const fileTabUi =
    jest.requireActual<typeof FileTabUiModule>('../fileTabUiStore');
  const appState =
    jest.requireActual<typeof AppStateModule>('@canopy/app-state');

  const client: CanopyClient = {
    capabilities: {
      localExecution: true,
      terminalPty: true,
      fileSystemAccess: 'read-write',
      voice: false,
      settingsScope: 'full',
      pipelines: 'execute',
      routing: 'in-memory',
      overviewNotifications: true,
    },
    query<K extends QueryName>(
      name: K,
      args: QueryMap[K]['args'],
    ): Promise<QueryMap[K]['result']> {
      if (name === 'file.read') {
        const read = args as QueryMap['file.read']['args'];
        return Promise.resolve({
          workspaceLocalId: read.projectId,
          worktreeLocalId: read.worktreeId,
          fileRootLocalId: read.fileRootLocalId,
          path: read.relativePath,
          content: 'baseline',
          size: 8,
          version: 'v1',
          truncated: false,
          modifiedAt: new Date(1000).toISOString(),
        } as QueryMap[K]['result']);
      }
      return Promise.reject(new Error(`no query responder for ${name}`));
    },
    async command<K extends CommandName>(
      name: K,
      args: CommandMap[K]['args'],
    ): Promise<CommandMap[K]['result']> {
      if (name === 'file.save') {
        const save = args as CommandMap['file.save']['args'];
        const response = await saveFileContentMock({
          projectId: save.projectId,
          worktreeId: save.worktreeId,
          absolutePath: save.relativePath,
          content: save.content,
          expectedModifiedAtMs: save.expectedModifiedAtMs,
        });
        return {
          workspaceLocalId: save.projectId,
          worktreeLocalId: save.worktreeId,
          fileRootLocalId: save.fileRootLocalId,
          path: save.relativePath,
          content: save.content,
          size: response.sizeBytes,
          version: `v${response.modifiedAtMs}`,
          truncated: false,
          modifiedAt: new Date(response.modifiedAtMs).toISOString(),
        } as CommandMap[K]['result'];
      }
      return Promise.reject(new Error(`no command responder for ${name}`));
    },
    subscribe(): Unsubscribe {
      return (): void => {};
    },
  };

  const store = appState.createFileViewerStore(client);
  const controller = controllerModule.desktopFileSessionController;
  const detach = controller.attachStore(store, { onSaveCommitted: () => {} });
  return { controller, fileTabUi, store, appState, detach };
}

/** Register + read + optionally edit a file session for a tab. Returns its key. */
async function seedFileSession(
  h: ReturnType<typeof attachSharedFileStore>,
  tabId: string,
  relativePath: string,
  edited?: string,
): Promise<string> {
  const request = {
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    fileRootLocalId: 'repo-1',
    relativePath,
  };
  const key = h.controller.registerTab(tabId, request);
  await h.store.getState().openFile(request);
  if (edited !== undefined) {
    h.store.getState().updateContent(key, edited);
  }
  return key;
}

/** Drain queued microtasks (fake timers keep real timers from firing). */
async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

describe('explicit reopen of an existing file tab', () => {
  it('checks the shared session against disk without adding a tab', async () => {
    const { useChatStore } = loadChatStore();
    const file = attachSharedFileStore();
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: { [KEY]: { tabs: [], activeTabId: '' } },
    });
    const params = {
      absolutePath: '/abs/path/notes.md',
      filename: 'notes.md',
    };
    const tabId = useChatStore.getState().openFileTab(params) ?? '';
    const key = await seedFileSession(file, tabId, 'notes.md');
    const refreshFile = jest.fn((): Promise<void> => Promise.resolve());
    file.store.setState({ refreshFile });

    // Already active: no activation transition, so the reopen itself reads.
    expect(useChatStore.getState().openFileTab(params)).toBe(tabId);
    // Background presentation keeps the current tab.
    useChatStore.getState().createTab();
    const chatTabId = useChatStore.getState().worktreeChats[KEY].activeTabId;
    expect(chatTabId).not.toBe(tabId);
    expect(
      useChatStore
        .getState()
        .openFileTab(params, undefined, { activate: false }),
    ).toBe(tabId);
    expect(useChatStore.getState().worktreeChats[KEY].activeTabId).toBe(
      chatTabId,
    );
    const emptyId = useChatStore.getState().createEmptyFileTab() ?? '';
    expect(useChatStore.getState().assignFileTab(emptyId, params)).toBe(tabId);

    expect(refreshFile.mock.calls).toEqual([[key], [key], [key]]);
    expect(
      useChatStore
        .getState()
        .worktreeChats[
          KEY
        ].tabs.filter((tab) => tab.kind === 'file' && tab.filePath === params.absolutePath),
    ).toHaveLength(1);
    file.controller.releaseTab(tabId);
    file.detach();
  });
});

describe('closeTab on a dirty file tab', () => {
  /**
   * Common setup: a worktree with a single dirty file tab plus a chat tab, so
   * closing the file tab doesn't trip the empty-worktree path. Dirty state and
   * saves live entirely in the shared file-viewer session (CAN-1426).
   */
  async function setupDirtyFileTab(args: {
    autoSaveEnabled: boolean;
  }): Promise<{
    useChatStore: (typeof ChatStoreModule)['useChatStore'];
    file: ReturnType<typeof attachSharedFileStore>;
    fileTabId: string;
    fileKey: string;
  }> {
    const { useChatStore } = loadChatStore();
    const file = attachSharedFileStore();

    const fileTabId = 'file-1';
    const fileTab: ChatTab = makeFileTab(fileTabId, '/abs/path/notes.md', {
      fileViewMode: 'raw',
    });
    const chatTab: ChatTab = makeChatTab('chat-1');
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [KEY]: { tabs: [chatTab, fileTab], activeTabId: fileTabId },
      },
    });

    // The close-guard branch decision reads the file-tab UI preference; the
    // controller's autosave debounce is not exercised here (the close path
    // calls the shared saveTab directly).
    file.fileTabUi.useFileTabUiStore
      .getState()
      .setAutoSaveEnabled(args.autoSaveEnabled);
    const fileKey = await seedFileSession(
      file,
      fileTabId,
      'notes.md',
      'hello!',
    );

    return { useChatStore, file, fileTabId, fileKey };
  }

  it('Auto Save off: dirty close opens the unsaved-changes modal carrying projectId/worktreeId/fileKey', async () => {
    const { useChatStore, file, fileTabId, fileKey } = await setupDirtyFileTab({
      autoSaveEnabled: false,
    });

    useChatStore.getState().closeTab(fileTabId);

    // Tab is still present.
    const wc = useChatStore.getState().worktreeChats[KEY];
    expect(wc.tabs.some((t) => t.id === fileTabId)).toBe(true);

    const pending =
      file.fileTabUi.useFileTabUiStore.getState().pendingUnsavedClose;
    expect(pending).not.toBeNull();
    expect(pending?.tabId).toBe(fileTabId);
    expect(pending?.fileKey).toBe(fileKey);
    expect(pending?.projectId).toBe(PROJECT_ID);
    expect(pending?.worktreeId).toBe(WORKTREE_ID);
    file.fileTabUi.useFileTabUiStore.getState().clearPendingUnsavedClose();
    const memory = jest.requireActual<typeof LastViewModeModule>(
      '../../lib/file-viewer/last-view-mode',
    );
    expect(
      memory.readRememberedFileViewMode({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        absolutePath: '/abs/path/notes.md',
      }),
    ).toBeUndefined();
    file.detach();
  });

  it('force close removes the file tab and drops its shared session', async () => {
    const { useChatStore, file, fileTabId } = await setupDirtyFileTab({
      autoSaveEnabled: false,
    });

    useChatStore.getState().closeTab(fileTabId, { force: true });

    const wc = useChatStore.getState().worktreeChats[KEY];
    expect(wc.tabs.some((t) => t.id === fileTabId)).toBe(false);
    expect(file.controller.getSession(fileTabId)).toBeUndefined();
    file.detach();
  });

  it('Auto Save on (clean save): closes the originating tab', async () => {
    const { useChatStore, file, fileTabId } = await setupDirtyFileTab({
      autoSaveEnabled: true,
    });

    useChatStore.getState().closeTab(fileTabId);
    await flushMicrotasks();

    const wc = useChatStore.getState().worktreeChats[KEY];
    expect(wc.tabs.some((t) => t.id === fileTabId)).toBe(false);
    expect(file.controller.getSession(fileTabId)).toBeUndefined();
    file.detach();
  });

  it('Auto Save on (failed save): keeps the tab open and surfaces the error', async () => {
    saveFileContentMock.mockRejectedValueOnce(new Error('disk full'));
    const { useChatStore, file, fileTabId } = await setupDirtyFileTab({
      autoSaveEnabled: true,
    });

    useChatStore.getState().closeTab(fileTabId);
    await flushMicrotasks();

    const wc = useChatStore.getState().worktreeChats[KEY];
    expect(wc.tabs.some((t) => t.id === fileTabId)).toBe(true);
    const session = file.controller.getSession(fileTabId);
    expect(session?.error).toBe('disk full');
    expect(session?.dirty).toBe(true);
    const memory = jest.requireActual<typeof LastViewModeModule>(
      '../../lib/file-viewer/last-view-mode',
    );
    expect(
      memory.readRememberedFileViewMode({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        absolutePath: '/abs/path/notes.md',
      }),
    ).toBeUndefined();
    file.detach();
  });

  it('Auto Save on with edits during save: tab stays open and post-save dirty re-check abandons close', async () => {
    let resolveSave: (value: {
      filename: string;
      sizeBytes: number;
      modifiedAtMs: number;
    }) => void = () => undefined;
    saveFileContentMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );

    const { useChatStore, file, fileTabId, fileKey } = await setupDirtyFileTab({
      autoSaveEnabled: true,
    });

    useChatStore.getState().closeTab(fileTabId);
    // While the save is in flight, the user types more.
    file.store.getState().updateContent(fileKey, 'hello!! more');
    resolveSave({ filename: 'notes.md', sizeBytes: 1, modifiedAtMs: 2000 });
    await flushMicrotasks();

    const wc = useChatStore.getState().worktreeChats[KEY];
    expect(wc.tabs.some((t) => t.id === fileTabId)).toBe(true);
    const session = file.controller.getSession(fileTabId);
    expect(session?.dirty).toBe(true);
    expect(session?.content).toBe('hello!! more');
    file.detach();
  });

  it('Auto Save on with worktree switch during save: closes the originating tab in the original worktree', async () => {
    let resolveSave: (value: {
      filename: string;
      sizeBytes: number;
      modifiedAtMs: number;
    }) => void = () => undefined;
    saveFileContentMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );

    const { useChatStore, file, fileTabId } = await setupDirtyFileTab({
      autoSaveEnabled: true,
    });

    useChatStore.getState().closeTab(fileTabId);

    // Simulate a worktree switch — point selectedWorktree at a different
    // (project, worktree) pair before the save resolves.
    const otherKey = `${PROJECT_ID}/other-worktree`;
    useChatStore.setState((state) => ({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: 'other-worktree' },
      worktreeChats: {
        ...state.worktreeChats,
        [otherKey]: { tabs: [], activeTabId: '' },
      },
    }));

    resolveSave({ filename: 'notes.md', sizeBytes: 1, modifiedAtMs: 2000 });
    await flushMicrotasks();

    // The originating tab is closed in the original worktree.
    const wc = useChatStore.getState().worktreeChats[KEY];
    expect(wc.tabs.some((t) => t.id === fileTabId)).toBe(false);
    // Shared session is gone.
    expect(file.controller.getSession(fileTabId)).toBeUndefined();
    file.detach();
  });

  it('closeTab(tabId, { projectId, worktreeId }) targets that worktree, not the selected one', () => {
    const { useChatStore } = loadChatStore();

    const otherKey = `${PROJECT_ID}/other-worktree`;
    const fileTab: ChatTab = makeChatTab('file-1', {
      title: 'notes.md',
      kind: 'file',
      filePath: '/abs/path/notes.md',
    });
    const otherChatTab: ChatTab = makeChatTab('chat-1');
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [KEY]: { tabs: [otherChatTab], activeTabId: 'chat-1' },
        [otherKey]: { tabs: [fileTab, otherChatTab], activeTabId: 'chat-1' },
      },
    });

    useChatStore.getState().closeTab('file-1', {
      projectId: PROJECT_ID,
      worktreeId: 'other-worktree',
    });

    // The selected worktree's tabs are unchanged.
    expect(
      useChatStore.getState().worktreeChats[KEY].tabs.map((t) => t.id),
    ).toEqual(['chat-1']);
    // The non-selected worktree no longer contains file-1.
    expect(
      useChatStore
        .getState()
        .worktreeChats[otherKey].tabs.some((t) => t.id === 'file-1'),
    ).toBe(false);
  });
});

describe('closeTab remembered editable chat target', () => {
  it('preserves the remembered chat when an unrelated tab closes under an active file', () => {
    const { useChatStore } = loadChatStore();

    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [KEY]: {
          tabs: [
            makeChatTab('chat-remembered'),
            makeChatTab('chat-other'),
            makeFileTab('file-active', '/abs/path/active.ts'),
          ],
          activeTabId: 'file-active',
          lastActiveEditableChatId: 'chat-remembered',
        },
      },
    });

    useChatStore.getState().closeTab('chat-other');

    const wc = useChatStore.getState().worktreeChats[KEY];
    expect(wc.activeTabId).toBe('file-active');
    expect(wc.lastActiveEditableChatId).toBe('chat-remembered');
  });
});

describe('closeTabs', () => {
  it('recomputes the remembered chat when bulk close removes it under an active file', () => {
    const { useChatStore } = loadChatStore();

    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [KEY]: {
          tabs: [
            makeChatTab('chat-fallback'),
            makeChatTab('chat-remembered'),
            makeChatTab('chat-other'),
            makeFileTab('file-active', '/abs/path/active.ts'),
          ],
          activeTabId: 'file-active',
          lastActiveEditableChatId: 'chat-remembered',
        },
      },
    });

    useChatStore.getState().closeTabs(['chat-remembered', 'chat-other']);

    const wc = useChatStore.getState().worktreeChats[KEY];
    expect(wc.activeTabId).toBe('file-active');
    expect(wc.lastActiveEditableChatId).toBe('chat-fallback');
  });

  it('keeps the tab that shifts into a closed active slot selected when protected tabs remain', () => {
    const { useChatStore } = loadChatStore();

    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [KEY]: {
          tabs: [
            makeChatTab('chat-a', { title: 'A' }),
            makeChatTab('chat-b', { title: 'B' }),
            makeChatTab('chat-c', { title: 'C', status: 'streaming' }),
          ],
          activeTabId: 'chat-a',
        },
      },
    });

    useChatStore.getState().closeTabs(['chat-a', 'chat-c']);

    const wc = useChatStore.getState().worktreeChats[KEY];
    expect(wc.tabs.map((tab) => tab.id)).toEqual(['chat-b', 'chat-c']);
    expect(wc.activeTabId).toBe('chat-b');
  });

  it('skips dirty file tabs and busy chat tabs while closing eligible targets', async () => {
    const { useChatStore } = loadChatStore();
    const file = attachSharedFileStore();
    const {
      getChatScrollPosition,
      saveChatScrollPosition,
      saveEditorScrollPosition,
      getEditorScrollPosition,
      saveFileViewerScrollPosition,
      getFileViewerScrollPosition,
    } = jest.requireActual<typeof TabScrollPositionsModule>(
      '../../lib/tab-scroll-positions',
    );

    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [KEY]: {
          tabs: [
            makeChatTab('chat-idle'),
            makeFileTab('file-clean', '/abs/path/clean.md'),
            makeFileTab('file-dirty', '/abs/path/dirty.md'),
            makeChatTab('chat-busy', { status: 'streaming' }),
          ],
          activeTabId: 'chat-idle',
        },
      },
    });

    await seedFileSession(file, 'file-clean', 'clean.md');
    await seedFileSession(file, 'file-dirty', 'dirty.md', 'dirty!');
    saveChatScrollPosition('chat-idle', 44);
    saveChatScrollPosition('chat-busy', 88);
    saveEditorScrollPosition('file-clean', { top: 120, left: 3 });
    saveEditorScrollPosition('file-dirty', { top: 240, left: 6 });
    saveFileViewerScrollPosition('file-clean', { top: 60, left: 1 });
    saveFileViewerScrollPosition('file-dirty', { top: 360, left: 9 });

    useChatStore
      .getState()
      .closeTabs(['chat-idle', 'file-clean', 'file-dirty', 'chat-busy']);

    const wc = useChatStore.getState().worktreeChats[KEY];
    expect(wc.tabs.map((tab) => tab.id)).toEqual(['file-dirty', 'chat-busy']);
    expect(wc.activeTabId).toBe('file-dirty');
    expect(file.controller.getSession('file-clean')).toBeUndefined();
    expect(file.controller.getSession('file-dirty')).toBeDefined();
    expect(getChatScrollPosition('chat-idle')).toBeUndefined();
    expect(getChatScrollPosition('chat-busy')).toBe(88);
    expect(getEditorScrollPosition('file-clean')).toBeUndefined();
    expect(getEditorScrollPosition('file-dirty')).toEqual({
      top: 240,
      left: 6,
    });
    // The clean file tab is closed, so its file-viewer scroll entry is
    // cleared; the dirty tab is skipped by the batch close and keeps its
    // file-viewer scroll so reading position survives the abandoned close.
    expect(getFileViewerScrollPosition('file-clean')).toBeUndefined();
    expect(getFileViewerScrollPosition('file-dirty')).toEqual({
      top: 360,
      left: 9,
    });
    file.detach();
  });
});

describe('reorderTabs', () => {
  it('appends a tab when beforeTabId is null', () => {
    const { useChatStore } = loadChatStore();

    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [KEY]: {
          tabs: [
            makeChatTab('chat-a'),
            makeChatTab('chat-b'),
            makeChatTab('chat-c'),
          ],
          activeTabId: 'chat-a',
        },
      },
    });

    useChatStore.getState().reorderTabs('chat-a', null);

    expect(
      useChatStore.getState().worktreeChats[KEY].tabs.map((tab) => tab.id),
    ).toEqual(['chat-b', 'chat-c', 'chat-a']);
  });

  it('inserts before the requested target', () => {
    const { useChatStore } = loadChatStore();

    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [KEY]: {
          tabs: [
            makeChatTab('chat-a'),
            makeChatTab('chat-b'),
            makeChatTab('chat-c'),
          ],
          activeTabId: 'chat-a',
        },
      },
    });

    useChatStore.getState().reorderTabs('chat-c', 'chat-b');

    expect(
      useChatStore.getState().worktreeChats[KEY].tabs.map((tab) => tab.id),
    ).toEqual(['chat-a', 'chat-c', 'chat-b']);
  });

  it('treats an invalid beforeTabId as a no-op', () => {
    const { useChatStore } = loadChatStore();

    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [KEY]: {
          tabs: [
            makeChatTab('chat-a'),
            makeChatTab('chat-b'),
            makeChatTab('chat-c'),
          ],
          activeTabId: 'chat-a',
        },
      },
    });

    useChatStore.getState().reorderTabs('chat-c', 'missing-tab');

    expect(
      useChatStore.getState().worktreeChats[KEY].tabs.map((tab) => tab.id),
    ).toEqual(['chat-a', 'chat-b', 'chat-c']);
  });
});

describe('expireMcpQuestion', () => {
  it('removes a pending question card by requestId', () => {
    const { useChatStore } = loadChatStore();
    useChatStore.setState({
      worktreeChats: {
        [KEY]: { tabs: [makeChatTab('c')], activeTabId: 'c' },
      },
      pendingQuestions: {
        'req-1': {
          requestId: 'req-1',
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          chatId: 'c',
          questions: [],
        },
      },
    });
    useChatStore.getState().expireMcpQuestion('req-1');
    expect(useChatStore.getState().pendingQuestions['req-1']).toBeUndefined();
  });
});
