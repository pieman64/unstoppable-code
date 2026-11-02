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
import { CanopyClientProvider } from '@canopy/app-state';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
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
const mockTurnGroupProps: Array<{
  group: {
    userMessage: { id: string };
    assistantMessages: Array<{
      blocks: Array<{ type: string; toolUseId?: string }>;
    }>;
  };
  onShowSpawningCall?: (target: {
    toolUseId?: string;
    userMessageId?: string;
  }) => void;
  revealRequest?: { messageId: string };
  searchMessageId?: string;
}> = [];
jest.mock('../TurnGroupRenderer', () => ({
  TurnGroupRenderer: (
    props: (typeof mockTurnGroupProps)[number],
  ): JSX.Element => {
    mockTurnGroupProps.push(props);
    // Like a completed turn, its tool rows render only once it is opened.
    return (
      <div>
        {props.revealRequest
          ? props.group.assistantMessages.flatMap((message) =>
              message.blocks.flatMap((block) =>
                block.toolUseId === undefined
                  ? []
                  : [
                      <div
                        key={block.toolUseId}
                        data-tool-use-id={block.toolUseId}
                      />,
                    ],
              ),
            )
          : null}
      </div>
    );
  },
}));
jest.mock('../ChatMessageItem', () => ({ ChatMessageItem: (): null => null }));
jest.mock('../QueuedMessageBubble', () => ({
  QueuedMessageBubble: (): null => null,
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
        <CanopyClientProvider client={ipcCanopyClient}>
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
          />
        </CanopyClientProvider>,
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

function wakeMessages(): ChatMessage[] {
  return [
    {
      id: 'user-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'Run the tests in the background' }],
      timestamp: 1,
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'tool-1',
          toolName: 'Bash',
          input: JSON.stringify({
            command: 'npm test',
            description: 'Run the tests',
          }),
        },
      ],
      timestamp: 2,
    },
    {
      id: 'turn-1:timer',
      role: 'system',
      blocks: [
        {
          type: 'turn_timer',
          turnId: 'turn-1',
          userMessageId: 'user-1',
          startedAt: 1,
          completedAt: 3,
        },
      ],
      timestamp: 1,
    },
    {
      id: 'wake:timer',
      role: 'system',
      blocks: [
        {
          type: 'turn_timer',
          turnId: 'wake',
          spawnedBy: { taskId: 'task-1', toolUseId: 'tool-1' },
          startedAt: 4,
          completedAt: 8,
        },
      ],
      timestamp: 4,
    },
    {
      id: 'wake-tool',
      role: 'assistant',
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'tool-2',
          toolName: 'Read',
          input: JSON.stringify({ file_path: '/tmp/test-report.txt' }),
        },
      ],
      timestamp: 5,
    },
    {
      id: 'wake-answer',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'The tests passed.' }],
      timestamp: 6,
    },
  ];
}

describe('ChatMessageList wake turns (turn-state phase 40d)', () => {
  function wakeGroupProps(): (typeof mockTurnGroupProps)[number] | undefined {
    return mockTurnGroupProps
      .filter((props) => props.group.userMessage.id === 'wake:timer:wake')
      .at(-1);
  }

  beforeEach(() => {
    mockTurnGroupProps.length = 0;
  });

  function rect(top: number, height: number): DOMRect {
    return {
      top,
      height,
      bottom: top + height,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: top,
      toJSON: (): unknown => ({}),
    };
  }

  it("opens the spawning call's collapsed turn, centers the call and highlights only it", () => {
    const { host } = renderList(wakeMessages());
    const showSpawningCall = wakeGroupProps()?.onShowSpawningCall;
    expect(showSpawningCall).toBeInstanceOf(Function);
    expect(host.querySelector('[data-tool-use-id="tool-1"]')).toBeNull();

    act(() =>
      showSpawningCall?.({ toolUseId: 'tool-1', userMessageId: 'user-1' }),
    );
    expect(
      mockTurnGroupProps
        .filter((props) => props.group.userMessage.id === 'user-1')
        .at(-1)?.revealRequest,
    ).toEqual({ messageId: 'assistant-1' });
    const row = host.querySelector<HTMLElement>('[data-tool-use-id="tool-1"]');
    const scroller = host.querySelector<HTMLElement>(
      '[data-testid="chat-message-list-scroll"]',
    );
    expect(row).not.toBeNull();
    expect(scroller).not.toBeNull();
    jest
      .spyOn(scroller ?? host, 'getBoundingClientRect')
      .mockReturnValue(rect(100, 400));
    jest
      .spyOn(row ?? host, 'getBoundingClientRect')
      .mockReturnValue(rect(900, 20));
    scrollToSpy.mockClear();

    act(() => {
      jest.advanceTimersByTime(32);
    });
    // The row's middle (910) lands on the scroller's middle (300).
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 610, behavior: 'smooth' });
    expect(row?.dataset.chatCallFocus).toBe('true');
    expect(section(host, 'user-1')?.dataset.chatTurnFocus).toBeUndefined();
    expect(section(host, 'user-1')?.dataset.chatCallFocus).toBeUndefined();

    act(() => {
      jest.advanceTimersByTime(2500);
    });
    expect(row?.dataset.chatCallFocus).toBeUndefined();
  });

  it('highlights only the prompt bubble when the spawning call is not loaded', () => {
    const { host } = renderList(wakeMessages());

    act(() =>
      wakeGroupProps()?.onShowSpawningCall?.({
        toolUseId: 'tool-missing',
        userMessageId: 'user-1',
      }),
    );
    act(() => {
      jest.advanceTimersByTime(32);
    });

    expect(scrollToSpy).toHaveBeenCalled();
    expect(
      host.querySelector<HTMLElement>('[data-sticky-user-message-id="user-1"]')
        ?.dataset.chatCallFocus,
    ).toBe('true');
    expect(section(host, 'user-1')?.dataset.chatTurnFocus).toBeUndefined();
    expect(section(host, 'user-1')?.dataset.chatCallFocus).toBeUndefined();
  });

  it("expands the wake's turn for a search match inside it", () => {
    renderList(wakeMessages(), {
      searchSelection: {
        // Search reports the prompt's indexed turn, which holds the wake.
        turnId: 'user-1',
        messageId: 'wake-tool',
        count: 1,
        occurrence: 0,
        query: 'report',
        generation: 1,
      },
    });
    expect(wakeGroupProps()?.searchMessageId).toBe('wake-tool');
    expect(
      mockTurnGroupProps
        .filter((props) => props.group.userMessage.id === 'user-1')
        .at(-1)?.searchMessageId,
    ).toBeUndefined();
  });
});
