/**
 * @jest-environment jsdom
 *
 * A managed background delegate outlives the turn that started it, so its
 * card in the pinned Agent activity section must survive the parent chat's
 * turns starting and ending, and other delegates joining the list. Remounting
 * the card resets its expansion, which reads as the card randomly collapsing
 * while the user is reading it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatMessageList } from '../ChatMessageList';
import type { ChatMessage } from '@/stores/chatStore';
import type * as ChatRenderStoresTestUtils from '@/test-utils/chatRenderStores';

const mockChatId = 'chat-active-agent';

jest.mock('@/stores/chatStore', () => {
  const state = {
    selectedWorktree: { projectId: 'project', worktreeId: 'worktree' },
    worktreeChats: {
      'project/worktree': {
        activeTabId: 'chat-active-agent',
        tabs: [{ id: 'chat-active-agent' }],
      },
    },
    pendingQuestions: {},
    pendingApprovals: {},
    runtimeByChatId: {},
    recordAgentArtifactCarry: (): void => undefined,
  };
  const useChatStore = (selector: (value: typeof state) => unknown): unknown =>
    selector(state);
  useChatStore.getState = (): typeof state => state;
  return {
    useChatStore,
    ...jest
      .requireActual<
        typeof ChatRenderStoresTestUtils
      >('@/test-utils/chatRenderStores')
      .mockChatRenderHooks(() => state),
  };
});

jest.mock('@/stores/appAdvisorWatchersStore', () => {
  const state = {
    watchers: [],
    hydrated: true,
    loading: false,
    subscribeBridge: (): (() => void) => () => undefined,
    hydrate: (): Promise<void> => Promise.resolve(),
  };
  const useAppAdvisorWatchersStore = (
    selector: (value: typeof state) => unknown,
  ): unknown => selector(state);
  useAppAdvisorWatchersStore.getState = (): typeof state => state;
  return { useAppAdvisorWatchersStore };
});

jest.mock('@/stores/pipelineRunsStore', () => ({
  usePipelineRunsStore: (
    selector: (value: { summaries: readonly never[] }) => unknown,
  ): unknown => selector({ summaries: [] }),
}));

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
  TurnGroupRenderer: (): null => null,
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

const TIMESTAMP = 1789490000000;

function delegateMessage(delegationId: string, offset: number): ChatMessage {
  const agentBlockId = `delegated-agent-${delegationId}`;
  return {
    id: agentBlockId,
    role: 'assistant',
    timestamp: TIMESTAMP + offset,
    blocks: [
      {
        type: 'delegated_agent_call',
        agentBlockId,
        delegationId,
        parentTurnId: 'request',
        sequence: 1,
        createdAt: TIMESTAMP,
        selectedModelId: 'sonnet',
        runtimeModelId: 'claude-sonnet-4-6',
        targetHarnessId: 'claude',
        parentToolCallId: `spawn-${delegationId}`,
        parentHarnessId: 'codex',
        description: `Review ${delegationId}`,
        prompt: `Review ${delegationId}`,
        executionMode: 'background',
        status: 'running',
        runGeneration: 1,
        outputTruncated: false,
      },
    ],
  };
}

function completedTurn(delegationIds: readonly string[]): ChatMessage[] {
  return [
    {
      id: 'request',
      role: 'user',
      timestamp: TIMESTAMP,
      blocks: [{ type: 'text', text: 'Review the source in the background.' }],
    },
    ...delegationIds.map((id, index) => delegateMessage(id, index + 1)),
    {
      id: 'parent-answer',
      role: 'assistant',
      timestamp: TIMESTAMP + 10,
      blocks: [{ type: 'text', text: 'The review continues.' }],
    },
    {
      id: 'timer',
      role: 'system',
      timestamp: TIMESTAMP + 11,
      blocks: [
        {
          type: 'turn_timer',
          startedAt: TIMESTAMP,
          completedAt: TIMESTAMP + 11,
        },
      ],
    },
  ];
}

/** A second turn the parent is still running, e.g. a watcher follow-up. */
const ACTIVE_FOLLOW_UP: ChatMessage[] = [
  {
    id: 'follow-up',
    role: 'user',
    timestamp: TIMESTAMP + 20,
    blocks: [{ type: 'text', text: 'Keep going.' }],
  },
  {
    id: 'follow-up-timer',
    role: 'system',
    timestamp: TIMESTAMP + 21,
    blocks: [
      { type: 'turn_timer', startedAt: TIMESTAMP + 20, completedAt: null },
    ],
  },
];

const mountedRoots: Root[] = [];

function renderList(messages: ChatMessage[]): {
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
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: mockChatId,
          }}
          onClearQueuedMessage={(): void => undefined}
        />,
      );
    });
  };
  render(messages);
  return { host, rerender: render };
}

function delegateCard(host: HTMLElement, delegationId: string): HTMLElement {
  const card = host.querySelector<HTMLElement>(
    `[data-testid="agent-activity-active"] [data-delegation-id="${delegationId}"]`,
  );
  if (!card) throw new Error(`Missing active card for ${delegationId}`);
  return card;
}

function expand(card: HTMLElement): void {
  const toggle = card.querySelector<HTMLButtonElement>(
    '[aria-label="Expand delegated task"]',
  );
  if (!toggle) throw new Error('Card is already expanded');
  act(() => toggle.click());
}

function isExpanded(card: HTMLElement): boolean {
  return card.querySelector('[aria-label="Collapse delegated task"]') !== null;
}

beforeEach(() => {
  globalThis.ResizeObserver = TestResizeObserver;
});

afterEach(() => {
  act(() => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.innerHTML = '';
});

describe('pinned managed delegate expansion', () => {
  it('stays expanded when the parent chat starts and finishes another turn', () => {
    const idle = completedTurn(['alpha']);
    const { host, rerender } = renderList(idle);
    expand(delegateCard(host, 'alpha'));

    rerender([...idle, ...ACTIVE_FOLLOW_UP]);
    expect(isExpanded(delegateCard(host, 'alpha'))).toBe(true);

    rerender(idle);
    expect(isExpanded(delegateCard(host, 'alpha'))).toBe(true);
  });

  it('keeps each card expanded as other delegates join the list', () => {
    const { host, rerender } = renderList(completedTurn(['beta']));
    expand(delegateCard(host, 'beta'));

    rerender(completedTurn(['alpha', 'beta']));

    expect(isExpanded(delegateCard(host, 'beta'))).toBe(true);
    expect(isExpanded(delegateCard(host, 'alpha'))).toBe(false);
  });
});

describe('pinned managed delegate stop controls', () => {
  const stop = jest.fn();
  const stopAll = jest.fn();
  let originalApi: PropertyDescriptor | undefined;
  const target = {
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: mockChatId,
  };

  beforeEach(() => {
    stop.mockReset().mockResolvedValue({ ok: true });
    stopAll.mockReset().mockResolvedValue({ ok: true, stopped: 2 });
    originalApi = Object.getOwnPropertyDescriptor(window, 'api');
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { managedDelegation: { stop, stopAll } },
    });
  });

  afterEach(() => {
    if (originalApi) Object.defineProperty(window, 'api', originalApi);
    else Reflect.deleteProperty(window, 'api');
  });

  function nestedTurn(): ChatMessage[] {
    const turn = completedTurn(['alpha', 'beta']);
    return turn.map((message) =>
      message.id === 'delegated-agent-beta'
        ? {
            ...message,
            blocks: message.blocks.map((block) =>
              block.type === 'delegated_agent_call'
                ? { ...block, depth: 2, parentDelegationId: 'alpha' }
                : block,
            ),
          }
        : message,
    );
  }

  function stopFor(host: HTMLElement, delegationId: string): HTMLButtonElement {
    const button = delegateCard(
      host,
      delegationId,
    ).querySelector<HTMLButtonElement>('[data-testid="delegated-agent-stop"]');
    if (!button) throw new Error(`Missing Stop for ${delegationId}`);
    return button;
  }

  it('stops one pinned delegate for this chat', async () => {
    const { host } = renderList(nestedTurn());
    await act(async () => {
      stopFor(host, 'beta').click();
      await Promise.resolve();
    });
    expect(stop).toHaveBeenCalledWith({ ...target, delegationId: 'beta' });
    expect(stopAll).not.toHaveBeenCalled();
  });

  it('tells the user a parent Stop also ends its live children', () => {
    const { host } = renderList(nestedTurn());
    act(() => {
      stopFor(host, 'alpha').parentElement?.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      );
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Stop delegation and the tasks it started',
    );
  });

  it('stops every live delegate after the inline confirmation', async () => {
    const { host } = renderList(nestedTurn());
    const stopAllButton = host.querySelector<HTMLButtonElement>(
      '[data-testid="agent-activity-active"] [data-testid="agent-activity-stop-all"]',
    );
    act(() => stopAllButton?.click());
    expect(host.textContent).toContain('Stop 2 delegations?');
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>(
          '[data-testid="agent-activity-stop-all-confirm"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(stopAll).toHaveBeenCalledWith(target);
  });

  it('offers no Stop all once every delegate settled', () => {
    const settled = completedTurn(['alpha']).map((message) => ({
      ...message,
      blocks: message.blocks.map((block) =>
        block.type === 'delegated_agent_call'
          ? { ...block, status: 'cancelled' as const }
          : block,
      ),
    }));
    const { host } = renderList([...settled, ...ACTIVE_FOLLOW_UP]);
    expect(
      host.querySelector('[data-testid="agent-activity-stop-all"]'),
    ).toBeNull();
  });
});
