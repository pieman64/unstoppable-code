/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import type { PendingQuestion } from '@/stores/chatStore';
import type { TurnGroup, TurnMessage } from '../types';
import { TurnGroupRenderer } from '../TurnGroupRenderer';
import type * as ChatRenderStoresTestUtils from '@/test-utils/chatRenderStores';

jest.mock('@/stores/chatStore', () => ({
  useChatStore: (select: (state: unknown) => unknown): unknown => select({}),
  ...jest
    .requireActual<
      typeof ChatRenderStoresTestUtils
    >('@/test-utils/chatRenderStores')
    .mockChatRenderHooks(() => ({})),
}));
jest.mock('../ChatMessageItem', () => ({
  ChatMessageItem: ({
    message,
    turnExpanded,
  }: {
    message: TurnMessage;
    turnExpanded?: boolean;
  }): JSX.Element => (
    <div
      data-message-id={message.id}
      data-turn-expanded={turnExpanded ? 'true' : 'false'}
    >
      {message.blocks.some(
        (block) => block.type === 'text' && block.asyncQuestion,
      ) ? (
        <textarea aria-label="Question input" defaultValue="" />
      ) : (
        message.id
      )}
    </div>
  ),
}));
jest.mock('../TurnTimer', () => ({ TurnTimer: (): null => null }));
jest.mock('../TurnFeedbackHosts', () => ({
  TurnFeedbackSlot: (): null => null,
}));
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

it('keeps question input mounted across completion, toggles, and optimistic answer reservation', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const group: TurnGroup = {
    kind: 'turn-group',
    isComplete: false,
    userMessage: {
      id: 'user',
      role: 'user',
      timestamp: 1,
      blocks: [{ type: 'text', text: 'Ask me' }],
    },
    assistantMessages: [
      {
        id: 'question',
        role: 'assistant',
        timestamp: 2,
        blocks: [
          {
            type: 'text',
            text: 'Scope?',
            asyncQuestion: {
              requestId: 'question',
              questions: [{ title: 'Scope?', options: null }],
            },
          },
        ],
      },
      {
        id: 'tool',
        role: 'assistant',
        timestamp: 3,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'tool',
            toolName: 'Bash',
            input: '{}',
          },
        ],
      },
      {
        id: 'final',
        role: 'assistant',
        timestamp: 4,
        blocks: [{ type: 'text', text: 'Done' }],
      },
    ],
    timerMessage: {
      id: 'timer',
      role: 'system',
      timestamp: 1,
      blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: null }],
    },
  };
  const question: PendingQuestion = {
    requestId: 'question',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    delivery: 'async',
    questions: [{ question: 'Scope?', options: [], allowOther: true }],
  };
  const render = (complete: boolean, pending = question): void => {
    act(() =>
      root.render(
        <TurnGroupRenderer
          group={{ ...group, isComplete: complete }}
          chatPendingQuestions={[pending]}
          isLastTurnGroup
          isLastForkableTurnGroup
        />,
      ),
    );
  };
  try {
    render(false);
    const input = host.querySelector('textarea');
    expect(input).not.toBeNull();
    if (!input) throw new Error('Missing question input');
    input.value = 'Keep this answer';
    render(true);
    expect(host.querySelector('textarea')).toBe(input);
    expect(
      host
        .querySelector('[data-message-id="final"]')
        ?.getAttribute('data-turn-expanded'),
    ).toBe('false');
    const toggle = host.querySelector<HTMLButtonElement>(
      '[aria-label^="Agent steps:"]',
    );
    if (!toggle) throw new Error('Missing turn toggle');
    act(() => toggle.click());
    expect(
      host
        .querySelector('[data-message-id="final"]')
        ?.getAttribute('data-turn-expanded'),
    ).toBe('true');
    act(() => toggle.click());
    for (let index = 0; index < 2; index += 1) {
      act(() => toggle.click());
      expect(host.querySelector('textarea')).toBe(input);
      expect(input.value).toBe('Keep this answer');
    }
    // The actual question card owns in-flight/error state and renders nothing
    // after success. Its parent must not unmount it on optimistic reservation.
    render(true, { ...question, answeredAt: 5 });
    expect(host.querySelector('textarea')).toBe(input);
    render(true);
    expect(host.querySelector('textarea')).toBe(input);
    expect(input.value).toBe('Keep this answer');
    render(true, { ...question, dismissedAt: 6 });
    expect(host.querySelector('textarea')).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

// Failed tool calls retain individual rows after compact tool calls graduate.
// These tests exercise progressive mounting and retained identity for those rows.
it('progressively mounts a large completed turn without deferring its final rows indefinitely', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const frameCallbacks: FrameRequestCallback[] = [];
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback): number => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    },
  });
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    value: (): void => undefined,
  });
  const assistantMessages: TurnMessage[] = Array.from(
    { length: 130 },
    (_, index) => ({
      id: `step-${index}`,
      role: 'assistant' as const,
      timestamp: index + 2,
      blocks:
        index === 129
          ? [{ type: 'text' as const, text: `Step ${index}` }]
          : [
              {
                type: 'tool_use' as const,
                toolUseId: `tool-${index}`,
                toolName: 'Read',
                input: '{}',
                result: { output: 'Retry required', isError: true },
              },
            ],
    }),
  );
  const largeGroup: TurnGroup = {
    kind: 'turn-group',
    isComplete: true,
    userMessage: {
      id: 'large-user',
      role: 'user',
      timestamp: 1,
      blocks: [{ type: 'text', text: 'Show every step' }],
    },
    assistantMessages,
    timerMessage: {
      id: 'large-timer',
      role: 'system',
      timestamp: 200,
      blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 200 }],
    },
  };
  try {
    act(() => {
      root.render(
        <TurnGroupRenderer
          group={largeGroup}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
        />,
      );
    });
    const toggle = host.querySelector<HTMLButtonElement>(
      '[aria-label^="Agent steps:"]',
    );
    if (!toggle) throw new Error('Missing large-turn toggle');

    act(() => toggle.click());
    const initialCount = host.querySelectorAll(
      '[data-message-id^="step-"]',
    ).length;
    expect(initialCount).toBeGreaterThan(0);
    // Eight progressive rows plus the always-retained final response keeps
    // each expansion quantum below the renderer's 100 ms responsiveness cap.
    expect(initialCount).toBeLessThanOrEqual(9);
    expect(host.querySelector('[data-message-id="step-100"]')).toBeNull();
    const mountedStep = host.querySelector('[data-message-id="step-0"]');
    expect(mountedStep).not.toBeNull();

    while (frameCallbacks.length > 0) {
      const callback = frameCallbacks.shift();
      if (callback) act(() => callback(performance.now()));
    }
    expect(host.querySelectorAll('[data-message-id^="step-"]')).toHaveLength(
      assistantMessages.length,
    );

    const prependedMessages: TurnMessage[] = Array.from(
      { length: 40 },
      (_, index) => ({
        id: `older-${index}`,
        role: 'assistant' as const,
        timestamp: index - 40,
        blocks: [
          {
            type: 'tool_use' as const,
            toolUseId: `older-tool-${index}`,
            toolName: 'Read',
            input: '{}',
            result: { output: 'Retry required', isError: true },
          },
        ],
      }),
    );
    act(() => {
      root.render(
        <TurnGroupRenderer
          group={{
            ...largeGroup,
            assistantMessages: [...prependedMessages, ...assistantMessages],
          }}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
        />,
      );
    });
    expect(host.querySelector('[data-message-id="step-0"]')).toBe(mountedStep);
    expect(
      host.querySelectorAll('[data-message-id^="older-"]').length,
    ).toBeLessThanOrEqual(8);

    while (frameCallbacks.length > 0) {
      const callback = frameCallbacks.shift();
      if (callback) act(() => callback(performance.now()));
    }
    expect(host.querySelectorAll('[data-message-id^="step-"]')).toHaveLength(
      assistantMessages.length,
    );
    expect(host.querySelector('[data-message-id="step-100"]')).not.toBeNull();

    const searchedStep = host.querySelector('[data-message-id="step-100"]');
    act(() => {
      root.render(
        <TurnGroupRenderer
          group={{
            ...largeGroup,
            assistantMessages: [...prependedMessages, ...assistantMessages],
          }}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
          searchMessageId="step-100"
        />,
      );
    });
    act(() => {
      root.render(
        <TurnGroupRenderer
          group={{
            ...largeGroup,
            assistantMessages: [...prependedMessages, ...assistantMessages],
          }}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
        />,
      );
    });
    expect(host.querySelectorAll('[data-message-id^="step-"]')).toHaveLength(
      assistantMessages.length,
    );
    expect(host.querySelector('[data-message-id="step-100"]')).toBe(
      searchedStep,
    );
  } finally {
    act(() => root.unmount());
    host.remove();
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: originalRequestAnimationFrame,
    });
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
      value: originalCancelAnimationFrame,
    });
  }
});

it('preserves mounted rows when an expanded completed turn crosses the progressive threshold', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const messages: TurnMessage[] = Array.from({ length: 100 }, (_, index) => ({
    id: `threshold-${index}`,
    role: 'assistant' as const,
    timestamp: index + 2,
    blocks:
      index === 99
        ? [{ type: 'text' as const, text: `Step ${index}` }]
        : [
            {
              type: 'tool_use' as const,
              toolUseId: `threshold-tool-${index}`,
              toolName: 'Read',
              input: '{}',
              result: { output: 'Retry required', isError: true },
            },
          ],
  }));
  const group: TurnGroup = {
    kind: 'turn-group',
    isComplete: true,
    userMessage: {
      id: 'threshold-user',
      role: 'user',
      timestamp: 1,
      blocks: [{ type: 'text', text: 'Cross the threshold' }],
    },
    assistantMessages: messages.slice(0, 99),
    timerMessage: {
      id: 'threshold-timer',
      role: 'system',
      timestamp: 200,
      blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 200 }],
    },
  };
  try {
    act(() => {
      root.render(
        <TurnGroupRenderer
          group={group}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
        />,
      );
    });
    const toggle = host.querySelector<HTMLButtonElement>(
      '[aria-label^="Agent steps:"]',
    );
    if (!toggle) throw new Error('Missing threshold-turn toggle');
    act(() => toggle.click());
    const firstRow = host.querySelector('[data-message-id="threshold-0"]');
    expect(
      host.querySelectorAll(
        '[data-message-id^="threshold-"][data-turn-expanded="true"]',
      ),
    ).toHaveLength(99);

    act(() => {
      root.render(
        <TurnGroupRenderer
          group={{ ...group, assistantMessages: messages }}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
        />,
      );
    });
    expect(
      host.querySelectorAll(
        '[data-message-id^="threshold-"][data-turn-expanded="true"]',
      ),
    ).toHaveLength(100);
    expect(host.querySelector('[data-message-id="threshold-0"]')).toBe(
      firstRow,
    );
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
