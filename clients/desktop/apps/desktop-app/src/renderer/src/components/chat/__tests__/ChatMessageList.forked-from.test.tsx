import { renderToStaticMarkup } from 'react-dom/server';
import type { JSX } from 'react';
import { ChatMessageList } from '../ChatMessageList';
import type { ChatMessage, ChatTab } from '@/stores/chatStore';
import type { TranscriptTurnSummary } from '@canopy/agent-transcript/transcript-storage';
import { computeTurnSummary } from '@canopy/desktop-shared/lib/turn-utils';
import type * as ChatRenderStoresTestUtils from '@/test-utils/chatRenderStores';

let mockChatState: {
  selectedWorktree: { projectId: string; worktreeId: string };
  worktreeChats: Record<
    string,
    { activeTabId: string; tabs: Array<Partial<ChatTab>> }
  >;
  runtimeByChatId: Record<string, never>;
  pendingQuestions: Record<string, never>;
  pendingApprovals: Record<string, never>;
};

jest.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: typeof mockChatState) => unknown): unknown =>
    selector(mockChatState),
  ...jest
    .requireActual<
      typeof ChatRenderStoresTestUtils
    >('@/test-utils/chatRenderStores')
    .mockChatRenderHooks(() => mockChatState),
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

jest.mock('../ForkedFromLink', () => ({
  ForkedFromLink: (): JSX.Element => (
    <div data-testid="forked-from-link">Forked from conversation</div>
  ),
}));

jest.mock('../TurnGroupRenderer', () => ({
  TurnGroupRenderer: ({
    group,
    isLastTurnGroup,
    knownPipelineRuns,
  }: {
    group: { userMessage: { id: string } };
    isLastTurnGroup: boolean;
    knownPipelineRuns?: Record<string, unknown>;
  }): JSX.Element => (
    <div
      data-testid={`turn-${group.userMessage.id}`}
      data-last-turn-group={isLastTurnGroup}
      data-known-pipeline-runs={Object.keys(knownPipelineRuns ?? {}).join(',')}
    >
      turn:{group.userMessage.id}
    </div>
  ),
}));

jest.mock('../ChatMessageItem', () => ({
  ChatMessageItem: ({ message }: { message: { id: string } }): JSX.Element => (
    <div data-testid={`message-${message.id}`}>message:{message.id}</div>
  ),
}));

jest.mock('../QueuedMessageBubble', () => ({
  QueuedMessageBubble: (): JSX.Element => <div />,
}));

jest.mock('../QueuedMessageEditor', () => ({
  QueuedMessageEditor: (): JSX.Element => <div />,
}));

function message(
  id: string,
  role: 'user' | 'assistant' | 'system',
  blocks: ChatMessage['blocks'],
): ChatMessage {
  return { id, role, blocks, timestamp: 1 } as ChatMessage;
}

function textMessage(
  id: string,
  role: 'user' | 'assistant',
  text: string,
): ChatMessage {
  return message(id, role, [{ type: 'text', text }]);
}

function timerMessage(id: string): ChatMessage {
  return message(id, 'system', [
    { type: 'turn_timer', startedAt: 1, completedAt: 2 },
  ]);
}

function pipelineRunMessages(): ChatMessage[] {
  const createdAt = '2026-09-18T00:00:00.000Z';
  return [
    message('pipeline-tool', 'assistant', [
      {
        type: 'tool_use',
        toolUseId: 'pipeline-tool-use',
        toolName: 'DispatchAction',
        input: '{}',
      },
    ]),
    message('pipeline-result', 'assistant', [
      {
        type: 'tool_result',
        toolUseId: 'pipeline-tool-use',
        toolName: 'DispatchAction',
        output: JSON.stringify({
          ok: true,
          result: {
            agentArtifacts: [
              {
                version: 1,
                kind: 'pipeline_run',
                operation: 'pipeline.run',
                dedupeKey: 'canopy:pipeline_run:execution:exec-1',
                createdAt,
                executionId: 'exec-1',
                pipelineId: 'pipe-1',
                pipelineName: 'Build',
                initialStatus: 'running',
                queuedAt: createdAt,
                projectId: 'project',
                worktreeId: 'worktree',
                navigationTarget: {
                  kind: 'pipeline_execution',
                  executionId: 'exec-1',
                  projectId: 'project',
                  worktreeId: 'worktree',
                },
              },
            ],
          },
        }),
        isError: false,
      },
    ]),
  ];
}

function renderList(options: {
  messages: ChatMessage[];
  atMessageId?: string;
  enableForkedFromLink?: boolean;
  transcriptTurns?: TranscriptTurnSummary[];
}): string {
  mockChatState = {
    selectedWorktree: { projectId: 'project', worktreeId: 'worktree' },
    worktreeChats: {
      'project/worktree': {
        activeTabId: 'chat-1',
        tabs: [
          {
            id: 'chat-1',
            forkedFrom: {
              projectId: 'project',
              worktreeId: 'worktree',
              chatId: 'source-chat',
              ...(options.atMessageId
                ? { atMessageId: options.atMessageId }
                : {}),
            },
          },
        ],
      },
    },
    runtimeByChatId: {},
    pendingQuestions: {},
    pendingApprovals: {},
  };

  return renderToStaticMarkup(
    <ChatMessageList
      messages={options.messages}
      transcriptTurns={options.transcriptTurns}
      queuedMessages={[]}
      chatId="chat-1"
      onClearQueuedMessage={jest.fn()}
      enableForkedFromLink={options.enableForkedFromLink ?? true}
    />,
  );
}

describe('ChatMessageList fork source divider placement', () => {
  it('marks the latest turn group as last when a standalone message trails it', () => {
    const html = renderList({
      messages: [
        textMessage('user-1', 'user', 'First prompt'),
        textMessage('assistant-1', 'assistant', 'First answer'),
        timerMessage('timer-1'),
        textMessage('trailing-user', 'user', 'Queued follow-up'),
      ],
    });

    expect(html).toContain('data-testid="turn-user-1"');
    expect(html).toContain('data-last-turn-group="true"');
  });

  it('forwards chat-initiated pipeline runs to completed turns', () => {
    const html = renderList({
      messages: [
        textMessage('user-1', 'user', 'Run the pipeline'),
        ...pipelineRunMessages(),
        timerMessage('timer-1'),
      ],
    });

    expect(html).toContain('data-known-pipeline-runs="exec-1"');
  });

  it.each([false, true])(
    'uses inferred timer frames only while a turn has unloaded rows (%s)',
    (partial) => {
      const html = renderList({
        messages: [
          textMessage('historical', 'user', 'Old prompt'),
          textMessage('answer', 'assistant', 'Old answer'),
        ],
        transcriptTurns: [
          {
            id: 'historical',
            start: 0,
            end: partial ? 1000 : 2,
            complete: false,
            summary: computeTurnSummary([]),
            finalMessageIds: ['answer'],
            frameTimer: {
              ...timerMessage('inferred'),
              blocks: [{ type: 'turn_timer', completedAt: null }],
            },
            ...(partial ? { before: 999 } : {}),
          },
        ],
      });
      if (partial) expect(html).toContain('data-testid="turn-historical"');
      else {
        expect(html).toContain('data-testid="message-answer"');
        expect(html).not.toContain('data-testid="turn-historical"');
      }
    },
  );
  it('keeps non-virtualized sticky sections as spaced layout boxes', () => {
    const html = renderList({
      messages: [
        textMessage('user-1', 'user', 'First prompt'),
        timerMessage('timer-1'),
        textMessage('assistant-1', 'assistant', 'First answer'),
        textMessage('user-2', 'user', 'Second prompt'),
        timerMessage('timer-2'),
        textMessage('assistant-2', 'assistant', 'Second answer'),
      ],
    });

    expect(html).not.toMatch(
      /class="contents"[^>]*>.*data-chat-sticky-section/s,
    );
    expect(html).toMatch(/class="space-y-2"[^>]*>.*data-chat-sticky-section/s);
  });

  it('renders the divider at the top for empty-history forks', () => {
    const html = renderList({ messages: [] });

    expect(html).toContain('Forked from conversation');
  });

  it('renders an empty-history fork divider before a hoisted first prompt', () => {
    const html = renderList({
      messages: [
        textMessage('user-1', 'user', 'First prompt'),
        timerMessage('timer-1'),
        textMessage('assistant-1', 'assistant', 'First answer'),
      ],
    });

    expect(html.indexOf('Forked from conversation')).toBeGreaterThan(-1);
    expect(html.indexOf('message:user-1')).toBeGreaterThan(-1);
    expect(html.indexOf('Forked from conversation')).toBeLessThan(
      html.indexOf('message:user-1'),
    );
    expect(html.indexOf('Forked from conversation')).toBeLessThan(
      html.indexOf('data-chat-sticky-section'),
    );
  });

  it('renders the divider after the anchored turn group', () => {
    const html = renderList({
      atMessageId: 'assistant-1',
      messages: [
        textMessage('user-1', 'user', 'First prompt'),
        timerMessage('timer-1'),
        textMessage('assistant-1', 'assistant', 'First answer'),
        textMessage('user-2', 'user', 'Second prompt'),
        timerMessage('timer-2'),
        textMessage('assistant-2', 'assistant', 'Second answer'),
      ],
    });

    expect(html.indexOf('turn:user-1')).toBeGreaterThan(-1);
    expect(html.indexOf('Forked from conversation')).toBeGreaterThan(
      html.indexOf('turn:user-1'),
    );
    expect(html.indexOf('Forked from conversation')).toBeLessThan(
      html.indexOf('turn:user-2'),
    );
  });

  it('renders the divider after a turn group when anchored to its timer', () => {
    const html = renderList({
      atMessageId: 'timer-1',
      messages: [
        textMessage('user-1', 'user', 'First prompt'),
        timerMessage('timer-1'),
        textMessage('user-2', 'user', 'Second prompt'),
        timerMessage('timer-2'),
        textMessage('assistant-2', 'assistant', 'Second answer'),
      ],
    });

    expect(html.indexOf('turn:user-1')).toBeGreaterThan(-1);
    expect(html.indexOf('Forked from conversation')).toBeGreaterThan(
      html.indexOf('turn:user-1'),
    );
    expect(html.indexOf('Forked from conversation')).toBeLessThan(
      html.indexOf('turn:user-2'),
    );
  });

  it('renders the divider after an anchored standalone message', () => {
    const html = renderList({
      atMessageId: 'orphan-assistant',
      messages: [
        textMessage('orphan-assistant', 'assistant', 'Restored answer'),
        textMessage('user-1', 'user', 'Next prompt'),
        timerMessage('timer-1'),
        textMessage('assistant-1', 'assistant', 'Next answer'),
      ],
    });

    expect(html.indexOf('message:orphan-assistant')).toBeGreaterThan(-1);
    expect(html.indexOf('Forked from conversation')).toBeGreaterThan(
      html.indexOf('message:orphan-assistant'),
    );
    expect(html.indexOf('Forked from conversation')).toBeLessThan(
      html.indexOf('turn:user-1'),
    );
  });

  it('hides the divider when the stored anchor is no longer present', () => {
    const html = renderList({
      atMessageId: 'missing',
      messages: [
        textMessage('user-1', 'user', 'First prompt'),
        timerMessage('timer-1'),
        textMessage('assistant-1', 'assistant', 'First answer'),
      ],
    });

    expect(html).not.toContain('Forked from conversation');
  });
});
