/**
 * @jest-environment jsdom
 */
import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CoworkWorkEntryMeta } from '@canopy/desktop-shared/types';
import { AppAdvisorFloatingSurface } from '@/components/app-advisor/AppAdvisorFloatingSurface';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useChatStore } from '@/stores/chatStore';
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';
import type { ChatTab } from '@/stores/chat/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('@/components/chat/WorktreeChatSurface', () => ({
  WorktreeChatSurface: ({
    chatTabId,
    emptyStateCenter,
  }: {
    chatTabId: string;
    emptyStateCenter?: ReactNode;
  }): JSX.Element => (
    <div data-testid="mock-chat-surface" data-chat-tab-id={chatTabId}>
      {emptyStateCenter}
    </div>
  ),
}));

const ENTRY_ID = 'entry-1';
const OTHER_ENTRY_ID = 'entry-2';
const EARLIER_TAB_ID = 'tab-earlier';
const NEW_TAB_ID = 'tab-new';
const OTHER_TAB_ID = 'tab-other';

function chatTab(
  id: string,
  title: string,
  options: {
    messageCount?: number;
    lastMessageAt?: number;
    createdAt?: string;
  } = {},
): ChatTab {
  const messageCount = options.messageCount ?? 0;
  const tab = {
    id,
    title,
    kind: 'chat',
    createdAt: options.createdAt ?? '2026-10-01T00:00:00.000Z',
    messages: [],
    queuedMessages: [],
    transcript:
      messageCount > 0
        ? {
            format: 'complete-message-jsonl-v1',
            committedMessageCount: messageCount,
            committedByteLength: 1,
            transcriptRevision: 1,
            hasActiveSidecar: false,
            messageCount,
            lastMessageAt: options.lastMessageAt,
          }
        : undefined,
  };
  return tab as unknown as ChatTab;
}

function workEntry(
  id: string,
  title: string,
  lastMessageAt: string,
): CoworkWorkEntryMeta {
  return {
    id,
    title,
    createdAt: '2026-10-01T00:00:00.000Z',
    lastMessageAt,
    chatCount: 1,
  };
}

describe('AppAdvisorFloatingSurface', () => {
  let container: HTMLDivElement;
  let root: Root;
  let selectWorkEntryMock: jest.Mock<Promise<boolean>, [string]>;
  let switchTabMock: jest.Mock;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    selectWorkEntryMock = jest
      .fn<Promise<boolean>, [string]>()
      .mockResolvedValue(true);
    switchTabMock = jest.fn();
    useStandaloneChatStore.setState({
      workEntries: [
        // The entry's title follows its latest chat, the earlier one here,
        // even while a fresh chat in the same entry is open.
        workEntry(ENTRY_ID, 'Earlier chat', '2026-10-02T00:00:00.000Z'),
        workEntry(OTHER_ENTRY_ID, 'Other chat', '2026-10-01T12:00:00.000Z'),
      ],
      selectWorkEntry: selectWorkEntryMock,
      startNewChat: jest.fn().mockResolvedValue(undefined),
    });
    useChatStore.setState({
      switchTab: switchTabMock,
      worktreeChats: {
        [`app-advisor/${ENTRY_ID}`]: {
          // "New chat" opened a second tab in the same entry.
          tabs: [
            chatTab(EARLIER_TAB_ID, 'Earlier chat', {
              messageCount: 2,
              lastMessageAt: Date.parse('2026-10-02T00:00:00.000Z'),
            }),
            chatTab(NEW_TAB_ID, 'New chat', {
              createdAt: '2026-10-03T00:00:00.000Z',
            }),
          ],
          activeTabId: NEW_TAB_ID,
        },
        [`app-advisor/${OTHER_ENTRY_ID}`]: {
          tabs: [
            chatTab(OTHER_TAB_ID, 'Other chat', {
              messageCount: 2,
              lastMessageAt: Date.parse('2026-10-01T12:00:00.000Z'),
            }),
          ],
          activeTabId: OTHER_TAB_ID,
        },
      },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function render(): void {
    act(() => {
      root.render(
        <AppAdvisorFloatingSurface
          ready
          activeWorkEntryId={ENTRY_ID}
          activeChatId={NEW_TAB_ID}
        />,
      );
    });
  }

  function title(): HTMLElement {
    const element = document.querySelector<HTMLElement>(
      '[data-testid="app-advisor-floating-title"]',
    );
    if (!element) throw new Error('missing floating title');
    return element;
  }

  function menuItems(): HTMLElement[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-testid="app-advisor-floating-chat"]',
      ),
    );
  }

  it('titles the panel after the open chat, not its Work Entry', () => {
    render();

    expect(title().textContent).toBe('New chat');
  });

  it('switches back to an earlier chat in the same Work Entry from the title menu', async () => {
    render();

    act(() => {
      title().click();
    });
    const items = menuItems();
    expect(items.map((item) => item.textContent)).toEqual([
      'New chat',
      expect.stringContaining('Earlier chat'),
      expect.stringContaining('Other chat'),
    ]);
    expect(items[0]?.getAttribute('aria-checked')).toBe('true');

    await act(async () => {
      items[1]?.click();
      await Promise.resolve();
    });

    expect(selectWorkEntryMock).toHaveBeenCalledWith(ENTRY_ID);
    expect(switchTabMock).toHaveBeenCalledWith(EARLIER_TAB_ID, {
      projectId: 'app-advisor',
      worktreeId: ENTRY_ID,
    });
  });

  it('offers an earlier chat in the same Work Entry among the recent chats', async () => {
    render();

    const recent = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-testid="floating-chat-recent-item"]',
      ),
    );
    expect(recent.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Earlier chat'),
      expect.stringContaining('Other chat'),
    ]);

    await act(async () => {
      recent[1]?.click();
      await Promise.resolve();
    });

    expect(selectWorkEntryMock).toHaveBeenCalledWith(OTHER_ENTRY_ID);
    expect(switchTabMock).toHaveBeenCalledWith(OTHER_TAB_ID, {
      projectId: 'app-advisor',
      worktreeId: OTHER_ENTRY_ID,
    });
  });
  it('resizes under the pointer at the interface scale', () => {
    // The interface scale is a page zoom; pointer screen coordinates are
    // not zoomed, so a 60px drag at 150% is 40 CSS px.
    const setFloatingSize = jest.fn();
    const appAdvisorBefore = useAppAdvisorStore.getState();
    useAppAdvisorStore.setState({ setFloatingSize });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { getUiZoomFactor: (): number => 1.5 },
    });
    Element.prototype.setPointerCapture = jest.fn();
    Element.prototype.hasPointerCapture = jest.fn(() => true);
    Element.prototype.releasePointerCapture = jest.fn();
    const rect = jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 0, 400, 600));
    try {
      render();
      const handle = document.querySelector(
        '[data-testid="app-advisor-floating-resize-left"]',
      );
      if (!handle) throw new Error('missing resize handle');
      const fire = (type: string, x: number): void => {
        const event = new MouseEvent(type, {
          bubbles: true,
          button: 0,
          screenX: x,
          screenY: 300,
        });
        Object.defineProperty(event, 'pointerId', { value: 1 });
        handle.dispatchEvent(event);
      };
      act(() => fire('pointerdown', 500));
      act(() => fire('pointermove', 440));
      act(() => fire('pointerup', 440));

      expect(setFloatingSize).toHaveBeenLastCalledWith({
        width: 440,
        height: 600,
      });
    } finally {
      rect.mockRestore();
      useAppAdvisorStore.setState(appAdvisorBefore, true);
      Reflect.deleteProperty(window, 'api');
    }
  });
});
