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
 *
 * Deltas, the command port and tab lifecycle commands are covered by the
 * sibling `chatStore.revisioned*.test.ts` files.
 * Setup, and why the suite is split, live in `chatStoreRevisionedHarness.ts`.
 */
import type {
  ApprovalRequestEvent,
  ChatCommandResult,
  ChatStateSnapshot,
  GitHubWorkflowRunArtifactReceiptV1,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type * as ChatStoreModule from '../chatStore';
import { makeTestPreferences } from '@/test-utils/preferences';
import type { ChatTab } from '../chat/types';
import type * as DiffStatsRuntimeModule from '../projectsStore.diffStatsRuntime';
import type * as ChatInterestRedeclareModule from '@/lib/chat-interest/redeclare';
import {
  CHAT_STATE_COMMAND_FAILED_NOTICE,
  CHAT_STATE_CONFLICT_NOTICE,
} from '../chat/revisioned-copy';
import { buildGitHubWorkflowRunArtifactReceipt } from '@canopy/desktop-shared/lib/agent-artifacts';
import {
  loadTabsMock,
  saveTabsMock,
  saveTabsPartialMock,
  getStateMock,
  archiveTabMock,
  forkOpenWorktreeTabsMock,
  commandMock,
  pendingApprovalRequestsMock,
  getResolvedDefaultMock,
  setModeMock,
  toggleThinkingLevelMock,
  togglePlanModeMock,
  loadChatStore,
  persistedTab,
  tabsFile,
  snapshot,
  changeEvent,
  commandResult,
  deferred,
  flushMicrotasks,
  flushPendingWork,
  KEY,
  hydrate,
  installRevisionedChatStoreHooks,
} from './chatStoreRevisionedHarness';

installRevisionedChatStoreHooks();

describe('revisioned hydration', () => {
  it('restores a staged rich draft into composer state before defaults can restamp an empty chat', async () => {
    const previous = Object.getOwnPropertyDescriptor(
      globalThis,
      'localStorage',
    );
    const draft = [
      { type: 'paragraph', children: [{ text: 'My edited incident' }] },
    ];
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string): string | null =>
          key === 'canopy:try-it-draft:v1:chat-1'
            ? JSON.stringify({ content: draft, stagingIds: ['capability'] })
            : null,
      },
    });
    try {
      const { useChatStore } = loadChatStore();
      getStateMock.mockResolvedValue(
        snapshot(0, [persistedTab('chat-1')], 'chat-1'),
      );
      await useChatStore.getState().loadTabsForTarget('proj', 'wt');
      expect(useChatStore.getState().tabDrafts['chat-1']).toEqual(draft);
    } finally {
      if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });
  // This first test loads the store's dependency graph in a busy CI shard.
  it('exposes only a newly created scope before hydration, with resolved defaults and a stable draft target', async () => {
    const { useChatStore } = loadChatStore();
    const pending = deferred<ChatStateSnapshot>();
    const approval = deferred<'full-access'>();
    getStateMock.mockReturnValue(pending.promise);
    getResolvedDefaultMock.mockReturnValue(approval.promise);
    useChatStore.getState().applyModelDefaults(
      makeTestPreferences({
        defaultWorktreeProvider: 'claude',
        defaultWorktreeModelByProvider: {
          claude: { model: 'sonnet', thinkingLevel: 'low' },
          codex: { model: 'gpt-5.5', thinkingLevel: 'low' },
          ollama: null,
        },
      }),
    );
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

  it('hint activation acknowledges existing Plan without toggling it off', async () => {
    const { useChatStore } = loadChatStore();
    getStateMock.mockResolvedValue(
      snapshot(0, [persistedTab('hint', { planMode: true })], 'hint'),
    );
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    const activated = jest.fn();
    useChatStore
      .getState()
      .togglePlanMode(
        { projectId: 'proj', worktreeId: 'wt', chatId: 'hint' },
        activated,
      );
    await flushMicrotasks();
    expect(activated).toHaveBeenCalledWith(true);
    expect(togglePlanModeMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().worktreeChats[KEY]?.tabs[0]?.planMode).toBe(
      true,
    );
  });

  it('hint activation reports a rejected backend setter and restores Plan', async () => {
    const { useChatStore } = loadChatStore();
    getStateMock.mockResolvedValue(
      snapshot(0, [persistedTab('hint', { planMode: false })], 'hint'),
    );
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    togglePlanModeMock.mockRejectedValueOnce(new Error('setter failed'));
    const activated = jest.fn();
    useChatStore
      .getState()
      .togglePlanMode(
        { projectId: 'proj', worktreeId: 'wt', chatId: 'hint' },
        activated,
      );
    await flushMicrotasks();
    expect(activated).toHaveBeenCalledWith(false);
    expect(useChatStore.getState().worktreeChats[KEY]?.tabs[0]?.planMode).toBe(
      false,
    );
  });

  it('a rejected hint activation preserves a newer off/on Plan choice', async () => {
    const { useChatStore } = loadChatStore();
    getStateMock.mockResolvedValue(
      snapshot(0, [persistedTab('hint', { planMode: false })], 'hint'),
    );
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    let rejectActivation: ((error: Error) => void) | undefined;
    togglePlanModeMock.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectActivation = reject;
        }),
    );
    const target = { projectId: 'proj', worktreeId: 'wt', chatId: 'hint' };
    const activated = jest.fn();
    useChatStore.getState().togglePlanMode(target, activated);
    useChatStore.getState().togglePlanMode(target);
    useChatStore.getState().togglePlanMode(target);
    await flushMicrotasks();
    expect(useChatStore.getState().worktreeChats[KEY]?.tabs[0]?.planMode).toBe(
      true,
    );
    rejectActivation?.(new Error('older setter failed'));
    await flushMicrotasks();
    expect(activated).toHaveBeenCalledWith(false);
    expect(useChatStore.getState().worktreeChats[KEY]?.tabs[0]?.planMode).toBe(
      true,
    );
  });

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

describe('dispatchChatCommand', () => {
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

describe('setChatUnread (CAN-4378)', () => {
  async function hydrateTwoTabs(
    useChatStore: typeof ChatStoreModule.useChatStore,
    chat1: Partial<PersistedChatTab> = {},
    activeTabId = 'chat-2',
  ): Promise<void> {
    getStateMock.mockResolvedValue(
      snapshot(
        5,
        [persistedTab('chat-1', chat1), persistedTab('chat-2')],
        activeTabId,
      ),
    );
    commandMock.mockImplementation((envelope) =>
      Promise.resolve(commandResult(envelope.commandId, 'applied')),
    );
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    useChatStore.setState({
      selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
    });
  }

  function chat1(
    useChatStore: typeof ChatStoreModule.useChatStore,
  ): ChatTab | undefined {
    return useChatStore
      .getState()
      .worktreeChats[KEY]?.tabs.find((candidate) => candidate.id === 'chat-1');
  }

  function sentCommands(): unknown[] {
    return commandMock.mock.calls.map(([envelope]) => envelope.command);
  }

  it('marks a read chat unread as a manual mark', async () => {
    const { useChatStore } = loadChatStore();
    await hydrateTwoTabs(useChatStore);
    commandMock.mockClear();

    useChatStore.getState().setChatUnread('proj', 'wt', 'chat-1', true);
    await flushMicrotasks();

    expect(chat1(useChatStore)?.unread).toBe(true);
    expect(chat1(useChatStore)?.unreadMarkedManually).toBe(true);
    expect(useChatStore.getState().unreadWorktreeKeys.has(KEY)).toBe(true);
    expect(sentCommands()).toEqual([
      { type: 'chat.mark_unread', chatId: 'chat-1', manual: true },
    ]);
  });

  it('restores canonical state when main rejects a manual mark', async () => {
    const { useChatStore } = loadChatStore();
    await hydrateTwoTabs(useChatStore);
    // An older remote-control host refuses the manual flag.
    commandMock.mockImplementation((envelope) =>
      Promise.resolve(commandResult(envelope.commandId, 'rejected')),
    );

    useChatStore.getState().setChatUnread('proj', 'wt', 'chat-1', true);
    expect(chat1(useChatStore)?.unread).toBe(true);
    await flushPendingWork();

    expect(chat1(useChatStore)?.unread).not.toBe(true);
    expect(chat1(useChatStore)?.unreadMarkedManually).toBeUndefined();
  });

  it('does nothing when the chat is already in the requested state', async () => {
    const { useChatStore } = loadChatStore();
    await hydrateTwoTabs(useChatStore, { unread: true });
    commandMock.mockClear();

    useChatStore.getState().setChatUnread('proj', 'wt', 'chat-1', true);
    useChatStore.getState().setChatUnread('proj', 'wt', 'chat-2', false);
    useChatStore.getState().setChatUnread('proj', 'wt', 'missing', true);
    await flushMicrotasks();

    expect(chat1(useChatStore)?.unreadMarkedManually).toBeUndefined();
    expect(commandMock).not.toHaveBeenCalled();
  });

  it('marks an unread chat read through the shared read path', async () => {
    const { useChatStore } = loadChatStore();
    await hydrateTwoTabs(useChatStore, {
      unread: true,
      unreadMarkedManually: true,
    });
    commandMock.mockClear();

    useChatStore.getState().setChatUnread('proj', 'wt', 'chat-1', false);
    await flushMicrotasks();

    expect(chat1(useChatStore)?.unread).toBe(false);
    expect(chat1(useChatStore)?.unreadMarkedManually).toBeUndefined();
    expect(sentCommands()).toEqual([
      { type: 'chat.mark_read', chatId: 'chat-1' },
      { type: 'chat.dismiss_attention', chatId: 'chat-1' },
    ]);
  });

  it('hydration keeps the manual flag only while the chat is unread', async () => {
    const { useChatStore } = loadChatStore();
    getStateMock.mockResolvedValue(
      snapshot(
        5,
        [
          persistedTab('chat-1', { unread: true, unreadMarkedManually: true }),
          persistedTab('chat-2', { unreadMarkedManually: true }),
        ],
        'chat-2',
      ),
    );
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');

    const tabs = useChatStore.getState().worktreeChats[KEY]?.tabs ?? [];
    expect(tabs[0]?.unreadMarkedManually).toBe(true);
    expect(tabs[1]?.unreadMarkedManually).toBeUndefined();
  });

  it('keeps the viewed chat unread until it is left and reselected', async () => {
    const { useChatStore } = loadChatStore();
    await hydrateTwoTabs(useChatStore, {}, 'chat-1');
    const target = { projectId: 'proj', worktreeId: 'wt' };

    useChatStore.getState().setChatUnread('proj', 'wt', 'chat-1', true);
    await flushPendingWork();
    expect(chat1(useChatStore)?.unread).toBe(true);

    useChatStore.getState().switchTab('chat-2', target);
    await flushPendingWork();
    expect(chat1(useChatStore)?.unread).toBe(true);

    useChatStore.getState().switchTab('chat-1', target);
    await flushPendingWork();
    expect(chat1(useChatStore)?.unread).toBe(false);
  });

  it('a new reply replaces a manual mark with an automatic one', async () => {
    const { useChatStore } = loadChatStore();
    await hydrateTwoTabs(useChatStore, {
      unread: true,
      unreadMarkedManually: true,
    });
    const keysBefore = useChatStore.getState().unreadWorktreeKeys;
    commandMock.mockClear();

    useChatStore.getState().handleChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      data: { type: 'result', is_error: false, result: 'Finished' },
    });
    await flushMicrotasks();

    expect(chat1(useChatStore)?.unread).toBe(true);
    expect(chat1(useChatStore)?.unreadMarkedManually).toBeUndefined();
    expect(useChatStore.getState().unreadWorktreeKeys).toBe(keysBefore);
    expect(sentCommands()).toContainEqual({
      type: 'chat.mark_unread',
      chatId: 'chat-1',
    });
    expect(sentCommands()).not.toContainEqual({
      type: 'chat.mark_unread',
      chatId: 'chat-1',
      manual: true,
    });
  });

  it('a reply on an automatically unread chat sends nothing new', async () => {
    const { useChatStore } = loadChatStore();
    await hydrateTwoTabs(useChatStore, { unread: true });
    commandMock.mockClear();

    useChatStore.getState().handleChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      data: { type: 'result', is_error: false, result: 'Finished' },
    });
    await flushMicrotasks();

    expect(sentCommands()).not.toContainEqual(
      expect.objectContaining({ type: 'chat.mark_unread' }),
    );
  });

  async function enterRefresh(
    useChatStore: typeof ChatStoreModule.useChatStore,
  ): Promise<{ resolve: (value: ChatStateSnapshot) => void }> {
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
    await flushMicrotasks();
    commandMock.mockClear();
    return refreshed;
  }

  it('a manual mark queued during a refresh flushes as manual', async () => {
    const { useChatStore } = loadChatStore();
    await hydrateTwoTabs(useChatStore);
    const refreshed = await enterRefresh(useChatStore);

    useChatStore.getState().setChatUnread('proj', 'wt', 'chat-1', true);
    await flushMicrotasks();
    expect(commandMock).not.toHaveBeenCalled();

    refreshed.resolve(
      snapshot(9, [persistedTab('chat-1'), persistedTab('chat-2')], 'chat-2'),
    );
    await flushMicrotasks();
    await flushMicrotasks();

    expect(sentCommands()).toContainEqual({
      type: 'chat.mark_unread',
      chatId: 'chat-1',
      manual: true,
    });
  });

  it('marking read during a refresh drops a queued manual mark', async () => {
    const { useChatStore } = loadChatStore();
    await hydrateTwoTabs(useChatStore);
    const refreshed = await enterRefresh(useChatStore);

    useChatStore.getState().setChatUnread('proj', 'wt', 'chat-1', true);
    useChatStore.getState().setChatUnread('proj', 'wt', 'chat-1', false);
    await flushMicrotasks();

    refreshed.resolve(
      snapshot(9, [persistedTab('chat-1'), persistedTab('chat-2')], 'chat-2'),
    );
    await flushMicrotasks();
    await flushMicrotasks();

    expect(sentCommands()).not.toContainEqual(
      expect.objectContaining({ type: 'chat.mark_unread' }),
    );
  });

  it('a later automatic mark replaces a queued manual one', async () => {
    const { useChatStore } = loadChatStore();
    await hydrateTwoTabs(useChatStore);
    const refreshed = await enterRefresh(useChatStore);

    useChatStore.getState().setChatUnread('proj', 'wt', 'chat-1', true);
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

    const unreadMarks = sentCommands().filter(
      (command) =>
        typeof command === 'object' &&
        command !== null &&
        'type' in command &&
        command.type === 'chat.mark_unread',
    );
    expect(unreadMarks).toEqual([
      { type: 'chat.mark_unread', chatId: 'chat-1' },
    ]);
  });
});
