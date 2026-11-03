/**
 * @jest-environment jsdom
 */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CanopyClientProvider } from '@canopy/app-state';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import { ChatMessageList } from '../ChatMessageList';
import {
  clearChatScrollPosition,
  getChatScrollPosition,
  getSavedChatScrollPosition,
  saveChatScrollPosition,
} from '@/lib/tab-scroll-positions';

import type { ChatMessage, QueuedChatMessage } from '@/stores/chatStore';
import type * as ChatRenderStoresTestUtils from '@/test-utils/chatRenderStores';

let mockChatId = 'chat-scroll-test';

function scrollTarget(chatId: string): {
  projectId: string;
  worktreeId: string;
  chatId: string;
} {
  return {
    projectId: 'project-scroll-test',
    worktreeId: 'worktree-scroll-test',
    chatId,
  };
}

jest.mock('@/stores/chatStore', () => {
  const mockState = (): unknown => ({
    selectedWorktree: {
      projectId: 'project-scroll-test',
      worktreeId: 'worktree-scroll-test',
    },
    worktreeChats: {
      'project-scroll-test/worktree-scroll-test': {
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

jest.mock('../ForkedFromLink', () => ({
  ForkedFromLink: (): null => null,
}));
jest.mock('../TurnGroupRenderer', () => ({
  TurnGroupRenderer: ({
    group,
    forceExpandedUserMessage,
  }: {
    group: { assistantMessages: Array<{ id: string }> };
    forceExpandedUserMessage?: boolean;
  }): JSX.Element => (
    <div data-force-expanded={String(forceExpandedUserMessage === true)}>
      {group.assistantMessages.map((message) => (
        <div key={message.id} data-chat-message-id={message.id} />
      ))}
    </div>
  ),
}));
jest.mock('../ChatMessageItem', () => ({
  ChatMessageItem: ({ message }: { message: { id: string } }): JSX.Element => (
    <div data-chat-message-id={message.id} />
  ),
}));
jest.mock('../QueuedMessageBubble', () => ({
  QueuedMessageBubble: (): null => null,
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

type ResizeCallback = ResizeObserverCallback;

const resizeObservers: Array<{
  callback: ResizeCallback;
  elements: Set<Element>;
  observer: ResizeObserver;
}> = [];

class TestResizeObserver implements ResizeObserver {
  private readonly entry: (typeof resizeObservers)[number];

  constructor(callback: ResizeCallback) {
    this.entry = { callback, elements: new Set(), observer: this };
    resizeObservers.push(this.entry);
  }

  observe(target: Element): void {
    this.entry.elements.add(target);
  }

  unobserve(target: Element): void {
    this.entry.elements.delete(target);
  }

  disconnect(): void {
    this.entry.elements.clear();
  }
}

function triggerResize(target: Element): void {
  for (const observer of resizeObservers) {
    if (observer.elements.has(target)) {
      observer.callback([], observer.observer);
    }
  }
}

function installScrollableMetrics(
  element: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number },
): void {
  let top = 0;
  Object.defineProperties(element, {
    scrollHeight: {
      configurable: true,
      get: (): number => metrics.scrollHeight,
    },
    clientHeight: {
      configurable: true,
      get: (): number => metrics.clientHeight,
    },
    scrollTop: {
      configurable: true,
      get: (): number => top,
      set: (value: number): void => {
        top = Math.max(
          0,
          Math.min(value, metrics.scrollHeight - metrics.clientHeight),
        );
      },
    },
  });
}

function chatMessageList(
  chatId: string,
  worktreeId = 'worktree-scroll-test',
  options: {
    messages?: ChatMessage[];
    queuedMessages?: QueuedChatMessage[];
    materializeAllTranscriptItems?: boolean;
    suppressAutoScroll?: boolean;
  } = {},
): JSX.Element {
  return (
    <CanopyClientProvider client={ipcCanopyClient}>
      <ChatMessageList
        messages={options.messages ?? []}
        queuedMessages={options.queuedMessages ?? []}
        chatId={chatId}
        targetOverride={{
          projectId: 'project-scroll-test',
          worktreeId,
          chatId,
        }}
        onClearQueuedMessage={(): void => undefined}
        materializeAllTranscriptItems={options.materializeAllTranscriptItems}
        suppressAutoScroll={options.suppressAutoScroll}
      />
    </CanopyClientProvider>
  );
}

/** A transcript of 90 turns: enough sections for the list to virtualize. */
function virtualTranscript(prefix: string): ChatMessage[] {
  return Array.from({ length: 90 }, (_, index) => [
    {
      id: `${prefix}-user-${index}`,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: `Ask ${index}` }],
      timestamp: index * 2,
    },
    {
      id: `${prefix}-assistant-${index}`,
      role: 'assistant' as const,
      blocks: [{ type: 'text' as const, text: `Answer ${index}` }],
      timestamp: index * 2 + 1,
    },
  ]).flat();
}

function systemMessages(ids: string[]): ChatMessage[] {
  return ids.map((id, index) => ({
    id,
    role: 'system',
    blocks: [{ type: 'text', text: id }],
    timestamp: index,
  }));
}

function renderList(chatId: string): {
  root: Root;
  host: HTMLDivElement;
  scroller: HTMLDivElement;
  content: HTMLDivElement;
} {
  mockChatId = chatId;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(chatMessageList(chatId));
  });
  const scroller = host.querySelector<HTMLDivElement>(
    '[data-testid="chat-message-list-scroll"]',
  );
  // The scroller's immediate child is the shared OverlayScrollArea's content
  // wrapper; the transcript's own measured content element sits inside it.
  const content = host.querySelector<HTMLDivElement>(
    '[data-testid="chat-message-list-content"]',
  );
  if (!scroller || !(content instanceof HTMLDivElement)) {
    throw new Error('Expected the chat message scroller and content');
  }
  return { root, host, scroller, content };
}

/**
 * Lays the message rows out from the DOM, as a browser does: the rows sit at
 * their `before` tops until the row named `inserted` is mounted, and at their
 * `after` tops from then on. A prompt inside the sticky header stays pinned at
 * the top of the viewport. `rowMeasurements` lists every row that was measured.
 */
function mockRowGeometry(
  view: { host: HTMLElement; scroller: HTMLElement },
  tops: { before: Record<string, number>; after: Record<string, number> },
): { spy: jest.SpyInstance; rowMeasurements: string[] } {
  const rowMeasurements: string[] = [];
  const spy = jest
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement): DOMRect {
      if (this === view.scroller) return new DOMRect(0, 0, 500, 200);
      const messageId = this.dataset.chatMessageId;
      if (messageId === undefined) return new DOMRect(0, 0, 500, 100);
      rowMeasurements.push(messageId);
      if (this.closest('[data-sticky-user-message-id]'))
        return new DOMRect(0, 8, 100, 40);
      const layout = view.host.querySelector(
        '[data-chat-message-id="inserted"]',
      )
        ? tops.after
        : tops.before;
      return new DOMRect(
        0,
        (layout[messageId] ?? 0) - view.scroller.scrollTop,
        100,
        20,
      );
    });
  return { spy, rowMeasurements };
}

beforeEach(() => {
  jest.useFakeTimers();
  resizeObservers.length = 0;
  globalThis.ResizeObserver = TestResizeObserver;
  window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
    window.setTimeout(() => callback(performance.now()), 16);
  window.cancelAnimationFrame = (id: number): void => window.clearTimeout(id);
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('ChatMessageList scroll position', () => {
  it('keeps the same message at the same viewport offset across a shifted transcript window', () => {
    const chatId = 'chat-reset-message-anchor';
    clearChatScrollPosition(scrollTarget(chatId));
    const view = renderList(chatId);
    const metrics = { scrollHeight: 1_000, clientHeight: 200 };
    installScrollableMetrics(view.scroller, metrics);
    const geometry = mockRowGeometry(view, {
      before: { anchor: 350, tail: 450 },
      after: { inserted: 330, anchor: 430, 'replacement-tail': 530 },
    });

    act(() => {
      view.root.render(
        chatMessageList(chatId, undefined, {
          messages: systemMessages(['anchor', 'tail']),
        }),
      );
    });
    view.scroller.scrollTop = 300;
    act(() => {
      view.scroller.dispatchEvent(new Event('scroll'));
    });
    expect(
      view.host
        .querySelector<HTMLElement>('[data-chat-message-id="anchor"]')
        ?.getBoundingClientRect().top,
    ).toBe(50);

    act(() => {
      view.root.render(
        chatMessageList(chatId, undefined, {
          messages: systemMessages(['inserted', 'anchor', 'replacement-tail']),
        }),
      );
    });

    expect(view.scroller.scrollTop).toBe(380);
    expect(
      view.host
        .querySelector<HTMLElement>('[data-chat-message-id="anchor"]')
        ?.getBoundingClientRect().top,
    ).toBe(50);

    geometry.spy.mockRestore();
    act(() => view.root.unmount());
    view.host.remove();
  });

  it('keeps the row being read in place when rows shift above it under a pinned prompt', () => {
    const chatId = 'chat-reset-pinned-prompt-anchor';
    clearChatScrollPosition(scrollTarget(chatId));
    const view = renderList(chatId);
    const metrics = { scrollHeight: 1_000, clientHeight: 200 };
    installScrollableMetrics(view.scroller, metrics);
    const turn = (assistantIds: string[]): ChatMessage[] => [
      {
        id: 'prompt',
        role: 'user',
        blocks: [{ type: 'text', text: 'Ask' }],
        timestamp: 0,
      },
      ...assistantIds.map(
        (id, index): ChatMessage => ({
          id,
          role: 'assistant',
          blocks: [{ type: 'text', text: id }],
          timestamp: index + 1,
        }),
      ),
      {
        id: 'prompt:timer',
        role: 'system',
        blocks: [{ type: 'turn_timer', startedAt: 0, completedAt: 100 }],
        timestamp: 100,
      },
    ];
    const geometry = mockRowGeometry(view, {
      before: { earlier: 200, anchor: 350, tail: 450 },
      after: { earlier: 200, inserted: 330, anchor: 430, tail: 530 },
    });

    act(() => {
      view.root.render(
        chatMessageList(chatId, undefined, {
          messages: turn(['earlier', 'anchor', 'tail']),
        }),
      );
    });
    expect(
      view.host.querySelector(
        '[data-sticky-user-message-id] [data-chat-message-id="prompt"]',
      ),
    ).not.toBeNull();
    view.scroller.scrollTop = 300;
    act(() => {
      view.scroller.dispatchEvent(new Event('scroll'));
    });
    expect(
      view.host
        .querySelector<HTMLElement>('[data-chat-message-id="anchor"]')
        ?.getBoundingClientRect().top,
    ).toBe(50);

    act(() => {
      view.root.render(
        chatMessageList(chatId, undefined, {
          messages: turn(['earlier', 'inserted', 'anchor', 'tail']),
        }),
      );
    });

    expect(view.scroller.scrollTop).toBe(380);
    expect(
      view.host
        .querySelector<HTMLElement>('[data-chat-message-id="anchor"]')
        ?.getBoundingClientRect().top,
    ).toBe(50);

    geometry.spy.mockRestore();
    act(() => view.root.unmount());
    view.host.remove();
  });

  it("measures the reader's row when the transcript changes, not on every scroll event", () => {
    const chatId = 'chat-reset-anchor-measurement';
    clearChatScrollPosition(scrollTarget(chatId));
    const view = renderList(chatId);
    installScrollableMetrics(view.scroller, {
      scrollHeight: 1_000,
      clientHeight: 200,
    });
    const geometry = mockRowGeometry(view, {
      before: { anchor: 350, tail: 450 },
      after: { inserted: 330, anchor: 430, tail: 530 },
    });

    act(() => {
      view.root.render(
        chatMessageList(chatId, undefined, {
          messages: systemMessages(['anchor', 'tail']),
        }),
      );
    });
    view.scroller.scrollTop = 300;
    geometry.rowMeasurements.length = 0;
    act(() => {
      for (let event = 0; event < 5; event += 1)
        view.scroller.dispatchEvent(new Event('scroll'));
      jest.advanceTimersByTime(500);
    });
    expect(geometry.rowMeasurements).toEqual([]);

    act(() => {
      view.root.render(
        chatMessageList(chatId, undefined, {
          messages: systemMessages(['inserted', 'anchor', 'tail']),
        }),
      );
    });

    expect(view.scroller.scrollTop).toBe(380);

    geometry.spy.mockRestore();
    act(() => view.root.unmount());
    view.host.remove();
  });

  it('anchors on a row that survives when the first visible row is removed', () => {
    const chatId = 'chat-reset-anchor-survivor';
    clearChatScrollPosition(scrollTarget(chatId));
    const view = renderList(chatId);
    installScrollableMetrics(view.scroller, {
      scrollHeight: 1_000,
      clientHeight: 200,
    });
    const geometry = mockRowGeometry(view, {
      before: { removed: 350, anchor: 450, tail: 550 },
      after: { inserted: 300, anchor: 500, tail: 600 },
    });

    act(() => {
      view.root.render(
        chatMessageList(chatId, undefined, {
          messages: systemMessages(['removed', 'anchor', 'tail']),
        }),
      );
    });
    view.scroller.scrollTop = 300;
    act(() => {
      view.scroller.dispatchEvent(new Event('scroll'));
    });
    expect(
      view.host
        .querySelector<HTMLElement>('[data-chat-message-id="anchor"]')
        ?.getBoundingClientRect().top,
    ).toBe(150);

    act(() => {
      view.root.render(
        chatMessageList(chatId, undefined, {
          messages: systemMessages(['inserted', 'anchor', 'tail']),
        }),
      );
    });

    expect(view.scroller.scrollTop).toBe(350);
    expect(
      view.host
        .querySelector<HTMLElement>('[data-chat-message-id="anchor"]')
        ?.getBoundingClientRect().top,
    ).toBe(150);

    geometry.spy.mockRestore();
    act(() => view.root.unmount());
    view.host.remove();
  });

  it('materializes every row without replacing the virtual window', () => {
    const messages: ChatMessage[] = Array.from({ length: 90 }, (_, index) => ({
      id: `materialized-message-${index}`,
      role: 'system',
      blocks: [{ type: 'text', text: `Historical message ${index}` }],
      timestamp: index,
    }));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        chatMessageList('materialized-chat', undefined, { messages }),
      );
    });
    const virtualWindow = host.querySelector(
      '[data-testid="chat-transcript-virtual-window"]',
    );
    expect(virtualWindow).not.toBeNull();

    act(() => {
      root.render(
        chatMessageList('materialized-chat', undefined, {
          messages,
          materializeAllTranscriptItems: true,
        }),
      );
    });
    expect(
      host.querySelector('[data-testid="chat-transcript-virtual-window"]'),
    ).toBe(virtualWindow);

    act(() => root.unmount());
    host.remove();
  });

  it('force-expands user prompts while an archived search materializes the transcript', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const messages: ChatMessage[] = [
      {
        id: 'archived-user',
        role: 'user',
        blocks: [{ type: 'text', text: 'Hidden archived search marker' }],
        timestamp: 1,
      },
      {
        id: 'archived-timer',
        role: 'system',
        blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 2 }],
        timestamp: 2,
      },
    ];

    act(() => {
      root.render(
        chatMessageList('archived-search-chat', undefined, {
          messages,
          materializeAllTranscriptItems: true,
        }),
      );
    });

    expect(host.querySelector('[data-force-expanded="true"]')).not.toBeNull();
    act(() => root.unmount());
    host.remove();
  });

  it('retains virtual measurements when later scroll events update the offset', () => {
    const target = scrollTarget('chat-measurement-cache');
    const measurements = [
      {
        index: 0,
        key: 'turn-0',
        start: 0,
        size: 240,
        end: 240,
        lane: 0,
      },
    ];

    saveChatScrollPosition(target, 125, measurements);
    saveChatScrollPosition(target, 180);

    expect(getSavedChatScrollPosition(target)).toEqual({
      chatId: target.chatId,
      top: 180,
      measurements,
    });
  });

  it('stretches its scroll area over the Activity card inset, so the edge scrollbar stays reachable', () => {
    // ActivityCardChatLayout pads the chat's right side and sets a negative
    // --chat-scrollbar-inset. The scroll area itself (whose pointer hover
    // reveals the rail) reaches the pane edge; its viewport pads the same
    // amount back so the reading column does not move.
    const view = renderList('chat-scroll-inset');
    const area = view.scroller.closest<HTMLElement>(
      '[data-overlay-scroll-area]',
    );
    expect(area?.className).toContain(
      'right-[var(--chat-scrollbar-inset,0px)]',
    );
    expect(view.scroller.className).toContain(
      'pr-[calc(1rem-var(--chat-scrollbar-inset,0px))]',
    );
    const rail = area?.querySelector<HTMLElement>('[data-overlay-scrollbar]');
    expect(rail?.className).not.toContain('--chat-scrollbar-inset');
    act(() => view.root.unmount());
    view.host.remove();
  });

  it('keeps a first visit at the bottom when content grows after mount', () => {
    const chatId = 'chat-default-bottom';
    clearChatScrollPosition(chatId);
    const view = renderList(chatId);
    installScrollableMetrics(view.scroller, {
      scrollHeight: 1_000,
      clientHeight: 200,
    });

    act(() => triggerResize(view.content));

    expect(view.scroller.scrollTop).toBe(800);
    expect(getChatScrollPosition(scrollTarget(chatId))).toBe(800);
    act(() => view.root.unmount());
    view.host.remove();
  });

  it('mounts only the tail rows when a first visit loads a virtualized transcript', () => {
    // Rows are measured by `offsetHeight`, and the virtualizer sizes its
    // window from the scroller's. jsdom reports zero for both.
    const offsetHeight = jest
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockImplementation(function (this: HTMLElement): number {
        if (this.dataset.testid === 'chat-message-list-scroll') return 600;
        return this.dataset.index === undefined ? 0 : 300;
      });
    const chatId = 'chat-virtual-first-visit';
    clearChatScrollPosition(chatId);
    const view = renderList(chatId);
    installScrollableMetrics(view.scroller, {
      scrollHeight: 27_000,
      clientHeight: 600,
    });
    const mounted = new Set<number>();
    const observer = new MutationObserver(() => undefined);
    observer.observe(view.host, { childList: true, subtree: true });
    const collect = (): void => {
      for (const record of observer.takeRecords()) {
        record.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          const rows: HTMLElement[] = [
            node,
            ...Array.from(node.querySelectorAll<HTMLElement>('[data-index]')),
          ];
          rows.forEach((row) => {
            const index = row.dataset.index;
            if (index !== undefined) mounted.add(Number(index));
          });
        });
      }
    };
    const messages: ChatMessage[] = Array.from({ length: 90 }, (_, index) => [
      {
        id: `first-visit-user-${index}`,
        role: 'user' as const,
        blocks: [{ type: 'text' as const, text: `Ask ${index}` }],
        timestamp: index * 2,
      },
      {
        id: `first-visit-assistant-${index}`,
        role: 'assistant' as const,
        blocks: [{ type: 'text' as const, text: `Answer ${index}` }],
        timestamp: index * 2 + 1,
      },
    ]).flat();

    // The transcript page arrives after the panel mounted, as it does when a
    // stored chat is opened.
    act(() => {
      view.root.render(chatMessageList(chatId, undefined, { messages }));
    });
    collect();
    act(() => {
      jest.advanceTimersByTime(100);
    });
    collect();

    // The first visit opens at the tail. Rendering the head first would build
    // and lay out sections the user never sees, then replace them.
    expect(mounted.has(89)).toBe(true);
    expect(Math.min(...mounted)).toBeGreaterThanOrEqual(80);
    observer.disconnect();
    offsetHeight.mockRestore();
    act(() => view.root.unmount());
    view.host.remove();
  });

  it('mounts visible sections first and their off-screen neighbours in later frames', () => {
    const offsetHeight = jest
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockImplementation(function (this: HTMLElement): number {
        if (this.dataset.testid === 'chat-message-list-scroll') return 600;
        return this.dataset.index === undefined ? 0 : 300;
      });
    const chatId = 'chat-virtual-progressive-overscan';
    clearChatScrollPosition(chatId);
    const view = renderList(chatId);
    installScrollableMetrics(view.scroller, {
      scrollHeight: 27_000,
      clientHeight: 600,
    });
    const mountedRows = (): number[] =>
      Array.from(
        view.host.querySelectorAll<HTMLElement>(
          '[data-testid="chat-transcript-virtual-window"] > [data-index]',
        ),
      ).map((row) => Number(row.dataset.index));
    const messages: ChatMessage[] = Array.from({ length: 90 }, (_, index) => [
      {
        id: `progressive-user-${index}`,
        role: 'user' as const,
        blocks: [{ type: 'text' as const, text: `Ask ${index}` }],
        timestamp: index * 2,
      },
      {
        id: `progressive-assistant-${index}`,
        role: 'assistant' as const,
        blocks: [{ type: 'text' as const, text: `Answer ${index}` }],
        timestamp: index * 2 + 1,
      },
    ]).flat();

    act(() => {
      view.root.render(chatMessageList(chatId, undefined, { messages }));
    });

    // The open builds only what is on screen. Overscan neighbours, which can
    // each be a whole turn of Markdown, follow one per frame.
    expect(mountedRows()).toEqual([89]);
    act(() => {
      jest.advanceTimersByTime(16);
    });
    expect(mountedRows()).toEqual([88, 89]);
    act(() => {
      jest.advanceTimersByTime(100);
    });
    expect(mountedRows()).toEqual([87, 88, 89]);
    offsetHeight.mockRestore();
    act(() => view.root.unmount());
    view.host.remove();
  });

  it('opens a chat switched in the same list at its own position', () => {
    const offsetHeight = jest
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockImplementation(function (this: HTMLElement): number {
        if (this.dataset.testid === 'chat-message-list-scroll') return 600;
        return this.dataset.index === undefined ? 0 : 300;
      });
    const firstChatId = 'chat-virtual-switch-from-top';
    const secondChatId = 'chat-virtual-switch-unvisited';
    clearChatScrollPosition(firstChatId);
    clearChatScrollPosition(secondChatId);
    const view = renderList(firstChatId);
    installScrollableMetrics(view.scroller, {
      scrollHeight: 27_000,
      clientHeight: 600,
    });
    const mountedRows = (): number[] =>
      Array.from(
        view.host.querySelectorAll<HTMLElement>(
          '[data-testid="chat-transcript-virtual-window"] > [data-index]',
        ),
      ).map((row) => Number(row.dataset.index));
    act(() => {
      view.root.render(
        chatMessageList(firstChatId, undefined, {
          messages: virtualTranscript('switch-from-top'),
        }),
      );
    });
    act(() => {
      jest.advanceTimersByTime(100);
    });
    // The user reads the first chat from its top.
    act(() => {
      view.scroller.scrollTop = 0;
      view.scroller.dispatchEvent(new Event('scroll'));
    });
    act(() => {
      jest.advanceTimersByTime(100);
    });
    expect(mountedRows()).toContain(0);

    // A host that keeps one list across chat tabs (the pipeline chat panel,
    // for one) switches it to a chat the user has not opened yet.
    mockChatId = secondChatId;
    act(() => {
      view.root.render(
        chatMessageList(secondChatId, undefined, {
          messages: virtualTranscript('switch-unvisited'),
        }),
      );
    });

    // It opens at its own tail, as a new list would. Building its head at the
    // previous chat's offset would lay out sections the restore then drops.
    expect(mountedRows()).toContain(89);
    expect(Math.min(...mountedRows())).toBeGreaterThanOrEqual(87);
    offsetHeight.mockRestore();
    act(() => view.root.unmount());
    view.host.remove();
  });

  it('drops a queued scroll restore when the list switches to a fork that shares the row', () => {
    const offsetHeight = jest
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockImplementation(function (this: HTMLElement): number {
        if (this.dataset.testid === 'chat-message-list-scroll') return 600;
        return this.dataset.index === undefined ? 0 : 300;
      });
    const sourceChatId = 'chat-anchor-queued-source';
    const forkChatId = 'chat-anchor-queued-fork';
    clearChatScrollPosition(scrollTarget(sourceChatId));
    clearChatScrollPosition(scrollTarget(forkChatId));
    const view = renderList(sourceChatId);
    installScrollableMetrics(view.scroller, {
      scrollHeight: 40_000,
      clientHeight: 600,
    });
    // Each answer sits 60 px under the top of the section the list placed.
    const geometry = jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement): DOMRect {
        if (this === view.scroller) return new DOMRect(0, 0, 500, 600);
        if (this.dataset.chatMessageId === undefined)
          return new DOMRect(0, 0, 500, 100);
        if (this.closest('[data-sticky-user-message-id]'))
          return new DOMRect(0, 8, 100, 40);
        const section = this.closest<HTMLElement>('[data-index]');
        return new DOMRect(
          0,
          Number.parseFloat(section?.style.top ?? '0') +
            60 -
            view.scroller.scrollTop,
          100,
          20,
        );
      });
    const messages = virtualTranscript('shared');
    act(() => {
      view.root.render(chatMessageList(sourceChatId, undefined, { messages }));
    });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    view.scroller.scrollTop = 12_000;
    act(() => {
      view.scroller.dispatchEvent(new Event('scroll'));
      jest.advanceTimersByTime(500);
    });

    // A turn inserted above the reader queues a restore for the next frame.
    const reordered: ChatMessage[] = [
      ...messages.slice(0, 20),
      {
        id: 'shared-user-inserted',
        role: 'user',
        blocks: [{ type: 'text', text: 'Inserted ask' }],
        timestamp: 20,
      },
      {
        id: 'shared-assistant-inserted',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Inserted answer' }],
        timestamp: 20,
      },
      ...messages.slice(20),
    ];
    act(() => {
      view.root.render(
        chatMessageList(sourceChatId, undefined, { messages: reordered }),
      );
    });

    // Before that frame, the list switches to a fork of the chat. It holds the
    // same rows and was left at its own position.
    saveChatScrollPosition(scrollTarget(forkChatId), 750);
    mockChatId = forkChatId;
    act(() => {
      view.root.render(
        chatMessageList(forkChatId, undefined, { messages: reordered }),
      );
    });
    expect(view.scroller.scrollTop).toBe(750);
    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(view.scroller.scrollTop).toBe(750);
    geometry.mockRestore();
    offsetHeight.mockRestore();
    act(() => view.root.unmount());
    view.host.remove();
  });

  it('mounts a chat switched in the same list one section at a time', () => {
    const offsetHeight = jest
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockImplementation(function (this: HTMLElement): number {
        if (this.dataset.testid === 'chat-message-list-scroll') return 600;
        return this.dataset.index === undefined ? 0 : 300;
      });
    const firstChatId = 'chat-virtual-switch-from-tail';
    const secondChatId = 'chat-virtual-switch-next';
    clearChatScrollPosition(firstChatId);
    clearChatScrollPosition(secondChatId);
    const view = renderList(firstChatId);
    installScrollableMetrics(view.scroller, {
      scrollHeight: 27_000,
      clientHeight: 600,
    });
    const mountedRows = (): number[] =>
      Array.from(
        view.host.querySelectorAll<HTMLElement>(
          '[data-testid="chat-transcript-virtual-window"] > [data-index]',
        ),
      ).map((row) => Number(row.dataset.index));
    act(() => {
      view.root.render(
        chatMessageList(firstChatId, undefined, {
          messages: virtualTranscript('switch-from-tail'),
        }),
      );
    });
    act(() => {
      jest.advanceTimersByTime(16);
    });
    act(() => {
      jest.advanceTimersByTime(100);
    });
    expect(mountedRows()).toEqual([87, 88, 89]);

    mockChatId = secondChatId;
    act(() => {
      view.root.render(
        chatMessageList(secondChatId, undefined, {
          messages: virtualTranscript('switch-next'),
        }),
      );
    });

    // The previous chat's mounted sections share indexes with this chat's but
    // none of its content: its neighbours still join one per pass, not all in
    // its first render.
    expect(mountedRows()).toContain(89);
    expect(mountedRows()).not.toContain(87);
    act(() => {
      jest.advanceTimersByTime(16);
    });
    expect(mountedRows()).toEqual([87, 88, 89]);
    offsetHeight.mockRestore();
    act(() => view.root.unmount());
    view.host.remove();
  });

  it('builds only the first long report when a jump reaches the top', () => {
    const offsetHeight = jest
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockImplementation(function (this: HTMLElement): number {
        if (this.dataset.testid === 'chat-message-list-scroll') return 600;
        return this.dataset.index === undefined ? 0 : 6_000;
      });
    const chatId = 'chat-virtual-long-report-jump';
    clearChatScrollPosition(chatId);
    const view = renderList(chatId);
    installScrollableMetrics(view.scroller, {
      scrollHeight: 180_000,
      clientHeight: 600,
    });
    const mountedRows = (): number[] =>
      Array.from(
        view.host.querySelectorAll<HTMLElement>(
          '[data-testid="chat-transcript-virtual-window"] > [data-index]',
        ),
      ).map((row) => Number(row.dataset.index));
    const report = `# Final report\n\n${'Detailed verification evidence. '.repeat(800)}`;
    const messages: ChatMessage[] = Array.from({ length: 30 }, (_, index) => [
      {
        id: `long-report-user-${index}`,
        role: 'user' as const,
        blocks: [{ type: 'text' as const, text: `Ask ${index}` }],
        timestamp: index * 2,
      },
      {
        id: `long-report-assistant-${index}`,
        role: 'assistant' as const,
        blocks: [{ type: 'text' as const, text: report }],
        timestamp: index * 2 + 1,
      },
    ]).flat();
    act(() => {
      view.root.render(chatMessageList(chatId, undefined, { messages }));
    });
    act(() => {
      jest.advanceTimersByTime(100);
    });
    expect(Math.min(...mountedRows())).toBeGreaterThan(20);

    act(() => {
      view.scroller.scrollTop = 0;
      view.scroller.dispatchEvent(new Event('scroll'));
    });

    // Unmeasured sections are placed by their estimated height. Estimated as
    // a few lines, every section of the first screenful would look visible
    // and be built, although the first report alone fills the viewport.
    expect(mountedRows().filter((index) => index < 20)).toEqual([0]);
    offsetHeight.mockRestore();
    act(() => view.root.unmount());
    view.host.remove();
  });

  it('retries a saved offset after the transcript reaches its full height', () => {
    const chatId = 'chat-late-restore';
    saveChatScrollPosition(scrollTarget(chatId), 420);
    const view = renderList(chatId);
    installScrollableMetrics(view.scroller, {
      scrollHeight: 1_000,
      clientHeight: 200,
    });

    act(() => triggerResize(view.content));

    expect(view.scroller.scrollTop).toBe(420);
    act(() => view.root.unmount());
    view.host.remove();
  });

  it('preserves an unreachable saved offset during teardown', () => {
    const chatId = 'chat-pending-unmount';
    saveChatScrollPosition(scrollTarget(chatId), 420);
    const view = renderList(chatId);
    installScrollableMetrics(view.scroller, {
      scrollHeight: 300,
      clientHeight: 200,
    });

    act(() => triggerResize(view.content));
    expect(view.scroller.scrollTop).toBe(100);

    act(() => view.root.unmount());

    expect(getChatScrollPosition(scrollTarget(chatId))).toBe(420);
    view.host.remove();
  });

  it('defers message-driven bottom pinning until content layout completes', () => {
    const chatId = 'chat-message-bottom';
    clearChatScrollPosition(chatId);
    const metrics = { scrollHeight: 1_000, clientHeight: 200 };
    const view = renderList(chatId);
    installScrollableMetrics(view.scroller, metrics);
    act(() => triggerResize(view.content));
    expect(view.scroller.scrollTop).toBe(800);

    metrics.scrollHeight = 1_400;
    act(() => {
      view.root.render(chatMessageList(chatId));
    });

    // A transcript rerender must not synchronously read its full scroll height
    // and force layout. ResizeObserver reports the committed content size and
    // remains the source of truth for the eventual stick-to-bottom behavior.
    expect(view.scroller.scrollTop).toBe(800);
    act(() => triggerResize(view.content));

    expect(view.scroller.scrollTop).toBe(1_200);
    expect(getChatScrollPosition(scrollTarget(chatId))).toBe(1_200);
    act(() => view.root.unmount());
    view.host.remove();
  });

  const transcript: ChatMessage[] = [
    {
      id: 'send-user-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'First ask' }],
      timestamp: 1,
    },
    {
      id: 'send-assistant-1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'First answer' }],
      timestamp: 2,
    },
  ];

  function renderScrolledUp(chatId: string): {
    view: ReturnType<typeof renderList>;
    metrics: { scrollHeight: number; clientHeight: number };
  } {
    clearChatScrollPosition(scrollTarget(chatId));
    mockChatId = chatId;
    const view = renderList(chatId);
    act(() => {
      view.root.render(
        chatMessageList(chatId, undefined, { messages: transcript }),
      );
    });
    const metrics = { scrollHeight: 1_000, clientHeight: 200 };
    installScrollableMetrics(view.scroller, metrics);
    act(() => triggerResize(view.content));
    act(() => jest.runOnlyPendingTimers());
    view.scroller.scrollTop = 275;
    act(() => {
      view.scroller.dispatchEvent(new Event('scroll'));
    });
    return { view, metrics };
  }

  it('reopens a chat left at the bottom at its newest content', () => {
    const chatId = 'chat-bottom-reopen-latest';
    clearChatScrollPosition(chatId);
    const first = renderList(chatId);
    installScrollableMetrics(first.scroller, {
      scrollHeight: 1_000,
      clientHeight: 200,
    });
    act(() => triggerResize(first.content));
    act(() => jest.runOnlyPendingTimers());
    expect(first.scroller.scrollTop).toBe(800);
    act(() => first.root.unmount());
    first.host.remove();

    // The agent replied while the user was on another tab or worktree.
    const second = renderList(chatId);
    installScrollableMetrics(second.scroller, {
      scrollHeight: 1_600,
      clientHeight: 200,
    });
    act(() => triggerResize(second.content));

    expect(second.scroller.scrollTop).toBe(1_400);
    act(() => second.root.unmount());
    second.host.remove();
  });

  it('reopens a chat scrolled by hand to the bottom at its newest content', () => {
    const chatId = 'chat-manual-bottom-reopen-latest';
    clearChatScrollPosition(chatId);
    const first = renderList(chatId);
    installScrollableMetrics(first.scroller, {
      scrollHeight: 1_000,
      clientHeight: 200,
    });
    act(() => triggerResize(first.content));
    act(() => jest.runOnlyPendingTimers());
    first.scroller.scrollTop = 275;
    act(() => {
      first.scroller.dispatchEvent(new Event('scroll'));
    });
    first.scroller.scrollTop = 800;
    act(() => {
      first.scroller.dispatchEvent(new Event('scroll'));
    });
    act(() => first.root.unmount());
    first.host.remove();

    const second = renderList(chatId);
    installScrollableMetrics(second.scroller, {
      scrollHeight: 1_600,
      clientHeight: 200,
    });
    act(() => triggerResize(second.content));

    expect(second.scroller.scrollTop).toBe(1_400);
    act(() => second.root.unmount());
    second.host.remove();
  });

  it('reopens a chat read mid-transcript at the same offset after new content', () => {
    const chatId = 'chat-mid-reopen-same-offset';
    clearChatScrollPosition(chatId);
    const first = renderList(chatId);
    installScrollableMetrics(first.scroller, {
      scrollHeight: 1_000,
      clientHeight: 200,
    });
    act(() => triggerResize(first.content));
    act(() => jest.runOnlyPendingTimers());
    first.scroller.scrollTop = 275;
    act(() => {
      first.scroller.dispatchEvent(new Event('scroll'));
    });
    act(() => first.root.unmount());
    first.host.remove();

    const second = renderList(chatId);
    installScrollableMetrics(second.scroller, {
      scrollHeight: 1_600,
      clientHeight: 200,
    });
    act(() => triggerResize(second.content));

    expect(second.scroller.scrollTop).toBe(275);
    act(() => second.root.unmount());
    second.host.remove();
  });

  it('reopens a chat scrolled up during a running turn at the same offset', () => {
    const chatId = 'chat-scrolled-up-while-streaming';
    clearChatScrollPosition(chatId);
    const metrics = { scrollHeight: 1_000, clientHeight: 200 };
    const first = renderList(chatId);
    installScrollableMetrics(first.scroller, metrics);
    act(() => triggerResize(first.content));
    act(() => jest.runOnlyPendingTimers());
    first.scroller.scrollTop = 275;
    act(() => {
      first.scroller.dispatchEvent(new Event('scroll'));
    });
    // The agent keeps streaming while the user reads above the tail.
    metrics.scrollHeight = 1_300;
    act(() => triggerResize(first.content));
    expect(first.scroller.scrollTop).toBe(275);
    act(() => first.root.unmount());
    first.host.remove();

    // More output arrives while the user is on another tab.
    const second = renderList(chatId);
    installScrollableMetrics(second.scroller, {
      scrollHeight: 1_900,
      clientHeight: 200,
    });
    act(() => triggerResize(second.content));

    expect(second.scroller.scrollTop).toBe(275);
    act(() => second.root.unmount());
    second.host.remove();
  });

  it('reopens a chat left at the bottom during a running turn at its newest content', () => {
    const chatId = 'chat-bottom-while-streaming';
    clearChatScrollPosition(chatId);
    const metrics = { scrollHeight: 1_000, clientHeight: 200 };
    const first = renderList(chatId);
    installScrollableMetrics(first.scroller, metrics);
    act(() => triggerResize(first.content));
    act(() => jest.runOnlyPendingTimers());
    // The agent keeps streaming while the user follows the tail.
    metrics.scrollHeight = 1_300;
    act(() => triggerResize(first.content));
    expect(first.scroller.scrollTop).toBe(1_100);
    act(() => first.root.unmount());
    first.host.remove();

    // More output arrives while the user is on another tab.
    const second = renderList(chatId);
    installScrollableMetrics(second.scroller, {
      scrollHeight: 1_900,
      clientHeight: 200,
    });
    act(() => triggerResize(second.content));

    expect(second.scroller.scrollTop).toBe(1_700);
    act(() => second.root.unmount());
    second.host.remove();
  });

  describe.each([
    ['off', false],
    ['on', true],
  ])(
    'when the person sends a prompt with early access %s',
    (_label, earlyAccess) => {
      beforeEach(() => {
        setTestEarlyAccessFeatures({
          enabled: earlyAccess,
          hydrated: true,
        });
      });
      afterEach(() => {
        setTestEarlyAccessFeatures({ enabled: false });
      });

      const secondAsk: ChatMessage = {
        id: 'send-user-2',
        role: 'user',
        blocks: [{ type: 'text', text: 'Second ask' }],
        timestamp: 3,
        userMessageSource: 'human',
      };

      it('jumps to the bottom even when the transcript was scrolled up', () => {
        const chatId = 'chat-send-scrolls-bottom';
        const { view, metrics } = renderScrolledUp(chatId);

        metrics.scrollHeight = 1_200;
        act(() => {
          view.root.render(
            chatMessageList(chatId, undefined, {
              messages: [
                ...transcript,
                {
                  id: 'send-user-2',
                  role: 'user',
                  blocks: [{ type: 'text', text: 'Second ask' }],
                  timestamp: 3,
                  userMessageSource: 'human',
                },
              ],
            }),
          );
        });
        expect(view.scroller.scrollTop).toBe(1_000);

        // The reply streams in below the prompt and stays in view.
        metrics.scrollHeight = 1_500;
        act(() => triggerResize(view.content));
        expect(view.scroller.scrollTop).toBe(1_300);
        act(() => view.root.unmount());
        view.host.remove();
      });

      it('jumps to the bottom when the prompt is queued behind a running turn', () => {
        const chatId = 'chat-queue-scrolls-bottom';
        const { view, metrics } = renderScrolledUp(chatId);

        metrics.scrollHeight = 1_100;
        act(() => {
          view.root.render(
            chatMessageList(chatId, undefined, {
              messages: transcript,
              queuedMessages: [{ text: 'Queued ask' }],
            }),
          );
        });
        expect(view.scroller.scrollTop).toBe(900);
        act(() => view.root.unmount());
        view.host.remove();
      });

      it('re-arms for a replaced host queue entry without a count increase', () => {
        const chatId = 'chat-queue-replaced';
        const { view, metrics } = renderScrolledUp(chatId);
        const renderQueue = (id: string): void =>
          act(() => {
            view.root.render(
              chatMessageList(chatId, undefined, {
                messages: transcript,
                queuedMessages: [{ text: id, hostQueueEntryId: id }],
              }),
            );
          });
        metrics.scrollHeight = 1_100;
        renderQueue('q1');
        act(() => jest.runOnlyPendingTimers());
        view.scroller.scrollTop = 275;
        act(() => {
          view.scroller.dispatchEvent(new Event('scroll'));
        });
        renderQueue('q2');
        expect(view.scroller.scrollTop).toBe(900);
        act(() => view.root.unmount());
        view.host.remove();
      });

      it('preserves scrollback when an observed host queue entry is restored', () => {
        const chatId = 'chat-queue-restored';
        const { view, metrics } = renderScrolledUp(chatId);
        const renderQueue = (ids: string[]): void =>
          act(() => {
            view.root.render(
              chatMessageList(chatId, undefined, {
                messages: transcript,
                queuedMessages: ids.map((id) => ({
                  text: id,
                  hostQueueEntryId: id,
                })),
              }),
            );
          });
        metrics.scrollHeight = 1_100;
        renderQueue(['q1']);
        act(() => jest.runOnlyPendingTimers());
        view.scroller.scrollTop = 275;
        act(() => {
          view.scroller.dispatchEvent(new Event('scroll'));
        });
        renderQueue([]);
        renderQueue(['q1']);
        expect(view.scroller.scrollTop).toBe(275);
        renderQueue(['q1', 'q2']);
        expect(view.scroller.scrollTop).toBe(900);
        act(() => view.root.unmount());
        view.host.remove();
      });

      it('keeps the reader in place for a watcher prompt', () => {
        const chatId = 'chat-watcher-keeps-offset';
        const { view, metrics } = renderScrolledUp(chatId);

        metrics.scrollHeight = 1_200;
        act(() => {
          view.root.render(
            chatMessageList(chatId, undefined, {
              messages: [
                ...transcript,
                {
                  id: 'watcher-user-2',
                  role: 'user',
                  blocks: [{ type: 'text', text: 'Pipeline finished' }],
                  timestamp: 3,
                  userMessageSource: 'watcher',
                },
              ],
            }),
          );
        });
        act(() => triggerResize(view.content));
        expect(view.scroller.scrollTop).toBe(275);
        act(() => view.root.unmount());
        view.host.remove();
      });

      it('keeps the reader in place when a dequeued prompt takes its persisted id', () => {
        const chatId = 'chat-dequeue-id-swap-keeps-offset';
        const { view, metrics } = renderScrolledUp(chatId);
        const render = (
          messages: ChatMessage[],
          queuedMessages: QueuedChatMessage[] = [],
        ): void => {
          act(() => {
            view.root.render(
              chatMessageList(chatId, undefined, { messages, queuedMessages }),
            );
          });
        };

        metrics.scrollHeight = 1_100;
        render(transcript, [{ text: 'Queued ask', hostQueueEntryId: 'q-1' }]);
        expect(view.scroller.scrollTop).toBe(900);

        // The person scrolls back up while the queued prompt waits.
        view.scroller.scrollTop = 275;
        act(() => {
          view.scroller.dispatchEvent(new Event('scroll'));
        });

        // The queue hands the prompt to the transcript as a temporary row...
        const ask = {
          role: 'user' as const,
          blocks: [{ type: 'text' as const, text: 'Queued ask' }],
        };
        render([
          ...transcript,
          { ...ask, id: 'pending-queue-user:q-1', timestamp: 3 },
        ]);
        expect(view.scroller.scrollTop).toBe(275);

        // ...which the persisted message then replaces under its real id.
        render([
          ...transcript,
          {
            ...ask,
            id: 'send-user-2',
            timestamp: 4,
            userMessageSource: 'human',
          },
        ]);
        expect(view.scroller.scrollTop).toBe(275);
        act(() => view.root.unmount());
        view.host.remove();
      });

      it('restores a mid-transcript offset when the transcript loads after mount', () => {
        const chatId = 'chat-lazy-load-keeps-offset';
        clearChatScrollPosition(scrollTarget(chatId));
        saveChatScrollPosition(scrollTarget(chatId), 275, undefined, false);
        // Tabs that are not loaded yet mount with no rows.
        const view = renderList(chatId);
        installScrollableMetrics(view.scroller, {
          scrollHeight: 1_000,
          clientHeight: 200,
        });
        act(() => {
          view.root.render(
            chatMessageList(chatId, undefined, { messages: transcript }),
          );
        });
        act(() => triggerResize(view.content));

        expect(view.scroller.scrollTop).toBe(275);
        expect(
          getSavedChatScrollPosition(scrollTarget(chatId))?.atBottom,
        ).not.toBe(true);
        act(() => view.root.unmount());
        view.host.remove();
      });

      it('stops following when the reader scrolls up again after sending', () => {
        const chatId = 'chat-send-then-scroll-up';
        const { view, metrics } = renderScrolledUp(chatId);

        metrics.scrollHeight = 1_200;
        act(() => {
          view.root.render(
            chatMessageList(chatId, undefined, {
              messages: [...transcript, secondAsk],
            }),
          );
        });
        expect(view.scroller.scrollTop).toBe(1_000);
        act(() => jest.runOnlyPendingTimers());

        view.scroller.scrollTop = 400;
        act(() => {
          view.scroller.dispatchEvent(new Event('scroll'));
        });
        metrics.scrollHeight = 1_500;
        act(() => triggerResize(view.content));
        expect(view.scroller.scrollTop).toBe(400);
        act(() => view.root.unmount());
        view.host.remove();
      });

      it('keeps the reader in place for hidden prompts and automated queue entries', () => {
        const chatId = 'chat-automated-keeps-offset';
        const { view, metrics } = renderScrolledUp(chatId);

        metrics.scrollHeight = 1_200;
        act(() => {
          view.root.render(
            chatMessageList(chatId, undefined, {
              messages: [
                ...transcript,
                { ...secondAsk, id: 'hidden-user-2', hidden: true },
              ],
              queuedMessages: [
                { text: 'Hook follow-up', queuedHookQueueId: 'hook-1' },
              ],
            }),
          );
        });
        act(() => triggerResize(view.content));
        expect(view.scroller.scrollTop).toBe(275);
        act(() => view.root.unmount());
        view.host.remove();
      });

      it('keeps the reader in place when older history loads above', () => {
        const chatId = 'chat-history-keeps-offset';
        const { view, metrics } = renderScrolledUp(chatId);

        metrics.scrollHeight = 1_400;
        act(() => {
          view.root.render(
            chatMessageList(chatId, undefined, {
              messages: [
                {
                  id: 'older-user',
                  role: 'user',
                  blocks: [{ type: 'text', text: 'Older ask' }],
                  timestamp: 0,
                  userMessageSource: 'human',
                },
                ...transcript,
              ],
            }),
          );
        });
        act(() => triggerResize(view.content));
        expect(view.scroller.scrollTop).not.toBe(1_200);
        act(() => view.root.unmount());
        view.host.remove();
      });

      it('leaves the reader in place while transcript search holds the view', () => {
        const chatId = 'chat-search-suppresses-send';
        const { view, metrics } = renderScrolledUp(chatId);
        const render = (suppressAutoScroll: boolean): void => {
          act(() => {
            view.root.render(
              chatMessageList(chatId, undefined, {
                messages: [...transcript, secondAsk],
                suppressAutoScroll,
              }),
            );
          });
        };

        metrics.scrollHeight = 1_200;
        render(true);
        expect(view.scroller.scrollTop).toBe(275);

        // Closing search does not replay the send it held back.
        render(false);
        expect(view.scroller.scrollTop).toBe(275);
        act(() => view.root.unmount());
        view.host.remove();
      });
    },
  );

  it('retains a manual offset while an inactive panel has zero height', () => {
    const chatId = 'chat-hidden-panel';
    clearChatScrollPosition(chatId);
    const metrics = { scrollHeight: 1_000, clientHeight: 200 };
    const view = renderList(chatId);
    installScrollableMetrics(view.scroller, metrics);
    act(() => triggerResize(view.content));
    act(() => jest.runOnlyPendingTimers());

    view.scroller.scrollTop = 275;
    act(() => {
      view.scroller.dispatchEvent(new Event('scroll'));
    });

    metrics.scrollHeight = 0;
    metrics.clientHeight = 0;
    act(() => triggerResize(view.content));
    metrics.scrollHeight = 1_000;
    metrics.clientHeight = 200;
    act(() => triggerResize(view.content));

    expect(view.scroller.scrollTop).toBe(275);
    expect(getChatScrollPosition(scrollTarget(chatId))).toBe(275);
    act(() => view.root.unmount());
    view.host.remove();
  });

  it('does not move the transcript to the bottom when a disclosure opens', () => {
    const chatId = 'manual-disclosure-scroll';
    clearChatScrollPosition(scrollTarget(chatId));
    const view = renderList(chatId);
    const metrics = { scrollHeight: 1000, clientHeight: 200 };
    installScrollableMetrics(view.scroller, metrics);
    act(() => triggerResize(view.content));
    act(() => jest.runOnlyPendingTimers());
    expect(view.scroller.scrollTop).toBe(800);
    const toggle = document.createElement('button');
    toggle.setAttribute('data-step-row', '');
    toggle.setAttribute('aria-expanded', 'false');
    view.content.append(toggle);
    act(() => toggle.click());
    metrics.scrollHeight = 1400;
    act(() => triggerResize(view.content));
    expect(view.scroller.scrollTop).toBe(800);
    act(() => view.root.unmount());
    view.host.remove();
  });

  it('honors a user scroll before the previous programmatic-scroll frame settles', () => {
    const chatId = 'manual-during-scroll-frame';
    clearChatScrollPosition(scrollTarget(chatId));
    const view = renderList(chatId);
    const metrics = { scrollHeight: 1000, clientHeight: 200 };
    installScrollableMetrics(view.scroller, metrics);
    act(() => triggerResize(view.content));
    expect(view.scroller.scrollTop).toBe(800);
    // Deliberately do not advance RAF: the old bottom pin's guard is active.
    view.scroller.scrollTop = 275;
    act(() => {
      view.scroller.dispatchEvent(new Event('scroll'));
    });
    metrics.scrollHeight = 1400;
    act(() => triggerResize(view.content));
    expect(view.scroller.scrollTop).toBe(275);
    act(() => view.root.unmount());
    view.host.remove();
  });

  it('captures the current offset during a project transition teardown', () => {
    const chatId = 'chat-unmount-save';
    clearChatScrollPosition(chatId);
    const view = renderList(chatId);
    installScrollableMetrics(view.scroller, {
      scrollHeight: 1_000,
      clientHeight: 200,
    });
    view.scroller.scrollTop = 275;

    act(() => view.root.unmount());

    expect(getChatScrollPosition(scrollTarget(chatId))).toBe(275);
    view.host.remove();
  });

  it('reuses a saved active offset during teardown without forcing layout', () => {
    const chatId = 'chat-saved-active-unmount';
    clearChatScrollPosition(chatId);
    const view = renderList(chatId);
    installScrollableMetrics(view.scroller, {
      scrollHeight: 1_000,
      clientHeight: 200,
    });
    act(() => triggerResize(view.content));
    act(() => jest.runOnlyPendingTimers());

    view.scroller.scrollTop = 275;
    act(() => {
      view.scroller.dispatchEvent(new Event('scroll'));
    });
    expect(getChatScrollPosition(scrollTarget(chatId))).toBe(275);

    const clientHeightSpy = jest.spyOn(view.scroller, 'clientHeight', 'get');
    act(() => view.root.unmount());

    expect(getChatScrollPosition(scrollTarget(chatId))).toBe(275);
    expect(clientHeightSpy).not.toHaveBeenCalled();
    view.host.remove();
  });

  it('captures a newer live offset after resize-driven bottom pinning', () => {
    const chatId = 'chat-resize-pin-then-scroll';
    clearChatScrollPosition(chatId);
    const view = renderList(chatId);
    installScrollableMetrics(view.scroller, {
      scrollHeight: 1_000,
      clientHeight: 200,
    });
    act(() => triggerResize(view.content));
    act(() => jest.runOnlyPendingTimers());
    expect(getChatScrollPosition(scrollTarget(chatId))).toBe(800);

    // A native scroll offset can change during teardown without a final scroll
    // event. The live value must supersede the resize-created saved entry.
    view.scroller.scrollTop = 275;
    act(() => view.root.unmount());

    expect(getChatScrollPosition(scrollTarget(chatId))).toBe(275);
    view.host.remove();
  });

  it('retains the saved offset when a panel collapses before unmount', () => {
    const chatId = 'chat-collapsed-unmount';
    clearChatScrollPosition(chatId);
    const metrics = { scrollHeight: 1_000, clientHeight: 200 };
    const view = renderList(chatId);
    installScrollableMetrics(view.scroller, metrics);
    act(() => triggerResize(view.content));
    act(() => jest.runOnlyPendingTimers());

    view.scroller.scrollTop = 275;
    act(() => {
      view.scroller.dispatchEvent(new Event('scroll'));
    });
    expect(getChatScrollPosition(scrollTarget(chatId))).toBe(275);

    metrics.scrollHeight = 0;
    metrics.clientHeight = 0;
    view.scroller.scrollTop = 0;
    const clientHeightSpy = jest.spyOn(view.scroller, 'clientHeight', 'get');
    act(() => triggerResize(view.content));
    clientHeightSpy.mockClear();
    act(() => view.root.unmount());

    expect(getChatScrollPosition(scrollTarget(chatId))).toBe(275);
    expect(clientHeightSpy).not.toHaveBeenCalled();
    view.host.remove();
  });

  it('retains a programmatic bottom offset when collapse precedes resize delivery', () => {
    const chatId = 'chat-collapse-before-resize';
    clearChatScrollPosition(chatId);
    const metrics = { scrollHeight: 1_000, clientHeight: 200 };
    const view = renderList(chatId);
    installScrollableMetrics(view.scroller, metrics);
    act(() => triggerResize(view.content));
    act(() => jest.runOnlyPendingTimers());
    expect(getChatScrollPosition(scrollTarget(chatId))).toBe(800);

    // React can unmount the outgoing tab in the same task that collapses it,
    // before ResizeObserver reports the zero-height viewport.
    metrics.scrollHeight = 0;
    metrics.clientHeight = 0;
    view.scroller.scrollTop = 0;
    act(() => view.root.unmount());

    expect(getChatScrollPosition(scrollTarget(chatId))).toBe(800);
    view.host.remove();
  });

  it('does not force layout while a hidden panel unmounts', () => {
    const chatId = 'chat-hidden-unmount-layout';
    clearChatScrollPosition(chatId);
    const metrics = { scrollHeight: 1_000, clientHeight: 200 };
    const view = renderList(chatId);
    installScrollableMetrics(view.scroller, metrics);
    act(() => triggerResize(view.content));
    act(() => jest.runOnlyPendingTimers());

    view.scroller.scrollTop = 275;
    act(() => {
      view.scroller.dispatchEvent(new Event('scroll'));
    });
    view.host.hidden = true;

    let clientHeightReads = 0;
    Object.defineProperty(view.scroller, 'clientHeight', {
      configurable: true,
      get: (): number => {
        clientHeightReads += 1;
        return 0;
      },
    });
    act(() => view.root.unmount());

    expect(clientHeightReads).toBe(0);
    expect(getChatScrollPosition(scrollTarget(chatId))).toBe(275);
    view.host.remove();
  });

  it('keeps duplicate chat ids isolated between worktrees', () => {
    const chatId = 'shared-chat-id';
    const first = scrollTarget(chatId);
    const second = { ...first, worktreeId: 'other-worktree' };

    saveChatScrollPosition(first, 125);
    saveChatScrollPosition(second, 640);

    expect(getChatScrollPosition(first)).toBe(125);
    expect(getChatScrollPosition(second)).toBe(640);

    clearChatScrollPosition(chatId);
    expect(getChatScrollPosition(first)).toBeUndefined();
    expect(getChatScrollPosition(second)).toBeUndefined();
  });

  it('restores the scoped position when worktrees share a chat id', () => {
    const chatId = 'shared-transition-chat';
    const first = scrollTarget(chatId);
    const second = { ...first, worktreeId: 'other-worktree' };
    saveChatScrollPosition(first, 125);
    saveChatScrollPosition(second, 640);
    const view = renderList(chatId);
    installScrollableMetrics(view.scroller, {
      scrollHeight: 1_000,
      clientHeight: 200,
    });
    act(() => triggerResize(view.content));
    expect(view.scroller.scrollTop).toBe(125);

    act(() => {
      view.root.render(chatMessageList(chatId, second.worktreeId));
    });

    expect(view.scroller.scrollTop).toBe(640);
    act(() => view.root.unmount());
    view.host.remove();
  });
});

describe('ChatMessageList replay privacy', () => {
  it('blocks only the transcript content from session replay', () => {
    const view = renderList('chat-replay-privacy');
    // The recorder keeps a same-size placeholder for the transcript and
    // records nothing inside it; the scroll viewport stays recorded.
    expect(view.content.classList.contains('ph-no-capture')).toBe(true);
    expect(view.scroller.closest('.ph-no-capture')).toBeNull();
    act(() => view.root.unmount());
    view.host.remove();
  });
});
