/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import type { TurnDiffData } from '@canopy/desktop-shared/types';
import type { TurnGroup, TurnMessage } from '../types';
import { TurnGroupRenderer } from '../TurnGroupRenderer';
import type * as ChatRenderStoresTestUtils from '@/test-utils/chatRenderStores';

const mockForkTab = jest.fn();
jest.mock('@/stores/chatStore', () => ({
  useChatStore: (select: (state: unknown) => unknown): unknown =>
    select({ forkTab: mockForkTab }),
  ...jest
    .requireActual<
      typeof ChatRenderStoresTestUtils
    >('@/test-utils/chatRenderStores')
    .mockChatRenderHooks(() => ({})),
}));
jest.mock('../ChatMessageItem', () => ({
  ChatMessageItem: ({ message }: { message: TurnMessage }): JSX.Element => (
    <div>{message.id}</div>
  ),
}));
jest.mock('../TurnTimer', () => ({
  TurnTimer: ({
    showForkAction,
    onFork,
  }: {
    showForkAction?: boolean;
    onFork?: () => void;
  }): JSX.Element | null =>
    showForkAction && onFork ? (
      <button type="button" data-testid="fork" onClick={onFork} />
    ) : null,
}));
jest.mock('../TurnFeedbackHosts', () => ({
  TurnFeedbackSlot: (): null => null,
}));
jest.mock('../TurnDiffSummary', () => ({
  TurnDiffSummary: ({ turnDiff }: { turnDiff?: TurnDiffData }): JSX.Element => (
    <div data-testid="turn-diff" data-files={turnDiff?.files.length ?? 0} />
  ),
}));
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const turnDiff: TurnDiffData = {
  files: [
    { path: 'report.md', status: 'modified', insertions: 2, deletions: 0 },
  ],
  totalInsertions: 2,
  capturedAt: 1,
  totalDeletions: 0,
  treeRefs: [{ startTree: 'a', endTree: 'b' }],
};

function group(id: string, head: TurnMessage['blocks'][number]): TurnGroup {
  return {
    kind: 'turn-group',
    isComplete: true,
    userMessage: {
      id,
      role: head.type === 'text' ? 'user' : 'system',
      timestamp: 1,
      blocks: [head],
    },
    assistantMessages: [
      {
        id: `${id}-final`,
        role: 'assistant',
        timestamp: 2,
        blocks: [{ type: 'text', text: 'Done' }],
      },
    ],
    timerMessage: {
      id: `${id}-timer`,
      role: 'system',
      timestamp: 3,
      blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 3 }],
    },
  };
}

function render(element: JSX.Element): { host: HTMLElement; done: () => void } {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    done: (): void => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

it("shows a prompt's diff on its continuation, not on the prompt's own turn", () => {
  const prompt = render(
    <TurnGroupRenderer
      group={group('u1', { type: 'text', text: 'Load Slack' })}
      turnDiff={turnDiff}
      hideTurnDiffSummary
      chatPendingQuestions={[]}
      isLastTurnGroup={false}
      isLastForkableTurnGroup={false}
    />,
  );
  expect(prompt.host.querySelector('[data-testid="turn-diff"]')).toBeNull();
  prompt.done();

  const continuation = render(
    <TurnGroupRenderer
      group={group('c1', {
        type: 'wake_boundary',
        turnId: 'c1',
        spawningUserMessageId: 'u1',
        toolsLoaded: true,
      })}
      turnDiff={turnDiff}
      resetTurnId="u1"
      chatPendingQuestions={[]}
      isLastTurnGroup
      isLastForkableTurnGroup
    />,
  );
  expect(
    continuation.host
      .querySelector('[data-testid="turn-diff"]')
      ?.getAttribute('data-files'),
  ).toBe('1');
  continuation.done();
});

it("counts a continuation step its prompt's safety receipt denied as blocked", () => {
  const continuation = group('c1', {
    type: 'wake_boundary',
    turnId: 'c1',
    spawningUserMessageId: 'u1',
    toolsLoaded: true,
  });
  continuation.assistantMessages = [
    {
      id: 'push',
      role: 'assistant',
      timestamp: 2,
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'push-1',
          toolName: 'Bash',
          input: JSON.stringify({ command: 'git push --force' }),
          result: { output: 'denied', isError: true },
        },
      ],
    },
    {
      id: 'receipt',
      role: 'system',
      timestamp: 3,
      blocks: [
        {
          type: 'approval_safety_denied_info',
          receiptId: 'receipt',
          timestamp: 3,
          reason: 'force-push',
          command: 'git push --force',
          mode: 'ask',
          toolUseId: 'push-1',
          // The continuation runs under its prompt, so its receipts name it.
          turnUserMessageId: 'u1',
        },
      ],
    },
    {
      id: 'answer',
      role: 'assistant',
      timestamp: 4,
      blocks: [{ type: 'text', text: 'The push was denied.' }],
    },
  ];
  const view = render(
    <TurnGroupRenderer
      group={continuation}
      chatPendingQuestions={[]}
      isLastTurnGroup
      isLastForkableTurnGroup
    />,
  );
  expect(view.host.textContent).toMatch(/1 blocked/i);
  expect(view.host.textContent).not.toMatch(/failed/i);
  view.done();
});

it('forks the original reply snapshot while its tools-loaded continuation runs', () => {
  mockForkTab.mockClear();
  const view = render(
    <TurnGroupRenderer
      group={group('u1', { type: 'text', text: 'Load Slack' })}
      chatId="chat-1"
      sourceSdkSessionId="session-1"
      continuationActive
      chatPendingQuestions={[]}
      isLastTurnGroup={false}
      isLastForkableTurnGroup={false}
    />,
  );
  act(() =>
    view.host.querySelector<HTMLButtonElement>('[data-testid="fork"]')?.click(),
  );
  expect(mockForkTab).toHaveBeenCalledWith('chat-1', undefined, {
    forkAfterUserMessageId: 'u1',
  });
  view.done();
});
