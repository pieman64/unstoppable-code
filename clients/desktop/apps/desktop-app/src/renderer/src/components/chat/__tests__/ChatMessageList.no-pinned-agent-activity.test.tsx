/**
 * @jest-environment jsdom
 *
 * Under the Subagents view experiment the chat has no pinned Agent activity
 * section above the composer: running subagents are counted in the worktree
 * top bar and managed in the Subagents panel.
 * ChatMessageList.active-agent-expansion.test.tsx covers the pinned section
 * while the experiment is off.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatMessageList } from '../ChatMessageList';
import type { ChatMessage } from '@/stores/chatStore';
import type * as ChatRenderStoresTestUtils from '@/test-utils/chatRenderStores';

const mockChatId = 'chat-active-agent';

jest.mock('@/stores/labsExperimentsStore', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@/stores/labsExperimentsStore',
  ),
  useLabsExperimentEnabled: (id: string): boolean => id === 'subagents-view',
}));

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

beforeEach(() => {
  globalThis.ResizeObserver = TestResizeObserver;
});

afterEach(() => {
  act(() => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.innerHTML = '';
});

describe('live delegates above the composer', () => {
  it('pins no Agent activity section: the top bar counts them and opens Subagents', () => {
    const { host } = renderList([
      ...completedTurn(['alpha', 'beta']),
      ...ACTIVE_FOLLOW_UP,
    ]);
    expect(
      host.querySelector('[data-testid="agent-activity-active"]'),
    ).toBeNull();
  });
});
