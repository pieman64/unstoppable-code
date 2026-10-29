/** @jest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
  writable: true,
});
import type { ChatInterestChatRef } from '@canopy/desktop-shared/types';
import {
  endChatIntent,
  noteChatIntent,
  startChatPrefetch,
  useChatPrefetch,
  type ChatPrefetchHost,
  type ChatPrefetchTarget,
} from '../chat-prefetch';
import { fromPersistedTab } from '../persisted-tabs';
import type { ChatState } from '../state';

function target(chatId = 'a', worktreeId = 'w'): ChatPrefetchTarget {
  return { kind: 'chat', projectId: 'p', worktreeId, chatId };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function tick(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

interface Harness {
  host: ChatPrefetchHost;
  state: ReturnType<ChatPrefetchHost['getState']>;
  read: jest.Mock<Promise<void>, [ChatInterestChatRef, () => Promise<void>]>;
  warmUp: jest.Mock<Promise<void>, [ChatInterestChatRef]>;
  hydrate: jest.Mock<ReturnType<ChatPrefetchHost['hydrate']>, [string, string]>;
  flush: jest.Mock<Promise<void>, []>;
  stop: () => void;
  setFocused: (refs: ChatInterestChatRef[]) => void;
  idle: () => Promise<void>;
  notify: () => void;
}

function setup(): Harness {
  let storeChanged = (): void => undefined;
  let idle = (): void => undefined;
  let focused: ChatInterestChatRef[] = [];
  const state: Pick<ChatState, 'worktreeChats' | 'chatStateSync'> = {
    worktreeChats: {
      'p/w': {
        activeTabId: 'b',
        tabs: ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({
          ...fromPersistedTab({
            id,
            title: id,
            createdAt: '2026-10-01',
            messages: [],
          }),
          transcriptStale: true,
          lastEventAt: i,
        })),
      },
    },
    chatStateSync: { 'p/w': { phase: 'live', revision: 1 } },
  };
  const warmUp = jest.fn<Promise<void>, [ChatInterestChatRef]>(() =>
    Promise.resolve(),
  );
  const flush = jest.fn(() => Promise.resolve());
  const read = jest.fn<
    Promise<void>,
    [ChatInterestChatRef, () => Promise<void>]
  >(async (_ref, barrier) => {
    await barrier();
  });
  const hydrate = jest.fn<
    ReturnType<ChatPrefetchHost['hydrate']>,
    [string, string]
  >((projectId, worktreeId) => {
    state.worktreeChats[`${projectId}/${worktreeId}`] =
      state.worktreeChats['p/w'];
    state.chatStateSync[`${projectId}/${worktreeId}`] = {
      phase: 'live',
      revision: 1,
    };
    return Promise.resolve('installed');
  });
  const host: ChatPrefetchHost = {
    getState: () => state,
    subscribe: (callback) => {
      storeChanged = callback;
      return jest.fn();
    },
    focused: () => focused,
    isCatchingUp: jest.fn(() => false),
    hydrate,
    warmUp,
    catchUp: read,
    flush,
    scheduleIdle: jest.fn((callback) => {
      idle = callback;
      return () => {
        idle = (): void => undefined;
      };
    }),
  };
  const stop = startChatPrefetch(host);
  return {
    host,
    state,
    read,
    warmUp,
    hydrate,
    flush,
    stop,
    setFocused: (refs: ChatInterestChatRef[]): void => {
      focused = refs;
    },
    idle: async (): Promise<void> => {
      const callback = idle;
      idle = (): void => undefined;
      callback();
      await tick();
    },
    notify: (): void => storeChanged(),
  };
}

let stop = (): void => undefined;
beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  stop();
  jest.useRealTimers();
});

it('waits the full 80 ms pointer dwell', async () => {
  const h = setup();
  stop = h.stop;
  await tick();
  noteChatIntent(target(), 'pointer');
  jest.advanceTimersByTime(79);
  await tick();
  expect(h.read).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  await tick();
  expect(h.read).toHaveBeenCalledTimes(1);
});

it('cancels a dwell when the pointer leaves', async () => {
  const h = setup();
  stop = h.stop;
  await tick();
  noteChatIntent(target(), 'pointer');
  jest.advanceTimersByTime(79);
  endChatIntent(target());
  jest.advanceTimersByTime(100);
  await tick();
  expect(h.warmUp).not.toHaveBeenCalled();
  expect(h.read).not.toHaveBeenCalled();
});

it('acts immediately on focus and promotes an existing pointer dwell', async () => {
  const h = setup();
  stop = h.stop;
  await tick();
  noteChatIntent(target(), 'pointer');
  noteChatIntent(target(), 'focus');
  await tick();
  expect(h.read).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(80);
  await tick();
  expect(h.read).toHaveBeenCalledTimes(1);
});

it('deduplicates a chat across chat and worktree intents without cancelling an in-flight read', async () => {
  const h = setup();
  stop = h.stop;
  await tick();
  const pending = deferred<void>();
  h.read.mockReturnValue(pending.promise);
  noteChatIntent(target('b'), 'focus');
  await tick();
  noteChatIntent(
    { kind: 'worktree', projectId: 'p', worktreeId: 'w' },
    'focus',
  );
  noteChatIntent(target('b'), 'pointer');
  jest.advanceTimersByTime(80);
  await tick();
  endChatIntent(target('b'));
  expect(h.read).toHaveBeenCalledTimes(1);
  expect(h.warmUp).toHaveBeenCalledTimes(1);
  pending.resolve();
  await tick();
});

it('limits in-flight reads to two, drains latest first and drops ended queued intents', async () => {
  const h = setup();
  stop = h.stop;
  await tick();
  const a = deferred<void>();
  const b = deferred<void>();
  h.read.mockImplementation((ref) =>
    ref.chatId === 'a' ? a.promise : b.promise,
  );
  noteChatIntent(target('a'), 'focus');
  noteChatIntent(target('b'), 'focus');
  await tick();
  noteChatIntent(target('c'), 'focus');
  noteChatIntent(target('d'), 'focus');
  noteChatIntent(target('e'), 'focus');
  endChatIntent(target('e'));
  await tick();
  expect(h.read).toHaveBeenCalledTimes(2);
  a.resolve();
  await tick();
  expect(h.read.mock.calls.map(([ref]) => ref.chatId)).toEqual(['a', 'b', 'd']);
  endChatIntent(target('c'));
  b.resolve();
  await tick();
  expect(h.read).toHaveBeenCalledTimes(3);
});

it('idle prefetch selects the most recent unread stale chat, one at a time', async () => {
  const h = setup();
  stop = h.stop;
  const tabs = h.state.worktreeChats['p/w'].tabs;
  tabs[0].unread = true;
  tabs[2].unread = true;
  tabs[4].unread = true;
  delete tabs[4].transcriptStale;
  const pending = deferred<void>();
  h.read.mockReturnValue(pending.promise);
  await tick();
  await h.idle();
  expect(h.read.mock.calls.map(([ref]) => ref.chatId)).toEqual(['c']);
  h.notify();
  await h.idle();
  expect(h.read).toHaveBeenCalledTimes(1);
  pending.resolve();
  await tick();
  await h.idle();
  expect(h.read.mock.calls.map(([ref]) => ref.chatId)).toEqual(['c', 'a']);
  expect(tabs[0].unread).toBe(true);
  expect(h.state.worktreeChats['p/w'].activeTabId).toBe('b');
});

it('resolves a tracked worktree to its active chat without hydration', async () => {
  const h = setup();
  stop = h.stop;
  await tick();
  noteChatIntent(
    { kind: 'worktree', projectId: 'p', worktreeId: 'w' },
    'focus',
  );
  await tick();
  expect(h.hydrate).not.toHaveBeenCalled();
  expect(h.read.mock.calls[0][0]).toEqual({
    projectId: 'p',
    worktreeId: 'w',
    chatId: 'b',
  });
});

it('reads a tracked chat whose transcript is not loaded, but not a loaded fresh one', async () => {
  const h = setup();
  stop = h.stop;
  await tick();
  for (const tab of h.state.worktreeChats['p/w'].tabs) {
    delete tab.transcriptStale;
    if (tab.id === 'c') tab.transcriptLoaded = false;
  }
  noteChatIntent(target('a'), 'focus');
  noteChatIntent(target('c'), 'focus');
  await tick();
  expect(h.read.mock.calls.map(([ref]) => ref.chatId)).toEqual(['c']);
});

it.each(['worktree', 'chat'] as const)(
  'hydrates an untracked %s scope before warming and reading',
  async (kind) => {
    const h = setup();
    stop = h.stop;
    await tick();
    delete h.state.chatStateSync['p/w'];
    h.state.worktreeChats['p/w'].tabs.forEach((tab) => {
      delete tab.transcriptStale;
    });
    const order: string[] = [];
    h.hydrate.mockImplementation(() => {
      order.push('hydrate');
      h.state.chatStateSync['p/w'] = { phase: 'live', revision: 1 };
      return Promise.resolve('installed');
    });
    h.warmUp.mockImplementation(() => {
      order.push('warm');
      return Promise.resolve();
    });
    h.read.mockImplementation(() => {
      order.push('read');
      return Promise.resolve();
    });
    noteChatIntent(
      kind === 'chat' ? target('b') : { kind, projectId: 'p', worktreeId: 'w' },
      'focus',
    );
    await tick();
    expect(order).toEqual(['hydrate', 'warm', 'read']);
  },
);

it('waits for warm acknowledgement before catch-up and passes the declaration barrier', async () => {
  const h = setup();
  stop = h.stop;
  await tick();
  const acknowledged = deferred<void>();
  h.warmUp.mockReturnValue(acknowledged.promise);
  noteChatIntent(target(), 'focus');
  await tick();
  expect(h.read).not.toHaveBeenCalled();
  acknowledged.resolve();
  await tick();
  expect(h.read).toHaveBeenCalledWith(
    { projectId: 'p', worktreeId: 'w', chatId: 'a' },
    h.host.flush,
  );
  expect(h.flush).toHaveBeenCalledTimes(1);
});

it.each(['focused', 'fresh', 'catching-up'] as const)(
  'does nothing for a %s chat',
  async (condition) => {
    const h = setup();
    stop = h.stop;
    await tick();
    if (condition === 'focused')
      h.setFocused([{ projectId: 'p', worktreeId: 'w', chatId: 'a' }]);
    if (condition === 'fresh')
      delete h.state.worktreeChats['p/w'].tabs[0].transcriptStale;
    if (condition === 'catching-up') h.host.isCatchingUp = (): boolean => true;
    noteChatIntent(target(), 'focus');
    await tick();
    expect(h.warmUp).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
  },
);

it('hydrates a missing worktree scope and uses the newly hydrated active chat', async () => {
  const h = setup();
  stop = h.stop;
  await tick();
  noteChatIntent(
    { kind: 'worktree', projectId: 'p', worktreeId: 'untracked' },
    'focus',
  );
  await tick();
  expect(h.hydrate).toHaveBeenCalledWith('p', 'untracked');
  expect(h.read.mock.calls[0][0]).toEqual({
    projectId: 'p',
    worktreeId: 'untracked',
    chatId: 'b',
  });
});

it.each(['failed', 'unavailable'] as const)(
  'does not warm or read when hydration is %s',
  async (result) => {
    const h = setup();
    stop = h.stop;
    await tick();
    delete h.state.chatStateSync['p/w'];
    h.hydrate.mockResolvedValue(result);
    noteChatIntent(target(), 'focus');
    await tick();
    expect(h.warmUp).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
  },
);

it('does not read when warm acknowledgement fails, and frees the slot for another intent', async () => {
  const h = setup();
  stop = h.stop;
  await tick();
  h.warmUp.mockRejectedValueOnce(new Error('offline'));
  noteChatIntent(target(), 'focus');
  await tick();
  expect(h.read).not.toHaveBeenCalled();
  noteChatIntent(target('b'), 'focus');
  await tick();
  expect(h.read).toHaveBeenCalledTimes(1);
});

it('does not spin on a failed idle read of the same cached projection', async () => {
  const h = setup();
  stop = h.stop;
  h.state.worktreeChats['p/w'].tabs[0].unread = true;
  h.read.mockRejectedValue(new Error('offline'));
  await tick();
  await h.idle();
  await h.idle();
  h.notify();
  await h.idle();
  expect(h.read).toHaveBeenCalledTimes(1);
});

it('bounds the waiting queue to the eight latest intents', async () => {
  const h = setup();
  stop = h.stop;
  await tick();
  const tabs = h.state.worktreeChats['p/w'].tabs;
  for (let i = 0; i < 10; i += 1) tabs.push({ ...tabs[0], id: `queued-${i}` });
  const pending = deferred<void>();
  h.read.mockImplementation((ref) =>
    ref.chatId === 'a' || ref.chatId === 'b'
      ? pending.promise
      : Promise.resolve(),
  );
  noteChatIntent(target('a'), 'focus');
  noteChatIntent(target('b'), 'focus');
  await tick();
  for (let i = 0; i < 10; i += 1)
    noteChatIntent(target(`queued-${i}`), 'focus');
  pending.resolve();
  await tick();
  await tick();
  expect(h.read.mock.calls.map(([ref]) => ref.chatId)).toEqual([
    'a',
    'b',
    'queued-9',
    'queued-8',
    'queued-7',
    'queued-6',
    'queued-5',
    'queued-4',
    'queued-3',
    'queued-2',
  ]);
});

it('stopping drops dwells and queued work without cancelling a started read', async () => {
  const h = setup();
  stop = h.stop;
  await tick();
  const pending = deferred<void>();
  h.read.mockReturnValue(pending.promise);
  noteChatIntent(target(), 'focus');
  noteChatIntent(target('b'), 'focus');
  await tick();
  noteChatIntent(target('c'), 'focus');
  noteChatIntent(target('d'), 'pointer');
  h.stop();
  pending.resolve();
  jest.advanceTimersByTime(100);
  await tick();
  noteChatIntent(target('e'), 'focus');
  await tick();
  expect(h.read).toHaveBeenCalledTimes(2);
});

it.each([true, false])(
  'the hook schedules idle work on mount and cancels it on unmount (native idle: %s)',
  async (nativeIdle) => {
    const requestIdle = jest.fn(() => 1);
    const cancelIdle = jest.fn();
    Object.defineProperty(window, 'requestIdleCallback', {
      configurable: true,
      value: nativeIdle ? requestIdle : undefined,
    });
    Object.defineProperty(window, 'cancelIdleCallback', {
      configurable: true,
      value: cancelIdle,
    });
    function Probe(): null {
      useChatPrefetch();
      return null;
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    let mounted = true;
    stop = (): void => {
      if (!mounted) return;
      act(() => root.unmount());
      mounted = false;
    };
    await act(async () => {
      root.render(createElement(Probe));
      await tick();
    });
    const scheduledTimers = jest.getTimerCount();
    if (nativeIdle)
      expect(requestIdle).toHaveBeenCalledWith(expect.any(Function), {
        timeout: 1000,
      });
    else expect(scheduledTimers).toBeGreaterThan(0);
    stop();
    if (nativeIdle) expect(cancelIdle).toHaveBeenCalledWith(1);
    else expect(jest.getTimerCount()).toBe(scheduledTimers - 1);
  },
);
