/**
 * @jest-environment jsdom
 *
 * `TurnGroupRenderer` is memoized so a streaming delta in the live turn only
 * re-renders that turn. The list must therefore hand every completed row
 * referentially stable props: a fresh per-row closure (`onLoadHistory`) or a
 * callback rebuilt on every sticky-section change (`onJumpToMessage`) defeats
 * the memo boundary and re-renders every mounted turn on every token.
 */
// eslint-disable-next-line no-restricted-imports -- jsdom has no TextEncoder to size agent artifact receipts.
import { TextEncoder as NodeTextEncoder } from 'node:util';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as ReactNamespace from 'react';
import type { TranscriptTurnSummary } from '@canopy/agent-transcript/transcript-storage';
import { computeTurnSummary } from '@canopy/desktop-shared/lib/turn-utils';
import { ChatMessageList } from '../ChatMessageList';
import type { ChatMessage } from '@/stores/chatStore';
import type * as ChatRenderStoresTestUtils from '@/test-utils/chatRenderStores';

const mockChatId = 'chat-memo-stability';
const mockRenderCounts: Record<string, number> = {};
const mockLoadHistoryCalls: string[] = [];
const mockArtifactProps: Record<string, readonly unknown[] | undefined> = {};
const mockAllowRemoteImages: Record<string, boolean | undefined> = {};

jest.mock('@/stores/chatStore', () => {
  const mockState = (): unknown => ({
    selectedWorktree: {
      projectId: 'project-memo',
      worktreeId: 'worktree-memo',
    },
    worktreeChats: {
      'project-memo/worktree-memo': {
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
jest.mock('../TurnGroupRenderer', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  const { ChatMarkdownFileTargetContext } = jest.requireActual<{
    ChatMarkdownFileTargetContext: ReactNamespace.Context<
      { allowRemoteImages?: boolean } | undefined
    >;
  }>('../chat-markdown-file-target');
  // Same memo boundary as the production component: any changed prop
  // re-renders the probe, so the counts below measure prop stability.
  const TurnGroupRenderer = react.memo(function TurnGroupRenderer({
    group,
    onLoadHistory,
    agentArtifacts,
  }: {
    group: { userMessage: { id: string } };
    onLoadHistory?: (userMessageId: string) => void | Promise<void>;
    agentArtifacts?: readonly unknown[];
  }): JSX.Element {
    const markdownTarget = react.useContext(ChatMarkdownFileTargetContext);
    mockRenderCounts[group.userMessage.id] =
      (mockRenderCounts[group.userMessage.id] ?? 0) + 1;
    mockArtifactProps[group.userMessage.id] = agentArtifacts;
    mockAllowRemoteImages[group.userMessage.id] =
      markdownTarget?.allowRemoteImages;
    return react.createElement('button', {
      type: 'button',
      'data-turn-probe': group.userMessage.id,
      onClick: (): void => {
        mockLoadHistoryCalls.push(group.userMessage.id);
        void onLoadHistory?.(group.userMessage.id);
      },
    });
  });
  return { TurnGroupRenderer };
});
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

Object.assign(globalThis, { TextEncoder: NodeTextEncoder });

/**
 * A validated skill receipt, serialized the way a successful `DispatchAction`
 * tool result carries it. Fresh objects on every call: the projection cache
 * must key on artifact-relevant content, not on message identity, because
 * the store is free to rebuild message objects.
 */
function skillReceiptOutput(name: string): string {
  return JSON.stringify({
    ok: true,
    result: {
      agentArtifacts: [
        {
          version: 1,
          kind: 'skill',
          operation: 'skills.update',
          dedupeKey: `canopy:skill:installed:custom:${name}`,
          createdAt: '2026-08-04T12:00:00.000Z',
          source: 'installed',
          sourceId: 'custom',
          installedName: name,
          name,
          canUpdate: true,
          navigationTarget: {
            kind: 'installed_skill',
            sourceId: 'custom',
            skillName: name,
          },
        },
      ],
    },
  });
}

function artifactTurn(
  ordinal: number,
  ask: string,
  skillName: string,
): ChatMessage[] {
  return [
    {
      id: `user-${ordinal}`,
      role: 'user',
      blocks: [{ type: 'text', text: ask }],
      timestamp: ordinal * 10,
    },
    {
      id: `assistant-${ordinal}`,
      role: 'assistant',
      blocks: [
        {
          type: 'tool_use',
          toolUseId: `tool-${ordinal}`,
          toolName: 'DispatchAction',
          input: '{}',
        },
      ],
      timestamp: ordinal * 10 + 1,
    },
    {
      id: `result-${ordinal}`,
      role: 'assistant',
      blocks: [
        {
          type: 'tool_result',
          toolUseId: `tool-${ordinal}`,
          toolName: 'DispatchAction',
          output: skillReceiptOutput(skillName),
          isError: false,
        },
      ],
      timestamp: ordinal * 10 + 2,
    },
  ];
}

function transcript(liveText: string): ChatMessage[] {
  return [
    ...artifactTurn(1, 'First ask', 'alpha'),
    ...artifactTurn(2, 'Second ask', 'beta'),
    {
      id: 'user-3',
      role: 'user',
      blocks: [{ type: 'text', text: 'Third ask' }],
      timestamp: 30,
    },
    {
      id: 'assistant-3',
      role: 'assistant',
      blocks: [{ type: 'text', text: liveText }],
      timestamp: 31,
    },
    {
      id: 'timer-3',
      role: 'system',
      blocks: [{ type: 'turn_timer', startedAt: 30, completedAt: null }],
      timestamp: 32,
    },
  ];
}

const transcriptTurns: TranscriptTurnSummary[] = [
  {
    id: 'user-1',
    start: 0,
    end: 2,
    complete: true,
    summary: computeTurnSummary([]),
    finalMessageIds: ['assistant-1'],
    before: 1,
  },
];

const mountedRoots: Root[] = [];
const onLoadTurn = jest.fn((): Promise<void> => Promise.resolve());

function renderList(
  messages: ChatMessage[],
  options: { allowRemoteImages?: boolean } = {},
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
          transcriptTurns={transcriptTurns}
          onLoadTurn={onLoadTurn}
          targetOverride={{
            projectId: 'project-memo',
            worktreeId: 'worktree-memo',
            chatId: mockChatId,
            allowRemoteImages: options.allowRemoteImages,
          }}
          onClearQueuedMessage={(): void => undefined}
        />,
      );
    });
  };
  render(messages);
  return { root, host, rerender: render };
}

beforeEach(() => {
  globalThis.ResizeObserver = TestResizeObserver;
  for (const key of Object.keys(mockRenderCounts)) delete mockRenderCounts[key];
  for (const key of Object.keys(mockArtifactProps)) {
    delete mockArtifactProps[key];
  }
  for (const key of Object.keys(mockAllowRemoteImages)) {
    delete mockAllowRemoteImages[key];
  }
  mockLoadHistoryCalls.splice(0);
  onLoadTurn.mockClear();
});

afterEach(() => {
  act(() => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.innerHTML = '';
});

describe('ChatMessageList memo stability', () => {
  it('preserves the remote-image policy while memoizing a transcript target', () => {
    renderList(transcript('Third'), { allowRemoteImages: false });

    expect(mockAllowRemoteImages['user-1']).toBe(false);
  });

  it('does not re-render completed turn groups while the live turn streams', () => {
    const { rerender } = renderList(transcript('Third'));
    const firstAfterMount = mockRenderCounts['user-1'];
    const secondAfterMount = mockRenderCounts['user-2'];
    expect(firstAfterMount).toBeGreaterThanOrEqual(1);
    expect(secondAfterMount).toBeGreaterThanOrEqual(1);

    rerender(transcript('Third answer'));
    rerender(transcript('Third answer, continued'));

    expect(mockRenderCounts['user-1']).toBe(firstAfterMount);
    expect(mockRenderCounts['user-2']).toBe(secondAfterMount);
    expect(mockRenderCounts['user-3']).toBeGreaterThanOrEqual(3);
  });

  it('hands completed turns the same agentArtifacts identity across streaming deltas', () => {
    const { rerender } = renderList(transcript('Third'));
    const firstArtifacts = mockArtifactProps['user-1'];
    const secondArtifacts = mockArtifactProps['user-2'];
    expect(firstArtifacts).toHaveLength(1);
    expect(secondArtifacts).toHaveLength(1);
    const firstRenders = mockRenderCounts['user-1'];
    const secondRenders = mockRenderCounts['user-2'];

    rerender(transcript('Third answer'));
    rerender(transcript('Third answer, continued'));

    expect(mockArtifactProps['user-1']).toBe(firstArtifacts);
    expect(mockArtifactProps['user-2']).toBe(secondArtifacts);
    expect(mockRenderCounts['user-1']).toBe(firstRenders);
    expect(mockRenderCounts['user-2']).toBe(secondRenders);
  });

  it('recomputes only the edited completed turn when its artifacts change', () => {
    const { rerender } = renderList(transcript('Third'));
    const firstArtifacts = mockArtifactProps['user-1'];
    const secondArtifacts = mockArtifactProps['user-2'];
    const secondRenders = mockRenderCounts['user-2'];

    rerender([
      ...artifactTurn(1, 'First ask', 'alpha-renamed'),
      ...transcript('Third').slice(3),
    ]);

    expect(mockArtifactProps['user-1']).not.toBe(firstArtifacts);
    expect(mockArtifactProps['user-1']).toEqual([
      expect.objectContaining({ name: 'alpha-renamed' }),
    ]);
    expect(mockArtifactProps['user-2']).toBe(secondArtifacts);
    expect(mockRenderCounts['user-2']).toBe(secondRenders);
  });

  it('routes a row history load to the owning turn through the stable callback', () => {
    const { host } = renderList(transcript('Third'));
    const probe = host.querySelector<HTMLButtonElement>(
      '[data-turn-probe="user-1"]',
    );
    if (!probe) throw new Error('Missing turn probe');
    act(() => {
      probe.click();
    });
    expect(mockLoadHistoryCalls).toEqual(['user-1']);
    expect(onLoadTurn).toHaveBeenCalledTimes(1);
    expect(onLoadTurn).toHaveBeenCalledWith('user-1');
  });
});
