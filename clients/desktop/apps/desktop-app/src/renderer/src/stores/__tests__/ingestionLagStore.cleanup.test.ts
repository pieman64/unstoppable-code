import type { ChatIngestionLag } from '@canopy/desktop-shared/types';
import type * as ChatStoreModule from '../chatStore';
import type * as IngestionLagStoreModule from '../ingestionLagStore';
import type { ChatTab } from '../chatStore';

const noop = (): void => undefined;

function emptyPromise(): Promise<undefined> {
  return Promise.resolve(undefined);
}

function loadStores(): {
  chatStore: typeof ChatStoreModule;
  lagStore: typeof IngestionLagStoreModule;
} {
  jest.resetModules();
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: {
      api: {
        chat: {
          flushScope: emptyPromise,
          forkOpenWorktreeTabs: jest
            .fn()
            .mockResolvedValue({ tabBindings: {} }),
          adhocMigrateTabs: jest.fn().mockResolvedValue({ migratedTabIds: [] }),
          loadTabs: jest.fn().mockResolvedValue({
            version: 1,
            tabs: [],
            activeTabId: '',
          }),
          saveTabs: emptyPromise,
          saveTabsPartial: jest
            .fn()
            .mockResolvedValue({ needsFullSave: false }),
          sendMessage: emptyPromise,
          activeSessions: jest
            .fn()
            .mockResolvedValue({ activeChatIds: [], sessions: [] }),
          getChatQueueSnapshot: jest.fn().mockResolvedValue([]),
          getState: jest.fn().mockResolvedValue(undefined),
          archiveTab: jest.fn().mockResolvedValue([]),
          changeModel: jest.fn().mockResolvedValue(true),
          toggleThinkingLevel: emptyPromise,
          togglePlanMode: emptyPromise,
          forkCodexThread: jest
            .fn()
            .mockResolvedValue({ forkedThreadId: 'forked' }),
          command: jest.fn().mockResolvedValue({ outcome: 'applied' }),
        },
        github: {
          setForegroundWorktree: emptyPromise,
          requestFastRefresh: emptyPromise,
          requestKnownPrFastRefresh: jest.fn().mockResolvedValue(true),
        },
        terminal: { write: emptyPromise, onExit: jest.fn(() => noop) },
        claudeTerminal: {
          cleanup: emptyPromise,
          getState: jest.fn().mockResolvedValue(undefined),
          syncTranscript: jest
            .fn()
            .mockResolvedValue({ chatId: 'chat', importedEventCount: 0 }),
          onStateChanged: jest.fn(() => noop),
          onSyncCompleted: jest.fn(() => noop),
          onError: jest.fn(() => noop),
        },
        approvals: {
          pendingRequests: jest.fn().mockResolvedValue([]),
          getResolvedDefault: jest.fn().mockResolvedValue('ask'),
          setMode: emptyPromise,
        },
        getDiffStatsBatch: jest.fn().mockResolvedValue([]),
        discoverWorktreeEnv: emptyPromise,
        loadPreferences: jest.fn().mockResolvedValue({}),
        savePreferences: emptyPromise,
        saveFileContent: jest.fn().mockResolvedValue({
          filename: 'notes.md',
          sizeBytes: 0,
          modifiedAtMs: 0,
        }),
        getWorktreePath: jest.fn().mockResolvedValue('/worktree'),
      },
    },
  });

  return {
    chatStore: jest.requireActual<typeof ChatStoreModule>('../chatStore'),
    lagStore: jest.requireActual<typeof IngestionLagStoreModule>(
      '../ingestionLagStore',
    ),
  };
}

function makeChatTab(id: string): ChatTab {
  return {
    id,
    title: `Chat ${id}`,
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
  };
}

const LAG: ChatIngestionLag = {
  lagMs: 1000,
  source: 'receipt',
  sampledAtMs: 500,
  catchingUp: true,
};

describe('ingestion lag cleanup from chat lifecycle', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('clears a released revisioned scope and preserves other scopes', () => {
    const { chatStore, lagStore } = loadStores();
    const useChatStore = chatStore.useChatStore;
    const useIngestionLagStore = lagStore.useIngestionLagStore;
    useIngestionLagStore
      .getState()
      .setLag({ projectId: 'p', worktreeId: 'w', chatId: 'chat-1' }, LAG);
    useIngestionLagStore
      .getState()
      .setLag({ projectId: 'p', worktreeId: 'w2', chatId: 'chat-2' }, LAG);

    useChatStore.getState().releaseChatScopeRevisioned('p', 'w');

    expect(
      useIngestionLagStore.getState().lagByChat['p/w/chat-1'],
    ).toBeUndefined();
    expect(
      useIngestionLagStore.getState().lagByChat['p/w2/chat-2'],
    ).toBeDefined();
  });

  it('clears the chat entry when closeTab finalizes an idle tab', () => {
    const { chatStore, lagStore } = loadStores();
    const useChatStore = chatStore.useChatStore;
    const useIngestionLagStore = lagStore.useIngestionLagStore;
    const target = { projectId: 'p', worktreeId: 'w' };
    useChatStore.setState({
      selectedWorktree: target,
      worktreeChats: {
        'p/w': {
          tabs: [makeChatTab('close-me'), makeChatTab('keep-me')],
          activeTabId: 'close-me',
        },
      },
    });
    useIngestionLagStore
      .getState()
      .setLag({ ...target, chatId: 'close-me' }, LAG);
    useIngestionLagStore
      .getState()
      .setLag({ ...target, chatId: 'keep-me' }, LAG);

    useChatStore.getState().closeTab('close-me', target);

    expect(
      useIngestionLagStore.getState().lagByChat['p/w/close-me'],
    ).toBeUndefined();
    expect(
      useIngestionLagStore.getState().lagByChat['p/w/keep-me'],
    ).toBeDefined();
  });

  it('clears every finalized chat entry when closeTabs closes multiple idle tabs', () => {
    const { chatStore, lagStore } = loadStores();
    const useChatStore = chatStore.useChatStore;
    const useIngestionLagStore = lagStore.useIngestionLagStore;
    const target = { projectId: 'p', worktreeId: 'w' };
    useChatStore.setState({
      selectedWorktree: target,
      worktreeChats: {
        'p/w': {
          tabs: [
            makeChatTab('close-one'),
            makeChatTab('close-two'),
            makeChatTab('keep-me'),
          ],
          activeTabId: 'close-one',
        },
      },
    });
    useIngestionLagStore
      .getState()
      .setLag({ ...target, chatId: 'close-one' }, LAG);
    useIngestionLagStore
      .getState()
      .setLag({ ...target, chatId: 'close-two' }, LAG);
    useIngestionLagStore
      .getState()
      .setLag({ ...target, chatId: 'keep-me' }, LAG);

    useChatStore.getState().closeTabs(['close-one', 'close-two'], target);

    const entries = useIngestionLagStore.getState().lagByChat;
    expect(entries['p/w/close-one']).toBeUndefined();
    expect(entries['p/w/close-two']).toBeUndefined();
    expect(entries['p/w/keep-me']).toBeDefined();
  });
});
