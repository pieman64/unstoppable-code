/**
 * @jest-environment jsdom
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatRuntimeState } from '@canopy/desktop-shared/types';
import {
  chatStoreRenderView,
  useChatStore,
  type ChatTab,
} from '@/stores/chatStore';
import type { ChatMessage } from '@/stores/chat/types';
import {
  createChatTabHoverCardRenderer,
  deriveChatTabPreview,
} from '../chat-tab-preview';
import { warmUpChat } from '@/lib/chat-interest';
import { noteChatIntent } from '@/stores/chat/chat-prefetch';

jest.mock('@/lib/chat-interest', () => ({
  warmUpChat: jest.fn(() => Promise.resolve()),
}));
jest.mock('@/stores/chat/chat-prefetch', () => ({
  noteChatIntent: jest.fn(),
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const T0 = Date.UTC(2026, 9, 21, 12, 0, 0);

function message(
  id: string,
  role: ChatMessage['role'],
  blocks: ChatMessage['blocks'],
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return { id, role, blocks, timestamp: T0, ...extra };
}

const text = (value: string): ChatMessage['blocks'][number] => ({
  type: 'text',
  text: value,
});
const toolUse = (id: string): ChatMessage['blocks'][number] => ({
  type: 'tool_use',
  toolUseId: id,
  toolName: 'Read',
  input: '{}',
});

function chatTab(overrides: Partial<ChatTab> = {}): ChatTab {
  // The fields the preview reads; the rest of a runtime tab is irrelevant.
  return {
    id: 'chat-2',
    title: 'Second',
    createdAt: '2026-10-21T12:00:00.000Z',
    messages: [],
    status: 'idle',
    error: null,
    queuedMessages: [],
    ...overrides,
  } as ChatTab;
}

const TURN: ChatMessage[] = [
  message('u1', 'user', [text('Old prompt')]),
  message('a1', 'assistant', [text('Old reply')]),
  message('u2', 'user', [text('Tighten the Feed sidebar spacing')]),
  message('a2', 'assistant', [
    text('I will start with the rows.'),
    toolUse('t1'),
  ]),
  message('r1', 'user', [
    {
      type: 'tool_result',
      toolUseId: 't1',
      toolName: 'Read',
      output: 'ok',
      isError: false,
    },
  ]),
  message('a3', 'assistant', [toolUse('t2')]),
  // A sub-agent's own words are not the chat's reply.
  message('s1', 'assistant', [text('Sub-agent notes')], {
    parentToolUseId: 't2',
  }),
  message('a4', 'assistant', [text('Rows are tighter now.')]),
];

describe('deriveChatTabPreview', () => {
  it('reads the latest turn: prompt, own replies and its tool calls', () => {
    const preview = deriveChatTabPreview(
      {
        tab: chatTab({
          messages: TURN,
          turnEnds: { u2: { outcome: 'completed', endedAt: T0 + 60_000 } },
        }),
        runtime: undefined,
      },
      null,
    );
    expect(preview).toEqual({
      prompt: 'Tighten the Feed sidebar spacing',
      replies: ['I will start with the rows.', 'Rows are tighter now.'],
      status: { kind: 'finished', endedAt: T0 + 60_000 },
      toolCount: 2,
    });
  });

  it('is working with the turn start while the chat streams', () => {
    const runtime: ChatRuntimeState = {
      status: 'streaming',
      activeTurn: { userMessageId: 'u2', startedAt: T0 - 28_000 },
      queuedMessageIds: [],
    };
    expect(
      deriveChatTabPreview(
        { tab: chatTab({ messages: TURN, status: 'streaming' }), runtime },
        null,
      ).status,
    ).toEqual({ kind: 'working', startedAt: T0 - 28_000 });
  });

  it('puts a waiting question ahead of everything else', () => {
    expect(
      deriveChatTabPreview(
        {
          tab: chatTab({ messages: TURN, status: 'streaming' }),
          runtime: undefined,
        },
        'question',
      ).status,
    ).toEqual({ kind: 'waiting', reason: 'question' });
  });

  it('is stopped, not failed, after a cancelled or interrupted turn', () => {
    for (const status of ['cancelled', 'interrupted'] as const) {
      const runtime: ChatRuntimeState = {
        status,
        queuedMessageIds: [],
        lastActivityAt: T0 + 5_000,
      };
      expect(
        deriveChatTabPreview(
          { tab: chatTab({ messages: TURN }), runtime },
          null,
        ).status,
      ).toEqual({ kind: 'stopped', endedAt: T0 + 5_000 });
    }
    expect(
      deriveChatTabPreview(
        {
          tab: chatTab({
            messages: TURN,
            turnEnds: { u2: { outcome: 'cancelled', endedAt: T0 + 6_000 } },
          }),
          runtime: undefined,
        },
        null,
      ).status,
    ).toEqual({ kind: 'stopped', endedAt: T0 + 6_000 });
  });

  it('is failed only after an error', () => {
    const runtime: ChatRuntimeState = {
      status: 'failed',
      queuedMessageIds: [],
      lastActivityAt: T0 + 5_000,
    };
    expect(
      deriveChatTabPreview({ tab: chatTab({ messages: TURN }), runtime }, null)
        .status,
    ).toEqual({ kind: 'failed', endedAt: T0 + 5_000 });
    expect(
      deriveChatTabPreview(
        {
          tab: chatTab({ messages: TURN, status: 'error' }),
          runtime: undefined,
        },
        null,
      ).status.kind,
    ).toBe('failed');
  });

  it('is failed when main recorded the latest turn as failed', () => {
    expect(
      deriveChatTabPreview(
        {
          tab: chatTab({
            messages: TURN,
            turnEnds: { u2: { outcome: 'failed', endedAt: T0 + 7_000 } },
          }),
          runtime: undefined,
        },
        null,
      ).status,
    ).toEqual({ kind: 'failed', endedAt: T0 + 7_000 });
  });

  it('shows the cached reply and status before the body loads', () => {
    const preview = deriveChatTabPreview(
      {
        tab: chatTab({
          messages: [],
          transcriptLoaded: false,
          transcript: {
            format: 'complete-message-jsonl-v1',
            committedMessageCount: 8,
            committedByteLength: 100,
            transcriptRevision: 3,
            hasActiveSidecar: false,
            messageCount: 8,
            lastMessageAt: T0 + 90_000,
            lastAssistantPreview: 'Rows are tighter now.',
          },
        }),
        runtime: undefined,
      },
      null,
    );
    expect(preview).toEqual({
      prompt: null,
      replies: ['Rows are tighter now.'],
      status: { kind: 'finished', endedAt: T0 + 90_000 },
      toolCount: null,
    });
  });

  it('hides the tool count while the latest turn is only partly loaded', () => {
    type TurnSummary = NonNullable<
      NonNullable<ChatTab['transcriptWindow']>['turns']
    >[number];
    const summary = (
      id: string,
      start: number,
      before?: number,
    ): TurnSummary => ({
      id,
      start,
      end: start + 10,
      complete: true,
      summary: {} as never,
      finalMessageIds: [],
      ...(before === undefined ? {} : { before }),
    });
    const partly = deriveChatTabPreview(
      {
        tab: chatTab({
          messages: TURN.slice(2),
          transcriptWindow: {
            totalMessages: 1500,
            transcriptRevision: 4,
            turns: [summary('old', 0), summary('latest', 2, 500)],
          },
        }),
        runtime: undefined,
      },
      null,
    );
    expect(partly.toolCount).toBeNull();
    expect(partly.prompt).toBe('Tighten the Feed sidebar spacing');

    const whole = deriveChatTabPreview(
      {
        tab: chatTab({
          messages: TURN,
          transcriptWindow: {
            totalMessages: 8,
            transcriptRevision: 4,
            turns: [summary('old', 0, 0), summary('latest', 2)],
          },
        }),
        runtime: undefined,
      },
      null,
    );
    expect(whole.toolCount).toBe(2);
  });

  it('hides the tool count when the prompt row is not loaded yet', () => {
    const preview = deriveChatTabPreview(
      {
        tab: chatTab({
          messages: TURN.slice(5),
          transcriptWindow: {
            totalMessages: 1500,
            transcriptRevision: 4,
            before: 1490,
          },
        }),
        runtime: undefined,
      },
      null,
    );
    expect(preview.prompt).toBeNull();
    expect(preview.toolCount).toBeNull();
  });

  it('is empty for a chat with no messages', () => {
    expect(
      deriveChatTabPreview({ tab: chatTab(), runtime: undefined }, null),
    ).toEqual({
      prompt: null,
      replies: [],
      status: { kind: 'empty' },
      toolCount: null,
    });
  });

  it('counts tool calls Codex stores on system rows', () => {
    const preview = deriveChatTabPreview(
      {
        tab: chatTab({
          messages: [
            message('cu1', 'user', [text('Fix the build')]),
            message('cs1', 'system', [toolUse('c1')]),
            message('cs2', 'system', [toolUse('c2'), toolUse('c3')]),
            message('ca1', 'assistant', [text('The build passes now.')]),
          ],
        }),
        runtime: undefined,
      },
      null,
    );
    expect(preview.toolCount).toBe(3);
    expect(preview.replies).toEqual(['The build passes now.']);
  });

  it('never takes a sub-agent instruction for the chat prompt', () => {
    const preview = deriveChatTabPreview(
      {
        tab: chatTab({
          messages: [
            ...TURN,
            message('d1', 'user', [text('Sub-agent: list the icons')], {
              parentBlockId: 'codex-agent-1',
            }),
            message('d2', 'user', [text('Sub-agent: read the manifest')], {
              parentToolUseId: 't2',
            }),
          ],
          turnEnds: { u2: { outcome: 'failed', endedAt: T0 + 9_000 } },
        }),
        runtime: undefined,
      },
      null,
    );
    expect(preview).toEqual({
      prompt: 'Tighten the Feed sidebar spacing',
      replies: ['I will start with the rows.', 'Rows are tighter now.'],
      status: { kind: 'failed', endedAt: T0 + 9_000 },
      toolCount: 2,
    });
  });

  it('skips hidden deliveries when finding the prompt', () => {
    const preview = deriveChatTabPreview(
      {
        tab: chatTab({
          messages: [
            ...TURN,
            message('h1', 'user', [text('Internal continuation')], {
              hidden: true,
            }),
          ],
        }),
        runtime: undefined,
      },
      null,
    );
    expect(preview.prompt).toBe('Tighten the Feed sidebar spacing');
  });
});

describe('createChatTabHoverCardRenderer', () => {
  let container: HTMLDivElement;
  let root: Root;
  const renderCard = createChatTabHoverCardRenderer('project-1', 'worktree-1');
  const panelTab = {
    panelId: 'panel-chat-chat-2',
    kind: 'chat',
    title: 'Second',
    instance: { chatTabId: 'chat-2' },
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    useChatStore.setState({
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [chatTab({ messages: TURN.slice(0, 4), status: 'streaming' })],
        },
      },
      pendingQuestions: {},
      pendingApprovals: {},
      pendingPlanExits: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function mount(node: ReactNode): void {
    act(() => root.render(<>{node}</>));
  }

  const status = (): string =>
    container.querySelector('[data-testid="chat-tab-preview-status"]')
      ?.textContent ?? '';

  it('renders the hovered chat and follows it live', () => {
    mount(renderCard(panelTab));
    expect(
      container.querySelector('[data-testid="chat-tab-preview-prompt"]')
        ?.textContent,
    ).toBe('Tighten the Feed sidebar spacing');
    expect(status()).toMatch(/^Working….*1 tool$/);

    act(() => {
      useChatStore.setState({
        worktreeChats: {
          'project-1/worktree-1': {
            activeTabId: 'chat-1',
            tabs: [chatTab({ messages: TURN, status: 'idle' })],
          },
        },
      });
      chatStoreRenderView.flush();
    });
    expect(status()).toMatch(/^Finished.*2 tools$/);
    expect(
      container.querySelectorAll('[data-testid="chat-tab-preview-reply"] p'),
    ).toHaveLength(2);
  });

  it('keeps the chat warm while open and catches up a stale transcript', () => {
    jest.mocked(warmUpChat).mockClear();
    jest.mocked(noteChatIntent).mockClear();
    mount(renderCard(panelTab));
    const ref = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-2',
    };
    expect(warmUpChat).toHaveBeenCalledWith(ref);
    expect(noteChatIntent).not.toHaveBeenCalled();

    act(() => {
      useChatStore.setState({
        worktreeChats: {
          'project-1/worktree-1': {
            activeTabId: 'chat-1',
            tabs: [
              chatTab({
                messages: TURN.slice(0, 4),
                status: 'streaming',
                transcriptStale: true,
              }),
            ],
          },
        },
      });
      chatStoreRenderView.flush();
    });
    expect(noteChatIntent).toHaveBeenCalledWith(
      { kind: 'chat', ...ref },
      'focus',
    );
  });

  it('says Question waiting while the chat asks something', () => {
    useChatStore.setState({
      pendingQuestions: {
        q1: {
          requestId: 'q1',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-2',
          questions: [],
        },
      },
    });
    mount(renderCard(panelTab));
    expect(status()).toMatch(/^Question waiting/);
  });

  it('renders nothing for tabs that are not chats', () => {
    expect(
      renderCard({ panelId: 'b', kind: 'browser', title: 'Docs' }),
    ).toBeNull();
  });
});
