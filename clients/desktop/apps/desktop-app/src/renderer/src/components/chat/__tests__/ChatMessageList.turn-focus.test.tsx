/**
 * @jest-environment jsdom
 *
 * ECW-8684: a deep link from an automation run row asks the transcript to
 * scroll to one user-authored turn. The request is id-driven and must be
 * consumed exactly once — found or not — so a deleted target cannot leave a
 * dangling link that re-fires against an unrelated chat later.
 */
import { act, type ComponentProps, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatMessageList } from '../ChatMessageList';
import { useNavigationStore } from '@/stores/navigationStore';
import { hydratedKeys } from '@/stores/chat/hydration';
import type { ChatMessage } from '@/stores/chatStore';
import type * as ChatRenderStoresTestUtils from '@/test-utils/chatRenderStores';

const mockChatId = 'chat-turn-focus';

jest.mock('@/stores/chatStore', () => {
  const mockState = (): unknown => ({
    selectedWorktree: {
      projectId: 'project-turn-focus',
      worktreeId: 'worktree-turn-focus',
    },
    worktreeChats: {
      'project-turn-focus/worktree-turn-focus': {
        activeTabId: mockChatId,
        tabs: [{ id: mockChatId }],
      },
    },
    pendingQuestions: {},
    pendingApprovals: {},
    runtimeByChatId: {},
  });
  return {
    useChatStore: (selector: (state: unknown) => unknown): unknown =>
      selector(mockState()),
    ...jest
      .requireActual<
        typeof ChatRenderStoresTestUtils
      >('@/test-utils/chatRenderStores')
      .mockChatRenderHooks(mockState),
  };
});

jest.mock('@/hooks/useInvocableInventory', () => ({
  useInvocableInventory: (): { entries: [] } => ({ entries: [] }),
}));

jest.mock('@/stores/fileListStore', () => ({
  getWorktreeCacheKey: (projectId: string, worktreeId: string): string =>
    `${projectId}/${worktreeId}`,
  useFileListStore: (
    selector: (state: {
      indexCache: Record<string, never>;
      indexErrors: Record<string, never>;
      indexLoading: Set<string>;
      fetchFileIndex: jest.Mock;
    }) => unknown,
  ): unknown =>
    selector({
      indexCache: {},
      indexErrors: {},
      indexLoading: new Set(),
      fetchFileIndex: jest.fn(),
    }),
}));

jest.mock('../ForkedFromLink', () => ({ ForkedFromLink: (): null => null }));
jest.mock('../TurnGroupRenderer', () => ({
  TurnGroupRenderer: (): JSX.Element => <div />,
}));
jest.mock('../ChatMessageItem', () => ({ ChatMessageItem: (): null => null }));
jest.mock('../QueuedMessageBubble', () => ({
  QueuedMessageBubble: (): null => null,
}));
jest.mock('../QueuedMessageEditor', () => ({
  QueuedMessageEditor: (): null => null,
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

class TestResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function turnMessages(): ChatMessage[] {
  return [
    {
      id: 'user-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'First ask' }],
      timestamp: 1,
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'First answer' }],
      timestamp: 2,
    },
    {
      id: 'user-2',
      role: 'user',
      blocks: [{ type: 'text', text: 'Second ask' }],
      timestamp: 3,
    },
    {
      id: 'assistant-2',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Second answer' }],
      timestamp: 4,
    },
  ];
}

function manyTurnMessages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => [
    {
      id: `user-${index}`,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: `Ask ${index}` }],
      timestamp: index * 2,
    },
    {
      id: `assistant-${index}`,
      role: 'assistant' as const,
      blocks: [{ type: 'text' as const, text: `Answer ${index}` }],
      timestamp: index * 2 + 1,
    },
  ]).flat();
}

const mountedRoots: Root[] = [];
const scrollToSpy = jest.fn();

function renderList(
  messages: ChatMessage[],
  extra: Partial<ComponentProps<typeof ChatMessageList>> = {},
): {
  root: Root;
  host: HTMLDivElement;
  rerender: (next: ChatMessage[]) => void;
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  const render = (rows: ChatMessage[]): void => {
    act(() => {
      root.render(
        <ChatMessageList
          messages={rows}
          queuedMessages={[]}
          chatId={mockChatId}
          targetOverride={{
            projectId: 'project-turn-focus',
            worktreeId: 'worktree-turn-focus',
            chatId: mockChatId,
          }}
          onClearQueuedMessage={(): void => undefined}
          {...extra}
        />,
      );
    });
  };
  render(messages);
  return { root, host, rerender: render };
}

function section(host: HTMLElement, key: string): HTMLElement | null {
  return host.querySelector<HTMLElement>(`[data-chat-sticky-section="${key}"]`);
}

beforeEach(() => {
  jest.useFakeTimers();
  globalThis.ResizeObserver = TestResizeObserver;
  window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
    window.setTimeout(() => callback(performance.now()), 16);
  window.cancelAnimationFrame = (id: number): void => window.clearTimeout(id);
  scrollToSpy.mockClear();
  Object.defineProperty(Element.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: scrollToSpy,
  });
  useNavigationStore.setState({ pendingChatTurnFocus: undefined });
  hydratedKeys.add('project-turn-focus/worktree-turn-focus');
});

afterEach(() => {
  // Unmount before clearing the DOM: a still-mounted list stays subscribed to
  // the navigation store and would consume the next test's focus request.
  act(() => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  jest.clearAllTimers();
  jest.useRealTimers();
  document.body.innerHTML = '';
  hydratedKeys.clear();
});

describe('ChatMessageList turn focus', () => {
  it('scrolls to the requested turn and highlights it', () => {
    const { host } = renderList(turnMessages());

    act(() => {
      useNavigationStore.getState().openChatTurn({
        projectId: 'project-turn-focus',
        worktreeId: 'worktree-turn-focus',
        chatId: mockChatId,
        userMessageId: 'user-2',
      });
    });

    // Consumed exactly once, so a later unrelated render cannot re-fire it.
    expect(useNavigationStore.getState().pendingChatTurnFocus).toBeUndefined();

    act(() => {
      jest.advanceTimersByTime(32);
    });
    expect(section(host, 'user-2')?.dataset.chatTurnFocus).toBe('true');
    expect(section(host, 'user-1')?.dataset.chatTurnFocus).toBeUndefined();

    const scroller = host.querySelector<HTMLElement>(
      '[data-testid="chat-message-list-scroll"]',
    );
    expect(scrollToSpy).toHaveBeenCalled();
    expect(scroller).not.toBeNull();
  });

  it('clears the highlight after its timeout', () => {
    const { host } = renderList(turnMessages());

    act(() => {
      useNavigationStore.getState().openChatTurn({
        projectId: 'project-turn-focus',
        chatId: mockChatId,
        userMessageId: 'user-1',
      });
    });
    act(() => {
      jest.advanceTimersByTime(32);
    });
    expect(section(host, 'user-1')?.dataset.chatTurnFocus).toBe('true');

    act(() => {
      jest.advanceTimersByTime(2500);
    });
    expect(section(host, 'user-1')?.dataset.chatTurnFocus).toBeUndefined();
  });

  it('consumes the request even when the turn no longer exists', () => {
    const { host } = renderList(turnMessages());

    act(() => {
      useNavigationStore.getState().openChatTurn({
        projectId: 'project-turn-focus',
        chatId: mockChatId,
        userMessageId: 'deleted-message',
      });
    });

    expect(useNavigationStore.getState().pendingChatTurnFocus).toBeUndefined();
    act(() => {
      jest.advanceTimersByTime(600);
    });
    expect(section(host, 'user-1')?.dataset.chatTurnFocus).toBeUndefined();
  });

  it('consumes a missing turn after an empty transcript hydrates', () => {
    renderList([]);

    act(() => {
      useNavigationStore.getState().openChatTurn({
        projectId: 'project-turn-focus',
        chatId: mockChatId,
        userMessageId: 'deleted-message',
      });
    });

    expect(useNavigationStore.getState().pendingChatTurnFocus).toBeUndefined();
  });

  it('loads the owning turn before consuming a request for a turn outside the loaded window', async () => {
    let resolveLoad: () => void = () => undefined;
    const onLoadTurn = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const { host, rerender } = renderList(turnMessages(), {
      onLoadTurn,
      transcriptTurns: [],
    });

    act(() => {
      useNavigationStore.getState().openChatTurn({
        projectId: 'project-turn-focus',
        worktreeId: 'worktree-turn-focus',
        chatId: mockChatId,
        userMessageId: 'user-0',
      });
    });

    // The turn is older than the newest page: request its page and keep the
    // link pending rather than discarding it.
    expect(onLoadTurn).toHaveBeenCalledTimes(1);
    expect(onLoadTurn).toHaveBeenCalledWith('user-0');
    expect(useNavigationStore.getState().pendingChatTurnFocus).toMatchObject({
      userMessageId: 'user-0',
    });

    rerender([
      {
        id: 'user-0',
        role: 'user',
        blocks: [{ type: 'text', text: 'Oldest ask' }],
        timestamp: 0,
      },
      {
        id: 'assistant-0',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Oldest answer' }],
        timestamp: 0.5,
      },
      ...turnMessages(),
    ]);
    await act(async () => {
      resolveLoad();
      await Promise.resolve();
    });

    expect(useNavigationStore.getState().pendingChatTurnFocus).toBeUndefined();
    act(() => {
      jest.advanceTimersByTime(32);
    });
    expect(section(host, 'user-0')?.dataset.chatTurnFocus).toBe('true');
    expect(onLoadTurn).toHaveBeenCalledTimes(1);
  });

  it('consumes the request once loading the owning turn cannot make progress', async () => {
    const onLoadTurn = jest.fn((): Promise<void> => Promise.resolve());
    const { host } = renderList(turnMessages(), {
      onLoadTurn,
      transcriptTurns: [],
    });

    act(() => {
      useNavigationStore.getState().openChatTurn({
        projectId: 'project-turn-focus',
        chatId: mockChatId,
        userMessageId: 'deleted-message',
      });
    });
    expect(onLoadTurn).toHaveBeenCalledWith('deleted-message');
    await act(async () => {
      await Promise.resolve();
    });

    expect(useNavigationStore.getState().pendingChatTurnFocus).toBeUndefined();
    expect(onLoadTurn).toHaveBeenCalledTimes(1);
    act(() => {
      jest.advanceTimersByTime(600);
    });
    expect(section(host, 'user-1')?.dataset.chatTurnFocus).toBeUndefined();
  });

  it('uses the virtualized scroll path for a distant turn', () => {
    renderList(manyTurnMessages(80));
    scrollToSpy.mockClear();

    act(() => {
      useNavigationStore.getState().openChatTurn({
        projectId: 'project-turn-focus',
        worktreeId: 'worktree-turn-focus',
        chatId: mockChatId,
        userMessageId: 'user-79',
      });
    });

    expect(useNavigationStore.getState().pendingChatTurnFocus).toBeUndefined();
    expect(scrollToSpy).toHaveBeenCalled();
    const initialScrollCalls = scrollToSpy.mock.calls.length;
    act(() => {
      jest.advanceTimersByTime(64);
    });
    expect(scrollToSpy.mock.calls.length).toBeGreaterThan(initialScrollCalls);
  });

  it('ignores a request aimed at a different chat', () => {
    renderList(turnMessages());

    act(() => {
      useNavigationStore.getState().openChatTurn({
        projectId: 'project-turn-focus',
        chatId: 'some-other-chat',
        userMessageId: 'user-1',
      });
    });

    expect(useNavigationStore.getState().pendingChatTurnFocus).toMatchObject({
      chatId: 'some-other-chat',
    });
  });

  it('ignores reused chat and turn ids from a different project', () => {
    renderList(turnMessages());

    act(() => {
      useNavigationStore.getState().openChatTurn({
        projectId: 'different-project',
        worktreeId: 'worktree-turn-focus',
        chatId: mockChatId,
        userMessageId: 'user-1',
      });
    });

    expect(useNavigationStore.getState().pendingChatTurnFocus).toMatchObject({
      projectId: 'different-project',
      chatId: mockChatId,
      userMessageId: 'user-1',
    });
    expect(
      section(document.body, 'user-1')?.dataset.chatTurnFocus,
    ).toBeUndefined();
  });

  it('re-fires when the same turn is requested twice', () => {
    renderList(turnMessages());

    act(() => {
      useNavigationStore.getState().openChatTurn({
        projectId: 'project-turn-focus',
        chatId: mockChatId,
        userMessageId: 'user-1',
      });
    });
    const first = useNavigationStore.getState().pendingChatTurnFocus;
    expect(first).toBeUndefined();

    act(() => {
      useNavigationStore.getState().openChatTurn({
        projectId: 'project-turn-focus',
        chatId: mockChatId,
        userMessageId: 'user-1',
      });
    });
    // A second click produces a new nonce, so the effect runs again rather
    // than being swallowed as an unchanged value.
    expect(useNavigationStore.getState().pendingChatTurnFocus).toBeUndefined();
  });
});
