/**
 * Store-level coverage for the revisioned chat-state projection (frontend
 * plan):
 *
 * - Hydration prefers the main-owned revisioned snapshot and never runs the
 *   legacy load-merge-save path for a scope main serves.
 * - Existing scopes never flash a blank starter before their snapshot. A
 *   known-new scope can expose its starter after defaults resolve, retaining
 *   its identity through canonical creation. Load failures retain retry UI.
 * - Committed deltas apply in revision order; duplicates/old revisions are
 *   ignored; a gap enters the refreshing state (send disabled) and issues
 *   exactly one fresh snapshot query while the last good transcript stays.
 * - A failed refresh keeps the last transcript and the approved inline error;
 *   Retry recovers.
 * - dispatchChatCommand reconciles/rolls back per command and surfaces the
 *   approved conflict / failure copy; conflicts refresh, never auto-retry.
 * - Legacy provider-event reduction is suppressed for revisioned scopes, and
 *   the renderer never writes a snapshot for them.
 */
import type {
  ApprovalRequestEvent,
  CanopyApi,
  ChatCommand,
  ChatCommandEnvelope,
  ChatCommandResult,
  ChatStateChangedEvent,
  ChatStateSnapshot,
  ChatTabsFile,
  GitHubWorkflowRunArtifactReceiptV1,
  PersistedChatTab,
  initCodexModels as InitCodexModels,
} from '@canopy/desktop-shared/types';
import type * as ChatStoreModule from '../chatStore';
import type * as DiffStatsRuntimeModule from '../projectsStore.diffStatsRuntime';
import type * as NavigationStoreModule from '../navigationStore';
import type * as RevisionedChatSyncModule from '../chat/slices/revisioned';
import type * as DelegationActivityStoreModule from '../delegationActivityStore';
import type * as ChatInterestRedeclareModule from '@/lib/chat-interest/redeclare';
import {
  CHAT_STATE_COMMAND_FAILED_NOTICE,
  CHAT_STATE_CONFLICT_NOTICE,
} from '../chat/revisioned-copy';
import { buildGitHubWorkflowRunArtifactReceipt } from '@canopy/desktop-shared/lib/agent-artifacts';

const loadPreferencesMock = jest.fn();
const loadTabsMock = jest.fn();
const activeSessionsMock = jest.fn();
const saveTabsMock = jest.fn();
const saveTabsPartialMock = jest.fn();
const getChatQueueSnapshotMock = jest.fn();
const getStateMock = jest.fn();
const archiveTabMock = jest.fn();
const changeModelMock = jest.fn();
const forkOpenWorktreeTabsMock = jest.fn();
const commandMock = jest.fn<
  Promise<ChatCommandResult>,
  [ChatCommandEnvelope<ChatCommand>]
>();
const discoverWorktreeEnvMock = jest.fn();
const pendingApprovalRequestsMock = jest.fn();
const getResolvedDefaultMock = jest.fn();
const setModeMock = jest.fn().mockResolvedValue(undefined);
const toggleThinkingLevelMock = jest.fn().mockResolvedValue(undefined);
const togglePlanModeMock = jest.fn().mockResolvedValue(undefined);

declare global {
  interface Window {
    api: CanopyApi;
  }
}

function loadChatStore(): typeof ChatStoreModule {
  jest.resetModules();
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: {
      api: {
        loadPreferences: loadPreferencesMock,
        savePreferences: jest.fn().mockResolvedValue(undefined),
        discoverWorktreeEnv: discoverWorktreeEnvMock,
        getDiffStatsBatch: jest.fn().mockResolvedValue([]),
        github: {
          setForegroundWorktree: jest.fn().mockResolvedValue(undefined),
          requestFastRefresh: jest.fn().mockResolvedValue(undefined),
          requestKnownPrFastRefresh: jest.fn().mockResolvedValue(false),
        },
        approvals: {
          pendingRequests: pendingApprovalRequestsMock,
          getResolvedDefault: getResolvedDefaultMock,
          setMode: setModeMock,
        },
        chat: {
          loadTabs: loadTabsMock,
          activeSessions: activeSessionsMock,
          saveTabs: saveTabsMock,
          saveTabsPartial: saveTabsPartialMock,
          getChatQueueSnapshot: getChatQueueSnapshotMock,
          getState: getStateMock,
          archiveTab: archiveTabMock,
          changeModel: changeModelMock,
          toggleThinkingLevel: toggleThinkingLevelMock,
          togglePlanMode: togglePlanModeMock,
          forkOpenWorktreeTabs: forkOpenWorktreeTabsMock,
          command: commandMock,
        },
      },
    },
  });
  return jest.requireActual<typeof ChatStoreModule>('../chatStore');
}

function persistedTab(
  id: string,
  overrides: Partial<PersistedChatTab> = {},
): PersistedChatTab {
  return {
    id,
    title: `Tab ${id}`,
    messages: [
      {
        id: `${id}-m1`,
        role: 'user',
        blocks: [{ type: 'text', text: 'hello there' }],
        timestamp: 1,
      },
    ],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function tabsFile(tabs: PersistedChatTab[], activeTabId: string): ChatTabsFile {
  return { version: 1, tabs, activeTabId };
}

function snapshot(
  revision: number,
  tabs: PersistedChatTab[],
  activeTabId: string,
): ChatStateSnapshot {
  return {
    schemaVersion: 1,
    projectId: 'proj',
    worktreeId: 'wt',
    revision,
    tabsFile: tabsFile(tabs, activeTabId),
    archives: [],
    runtimeByChatId: {},
    queue: [],
  };
}

let eventCounter = 0;
function changeEvent(
  baseRevision: number,
  revision: number,
  changes: ChatStateChangedEvent['changes'],
): ChatStateChangedEvent {
  eventCounter += 1;
  return {
    schemaVersion: 1,
    eventId: `evt-${String(eventCounter)}`,
    occurredAt: new Date().toISOString(),
    projectId: 'proj',
    worktreeId: 'wt',
    baseRevision,
    revision,
    changes,
  };
}

function commandResult(
  commandId: string,
  outcome: ChatCommandResult['outcome'],
): ChatCommandResult {
  return { commandId, revision: 9, outcome };
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
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const KEY = 'proj/wt';

// Each test re-imports chatStore after `jest.resetModules()`. With a cold
// transform cache, the first import compiles the whole store graph and can
// exceed the per-test timeout. Load it once before the tests run.
beforeAll(() => {
  loadChatStore();
}, 60_000);

beforeEach(() => {
  jest.clearAllMocks();
  // Null model defaults: `ensureModelDefaultsLoaded` absorbs the failure and
  // the defaults resolvers fall back to built-ins (matches cold startup
  // before preferences load).
  loadPreferencesMock.mockRejectedValue(new Error('preferences unavailable'));
  activeSessionsMock.mockResolvedValue({ activeChatIds: [] });
  getChatQueueSnapshotMock.mockResolvedValue([]);
  saveTabsMock.mockResolvedValue(undefined);
  saveTabsPartialMock.mockResolvedValue({ needsFullSave: false });
  pendingApprovalRequestsMock.mockResolvedValue([]);
  getResolvedDefaultMock.mockResolvedValue('ask');
  archiveTabMock.mockResolvedValue([]);
  changeModelMock.mockResolvedValue(true);
  forkOpenWorktreeTabsMock.mockResolvedValue({ tabBindings: {} });
});

describe('revisioned hydration', () => {
  // This first test loads the store's dependency graph in a busy CI shard.
  it('exposes only a newly created scope before hydration, with resolved defaults and a stable draft target', async () => {
    const { useChatStore } = loadChatStore();
    const pending = deferred<ChatStateSnapshot>();
    const approval = deferred<'full-access'>();
    getStateMock.mockReturnValue(pending.promise);
    getResolvedDefaultMock.mockReturnValue(approval.promise);
    useChatStore.getState().applyModelDefaults({
      defaultWorktreeProvider: 'claude',
      defaultWorktreeModelByProvider: {
        claude: { model: 'sonnet', thinkingLevel: 'low' },
      },
      defaultChatInterfaceMode: 'canopy',
    });
    commandMock.mockImplementation((request) => {
      if (request.command.type === 'chat.create_tab') {
        // Main owns the persisted creation timestamp; only the tab id is
        // preserved from the eager renderer starter.
        useChatStore.getState().handleChatStateChanged(
          changeEvent(0, 1, [
            {
              type: 'tab.upserted',
              tab: persistedTab(request.command.tabId, {
                createdAt: '2026-01-01T00:00:00.000Z',
                messages: [],
                model: 'sonnet',
                approvalMode: 'full-access',
              }),
            },
          ]),
        );
      }
      return Promise.resolve(commandResult(request.commandId, 'applied'));
    });
    const options = { newlyCreated: true };
    useChatStore.getState().selectWorktree('proj', 'wt', options);
    jest
      .requireActual<
        typeof DiffStatsRuntimeModule
      >('../projectsStore.diffStatsRuntime')
      .diffStatsRuntimeTestExports.flush();
    await flushMicrotasks();
    expect(useChatStore.getState().worktreeChats[KEY]).toBeUndefined();
    approval.resolve('full-access');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const starter = useChatStore.getState().worktreeChats[KEY]?.tabs[0];
    expect(starter).toMatchObject({
      model: 'sonnet',
      thinkingLevel: 'low',
      approvalMode: 'full-access',
    });
    expect(commandMock).not.toHaveBeenCalled();
    const thinkingChange = useChatStore.getState().setThinkingLevel('high', {
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: starter.id,
    });
    const settingsTarget = {
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: starter.id,
    };
    const approvalChange = useChatStore
      .getState()
      .setTabApprovalMode(settingsTarget, 'ask');
    useChatStore.getState().togglePlanMode(settingsTarget);
    await flushMicrotasks();
    expect(toggleThinkingLevelMock).not.toHaveBeenCalled();
    expect(setModeMock).not.toHaveBeenCalled();
    expect(togglePlanModeMock).not.toHaveBeenCalled();
    pending.resolve(snapshot(0, [], ''));
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    await Promise.all([thinkingChange, approvalChange]);
    expect(setModeMock).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: starter.id, mode: 'ask' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(togglePlanModeMock).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: starter.id, enabled: true }),
    );
    expect(toggleThinkingLevelMock).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: starter.id, level: 'high' }),
    );
    expect(useChatStore.getState().worktreeChats[KEY]?.tabs[0]?.id).toBe(
      starter?.id,
    );
    expect(commandMock.mock.calls[0]?.[0].command).toMatchObject({
      type: 'chat.create_tab',
      tabId: starter?.id,
      approvalMode: 'full-access',
    });
  }, 20_000);

  it('installs the canonical snapshot without running the legacy load path', async () => {
    const { useChatStore } = loadChatStore();
    getStateMock.mockResolvedValue(
      snapshot(5, [persistedTab('chat-1')], 'chat-1'),
    );

    await useChatStore.getState().loadTabsForTarget('proj', 'wt');

    const state = useChatStore.getState();
    expect(state.worktreeChats[KEY]?.tabs.map((tab) => tab.id)).toEqual([
      'chat-1',
    ]);
    expect(
      state.worktreeChats[KEY]?.tabs[0]?.messages.map((m) => m.id),
    ).toEqual(['chat-1-m1']);
    expect(state.chatStateSync[KEY]).toEqual({ phase: 'live', revision: 5 });
    expect(loadTabsMock).not.toHaveBeenCalled();
    expect(saveTabsMock).not.toHaveBeenCalled();
    expect(saveTabsPartialMock).not.toHaveBeenCalled();
  });

  it('declares a scope to main before querying its snapshot, and drops it on release', async () => {
    const { useChatStore } = loadChatStore();
    const order: string[] = [];
    const setStateScopes = jest.fn(
      (declaration: { kind: string; scopes?: unknown[] }): Promise<void> => {
        order.push(`declare:${JSON.stringify(declaration)}`);
        return Promise.resolve();
      },
    );
    Object.assign(window.api.chat, { setStateScopes });
    getStateMock.mockImplementation((): Promise<ChatStateSnapshot> => {
      order.push('query');
      return Promise.resolve(snapshot(5, [persistedTab('chat-1')], 'chat-1'));
    });

    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    useChatStore.getState().releaseChatScopeRevisioned('proj', 'wt');

    const scoped = JSON.stringify({
      kind: 'scopes',
      scopes: [{ projectId: 'proj', worktreeId: 'wt' }],
    });
    const empty = JSON.stringify({ kind: 'scopes', scopes: [] });
    expect(order.indexOf(`declare:${scoped}`)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(`declare:${scoped}`)).toBeLessThan(
      order.indexOf('query'),
    );
    expect(order[order.length - 1]).toBe(`declare:${empty}`);
  });

  it('asks for a chat interest re-declare with each scope declaration', async () => {
    const { useChatStore } = loadChatStore();
    const redeclare = jest.requireActual<typeof ChatInterestRedeclareModule>(
      '@/lib/chat-interest/redeclare',
    );
    const handler = jest.fn();
    const removeHandler = redeclare.setChatInterestRedeclareHandler(handler);
    getStateMock.mockResolvedValue(
      snapshot(5, [persistedTab('chat-1')], 'chat-1'),
    );

    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    const afterHydration = handler.mock.calls.length;
    useChatStore.getState().releaseChatScopeRevisioned('proj', 'wt');

    expect(afterHydration).toBeGreaterThan(0);
    expect(handler.mock.calls.length).toBeGreaterThan(afterHydration);
    removeHandler();
  });

  it('auto-archives a completed tab restored from the canonical snapshot', async () => {
    const { useChatStore } = loadChatStore();
    const restored = snapshot(
      5,
      [
        persistedTab('chat-1', { autoArchive: true, unread: true }),
        persistedTab('keeper'),
      ],
      'keeper',
    );
    restored.runtimeByChatId = {
      'chat-1': {
        status: 'completed',
        queuedMessageIds: [],
        lastActivityAt: 100,
      },
    };
    getStateMock.mockResolvedValue(restored);

    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    await flushMicrotasks();

    expect(archiveTabMock).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt',
      tabId: 'chat-1',
      unread: true,
      keepSession: true,
    });
  });

  it('schedules idle unload for a scope hydrated outside a load', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
    try {
      const { useChatStore } = loadChatStore();
      getStateMock.mockResolvedValue(
        snapshot(5, [persistedTab('chat-1')], 'chat-1'),
      );
      await useChatStore
        .getState()
        .hydrateChatScopeRevisioned('proj', 'wt', { speculative: true });
      expect(useChatStore.getState().worktreeChats[KEY]).toBeDefined();

      // Past the ten-minute idle limit, the never-opened scope is unloaded.
      await jest.advanceTimersByTimeAsync(11 * 60 * 1000);
      expect(useChatStore.getState().worktreeChats[KEY]).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('defers snapshot auto-archive of a scope hydrated for a prefetch until it is loaded', async () => {
    const { useChatStore } = loadChatStore();
    const restored = snapshot(
      5,
      [
        persistedTab('chat-1', { autoArchive: true, unread: true }),
        persistedTab('keeper'),
      ],
      'keeper',
    );
    restored.runtimeByChatId = {
      'chat-1': {
        status: 'completed',
        queuedMessageIds: [],
        lastActivityAt: 100,
      },
    };
    getStateMock.mockResolvedValue(restored);

    await useChatStore
      .getState()
      .hydrateChatScopeRevisioned('proj', 'wt', { speculative: true });
    await flushMicrotasks();
    // A hover never writes stored state.
    expect(archiveTabMock).not.toHaveBeenCalled();

    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    await flushMicrotasks();
    expect(archiveTabMock).toHaveBeenCalledTimes(1);
    expect(archiveTabMock).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 'chat-1' }),
    );
  });

  it('does not auto-archive a completed tab with an unanswered async question', async () => {
    const { useChatStore } = loadChatStore();
    const restored = snapshot(
      5,
      [
        persistedTab('chat-1', { autoArchive: true, unread: true }),
        persistedTab('keeper'),
      ],
      'keeper',
    );
    restored.tabsFile.pendingQuestions = [
      {
        requestId: 'async-question',
        chatId: 'chat-1',
        delivery: 'async',
        questions: [{ id: '0', question: 'Which scope?', options: ['Full'] }],
      },
    ];
    restored.runtimeByChatId = {
      'chat-1': {
        status: 'completed',
        queuedMessageIds: [],
        lastActivityAt: 100,
      },
    };
    getStateMock.mockResolvedValue(restored);

    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    await flushMicrotasks();

    expect(archiveTabMock).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'answered', dismissedAt: undefined, expectedArchive: false },
    { label: 'dismissed', dismissedAt: 200, expectedArchive: true },
  ])(
    'handles auto-archive after a completed tab async question is $label',
    async ({ dismissedAt, expectedArchive }) => {
      const { useChatStore } = loadChatStore();
      const restored = snapshot(
        5,
        [
          persistedTab('chat-1', { autoArchive: true, unread: true }),
          persistedTab('keeper'),
        ],
        'keeper',
      );
      restored.tabsFile.pendingQuestions = [
        {
          requestId: 'async-question',
          chatId: 'chat-1',
          delivery: 'async',
          questions: [{ id: '0', question: 'Which scope?', options: ['Full'] }],
        },
      ];
      restored.runtimeByChatId = {
        'chat-1': {
          status: 'completed',
          queuedMessageIds: [],
          lastActivityAt: 100,
        },
      };
      getStateMock.mockResolvedValue(restored);

      await useChatStore.getState().loadTabsForTarget('proj', 'wt');
      await flushMicrotasks();
      expect(archiveTabMock).not.toHaveBeenCalled();

      useChatStore.getState().handleChatStateChanged(
        changeEvent(5, 6, [
          {
            type: 'pending_question.upserted',
            question: {
              ...restored.tabsFile.pendingQuestions[0],
              answers: [],
              answeredAt: 200,
              ...(dismissedAt ? { dismissedAt } : {}),
            },
          },
        ]),
      );
      await flushMicrotasks();

      if (expectedArchive) {
        expect(archiveTabMock).toHaveBeenCalledWith({
          projectId: 'proj',
          worktreeId: 'wt',
          tabId: 'chat-1',
          unread: true,
          keepSession: true,
        });
      } else {
        expect(archiveTabMock).not.toHaveBeenCalled();
      }
    },
  );

  it('recovers main-owned pending approvals during revisioned hydration', async () => {
    const { useChatStore } = loadChatStore();
    getStateMock.mockResolvedValue(
      snapshot(5, [persistedTab('chat-1')], 'chat-1'),
    );
    const pending: ApprovalRequestEvent = {
      requestId: 'approval-1',
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      provider: 'claude',
      title: 'Run command',
      details: { kind: 'command', command: 'npm publish' },
    };
    pendingApprovalRequestsMock.mockResolvedValue([pending]);

    await useChatStore.getState().loadTabsForTarget('proj', 'wt');

    expect(pendingApprovalRequestsMock).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().pendingApprovals['approval-1']).toEqual(
      pending,
    );
  });

  it.each(['foreground', 'background'] as const)(
    'finishes a scope that was only hydrated when the %s loader runs',
    async (loader) => {
      const { useChatStore } = loadChatStore();
      getStateMock.mockResolvedValue(
        snapshot(5, [persistedTab('chat-1')], 'chat-1'),
      );
      const pending: ApprovalRequestEvent = {
        requestId: 'approval-1',
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat-1',
        provider: 'claude',
        title: 'Run command',
        details: { kind: 'command', command: 'npm publish' },
      };
      pendingApprovalRequestsMock.mockResolvedValue([pending]);
      // A prefetch or refresh hydrates the scope without the loader's setup.
      await useChatStore.getState().hydrateChatScopeRevisioned('proj', 'wt');
      expect(useChatStore.getState().pendingApprovals['approval-1']).toBe(
        undefined,
      );

      if (loader === 'foreground') {
        useChatStore.setState({
          selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
        });
        await useChatStore.getState().loadTabs();
      } else {
        await useChatStore.getState().loadTabsForTarget('proj', 'wt');
      }

      expect(getStateMock).toHaveBeenCalledTimes(1);
      expect(useChatStore.getState().pendingApprovals['approval-1']).toEqual(
        pending,
      );
      // The setup runs once: a later load takes the plain fast path.
      await useChatStore.getState().loadTabsForTarget('proj', 'wt');
      expect(pendingApprovalRequestsMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['foreground', 'background'] as const)(
    'joins an in-flight %s tab load before returning to a Home send',
    async (firstLoader) => {
      const { useChatStore } = loadChatStore();
      const pending = deferred<ChatStateSnapshot>();
      getStateMock.mockReturnValue(pending.promise);
      useChatStore.setState({
        selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
      });
      const first =
        firstLoader === 'foreground'
          ? useChatStore.getState().loadTabs()
          : useChatStore.getState().loadTabsForTarget('proj', 'wt');
      await flushMicrotasks();
      let joinedSettled = false;
      const joined = (
        firstLoader === 'foreground'
          ? useChatStore.getState().loadTabsForTarget('proj', 'wt')
          : useChatStore.getState().loadTabs()
      ).then(() => {
        joinedSettled = true;
      });
      await flushMicrotasks();
      expect(joinedSettled).toBe(false);
      pending.resolve(
        snapshot(5, [persistedTab('existing-chat')], 'existing-chat'),
      );
      await Promise.all([first, joined]);
      expect(getStateMock).toHaveBeenCalledTimes(1);
      expect(
        useChatStore.getState().worktreeChats[KEY]?.tabs.map((tab) => tab.id),
      ).toEqual(['existing-chat']);
    },
  );

  it('does not report released or concurrent hydration as installed early', async () => {
    const { useChatStore } = loadChatStore();
    const pending = deferred<ChatStateSnapshot>();
    getStateMock.mockReturnValue(pending.promise);

    const first = useChatStore
      .getState()
      .hydrateChatScopeRevisioned('proj', 'wt');
    await flushMicrotasks();
    let secondSettled = false;
    const second = useChatStore
      .getState()
      .hydrateChatScopeRevisioned('proj', 'wt')
      .finally(() => {
        secondSettled = true;
      });
    await flushMicrotasks();
    expect(secondSettled).toBe(false);

    useChatStore.getState().releaseChatScopeRevisioned('proj', 'wt');
    pending.resolve(snapshot(5, [persistedTab('chat-1')], 'chat-1'));

    await expect(first).resolves.toBe('failed');
    await expect(second).resolves.toBe('failed');
  });

  it('falls back to the legacy path when main does not expose the revisioned service', async () => {
    const { useChatStore } = loadChatStore();
    getStateMock.mockRejectedValue(
      new Error(
        "Error invoking remote method 'chat:get-state': " +
          "No handler registered for 'chat:get-state'",
      ),
    );
    loadTabsMock.mockResolvedValue(
      tabsFile([persistedTab('legacy-1')], 'legacy-1'),
    );

    await useChatStore.getState().loadTabsForTarget('proj', 'wt');

    const state = useChatStore.getState();
    expect(loadTabsMock).toHaveBeenCalledTimes(1);
    expect(state.worktreeChats[KEY]?.tabs.map((tab) => tab.id)).toEqual([
      'legacy-1',
    ]);
    expect(state.chatStateSync[KEY]).toBeUndefined();

    // Once detected unavailable, later scopes go straight to legacy.
    getStateMock.mockClear();
    getResolvedDefaultMock.mockResolvedValue('full-access');
    loadTabsMock.mockResolvedValue(tabsFile([], ''));
    await useChatStore.getState().loadTabsForTarget('proj', 'wt2');
    expect(getStateMock).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().worktreeChats['proj/wt2']?.tabs[0]?.approvalMode,
    ).toBe('full-access');
  });

  it('stamps a starter tab with its creation-time approval mode before revisioned sync is live', async () => {
    const { useChatStore } = loadChatStore();
    getResolvedDefaultMock.mockResolvedValue('full-access');

    await useChatStore
      .getState()
      .ensureWorktreeHasChatTab({ projectId: 'proj', worktreeId: 'wt' });

    expect(useChatStore.getState().worktreeChats[KEY]?.tabs).toHaveLength(1);
    expect(
      useChatStore.getState().worktreeChats[KEY]?.tabs[0]?.approvalMode,
    ).toBe('full-access');
    expect(commandMock).not.toHaveBeenCalled();
  });

  it('never flashes a starter chat before the authoritative snapshot resolves, and shows the load-error treatment on failure', async () => {
    const { useChatStore } = loadChatStore();
    const pending = deferred<ChatStateSnapshot>();
    getStateMock.mockReturnValue(pending.promise);

    const hydration = useChatStore.getState().loadTabsForTarget('proj', 'wt');
    await flushMicrotasks();
    // Loading treatment: no fabricated empty chat while the query runs.
    expect(useChatStore.getState().worktreeChats[KEY]).toBeUndefined();
    expect(useChatStore.getState().chatStateSync[KEY]?.phase).toBe('hydrating');

    pending.reject(new Error('recovery failed'));
    await hydration;

    // Load error: inline error state, still no blank starter chat.
    expect(useChatStore.getState().worktreeChats[KEY]).toBeUndefined();
    expect(useChatStore.getState().chatStateSync[KEY]).toEqual({
      phase: 'refresh_error',
      revision: null,
    });
    expect(loadTabsMock).not.toHaveBeenCalled();
  });

  it('confirms an authoritative empty scope with a default tab only after the snapshot arrives', async () => {
    const { useChatStore } = loadChatStore();
    getStateMock.mockResolvedValue(snapshot(0, [], ''));
    getResolvedDefaultMock.mockResolvedValue('full-access');
    commandMock.mockImplementation((request) =>
      Promise.resolve(commandResult(request.commandId, 'applied')),
    );

    await useChatStore.getState().loadTabsForTarget('proj', 'wt');

    const chatState = useChatStore.getState().worktreeChats[KEY];
    expect(chatState?.tabs).toHaveLength(1);
    expect(chatState?.tabs[0]?.approvalMode).toBe('full-access');
    expect(commandMock).toHaveBeenCalledTimes(1);
    const createCommand = commandMock.mock.calls[0]?.[0].command;
    expect(createCommand?.type).toBe('chat.create_tab');
    if (createCommand?.type === 'chat.create_tab') {
      expect(createCommand.approvalMode).toBe('full-access');
    }
    expect(useChatStore.getState().chatStateSync[KEY]?.phase).toBe('live');
  });

  it('defers the starter chat of an empty scope hydrated for a prefetch until it is loaded', async () => {
    const { useChatStore } = loadChatStore();
    getStateMock.mockResolvedValue(snapshot(0, [], ''));
    getResolvedDefaultMock.mockResolvedValue('full-access');
    commandMock.mockImplementation((request) =>
      Promise.resolve(commandResult(request.commandId, 'applied')),
    );

    await useChatStore
      .getState()
      .hydrateChatScopeRevisioned('proj', 'wt', { speculative: true });
    await flushMicrotasks();
    await flushMicrotasks();

    // A hover never writes stored state.
    expect(commandMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().worktreeChats[KEY]?.tabs ?? []).toHaveLength(
      0,
    );

    // Opening the worktree creates it as usual.
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    expect(commandMock).toHaveBeenCalledTimes(1);
    expect(commandMock.mock.calls[0]?.[0].command.type).toBe('chat.create_tab');
    expect(useChatStore.getState().worktreeChats[KEY]?.tabs).toHaveLength(1);
  });

  it('drops its starter when another writer committed the scope’s first chat', async () => {
    const { useChatStore } = loadChatStore();
    getStateMock.mockResolvedValue(snapshot(0, [], ''));
    getResolvedDefaultMock.mockResolvedValue('auto');
    commandMock.mockImplementation((request) =>
      Promise.resolve({
        ...commandResult(request.commandId, 'already_applied'),
        entityId: 'automation-chat',
      }),
    );

    await useChatStore.getState().loadTabsForTarget('proj', 'wt');

    const createCommand = commandMock.mock.calls[0]?.[0].command;
    expect(createCommand).toMatchObject({
      type: 'chat.create_tab',
      starter: true,
    });
    const chatState = useChatStore.getState().worktreeChats[KEY];
    expect(chatState?.tabs).toEqual([]);
    expect(chatState?.activeTabId).toBe('automation-chat');
  });

  it('does not create a destination starter while branched tabs are being handed off', async () => {
    const { useChatStore } = loadChatStore();
    const pendingFork = deferred<{
      tabBindings: Record<string, { destinationTabId: string }>;
    }>();
    forkOpenWorktreeTabsMock.mockReturnValue(pendingFork.promise);
    commandMock.mockImplementation((request) =>
      Promise.resolve(commandResult(request.commandId, 'applied')),
    );

    const forking = useChatStore.getState().forkOpenTabsToWorktree({
      projectId: 'proj',
      sourceWorktreeId: 'source',
      destinationWorktreeId: 'destination',
    });
    await flushMicrotasks();

    getStateMock.mockResolvedValue({
      ...snapshot(0, [], ''),
      worktreeId: 'destination',
    });
    await useChatStore.getState().loadTabsForTarget('proj', 'destination');

    expect(
      useChatStore.getState().worktreeChats['proj/destination']?.tabs,
    ).toEqual([]);
    expect(commandMock).not.toHaveBeenCalled();

    pendingFork.resolve({
      tabBindings: { 'source-chat': { destinationTabId: 'forked-chat' } },
    });
    await forking;
  });

  it('does not expose a starter tab before its approval default resolves', async () => {
    const { useChatStore } = loadChatStore();
    const approvalDefault = deferred<'full-access'>();
    getStateMock.mockResolvedValue(snapshot(0, [], ''));
    getResolvedDefaultMock.mockReturnValueOnce(approvalDefault.promise);
    commandMock.mockImplementation((request) =>
      Promise.resolve(commandResult(request.commandId, 'applied')),
    );

    const hydration = useChatStore.getState().loadTabsForTarget('proj', 'wt');
    await flushMicrotasks();
    expect(useChatStore.getState().worktreeChats[KEY]?.tabs).toEqual([]);
    expect(commandMock).not.toHaveBeenCalled();

    approvalDefault.resolve('full-access');
    await hydration;
    await flushMicrotasks();
    await flushMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const starter = useChatStore.getState().worktreeChats[KEY]?.tabs[0];
    expect(starter?.approvalMode).toBe('full-access');
    expect(commandMock).toHaveBeenCalledTimes(1);
    expect(commandMock.mock.calls[0]?.[0].command).toMatchObject({
      type: 'chat.create_tab',
      tabId: starter?.id,
      approvalMode: 'full-access',
    });
  });
});

describe('committed delta application', () => {
  async function hydrate(
    useChatStore: (typeof ChatStoreModule)['useChatStore'],
  ): Promise<void> {
    getStateMock.mockResolvedValue(
      snapshot(5, [persistedTab('chat-1')], 'chat-1'),
    );
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
  }

  it('applies contiguous deltas and ignores duplicates and old revisions', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);

    const upsert = changeEvent(5, 6, [
      {
        type: 'message.upserted',
        chatId: 'chat-1',
        message: {
          id: 'chat-1-m2',
          role: 'assistant',
          blocks: [{ id: 'b2', type: 'text', text: 'reply' }],
          timestamp: 2,
        },
      },
    ]);
    useChatStore.getState().handleChatStateChanged(upsert);
    // Duplicate delivery and an older revision must not regress state.
    useChatStore.getState().handleChatStateChanged(upsert);
    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(4, 5, [
          { type: 'message.removed', chatId: 'chat-1', messageId: 'chat-1-m1' },
        ]),
      );

    const tab = useChatStore.getState().worktreeChats[KEY]?.tabs[0];
    expect(tab?.messages.map((m) => m.id)).toEqual(['chat-1-m1', 'chat-1-m2']);
    expect(useChatStore.getState().chatStateSync[KEY]).toEqual({
      phase: 'live',
      revision: 6,
    });
  });

  it('waits for terminal unread processing before auto-archiving canonical completion', async () => {
    const { useChatStore } = loadChatStore();
    const initial = snapshot(
      5,
      [persistedTab('chat-1', { autoArchive: true }), persistedTab('keeper')],
      'chat-1',
    );
    initial.runtimeByChatId = {
      'chat-1': {
        status: 'streaming',
        queuedMessageIds: [],
        lastActivityAt: 100,
      },
    };
    getStateMock.mockResolvedValueOnce(initial);
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');

    useChatStore.getState().handleChatStateChanged(
      changeEvent(5, 6, [
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: {
            status: 'completed',
            queuedMessageIds: [],
            lastActivityAt: 200,
          },
        },
      ]),
    );
    await flushMicrotasks();

    expect(archiveTabMock).not.toHaveBeenCalled();

    useChatStore.setState({
      selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
    });
    useChatStore.getState().handleChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      data: {
        type: 'claude_terminal_transcript_sync',
        messages: [],
        importedEventCount: 1,
      },
    });
    await flushMicrotasks();

    expect(archiveTabMock).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt',
      tabId: 'chat-1',
      unread: true,
      keepSession: true,
    });
    expect(
      useChatStore.getState().worktreeChats[KEY]?.tabs.map((tab) => tab.id),
    ).toEqual(['keeper']);
  });

  it('auto-archives after canonical completion follows terminal presentation', async () => {
    const { useChatStore } = loadChatStore();
    const initial = snapshot(
      5,
      [persistedTab('chat-1', { autoArchive: true }), persistedTab('keeper')],
      'chat-1',
    );
    initial.runtimeByChatId = {
      'chat-1': {
        status: 'streaming',
        queuedMessageIds: [],
        lastActivityAt: 100,
      },
    };
    getStateMock.mockResolvedValueOnce(initial);
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    useChatStore.setState({
      selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
    });

    useChatStore.getState().handleChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      data: { type: 'result', is_error: false, result: 'Finished' },
    });
    await flushMicrotasks();
    expect(archiveTabMock).not.toHaveBeenCalled();

    useChatStore.getState().handleChatStateChanged(
      changeEvent(5, 6, [
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: {
            status: 'completed',
            queuedMessageIds: [],
            lastActivityAt: 200,
          },
        },
      ]),
    );
    await flushMicrotasks();

    expect(archiveTabMock).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt',
      tabId: 'chat-1',
      unread: true,
      keepSession: true,
    });
  });

  it('defers canonical auto-archive while delegates are live, then archives when they finish', async () => {
    const { useChatStore } = loadChatStore();
    const delegations = jest.requireActual<
      typeof DelegationActivityStoreModule
    >('../delegationActivityStore');
    const revisioned = jest.requireActual<typeof RevisionedChatSyncModule>(
      '../chat/slices/revisioned',
    );
    const disposeReevaluation = revisioned.installAutoArchiveAfterDelegates();
    const setDelegates = (live: number): void => {
      delegations.useDelegationActivityStore.getState().applyActivity({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat-1',
        live,
        queued: 0,
      });
    };
    try {
      const initial = snapshot(
        5,
        [persistedTab('chat-1', { autoArchive: true }), persistedTab('keeper')],
        'chat-1',
      );
      initial.runtimeByChatId = {
        'chat-1': {
          status: 'streaming',
          queuedMessageIds: [],
          lastActivityAt: 100,
        },
      };
      getStateMock.mockResolvedValueOnce(initial);
      await useChatStore.getState().loadTabsForTarget('proj', 'wt');
      useChatStore.setState({
        selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
      });
      setDelegates(1);

      useChatStore.getState().handleChatEvent({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat-1',
        data: { type: 'result', is_error: false, result: 'Completed' },
      });
      useChatStore.getState().handleChatStateChanged(
        changeEvent(5, 6, [
          {
            type: 'runtime.patched',
            chatId: 'chat-1',
            runtime: {
              status: 'completed',
              queuedMessageIds: [],
              lastActivityAt: 200,
            },
          },
        ]),
      );
      await flushMicrotasks();

      // Skipped rather than attempted and refused; the flag stays.
      expect(archiveTabMock).not.toHaveBeenCalled();
      expect(
        useChatStore
          .getState()
          .worktreeChats[KEY]?.tabs.find((tab) => tab.id === 'chat-1')
          ?.autoArchive,
      ).toBe(true);

      setDelegates(0);
      await flushMicrotasks();

      expect(archiveTabMock).toHaveBeenCalledTimes(1);
      expect(archiveTabMock).toHaveBeenCalledWith({
        projectId: 'proj',
        worktreeId: 'wt',
        tabId: 'chat-1',
        unread: true,
        keepSession: true,
      });
      expect(
        useChatStore.getState().worktreeChats[KEY]?.tabs.map((tab) => tab.id),
      ).toEqual(['keeper']);
    } finally {
      disposeReevaluation();
    }
  });

  it('retries a deferred legacy auto-archive after a renderer reload', async () => {
    const { useChatStore: beforeReload } = loadChatStore();
    const legacyUnavailable = new Error(
      "Error invoking remote method 'chat:get-state': No handler registered for 'chat:get-state'",
    );
    getStateMock.mockRejectedValue(legacyUnavailable);
    loadTabsMock.mockResolvedValue(
      tabsFile(
        [persistedTab('chat-1', { autoArchive: true }), persistedTab('keeper')],
        'chat-1',
      ),
    );
    await beforeReload.getState().loadTabsForTarget('proj', 'wt');
    const priorRevisioned = jest.requireActual<typeof RevisionedChatSyncModule>(
      '../chat/slices/revisioned',
    );
    priorRevisioned.deferLegacyAutoArchiveUntilDelegatesFinish(
      'proj',
      'wt',
      'chat-1',
    );

    // Module reload discards the in-memory deferral. The persisted tab marker
    // remains, and the live delegate completes after the new store hydrates.
    const { useChatStore } = loadChatStore();
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    const delegations = jest.requireActual<
      typeof DelegationActivityStoreModule
    >('../delegationActivityStore');
    const revisioned = jest.requireActual<typeof RevisionedChatSyncModule>(
      '../chat/slices/revisioned',
    );
    const dispose = revisioned.installAutoArchiveAfterDelegates();
    try {
      delegations.useDelegationActivityStore.getState().hydrate([
        {
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: 'chat-1',
          live: 1,
          queued: 0,
        },
      ]);
      delegations.useDelegationActivityStore.getState().applyActivity({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat-1',
        live: 0,
        queued: 0,
      });
      await flushMicrotasks();
      expect(archiveTabMock).toHaveBeenCalledWith({
        projectId: 'proj',
        worktreeId: 'wt',
        tabId: 'chat-1',
        keepSession: true,
      });
    } finally {
      dispose();
    }
  });

  it('retries a deferred legacy auto-archive when the first activity snapshot is empty', async () => {
    const { useChatStore } = loadChatStore();
    getStateMock.mockRejectedValue(
      new Error("No handler registered for 'chat:get-state'"),
    );
    loadTabsMock.mockResolvedValue(
      tabsFile(
        [persistedTab('chat-1', { autoArchive: true }), persistedTab('keeper')],
        'chat-1',
      ),
    );
    const delegations = jest.requireActual<
      typeof DelegationActivityStoreModule
    >('../delegationActivityStore');
    const revisioned = jest.requireActual<typeof RevisionedChatSyncModule>(
      '../chat/slices/revisioned',
    );
    const dispose = revisioned.installAutoArchiveAfterDelegates();
    try {
      await useChatStore.getState().loadTabsForTarget('proj', 'wt');
      expect(archiveTabMock).not.toHaveBeenCalled();

      // The delegate finished before this renderer received any nonzero event.
      delegations.useDelegationActivityStore.getState().hydrate([]);
      await flushMicrotasks();

      expect(archiveTabMock).toHaveBeenCalledWith({
        projectId: 'proj',
        worktreeId: 'wt',
        tabId: 'chat-1',
        keepSession: true,
      });
    } finally {
      dispose();
    }
  });

  it('retries a deferred legacy auto-archive when tabs hydrate after empty activity', async () => {
    const { useChatStore } = loadChatStore();
    getStateMock.mockRejectedValue(
      new Error("No handler registered for 'chat:get-state'"),
    );
    loadTabsMock.mockResolvedValue(
      tabsFile(
        [persistedTab('chat-1', { autoArchive: true }), persistedTab('keeper')],
        'chat-1',
      ),
    );
    const delegations = jest.requireActual<
      typeof DelegationActivityStoreModule
    >('../delegationActivityStore');
    const revisioned = jest.requireActual<typeof RevisionedChatSyncModule>(
      '../chat/slices/revisioned',
    );
    const dispose = revisioned.installAutoArchiveAfterDelegates();
    try {
      delegations.useDelegationActivityStore.getState().hydrate([]);
      await useChatStore.getState().loadTabsForTarget('proj', 'wt');
      await flushMicrotasks();

      expect(archiveTabMock).toHaveBeenCalledWith({
        projectId: 'proj',
        worktreeId: 'wt',
        tabId: 'chat-1',
        keepSession: true,
      });
    } finally {
      dispose();
    }
  });

  it('waits for the parent turn when delegates finish before it completes', async () => {
    const { useChatStore } = loadChatStore();
    const delegations = jest.requireActual<
      typeof DelegationActivityStoreModule
    >('../delegationActivityStore');
    const revisioned = jest.requireActual<typeof RevisionedChatSyncModule>(
      '../chat/slices/revisioned',
    );
    const disposeReevaluation = revisioned.installAutoArchiveAfterDelegates();
    try {
      const initial = snapshot(
        5,
        [persistedTab('chat-1', { autoArchive: true }), persistedTab('keeper')],
        'chat-1',
      );
      initial.runtimeByChatId = {
        'chat-1': {
          status: 'streaming',
          queuedMessageIds: [],
          lastActivityAt: 100,
        },
      };
      getStateMock.mockResolvedValueOnce(initial);
      await useChatStore.getState().loadTabsForTarget('proj', 'wt');
      const store = delegations.useDelegationActivityStore.getState();
      store.applyActivity({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat-1',
        live: 1,
        queued: 0,
      });
      store.applyActivity({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat-1',
        live: 0,
        queued: 0,
      });
      await flushMicrotasks();

      // The parent is still streaming: nothing to archive yet.
      expect(archiveTabMock).not.toHaveBeenCalled();
    } finally {
      disposeReevaluation();
    }
  });

  it('retries auto-archive after delegated work blocks the first terminal archive', async () => {
    const { useChatStore } = loadChatStore();
    const initial = snapshot(
      5,
      [persistedTab('chat-1', { autoArchive: true }), persistedTab('keeper')],
      'chat-1',
    );
    initial.runtimeByChatId = {
      'chat-1': {
        status: 'streaming',
        queuedMessageIds: [],
        lastActivityAt: 100,
      },
    };
    getStateMock.mockResolvedValueOnce(initial);
    archiveTabMock
      .mockRejectedValueOnce(
        new Error('The chat still has active delegated work.'),
      )
      .mockResolvedValueOnce([]);
    const consoleError = jest.spyOn(console, 'error').mockImplementation();
    try {
      await useChatStore.getState().loadTabsForTarget('proj', 'wt');
      useChatStore.setState({
        selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
      });
      useChatStore.getState().handleChatEvent({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat-1',
        data: { type: 'result', is_error: false, result: 'Completed' },
      });
      useChatStore.getState().handleChatStateChanged(
        changeEvent(5, 6, [
          {
            type: 'runtime.patched',
            chatId: 'chat-1',
            runtime: {
              status: 'completed',
              queuedMessageIds: [],
              lastActivityAt: 200,
            },
          },
        ]),
      );
      await flushMicrotasks();
      expect(archiveTabMock).toHaveBeenCalledTimes(1);
      expect(
        useChatStore.getState().worktreeChats[KEY]?.tabs.map((tab) => tab.id),
      ).toEqual(['chat-1', 'keeper']);

      // The child settles later and publishes another canonical completed
      // runtime. The terminal presentation remains valid for a retry.
      useChatStore.getState().handleChatStateChanged(
        changeEvent(6, 7, [
          {
            type: 'runtime.patched',
            chatId: 'chat-1',
            runtime: {
              status: 'completed',
              queuedMessageIds: [],
              lastActivityAt: 300,
            },
          },
        ]),
      );
      await flushMicrotasks();
      expect(archiveTabMock).toHaveBeenCalledTimes(2);
      expect(
        useChatStore.getState().worktreeChats[KEY]?.tabs.map((tab) => tab.id),
      ).toEqual(['keeper']);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('retries a completed delta received while a refused auto-archive is still in flight', async () => {
    const { useChatStore } = loadChatStore();
    const initial = snapshot(
      5,
      [persistedTab('chat-1', { autoArchive: true }), persistedTab('keeper')],
      'chat-1',
    );
    initial.runtimeByChatId = {
      'chat-1': {
        status: 'streaming',
        queuedMessageIds: [],
        lastActivityAt: 100,
      },
    };
    getStateMock.mockResolvedValueOnce(initial);
    const firstArchive = deferred<unknown[]>();
    archiveTabMock
      .mockReturnValueOnce(firstArchive.promise)
      .mockRejectedValueOnce(
        new Error('The chat still has active delegated work.'),
      )
      .mockResolvedValueOnce([]);
    const consoleError = jest.spyOn(console, 'error').mockImplementation();
    try {
      await useChatStore.getState().loadTabsForTarget('proj', 'wt');
      useChatStore.setState({
        selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
      });
      useChatStore.getState().handleChatEvent({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat-1',
        data: { type: 'result', is_error: false, result: 'Completed' },
      });
      useChatStore.getState().handleChatStateChanged(
        changeEvent(5, 6, [
          {
            type: 'runtime.patched',
            chatId: 'chat-1',
            runtime: {
              status: 'completed',
              queuedMessageIds: [],
              lastActivityAt: 200,
            },
          },
        ]),
      );
      expect(archiveTabMock).toHaveBeenCalledTimes(1);

      // Delegation settlement is committed before main rejects the archive.
      useChatStore.getState().handleChatStateChanged(
        changeEvent(6, 7, [
          {
            type: 'runtime.patched',
            chatId: 'chat-1',
            runtime: {
              status: 'completed',
              queuedMessageIds: [],
              lastActivityAt: 300,
            },
          },
        ]),
      );
      expect(archiveTabMock).toHaveBeenCalledTimes(1);

      firstArchive.reject(
        new Error('The chat still has active delegated work.'),
      );
      await flushMicrotasks();
      expect(archiveTabMock).toHaveBeenCalledTimes(2);
      expect(
        useChatStore.getState().worktreeChats[KEY]?.tabs.map((tab) => tab.id),
      ).toEqual(['chat-1', 'keeper']);
      await flushMicrotasks();
      expect(archiveTabMock).toHaveBeenCalledTimes(2);

      // The second refusal does not spin. Only another committed completion
      // can request a third attempt once delegated work actually settles.
      useChatStore.getState().handleChatStateChanged(
        changeEvent(7, 8, [
          {
            type: 'runtime.patched',
            chatId: 'chat-1',
            runtime: {
              status: 'completed',
              queuedMessageIds: [],
              lastActivityAt: 400,
            },
          },
        ]),
      );
      await flushMicrotasks();
      expect(archiveTabMock).toHaveBeenCalledTimes(3);
      expect(
        useChatStore.getState().worktreeChats[KEY]?.tabs.map((tab) => tab.id),
      ).toEqual(['keeper']);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('retries a refused snapshot auto-archive on a later completed delta', async () => {
    const { useChatStore } = loadChatStore();
    const initial = snapshot(
      5,
      [persistedTab('chat-1', { autoArchive: true }), persistedTab('keeper')],
      'chat-1',
    );
    initial.runtimeByChatId = {
      'chat-1': {
        status: 'completed',
        queuedMessageIds: [],
        lastActivityAt: 100,
      },
    };
    getStateMock.mockResolvedValueOnce(initial);
    archiveTabMock
      .mockRejectedValueOnce(
        new Error('The chat still has active delegated work.'),
      )
      .mockResolvedValueOnce([]);
    const consoleError = jest.spyOn(console, 'error').mockImplementation();
    try {
      await useChatStore.getState().loadTabsForTarget('proj', 'wt');
      await flushMicrotasks();
      expect(archiveTabMock).toHaveBeenCalledTimes(1);
      expect(
        useChatStore.getState().worktreeChats[KEY]?.tabs.map((tab) => tab.id),
      ).toEqual(['chat-1', 'keeper']);

      useChatStore.getState().handleChatStateChanged(
        changeEvent(5, 6, [
          {
            type: 'runtime.patched',
            chatId: 'chat-1',
            runtime: {
              status: 'completed',
              queuedMessageIds: [],
              lastActivityAt: 200,
            },
          },
        ]),
      );
      await flushMicrotasks();
      expect(archiveTabMock).toHaveBeenCalledTimes(2);
      expect(
        useChatStore.getState().worktreeChats[KEY]?.tabs.map((tab) => tab.id),
      ).toEqual(['keeper']);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('uses the latest read state when a refused auto-archive is retried', async () => {
    const { useChatStore } = loadChatStore();
    const initial = snapshot(
      5,
      [
        persistedTab('chat-1', { autoArchive: true, unread: true }),
        persistedTab('keeper'),
      ],
      'chat-1',
    );
    initial.runtimeByChatId = {
      'chat-1': {
        status: 'completed',
        queuedMessageIds: [],
        lastActivityAt: 100,
      },
    };
    getStateMock.mockResolvedValueOnce(initial);
    archiveTabMock
      .mockRejectedValueOnce(
        new Error('The chat still has active delegated work.'),
      )
      .mockResolvedValueOnce([]);
    const consoleError = jest.spyOn(console, 'error').mockImplementation();
    try {
      await useChatStore.getState().loadTabsForTarget('proj', 'wt');
      await flushMicrotasks();
      expect(archiveTabMock).toHaveBeenCalledWith(
        expect.objectContaining({ tabId: 'chat-1', unread: true }),
      );

      useChatStore.getState().handleChatStateChanged(
        changeEvent(5, 6, [
          {
            type: 'tab.metadata_patched',
            tabId: 'chat-1',
            patch: { unread: false },
          },
        ]),
      );
      expect(
        useChatStore
          .getState()
          .worktreeChats[KEY]?.tabs.find((tab) => tab.id === 'chat-1')?.unread,
      ).toBe(false);
      useChatStore.getState().handleChatStateChanged(
        changeEvent(6, 7, [
          {
            type: 'runtime.patched',
            chatId: 'chat-1',
            runtime: {
              status: 'completed',
              queuedMessageIds: [],
              lastActivityAt: 200,
            },
          },
        ]),
      );
      await flushMicrotasks();
      expect(archiveTabMock).toHaveBeenCalledTimes(2);
      expect(archiveTabMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ tabId: 'chat-1' }),
      );
      expect(archiveTabMock).toHaveBeenNthCalledWith(
        2,
        expect.not.objectContaining({ unread: true }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('starts a fresh auto-archive after scope rehydration while an older attempt is in flight', async () => {
    const { useChatStore } = loadChatStore();
    const initial = snapshot(
      5,
      [persistedTab('chat-1', { autoArchive: true }), persistedTab('keeper')],
      'chat-1',
    );
    initial.runtimeByChatId = {
      'chat-1': {
        status: 'completed',
        queuedMessageIds: [],
        lastActivityAt: 100,
      },
    };
    getStateMock.mockResolvedValue(initial);
    const oldArchive = deferred<unknown[]>();
    const newArchive = deferred<unknown[]>();
    archiveTabMock
      .mockReturnValueOnce(oldArchive.promise)
      .mockReturnValueOnce(newArchive.promise);
    const consoleError = jest.spyOn(console, 'error').mockImplementation();
    try {
      await useChatStore.getState().loadTabsForTarget('proj', 'wt');
      expect(archiveTabMock).toHaveBeenCalledTimes(1);

      useChatStore.getState().releaseChatScopeRevisioned('proj', 'wt');
      await useChatStore.getState().hydrateChatScopeRevisioned('proj', 'wt');
      expect(archiveTabMock).toHaveBeenCalledTimes(2);

      oldArchive.reject(new Error('Old archive request refused'));
      await flushMicrotasks();
      useChatStore.getState().handleChatStateChanged(
        changeEvent(5, 6, [
          {
            type: 'runtime.patched',
            chatId: 'chat-1',
            runtime: {
              status: 'completed',
              queuedMessageIds: [],
              lastActivityAt: 200,
            },
          },
        ]),
      );
      await flushMicrotasks();
      expect(archiveTabMock).toHaveBeenCalledTimes(2);
      newArchive.resolve([]);
      await flushMicrotasks();
      expect(
        useChatStore.getState().worktreeChats[KEY]?.tabs.map((tab) => tab.id),
      ).toEqual(['keeper']);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('drops snapshot auto-archive unread state when a newer snapshot disables it', async () => {
    const { useChatStore } = loadChatStore();
    const initial = snapshot(
      5,
      [
        persistedTab('chat-1', { autoArchive: true, unread: true }),
        persistedTab('keeper'),
      ],
      'chat-1',
    );
    initial.runtimeByChatId = {
      'chat-1': {
        status: 'completed',
        queuedMessageIds: [],
        lastActivityAt: 100,
      },
    };
    getStateMock.mockResolvedValueOnce(initial);
    archiveTabMock
      .mockRejectedValueOnce(
        new Error('The chat still has active delegated work.'),
      )
      .mockResolvedValueOnce([]);
    const consoleError = jest.spyOn(console, 'error').mockImplementation();
    try {
      await useChatStore.getState().loadTabsForTarget('proj', 'wt');
      await flushMicrotasks();
      expect(archiveTabMock).toHaveBeenCalledWith({
        projectId: 'proj',
        worktreeId: 'wt',
        tabId: 'chat-1',
        unread: true,
        keepSession: true,
      });

      const newer = snapshot(
        9,
        [
          persistedTab('chat-1', { autoArchive: false, unread: false }),
          persistedTab('keeper'),
        ],
        'chat-1',
      );
      newer.runtimeByChatId = {
        'chat-1': {
          status: 'completed',
          queuedMessageIds: [],
          lastActivityAt: 200,
        },
      };
      getStateMock.mockResolvedValueOnce(newer);
      useChatStore.getState().handleChatStateChanged(
        changeEvent(8, 9, [
          {
            type: 'runtime.patched',
            chatId: 'chat-1',
            runtime: {
              status: 'completed',
              queuedMessageIds: [],
              lastActivityAt: 200,
            },
          },
        ]),
      );
      await flushMicrotasks();
      expect(
        useChatStore.getState().worktreeChats[KEY]?.tabs[0]?.autoArchive ??
          false,
      ).toBe(false);

      expect(archiveTabMock).toHaveBeenCalledTimes(1);

      const reenabled = snapshot(
        13,
        [
          persistedTab('chat-1', { autoArchive: true, unread: false }),
          persistedTab('keeper'),
        ],
        'chat-1',
      );
      reenabled.runtimeByChatId = {
        'chat-1': {
          status: 'completed',
          queuedMessageIds: [],
          lastActivityAt: 300,
        },
      };
      getStateMock.mockResolvedValueOnce(reenabled);
      useChatStore.getState().handleChatStateChanged(
        changeEvent(12, 13, [
          {
            type: 'runtime.patched',
            chatId: 'chat-1',
            runtime: {
              status: 'completed',
              queuedMessageIds: [],
              lastActivityAt: 300,
            },
          },
        ]),
      );
      await flushMicrotasks();
      expect(archiveTabMock).toHaveBeenCalledTimes(2);
      expect(archiveTabMock).toHaveBeenLastCalledWith({
        projectId: 'proj',
        worktreeId: 'wt',
        tabId: 'chat-1',
        keepSession: true,
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it('drops auto-archive unread state across canonical off and on metadata patches', async () => {
    const { useChatStore } = loadChatStore();
    const { recordCanonicalTerminalPresentation } = jest.requireActual<
      typeof RevisionedChatSyncModule
    >('../chat/slices/revisioned');
    const initial = snapshot(
      5,
      [
        persistedTab('chat-1', { autoArchive: true, unread: true }),
        persistedTab('keeper'),
      ],
      'chat-1',
    );
    initial.runtimeByChatId = {
      'chat-1': {
        status: 'completed',
        queuedMessageIds: [],
        lastActivityAt: 100,
      },
    };
    getStateMock.mockResolvedValueOnce(initial);
    archiveTabMock
      .mockRejectedValueOnce(
        new Error('The chat still has active delegated work.'),
      )
      .mockResolvedValueOnce([]);
    const consoleError = jest.spyOn(console, 'error').mockImplementation();
    try {
      await useChatStore.getState().loadTabsForTarget('proj', 'wt');
      await flushMicrotasks();
      expect(archiveTabMock).toHaveBeenCalledTimes(1);

      useChatStore.getState().handleChatStateChanged(
        changeEvent(5, 6, [
          {
            type: 'tab.metadata_patched',
            tabId: 'chat-1',
            patch: { autoArchive: false, unread: false },
          },
        ]),
      );
      useChatStore.getState().handleChatStateChanged(
        changeEvent(6, 7, [
          {
            type: 'tab.metadata_patched',
            tabId: 'chat-1',
            patch: { autoArchive: true },
          },
        ]),
      );
      await flushMicrotasks();
      expect(archiveTabMock).toHaveBeenCalledTimes(1);

      useChatStore.getState().handleChatStateChanged(
        changeEvent(7, 8, [
          {
            type: 'runtime.patched',
            chatId: 'chat-1',
            runtime: {
              status: 'streaming',
              queuedMessageIds: [],
              lastActivityAt: 200,
            },
          },
        ]),
      );
      recordCanonicalTerminalPresentation('proj', 'wt', 'chat-1', false);
      useChatStore.getState().handleChatStateChanged(
        changeEvent(8, 9, [
          {
            type: 'runtime.patched',
            chatId: 'chat-1',
            runtime: {
              status: 'completed',
              queuedMessageIds: [],
              lastActivityAt: 300,
            },
          },
        ]),
      );
      await flushMicrotasks();
      expect(archiveTabMock).toHaveBeenCalledTimes(2);
      expect(archiveTabMock).toHaveBeenLastCalledWith({
        projectId: 'proj',
        worktreeId: 'wt',
        tabId: 'chat-1',
        keepSession: true,
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it('ignores Codex subagent completion as a root terminal presentation', async () => {
    const { useChatStore } = loadChatStore();
    const initial = snapshot(
      5,
      [
        persistedTab('chat-1', {
          autoArchive: true,
          providerType: 'codex',
          sdkSessionId: 'root-thread',
        }),
        persistedTab('keeper'),
      ],
      'keeper',
    );
    initial.runtimeByChatId = {
      'chat-1': {
        status: 'streaming',
        queuedMessageIds: [],
        lastActivityAt: 100,
      },
    };
    getStateMock.mockResolvedValueOnce(initial);
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    useChatStore.setState({
      selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
    });

    useChatStore.getState().handleChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      data: {
        type: 'codex',
        event: { type: 'turn.completed', thread_id: 'subagent-thread' },
      },
    });
    useChatStore.getState().handleChatStateChanged(
      changeEvent(5, 6, [
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: {
            status: 'completed',
            queuedMessageIds: [],
            lastActivityAt: 200,
          },
        },
      ]),
    );
    await flushMicrotasks();

    expect(archiveTabMock).not.toHaveBeenCalled();
  });

  it('preserves auto-archive through successful Codex completion', async () => {
    const { useChatStore } = loadChatStore();
    const { useNavigationStore } =
      jest.requireActual<typeof NavigationStoreModule>('../navigationStore');
    const initial = snapshot(
      5,
      [
        persistedTab('chat-1', {
          autoArchive: true,
          autoArchiveToggleVisible: true,
          providerType: 'codex',
          sdkSessionId: 'root-thread',
        }),
        persistedTab('keeper'),
      ],
      'chat-1',
    );
    initial.runtimeByChatId = {
      'chat-1': {
        status: 'streaming',
        queuedMessageIds: [],
        lastActivityAt: 100,
      },
    };
    getStateMock.mockResolvedValueOnce(initial);
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    useNavigationStore.setState({ activePage: 'main' });
    useChatStore.setState((state) => ({
      selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
      worktreeChats: {
        ...state.worktreeChats,
        [KEY]: {
          ...state.worktreeChats[KEY],
          tabs:
            state.worktreeChats[KEY]?.tabs.map((tab) =>
              tab.id === 'chat-1'
                ? { ...tab, autoArchiveToggleVisible: true }
                : tab,
            ) ?? [],
        },
      },
    }));

    useChatStore.getState().handleChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      data: {
        type: 'codex',
        event: {
          type: 'turn.completed',
          thread_id: 'root-thread',
          status: 'completed',
        },
      },
    });

    expect(
      useChatStore
        .getState()
        .worktreeChats[KEY]?.tabs.find((tab) => tab.id === 'chat-1')
        ?.autoArchive,
    ).toBe(true);
    expect(archiveTabMock).not.toHaveBeenCalled();

    useChatStore.getState().handleChatStateChanged(
      changeEvent(5, 6, [
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: {
            status: 'completed',
            queuedMessageIds: [],
            lastActivityAt: 200,
          },
        },
      ]),
    );
    await flushMicrotasks();

    expect(archiveTabMock).toHaveBeenCalledTimes(1);

    useChatStore.getState().handleChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      data: { type: 'result', is_error: false, result: 'Turn completed' },
    });
    await flushMicrotasks();

    expect(archiveTabMock).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt',
      tabId: 'chat-1',
      keepSession: true,
    });
    expect(archiveTabMock).toHaveBeenCalledTimes(1);
  });

  it('does not present or auto-archive an interrupted Codex turn before its cancellation result', async () => {
    const { useChatStore } = loadChatStore();
    const initial = snapshot(
      5,
      [
        persistedTab('chat-1', {
          autoArchive: true,
          autoArchiveToggleVisible: true,
          providerType: 'codex',
          sdkSessionId: 'root-thread',
        }),
        persistedTab('keeper'),
      ],
      'keeper',
    );
    initial.runtimeByChatId = {
      'chat-1': {
        status: 'streaming',
        queuedMessageIds: [],
        lastActivityAt: 100,
      },
    };
    getStateMock.mockResolvedValueOnce(initial);
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    useChatStore.setState({
      selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
    });

    useChatStore.getState().handleChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      data: {
        type: 'codex',
        event: {
          type: 'turn.completed',
          thread_id: 'root-thread',
          status: 'interrupted',
        },
      },
    });
    useChatStore.getState().handleChatStateChanged(
      changeEvent(5, 6, [
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: {
            status: 'completed',
            queuedMessageIds: [],
            lastActivityAt: 200,
          },
        },
      ]),
    );
    await flushMicrotasks();

    expect(archiveTabMock).not.toHaveBeenCalled();
    expect(
      useChatStore
        .getState()
        .worktreeChats[KEY]?.tabs.find((tab) => tab.id === 'chat-1')?.unread,
    ).not.toBe(true);

    useChatStore.getState().handleChatStateChanged(
      changeEvent(6, 7, [
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: {
            status: 'cancelled',
            queuedMessageIds: [],
            lastActivityAt: 201,
          },
        },
      ]),
    );
    useChatStore.getState().handleChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      data: { type: 'result', is_error: false, result: 'Turn cancelled' },
    });
    await flushMicrotasks();

    expect(archiveTabMock).not.toHaveBeenCalled();
  });

  it('reconciles terminal presentation while canonical hydration is in progress', async () => {
    const { useChatStore } = loadChatStore();
    const initial = snapshot(
      5,
      [persistedTab('chat-1'), persistedTab('keeper')],
      'chat-1',
    );
    initial.runtimeByChatId = {
      'chat-1': {
        status: 'completed',
        queuedMessageIds: [],
        lastActivityAt: 100,
      },
    };
    getStateMock.mockResolvedValueOnce(initial);
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    useChatStore.setState((state) => ({
      selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
      chatStateSync: {
        ...state.chatStateSync,
        [KEY]: { phase: 'hydrating' },
      },
      worktreeChats: {
        ...state.worktreeChats,
        [KEY]: {
          ...state.worktreeChats[KEY],
          activeTabId: 'keeper',
          tabs:
            state.worktreeChats[KEY]?.tabs.map((tab) =>
              tab.id === 'chat-1'
                ? { ...tab, autoArchive: true, status: 'streaming' }
                : tab,
            ) ?? [],
        },
      },
    }));

    useChatStore.getState().handleChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      data: { type: 'result', is_error: false, result: 'Finished' },
    });
    await flushMicrotasks();

    expect(archiveTabMock).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt',
      tabId: 'chat-1',
      unread: true,
      keepSession: true,
    });
  });

  it('auto-archives when the marker arrives after canonical completion', async () => {
    const { useChatStore } = loadChatStore();
    const completedTab = persistedTab('chat-1');
    const initial = snapshot(
      5,
      [completedTab, persistedTab('keeper')],
      'chat-1',
    );
    initial.runtimeByChatId = {
      'chat-1': {
        status: 'completed',
        queuedMessageIds: [],
        lastActivityAt: 100,
      },
    };
    getStateMock.mockResolvedValueOnce(initial);
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    archiveTabMock.mockClear();
    useChatStore.setState({
      selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
    });
    useChatStore.getState().handleChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      data: { type: 'result', is_error: false, result: 'Finished' },
    });
    await flushMicrotasks();
    expect(archiveTabMock).not.toHaveBeenCalled();

    useChatStore.getState().handleChatStateChanged(
      changeEvent(5, 6, [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat-1',
          patch: { autoArchive: true },
        },
      ]),
    );
    await flushMicrotasks();

    expect(archiveTabMock).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt',
      tabId: 'chat-1',
      unread: true,
      keepSession: true,
    });
  });

  it('persists disabling auto-archive before a completed snapshot is reinstalled', async () => {
    const { useChatStore } = loadChatStore();
    const initial = snapshot(
      5,
      [persistedTab('chat-1', { autoArchive: true }), persistedTab('keeper')],
      'chat-1',
    );
    initial.runtimeByChatId = {
      'chat-1': {
        status: 'streaming',
        queuedMessageIds: [],
        lastActivityAt: 100,
      },
    };
    getStateMock.mockResolvedValueOnce(initial);
    commandMock.mockImplementation((envelope) =>
      Promise.resolve(commandResult(envelope.commandId, 'applied')),
    );
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');

    useChatStore
      .getState()
      .setAutoArchiveForActiveTurn(
        { projectId: 'proj', worktreeId: 'wt', chatId: 'chat-1' },
        false,
      );
    await flushMicrotasks();

    expect(commandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj',
        worktreeId: 'wt',
        command: {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { autoArchive: null },
        },
      }),
    );

    const refreshed = snapshot(
      8,
      [persistedTab('chat-1'), persistedTab('keeper')],
      'chat-1',
    );
    refreshed.runtimeByChatId = {
      'chat-1': {
        status: 'completed',
        queuedMessageIds: [],
        lastActivityAt: 200,
      },
    };
    getStateMock.mockResolvedValueOnce(refreshed);
    useChatStore.getState().handleChatStateChanged(changeEvent(6, 7, []));
    await flushMicrotasks();
    await flushMicrotasks();

    expect(archiveTabMock).not.toHaveBeenCalled();
  });

  it('does not reuse terminal unread state after a new turn starts', async () => {
    const { useChatStore } = loadChatStore();
    const completedTab = persistedTab('chat-1');
    const initial = snapshot(5, [completedTab], 'chat-1');
    initial.runtimeByChatId = {
      'chat-1': {
        status: 'completed',
        queuedMessageIds: [],
        lastActivityAt: 100,
      },
    };
    getStateMock.mockResolvedValueOnce(initial);
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    useChatStore.getState().handleChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      data: { type: 'result', is_error: false, result: 'Old turn finished' },
    });

    useChatStore.getState().handleChatStateChanged(
      changeEvent(5, 6, [
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: {
            status: 'streaming',
            queuedMessageIds: [],
            lastActivityAt: 200,
          },
        },
      ]),
    );
    useChatStore.getState().handleChatStateChanged(
      changeEvent(6, 7, [
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: {
            status: 'completed',
            queuedMessageIds: [],
            lastActivityAt: 300,
          },
        },
      ]),
    );
    useChatStore.getState().handleChatStateChanged(
      changeEvent(7, 8, [
        {
          type: 'tab.upserted',
          tab: { ...completedTab, autoArchive: true },
        },
      ]),
    );
    await flushMicrotasks();

    expect(archiveTabMock).not.toHaveBeenCalled();
  });

  it('suppresses legacy provider-event reduction for a revisioned scope', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);
    const before = useChatStore.getState().worktreeChats[KEY];

    useChatStore.getState().handleChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      data: {
        type: 'assistant',
        message: {
          id: 'legacy-assistant',
          role: 'assistant',
          content: [{ type: 'text', text: 'must not double-apply' }],
        },
      },
    });

    expect(useChatStore.getState().worktreeChats[KEY]).toBe(before);
  });

  it.each([true, false])(
    'records the account proxy route (%s) from a routing report and keeps it through canonical updates and a refresh',
    async (accountProxyRouted) => {
      const { useChatStore } = loadChatStore();
      await hydrate(useChatStore);
      const routedTab = (): boolean | undefined =>
        useChatStore
          .getState()
          .worktreeChats[KEY]?.tabs.find((tab) => tab.id === 'chat-1')
          ?.accountProxyRouted;
      expect(routedTab()).toBeUndefined();

      useChatStore.getState().handleChatEvent({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat-1',
        data: {
          type: 'canopy_ai_credits_routing',
          provider: 'claude',
          active: false,
          ...(accountProxyRouted ? { accountProxyRouted: true } : {}),
        },
      });
      expect(routedTab()).toBe(accountProxyRouted);

      useChatStore.getState().handleChatStateChanged(
        changeEvent(5, 6, [
          {
            type: 'tab.upserted',
            tab: persistedTab('chat-1', { title: 'Renamed' }),
          },
        ]),
      );
      expect(routedTab()).toBe(accountProxyRouted);

      // A revision gap reinstalls the scope from a fresh canonical snapshot.
      getStateMock.mockResolvedValue(
        snapshot(9, [persistedTab('chat-1')], 'chat-1'),
      );
      useChatStore
        .getState()
        .handleChatStateChanged(
          changeEvent(8, 9, [{ type: 'tab.removed', tabId: 'chat-1' }]),
        );
      await flushMicrotasks();
      expect(useChatStore.getState().chatStateSync[KEY]).toEqual({
        phase: 'live',
        revision: 9,
      });
      expect(routedTab()).toBe(accountProxyRouted);
      expect(saveTabsMock).not.toHaveBeenCalled();
    },
  );

  it('does not regress fresh renderer activity on a revisioned compatibility event', async () => {
    const { useChatStore } = loadChatStore();
    const initial = snapshot(5, [persistedTab('chat-1')], 'chat-1');
    initial.runtimeByChatId = {
      'chat-1': {
        status: 'streaming',
        queuedMessageIds: [],
        lastActivityAt: 100,
      },
    };
    getStateMock.mockResolvedValueOnce(initial);
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    useChatStore.setState({
      selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
    });
    useChatStore.setState((state) => {
      const current = state.worktreeChats[KEY];
      if (!current) return state;
      return {
        worktreeChats: {
          ...state.worktreeChats,
          [KEY]: {
            ...current,
            tabs: current.tabs.map((tab) =>
              tab.id === 'chat-1' ? { ...tab, lastEventAt: 200 } : tab,
            ),
          },
        },
      };
    });

    useChatStore.getState().handleChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      data: {
        type: 'result',
        is_error: false,
        result: 'continuing',
        canopy_session_continues: true,
      },
    });

    expect(
      useChatStore.getState().worktreeChats[KEY]?.tabs[0]?.lastEventAt,
    ).toBe(200);
  });

  it('does not double-reduce a committed Codex failure compatibility event and refreshes activity ordering', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);

    useChatStore.getState().handleChatStateChanged(
      changeEvent(5, 6, [
        {
          type: 'message.upserted',
          chatId: 'chat-1',
          message: {
            id: 'chat-1-provider-error',
            role: 'assistant',
            blocks: [
              {
                id: 'chat-1-provider-error-block',
                type: 'error',
                content: 'The provider failed',
              },
            ],
            timestamp: 2,
          },
        },
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: {
            status: 'failed',
            queuedMessageIds: [],
            lastActivityAt: 200,
            error: {
              code: 'provider_error',
              message: 'The provider failed',
              retryable: true,
              occurredAt: new Date().toISOString(),
            },
          },
        },
      ]),
    );

    useChatStore.getState().handleChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      data: {
        type: 'codex',
        event: {
          type: 'turn.failed',
          error: { message: 'The provider failed' },
        },
      },
    });

    const tab = useChatStore.getState().worktreeChats[KEY]?.tabs[0];
    expect(tab?.messages.map((message) => message.id)).toEqual([
      'chat-1-m1',
      'chat-1-provider-error',
    ]);
    expect(tab?.status).toBe('error');
    expect(tab?.lastEventAt).toBe(200);
  });

  it('restores terminal activity ordering from a revision-gap snapshot', async () => {
    const { useChatStore } = loadChatStore();
    const initial = snapshot(5, [persistedTab('chat-1')], 'chat-1');
    initial.runtimeByChatId = {
      'chat-1': {
        status: 'streaming',
        queuedMessageIds: [],
        lastActivityAt: 100,
      },
    };
    getStateMock.mockResolvedValueOnce(initial);
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    useChatStore.setState((state) => {
      const current = state.worktreeChats[KEY];
      if (!current) return state;
      return {
        worktreeChats: {
          ...state.worktreeChats,
          [KEY]: {
            ...current,
            tabs: current.tabs.map((tab) =>
              tab.id === 'chat-1' ? { ...tab, lastEventAt: 100 } : tab,
            ),
          },
        },
      };
    });

    const refreshed = deferred<ChatStateSnapshot>();
    getStateMock.mockReturnValueOnce(refreshed.promise);
    useChatStore.getState().handleChatStateChanged(
      changeEvent(8, 9, [
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: {
            status: 'failed',
            queuedMessageIds: [],
            lastActivityAt: 200,
            error: {
              code: 'provider_error',
              message: 'The provider failed',
              retryable: true,
              occurredAt: new Date().toISOString(),
            },
          },
        },
      ]),
    );
    expect(useChatStore.getState().chatStateSync[KEY]?.phase).toBe(
      'refreshing',
    );

    useChatStore.getState().handleChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      data: {
        type: 'codex',
        event: {
          type: 'turn.failed',
          error: { message: 'The provider failed' },
        },
      },
    });
    expect(
      useChatStore.getState().worktreeChats[KEY]?.tabs[0]?.lastEventAt,
    ).toBe(100);

    const recovered = snapshot(9, [persistedTab('chat-1')], 'chat-1');
    recovered.runtimeByChatId = {
      'chat-1': {
        status: 'failed',
        queuedMessageIds: [],
        lastActivityAt: 200,
        error: {
          code: 'provider_error',
          message: 'The provider failed',
          retryable: true,
          occurredAt: new Date().toISOString(),
        },
      },
    };
    refreshed.resolve(recovered);
    await flushMicrotasks();

    const tab = useChatStore.getState().worktreeChats[KEY]?.tabs[0];
    expect(tab?.status).toBe('error');
    expect(tab?.lastEventAt).toBe(200);
  });

  it('commits a background turn unread transition through the canonical command port', async () => {
    const { useChatStore } = loadChatStore();
    getStateMock.mockResolvedValue(
      snapshot(5, [persistedTab('chat-1'), persistedTab('chat-2')], 'chat-2'),
    );
    commandMock.mockImplementation((envelope) =>
      Promise.resolve(commandResult(envelope.commandId, 'applied')),
    );
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    useChatStore.setState({
      selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
    });

    useChatStore.getState().handleChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      data: { type: 'result', is_error: false, result: 'Finished' },
    });
    await flushMicrotasks();

    expect(useChatStore.getState().worktreeChats[KEY]?.tabs[0]?.unread).toBe(
      true,
    );
    expect(
      commandMock.mock.calls.map(([envelope]) => envelope.command),
    ).toContainEqual({ type: 'chat.mark_unread', chatId: 'chat-1' });
  });

  it('defers a background unread command until revision recovery is live', async () => {
    const { useChatStore } = loadChatStore();
    getStateMock.mockResolvedValueOnce(
      snapshot(5, [persistedTab('chat-1'), persistedTab('chat-2')], 'chat-2'),
    );
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    useChatStore.setState({
      selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
    });

    const refreshed = deferred<ChatStateSnapshot>();
    getStateMock.mockReturnValueOnce(refreshed.promise);
    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(8, 9, [
          { type: 'message.removed', chatId: 'chat-1', messageId: 'missing' },
        ]),
      );
    expect(useChatStore.getState().chatStateSync[KEY]?.phase).toBe(
      'refreshing',
    );

    commandMock.mockImplementation((envelope) => {
      if (envelope.command.type === 'chat.mark_unread') {
        useChatStore.getState().handleChatStateChanged(
          changeEvent(9, 10, [
            {
              type: 'tab.upserted',
              tab: persistedTab('chat-1', { unread: true }),
            },
          ]),
        );
      }
      return Promise.resolve(commandResult(envelope.commandId, 'applied'));
    });
    useChatStore.getState().handleChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      data: { type: 'result', is_error: false, result: 'Finished' },
    });
    await flushMicrotasks();
    expect(commandMock).not.toHaveBeenCalled();

    refreshed.resolve(
      snapshot(9, [persistedTab('chat-1'), persistedTab('chat-2')], 'chat-2'),
    );
    await flushMicrotasks();
    await flushMicrotasks();

    expect(
      commandMock.mock.calls.map(([envelope]) => envelope.command),
    ).toContainEqual({ type: 'chat.mark_unread', chatId: 'chat-1' });
    expect(useChatStore.getState().worktreeChats[KEY]?.tabs[0]?.unread).toBe(
      true,
    );
  });

  it('commits tab activation, read state, and attention dismissal through the canonical command port', async () => {
    const { useChatStore } = loadChatStore();
    getStateMock.mockResolvedValue(
      snapshot(5, [persistedTab('chat-1', { unread: true })], 'chat-1'),
    );
    commandMock.mockImplementation(
      (envelope): Promise<ChatCommandResult> =>
        Promise.resolve(commandResult(envelope.commandId, 'applied')),
    );
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');

    useChatStore
      .getState()
      .switchTab('chat-1', { projectId: 'proj', worktreeId: 'wt' });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(
      commandMock.mock.calls.map(([envelope]) => envelope.command),
    ).toEqual([
      { type: 'chat.activate_tab', tabId: 'chat-1' },
      { type: 'chat.mark_read', chatId: 'chat-1' },
      { type: 'chat.dismiss_attention', chatId: 'chat-1' },
    ]);
  });

  it('keeps the latest optimistic tab selection while an older activation delta is delayed', async () => {
    const { useChatStore } = loadChatStore();
    const activation = deferred<ChatCommandResult>();
    getStateMock.mockResolvedValue(
      snapshot(5, [persistedTab('chat-1'), persistedTab('chat-2')], 'chat-1'),
    );
    commandMock.mockImplementation((envelope) =>
      envelope.command.type === 'chat.activate_tab'
        ? activation.promise
        : Promise.resolve(commandResult(envelope.commandId, 'applied')),
    );
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');

    useChatStore
      .getState()
      .switchTab('chat-2', { projectId: 'proj', worktreeId: 'wt' });
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'chat-2',
    );

    // Main was already committing the previous selection when the click
    // occurred. Its contiguous event is canonical but older than the user's
    // in-flight activation, so it must not repaint the visible selection.
    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(5, 6, [
          { type: 'tab.active_changed', activeTabId: 'chat-1' },
        ]),
      );
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'chat-2',
    );

    const activationEnvelope = commandMock.mock.calls.find(
      ([envelope]) => envelope.command.type === 'chat.activate_tab',
    )?.[0];
    if (!activationEnvelope) throw new Error('Expected activation command');
    activation.resolve({
      commandId: activationEnvelope.commandId,
      revision: 7,
      outcome: 'applied',
    });
    await flushMicrotasks();
    // A command result can beat its broadcast; keep the overlay through that
    // interval as well.
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'chat-2',
    );

    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(6, 7, [
          { type: 'tab.active_changed', activeTabId: 'chat-2' },
        ]),
      );
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'chat-2',
    );
  });

  it('keeps a newly created tab selected while an older activation commits', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);
    const creation = deferred<ChatCommandResult>();
    commandMock.mockImplementation((envelope) =>
      envelope.command.type === 'chat.create_tab'
        ? creation.promise
        : Promise.resolve(commandResult(envelope.commandId, 'applied')),
    );
    useChatStore
      .getState()
      .createTab({ projectId: 'proj', worktreeId: 'wt', id: 'new-draft' });
    await flushMicrotasks();
    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(5, 6, [
          { type: 'tab.active_changed', activeTabId: 'chat-1' },
        ]),
      );
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'new-draft',
    );
    const envelope = commandMock.mock.calls.find(
      ([call]) => call.command.type === 'chat.create_tab',
    )?.[0];
    if (!envelope) throw new Error('Expected creation command');
    creation.resolve({
      commandId: envelope.commandId,
      revision: 7,
      outcome: 'applied',
    });
    await flushMicrotasks();
    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(6, 7, [
          { type: 'tab.active_changed', activeTabId: 'new-draft' },
        ]),
      );
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'new-draft',
    );
  });

  it.each(['rejected', 'transport_failed'] as const)(
    'releases a new-tab selection when creation is %s',
    async (failure) => {
      const { useChatStore } = loadChatStore();
      await hydrate(useChatStore);
      const creation = deferred<ChatCommandResult>();
      commandMock.mockImplementation((envelope) =>
        envelope.command.type === 'chat.create_tab'
          ? creation.promise
          : Promise.resolve(commandResult(envelope.commandId, 'applied')),
      );
      useChatStore
        .getState()
        .createTab({ projectId: 'proj', worktreeId: 'wt', id: 'new-draft' });
      await flushMicrotasks();
      const envelope = commandMock.mock.calls.find(
        ([call]) => call.command.type === 'chat.create_tab',
      )?.[0];
      if (!envelope) throw new Error('Expected creation command');
      if (failure === 'rejected') {
        creation.resolve({
          commandId: envelope.commandId,
          revision: 5,
          outcome: 'rejected',
        });
      } else {
        creation.reject(new Error('Creation transport failed'));
      }
      await flushMicrotasks();
      expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
        'chat-1',
      );
    },
  );

  it.each(['openFileTab', 'createEmptyFileTab'] as const)(
    'keeps a %s tab selected while an older tab activation commits',
    async (open) => {
      const { useChatStore } = loadChatStore();
      const target = { projectId: 'proj', worktreeId: 'wt' };
      const activation = deferred<ChatCommandResult>();
      const creation = deferred<ChatCommandResult>();
      getStateMock.mockResolvedValue(
        snapshot(5, [persistedTab('chat-1'), persistedTab('chat-2')], 'chat-1'),
      );
      commandMock.mockImplementation((envelope) =>
        envelope.command.type === 'chat.activate_tab'
          ? activation.promise
          : envelope.command.type === 'chat.create_file_tab'
            ? creation.promise
            : Promise.resolve(commandResult(envelope.commandId, 'applied')),
      );
      await useChatStore.getState().loadTabsForTarget('proj', 'wt');

      // A tab click still crossing to main, then a file tab opened (e.g. from
      // that tab's embedded tree) before the click's activation commits.
      useChatStore.getState().switchTab('chat-2', target);
      const fileTabId =
        open === 'openFileTab'
          ? useChatStore
              .getState()
              .openFileTab(
                { absolutePath: '/repo/q3.xlsx', filename: 'q3.xlsx' },
                target,
              )
          : useChatStore.getState().createEmptyFileTab(target);
      if (fileTabId === null) throw new Error('Expected a file tab');
      await flushMicrotasks();
      const envelopeFor = (type: ChatCommand['type']): ChatCommandEnvelope => {
        const envelope = commandMock.mock.calls.find(
          ([call]) => call.command.type === type,
        )?.[0];
        if (!envelope) throw new Error(`Expected ${type}`);
        return envelope;
      };

      activation.resolve({
        commandId: envelopeFor('chat.activate_tab').commandId,
        revision: 6,
        outcome: 'applied',
      });
      await flushMicrotasks();
      useChatStore
        .getState()
        .handleChatStateChanged(
          changeEvent(5, 6, [
            { type: 'tab.active_changed', activeTabId: 'chat-2' },
          ]),
        );
      expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
        fileTabId,
      );

      creation.resolve({
        commandId: envelopeFor('chat.create_file_tab').commandId,
        revision: 7,
        outcome: 'applied',
      });
      await flushMicrotasks();
      useChatStore
        .getState()
        .handleChatStateChanged(
          changeEvent(6, 7, [
            { type: 'tab.active_changed', activeTabId: fileTabId },
          ]),
        );
      expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
        fileTabId,
      );
    },
  );

  it('waits for an empty file tab to be created before assigning its path', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);
    const creation = deferred<ChatCommandResult>();
    commandMock.mockImplementation((envelope) =>
      envelope.command.type === 'chat.create_file_tab'
        ? creation.promise
        : Promise.resolve(commandResult(envelope.commandId, 'applied')),
    );
    const target = { projectId: 'proj', worktreeId: 'wt' };
    const tabId = useChatStore.getState().createEmptyFileTab(target);
    if (tabId === null) throw new Error('Expected an empty file tab');
    useChatStore
      .getState()
      .assignFileTab(
        tabId,
        { absolutePath: '/repo/assigned.md', filename: 'assigned.md' },
        target,
      );
    await flushMicrotasks();
    expect(commandMock.mock.calls.map(([call]) => call.command.type)).toEqual([
      'chat.create_file_tab',
    ]);

    const envelope = commandMock.mock.calls[0]?.[0];
    if (!envelope) throw new Error('Expected creation command');
    creation.resolve(commandResult(envelope.commandId, 'applied'));
    await flushMicrotasks();
    expect(commandMock.mock.calls.map(([call]) => call.command.type)).toEqual([
      'chat.create_file_tab',
      'chat.patch_tab_settings',
    ]);
  });

  it.each(['rejected', 'transport_failed'] as const)(
    'releases a new file-tab selection when creation is %s',
    async (failure) => {
      const { useChatStore } = loadChatStore();
      await hydrate(useChatStore);
      const creation = deferred<ChatCommandResult>();
      commandMock.mockImplementation((envelope) =>
        envelope.command.type === 'chat.create_file_tab'
          ? creation.promise
          : Promise.resolve(commandResult(envelope.commandId, 'applied')),
      );
      const fileTabId = useChatStore
        .getState()
        .openFileTab(
          { absolutePath: '/repo/q3.xlsx', filename: 'q3.xlsx' },
          { projectId: 'proj', worktreeId: 'wt' },
        );
      await flushMicrotasks();
      expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
        fileTabId,
      );
      const envelope = commandMock.mock.calls.find(
        ([call]) => call.command.type === 'chat.create_file_tab',
      )?.[0];
      if (!envelope) throw new Error('Expected creation command');
      if (failure === 'rejected') {
        creation.resolve({
          commandId: envelope.commandId,
          revision: 5,
          outcome: 'rejected',
        });
      } else {
        creation.reject(new Error('Creation transport failed'));
      }
      await flushMicrotasks();
      expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
        'chat-1',
      );
    },
  );

  it('creates a background file with a non-activating canonical command (CAN-4663)', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);
    const creation = deferred<ChatCommandResult>();
    commandMock.mockImplementation(() => creation.promise);
    const fileTabId = useChatStore
      .getState()
      .openFileTab(
        { absolutePath: '/repo/notes.md', filename: 'notes.md' },
        { projectId: 'proj', worktreeId: 'wt' },
        { activate: false },
      );
    await flushMicrotasks();
    const envelope = commandMock.mock.calls[0]?.[0];
    expect(envelope?.command).toMatchObject({
      type: 'chat.create_file_tab',
      tabId: fileTabId,
      activate: false,
    });
    if (!envelope) throw new Error('Expected a creation command');
    creation.resolve({
      commandId: envelope.commandId,
      revision: 6,
      outcome: 'applied',
    });
    await flushMicrotasks();
    expect(commandMock).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'chat-1',
    );
  });

  it('never overwrites a user selection made while a background file tab is created', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore, [
      persistedTab('chat-1'),
      persistedTab('chat-2'),
    ]);
    const creation = deferred<ChatCommandResult>();
    commandMock.mockImplementation((envelope) =>
      envelope.command.type === 'chat.create_file_tab'
        ? creation.promise
        : Promise.resolve(commandResult(envelope.commandId, 'applied')),
    );
    const target = { projectId: 'proj', worktreeId: 'wt' };
    useChatStore
      .getState()
      .openFileTab(
        { absolutePath: '/repo/notes.md', filename: 'notes.md' },
        target,
        { activate: false },
      );
    useChatStore.getState().switchTab('chat-2', target);
    await flushMicrotasks();
    const creationEnvelope = commandMock.mock.calls.find(
      ([call]) => call.command.type === 'chat.create_file_tab',
    )?.[0];
    if (!creationEnvelope) throw new Error('Expected creation command');

    creation.resolve({
      commandId: creationEnvelope.commandId,
      revision: 6,
      outcome: 'applied',
    });
    await flushMicrotasks();

    const activations = commandMock.mock.calls
      .map(([call]) => call.command)
      .filter((command) => command.type === 'chat.activate_tab');
    expect(activations).toEqual([
      { type: 'chat.activate_tab', tabId: 'chat-2' },
    ]);
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'chat-2',
    );
  });

  it('keeps the newest file tab selected while an earlier file-tab creation commits', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);
    const creations = new Map<
      string,
      ReturnType<typeof deferred<ChatCommandResult>>
    >();
    commandMock.mockImplementation((envelope) => {
      if (envelope.command.type !== 'chat.create_file_tab') {
        return Promise.resolve(commandResult(envelope.commandId, 'applied'));
      }
      const creation = deferred<ChatCommandResult>();
      creations.set(envelope.command.tabId, creation);
      return creation.promise;
    });
    const target = { projectId: 'proj', worktreeId: 'wt' };
    const firstTabId = useChatStore
      .getState()
      .openFileTab(
        { absolutePath: '/repo/legacy.doc', filename: 'legacy.doc' },
        target,
      );
    // The next file is opened from the first file tab's embedded tree before
    // the first creation (which also activates its tab in main) commits.
    const secondTabId = useChatStore
      .getState()
      .openFileTab(
        { absolutePath: '/repo/legacy.xls', filename: 'legacy.xls' },
        target,
      );
    if (firstTabId === null || secondTabId === null) {
      throw new Error('Expected file tabs');
    }
    await flushMicrotasks();
    const commandIdFor = (tabId: string): string => {
      const envelope = commandMock.mock.calls.find(
        ([call]) =>
          call.command.type === 'chat.create_file_tab' &&
          call.command.tabId === tabId,
      )?.[0];
      if (!envelope) throw new Error(`Expected creation of ${tabId}`);
      return envelope.commandId;
    };

    creations.get(firstTabId)?.resolve({
      commandId: commandIdFor(firstTabId),
      revision: 6,
      outcome: 'applied',
    });
    await flushMicrotasks();
    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(5, 6, [
          { type: 'tab.active_changed', activeTabId: firstTabId },
        ]),
      );
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      secondTabId,
    );

    creations.get(secondTabId)?.resolve({
      commandId: commandIdFor(secondTabId),
      revision: 7,
      outcome: 'applied',
    });
    await flushMicrotasks();
    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(6, 7, [
          { type: 'tab.active_changed', activeTabId: secondTabId },
        ]),
      );
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      secondTabId,
    );
  });

  it('does not let a late activation result supersede a newer tab click', async () => {
    const { useChatStore } = loadChatStore();
    const firstActivation = deferred<ChatCommandResult>();
    const secondActivation = deferred<ChatCommandResult>();
    getStateMock.mockResolvedValue(
      snapshot(
        5,
        [
          persistedTab('chat-1'),
          persistedTab('chat-2'),
          persistedTab('chat-3'),
        ],
        'chat-1',
      ),
    );
    commandMock.mockImplementation((envelope) => {
      if (envelope.command.type !== 'chat.activate_tab') {
        return Promise.resolve(commandResult(envelope.commandId, 'applied'));
      }
      return envelope.command.tabId === 'chat-2'
        ? firstActivation.promise
        : secondActivation.promise;
    });
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');

    useChatStore
      .getState()
      .switchTab('chat-2', { projectId: 'proj', worktreeId: 'wt' });
    useChatStore
      .getState()
      .switchTab('chat-3', { projectId: 'proj', worktreeId: 'wt' });

    const activationEnvelopes = commandMock.mock.calls
      .map(([envelope]) => envelope)
      .filter((envelope) => envelope.command.type === 'chat.activate_tab');
    expect(activationEnvelopes).toHaveLength(2);
    firstActivation.resolve({
      commandId: activationEnvelopes[0].commandId,
      revision: 6,
      outcome: 'applied',
    });
    await flushMicrotasks();
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'chat-3',
    );

    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(5, 6, [
          { type: 'tab.active_changed', activeTabId: 'chat-2' },
        ]),
      );
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'chat-3',
    );

    secondActivation.resolve({
      commandId: activationEnvelopes[1].commandId,
      revision: 7,
      outcome: 'applied',
    });
    await flushMicrotasks();
    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(6, 7, [
          { type: 'tab.active_changed', activeTabId: 'chat-3' },
        ]),
      );
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'chat-3',
    );
  });

  it('rolls a rejected later activation back to a newer accepted canonical tab', async () => {
    const { useChatStore } = loadChatStore();
    const firstActivation = deferred<ChatCommandResult>();
    const secondActivation = deferred<ChatCommandResult>();
    getStateMock.mockResolvedValue(
      snapshot(
        5,
        [
          persistedTab('chat-1'),
          persistedTab('chat-2'),
          persistedTab('chat-3'),
        ],
        'chat-1',
      ),
    );
    commandMock.mockImplementation((envelope) => {
      if (envelope.command.type !== 'chat.activate_tab') {
        return Promise.resolve(commandResult(envelope.commandId, 'applied'));
      }
      return envelope.command.tabId === 'chat-2'
        ? firstActivation.promise
        : secondActivation.promise;
    });
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');

    useChatStore
      .getState()
      .switchTab('chat-2', { projectId: 'proj', worktreeId: 'wt' });
    useChatStore
      .getState()
      .switchTab('chat-3', { projectId: 'proj', worktreeId: 'wt' });
    const activationEnvelopes = commandMock.mock.calls
      .map(([envelope]) => envelope)
      .filter((envelope) => envelope.command.type === 'chat.activate_tab');

    firstActivation.resolve({
      commandId: activationEnvelopes[0].commandId,
      revision: 6,
      outcome: 'applied',
    });
    await flushMicrotasks();
    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(5, 6, [
          { type: 'tab.active_changed', activeTabId: 'chat-2' },
        ]),
      );
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'chat-3',
    );

    secondActivation.resolve({
      commandId: activationEnvelopes[1].commandId,
      revision: 6,
      outcome: 'rejected',
    });
    await flushMicrotasks();

    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'chat-2',
    );
  });

  it('rolls consecutive failed activations back to the confirmed canonical tab', async () => {
    const { useChatStore } = loadChatStore();
    const firstActivation = deferred<ChatCommandResult>();
    const secondActivation = deferred<ChatCommandResult>();
    getStateMock.mockResolvedValue(
      snapshot(
        5,
        [
          persistedTab('chat-1'),
          persistedTab('chat-2'),
          persistedTab('chat-3'),
        ],
        'chat-1',
      ),
    );
    commandMock.mockImplementation((envelope) => {
      if (envelope.command.type !== 'chat.activate_tab') {
        return Promise.resolve(commandResult(envelope.commandId, 'applied'));
      }
      return envelope.command.tabId === 'chat-2'
        ? firstActivation.promise
        : secondActivation.promise;
    });
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');

    useChatStore
      .getState()
      .switchTab('chat-2', { projectId: 'proj', worktreeId: 'wt' });
    useChatStore
      .getState()
      .switchTab('chat-3', { projectId: 'proj', worktreeId: 'wt' });
    const activationEnvelopes = commandMock.mock.calls
      .map(([envelope]) => envelope)
      .filter((envelope) => envelope.command.type === 'chat.activate_tab');

    firstActivation.resolve({
      commandId: activationEnvelopes[0].commandId,
      revision: 5,
      outcome: 'rejected',
    });
    await flushMicrotasks();
    secondActivation.resolve({
      commandId: activationEnvelopes[1].commandId,
      revision: 5,
      outcome: 'rejected',
    });
    await flushMicrotasks();

    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'chat-1',
    );
  });

  it('commits a visible target acknowledgement through the canonical command port', async () => {
    const { useChatStore } = loadChatStore();
    getStateMock.mockResolvedValue(
      snapshot(5, [persistedTab('chat-1', { unread: true })], 'chat-1'),
    );
    commandMock.mockImplementation(
      (envelope): Promise<ChatCommandResult> =>
        Promise.resolve(commandResult(envelope.commandId, 'applied')),
    );
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');

    useChatStore.getState().markTargetRead('proj', 'wt', {
      tabId: 'chat-1',
    });
    await flushMicrotasks();

    expect(
      commandMock.mock.calls.map(([envelope]) => envelope.command),
    ).toEqual([
      { type: 'chat.mark_read', chatId: 'chat-1' },
      { type: 'chat.dismiss_attention', chatId: 'chat-1' },
    ]);
  });

  it('commits a visible worktree selection acknowledgement through the canonical command port', async () => {
    const { useChatStore } = loadChatStore();
    const { useNavigationStore } =
      jest.requireActual<typeof NavigationStoreModule>('../navigationStore');
    getStateMock.mockResolvedValue(
      snapshot(5, [persistedTab('chat-1', { unread: true })], 'chat-1'),
    );
    commandMock.mockImplementation(
      (envelope): Promise<ChatCommandResult> =>
        Promise.resolve(commandResult(envelope.commandId, 'applied')),
    );
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    useNavigationStore.setState({ activePage: 'main' });

    useChatStore.getState().selectWorktree('proj', 'wt');
    await flushMicrotasks();

    expect(
      commandMock.mock.calls.map(([envelope]) => envelope.command),
    ).toEqual([
      { type: 'chat.mark_read', chatId: 'chat-1' },
      { type: 'chat.dismiss_attention', chatId: 'chat-1' },
      {
        type: 'chat.create_tab',
        tabId: 'chat-1',
        title: 'Tab chat-1',
        modelConfig: {
          fastMode: false,
          speed: 'standard',
          thinkingLevel: 'high',
        },
        proposalMode: 'optional',
      },
    ]);
  });

  it('on a revision gap keeps the last good transcript, disables send, queries one snapshot, and recovers', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);

    const refreshed = deferred<ChatStateSnapshot>();
    getStateMock.mockClear();
    getStateMock.mockReturnValue(refreshed.promise);

    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(8, 9, [
          { type: 'message.removed', chatId: 'chat-1', messageId: 'chat-1-m1' },
        ]),
      );

    expect(useChatStore.getState().chatStateSync[KEY]?.phase).toBe(
      'refreshing',
    );
    // Last good transcript retained.
    expect(
      useChatStore.getState().worktreeChats[KEY]?.tabs[0]?.messages,
    ).toHaveLength(1);
    // Send is disabled while refreshing: the command path refuses to submit.
    const blocked = await useChatStore
      .getState()
      .dispatchChatCommand(
        { projectId: 'proj', worktreeId: 'wt' },
        { type: 'chat.mark_read', chatId: 'chat-1' },
      );
    expect(blocked).toBe('transport_failed');
    expect(commandMock).not.toHaveBeenCalled();
    expect(getStateMock).toHaveBeenCalledTimes(1); // exactly one refresh query

    refreshed.resolve(snapshot(9, [persistedTab('chat-1')], 'chat-1'));
    await flushMicrotasks();
    expect(useChatStore.getState().chatStateSync[KEY]).toEqual({
      phase: 'live',
      revision: 9,
    });
  });

  it('keeps the last transcript on refresh failure and recovers via Retry', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);

    getStateMock.mockRejectedValueOnce(new Error('refresh failed'));
    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(8, 9, [{ type: 'tab.removed', tabId: 'chat-1' }]),
      );
    await flushMicrotasks();

    expect(useChatStore.getState().chatStateSync[KEY]?.phase).toBe(
      'refresh_error',
    );
    expect(
      useChatStore.getState().worktreeChats[KEY]?.tabs.map((tab) => tab.id),
    ).toEqual(['chat-1']);

    getStateMock.mockResolvedValueOnce(
      snapshot(10, [persistedTab('chat-2')], 'chat-2'),
    );
    useChatStore.getState().retryChatStateRefresh('proj', 'wt');
    await flushMicrotasks();
    expect(useChatStore.getState().chatStateSync[KEY]).toEqual({
      phase: 'live',
      revision: 10,
    });
    expect(
      useChatStore.getState().worktreeChats[KEY]?.tabs.map((tab) => tab.id),
    ).toEqual(['chat-2']);
  });

  it('materializes a canonical starter tab when Retry recovers an empty scope', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);

    getStateMock.mockRejectedValueOnce(new Error('refresh failed'));
    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(8, 9, [{ type: 'tab.removed', tabId: 'chat-1' }]),
      );
    await flushMicrotasks();

    getStateMock.mockResolvedValueOnce(snapshot(10, [], ''));
    commandMock.mockImplementation((request) =>
      Promise.resolve(commandResult(request.commandId, 'applied')),
    );
    useChatStore.getState().retryChatStateRefresh('proj', 'wt');
    await flushMicrotasks();

    const recovered = useChatStore.getState().worktreeChats[KEY];
    expect(useChatStore.getState().chatStateSync[KEY]).toEqual({
      phase: 'live',
      revision: 10,
    });
    expect(recovered?.tabs).toHaveLength(1);
    expect(commandMock.mock.calls[0]?.[0].command).toMatchObject({
      type: 'chat.create_tab',
      tabId: recovered?.tabs[0]?.id,
    });
  });
});

describe('structural tab lifecycle commands', () => {
  async function hydrate(
    useChatStore: (typeof ChatStoreModule)['useChatStore'],
    tabs: PersistedChatTab[] = [persistedTab('chat-1')],
  ): Promise<void> {
    getStateMock.mockResolvedValue(snapshot(5, tabs, tabs[0]?.id ?? ''));
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
  }

  /**
   * Mimic main's canonical view: structural commands succeed only for tabs
   * main knows about, exactly like the real service's `not_found` handling.
   */
  function installCanonicalAwareCommandMock(initialTabIds: string[]): {
    knownTabIds: Set<string>;
  } {
    const knownTabIds = new Set(initialTabIds);
    commandMock.mockImplementation((envelope): Promise<ChatCommandResult> => {
      const command = envelope.command;
      if (
        command.type === 'chat.create_tab' ||
        command.type === 'chat.create_file_tab'
      ) {
        knownTabIds.add(command.tabId);
        return Promise.resolve(commandResult(envelope.commandId, 'applied'));
      }
      if (command.type === 'chat.activate_tab') {
        return Promise.resolve(
          commandResult(
            envelope.commandId,
            knownTabIds.has(command.tabId) ? 'applied' : 'not_found',
          ),
        );
      }
      return Promise.resolve(commandResult(envelope.commandId, 'applied'));
    });
    return { knownTabIds };
  }

  it('commits chat.create_tab for a newly created draft tab', async () => {
    const { useChatStore } = loadChatStore();
    installCanonicalAwareCommandMock(['chat-1']);
    await hydrate(useChatStore);

    useChatStore.getState().createTab({ projectId: 'proj', worktreeId: 'wt' });
    await flushMicrotasks();

    const draft = useChatStore
      .getState()
      .worktreeChats[KEY]?.tabs.find((tab) => tab.id !== 'chat-1');
    expect(draft).toBeDefined();
    const createCommands = commandMock.mock.calls
      .map(([envelope]) => envelope.command)
      .filter((command) => command.type === 'chat.create_tab');
    expect(createCommands).toEqual([
      expect.objectContaining({ type: 'chat.create_tab', tabId: draft?.id }),
    ]);
  });

  it('queues draft actions behind canonical creation and creates from the latest tab state', async () => {
    const { useChatStore } = loadChatStore();
    installCanonicalAwareCommandMock(['chat-1']);
    await hydrate(useChatStore);
    commandMock.mockClear();
    const approvalDefault = deferred<'full-access'>();
    getResolvedDefaultMock.mockReturnValueOnce(approvalDefault.promise);

    useChatStore.getState().createTab({
      projectId: 'proj',
      worktreeId: 'wt',
      id: 'draft',
    });
    useChatStore.setState((state) => {
      const worktree = state.worktreeChats[KEY];
      if (!worktree) return state;
      return {
        worktreeChats: {
          ...state.worktreeChats,
          [KEY]: {
            ...worktree,
            tabs: worktree.tabs.map((tab) =>
              tab.id === 'draft'
                ? { ...tab, title: 'Latest title', selectedRepoId: 'repo-2' }
                : tab,
            ),
          },
        },
      };
    });
    useChatStore.getState().closeTab('draft', {
      projectId: 'proj',
      worktreeId: 'wt',
    });
    await flushMicrotasks();

    expect(commandMock).not.toHaveBeenCalled();

    approvalDefault.resolve('full-access');
    await flushMicrotasks();
    await flushMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      commandMock.mock.calls.map(([envelope]) => envelope.command),
    ).toEqual([
      expect.objectContaining({
        type: 'chat.create_tab',
        tabId: 'draft',
        title: 'Latest title',
        selectedRepoId: 'repo-2',
        approvalMode: 'full-access',
      }),
      expect.objectContaining({
        type: 'chat.close_tab',
        tabId: 'draft',
      }),
    ]);
  });

  it.each([true, false])(
    'waits for a draft tab creation and keeps its model target after navigation (explicit target: %s)',
    async (explicitTarget) => {
      const { useChatStore } = loadChatStore();
      const { initCodexModels } = jest.requireActual<{
        initCodexModels: typeof InitCodexModels;
      }>('@canopy/desktop-shared/types');
      initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
      installCanonicalAwareCommandMock(['chat-1']);
      commandMock.mockImplementation((envelope) =>
        Promise.resolve(
          commandResult(
            envelope.commandId,
            envelope.command.type === 'chat.patch_tab_settings'
              ? 'not_found'
              : 'applied',
          ),
        ),
      );
      await hydrate(useChatStore);
      commandMock.mockClear();
      const approvalDefault = deferred<'ask'>();
      getResolvedDefaultMock.mockReturnValueOnce(approvalDefault.promise);
      useChatStore.setState({
        selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
      });

      useChatStore.getState().createTab({
        projectId: 'proj',
        worktreeId: 'wt',
        id: 'draft',
      });
      const modelChange = useChatStore.getState().setModelAndWait(
        'gpt-5.5',
        explicitTarget
          ? {
              projectId: 'proj',
              worktreeId: 'wt',
              chatId: 'draft',
            }
          : undefined,
      );
      await flushMicrotasks();

      useChatStore.setState((state) => ({
        worktreeChats: {
          ...state.worktreeChats,
          [KEY]: { ...state.worktreeChats[KEY], activeTabId: 'chat-1' },
        },
      }));

      // A fresh worktree/chat can expose its composer while approval-default
      // resolution still holds up canonical tab creation. The model channel
      // must not target that renderer-only id and provoke a not_found refresh.
      expect(changeModelMock).not.toHaveBeenCalled();

      approvalDefault.resolve('ask');
      await expect(modelChange).resolves.toBe(true);
      expect(commandMock.mock.calls[0]?.[0].command).toMatchObject({
        type: 'chat.create_tab',
        tabId: 'draft',
      });
      expect(changeModelMock).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: 'draft',
          model: 'gpt-5.5',
        }),
      );
      expect(useChatStore.getState().chatStateNotices[KEY]).toBeUndefined();
      expect(useChatStore.getState().worktreeChats[KEY].activeTabId).toBe(
        'chat-1',
      );
      expect(useChatStore.getState().pendingModelChanges).toEqual({});
    },
  );

  it('waits for a replaced starter tab close before creating at the returned revision', async () => {
    const { useChatStore } = loadChatStore();
    const closeResult = deferred<ChatCommandResult>();
    commandMock.mockImplementation((commandEnvelope) => {
      if (commandEnvelope.command.type === 'chat.close_tab') {
        return closeResult.promise;
      }
      return Promise.resolve({
        commandId: commandEnvelope.commandId,
        revision: 7,
        outcome: 'applied',
      });
    });
    await hydrate(useChatStore, [persistedTab('starter', { messages: [] })]);

    useChatStore.getState().createTab({
      projectId: 'proj',
      worktreeId: 'wt',
      id: 'replacement',
      replaceActiveEmpty: true,
    });
    await flushMicrotasks();

    expect(commandMock).toHaveBeenCalledTimes(1);
    expect(commandMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        expectedRevision: 5,
        command: {
          type: 'chat.close_tab',
          tabId: 'starter',
          mode: 'discard_empty',
        },
      }),
    );

    closeResult.resolve({
      commandId: commandMock.mock.calls[0]?.[0].commandId ?? 'close',
      revision: 6,
      outcome: 'applied',
    });
    await flushMicrotasks();

    expect(commandMock).toHaveBeenCalledTimes(2);
    const createEnvelope = commandMock.mock.calls[1]?.[0];
    expect(createEnvelope?.expectedRevision).toBe(6);
    expect(createEnvelope?.command).toMatchObject({
      type: 'chat.create_tab',
      tabId: 'replacement',
    });
  });

  it('creates a replacement when the deferred starter was never canonical', async () => {
    const { useChatStore } = loadChatStore();
    installCanonicalAwareCommandMock([]);
    const starterDefault = deferred<'ask'>();
    getResolvedDefaultMock
      .mockReturnValueOnce(starterDefault.promise)
      .mockResolvedValueOnce('full-access');

    const hydration = hydrate(useChatStore, []);
    await flushMicrotasks();
    const starterId = useChatStore.getState().worktreeChats[KEY]?.activeTabId;
    expect(starterId).toBeDefined();

    useChatStore.getState().createTab({
      projectId: 'proj',
      worktreeId: 'wt',
      id: 'replacement',
      replaceActiveEmpty: true,
    });
    await flushMicrotasks();
    starterDefault.resolve('ask');
    await hydration;
    await flushMicrotasks();
    await flushMicrotasks();

    expect(
      commandMock.mock.calls.map(([envelope]) => envelope.command),
    ).toEqual([
      expect.objectContaining({
        type: 'chat.create_tab',
        tabId: 'replacement',
        approvalMode: 'full-access',
      }),
    ]);
  });

  it('closes a starter at the revision returned by its pending creation', async () => {
    const { useChatStore } = loadChatStore();
    const starterCreateResult = deferred<ChatCommandResult>();
    commandMock.mockImplementation((envelope) => {
      if (commandMock.mock.calls.length === 1) {
        return starterCreateResult.promise;
      }
      return Promise.resolve({
        commandId: envelope.commandId,
        revision: envelope.command.type === 'chat.close_tab' ? 7 : 8,
        outcome: 'applied',
      });
    });

    const hydration = hydrate(useChatStore, []);
    await flushMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushMicrotasks();
    expect(commandMock).toHaveBeenCalledTimes(1);
    const starterEnvelope = commandMock.mock.calls[0]?.[0];
    const starterTabId =
      starterEnvelope?.command.type === 'chat.create_tab'
        ? starterEnvelope.command.tabId
        : undefined;
    expect(starterTabId).toBeDefined();

    useChatStore.getState().createTab({
      projectId: 'proj',
      worktreeId: 'wt',
      id: 'replacement',
      replaceActiveEmpty: true,
    });
    await flushMicrotasks();
    expect(commandMock).toHaveBeenCalledTimes(1);

    starterCreateResult.resolve({
      commandId: starterEnvelope?.commandId ?? 'starter-create',
      revision: 6,
      outcome: 'applied',
    });
    await hydration;
    await flushMicrotasks();
    await flushMicrotasks();

    const closeEnvelope = commandMock.mock.calls[1]?.[0];
    expect(closeEnvelope?.expectedRevision).toBe(6);
    expect(closeEnvelope?.command).toMatchObject({
      type: 'chat.close_tab',
      tabId: starterTabId,
    });
    const replacementEnvelope = commandMock.mock.calls[2]?.[0];
    expect(replacementEnvelope?.expectedRevision).toBe(7);
    expect(replacementEnvelope?.command).toMatchObject({
      type: 'chat.create_tab',
      tabId: 'replacement',
    });
  });

  it('creates a replacement when the discarded starter is already absent', async () => {
    const { useChatStore } = loadChatStore();
    commandMock.mockImplementation((envelope) =>
      Promise.resolve({
        commandId: envelope.commandId,
        revision: envelope.command.type === 'chat.close_tab' ? 6 : 7,
        outcome:
          envelope.command.type === 'chat.close_tab' ? 'not_found' : 'applied',
      }),
    );
    await hydrate(useChatStore, [persistedTab('starter', { messages: [] })]);

    useChatStore.getState().createTab({
      projectId: 'proj',
      worktreeId: 'wt',
      id: 'replacement',
      replaceActiveEmpty: true,
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(
      commandMock.mock.calls.map(([envelope]) => envelope.command),
    ).toEqual([
      expect.objectContaining({ type: 'chat.close_tab', tabId: 'starter' }),
      expect.objectContaining({
        type: 'chat.create_tab',
        tabId: 'replacement',
      }),
    ]);
    expect(useChatStore.getState().chatStateNotices[KEY]).toBeUndefined();
  });

  it('consumes approval-default failures while a scope is not revisioned live', async () => {
    const { useChatStore } = loadChatStore();
    useChatStore.setState({
      fetchApprovalDefault: jest
        .fn()
        .mockRejectedValue(new Error('approval defaults unavailable')),
    });

    useChatStore.getState().createTab({
      projectId: 'proj',
      worktreeId: 'hydrating',
      id: 'local-draft',
    });
    await flushMicrotasks();

    expect(
      useChatStore.getState().worktreeChats['proj/hydrating']?.activeTabId,
    ).toBe('local-draft');
  });

  it('a fresh draft tab survives switching away and back without a conflict refresh', async () => {
    // Regression: create a tab, click into another tab, return to the new
    // (unused) tab. Pre-fix the draft never reached canonical state, so the
    // return-activation hit `not_found`, showed "This chat changed
    // elsewhere. Your view has been refreshed.", and the refresh erased the
    // draft.
    const { useChatStore } = loadChatStore();
    installCanonicalAwareCommandMock(['chat-1']);
    await hydrate(useChatStore);

    useChatStore.getState().createTab({ projectId: 'proj', worktreeId: 'wt' });
    await flushMicrotasks();
    const draftId = useChatStore
      .getState()
      .worktreeChats[KEY]?.tabs.find((tab) => tab.id !== 'chat-1')?.id;
    expect(draftId).toBeDefined();
    if (!draftId) return;

    useChatStore
      .getState()
      .switchTab('chat-1', { projectId: 'proj', worktreeId: 'wt' });
    await flushMicrotasks();
    useChatStore
      .getState()
      .switchTab(draftId, { projectId: 'proj', worktreeId: 'wt' });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(useChatStore.getState().chatStateNotices[KEY]).toBeUndefined();
    const tabs = useChatStore.getState().worktreeChats[KEY]?.tabs ?? [];
    expect(tabs.map((tab) => tab.id)).toContain(draftId);
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      draftId,
    );
  });

  it('commits chat.create_file_tab for a newly opened file tab', async () => {
    const { useChatStore } = loadChatStore();
    installCanonicalAwareCommandMock(['chat-1']);
    await hydrate(useChatStore);

    const fileTabId = useChatStore
      .getState()
      .openFileTab(
        { absolutePath: '/repo/src/index.ts', filename: 'index.ts' },
        { projectId: 'proj', worktreeId: 'wt' },
      );
    await flushMicrotasks();

    expect(fileTabId).not.toBeNull();
    const fileCommands = commandMock.mock.calls
      .map(([envelope]) => envelope.command)
      .filter((command) => command.type === 'chat.create_file_tab');
    expect(fileCommands).toEqual([
      expect.objectContaining({
        type: 'chat.create_file_tab',
        tabId: fileTabId,
        filePath: '/repo/src/index.ts',
      }),
    ]);
    expect(fileCommands[0]).not.toHaveProperty('viewMode');
  });

  it('commits the seeded view mode with chat.create_file_tab', async () => {
    const { useChatStore } = loadChatStore();
    installCanonicalAwareCommandMock(['chat-1']);
    await hydrate(useChatStore);

    const fileTabId = useChatStore.getState().openFileTab(
      {
        absolutePath: '/repo/docs/report.md',
        filename: 'report.md',
        initialViewMode: 'preview',
      },
      { projectId: 'proj', worktreeId: 'wt' },
    );
    await flushMicrotasks();

    const fileCommands = commandMock.mock.calls
      .map(([envelope]) => envelope.command)
      .filter((command) => command.type === 'chat.create_file_tab');
    expect(fileCommands).toEqual([
      expect.objectContaining({
        type: 'chat.create_file_tab',
        tabId: fileTabId,
        filePath: '/repo/docs/report.md',
        viewMode: 'preview',
      }),
    ]);
  });

  it('commits chat.reorder_tabs with the full resulting order', async () => {
    const { useChatStore } = loadChatStore();
    installCanonicalAwareCommandMock(['chat-1', 'chat-2']);
    await hydrate(useChatStore, [
      persistedTab('chat-1'),
      persistedTab('chat-2'),
    ]);

    useChatStore
      .getState()
      .reorderTabs('chat-2', 'chat-1', { projectId: 'proj', worktreeId: 'wt' });
    await flushMicrotasks();

    const reorderCommands = commandMock.mock.calls
      .map(([envelope]) => envelope.command)
      .filter((command) => command.type === 'chat.reorder_tabs');
    expect(reorderCommands).toEqual([
      expect.objectContaining({
        type: 'chat.reorder_tabs',
        tabIds: ['chat-2', 'chat-1'],
      }),
    ]);
  });

  it('sequences pin settings and reorder commands across canonical revisions', async () => {
    const { useChatStore } = loadChatStore();
    let canonicalRevision = 5;
    let canonicalOrder = ['chat-1', 'chat-2'];
    let pinnedChatIds = new Set<string>();
    commandMock.mockImplementation((commandEnvelope) => {
      const expectedRevision = commandEnvelope.expectedRevision;
      if (expectedRevision !== canonicalRevision) {
        return Promise.resolve({
          commandId: commandEnvelope.commandId,
          revision: canonicalRevision,
          outcome: 'conflict',
        });
      }
      const command = commandEnvelope.command;
      if (command.type === 'chat.patch_tab_settings') {
        pinnedChatIds = new Set(pinnedChatIds);
        if (command.patch.pinned === true) pinnedChatIds.add(command.tabId);
        else pinnedChatIds.delete(command.tabId);
      } else if (command.type === 'chat.reorder_tabs') {
        canonicalOrder = [...command.tabIds];
      }
      canonicalRevision += 1;
      return Promise.resolve({
        commandId: commandEnvelope.commandId,
        revision: canonicalRevision,
        outcome: 'applied',
      });
    });
    await hydrate(useChatStore, [
      persistedTab('chat-1'),
      persistedTab('chat-2'),
    ]);

    useChatStore
      .getState()
      .setTabPinned('chat-2', true, { projectId: 'proj', worktreeId: 'wt' });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(
      commandMock.mock.calls.map(([commandEnvelope]) => ({
        type: commandEnvelope.command.type,
        expectedRevision: commandEnvelope.expectedRevision,
      })),
    ).toEqual([
      { type: 'chat.patch_tab_settings', expectedRevision: 5 },
      { type: 'chat.reorder_tabs', expectedRevision: 6 },
    ]);
    expect(Array.from(pinnedChatIds)).toEqual(['chat-2']);
    expect(canonicalOrder).toEqual(['chat-2', 'chat-1']);
  });

  it('commits chat.close_tab discard_empty when closing an unused draft', async () => {
    const { useChatStore } = loadChatStore();
    installCanonicalAwareCommandMock(['chat-1']);
    await hydrate(useChatStore);
    useChatStore.getState().createTab({ projectId: 'proj', worktreeId: 'wt' });
    await flushMicrotasks();
    const draftId = useChatStore
      .getState()
      .worktreeChats[KEY]?.tabs.find((tab) => tab.id !== 'chat-1')?.id;
    expect(draftId).toBeDefined();
    if (!draftId) return;

    useChatStore
      .getState()
      .closeTab(draftId, { projectId: 'proj', worktreeId: 'wt' });
    await flushMicrotasks();
    await flushMicrotasks();

    const closeCommands = commandMock.mock.calls
      .map(([envelope]) => envelope.command)
      .filter((command) => command.type === 'chat.close_tab');
    expect(closeCommands).toEqual([
      expect.objectContaining({
        type: 'chat.close_tab',
        tabId: draftId,
        mode: 'discard_empty',
      }),
    ]);
  });

  it('does not rematerialize a closed tab when an older upsert arrives after the close result', async () => {
    const { useChatStore } = loadChatStore();
    const closeResult = deferred<ChatCommandResult>();
    commandMock.mockImplementation((envelope) =>
      envelope.command.type === 'chat.close_tab'
        ? closeResult.promise
        : Promise.resolve(commandResult(envelope.commandId, 'applied')),
    );
    await hydrate(useChatStore, [
      persistedTab('chat-1'),
      persistedTab('chat-2'),
    ]);

    useChatStore
      .getState()
      .closeTab('chat-2', { projectId: 'proj', worktreeId: 'wt' });
    await flushMicrotasks();
    const closeEnvelope = commandMock.mock.calls.find(
      ([envelope]) => envelope.command.type === 'chat.close_tab',
    )?.[0];
    if (!closeEnvelope) throw new Error('Expected close command');

    closeResult.resolve({
      commandId: closeEnvelope.commandId,
      revision: 7,
      outcome: 'applied',
    });
    await flushMicrotasks();
    expect(
      useChatStore.getState().worktreeChats[KEY]?.tabs.map((tab) => tab.id),
    ).toEqual(['chat-1']);

    // A pre-close mutation was already committed when the user clicked close,
    // but its broadcast was delayed. It may update canonical data without
    // making the optimistically closed tab or panel visible again.
    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(5, 6, [
          { type: 'tab.upserted', tab: persistedTab('chat-2') },
        ]),
      );
    expect(
      useChatStore.getState().worktreeChats[KEY]?.tabs.map((tab) => tab.id),
    ).toEqual(['chat-1']);

    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(6, 7, [{ type: 'tab.removed', tabId: 'chat-2' }]),
      );
    expect(
      useChatStore.getState().worktreeChats[KEY]?.tabs.map((tab) => tab.id),
    ).toEqual(['chat-1']);
  });

  it('refreshes a destructively filtered tab when optimistic close is rejected', async () => {
    const { useChatStore } = loadChatStore();
    const closeResult = deferred<ChatCommandResult>();
    commandMock.mockImplementation((envelope) =>
      envelope.command.type === 'chat.close_tab'
        ? closeResult.promise
        : Promise.resolve(commandResult(envelope.commandId, 'applied')),
    );
    await hydrate(useChatStore, [
      persistedTab('chat-1'),
      persistedTab('chat-2'),
    ]);
    getStateMock.mockClear();
    getStateMock.mockResolvedValue(
      snapshot(7, [persistedTab('chat-1'), persistedTab('chat-2')], 'chat-1'),
    );

    useChatStore
      .getState()
      .closeTab('chat-2', { projectId: 'proj', worktreeId: 'wt' });
    await flushMicrotasks();
    useChatStore
      .getState()
      .handleChatStateChanged(
        changeEvent(5, 6, [
          { type: 'tab.upserted', tab: persistedTab('chat-2') },
        ]),
      );
    expect(
      useChatStore.getState().worktreeChats[KEY]?.tabs.map((tab) => tab.id),
    ).toEqual(['chat-1']);

    const closeEnvelope = commandMock.mock.calls.find(
      ([envelope]) => envelope.command.type === 'chat.close_tab',
    )?.[0];
    if (!closeEnvelope) throw new Error('Expected close command');
    closeResult.resolve({
      commandId: closeEnvelope.commandId,
      revision: 6,
      outcome: 'rejected',
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(getStateMock).toHaveBeenCalledTimes(1);
    expect(
      useChatStore.getState().worktreeChats[KEY]?.tabs.map((tab) => tab.id),
    ).toEqual(['chat-1', 'chat-2']);
  });

  it.each([false, true])(
    'archives an unloaded background transcript (bulk: %s)',
    async (bulk) => {
      const { useChatStore } = loadChatStore();
      installCanonicalAwareCommandMock(['chat-1', 'chat-2']);
      await hydrate(useChatStore, [
        persistedTab('chat-1'),
        persistedTab('chat-2', {
          messages: [],
          transcriptLoaded: false,
          transcript: {
            format: 'complete-message-jsonl-v1',
            committedMessageCount: 2,
            committedByteLength: 200,
            transcriptRevision: 1,
            hasActiveSidecar: false,
            messageCount: 2,
          },
        }),
      ]);
      expect(
        useChatStore.getState().worktreeChats[KEY]?.tabs[1]?.messages,
      ).toEqual([]);
      commandMock.mockClear();

      const target = { projectId: 'proj', worktreeId: 'wt' };
      if (bulk) useChatStore.getState().closeTabs(['chat-2'], target);
      else useChatStore.getState().closeTab('chat-2', target);
      await flushMicrotasks();
      await flushMicrotasks();

      const command = commandMock.mock.calls[0]?.[0].command;
      expect(command).toMatchObject(
        bulk
          ? {
              type: 'chat.close_tabs',
              targets: [{ tabId: 'chat-2', mode: 'archive' }],
            }
          : { type: 'chat.close_tab', tabId: 'chat-2', mode: 'archive' },
      );
    },
  );

  it('atomically persists the replacement when closing the final tab', async () => {
    const { useChatStore } = loadChatStore();
    installCanonicalAwareCommandMock(['chat-1']);
    await hydrate(useChatStore, [persistedTab('chat-1', { messages: [] })]);

    useChatStore
      .getState()
      .closeTab('chat-1', { projectId: 'proj', worktreeId: 'wt' });
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    const replacementId =
      useChatStore.getState().worktreeChats[KEY]?.activeTabId;
    const closeCommands = commandMock.mock.calls
      .map(([envelope]) => envelope.command)
      .filter((command) => command.type === 'chat.close_tab');
    expect(replacementId).toBeDefined();
    expect(closeCommands).toHaveLength(1);
    const closeCommand = closeCommands[0];
    if (!closeCommand || closeCommand.type !== 'chat.close_tab') {
      throw new Error('Expected one close-tab command');
    }
    expect(closeCommand).toMatchObject({
      tabId: 'chat-1',
      mode: 'discard_empty',
      replacementTabId: replacementId,
    });
    expect(closeCommand.replacementTab).toMatchObject({
      type: 'chat.create_tab',
      tabId: replacementId,
      approvalMode: 'ask',
    });
    expect(closeCommand.replacementTab?.modelConfig).toBeDefined();
    expect(typeof closeCommand.replacementTab?.deferredToolsAllowed).toBe(
      'boolean',
    );
  });

  it('commits one atomic command when bulk-closing multiple tabs', async () => {
    const { useChatStore } = loadChatStore();
    installCanonicalAwareCommandMock(['chat-1', 'chat-2']);
    await hydrate(useChatStore, [
      persistedTab('chat-1', { messages: [] }),
      persistedTab('chat-2', { messages: [] }),
    ]);

    useChatStore.getState().closeTabs(['chat-1', 'chat-2'], {
      projectId: 'proj',
      worktreeId: 'wt',
    });
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    const replacementId =
      useChatStore.getState().worktreeChats[KEY]?.activeTabId;
    expect(commandMock).toHaveBeenCalledTimes(1);
    const closeCommand = commandMock.mock.calls[0]?.[0].command;
    if (!closeCommand || closeCommand.type !== 'chat.close_tabs') {
      throw new Error('Expected one bulk-close command');
    }
    expect(closeCommand).toMatchObject({
      targets: [
        { tabId: 'chat-1', mode: 'discard_empty' },
        { tabId: 'chat-2', mode: 'discard_empty' },
      ],
      replacementTabId: replacementId,
    });
    expect(closeCommand.replacementTab).toMatchObject({
      type: 'chat.create_tab',
      tabId: replacementId,
      approvalMode: 'ask',
    });
    expect(closeCommand.replacementTab?.modelConfig).toBeDefined();
    expect(typeof closeCommand.replacementTab?.deferredToolsAllowed).toBe(
      'boolean',
    );
  });

  it("dispatches close mode 'discard' for a contentful close in a hard-delete sentinel scope", async () => {
    const { useChatStore } = loadChatStore();
    installCanonicalAwareCommandMock(['plan-chat']);
    getStateMock.mockResolvedValue({
      schemaVersion: 1,
      projectId: 'plan-explore-chat',
      worktreeId: 'plan-1',
      revision: 5,
      tabsFile: tabsFile([persistedTab('plan-chat')], 'plan-chat'),
      archives: [],
      runtimeByChatId: {},
      queue: [],
    });
    await useChatStore
      .getState()
      .loadTabsForTarget('plan-explore-chat', 'plan-1');

    useChatStore.getState().closeTab('plan-chat', {
      projectId: 'plan-explore-chat',
      worktreeId: 'plan-1',
    });
    await flushMicrotasks();
    await flushMicrotasks();

    const closeCommands = commandMock.mock.calls
      .map(([envelope]) => envelope.command)
      .filter((command) => command.type === 'chat.close_tab');
    expect(closeCommands).toEqual([
      expect.objectContaining({
        type: 'chat.close_tab',
        tabId: 'plan-chat',
        mode: 'discard',
      }),
    ]);
  });

  it('commits chat.fork_tab for a same-scope fork', async () => {
    const { useChatStore } = loadChatStore();
    installCanonicalAwareCommandMock(['chat-1']);
    await hydrate(useChatStore);

    useChatStore
      .getState()
      .forkTab('chat-1', { projectId: 'proj', worktreeId: 'wt' });
    await flushMicrotasks();

    const forkCommands = commandMock.mock.calls
      .map(([envelope]) => envelope.command)
      .filter((command) => command.type === 'chat.fork_tab');
    const forkedTab = useChatStore
      .getState()
      .worktreeChats[KEY]?.tabs.find((tab) => tab.id !== 'chat-1');
    expect(forkedTab).toBeDefined();
    expect(forkCommands).toEqual([
      expect.objectContaining({
        type: 'chat.fork_tab',
        sourceTabId: 'chat-1',
        targetTabId: forkedTab?.id,
      }),
    ]);
  });
});

describe('dispatchChatCommand', () => {
  async function hydrate(
    useChatStore: (typeof ChatStoreModule)['useChatStore'],
  ): Promise<void> {
    getStateMock.mockResolvedValue(
      snapshot(5, [persistedTab('chat-1')], 'chat-1'),
    );
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
  }

  it('keeps carried GitHub snapshots below the main command-size limit', async () => {
    const { useChatStore } = loadChatStore();
    const createdAt = '2026-09-14T12:00:00.000Z';
    const largeRun = (runId: string): GitHubWorkflowRunArtifactReceiptV1 =>
      buildGitHubWorkflowRunArtifactReceipt({
        operation: 'github.watch',
        createdAt,
        watcherId: `watcher-${runId}`,
        repository: 'acme/api',
        runId,
        runAttempt: 1,
        workflowName: 'CI',
        runNumber: Number(runId),
        htmlUrl: `https://github.com/acme/api/actions/runs/${runId}`,
        state: { kind: 'intermediate', status: 'in_progress' },
        startedAt: createdAt,
        observedAt: createdAt,
        jobs: Array.from({ length: 500 }, (_, index) => ({
          jobId: String(Number(runId) * 1_000 + index + 1),
          name: `${String(index).padStart(3, '0')}-${'n'.repeat(196)}`,
          status: 'in_progress',
          conclusion: null,
          htmlUrl: `https://github.com/acme/api/actions/runs/${runId}/job/${String(Number(runId) * 1_000 + index + 1)}`,
          createdAt,
          startedAt: createdAt,
          observedAt: createdAt,
        })),
        navigationTarget: {
          kind: 'github_workflow_run',
          repository: 'acme/api',
          runId,
          htmlUrl: `https://github.com/acme/api/actions/runs/${runId}`,
        },
      });
    const userMessages = Array.from({ length: 6 }, (_, index) => ({
      id: `user-${index + 1}`,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: `prompt ${index + 1}` }],
      timestamp: index + 1,
    }));
    const existingCarry = Object.fromEntries(
      userMessages
        .slice(0, -1)
        .map((message, index) => [message.id, [largeRun(String(index + 101))]]),
    );
    getStateMock.mockResolvedValue(
      snapshot(
        5,
        [
          persistedTab('chat-1', {
            messages: userMessages,
            agentArtifactCarryByTurn: existingCarry,
          }),
        ],
        'chat-1',
      ),
    );
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    commandMock.mockImplementation((envelope: { commandId: string }) =>
      Promise.resolve(commandResult(envelope.commandId, 'applied')),
    );

    useChatStore
      .getState()
      .recordAgentArtifactCarry(
        { projectId: 'proj', worktreeId: 'wt', chatId: 'chat-1' },
        'user-6',
        [largeRun('106')],
      );
    await flushMicrotasks();

    const envelope =
      commandMock.mock.calls[commandMock.mock.calls.length - 1]?.[0];
    expect(envelope?.command.type).toBe('chat.patch_tab_settings');
    expect(
      new TextEncoder().encode(JSON.stringify(envelope)).byteLength,
    ).toBeLessThan(1024 * 1024);
    if (envelope?.command.type !== 'chat.patch_tab_settings') {
      throw new Error('Expected a chat.patch_tab_settings command');
    }
    expect(envelope.command.patch.agentArtifactCarryByTurn).toEqual(
      useChatStore.getState().worktreeChats[KEY]?.tabs[0]
        ?.agentArtifactCarryByTurn,
    );
    expect(
      envelope.command.patch.agentArtifactCarryByTurn?.['user-6']?.[0],
    ).toMatchObject({ kind: 'github_workflow_run', runId: '106' });
  });

  it('reconciles an accepted command without attaching the scope revision by default', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);
    commandMock.mockImplementation((envelope: { commandId: string }) =>
      Promise.resolve(commandResult(envelope.commandId, 'applied')),
    );
    const rollback = jest.fn();
    const reconcile = jest.fn();

    const disposition = await useChatStore
      .getState()
      .dispatchChatCommand(
        { projectId: 'proj', worktreeId: 'wt' },
        { type: 'chat.close_tab', tabId: 'chat-1', mode: 'archive' },
        { rollback, reconcile },
      );

    expect(disposition).toBe('accepted');
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();
    expect(commandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: 1,
        projectId: 'proj',
        worktreeId: 'wt',
      }),
    );
    expect(commandMock.mock.calls[0]?.[0]).not.toHaveProperty(
      'expectedRevision',
    );
    expect(useChatStore.getState().chatStateNotices[KEY]).toBeUndefined();
  });

  it('attaches an explicit revision only when a command sequence requires it', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);
    commandMock.mockImplementation((envelope: { commandId: string }) =>
      Promise.resolve(commandResult(envelope.commandId, 'applied')),
    );

    await useChatStore
      .getState()
      .dispatchChatCommand(
        { projectId: 'proj', worktreeId: 'wt' },
        { type: 'chat.create_tab', tabId: 'chat-2', title: 'Second chat' },
        { expectedRevision: 7 },
      );

    expect(commandMock.mock.calls[0]?.[0]).toMatchObject({
      expectedRevision: 7,
    });
  });

  it('rolls back a stale destructive command, shows the conflict copy, and refreshes instead of retrying', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);
    commandMock.mockImplementation((envelope: { commandId: string }) =>
      Promise.resolve(commandResult(envelope.commandId, 'conflict')),
    );
    getStateMock.mockClear();
    getStateMock.mockResolvedValue(
      snapshot(11, [persistedTab('chat-1')], 'chat-1'),
    );
    const rollback = jest.fn();

    const disposition = await useChatStore
      .getState()
      .dispatchChatCommand(
        { projectId: 'proj', worktreeId: 'wt' },
        { type: 'chat.close_tab', tabId: 'chat-1', mode: 'archive' },
        { rollback },
      );

    expect(disposition).toBe('conflict');
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().chatStateNotices[KEY]).toEqual({
      kind: 'conflict',
      message: CHAT_STATE_CONFLICT_NOTICE,
    });
    // The view refreshed once; the command was not resubmitted.
    await flushMicrotasks();
    expect(getStateMock).toHaveBeenCalledTimes(1);
    expect(commandMock).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().chatStateSync[KEY]).toEqual({
      phase: 'live',
      revision: 11,
    });
  });

  it('rolls back only the failing overlay on transport failure and shows the failure copy', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);
    commandMock.mockRejectedValue(new Error('ipc dropped'));
    const rollback = jest.fn();

    const disposition = await useChatStore.getState().dispatchChatCommand(
      { projectId: 'proj', worktreeId: 'wt' },
      {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { planMode: true },
      },
      { rollback },
    );

    expect(disposition).toBe('transport_failed');
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().chatStateNotices[KEY]).toEqual({
      kind: 'command_failed',
      message: CHAT_STATE_COMMAND_FAILED_NOTICE,
    });

    useChatStore.getState().dismissChatStateNotice('proj', 'wt');
    expect(useChatStore.getState().chatStateNotices[KEY]).toBeUndefined();
  });

  it('returns an interface-mode command failure without rejecting the UI promise', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);
    commandMock.mockImplementation((commandEnvelope) =>
      Promise.resolve({
        commandId: commandEnvelope.commandId,
        revision: 5,
        outcome: 'rejected',
      }),
    );

    await expect(
      useChatStore.getState().setChatInterfaceMode('chat-1', 'claude-code', {
        projectId: 'proj',
        worktreeId: 'wt',
      }),
    ).resolves.toBe('rejected');
    expect(useChatStore.getState().chatStateNotices[KEY]).toEqual({
      kind: 'command_failed',
      message: CHAT_STATE_COMMAND_FAILED_NOTICE,
    });
  });
});

describe('Auto model selection mode', () => {
  const TARGET = {
    projectId: 'proj',
    worktreeId: 'wt',
    chatId: 'chat-1',
  } as const;

  async function hydrateLiveScope(
    tab: PersistedChatTab,
  ): Promise<typeof ChatStoreModule.useChatStore> {
    const { useChatStore } = loadChatStore();
    getStateMock.mockResolvedValue(snapshot(1, [tab], tab.id));
    commandMock.mockImplementation((request) =>
      Promise.resolve(commandResult(request.commandId, 'applied')),
    );
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    commandMock.mockClear();
    return useChatStore;
  }

  function activeTab(
    useChatStore: typeof ChatStoreModule.useChatStore,
  ): { modelSelectionMode?: 'auto' } | undefined {
    return useChatStore
      .getState()
      .worktreeChats[KEY]?.tabs.find((tab) => tab.id === 'chat-1');
  }

  it('enters Auto optimistically and patches the canonical tab', async () => {
    const useChatStore = await hydrateLiveScope(persistedTab('chat-1'));

    void useChatStore.getState().setModelSelectionMode('auto', TARGET);

    expect(activeTab(useChatStore)?.modelSelectionMode).toBe('auto');
    expect(commandMock).toHaveBeenCalledTimes(1);
    expect(commandMock.mock.calls[0]?.[0].command).toMatchObject({
      type: 'chat.patch_tab_settings',
      tabId: 'chat-1',
      patch: { modelSelectionMode: 'auto' },
    });
  });

  it('returns to manual with an explicit null, never an omitted key', async () => {
    const useChatStore = await hydrateLiveScope(
      persistedTab('chat-1', { modelSelectionMode: 'auto' }),
    );

    void useChatStore.getState().setModelSelectionMode('manual', TARGET);

    expect(activeTab(useChatStore)?.modelSelectionMode).toBeUndefined();
    const command = commandMock.mock.calls[0]?.[0].command;
    expect(command).toMatchObject({
      type: 'chat.patch_tab_settings',
      patch: { modelSelectionMode: null },
    });
  });

  it('is a no-op when the chat is already in the requested mode', async () => {
    const useChatStore = await hydrateLiveScope(
      persistedTab('chat-1', { modelSelectionMode: 'auto' }),
    );

    void useChatStore.getState().setModelSelectionMode('auto', TARGET);

    expect(commandMock).not.toHaveBeenCalled();
  });
});

describe('renameTab', () => {
  const TARGET = { projectId: 'proj', worktreeId: 'wt' };

  async function hydrate(
    useChatStore: (typeof ChatStoreModule)['useChatStore'],
    tabs: PersistedChatTab[] = [persistedTab('chat-1')],
  ): Promise<void> {
    getStateMock.mockResolvedValue(snapshot(5, tabs, tabs[0]?.id ?? ''));
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
  }

  function tab(
    useChatStore: (typeof ChatStoreModule)['useChatStore'],
    id = 'chat-1',
  ): ReturnType<
    typeof useChatStore.getState
  >['worktreeChats'][string]['tabs'][number] {
    const found = useChatStore
      .getState()
      .worktreeChats[KEY]?.tabs.find((t) => t.id === id);
    if (!found) throw new Error(`missing tab ${id}`);
    return found;
  }

  it('persists a rename even before a scope has a live revisioned projection', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);
    useChatStore.setState({ chatStateSync: {} });
    commandMock.mockImplementation((envelope) =>
      Promise.resolve(commandResult(envelope.commandId, 'applied')),
    );
    await expect(
      useChatStore.getState().renameTab('chat-1', 'Durable', TARGET),
    ).resolves.toBe(true);
    expect(commandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { customTitle: 'Durable' },
        },
      }),
    );
  });

  it('does not paint a rename when the scope is unavailable', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore, [
      persistedTab('chat-1', { customTitle: 'Before' }),
    ]);
    useChatStore.setState({
      chatStateSync: { [KEY]: { phase: 'refresh_error', revision: 5 } },
    });
    await expect(
      useChatStore.getState().renameTab('chat-1', 'After', TARGET),
    ).resolves.toBe(false);
    expect(tab(useChatStore).customTitle).toBe('Before');
    expect(commandMock).not.toHaveBeenCalled();
  });

  it('refreshes canonical state when transport fails after main committed the rename', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore, [
      persistedTab('chat-1', { customTitle: 'Before' }),
    ]);
    getStateMock.mockResolvedValue(
      snapshot(
        6,
        [
          persistedTab('chat-1', {
            customTitle: 'After',
            description: 'New generated',
          }),
        ],
        'chat-1',
      ),
    );
    commandMock.mockRejectedValue(new Error('reply lost after commit'));
    await expect(
      useChatStore.getState().renameTab('chat-1', 'After', TARGET),
    ).resolves.toBe(false);
    await flushMicrotasks();
    expect(getStateMock).toHaveBeenCalledTimes(2);
    expect(tab(useChatStore)).toMatchObject({
      customTitle: 'After',
      description: 'New generated',
    });
  });

  it('dispatches a trimmed custom title at the scope revision and applies it optimistically', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);
    const pending = deferred<ChatCommandResult>();
    commandMock.mockReturnValue(pending.promise);

    const result = useChatStore
      .getState()
      .renameTab('chat-1', '  Release notes  ', TARGET);
    await flushMicrotasks();

    expect(tab(useChatStore).customTitle).toBe('Release notes');
    const envelope = commandMock.mock.calls[0]?.[0];
    expect(envelope?.expectedRevision).toBe(5);
    expect(envelope?.command).toEqual({
      type: 'chat.patch_tab_settings',
      tabId: 'chat-1',
      patch: { customTitle: 'Release notes' },
    });
    pending.resolve(commandResult(envelope?.commandId ?? '', 'applied'));
    await expect(result).resolves.toBe(true);
    expect(tab(useChatStore).customTitle).toBe('Release notes');
  });

  it('clears with null for blank input and skips unchanged names', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore, [
      persistedTab('chat-1', { customTitle: 'Mine', description: 'Gen' }),
    ]);
    commandMock.mockImplementation((envelope) =>
      Promise.resolve(commandResult(envelope.commandId, 'applied')),
    );

    await expect(
      useChatStore.getState().renameTab('chat-1', ' Mine ', TARGET),
    ).resolves.toBe(true);
    expect(commandMock).not.toHaveBeenCalled();

    await expect(
      useChatStore.getState().renameTab('chat-1', '   ', TARGET),
    ).resolves.toBe(true);
    expect(commandMock.mock.calls[0]?.[0].command).toEqual({
      type: 'chat.patch_tab_settings',
      tabId: 'chat-1',
      patch: { customTitle: null },
    });
    expect('customTitle' in tab(useChatStore)).toBe(false);
  });

  it('ignores missing tabs, file tabs and over-limit names', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore, [
      persistedTab('chat-1'),
      persistedTab('file-1', { kind: 'file', filePath: '/tmp/a.ts' }),
    ]);

    const state = useChatStore.getState();
    await expect(state.renameTab('missing', 'x', TARGET)).resolves.toBe(false);
    await expect(state.renameTab('file-1', 'x', TARGET)).resolves.toBe(false);
    await expect(
      state.renameTab('chat-1', 'x'.repeat(257), TARGET),
    ).resolves.toBe(false);
    expect(commandMock).not.toHaveBeenCalled();
    expect(tab(useChatStore).customTitle).toBeUndefined();
  });

  it.each(['rejected', 'transport'] as const)(
    'rolls back its own optimistic name after a %s failure',
    async (failure) => {
      const { useChatStore } = loadChatStore();
      await hydrate(useChatStore, [
        persistedTab('chat-1', { customTitle: 'Before' }),
      ]);
      commandMock.mockImplementation((envelope) =>
        failure === 'transport'
          ? Promise.reject(new Error('ipc down'))
          : Promise.resolve(commandResult(envelope.commandId, 'rejected')),
      );

      await expect(
        useChatStore.getState().renameTab('chat-1', 'After', TARGET),
      ).resolves.toBe(false);
      expect(tab(useChatStore).customTitle).toBe('Before');
      expect(useChatStore.getState().chatStateNotices[KEY]).toEqual({
        kind: 'command_failed',
        message: CHAT_STATE_COMMAND_FAILED_NOTICE,
      });
    },
  );

  it('keeps a newer canonical name instead of rolling back over it', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);
    const pending = deferred<ChatCommandResult>();
    commandMock.mockReturnValue(pending.promise);

    const result = useChatStore.getState().renameTab('chat-1', 'Mine', TARGET);
    await flushMicrotasks();
    useChatStore.getState().handleChatStateChanged(
      changeEvent(5, 6, [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat-1',
          patch: { customTitle: 'Elsewhere', description: 'Generated' },
        },
      ]),
    );
    getStateMock.mockResolvedValue(
      snapshot(
        6,
        [
          persistedTab('chat-1', {
            customTitle: 'Elsewhere',
            description: 'Generated',
          }),
        ],
        'chat-1',
      ),
    );
    pending.reject(new Error('ipc down'));

    await expect(result).resolves.toBe(false);
    expect(tab(useChatStore).customTitle).toBe('Elsewhere');
    expect(tab(useChatStore).description).toBe('Generated');
  });

  it('targets the captured scope after navigation', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);
    commandMock.mockImplementation((envelope) =>
      Promise.resolve(commandResult(envelope.commandId, 'applied')),
    );
    useChatStore.setState({
      selectedWorktree: { projectId: 'other', worktreeId: 'elsewhere' },
    });

    await expect(
      useChatStore.getState().renameTab('chat-1', 'Mine', TARGET),
    ).resolves.toBe(true);
    const envelope = commandMock.mock.calls[0]?.[0];
    expect(envelope?.projectId).toBe('proj');
    expect(envelope?.worktreeId).toBe('wt');
    expect(tab(useChatStore).customTitle).toBe('Mine');
  });
});
