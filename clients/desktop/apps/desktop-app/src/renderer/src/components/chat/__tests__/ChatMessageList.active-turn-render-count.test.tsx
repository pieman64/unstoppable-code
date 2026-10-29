/**
 * @jest-environment jsdom
 *
 * Phase 12 (P2 renderer quick wins) render-count guard. Appending one tool
 * result to the ACTIVE turn must re-render O(1) transcript blocks, not every
 * block of that turn.
 *
 * The list renders the real `TurnGroupRenderer` and `ChatMessageItem`; only
 * `ChatBlockRenderer` is replaced by a probe that keeps the production
 * component's memo boundary (default shallow prop comparison) and counts its
 * renders per block. A React Profiler around the list counts commits.
 *
 * Before phase 12, `mergeToolResults` rebuilt every display message and every
 * tool block on each run, so each appended result re-rendered every block of
 * the active turn (and every message of it).
 */
import { act, Profiler, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as ReactNamespace from 'react';
import { ChatMessageList } from '../ChatMessageList';
import type { ChatMessage } from '@/stores/chatStore';
import type * as ChatRenderStoresTestUtils from '@/test-utils/chatRenderStores';

const mockChatId = 'chat-render-count';
const mockBlockRenders: Record<string, number> = {};

jest.mock('@/stores/chatStore', () => {
  const mockState = (): unknown => ({
    selectedWorktree: {
      projectId: 'project-render',
      worktreeId: 'worktree-render',
    },
    worktreeChats: {
      'project-render/worktree-render': {
        activeTabId: mockChatId,
        tabs: [{ id: mockChatId, messages: [], queuedMessages: [] }],
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

jest.mock('../ChatBlockRenderer', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  // Same memo boundary as the production `ChatBlockRenderer`: a block whose
  // props are all identical (block object included) is skipped.
  const ChatBlockRenderer = react.memo(function ChatBlockRenderer({
    block,
  }: {
    block: { type: string; toolUseId?: string; text?: string };
  }): JSX.Element {
    const key =
      block.type === 'tool_use' && block.toolUseId
        ? `tool:${block.toolUseId}`
        : `${block.type}:${block.text ?? ''}`;
    mockBlockRenders[key] = (mockBlockRenders[key] ?? 0) + 1;
    return react.createElement('div', { 'data-block-probe': key });
  });
  return { ChatBlockRenderer };
});
jest.mock('../UserBubble', () => ({ UserBubble: (): null => null }));
jest.mock('../TurnTimer', () => ({ TurnTimer: (): null => null }));
jest.mock('../TurnFeedbackHosts', () => ({
  TurnFeedbackSlot: (): null => null,
}));
jest.mock('../AutoArchiveToggleButton', () => ({
  AutoArchiveToggleButton: (): null => null,
}));
jest.mock('../RunCommentsButton', () => ({
  RunCommentsButton: (): null => null,
}));
jest.mock('@/components/shared/ShareSessionControl', () => ({
  ShareSessionControl: (): null => null,
}));
jest.mock('@/components/watchers/ChatWatcherButton', () => ({
  ChatWatcherButton: (): null => null,
}));
jest.mock('../ActiveAgentActivitySection', () => ({
  ActiveAgentActivitySection: (): null => null,
}));
jest.mock('../DesktopAgentActivitySection', () => ({
  DesktopAgentActivitySection: (): null => null,
}));
jest.mock('../TurnDiffSummary', () => ({ TurnDiffSummary: (): null => null }));
jest.mock('../ForkedFromLink', () => ({ ForkedFromLink: (): null => null }));
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

const ACTIVE_TOOL_COUNT = 8;

function toolCall(turn: number, index: number): ChatMessage {
  return {
    id: `assistant-${turn}-${index}`,
    role: 'assistant',
    blocks: [
      { type: 'text', text: `Step ${turn}.${index}` },
      {
        type: 'tool_use',
        toolUseId: `tool-${turn}-${index}`,
        toolName: 'Bash',
        input: JSON.stringify({ command: `echo ${turn}.${index}` }),
      },
    ],
    timestamp: turn * 1000 + index * 10 + 1,
  };
}

function toolResult(turn: number, index: number): ChatMessage {
  return {
    id: `result-${turn}-${index}`,
    // Persisted tool-result carriers are assistant rows; a `user` row is a
    // turn boundary.
    role: 'assistant',
    blocks: [
      {
        type: 'tool_result',
        toolUseId: `tool-${turn}-${index}`,
        toolName: 'Bash',
        output: `output ${turn}.${index}`,
        isError: false,
      },
    ],
    timestamp: turn * 1000 + index * 10 + 2,
  };
}

function completedTurn(turn: number): ChatMessage[] {
  const rows: ChatMessage[] = [
    {
      id: `user-${turn}`,
      role: 'user',
      blocks: [{ type: 'text', text: `Ask ${turn}` }],
      timestamp: turn * 1000,
    },
  ];
  for (let index = 0; index < 3; index += 1) {
    rows.push(toolCall(turn, index), toolResult(turn, index));
  }
  rows.push({
    id: `timer-${turn}`,
    role: 'system',
    blocks: [
      {
        type: 'turn_timer',
        startedAt: turn * 1000,
        completedAt: turn * 1000 + 900,
      },
    ],
    timestamp: turn * 1000 + 900,
  });
  return rows;
}

/**
 * Two completed turns, then an active turn with `ACTIVE_TOOL_COUNT` tool
 * calls; results exist for the first `resultCount` of them. The rows are
 * built once and reused, as the store keeps unchanged message objects.
 */
function buildTranscript(): {
  base: ChatMessage[];
  activeCalls: ChatMessage[];
  activeResults: ChatMessage[];
} {
  const base: ChatMessage[] = [
    ...completedTurn(1),
    ...completedTurn(2),
    {
      id: 'user-3',
      role: 'user',
      blocks: [{ type: 'text', text: 'Ask 3' }],
      timestamp: 3000,
    },
    {
      id: 'timer-3',
      role: 'system',
      blocks: [{ type: 'turn_timer', startedAt: 3000, completedAt: null }],
      timestamp: 3000,
    },
  ];
  const activeCalls: ChatMessage[] = [];
  const activeResults: ChatMessage[] = [];
  for (let index = 0; index < ACTIVE_TOOL_COUNT; index += 1) {
    activeCalls.push(toolCall(3, index));
    activeResults.push(toolResult(3, index));
  }
  return { base, activeCalls, activeResults };
}

function rows(
  transcript: ReturnType<typeof buildTranscript>,
  resultCount: number,
): ChatMessage[] {
  const out = [...transcript.base];
  transcript.activeCalls.forEach((call, index) => {
    out.push(call);
    if (index < resultCount) out.push(transcript.activeResults[index]);
  });
  return out;
}

const mountedRoots: Root[] = [];
let commits = 0;

function renderList(messages: ChatMessage[]): {
  rerender: (next: ChatMessage[]) => void;
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  const queuedMessages: never[] = [];
  const target = {
    projectId: 'project-render',
    worktreeId: 'worktree-render',
    chatId: mockChatId,
  };
  const onClear = (): void => undefined;
  const render = (next: ChatMessage[]): void => {
    act(() => {
      root.render(
        <Profiler
          id="chat-message-list"
          onRender={(): void => {
            commits += 1;
          }}
        >
          <ChatMessageList
            messages={next}
            queuedMessages={queuedMessages}
            chatId={mockChatId}
            targetOverride={target}
            onClearQueuedMessage={onClear}
          />
        </Profiler>,
      );
    });
  };
  render(messages);
  return { rerender: render };
}

function totalBlockRenders(): number {
  return Object.values(mockBlockRenders).reduce((sum, count) => sum + count, 0);
}

function activeTurnBlockRenders(): number {
  return Object.entries(mockBlockRenders)
    .filter(
      ([key]) =>
        key.startsWith('tool:tool-3-') || key.startsWith('text:Step 3.'),
    )
    .reduce((sum, [, count]) => sum + count, 0);
}

beforeEach(() => {
  globalThis.ResizeObserver = TestResizeObserver;
  for (const key of Object.keys(mockBlockRenders)) delete mockBlockRenders[key];
  commits = 0;
});

afterEach(() => {
  act(() => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.innerHTML = '';
});

describe('ChatMessageList active-turn render count', () => {
  it('renders every active-turn block on mount', () => {
    const transcript = buildTranscript();
    renderList(rows(transcript, ACTIVE_TOOL_COUNT - 1));

    // Text and tool block per active call, all mounted once.
    expect(activeTurnBlockRenders()).toBe(ACTIVE_TOOL_COUNT * 2);
  });

  it('re-renders O(1) blocks when one tool result is appended to the active turn', () => {
    const transcript = buildTranscript();
    const { rerender } = renderList(rows(transcript, ACTIVE_TOOL_COUNT - 1));
    const blocksBefore = totalBlockRenders();
    const commitsBefore = commits;

    rerender(rows(transcript, ACTIVE_TOOL_COUNT));

    const rerendered = Object.entries(mockBlockRenders)
      .filter(([key]) => mockBlockRenders[key] > 1)
      .map(([key]) => key);
    // Only the tool block that received the result changes.
    expect(rerendered).toEqual([`tool:tool-3-${ACTIVE_TOOL_COUNT - 1}`]);
    expect(totalBlockRenders() - blocksBefore).toBe(1);
    expect(commits).toBeGreaterThan(commitsBefore);
  });

  it('keeps per-append block work constant as the active turn grows', () => {
    const transcript = buildTranscript();
    const { rerender } = renderList(rows(transcript, 0));

    const perAppend: number[] = [];
    for (let count = 1; count <= ACTIVE_TOOL_COUNT; count += 1) {
      const before = totalBlockRenders();
      rerender(rows(transcript, count));
      perAppend.push(totalBlockRenders() - before);
    }

    expect(perAppend).toEqual(new Array<number>(ACTIVE_TOOL_COUNT).fill(1));
  });
});
