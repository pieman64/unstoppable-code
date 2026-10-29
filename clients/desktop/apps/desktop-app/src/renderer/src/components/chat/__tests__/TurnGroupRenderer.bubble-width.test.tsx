/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import type { TurnGroup, TurnMessage } from '../types';
import { TurnGroupRenderer } from '../TurnGroupRenderer';
import type * as ChatRenderStoresTestUtils from '@/test-utils/chatRenderStores';
import type * as UiSharedComponents from '@canopy/ui-shared/components';

let mockEarlyAccess = true;
let mockIsPhone = true;

jest.mock('@/stores/labsExperimentsStore', () => ({
  useLabsExperimentEnabled: (): boolean => mockEarlyAccess,
}));
jest.mock('@canopy/ui-shared/components', () => ({
  ...jest.requireActual<typeof UiSharedComponents>(
    '@canopy/ui-shared/components',
  ),
  useIsPhone: (): boolean => mockIsPhone,
}));
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
    <div data-role={message.role}>{message.id}</div>
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

// jsdom has no `CSS.escape`; the ids here need no escaping.
if (typeof CSS === 'undefined') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string): string => value },
  });
}

const resizeCallbacks: ResizeObserverCallback[] = [];
let bubbleWidth = 240;

beforeEach(() => {
  mockEarlyAccess = true;
  mockIsPhone = true;
  bubbleWidth = 240;
  resizeCallbacks.length = 0;
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    },
  });
  jest
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement): DOMRect {
      const width = this.dataset.role === 'user' ? bubbleWidth : 0;
      return new DOMRect(0, 0, width, 40);
    });
});

afterEach(() => {
  jest.restoreAllMocks();
});

function completedTurn(): TurnGroup {
  return {
    kind: 'turn-group',
    isComplete: true,
    userMessage: {
      id: 'user',
      role: 'user',
      timestamp: 1,
      blocks: [{ type: 'text', text: 'Prepare the report' }],
    },
    assistantMessages: [
      {
        id: 'tool',
        role: 'assistant',
        timestamp: 2,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'tool',
            toolName: 'Read',
            input: '{}',
            result: { output: '', isError: false },
          },
        ],
      },
      {
        id: 'final',
        role: 'assistant',
        timestamp: 3,
        blocks: [{ type: 'text', text: 'Done' }],
      },
    ],
    timerMessage: {
      id: 'timer',
      role: 'system',
      timestamp: 1,
      blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 4 }],
    },
  };
}

function renderBanner(): {
  banner: HTMLButtonElement;
  cleanup: () => void;
} {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <div data-chat-turn-group="user">
        <TurnGroupRenderer
          group={completedTurn()}
          chatPendingQuestions={[]}
          isLastTurnGroup
        />
      </div>,
    ),
  );
  const banner = host.querySelector<HTMLButtonElement>(
    '[aria-label^="Agent steps:"]',
  );
  if (!banner) throw new Error('Missing steps banner');
  return {
    banner,
    cleanup: (): void => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

it('matches the steps banner to the user bubble width in a narrow early-access chat', () => {
  const { banner, cleanup } = renderBanner();
  try {
    expect(banner.style.width).toBe('240px');
    // A short prompt's bubble never squeezes the banner below its chips.
    expect(banner.style.minWidth).toBe('max-content');
    expect(banner.className).toContain('ml-auto');

    bubbleWidth = 180;
    act(() => {
      for (const callback of resizeCallbacks) {
        callback([], {
          observe: () => undefined,
          unobserve: () => undefined,
          disconnect: () => undefined,
        });
      }
    });
    expect(banner.style.width).toBe('180px');
  } finally {
    cleanup();
  }
});

it.each([['the chat is wide', true, false]])(
  'keeps the banner full width when %s',
  (_label, earlyAccess, isPhone) => {
    mockEarlyAccess = earlyAccess;
    mockIsPhone = isPhone;
    const { banner, cleanup } = renderBanner();
    try {
      expect(banner.style.width).toBe('');
      expect(banner.style.minWidth).toBe('');
      expect(banner.className).toContain('w-full');
    } finally {
      cleanup();
    }
  },
);
