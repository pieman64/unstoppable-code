/**
 * The renderer mirror of main's per-chat managed delegation activity: snapshot
 * hydration, live events, removal at 0/0, settled notifications, and
 * resilience to a missing preload bridge.
 */
import type { ChatDelegationActivity } from '@canopy/desktop-shared/types';
import {
  chatDelegationKey,
  initializeDelegationActivityStore,
  resetDelegationActivityStoreForTests,
  selectChatHasLiveDelegates,
  selectWorktreeHasLiveDelegates,
  subscribeChatDelegatesSettled,
  useDelegationActivityStore,
  type ChatDelegationTarget,
} from '../delegationActivityStore';

function activity(
  overrides: Partial<ChatDelegationActivity> = {},
): ChatDelegationActivity {
  return {
    projectId: 'proj',
    worktreeId: 'wt',
    chatId: 'chat-1',
    live: 1,
    queued: 0,
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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

interface FakeBridge {
  listActivity: jest.Mock<Promise<ChatDelegationActivity[]>, []>;
  onActivityChanged: jest.Mock<
    () => void,
    [(activity: ChatDelegationActivity) => void]
  >;
  emit: (activity: ChatDelegationActivity) => void;
  unsubscribe: jest.Mock<void, []>;
}

function installBridge(
  listActivity: () => Promise<ChatDelegationActivity[]>,
): FakeBridge {
  let listener: ((activity: ChatDelegationActivity) => void) | null = null;
  const unsubscribe = jest.fn<void, []>();
  const bridge: FakeBridge = {
    listActivity: jest.fn(listActivity),
    onActivityChanged: jest.fn((cb) => {
      listener = cb;
      return unsubscribe;
    }),
    emit: (next) => listener?.(next),
    unsubscribe,
  };
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: {
      api: {
        managedDelegation: {
          listActivity: bridge.listActivity,
          onActivityChanged: bridge.onActivityChanged,
        },
      },
    },
  });
  return bridge;
}

afterEach(() => {
  resetDelegationActivityStoreForTests();
  Reflect.deleteProperty(global, 'window');
});

describe('delegationActivityStore', () => {
  it('keys chats by project, worktree and chat', () => {
    expect(chatDelegationKey('proj', 'wt', 'chat-1')).toBe('proj/wt/chat-1');
  });

  it('hydrates live chats from the snapshot and drops idle ones', () => {
    useDelegationActivityStore
      .getState()
      .hydrate([
        activity(),
        activity({ chatId: 'chat-2', live: 0, queued: 2 }),
        activity({ chatId: 'idle', live: 0, queued: 0 }),
      ]);

    const state = useDelegationActivityStore.getState();
    expect(state.hydrated).toBe(true);
    expect(Object.keys(state.byChat).sort()).toEqual([
      'proj/wt/chat-1',
      'proj/wt/chat-2',
    ]);
    expect(selectChatHasLiveDelegates(state, 'proj', 'wt', 'chat-1')).toBe(
      true,
    );
    // Queued-only delegations count as live work.
    expect(selectChatHasLiveDelegates(state, 'proj', 'wt', 'chat-2')).toBe(
      true,
    );
    expect(selectChatHasLiveDelegates(state, 'proj', 'wt', 'idle')).toBe(false);
    expect(selectWorktreeHasLiveDelegates(state, 'proj', 'wt')).toBe(true);
    expect(selectWorktreeHasLiveDelegates(state, 'proj', 'other')).toBe(false);
  });

  it('applies events and removes a chat when its count reaches 0/0', () => {
    const settled: ChatDelegationTarget[] = [];
    subscribeChatDelegatesSettled((target) => settled.push(target));
    const store = useDelegationActivityStore.getState();

    store.applyActivity(activity({ live: 1, queued: 1 }));
    expect(
      useDelegationActivityStore.getState().byChat['proj/wt/chat-1'],
    ).toMatchObject({ live: 1, queued: 1 });

    store.applyActivity(activity({ live: 2, queued: 0 }));
    expect(
      useDelegationActivityStore.getState().byChat['proj/wt/chat-1'],
    ).toMatchObject({ live: 2, queued: 0 });
    expect(settled).toEqual([]);

    store.applyActivity(activity({ live: 0, queued: 0 }));
    expect(useDelegationActivityStore.getState().byChat).toEqual({});
    expect(settled).toEqual([
      { projectId: 'proj', worktreeId: 'wt', chatId: 'chat-1' },
    ]);

    // A 0/0 for a chat that was never live is not a settle.
    store.applyActivity(activity({ chatId: 'other', live: 0, queued: 0 }));
    expect(settled).toHaveLength(1);
  });

  it('reports chats missing from a fresh snapshot as settled', () => {
    const settled: ChatDelegationTarget[] = [];
    subscribeChatDelegatesSettled((target) => settled.push(target));
    const store = useDelegationActivityStore.getState();
    store.hydrate([activity(), activity({ chatId: 'chat-2' })]);

    store.hydrate([activity({ chatId: 'chat-2' })]);

    expect(settled).toEqual([
      { projectId: 'proj', worktreeId: 'wt', chatId: 'chat-1' },
    ]);
  });

  it('hydrates from the bridge, replays events that raced the snapshot, then follows live events', async () => {
    const snapshot = deferred<ChatDelegationActivity[]>();
    const bridge = installBridge(() => snapshot.promise);

    const dispose = initializeDelegationActivityStore();
    expect(bridge.listActivity).toHaveBeenCalledTimes(1);
    // Idempotent while installed.
    initializeDelegationActivityStore();
    expect(bridge.listActivity).toHaveBeenCalledTimes(1);

    // The event lands before the snapshot; it must survive the hydrate.
    bridge.emit(activity({ chatId: 'chat-2', live: 1 }));
    expect(useDelegationActivityStore.getState().byChat).toEqual({});

    snapshot.resolve([activity()]);
    await flushMicrotasks();
    expect(
      Object.keys(useDelegationActivityStore.getState().byChat).sort(),
    ).toEqual(['proj/wt/chat-1', 'proj/wt/chat-2']);

    bridge.emit(activity({ live: 0, queued: 0 }));
    expect(Object.keys(useDelegationActivityStore.getState().byChat)).toEqual([
      'proj/wt/chat-2',
    ]);

    dispose();
    expect(bridge.unsubscribe).toHaveBeenCalledTimes(1);
    bridge.emit(activity({ chatId: 'chat-3' }));
    expect(
      useDelegationActivityStore.getState().byChat['proj/wt/chat-3'],
    ).toBeUndefined();
  });

  it('degrades to live events when the snapshot fails', async () => {
    const bridge = installBridge(() =>
      Promise.reject(new Error('bridge unavailable')),
    );
    initializeDelegationActivityStore();
    await flushMicrotasks();

    expect(useDelegationActivityStore.getState().hydrated).toBe(true);
    bridge.emit(activity());
    expect(
      selectChatHasLiveDelegates(
        useDelegationActivityStore.getState(),
        'proj',
        'wt',
        'chat-1',
      ),
    ).toBe(true);
  });

  it('is a no-op without the preload bridge', () => {
    Object.defineProperty(global, 'window', {
      configurable: true,
      value: { api: {} },
    });
    expect(() => initializeDelegationActivityStore()()).not.toThrow();
    expect(useDelegationActivityStore.getState().hydrated).toBe(false);
  });
});
