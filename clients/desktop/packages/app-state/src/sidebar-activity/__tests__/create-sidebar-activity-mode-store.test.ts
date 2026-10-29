import { CLIENT_STORE_DISPOSE } from '../../client-store-lifecycle';
import { createSidebarActivityModeStore } from '../create-sidebar-activity-mode-store';
import {
  SIDEBAR_ACTIVITY_UNREPLIED_PAGE_SIZE,
  type SidebarActivityBuildInput,
} from '../sidebar-activity-mode-model';

function inputWithUnreplied(count: number): SidebarActivityBuildInput {
  return {
    inventory: {
      workspaces: [{ localId: 'ws', name: 'W', type: 'single-repo' }],
      worktrees: [{ localId: 'wt', workspaceLocalId: 'ws', branch: 'main' }],
      standaloneChats: [],
      chatSummaries: Array.from({ length: count }, (_, index) => ({
        chatId: `chat-${String(index).padStart(3, '0')}`,
        scope: 'worktree' as const,
        workspaceLocalId: 'ws',
        worktreeLocalId: 'wt',
        title: `Chat ${index}`,
        lastMessageRole: 'assistant' as const,
        lastMessageAt: new Date(
          Date.UTC(2026, 0, 1, 0, 0, count - index),
        ).toISOString(),
      })),
    },
  };
}

interface Deferred {
  readonly promise: Promise<SidebarActivityBuildInput>;
  readonly resolve: (value: SidebarActivityBuildInput) => void;
  readonly reject: (error: Error) => void;
}

function deferred(): Deferred {
  let resolve: Deferred['resolve'] = () => undefined;
  let reject: Deferred['reject'] = () => undefined;
  const promise = new Promise<SidebarActivityBuildInput>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe('createSidebarActivityModeStore', () => {
  it('enters loading at once and builds exactly once on success', async () => {
    const store = createSidebarActivityModeStore();
    const load = jest.fn(() => Promise.resolve(inputWithUnreplied(3)));
    store.getState().enable(load, 's1');
    expect(store.getState()).toMatchObject({
      enabled: true,
      status: 'loading',
      snapshot: null,
    });
    await flush();
    expect(store.getState().status).toBe('ready');
    expect(store.getState().snapshot?.unreplied).toHaveLength(3);
    store.getState().enable(load, 's1');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('ignores duplicate enable while loading', () => {
    const store = createSidebarActivityModeStore();
    const load = jest.fn(() => deferred().promise);
    store.getState().enable(load, 's1');
    store.getState().enable(load, 's1');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('toggle while loading disables and the late result is dropped', async () => {
    const store = createSidebarActivityModeStore();
    const pending = deferred();
    store.getState().toggle(() => pending.promise, 's1');
    store.getState().toggle(() => pending.promise, 's1');
    expect(store.getState()).toMatchObject({ enabled: false, status: 'idle' });
    pending.resolve(inputWithUnreplied(1));
    await flush();
    expect(store.getState()).toMatchObject({ enabled: false, snapshot: null });
  });

  it('rapid on/off/on keeps only the newest load', async () => {
    const store = createSidebarActivityModeStore();
    const first = deferred();
    const second = deferred();
    store.getState().toggle(() => first.promise, 's1');
    store.getState().toggle(() => first.promise, 's1');
    store.getState().toggle(() => second.promise, 's1');
    first.resolve(inputWithUnreplied(5));
    await flush();
    expect(store.getState().status).toBe('loading');
    second.resolve(inputWithUnreplied(2));
    await flush();
    expect(store.getState().snapshot?.unreplied).toHaveLength(2);
  });

  it('drops a stale rejection after a newer cycle starts', async () => {
    const store = createSidebarActivityModeStore();
    const first = deferred();
    store.getState().toggle(() => first.promise, 's1');
    store.getState().disable();
    store.getState().enable(() => Promise.resolve(inputWithUnreplied(1)), 's1');
    first.reject(new Error('late'));
    await flush();
    expect(store.getState().status).toBe('ready');
  });

  it('reports errors and retries with the same loader', async () => {
    const store = createSidebarActivityModeStore();
    const load = jest
      .fn<Promise<SidebarActivityBuildInput>, []>()
      .mockRejectedValueOnce(new Error('partial'))
      .mockResolvedValueOnce(inputWithUnreplied(1));
    store.getState().enable(load, 's1');
    await flush();
    expect(store.getState()).toMatchObject({ enabled: true, status: 'error' });
    store.getState().retry();
    expect(store.getState().status).toBe('loading');
    await flush();
    expect(store.getState().status).toBe('ready');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('treats a synchronous loader throw as an error', async () => {
    const store = createSidebarActivityModeStore();
    store.getState().enable(() => {
      throw new Error('boom');
    }, 's1');
    await flush();
    expect(store.getState().status).toBe('error');
  });

  it('enable for a new session restarts the cycle', async () => {
    const store = createSidebarActivityModeStore();
    const first = deferred();
    store.getState().enable(() => first.promise, 's1');
    store.getState().enable(() => Promise.resolve(inputWithUnreplied(1)), 's2');
    first.resolve(inputWithUnreplied(4));
    await flush();
    expect(store.getState().sessionKey).toBe('s2');
    expect(store.getState().snapshot?.unreplied).toHaveLength(1);
  });

  it('disposal invalidates pending work and resets', async () => {
    const store = createSidebarActivityModeStore();
    const pending = deferred();
    store.getState().enable(() => pending.promise, 's1');
    store[CLIENT_STORE_DISPOSE]?.();
    pending.resolve(inputWithUnreplied(1));
    await flush();
    expect(store.getState()).toMatchObject({
      enabled: false,
      status: 'idle',
      snapshot: null,
      sessionKey: null,
    });
  });

  it.each([
    [0, [0]],
    [49, [49]],
    [50, [50]],
    [51, [50, 51]],
    [100, [50, 100]],
    [101, [50, 100, 101]],
  ])('pages %i unreplied rows as %j', async (total, steps) => {
    const store = createSidebarActivityModeStore();
    store
      .getState()
      .enable(() => Promise.resolve(inputWithUnreplied(total)), 's1');
    await flush();
    const seen = [store.getState().unrepliedVisible];
    const firstPage = store.getState().snapshot?.unreplied.slice(0, seen[0]);
    for (let index = 1; index < steps.length + 1; index += 1) {
      store.getState().showMore();
      seen.push(store.getState().unrepliedVisible);
    }
    expect(seen.slice(0, steps.length)).toEqual(steps);
    // One more Show more past the end changes nothing.
    expect(seen[steps.length]).toBe(steps[steps.length - 1]);
    // Earlier rows keep their order and identity.
    expect(store.getState().snapshot?.unreplied.slice(0, seen[0])).toEqual(
      firstPage,
    );
    expect(SIDEBAR_ACTIVITY_UNREPLIED_PAGE_SIZE).toBe(50);
  });

  it('show more does nothing unless ready', () => {
    const store = createSidebarActivityModeStore();
    store.getState().showMore();
    expect(store.getState().unrepliedVisible).toBe(0);
  });

  it('keeps membership frozen while live inputs change', async () => {
    const store = createSidebarActivityModeStore();
    const base = inputWithUnreplied(2);
    const summaries = [...base.inventory.chatSummaries];
    store.getState().enable(
      () =>
        Promise.resolve({
          inventory: { ...base.inventory, chatSummaries: summaries },
        }),
      's1',
    );
    await flush();
    const snapshot = store.getState().snapshot;
    // Host collections changing afterwards must not reach the frozen snapshot.
    summaries.length = 0;
    expect(store.getState().snapshot).toBe(snapshot);
    expect(snapshot?.unreplied).toHaveLength(2);
  });
});
