/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatLookProvider } from '@canopy/ui-shared/components';
import type { TurnGroup } from '../types';
import { TurnGroupRenderer } from '../TurnGroupRenderer';
import type * as ChatRenderStoresTestUtils from '@/test-utils/chatRenderStores';

const mockChatState = {
  selectedWorktree: { projectId: 'project', worktreeId: 'worktree' },
  worktreeChats: {
    'project/worktree': {
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          messages: [],
          queuedMessages: [],
          modelRoutingStartedAt: 1,
        },
      ],
    },
  },
};

jest.mock('@/stores/chatStore', () => ({
  useChatStore: (select: (state: unknown) => unknown): unknown =>
    select(mockChatState),
  ...jest
    .requireActual<
      typeof ChatRenderStoresTestUtils
    >('@/test-utils/chatRenderStores')
    .mockChatRenderHooks(() => mockChatState),
}));
jest.mock('../TurnTimer', () => ({
  TurnTimer: ({ workingLabel }: { workingLabel?: string }): JSX.Element => (
    <div data-testid="turn-timer">{workingLabel}</div>
  ),
}));
jest.mock('../TurnFeedbackHosts', () => ({
  TurnFeedbackSlot: (): null => null,
}));
Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  value: class {
    observe(): void {}
    disconnect(): void {}
  },
});
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const group: TurnGroup = {
  kind: 'turn-group',
  isComplete: false,
  userMessage: {
    id: 'user',
    role: 'user',
    timestamp: 1,
    blocks: [{ type: 'text', text: 'Pick a model for this.' }],
  },
  assistantMessages: [],
  timerMessage: {
    id: 'timer',
    role: 'system',
    timestamp: 1,
    blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: null }],
  },
};

afterEach(() => {
  jest.useRealTimers();
});

// Auto routing runs before the provider turn. A first send from Home opens
// with "Starting…", but once routing is visibly under way its status names
// the wait and keeps the turn's Stop target in view (CAN-4742 follow-up).
it.each(['classic', 'clean'] as const)(
  'shows "Choosing a model…" instead of "Starting…" while Auto routes a first send under the %s look',
  (look) => {
    jest.useFakeTimers();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          <ChatLookProvider value={look}>
            <TurnGroupRenderer
              chatId="chat"
              group={group}
              pendingTimer
              starting
              chatPendingQuestions={[]}
              isLastTurnGroup
              isLastForkableTurnGroup
            />
          </ChatLookProvider>,
        ),
      );
      expect(
        host.querySelector('[data-testid="turn-starting-status"]'),
      ).not.toBeNull();
      act(() => {
        jest.advanceTimersByTime(300);
      });
      expect(host.textContent).toContain('Choosing a model…');
      expect(
        host.querySelector('[data-testid="turn-starting-status"]'),
      ).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);
