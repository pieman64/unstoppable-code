/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { computeTurnSummary } from '@canopy/desktop-shared/lib/turn-utils';
import type { TranscriptTurnSummary } from '@canopy/agent-transcript/transcript-storage';
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
  ChatMessageItem: ({ message }: { message: TurnMessage }): JSX.Element => (
    <div>{message.id}</div>
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

const group: TurnGroup = {
  kind: 'turn-group',
  isComplete: true,
  userMessage: {
    id: 'user',
    role: 'user',
    timestamp: 1,
    blocks: [{ type: 'text', text: 'Ask me' }],
  },
  assistantMessages: [
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
    timestamp: 5,
    blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 5 }],
  },
};

/** A resumed turn whose summary still says it is incomplete on disk. */
const partiallyLoadedTurn: TranscriptTurnSummary = {
  id: 'user',
  start: 10,
  end: 20,
  complete: false,
  summary: computeTurnSummary([]),
  finalMessageIds: ['final'],
  before: 15,
};

it('refreshes a completed-but-stale turn once, keyed by the owning turn, even when the callback identity changes', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const calls: string[] = [];
  const render = (): void => {
    act(() => {
      root.render(
        <TurnGroupRenderer
          group={group}
          transcriptTurn={partiallyLoadedTurn}
          // A fresh closure per render, as a parent re-rendering during a
          // streaming turn produces. The refresh effect must not re-run on
          // identity alone.
          onLoadHistory={(userMessageId: string): void => {
            calls.push(userMessageId);
          }}
          chatPendingQuestions={[]}
          isLastTurnGroup
          isLastForkableTurnGroup
        />,
      );
    });
  };
  render();
  expect(calls).toEqual(['user']);
  render();
  render();
  expect(calls).toEqual(['user']);
  act(() => {
    root.unmount();
  });
  host.remove();
});
