/**
 * @jest-environment jsdom
 *
 * A managed background delegate outlives the turn that started it. The
 * composer's background drawer lists it (background drawer D2), so the
 * pinned Agent activity section never does: it mounts only for a streaming
 * turn's capability tiles.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CanopyClientProvider } from '@canopy/app-state';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
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
    completedWatchers: [],
    hydrated: true,
    loading: false,
    subscribeBridge: (): (() => void) => () => undefined,
    hydrate: (): Promise<void> => Promise.resolve(),
  };
  const useAppAdvisorWatchersStore = (
    selector: (value: typeof state) => unknown,
  ): unknown => selector(state);
  useAppAdvisorWatchersStore.getState = (): typeof state => state;
  return {
    useAppAdvisorWatchersStore,
    retainAppAdvisorWatchersBridge: (): (() => void) => () => undefined,
  };
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
        <CanopyClientProvider client={ipcCanopyClient}>
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
          />
        </CanopyClientProvider>,
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

describe('pinned Agent activity with live delegates', () => {
  it('lists no live delegate once its turn completed', () => {
    const { host } = renderList(completedTurn(['alpha', 'beta']));
    expect(
      host.querySelector('[data-testid="agent-activity-active"]'),
    ).toBeNull();
  });

  it('stays absent while a turn without capability tiles streams', () => {
    const { host } = renderList([
      ...completedTurn(['alpha']),
      ...ACTIVE_FOLLOW_UP,
    ]);
    expect(
      host.querySelector('[data-testid="agent-activity-active"]'),
    ).toBeNull();
  });
});

// Guard (Review Focus 1): the pinned section mounts for every chat with a
// turn, so it must render nothing when no turn streams, no delegate runs and
// no run is watched (CAN-4690).
describe('pinned section when nothing is live', () => {
  it('renders no pinned section when nothing is live', () => {
    const settled = completedTurn(['alpha']).map((message) => ({
      ...message,
      blocks: message.blocks.map((block) =>
        block.type === 'delegated_agent_call'
          ? { ...block, status: 'completed' as const }
          : block,
      ),
    }));
    const { host } = renderList(settled);
    expect(
      host.querySelector('[data-testid="agent-activity-active"]'),
    ).toBeNull();
  });
});
