/**
 * The renderer mirror of main's live provider background-task set: per-chat
 * pushes, worktree pulls that replay pushes received in flight over a stale
 * snapshot, removal of chats without a session, and the push handoff.
 */
import type {
  ActivityLiveBgTasksChangedEvent,
  ActivityLiveBgTasksRequest,
  ActivityLiveBgTasksResponse,
} from '@canopy/desktop-shared/types';
import {
  chatProviderBlocksClose,
  initializeLiveBackgroundTaskStore,
  isWorktreeLiveTasksHydrated,
  liveBackgroundTaskKey,
  resetLiveBackgroundTaskStoreForTests,
  selectChatProviderBlocksClose,
  selectChildToolLiveness,
  selectWorkspaceProviderBlocksClose,
  selectWorktreeProviderBlocksClose,
  setLiveBackgroundTaskPushHandler,
  subscribeChatProviderWorkSettled,
  useLiveBackgroundTaskStore,
  type LiveBackgroundTaskChatEntry,
} from '../liveBackgroundTaskStore';

function push(
  overrides: Partial<ActivityLiveBgTasksChangedEvent> = {},
): ActivityLiveBgTasksChangedEvent {
  return {
    projectId: 'proj',
    worktreeId: 'wt',
    chatId: 'chat-1',
    sessionActive: true,
    liveTasks: [{ taskId: 'task-1', toolUseId: 'tool-1' }],
    ...overrides,
  };
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

interface FakeBridge {
  listLiveBgTasks: jest.Mock<
    Promise<ActivityLiveBgTasksResponse>,
    [ActivityLiveBgTasksRequest]
  >;
  emit: (event: ActivityLiveBgTasksChangedEvent) => void;
  unsubscribe: jest.Mock<void, []>;
}

function installBridge(
  listLiveBgTasks: () => Promise<ActivityLiveBgTasksResponse> = () =>
    Promise.resolve({ chats: {} }),
): FakeBridge {
  let listener: ((event: ActivityLiveBgTasksChangedEvent) => void) | null =
    null;
  const unsubscribe = jest.fn<void, []>();
  const bridge: FakeBridge = {
    listLiveBgTasks: jest.fn<
      Promise<ActivityLiveBgTasksResponse>,
      [ActivityLiveBgTasksRequest]
    >(() => listLiveBgTasks()),
    emit: (event) => listener?.(event),
    unsubscribe,
  };
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: {
      api: {
        activity: {
          listLiveBgTasks: bridge.listLiveBgTasks,
          onLiveBgTasksChanged: jest.fn(
            (cb: (event: ActivityLiveBgTasksChangedEvent) => void) => {
              listener = cb;
              return unsubscribe;
            },
          ),
        },
      },
    },
  });
  return bridge;
}

afterEach(() => {
  resetLiveBackgroundTaskStoreForTests();
  setLiveBackgroundTaskPushHandler(null);
  Reflect.deleteProperty(global, 'window');
});

describe('liveBackgroundTaskStore', () => {
  it('keys chats by project, worktree and chat', () => {
    expect(liveBackgroundTaskKey('proj', 'wt', 'chat-1')).toBe(
      'proj/wt/chat-1',
    );
  });

  it('replaces one chat per push, returns the previous entry and removes no-session chats', () => {
    const store = useLiveBackgroundTaskStore.getState();

    expect(store.applyPush(push())).toBeUndefined();
    const first =
      useLiveBackgroundTaskStore.getState().byChat['proj/wt/chat-1'];
    expect(first).toEqual({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      sessionActive: true,
      liveTasks: [{ taskId: 'task-1', toolUseId: 'tool-1' }],
    });

    const previous = store.applyPush(
      push({ liveTasks: [{ taskId: 'task-2' }] }),
    );
    expect(previous).toBe(first);
    expect(
      useLiveBackgroundTaskStore.getState().byChat['proj/wt/chat-1']?.liveTasks,
    ).toEqual([{ taskId: 'task-2' }]);

    const beforeEnd =
      useLiveBackgroundTaskStore.getState().byChat['proj/wt/chat-1'];
    expect(store.applyPush(push({ sessionActive: false, liveTasks: [] }))).toBe(
      beforeEnd,
    );
    expect(useLiveBackgroundTaskStore.getState().byChat).toEqual({});
  });

  it('keeps entry and record identity for an unchanged push', () => {
    const store = useLiveBackgroundTaskStore.getState();
    store.applyPush(push());
    const byChat = useLiveBackgroundTaskStore.getState().byChat;

    store.applyPush(push());

    expect(useLiveBackgroundTaskStore.getState().byChat).toBe(byChat);
  });

  it('hydrates a worktree from the pull and returns the merged record', async () => {
    installBridge(() =>
      Promise.resolve({
        chats: {
          'chat-1': {
            sessionActive: true,
            liveTasks: [{ taskId: 'task-1', taskType: 'local_agent' }],
          },
          'chat-2': { sessionActive: true, liveTasks: [] },
        },
      }),
    );

    const result = await useLiveBackgroundTaskStore
      .getState()
      .refreshWorktree('proj', 'wt');

    expect(result).toEqual({
      chats: {
        'chat-1': {
          sessionActive: true,
          liveTasks: [{ taskId: 'task-1', taskType: 'local_agent' }],
        },
        'chat-2': { sessionActive: true, liveTasks: [] },
      },
    });
    expect(
      Object.keys(useLiveBackgroundTaskStore.getState().byChat).sort(),
    ).toEqual(['proj/wt/chat-1', 'proj/wt/chat-2']);
  });

  it('removes chats of the worktree absent from the snapshot and keeps other worktrees', async () => {
    const store = useLiveBackgroundTaskStore.getState();
    store.applyPush(push({ chatId: 'gone' }));
    store.applyPush(push({ worktreeId: 'other', chatId: 'elsewhere' }));
    installBridge(() =>
      Promise.resolve({
        chats: { 'chat-1': { sessionActive: true, liveTasks: [] } },
      }),
    );

    await store.refreshWorktree('proj', 'wt');

    expect(
      Object.keys(useLiveBackgroundTaskStore.getState().byChat).sort(),
    ).toEqual(['proj/other/elsewhere', 'proj/wt/chat-1']);
  });

  it('replays pushes received during the pull over a stale snapshot', async () => {
    const pull = deferred<ActivityLiveBgTasksResponse>();
    installBridge(() => pull.promise);
    const store = useLiveBackgroundTaskStore.getState();

    const refreshing = store.refreshWorktree('proj', 'wt');
    // Newer than the snapshot: chat-1's task ended, chat-2's session ended,
    // and chat-3 started a task the snapshot never saw.
    store.applyPush(push({ liveTasks: [] }));
    store.applyPush(
      push({ chatId: 'chat-2', sessionActive: false, liveTasks: [] }),
    );
    store.applyPush(push({ chatId: 'chat-3', liveTasks: [{ taskId: 't3' }] }));
    // Pushes are applied as they arrive, not only after the pull.
    expect(
      useLiveBackgroundTaskStore.getState().byChat['proj/wt/chat-3'],
    ).toBeDefined();
    pull.resolve({
      chats: {
        'chat-1': { sessionActive: true, liveTasks: [{ taskId: 'task-1' }] },
        'chat-2': { sessionActive: true, liveTasks: [{ taskId: 'task-2' }] },
      },
    });
    const result = await refreshing;

    expect(result).toEqual({
      chats: {
        'chat-1': { sessionActive: true, liveTasks: [] },
        'chat-3': { sessionActive: true, liveTasks: [{ taskId: 't3' }] },
      },
    });
    const byChat = useLiveBackgroundTaskStore.getState().byChat;
    expect(Object.keys(byChat).sort()).toEqual([
      'proj/wt/chat-1',
      'proj/wt/chat-3',
    ]);
    expect(byChat['proj/wt/chat-1']?.liveTasks).toEqual([]);
  });

  it('applies the snapshot and buffered pushes in one update', async () => {
    const pull = deferred<ActivityLiveBgTasksResponse>();
    installBridge(() => pull.promise);
    const store = useLiveBackgroundTaskStore.getState();
    const refreshing = store.refreshWorktree('proj', 'wt');
    store.applyPush(push({ liveTasks: [] }));
    const updates = jest.fn();
    const unsubscribe = useLiveBackgroundTaskStore.subscribe(updates);

    pull.resolve({
      chats: {
        'chat-1': { sessionActive: true, liveTasks: [{ taskId: 'task-1' }] },
        'chat-2': { sessionActive: true, liveTasks: [] },
      },
    });
    await refreshing;
    unsubscribe();

    expect(updates).toHaveBeenCalledTimes(1);
  });

  it('resolves null without the bridge or when the pull fails, leaving the mirror alone', async () => {
    const store = useLiveBackgroundTaskStore.getState();
    store.applyPush(push());
    const before = useLiveBackgroundTaskStore.getState().byChat;

    await expect(store.refreshWorktree('proj', 'wt')).resolves.toBeNull();

    installBridge(() => Promise.reject(new Error('ipc failed')));
    await expect(store.refreshWorktree('proj', 'wt')).resolves.toBeNull();
    expect(useLiveBackgroundTaskStore.getState().byChat).toBe(before);
  });

  it('applies each push, then hands previous and next to the handler', () => {
    const bridge = installBridge();
    const calls: Array<{
      previous: LiveBackgroundTaskChatEntry | undefined;
      next: ActivityLiveBgTasksChangedEvent;
      mirrored: LiveBackgroundTaskChatEntry | undefined;
    }> = [];
    setLiveBackgroundTaskPushHandler((previous, next) => {
      calls.push({
        previous,
        next,
        mirrored:
          useLiveBackgroundTaskStore.getState().byChat['proj/wt/chat-1'],
      });
    });

    const dispose = initializeLiveBackgroundTaskStore();
    expect(initializeLiveBackgroundTaskStore()).toBe(dispose);
    const first = push();
    bridge.emit(first);
    const second = push({ sessionActive: false, liveTasks: [] });
    bridge.emit(second);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.previous).toBeUndefined();
    expect(calls[0]?.next).toBe(first);
    expect(calls[0]?.mirrored?.liveTasks).toEqual(first.liveTasks);
    expect(calls[1]?.previous).toBe(calls[0]?.mirrored);
    expect(calls[1]?.next).toBe(second);
    expect(calls[1]?.mirrored).toBeUndefined();

    dispose();
    expect(bridge.unsubscribe).toHaveBeenCalledTimes(1);
    bridge.emit(push());
    expect(calls).toHaveLength(2);
  });

  it('keeps the mirror current when the handler throws', () => {
    const bridge = installBridge();
    setLiveBackgroundTaskPushHandler(() => {
      throw new Error('consumer failed');
    });
    initializeLiveBackgroundTaskStore();

    expect(() => bridge.emit(push())).not.toThrow();
    expect(
      useLiveBackgroundTaskStore.getState().byChat['proj/wt/chat-1'],
    ).toBeDefined();
  });

  it('is a no-op without the push bridge', () => {
    Object.defineProperty(global, 'window', {
      configurable: true,
      value: { api: { activity: {} } },
    });
    const dispose = initializeLiveBackgroundTaskStore();
    expect(() => dispose()).not.toThrow();
    expect(useLiveBackgroundTaskStore.getState().byChat).toEqual({});
  });
});

describe('liveBackgroundTaskStore hydration tracking', () => {
  it('marks a worktree hydrated only once its pull succeeds', async () => {
    const bridge = installBridge(() => Promise.reject(new Error('ipc failed')));
    const store = useLiveBackgroundTaskStore.getState();
    expect(isWorktreeLiveTasksHydrated('proj', 'wt')).toBe(false);

    await store.refreshWorktree('proj', 'wt');
    expect(isWorktreeLiveTasksHydrated('proj', 'wt')).toBe(false);

    bridge.listLiveBgTasks.mockImplementation(() =>
      Promise.resolve({ chats: {} }),
    );
    await store.refreshWorktree('proj', 'wt');
    expect(isWorktreeLiveTasksHydrated('proj', 'wt')).toBe(true);
    expect(useLiveBackgroundTaskStore.getState().hydratedWorktrees).toEqual({
      'proj/wt': true,
    });
    expect(isWorktreeLiveTasksHydrated('proj', 'other')).toBe(false);
  });

  it('treats every worktree as hydrated without the pull bridge', () => {
    expect(isWorktreeLiveTasksHydrated('proj', 'wt')).toBe(true);
  });

  it('pulls only unhydrated worktrees, once each, and resolves after them', async () => {
    const pull = deferred<ActivityLiveBgTasksResponse>();
    const bridge = installBridge(() => pull.promise);
    const store = useLiveBackgroundTaskStore.getState();
    useLiveBackgroundTaskStore.setState({
      hydratedWorktrees: { 'proj/done': true },
    });

    let settled = false;
    const ensuring = store
      .ensureWorktreesHydrated([
        { projectId: 'proj', worktreeId: 'wt' },
        { projectId: 'proj', worktreeId: 'wt' },
        { projectId: 'proj', worktreeId: 'done' },
      ])
      .then(() => {
        settled = true;
      });
    // A concurrent caller joins the in-flight pull instead of starting one.
    const joining = store.ensureWorktreesHydrated([
      { projectId: 'proj', worktreeId: 'wt' },
    ]);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(bridge.listLiveBgTasks).toHaveBeenCalledTimes(1);
    expect(bridge.listLiveBgTasks).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt',
    });

    pull.resolve({
      chats: {
        'chat-1': {
          sessionActive: true,
          liveTasks: [{ taskId: 'a', taskType: 'local_agent' }],
        },
      },
    });
    await Promise.all([ensuring, joining]);
    expect(settled).toBe(true);
    expect(
      selectChatProviderBlocksClose(
        useLiveBackgroundTaskStore.getState(),
        'proj',
        'wt',
        'chat-1',
      ),
    ).toBe(true);

    await store.ensureWorktreesHydrated([
      { projectId: 'proj', worktreeId: 'wt' },
    ]);
    expect(bridge.listLiveBgTasks).toHaveBeenCalledTimes(1);
  });

  it('resolves even when a pull fails', async () => {
    installBridge(() => Promise.reject(new Error('ipc failed')));
    await expect(
      useLiveBackgroundTaskStore
        .getState()
        .ensureWorktreesHydrated([{ projectId: 'proj', worktreeId: 'wt' }]),
    ).resolves.toBeUndefined();
    expect(isWorktreeLiveTasksHydrated('proj', 'wt')).toBe(false);
  });

  it('forgets hydration on reset', async () => {
    installBridge();
    await useLiveBackgroundTaskStore.getState().refreshWorktree('proj', 'wt');
    resetLiveBackgroundTaskStoreForTests();
    expect(useLiveBackgroundTaskStore.getState().hydratedWorktrees).toEqual({});
  });
});

describe('liveBackgroundTaskStore close-blocking selectors', () => {
  function seed(
    chatId: string,
    taskTypes: ReadonlyArray<string | undefined>,
    worktreeId = 'wt',
    projectId = 'proj',
  ): void {
    useLiveBackgroundTaskStore.getState().applyPush(
      push({
        projectId,
        worktreeId,
        chatId,
        liveTasks: taskTypes.map((taskType, index) => ({
          taskId: `${chatId}-${index}`,
          ...(taskType === undefined ? {} : { taskType }),
        })),
      }),
    );
  }

  it.each(['local_agent', 'local_workflow', 'remote_agent'])(
    'blocks close for a live %s',
    (taskType) => {
      seed('chat-1', ['local_bash', taskType]);
      const state = useLiveBackgroundTaskStore.getState();
      expect(selectChatProviderBlocksClose(state, 'proj', 'wt', 'chat-1')).toBe(
        true,
      );
      expect(selectWorktreeProviderBlocksClose(state, 'proj', 'wt')).toBe(true);
      expect(selectWorkspaceProviderBlocksClose(state, 'proj')).toBe(true);
      expect(chatProviderBlocksClose('proj', 'wt', 'chat-1')).toBe(true);
    },
  );

  it('never blocks for shells, MCP tasks or tasks without a type', () => {
    seed('chat-1', ['local_bash', 'mcp_task', undefined]);
    const state = useLiveBackgroundTaskStore.getState();
    expect(selectChatProviderBlocksClose(state, 'proj', 'wt', 'chat-1')).toBe(
      false,
    );
    expect(selectWorktreeProviderBlocksClose(state, 'proj', 'wt')).toBe(false);
    expect(selectWorkspaceProviderBlocksClose(state, 'proj')).toBe(false);
  });

  it('scopes each selector to its chat, worktree and workspace', () => {
    seed('chat-2', ['local_agent'], 'other');
    const state = useLiveBackgroundTaskStore.getState();
    expect(selectChatProviderBlocksClose(state, 'proj', 'wt', 'chat-2')).toBe(
      false,
    );
    expect(selectWorktreeProviderBlocksClose(state, 'proj', 'wt')).toBe(false);
    expect(selectWorktreeProviderBlocksClose(state, 'proj', 'other')).toBe(
      true,
    );
    expect(selectWorkspaceProviderBlocksClose(state, 'proj')).toBe(true);
    expect(selectWorkspaceProviderBlocksClose(state, 'elsewhere')).toBe(false);
  });
});

describe('selectChildToolLiveness', () => {
  it('is unknown until the worktree snapshot was applied', () => {
    installBridge();
    useLiveBackgroundTaskStore.getState().applyPush(push());
    expect(
      selectChildToolLiveness(
        useLiveBackgroundTaskStore.getState(),
        'proj',
        'wt',
        'chat-1',
      ),
    ).toEqual({ kind: 'unknown' });
  });

  it('is no-live-session for a hydrated worktree without the chat', async () => {
    installBridge();
    await useLiveBackgroundTaskStore.getState().refreshWorktree('proj', 'wt');
    expect(
      selectChildToolLiveness(
        useLiveBackgroundTaskStore.getState(),
        'proj',
        'wt',
        'chat-1',
      ),
    ).toEqual({ kind: 'no-live-session' });
  });

  it('lists the tool use ids of every live task, whatever its type', async () => {
    installBridge(() =>
      Promise.resolve({
        chats: {
          'chat-1': {
            sessionActive: true,
            liveTasks: [
              { taskId: 'a', toolUseId: 'tool-a', taskType: 'local_agent' },
              { taskId: 'b', toolUseId: 'tool-b', taskType: 'local_bash' },
              { taskId: 'c', toolUseId: 'tool-c' },
            ],
          },
        },
      }),
    );
    await useLiveBackgroundTaskStore.getState().refreshWorktree('proj', 'wt');
    expect(
      selectChildToolLiveness(
        useLiveBackgroundTaskStore.getState(),
        'proj',
        'wt',
        'chat-1',
      ),
    ).toEqual({
      kind: 'known',
      liveParentToolUseIds: ['tool-a', 'tool-b', 'tool-c'],
      hasUncorrelatedLiveTask: false,
    });
  });

  it('reports a live task without a tool use id as uncorrelated', () => {
    // Without the pull bridge pushes are all the mirror knows: hydrated.
    useLiveBackgroundTaskStore.getState().applyPush(
      push({
        liveTasks: [
          { taskId: 'a', toolUseId: 'tool-a' },
          { taskId: 'b', taskType: 'mcp_task' },
        ],
      }),
    );
    expect(
      selectChildToolLiveness(
        useLiveBackgroundTaskStore.getState(),
        'proj',
        'wt',
        'chat-1',
      ),
    ).toEqual({
      kind: 'known',
      liveParentToolUseIds: ['tool-a'],
      hasUncorrelatedLiveTask: true,
    });
    expect(
      selectChildToolLiveness(
        useLiveBackgroundTaskStore.getState(),
        'proj',
        'wt',
        'chat-2',
      ),
    ).toEqual({ kind: 'no-live-session' });
  });
});

describe('subscribeChatProviderWorkSettled', () => {
  it('fires when a push ends a chat’s close-blocking work, not for shells', () => {
    const settled = jest.fn();
    const unsubscribe = subscribeChatProviderWorkSettled(settled);
    const store = useLiveBackgroundTaskStore.getState();

    store.applyPush(
      push({ liveTasks: [{ taskId: 'b', taskType: 'local_bash' }] }),
    );
    store.applyPush(push({ liveTasks: [] }));
    expect(settled).not.toHaveBeenCalled();

    store.applyPush(
      push({ liveTasks: [{ taskId: 'a', taskType: 'local_workflow' }] }),
    );
    expect(settled).not.toHaveBeenCalled();
    store.applyPush(
      push({ liveTasks: [{ taskId: 'b', taskType: 'local_bash' }] }),
    );
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
    });
    // The listener reads the already-updated mirror.
    expect(chatProviderBlocksClose('proj', 'wt', 'chat-1')).toBe(false);

    store.applyPush(
      push({ liveTasks: [{ taskId: 'a', taskType: 'local_agent' }] }),
    );
    store.applyPush(push({ sessionActive: false, liveTasks: [] }));
    expect(settled).toHaveBeenCalledTimes(2);

    unsubscribe();
    store.applyPush(
      push({ liveTasks: [{ taskId: 'a', taskType: 'local_agent' }] }),
    );
    store.applyPush(push({ liveTasks: [] }));
    expect(settled).toHaveBeenCalledTimes(2);
  });

  it('fires when a snapshot drops a chat’s close-blocking work', async () => {
    const store = useLiveBackgroundTaskStore.getState();
    store.applyPush(
      push({ liveTasks: [{ taskId: 'a', taskType: 'local_agent' }] }),
    );
    store.applyPush(
      push({
        chatId: 'chat-2',
        liveTasks: [{ taskId: 'c', taskType: 'local_agent' }],
      }),
    );
    installBridge(() =>
      Promise.resolve({
        chats: {
          'chat-2': {
            sessionActive: true,
            liveTasks: [{ taskId: 'c', taskType: 'local_agent' }],
          },
        },
      }),
    );
    const settled = jest.fn();
    subscribeChatProviderWorkSettled(settled);

    await store.refreshWorktree('proj', 'wt');

    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
    });
  });

  it('keeps notifying the others when one listener throws', () => {
    const settled = jest.fn();
    subscribeChatProviderWorkSettled(() => {
      throw new Error('listener failed');
    });
    subscribeChatProviderWorkSettled(settled);
    const store = useLiveBackgroundTaskStore.getState();
    store.applyPush(
      push({ liveTasks: [{ taskId: 'a', taskType: 'local_agent' }] }),
    );
    expect(() => store.applyPush(push({ liveTasks: [] }))).not.toThrow();
    expect(settled).toHaveBeenCalledTimes(1);
  });
});
