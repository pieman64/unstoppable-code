/**
 * Revisioned chat store coverage for committed delta application: revision
 * ordering, duplicates, provider batch aggregates and auto-archive.
 * Setup, and why the suite is split, live in `chatStoreRevisionedHarness.ts`.
 */
import type {
  ChatStateSnapshot,
  ActivityLiveBgTasksResponse,
} from '@canopy/desktop-shared/types';
import type * as NavigationStoreModule from '../navigationStore';
import type * as RevisionedChatSyncModule from '../chat/slices/revisioned';
import type * as DelegationActivityStoreModule from '../delegationActivityStore';
import type * as LiveBackgroundTaskStoreModule from '../liveBackgroundTaskStore';
import {
  loadTabsMock,
  getStateMock,
  archiveTabMock,
  commandMock,
  loadChatStore,
  persistedTab,
  tabsFile,
  snapshot,
  changeEvent,
  providerBatchAggregateEvent,
  commandResult,
  deferred,
  flushMicrotasks,
  flushPendingWork,
  KEY,
  PROVIDER_TASK_TYPES,
  setLiveBackgroundTask,
  settleLiveBackgroundTask,
  installLiveTaskPullBridge,
  canonicalAutoArchiveSnapshot,
  completeCanonicalTurn,
  hydrate,
  installRevisionedChatStoreHooks,
} from './chatStoreRevisionedHarness';

installRevisionedChatStoreHooks();

describe('committed delta application', () => {
  it.each(['delta', 'refresh'] as const)(
    'retires the request map on canonical %s and ignores delayed review events (CAN-5431)',
    async (route) => {
      const { useChatStore } = loadChatStore();
      const initial = persistedTab('chat-1', {
        trackedPlanId: 'plan-1',
        trackedPlanSource: 'claude',
        trackedPlanReviewStatus: 'pending',
        planMode: true,
        pendingPlanExit: { plan: '# v1' },
        pendingPlanExitRequestId: 'old-review',
      });
      getStateMock.mockResolvedValue(snapshot(5, [initial], 'chat-1'));
      await useChatStore.getState().loadTabsForTarget('proj', 'wt');
      const event = {
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat-1',
        requestId: 'old-review',
        source: 'claude' as const,
        toolInput: { plan: '# v1' },
        revisionNumber: 1,
      };
      useChatStore.getState().handlePlanExitRequest(event);
      expect(
        useChatStore.getState().pendingPlanExits['old-review'],
      ).toBeDefined();
      if (route === 'delta')
        useChatStore.getState().handleChatStateChanged(
          changeEvent(5, 6, [
            {
              type: 'tab.metadata_patched',
              tabId: 'chat-1',
              patch: { pendingPlanExit: null, pendingPlanExitRequestId: null },
            },
          ]),
        );
      else {
        getStateMock.mockResolvedValue(
          snapshot(
            6,
            [
              {
                ...initial,
                pendingPlanExit: undefined,
                pendingPlanExitRequestId: undefined,
              },
            ],
            'chat-1',
          ),
        );
        useChatStore.getState().refreshChatScopeRevisioned('proj', 'wt');
        await flushMicrotasks();
      }
      expect(
        useChatStore.getState().pendingPlanExits['old-review'],
      ).toBeUndefined();
      useChatStore.getState().handlePlanExitRequest(event);
      expect(
        useChatStore.getState().worktreeChats[KEY]?.tabs[0]?.pendingPlanExit,
      ).toBeUndefined();
      useChatStore.getState().handleChatStateChanged(
        changeEvent(6, 7, [
          {
            type: 'tab.metadata_patched',
            tabId: 'chat-1',
            patch: {
              pendingPlanExit: { plan: '# v2' },
              pendingPlanExitRequestId: 'new-review',
              latestRevisionNumber: 2,
            },
          },
        ]),
      );
      useChatStore.getState().handlePlanExitRequest(event);
      const tab = useChatStore.getState().worktreeChats[KEY]?.tabs[0];
      expect(tab?.pendingPlanExitRequestId).toBe('new-review');
      expect(tab?.latestRevisionNumber).toBe(2);
      expect(
        useChatStore.getState().pendingPlanExits['old-review'],
      ).toBeUndefined();
    },
  );

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
          blocks: [{ type: 'text', text: 'reply' }],
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

  it('applies every aggregate change in order and ignores a duplicate aggregate', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);

    const aggregate = providerBatchAggregateEvent(5, 6);
    useChatStore.getState().handleChatStateChanged(aggregate);

    const appliedMessages =
      useChatStore.getState().worktreeChats[KEY]?.tabs[0]?.messages;
    expect(appliedMessages?.map((message) => message.id)).toEqual([
      'chat-1-m1',
      'chat-1-m2',
      'chat-1-m3',
    ]);
    expect(
      appliedMessages?.find((message) => message.id === 'chat-1-m2')?.blocks,
    ).toEqual([{ type: 'text', text: 'final aggregate content' }]);
    expect(
      appliedMessages?.find((message) => message.id === 'chat-1-m3')?.blocks,
    ).toEqual([{ type: 'text', text: 'new aggregate row' }]);
    expect(aggregate.changes.map((change) => change.type)).toEqual([
      'message.upserted',
      'message.upserted',
      'message.upserted',
      'runtime.patched',
      'runtime.patched',
      'message.upserted',
    ]);

    useChatStore.getState().handleChatStateChanged(aggregate);
    expect(
      useChatStore.getState().worktreeChats[KEY]?.tabs[0]?.messages,
    ).toEqual(appliedMessages);
    expect(useChatStore.getState().chatStateSync[KEY]).toEqual({
      phase: 'live',
      revision: 6,
    });
  });

  it('does not replay an aggregate already included in the installed snapshot', async () => {
    const { useChatStore } = loadChatStore();
    const finalTab = persistedTab('chat-1', {
      messages: [
        {
          id: 'chat-1-m1',
          role: 'user',
          blocks: [{ type: 'text', text: 'hello there' }],
          timestamp: 1,
        },
        {
          id: 'chat-1-m2',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'final aggregate content' }],
          timestamp: 2,
        },
        {
          id: 'chat-1-m3',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'new aggregate row' }],
          timestamp: 2,
        },
      ],
    });
    getStateMock.mockResolvedValue(snapshot(6, [finalTab], 'chat-1'));
    await useChatStore.getState().loadTabsForTarget('proj', 'wt');
    const snapshotMessages =
      useChatStore.getState().worktreeChats[KEY]?.tabs[0]?.messages;

    useChatStore
      .getState()
      .handleChatStateChanged(providerBatchAggregateEvent(5, 6));

    expect(
      useChatStore.getState().worktreeChats[KEY]?.tabs[0]?.messages,
    ).toEqual(snapshotMessages);
    expect(useChatStore.getState().chatStateSync[KEY]).toEqual({
      phase: 'live',
      revision: 6,
    });
    expect(getStateMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes instead of applying an aggregate across a revision gap', async () => {
    const { useChatStore } = loadChatStore();
    await hydrate(useChatStore);

    const refreshed = deferred<ChatStateSnapshot>();
    getStateMock.mockClear();
    getStateMock.mockReturnValue(refreshed.promise);
    const beforeGap =
      useChatStore.getState().worktreeChats[KEY]?.tabs[0]?.messages;
    useChatStore
      .getState()
      .handleChatStateChanged(providerBatchAggregateEvent(7, 8));

    expect(useChatStore.getState().chatStateSync[KEY]?.phase).toBe(
      'refreshing',
    );
    expect(
      useChatStore.getState().worktreeChats[KEY]?.tabs[0]?.messages,
    ).toEqual(beforeGap);
    expect(getStateMock).toHaveBeenCalledTimes(1);

    refreshed.resolve(snapshot(8, [persistedTab('chat-1')], 'chat-1'));
    await flushMicrotasks();
    expect(useChatStore.getState().chatStateSync[KEY]).toEqual({
      phase: 'live',
      revision: 8,
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

  it.each(PROVIDER_TASK_TYPES)(
    'defers canonical auto-archive while %s is live, then archives when it finishes',
    async (taskType) => {
      const { useChatStore } = loadChatStore();
      const liveTasks = jest.requireActual<
        typeof LiveBackgroundTaskStoreModule
      >('../liveBackgroundTaskStore');
      const revisioned = jest.requireActual<typeof RevisionedChatSyncModule>(
        '../chat/slices/revisioned',
      );
      const dispose = revisioned.installAutoArchiveAfterDelegates();
      try {
        setLiveBackgroundTask(taskType);
        getStateMock.mockResolvedValueOnce(canonicalAutoArchiveSnapshot());
        await useChatStore.getState().loadTabsForTarget('proj', 'wt');
        completeCanonicalTurn(useChatStore);
        await flushMicrotasks();

        expect(archiveTabMock).not.toHaveBeenCalled();
        expect(
          useChatStore
            .getState()
            .worktreeChats[KEY]?.tabs.find((tab) => tab.id === 'chat-1')
            ?.autoArchive,
        ).toBe(true);

        liveTasks.useLiveBackgroundTaskStore.getState().applyPush({
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: 'chat-1',
          sessionActive: true,
          liveTasks: [],
        });
        await flushMicrotasks();

        expect(archiveTabMock).toHaveBeenCalledTimes(1);
      } finally {
        dispose();
      }
    },
  );

  it.each(PROVIDER_TASK_TYPES)(
    'defers legacy auto-archive while %s is live, then archives when it finishes',
    async (taskType) => {
      const { useChatStore } = loadChatStore();
      getStateMock.mockRejectedValue(
        new Error("No handler registered for 'chat:get-state'"),
      );
      loadTabsMock.mockResolvedValue(
        tabsFile(
          [
            persistedTab('chat-1', { autoArchive: true }),
            persistedTab('keeper'),
          ],
          'chat-1',
        ),
      );
      const revisioned = jest.requireActual<typeof RevisionedChatSyncModule>(
        '../chat/slices/revisioned',
      );
      const dispose = revisioned.installAutoArchiveAfterDelegates();
      try {
        setLiveBackgroundTask(taskType);
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
        await flushMicrotasks();

        expect(archiveTabMock).not.toHaveBeenCalled();

        settleLiveBackgroundTask();
        await flushMicrotasks();

        expect(archiveTabMock).toHaveBeenCalledTimes(1);
      } finally {
        dispose();
      }
    },
  );

  it('does not defer auto-archive for shell-only background tasks', async () => {
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
    const revisioned = jest.requireActual<typeof RevisionedChatSyncModule>(
      '../chat/slices/revisioned',
    );
    const dispose = revisioned.installAutoArchiveAfterDelegates();
    try {
      setLiveBackgroundTask('local_bash');
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
      await flushMicrotasks();

      expect(archiveTabMock).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });

  it('waits for both delegates and provider work before canonical auto-archive', async () => {
    const { useChatStore } = loadChatStore();
    const delegations = jest.requireActual<
      typeof DelegationActivityStoreModule
    >('../delegationActivityStore');
    const liveTasks = jest.requireActual<typeof LiveBackgroundTaskStoreModule>(
      '../liveBackgroundTaskStore',
    );
    const revisioned = jest.requireActual<typeof RevisionedChatSyncModule>(
      '../chat/slices/revisioned',
    );
    const dispose = revisioned.installAutoArchiveAfterDelegates();
    try {
      setLiveBackgroundTask('local_agent');
      delegations.useDelegationActivityStore.getState().applyActivity({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat-1',
        live: 1,
        queued: 0,
      });
      getStateMock.mockResolvedValueOnce(canonicalAutoArchiveSnapshot());
      await useChatStore.getState().loadTabsForTarget('proj', 'wt');
      completeCanonicalTurn(useChatStore);
      await flushMicrotasks();
      expect(archiveTabMock).not.toHaveBeenCalled();

      delegations.useDelegationActivityStore.getState().applyActivity({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat-1',
        live: 0,
        queued: 0,
      });
      await flushMicrotasks();
      expect(archiveTabMock).not.toHaveBeenCalled();

      liveTasks.useLiveBackgroundTaskStore.getState().applyPush({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat-1',
        sessionActive: true,
        liveTasks: [],
      });
      await flushMicrotasks();
      expect(archiveTabMock).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });

  it('waits for an unvisited canonical worktree snapshot before auto-archive', async () => {
    const { useChatStore } = loadChatStore();
    const pendingSnapshot = deferred<ActivityLiveBgTasksResponse>();
    const listLiveBgTasks = jest.fn(() => pendingSnapshot.promise);
    installLiveTaskPullBridge(listLiveBgTasks);
    const revisioned = jest.requireActual<typeof RevisionedChatSyncModule>(
      '../chat/slices/revisioned',
    );
    const dispose = revisioned.installAutoArchiveAfterDelegates();
    try {
      getStateMock.mockResolvedValueOnce(canonicalAutoArchiveSnapshot());
      await useChatStore.getState().loadTabsForTarget('proj', 'wt');
      completeCanonicalTurn(useChatStore);
      await flushMicrotasks();

      expect(archiveTabMock).not.toHaveBeenCalled();
      expect(listLiveBgTasks).toHaveBeenCalled();

      pendingSnapshot.resolve({ chats: {} });
      await flushPendingWork();

      expect(archiveTabMock).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });

  it('waits for the first live-task snapshot before recovering a legacy auto-archive', async () => {
    const { useChatStore } = loadChatStore();
    const pendingSnapshot = deferred<ActivityLiveBgTasksResponse>();
    const listLiveBgTasks = jest.fn(() => pendingSnapshot.promise);
    installLiveTaskPullBridge(listLiveBgTasks);
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
      delegations.useDelegationActivityStore.getState().hydrate([]);
      await flushMicrotasks();

      expect(archiveTabMock).not.toHaveBeenCalled();
      expect(listLiveBgTasks).toHaveBeenCalled();

      pendingSnapshot.resolve({
        chats: {
          'chat-1': {
            sessionActive: true,
            liveTasks: [{ taskId: 'task-1', taskType: 'local_workflow' }],
          },
        },
      });
      await flushPendingWork();
      expect(archiveTabMock).not.toHaveBeenCalled();

      settleLiveBackgroundTask();
      await flushPendingWork();
      expect(archiveTabMock).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });

  it('proceeds after a failed live-task pull without retrying on chat changes', async () => {
    const { useChatStore } = loadChatStore();
    const listLiveBgTasks = jest.fn(() =>
      Promise.reject(new Error('live task snapshot unavailable')),
    );
    installLiveTaskPullBridge(listLiveBgTasks);
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
      delegations.useDelegationActivityStore.getState().hydrate([]);
      await flushPendingWork();

      const pullCountAfterFailure = listLiveBgTasks.mock.calls.length;
      expect(pullCountAfterFailure).toBeGreaterThan(0);
      expect(archiveTabMock).toHaveBeenCalledTimes(1);

      useChatStore.setState({
        worktreeChats: { ...useChatStore.getState().worktreeChats },
      });
      await flushMicrotasks();

      expect(listLiveBgTasks).toHaveBeenCalledTimes(pullCountAfterFailure);
      expect(archiveTabMock).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
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
      ...state,
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
      ...state,
      selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
      chatStateSync: {
        ...state.chatStateSync,
        [KEY]: { phase: 'hydrating', revision: 0 },
      },
      worktreeChats: {
        ...state.worktreeChats,
        [KEY]: {
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
});
