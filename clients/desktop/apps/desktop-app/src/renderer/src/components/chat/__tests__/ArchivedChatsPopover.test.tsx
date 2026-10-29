/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { hasBrowserNativeViewOverlay } from '@/lib/browserNativeOverlay';
import { ArchivedChatsPopover } from '../ArchivedChatsPopover';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CARD_HEIGHT = 300;

function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 600,
    right: 628,
    width: 28,
    height: bottom - top,
    x: 600,
    y: top,
    toJSON: () => ({}),
  };
}

describe('ArchivedChatsPopover anchored to the body (tab strip)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let anchor: HTMLDivElement;
  let scrollHeight: PropertyDescriptor | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    anchor = document.createElement('div');
    document.body.append(anchor);
    scrollHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollHeight',
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => CARD_HEIGHT,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 800,
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    anchor.remove();
    if (scrollHeight !== undefined) {
      Object.defineProperty(
        HTMLElement.prototype,
        'scrollHeight',
        scrollHeight,
      );
    }
  });

  /** `null` renders the in-place card the worktree header uses. */
  function renderPopover(
    anchorRect: DOMRect | null,
    look: 'classic' | 'card' = 'classic',
  ): HTMLElement {
    if (anchorRect !== null) {
      anchor.getBoundingClientRect = (): DOMRect => anchorRect;
    }
    act(() => {
      root.render(
        <ArchivedChatsPopover
          summaries={[
            {
              chatId: 'archived-1',
              title: 'Archived chat',
              turnCount: 2,
              archivedAt: '2026-06-20T00:00:00.000Z',
              createdAt: '2026-06-19T00:00:00.000Z',
              restorable: true,
              providerType: 'claude',
            },
          ]}
          onOpenChat={jest.fn()}
          onRestore={jest.fn()}
          onSummarize={jest.fn()}
          onOpenModal={jest.fn()}
          summarizingIds={new Set()}
          restoringIds={new Set()}
          anchor={anchorRect === null ? null : anchor}
          look={look}
        />,
      );
    });
    const popover = document.querySelector<HTMLElement>(
      '[data-testid="chat-tab-archive-popover"]',
    );
    if (popover === null) throw new Error('popover missing');
    return popover;
  }

  it('opens below the anchor when the window has room there', () => {
    const popover = renderPopover(rect(40, 68));

    expect(popover.style.top).toBe('68px');
    expect(popover.classList.contains('pt-1')).toBe(true);
  });

  it('opens above an anchor near the bottom of the window', () => {
    const popover = renderPopover(rect(740, 768));

    // Flush against the anchor's top, so the gap stays hoverable.
    expect(popover.style.top).toBe(`${740 - CARD_HEIGHT}px`);
    expect(popover.classList.contains('pb-1')).toBe(true);
    expect(Number.parseFloat(popover.style.maxHeight)).toBeGreaterThanOrEqual(
      CARD_HEIGHT,
    );
  });

  // The Browser panel is a native view drawn above the page. It only yields
  // to surfaces its overlay detection recognizes; any other card that drops
  // over a Browser pane is cut off where the pane starts.
  it.each([
    ['in the worktree header', null],
    ['anchored to the tab strip', rect(40, 68)],
  ])('counts as a native Browser view overlay %s', (_placement, anchorRect) => {
    renderPopover(anchorRect);

    expect(hasBrowserNativeViewOverlay(document)).toBe(true);
  });

  describe('with the Archived chats card look', () => {
    it.each([
      ['in the worktree header', null],
      ['anchored to the tab strip', rect(40, 68)],
    ])(
      'draws the shared card and still counts as a Browser overlay %s',
      (_placement, anchorRect) => {
        const popover = renderPopover(anchorRect, 'card');

        const card = popover.querySelector('[role="group"]');
        expect(card).toBeInstanceOf(HTMLElement);
        expect(card?.getAttribute('aria-label')).toBe('Archived chats');
        expect(popover.querySelector('.bg-popover')).toBeNull();
        expect(hasBrowserNativeViewOverlay(document)).toBe(true);
      },
    );

    it('shows the chat title and its turn count in the row', () => {
      const popover = renderPopover(null, 'card');

      const row = popover.querySelector(
        '[data-testid="chat-tab-archive-popover-row"]',
      );
      expect(row).toBeInstanceOf(HTMLElement);
      expect(row?.getAttribute('data-archived-chat-id')).toBe('archived-1');
      expect(row?.textContent).toContain('Archived chat');
      expect(row?.textContent).toContain('2 turns');
      expect(row?.querySelector('[title]')).toBeNull();
    });
  });
});
