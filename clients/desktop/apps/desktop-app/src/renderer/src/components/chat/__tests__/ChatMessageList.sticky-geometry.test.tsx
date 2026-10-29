/**
 * @jest-environment jsdom
 *
 * The sticky user message publishes its pinned height so each completed
 * turn's summary chip can stick right below it. The value is a custom
 * property, and custom properties inherit: written on the section, every
 * element of the section (a whole turn of rendered Markdown) is restyled
 * whenever a header is measured. It is written on the chips instead, which
 * are the only consumers.
 */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatMessageList } from '../ChatMessageList';
import { PinUserMessagesContext } from '../pin-user-messages-context';
import type { ChatMessage } from '@/stores/chatStore';

import type * as ChatRenderStoresTestUtils from '@/test-utils/chatRenderStores';
import type * as StickyTurnSummaryModule from '../StickyTurnSummary';

const mockChatId = 'chat-sticky-geometry';
let mockRenderChips = true;
// `markup` mirrors the chip's rendered DOM; `component` uses the shared chip
// wrapper that also picks up a height published before it mounted.
let mockChipKind: 'markup' | 'component' = 'markup';

jest.mock('@/stores/chatStore', () => {
  const mockState = (): unknown => ({
    selectedWorktree: {
      projectId: 'project-sticky-geometry',
      worktreeId: 'worktree-sticky-geometry',
    },
    worktreeChats: {
      'project-sticky-geometry/worktree-sticky-geometry': {
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
jest.mock('../TurnGroupRenderer', () => ({
  TurnGroupRenderer: ({
    stickyTurnSummary,
  }: {
    stickyTurnSummary?: boolean;
  }): JSX.Element => {
    if (!stickyTurnSummary || !mockRenderChips) return <div />;
    if (mockChipKind === 'markup') {
      return (
        <div>
          <div
            className="sticky z-10"
            style={{
              top: 'calc(var(--chat-sticky-user-height, 0px) + 0.5rem)',
            }}
            data-testid="sticky-turn-summary"
          />
        </div>
      );
    }
    const { StickyTurnSummary } = jest.requireActual<
      typeof StickyTurnSummaryModule
    >('../StickyTurnSummary');
    return (
      <div>
        <StickyTurnSummary>
          <span>Agent steps</span>
        </StickyTurnSummary>
      </div>
    );
  },
}));
// Attributes `CollapsibleUserMessageContent` publishes on the prompt's
// content element; null renders no content at all.
let mockUserContent: Record<string, string> | null = null;
jest.mock('../ChatMessageItem', () => ({
  ChatMessageItem: (): JSX.Element | null =>
    mockUserContent ? (
      <div data-testid="user-message-content" {...mockUserContent} />
    ) : null,
}));
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

const observers: Array<{
  callback: ResizeObserverCallback;
  targets: Set<Element>;
  observer: ResizeObserver;
}> = [];

class TestResizeObserver implements ResizeObserver {
  private readonly entry: (typeof observers)[number];

  constructor(callback: ResizeObserverCallback) {
    this.entry = { callback, targets: new Set(), observer: this };
    observers.push(this.entry);
  }

  observe(target: Element): void {
    this.entry.targets.add(target);
  }

  unobserve(target: Element): void {
    this.entry.targets.delete(target);
  }

  disconnect(): void {
    this.entry.targets.clear();
  }
}

function resizeEntry(target: Element, blockSize: number): ResizeObserverEntry {
  const box: ResizeObserverSize = { blockSize, inlineSize: 400 };
  return {
    target,
    borderBoxSize: [box],
    contentBoxSize: [box],
    devicePixelContentBoxSize: [box],
    contentRect: new DOMRectReadOnly(0, 0, 400, blockSize),
  };
}

function deliverHeights(sizes: Array<[Element, number]>): void {
  for (const entry of observers) {
    const entries = sizes
      .filter(([target]) => entry.targets.has(target))
      .map(([target, blockSize]) => resizeEntry(target, blockSize));
    if (entries.length > 0) entry.callback(entries, entry.observer);
  }
}

function deliverHeaderHeight(header: Element, blockSize: number): void {
  deliverHeights([[header, blockSize]]);
}

function turn(index: number): ChatMessage[] {
  return [
    {
      id: `user-${index}`,
      role: 'user',
      blocks: [{ type: 'text', text: `Ask ${index}` }],
      timestamp: index * 3,
    },
    {
      id: `assistant-${index}`,
      role: 'assistant',
      blocks: [{ type: 'text', text: `Answer ${index}` }],
      timestamp: index * 3 + 1,
    },
    {
      id: `timer-${index}`,
      role: 'system',
      blocks: [
        {
          type: 'turn_timer',
          startedAt: index * 3,
          completedAt: index * 3 + 2,
        },
      ],
      timestamp: index * 3 + 2,
    },
  ];
}

const roots: Root[] = [];

function renderList(
  messages: ChatMessage[],
  pinUserMessages = true,
): {
  host: HTMLDivElement;
  rerender: () => void;
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const render = (): void => {
    act(() => {
      root.render(
        <PinUserMessagesContext.Provider value={pinUserMessages}>
          <ChatMessageList
            messages={messages}
            queuedMessages={[]}
            chatId={mockChatId}
            targetOverride={{
              projectId: 'project-sticky-geometry',
              worktreeId: 'worktree-sticky-geometry',
              chatId: mockChatId,
            }}
            onClearQueuedMessage={(): void => undefined}
          />
        </PinUserMessagesContext.Provider>,
      );
    });
  };
  render();
  return { host, rerender: render };
}

function stickyParts(
  host: HTMLElement,
  key: string,
): { section: HTMLElement; header: HTMLElement } {
  const section = host.querySelector<HTMLElement>(
    `[data-chat-sticky-section="${key}"]`,
  );
  const header = section?.querySelector<HTMLElement>(
    '[data-testid="sticky-user-message"]',
  );
  if (!section || !header) throw new Error(`Missing sticky section ${key}`);
  return { section, header };
}

beforeEach(() => {
  jest.useFakeTimers();
  observers.length = 0;
  mockRenderChips = true;
  mockChipKind = 'markup';
  mockUserContent = null;
  setTestEarlyAccessFeatures({ enabled: false });
  globalThis.ResizeObserver = TestResizeObserver;
  window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
    window.setTimeout(() => callback(performance.now()), 16);
  window.cancelAnimationFrame = (id: number): void => window.clearTimeout(id);
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = '';
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('ChatMessageList sticky header geometry', () => {
  it('publishes the pinned height to the summary chips, not to the whole section', () => {
    const { host } = renderList([...turn(0), ...turn(1)]);
    const { section, header } = stickyParts(host, 'user-1');
    const chip = section.querySelector<HTMLElement>(
      '[data-testid="sticky-turn-summary"]',
    );
    expect(chip).not.toBeNull();

    act(() => deliverHeaderHeight(header, 48));

    expect(chip?.style.getPropertyValue('--chat-sticky-user-height')).toBe(
      '48px',
    );
    // An inherited custom property on the section would restyle every
    // element of the turn each time the header is measured.
    expect(section.style.getPropertyValue('--chat-sticky-user-height')).toBe(
      '',
    );
    expect(section.dataset.chatStickyUserHeight).toBe('48px');
    expect(header.style.top).toBe('0px');
  });

  it('applies the published height to a chip mounted after measurement', () => {
    mockChipKind = 'component';
    mockRenderChips = false;
    const { host, rerender } = renderList([...turn(0), ...turn(1)]);
    const { section, header } = stickyParts(host, 'user-1');
    act(() => deliverHeaderHeight(header, 64));
    expect(
      section.querySelector('[data-testid="sticky-turn-summary"]'),
    ).toBeNull();

    mockRenderChips = true;
    rerender();

    const chip = section.querySelector<HTMLElement>(
      '[data-testid="sticky-turn-summary"]',
    );
    expect(chip?.style.getPropertyValue('--chat-sticky-user-height')).toBe(
      '64px',
    );
  });

  it('clears the published height when the header unmounts', () => {
    const { host } = renderList([...turn(0), ...turn(1)]);
    const { section, header } = stickyParts(host, 'user-1');
    act(() => deliverHeaderHeight(header, 48));
    expect(section.dataset.chatStickyUserHeight).toBe('48px');

    act(() => {
      for (const root of roots.splice(0)) root.unmount();
    });

    expect(section.dataset.chatStickyUserHeight).toBeUndefined();
  });

  function contentOf(header: HTMLElement): HTMLElement {
    const content = header.querySelector<HTMLElement>(
      '[data-testid="user-message-content"]',
    );
    if (!content) throw new Error('Missing user message content');
    return content;
  }

  it('pins an expanded collapsible prompt by its bottom edge', () => {
    mockUserContent = {
      'data-collapsible': 'true',
      'data-collapsed': 'false',
      'data-collapsed-max-px': '80',
    };
    const { host } = renderList([...turn(0), ...turn(1)]);
    const { section, header } = stickyParts(host, 'user-1');

    act(() =>
      deliverHeights([
        [header, 140],
        [contentOf(header), 120],
      ]),
    );

    expect(header.style.top).toBe('-40px');
    expect(section.dataset.chatStickyUserHeight).toBe('100px');
  });

  function renderPromptWithinTolerance(): {
    section: HTMLElement;
    header: HTMLElement;
  } {
    mockUserContent = {
      'data-collapsed': 'false',
      'data-collapsed-max-px': '80',
    };
    const { host } = renderList([...turn(0), ...turn(1)]);
    const parts = stickyParts(host, 'user-1');
    act(() =>
      deliverHeights([
        [parts.header, 110],
        [contentOf(parts.header), 90],
      ]),
    );
    return parts;
  }

  // A prompt just past the clamp, but within its overflow tolerance, is
  // shown in full with no toggle. It is not expanded, so it pins its top
  // edge; shifting it up by the overflow clipped its first line.
  it('pins a prompt that cannot collapse by its top edge with early access on', () => {
    setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
    const { section, header } = renderPromptWithinTolerance();

    expect(header.style.top).toBe('0px');
    expect(section.dataset.chatStickyUserHeight).toBe('110px');
  });

  // A forced-open prompt (transcript search) renders at full height before
  // its collapse measurement marks it collapsible. That attribute change
  // resizes nothing, so the header must re-measure on it.
  it('re-pins by the bottom edge when a full-height prompt turns out collapsible', async () => {
    setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
    mockUserContent = {
      'data-collapsed': 'false',
      'data-collapsed-max-px': '80',
    };
    const { host } = renderList([...turn(0), ...turn(1)]);
    const { section, header } = stickyParts(host, 'user-1');
    act(() =>
      deliverHeights([
        [header, 140],
        [contentOf(header), 120],
      ]),
    );
    expect(header.style.top).toBe('0px');

    await act(async () => {
      contentOf(header).setAttribute('data-collapsible', 'true');
      await Promise.resolve();
    });

    expect(header.style.top).toBe('-40px');
    expect(section.dataset.chatStickyUserHeight).toBe('100px');
  });

  it('keeps short noncollapsible prompts pinned without a Labs opt-in', () => {
    const { section, header } = renderPromptWithinTolerance();

    expect(header.style.top).toBe('0px');
    expect(section.dataset.chatStickyUserHeight).toBe('110px');
  });
});

describe('ChatMessageList without pinned user messages', () => {
  it('renders user messages in their turns, with nothing sticky', () => {
    mockRenderChips = true;
    mockChipKind = 'markup';
    const { host } = renderList([...turn(1), ...turn(2)], false);

    expect(
      host.querySelector('[data-testid="sticky-user-message"]'),
    ).toBeNull();
    // Turns no longer ask for a summary that sticks below a pinned prompt.
    expect(
      host.querySelector('[data-testid="sticky-turn-summary"]'),
    ).toBeNull();
  });

  it('pins them by default', () => {
    mockRenderChips = true;
    mockChipKind = 'markup';
    const { host } = renderList([...turn(1), ...turn(2)]);

    expect(
      host.querySelectorAll('[data-testid="sticky-user-message"]'),
    ).toHaveLength(2);
  });
});
