/**
 * Regression coverage for the "new worktree with no visible chat tab" bug:
 *
 * - A failed hydration (`loadTabs` / `loadAllWorktreeTabs`) must still leave
 *   the worktree with a visible fallback tab instead of an empty chat panel,
 *   and must stay retryable so a later hydration merges the real persisted
 *   tabs. (Durable chat state is main-owned now, so the renderer fallback can
 *   never clobber persisted tabs; the renderer-side concern is purely the
 *   in-memory merge.)
 * - "Add chat" on a worktree with no store entry must create exactly one tab
 *   (it used to synthesize an implicit default tab plus the new tab, which
 *   surfaced as two tabs appearing at once).
 */
import type {
  CanopyApi,
  ChatTabsFile,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type * as ChatStoreModule from '../chatStore';
import type * as TabLifecycleModule from '../chat/tab-lifecycle';
import type * as HydrationModule from '../chat/hydration';
import { shouldKeepWorktreeChatHydrated } from '../chat/hydration';
import type { WorktreeChatState } from '../chat/types';

const loadPreferencesMock = jest.fn();
const loadTabsMock = jest.fn();
const activeSessionsMock = jest.fn();
const getResolvedApprovalDefaultMock = jest.fn();
const flushScopeMock = jest.fn<
  Promise<void>,
  [{ projectId: string; worktreeId: string }]
>();
const discoverWorktreeEnvMock = jest.fn();

declare global {
  interface Window {
    api: CanopyApi;
  }
}

let loadedHydration: typeof HydrationModule | null = null;

// A pending idle-unload timer closes over its module instance, so it keeps a
// `jest.resetModules()` copy of the whole store graph alive until it fires.
function releaseLoadedChatStore(): void {
  loadedHydration?.clearIdleChatUnloadTimer();
  loadedHydration = null;
}

function loadChatStore(): typeof ChatStoreModule {
  releaseLoadedChatStore();
  jest.resetModules();
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: {
      api: {
        loadPreferences: loadPreferencesMock,
        discoverWorktreeEnv: discoverWorktreeEnvMock,
        chat: {
          loadTabs: loadTabsMock,
          activeSessions: activeSessionsMock,
          flushScope: flushScopeMock,
        },
        approvals: {
          getResolvedDefault: getResolvedApprovalDefaultMock,
        },
      },
    },
  });
  const chatStore = jest.requireActual<typeof ChatStoreModule>('../chatStore');
  loadedHydration =
    jest.requireActual<typeof HydrationModule>('../chat/hydration');
  return chatStore;
}

function persistedTab(id: string): PersistedChatTab {
  return {
    id,
    title: `Tab ${id}`,
    messages: [],
    createdAt: new Date().toISOString(),
  };
}

function tabsFile(tabs: PersistedChatTab[], activeTabId: string): ChatTabsFile {
  return { version: 1, tabs, activeTabId };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  loadPreferencesMock.mockResolvedValue({
    defaultChatProvider: 'codex',
    defaultChatModelByProvider: {
      claude: { model: 'sonnet' },
      codex: { model: 'gpt-5.5' },
    },
    defaultWorktreeProvider: 'codex',
    defaultWorktreeModelByProvider: {
      claude: { model: 'sonnet' },
      codex: { model: 'gpt-5.5' },
    },
  });
  activeSessionsMock.mockResolvedValue({ activeChatIds: [] });
  getResolvedApprovalDefaultMock.mockResolvedValue('full-access');
  flushScopeMock.mockResolvedValue(undefined);
  discoverWorktreeEnvMock.mockResolvedValue(undefined);
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 600));
  releaseLoadedChatStore();
});

describe('chat tab hydration resilience', () => {
  it('falls back to a visible default tab when loadTabs rejects', async () => {
    const { useChatStore } = loadChatStore();
    loadTabsMock.mockRejectedValue(new Error('ipc failure'));

    useChatStore.setState({
      selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
    });
    await useChatStore.getState().loadTabs();

    const wc = useChatStore.getState().worktreeChats['proj/wt'];
    expect(wc).toBeDefined();
    expect(wc.tabs).toHaveLength(1);
    expect(wc.activeTabId).toBe(wc.tabs[0]?.id);
    expect(wc.tabs[0]?.approvalMode).toBe('full-access');
  });

  it('does not stamp an existing tab when fallback runs after hydration installed the scope', async () => {
    const { useChatStore } = loadChatStore();
    const { applyFallbackWorktreeChatState } = jest.requireActual<
      typeof TabLifecycleModule
    >('../chat/tab-lifecycle');
    loadTabsMock.mockRejectedValue(new Error('initial fallback'));

    useChatStore.setState({
      selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
    });
    await useChatStore.getState().loadTabs();
    useChatStore.setState((state) => ({
      worktreeChats: {
        ...state.worktreeChats,
        'proj/wt': {
          ...state.worktreeChats['proj/wt'],
          tabs: state.worktreeChats['proj/wt'].tabs.map((tab) => ({
            ...tab,
            approvalMode: undefined,
          })),
        },
      },
    }));
    getResolvedApprovalDefaultMock.mockClear();

    await applyFallbackWorktreeChatState('proj', 'wt');

    expect(getResolvedApprovalDefaultMock).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().worktreeChats['proj/wt'].tabs[0]?.approvalMode,
    ).toBeUndefined();
  });

  it('retries hydration after a failure and merges the real persisted tabs', async () => {
    const { useChatStore } = loadChatStore();
    loadTabsMock.mockRejectedValueOnce(new Error('transient failure'));

    useChatStore.setState({
      selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
    });
    await useChatStore.getState().loadTabs();
    expect(useChatStore.getState().worktreeChats['proj/wt'].tabs).toHaveLength(
      1,
    );

    loadTabsMock.mockResolvedValue(
      tabsFile([persistedTab('chat-a'), persistedTab('chat-b')], 'chat-b'),
    );
    await useChatStore.getState().loadTabs();

    const wc = useChatStore.getState().worktreeChats['proj/wt'];
    const ids = wc.tabs.map((tab) => tab.id);
    expect(ids).toEqual(expect.arrayContaining(['chat-a', 'chat-b']));
    expect(wc.tabs.length).toBeGreaterThanOrEqual(2);
    expect(wc.activeTabId).not.toBe('');
    expect(wc.tabs.some((tab) => tab.id === wc.activeTabId)).toBe(true);
  });

  it('hydrates a fresh worktree with a default tab and an active tab id', async () => {
    const { useChatStore } = loadChatStore();
    loadTabsMock.mockResolvedValue(tabsFile([], ''));

    useChatStore.setState({
      selectedWorktree: { projectId: 'proj', worktreeId: 'fresh' },
    });
    await useChatStore.getState().loadTabs();

    const wc = useChatStore.getState().worktreeChats['proj/fresh'];
    expect(wc.tabs).toHaveLength(1);
    expect(wc.activeTabId).toBe(wc.tabs[0]?.id);
  });

  it('keeps other worktrees hydrating when one loadAllWorktreeTabs item fails', async () => {
    const { useChatStore } = loadChatStore();
    loadTabsMock.mockImplementation((request: { worktreeId: string }) =>
      request.worktreeId === 'bad'
        ? Promise.reject(new Error('corrupt worktree'))
        : Promise.resolve(tabsFile([persistedTab('chat-good')], 'chat-good')),
    );

    await useChatStore.getState().loadAllWorktreeTabs([
      { projectId: 'proj', worktreeId: 'bad' },
      { projectId: 'proj', worktreeId: 'good' },
    ]);

    const bad = useChatStore.getState().worktreeChats['proj/bad'];
    const good = useChatStore.getState().worktreeChats['proj/good'];
    expect(bad.tabs).toHaveLength(1);
    expect(bad.activeTabId).toBe(bad.tabs[0]?.id);
    expect(good.tabs.map((tab) => tab.id)).toEqual(['chat-good']);
    expect(good.activeTabId).toBe('chat-good');
  });

  it('creates exactly one tab when "add chat" runs against a missing store entry', () => {
    const { useChatStore } = loadChatStore();

    useChatStore.setState({
      selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
    });
    expect(useChatStore.getState().worktreeChats['proj/wt']).toBeUndefined();

    useChatStore.getState().createTab();

    const wc = useChatStore.getState().worktreeChats['proj/wt'];
    expect(wc.tabs).toHaveLength(1);
    expect(wc.activeTabId).toBe(wc.tabs[0]?.id);
  });

  it('binds repository scope to an explicitly targeted new tab', () => {
    const { useChatStore } = loadChatStore();

    useChatStore.setState({
      selectedWorktree: { projectId: 'other', worktreeId: 'active' },
    });
    useChatStore.getState().createTab({
      projectId: 'proj',
      worktreeId: 'target',
      selectedRepoId: 'api',
    });

    const target = useChatStore.getState().worktreeChats['proj/target'];
    expect(target.tabs).toHaveLength(1);
    expect(target.tabs[0]?.selectedRepoId).toBe('api');
    expect(useChatStore.getState().selectedWorktree).toEqual({
      projectId: 'other',
      worktreeId: 'active',
    });
  });

  it('merges a newly added tab with persisted tabs once slow hydration completes', async () => {
    const { useChatStore } = loadChatStore();
    const pendingLoad = deferred<ChatTabsFile>();
    loadTabsMock.mockReturnValue(pendingLoad.promise);

    useChatStore.setState({
      selectedWorktree: { projectId: 'proj', worktreeId: 'slow' },
    });
    useChatStore.getState().createTab();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loadTabsMock).toHaveBeenCalledTimes(1);

    const newTabId =
      useChatStore.getState().worktreeChats['proj/slow']?.tabs[0]?.id;
    expect(newTabId).toBeDefined();

    pendingLoad.resolve(tabsFile([persistedTab('persisted')], 'persisted'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The hydration merge must keep the tab created before persisted tabs
    // arrived, add the persisted tab exactly once, and not duplicate either.
    const wc = useChatStore.getState().worktreeChats['proj/slow'];
    const ids = wc.tabs.map((tab) => tab.id);
    expect(ids).toContain('persisted');
    expect(ids).toContain(newTabId);
    expect(wc.tabs).toHaveLength(2);
    expect(new Set(ids).size).toBe(ids.length);
    expect(wc.tabs.some((tab) => tab.id === wc.activeTabId)).toBe(true);
  });

  it('idle-unloads a worktree whose only pending questions are answered but keeps one with an unanswered question', () => {
    const { useChatStore } = loadChatStore();
    const key = 'proj/wt';
    // An empty tab list isolates the pending-question gate: nothing else can
    // pin the worktree in memory.
    const idleChatState: WorktreeChatState = { tabs: [], activeTabId: '' };

    // Only an ANSWERED record for this worktree: retained for projection but
    // must not keep the worktree hydrated (it can idle-unload).
    useChatStore.setState({
      selectedWorktree: null,
      unreadWorktreeKeys: new Set<string>(),
      pendingPlanExits: {},
      pendingQuestions: {
        'req-answered': {
          requestId: 'req-answered',
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: 'chat',
          questions: [{ id: 'q1', question: 'Continue?', options: ['yes'] }],
          answers: [
            {
              questionId: 'q1',
              question: 'Continue?',
              selectedOptions: ['yes'],
            },
          ],
          answeredAt: 1_717_000_000_000,
        },
      },
    });

    expect(
      shouldKeepWorktreeChatHydrated(
        useChatStore.getState(),
        key,
        idleChatState,
      ),
    ).toBe(false);

    // An UNANSWERED (actionable) record for the same worktree still pins it.
    useChatStore.setState({
      pendingQuestions: {
        'req-open': {
          requestId: 'req-open',
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: 'chat',
          questions: [{ id: 'q1', question: 'Continue?', options: ['yes'] }],
        },
      },
    });

    expect(
      shouldKeepWorktreeChatHydrated(
        useChatStore.getState(),
        key,
        idleChatState,
      ),
    ).toBe(true);
  });

  it('does not retry failed fallback hydration in a loop for pending events', async () => {
    const { useChatStore } = loadChatStore();
    const errorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    loadTabsMock.mockRejectedValue(new Error('persistent failure'));

    try {
      useChatStore.getState().handleChatEvent({
        projectId: 'proj',
        worktreeId: 'failing',
        chatId: 'chat-1',
        data: { type: 'result', result: 'done', is_error: false },
      });

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(loadTabsMock).toHaveBeenCalledTimes(1);
      expect(
        useChatStore.getState().worktreeChats['proj/failing']?.tabs,
      ).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
