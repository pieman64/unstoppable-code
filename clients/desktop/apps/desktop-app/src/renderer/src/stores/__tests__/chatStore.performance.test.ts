import type { CanopyApi } from '@canopy/desktop-shared/types';
import { buildLongChatMessages } from '@/__tests__/chat-performance-fixtures';
import { measureDurationMs } from '@/lib/perf-test-utils';
import { createEmptyTab } from '../chat/tab-utils';
import type * as ActivityStoreModule from '../activityStore';
import type * as ChatStoreModule from '../chatStore';

// Durable chat persistence is main-owned now: the renderer store no longer
// schedules or serializes tab snapshots, so there is no renderer save path to
// performance-test here. Remaining coverage focuses on in-memory event
// handling and reconstruction costs.
const flushScopeMock = jest.fn<
  Promise<void>,
  [{ projectId: string; worktreeId: string }]
>();
const startOutputPollingMock = jest.fn<Promise<void>, [unknown]>();

declare global {
  interface Window {
    api: CanopyApi;
  }
}

function loadStores(): {
  chatStore: typeof ChatStoreModule;
  activityStore: typeof ActivityStoreModule;
} {
  jest.resetModules();
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: {
      api: {
        chat: {
          flushScope: flushScopeMock,
        },
        activity: {
          startOutputPolling: startOutputPollingMock,
        },
      },
    },
  });

  const chatStore = jest.requireActual<typeof ChatStoreModule>('../chatStore');
  const activityStore =
    jest.requireActual<typeof ActivityStoreModule>('../activityStore');

  return { chatStore, activityStore };
}

describe('chatStore transcript event handling', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    flushScopeMock.mockReset();
    flushScopeMock.mockResolvedValue(undefined);
    startOutputPollingMock.mockReset();
    startOutputPollingMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.resetModules();
  });

  it('does not notify for an unknown no-op transcript event', async () => {
    const { chatStore } = loadStores();
    const { useChatStore } = chatStore;
    const tab = {
      ...createEmptyTab({ providerTypeHint: 'claude' }),
      id: 'chat-1',
      title: 'No-op Chat',
      messages: [],
      status: 'idle' as const,
      error: null,
      createdAt: '2026-04-24T00:00:00.000Z',
      queuedMessages: [],
      planMode: false,
      proposalMode: 'optional' as const,
      thinkingLevel: 'high' as const,
      providerType: 'claude' as const,
    };
    useChatStore.setState({
      selectedWorktree: { projectId: 'project', worktreeId: 'worktree' },
      worktreeChats: {
        'project/worktree': {
          activeTabId: 'chat-1',
          tabs: [tab],
        },
      },
    });
    const subscriber = jest.fn();
    const unsubscribe = useChatStore.subscribe(subscriber);

    useChatStore.getState().handleChatEvent({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat-1',
      data: { type: 'unknown_event' },
    });
    await jest.advanceTimersByTimeAsync(600);
    unsubscribe();

    expect(subscriber).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().worktreeChats['project/worktree']?.tabs[0],
    ).toBe(tab);
  });
});

describe('mapWithConcurrency', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('preserves input order even when mapper completion order differs', async () => {
    const { chatStore } = loadStores();
    const completionDelays = new Map<number, number>([
      [1, 30],
      [2, 5],
      [3, 15],
    ]);

    const results = await chatStore.mapWithConcurrency(
      [1, 2, 3],
      2,
      async (item) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, completionDelays.get(item) ?? 0);
        });
        return `value-${String(item)}`;
      },
    );

    expect(results).toEqual(['value-1', 'value-2', 'value-3']);
  });

  it('rejects invalid concurrency values', async () => {
    const { chatStore } = loadStores();

    await expect(
      chatStore.mapWithConcurrency([1], 0, (item) => Promise.resolve(item)),
    ).rejects.toThrow('concurrency must be at least 1');
  });
});

describe('activityStore reconstruction performance', () => {
  beforeEach(() => {
    startOutputPollingMock.mockReset();
    startOutputPollingMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.resetModules();
  });

  it('reconstructs long transcripts within a generous budget', () => {
    const { activityStore } = loadStores();
    const { useActivityStore } = activityStore;
    const messages = buildLongChatMessages({
      turns: 500,
      toolsPerTurn: 3,
      includeSubagents: true,
    });

    const durationMs = measureDurationMs(() => {
      useActivityStore
        .getState()
        .reconstructFromMessages('project', 'worktree', [
          { id: 'chat-1', messages },
        ]);
    });

    expect(durationMs).toBeLessThan(2_500);
  });

  it('does not notify when reconstructed tool inputs only reorder object keys', () => {
    const { activityStore } = loadStores();
    const { useActivityStore } = activityStore;

    useActivityStore.getState().reconstructFromMessages('project', 'worktree', [
      {
        id: 'chat-1',
        messages: [
          {
            timestamp: 1,
            blocks: [
              {
                type: 'tool_use',
                toolUseId: 'tool-1',
                toolName: 'Read',
                input:
                  '{"path":"file.ts","options":{"recursive":true,"limit":5},"tags":["a","b"]}',
              },
            ],
          },
        ],
      },
    ]);

    const subscriber = jest.fn();
    const unsubscribe = useActivityStore.subscribe(subscriber);

    useActivityStore.getState().reconstructFromMessages('project', 'worktree', [
      {
        id: 'chat-1',
        messages: [
          {
            timestamp: 1,
            blocks: [
              {
                type: 'tool_use',
                toolUseId: 'tool-1',
                toolName: 'Read',
                input:
                  '{"tags":["a","b"],"options":{"limit":5,"recursive":true},"path":"file.ts"}',
              },
            ],
          },
        ],
      },
    ]);

    unsubscribe();
    expect(subscriber).not.toHaveBeenCalled();
  });
});
