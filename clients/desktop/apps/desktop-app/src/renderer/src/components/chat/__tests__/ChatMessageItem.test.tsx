import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentProps, JSX } from 'react';
import type * as UiSharedComponents from '@canopy/ui-shared/components';
import { ChatMessageItem } from '../ChatMessageItem';
import type { DisplayMessage } from '../types';

const mockWakeProps: Array<
  ComponentProps<typeof UiSharedComponents.WakeTurnBoundary>
> = [];
jest.mock('@canopy/ui-shared/components', () => ({
  ...jest.requireActual<typeof UiSharedComponents>(
    '@canopy/ui-shared/components',
  ),
  WakeTurnBoundary: (
    props: ComponentProps<typeof UiSharedComponents.WakeTurnBoundary>,
  ): null => {
    mockWakeProps.push(props);
    return null;
  },
}));

jest.mock('../ChatBlockRenderer', () => ({
  ChatBlockRenderer: ({
    isSystemMessage,
    progressiveMarkdown,
  }: {
    isSystemMessage?: boolean;
    progressiveMarkdown?: boolean;
  }): JSX.Element => (
    <span
      data-system-message={isSystemMessage ? 'true' : 'false'}
      data-progressive-markdown={progressiveMarkdown ? 'true' : 'false'}
    >
      Answer
    </span>
  ),
}));

jest.mock('../UserBubble', () => ({
  UserBubble: (): JSX.Element => <div data-role="user">Question</div>,
}));

describe('ChatMessageItem', () => {
  it('progressively mounts assistant markdown only inside an expanded turn', () => {
    const message: DisplayMessage = {
      id: 'assistant-report',
      role: 'assistant',
      timestamp: 5,
      blocks: [{ type: 'text', text: 'Large report' }],
    };

    const normal = renderToStaticMarkup(
      <ChatMessageItem
        message={message}
        chatPendingQuestions={[]}
        turnExpanded
      />,
    );
    const collapsed = renderToStaticMarkup(
      <ChatMessageItem message={message} chatPendingQuestions={[]} />,
    );
    const searchExpanded = renderToStaticMarkup(
      <ChatMessageItem
        message={message}
        chatPendingQuestions={[]}
        turnExpanded
        forceSearchExpanded
      />,
    );

    expect(normal).toContain('data-progressive-markdown="true"');
    expect(collapsed).toContain('data-progressive-markdown="false"');
    expect(searchExpanded).toContain('data-progressive-markdown="false"');
  });

  it('renders submitted async answers through the special block renderer, without a user bubble', () => {
    const message: DisplayMessage = {
      id: 'answer',
      role: 'user',
      timestamp: 5,
      blocks: [
        {
          type: 'text',
          text: 'Q: Which scope?\nA: Full',
          ...{
            asyncQuestionAnswer: {
              requestId: 'request',
              startsTurn: false,
              answers: [
                { question: 'Which scope?', selectedOptions: ['Full'] },
              ],
            },
          },
        },
      ],
    };
    const html = renderToStaticMarkup(
      <ChatMessageItem message={message} chatPendingQuestions={[]} />,
    );
    expect(html).toContain('Answer');
    expect(html).not.toContain('Question</div>');
  });

  it('renders nothing for a message whose blocks would all be invisible', () => {
    // Streaming can leave a message holding only empty text/thinking blocks.
    // Mounting a wrapper for it is not merely wasteful: the transcript's
    // `space-y` rules give even an empty element a margin slot, which widens
    // the bubble-to-reply gap in whichever turn happens to carry one.
    const message: DisplayMessage = {
      id: 'assistant-empty',
      role: 'assistant',
      blocks: [
        { type: 'text', text: '   ' },
        { type: 'thinking', text: '' },
      ],
      timestamp: 1,
    };

    const html = renderToStaticMarkup(
      <ChatMessageItem message={message} chatPendingQuestions={[]} />,
    );

    expect(html).toBe('');
  });

  it('still renders when only some blocks are empty', () => {
    const message: DisplayMessage = {
      id: 'assistant-mixed',
      role: 'assistant',
      blocks: [
        { type: 'thinking', text: '' },
        { type: 'text', text: 'Answer' },
      ],
      timestamp: 1,
    };

    const html = renderToStaticMarkup(
      <ChatMessageItem message={message} chatPendingQuestions={[]} />,
    );

    expect(html).toContain('data-role="assistant"');
  });

  it('marks assistant responses as selectable transcript content', () => {
    const message: DisplayMessage = {
      id: 'assistant-1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Answer' }],
      timestamp: 1,
    };

    const html = renderToStaticMarkup(
      <ChatMessageItem message={message} chatPendingQuestions={[]} />,
    );

    expect(html).toContain('data-role="assistant"');
    expect(html).toContain('data-system-message="false"');
  });

  it('marks system transcript blocks so connection failures can offer recovery', () => {
    const message: DisplayMessage = {
      id: 'system-1',
      role: 'system',
      blocks: [{ type: 'text', text: 'Claude is not authenticated.' }],
      timestamp: 1,
    };

    const html = renderToStaticMarkup(
      <ChatMessageItem message={message} chatPendingQuestions={[]} />,
    );

    expect(html).toContain('data-role="system"');
    expect(html).toContain('data-system-message="true"');
  });
});

describe('ChatMessageItem approval_resolution_info', () => {
  // CAN-3083: the approval receipt is chrome, not conversation, so it renders
  // bare through the block renderer rather than inside a message wrapper —
  // the same treatment `revert_info` and `hook_info` get. This is the
  // `LAYOUT_BLOCK_TYPES` membership assertion at its call site.
  it('renders as a bare system line, not a wrapped message', () => {
    const message: DisplayMessage = {
      id: 'approval-resolution',
      role: 'system',
      timestamp: 5,
      blocks: [
        {
          type: 'approval_resolution_info',
          timestamp: 5,
          resolvedBy: 'mode-change',
          mode: 'full-access',
          previousMode: 'ask',
          titles: ['ls apps/web/src/app/'],
        },
      ],
    };

    const html = renderToStaticMarkup(
      <ChatMessageItem message={message} chatPendingQuestions={[]} />,
    );

    expect(html).toBe(
      '<span data-system-message="true" data-progressive-markdown="false">Answer</span>',
    );
  });
});

describe('ChatMessageItem wake boundary', () => {
  it('passes the event flag and links to the call that started the task', () => {
    const message: DisplayMessage = {
      id: 'wake:timer:wake',
      role: 'system',
      timestamp: 5,
      blocks: [
        {
          type: 'wake_boundary',
          turnId: 'wake',
          taskLabel: 'build errors',
          spawningUserMessageId: 'user-1',
          spawningToolUseId: 'tool-1',
          taskEvent: true,
        },
      ],
    };
    const onShowSpawningCall = jest.fn();
    mockWakeProps.length = 0;

    renderToStaticMarkup(
      <ChatMessageItem
        message={message}
        chatPendingQuestions={[]}
        onShowSpawningCall={onShowSpawningCall}
      />,
    );

    const props = mockWakeProps.at(-1);
    expect(props).toMatchObject({ taskLabel: 'build errors', event: true });
    props?.onShowSpawningTurn?.();
    expect(onShowSpawningCall).toHaveBeenCalledWith({
      toolUseId: 'tool-1',
      userMessageId: 'user-1',
    });
  });

  it('offers no link when the transcript holds neither the call nor its prompt', () => {
    mockWakeProps.length = 0;
    renderToStaticMarkup(
      <ChatMessageItem
        message={{
          id: 'wake:timer:wake',
          role: 'system',
          timestamp: 5,
          blocks: [{ type: 'wake_boundary', turnId: 'wake' }],
        }}
        chatPendingQuestions={[]}
        onShowSpawningCall={jest.fn()}
      />,
    );
    expect(mockWakeProps.at(-1)).toMatchObject({ event: false });
    expect(mockWakeProps.at(-1)?.onShowSpawningTurn).toBeUndefined();
  });
});
