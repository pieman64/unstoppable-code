/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  FloatingChatRecentList,
  FloatingChatWindow,
  type FloatingChatWindowProps,
} from '../FloatingChatWindow';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('FloatingChatWindow', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderWindow(
    props: Partial<FloatingChatWindowProps> = {},
  ): HTMLElement {
    act(() =>
      root.render(
        <FloatingChatWindow
          title="New chat"
          surface="panel"
          onExpand={jest.fn()}
          onMinimize={jest.fn()}
          {...props}
        >
          <div data-testid="chat-body">Chat</div>
        </FloatingChatWindow>,
      ),
    );
    const frame = container.querySelector<HTMLElement>(
      '[data-testid="floating-chat-window"]',
    );
    if (!frame) throw new Error('frame not rendered');
    return frame;
  }

  const button = (frame: HTMLElement, label: string): HTMLButtonElement => {
    const found = frame.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    );
    if (!found) throw new Error(`${label} button not rendered`);
    return found;
  };

  it('offers Close last, after Minimize, only when given', () => {
    const onClose = jest.fn();
    const frame = renderWindow({ onClose });
    const header = frame.querySelector(
      '[data-testid="floating-chat-window-header"]',
    );
    expect(
      Array.from(header?.querySelectorAll('button') ?? []).map((control) =>
        control.getAttribute('aria-label'),
      ),
    ).toEqual(['Open full window', 'Minimize', 'Close']);
    act(() => button(frame, 'Close').click());
    expect(onClose).toHaveBeenCalledTimes(1);

    const withoutClose = renderWindow();
    expect(withoutClose.querySelector('button[aria-label="Close"]')).toBeNull();
  });

  it('titles the chat and wires Open full window and Minimize', () => {
    const onExpand = jest.fn();
    const onMinimize = jest.fn();
    const frame = renderWindow({ onExpand, onMinimize });

    expect(
      frame.querySelector('[data-testid="floating-chat-window-title"]')
        ?.textContent,
    ).toBe('New chat');
    expect(frame.querySelector('[data-testid="chat-body"]')).not.toBeNull();
    act(() => button(frame, 'Open full window').click());
    act(() => button(frame, 'Minimize').click());
    expect(onExpand).toHaveBeenCalledTimes(1);
    expect(onMinimize).toHaveBeenCalledTimes(1);
    // New chat only shows when the host offers it.
    expect(frame.querySelector('button[aria-label="New chat"]')).toBeNull();
  });

  it('draws the design-system shadow inside the native panel', () => {
    const frame = renderWindow({ surface: 'panel' });
    const edge = frame.querySelector<HTMLElement>(
      '[data-testid="floating-chat-window-edge"]',
    );
    expect(edge?.className).toContain('shadow-xl');
    expect(edge?.className).toContain('rounded-2xl');
    expect(edge?.className).toContain('pointer-events-none');
    // No ring of its own: the shadow token carries the edge.
    expect(edge?.className).not.toContain('ring');
    // Last child, so it paints over the chat rather than under it.
    expect(frame.lastElementChild).toBe(edge);
  });

  it('keeps the header text from being selected', () => {
    const frame = renderWindow();
    expect(
      frame.querySelector('[data-testid="floating-chat-window-header"]')
        ?.className,
    ).toContain('select-none');
  });

  it('fades the header into the chat below it', () => {
    const frame = renderWindow();
    const fade = frame.querySelector<HTMLElement>(
      '[data-testid="floating-chat-window-header-fade"]',
    );
    expect(fade?.className).toContain('top-11');
    expect(fade?.className).toContain('from-base to-transparent');
    expect(fade?.className).toContain('pointer-events-none');
  });

  it('leaves the web card to its own shadow', () => {
    const frame = renderWindow({ surface: 'card' });
    expect(frame.className).toContain('shadow-xl');
    expect(
      frame.querySelector('[data-testid="floating-chat-window-edge"]'),
    ).toBeNull();
  });

  describe('resizing', () => {
    const limits = {
      minWidth: 360,
      minHeight: 400,
      maxWidth: 640,
      maxHeight: 960,
    };

    function drag(
      handle: Element | null,
      from: { x: number; y: number },
      to: { x: number; y: number },
    ): void {
      if (!handle) throw new Error('resize handle not rendered');
      const fire = (type: string, at: { x: number; y: number }): void => {
        const event = new MouseEvent(type, {
          bubbles: true,
          button: 0,
          screenX: at.x,
          screenY: at.y,
        });
        Object.defineProperty(event, 'pointerId', { value: 1 });
        handle.dispatchEvent(event);
      };
      act(() => fire('pointerdown', from));
      act(() => fire('pointermove', to));
      act(() => fire('pointerup', to));
    }

    beforeEach(() => {
      Element.prototype.setPointerCapture = jest.fn();
      Element.prototype.hasPointerCapture = jest.fn(() => true);
      Element.prototype.releasePointerCapture = jest.fn();
      jest
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockReturnValue(new DOMRect(0, 0, 400, 640));
    });

    afterEach(() => jest.restoreAllMocks());

    it('has no handles unless the host makes it resizable', () => {
      const frame = renderWindow();
      expect(
        frame.querySelector('[data-testid^="floating-chat-window-resize-"]'),
      ).toBeNull();
    });

    it('grows toward the top-left from its edges and corner, within limits', () => {
      const onResize = jest.fn();
      const frame = renderWindow({ resize: { ...limits, onResize } });
      const handle = (edge: string): Element | null =>
        frame.querySelector(
          `[data-testid="floating-chat-window-resize-${edge}"]`,
        );

      // Dragging the left edge 80px left widens it; the height stays.
      drag(handle('left'), { x: 500, y: 300 }, { x: 420, y: 250 });
      expect(onResize).toHaveBeenLastCalledWith({ width: 480, height: 640 });

      // Dragging the top edge 100px up makes it taller; the width stays.
      drag(handle('top'), { x: 500, y: 300 }, { x: 450, y: 200 });
      expect(onResize).toHaveBeenLastCalledWith({ width: 400, height: 740 });

      // The corner moves both, and never past the limits.
      drag(handle('top-left'), { x: 500, y: 300 }, { x: -1000, y: -1000 });
      expect(onResize).toHaveBeenLastCalledWith({ width: 640, height: 960 });
      drag(handle('top-left'), { x: 500, y: 300 }, { x: 900, y: 900 });
      expect(onResize).toHaveBeenLastCalledWith({ width: 360, height: 400 });
    });

    it('follows the pointer at a page zoom other than 100%', () => {
      // Pointer screen coordinates are not page-zoomed, but the window's
      // size is in CSS px: at 200% a 80px drag is 40 CSS px.
      const onResize = jest.fn();
      const frame = renderWindow({
        resize: { ...limits, onResize, pageZoom: (): number => 2 },
      });
      drag(
        frame.querySelector(
          '[data-testid="floating-chat-window-resize-top-left"]',
        ),
        { x: 500, y: 300 },
        { x: 420, y: 200 },
      );
      expect(onResize).toHaveBeenLastCalledWith({ width: 440, height: 690 });
    });
  });

  it('keeps a plain title when the host passes no switcher', () => {
    const frame = renderWindow();
    const title = frame.querySelector(
      '[data-testid="floating-chat-window-title"]',
    );
    expect(title?.tagName).toBe('H2');
  });

  it('switches between all chats from the title menu', () => {
    const onSelect = jest.fn();
    const frame = renderWindow({
      title: 'Deploy report',
      switcher: {
        items: [
          { id: 'a', title: 'Deploy report', timeLabel: '2m' },
          { id: 'b', title: 'Rollout health', timeLabel: '1h' },
        ],
        activeId: 'a',
        onSelect,
      },
    });
    const trigger = frame.querySelector<HTMLButtonElement>(
      'button[data-testid="floating-chat-window-title"]',
    );
    if (!trigger) throw new Error('title menu button not rendered');
    expect(trigger.textContent).toBe('Deploy report');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    act(() => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const rows = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-testid="floating-chat-window-chat"]',
      ),
    );
    expect(rows.map((row) => row.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
    ]);
    // The open chat is checked; the others show their age.
    expect(rows[1]?.textContent).toBe('Rollout health1h');

    act(() => rows[1]?.click());
    expect(onSelect).toHaveBeenCalledWith('b');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    // The menu holds every chat; there is no See all.
    act(() => trigger.click());
    expect(document.body.textContent).not.toContain('See all');
  });

  it('offers New chat when the host passes a handler', () => {
    const onNewChat = jest.fn();
    const frame = renderWindow({ onNewChat });

    act(() => button(frame, 'New chat').click());
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it('fills a host panel without dragging its window, or floats as a card', () => {
    // Inside the app window a drag region would move the whole app window.
    const panel = renderWindow({ surface: 'panel' });
    expect(
      panel.querySelector('[data-testid="floating-chat-window-header"]')
        ?.className,
    ).not.toContain('electron-drag');
    expect(panel.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['h-full', 'w-full']),
    );
    expect(panel.className).not.toContain('fixed');

    const card = renderWindow({ surface: 'card' });
    expect(card.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['fixed', 'bottom-4', 'right-4', 'shadow-xl']),
    );
  });
});

describe('FloatingChatRecentList', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('lists recent chats with their age and opens one, with no See all', () => {
    const onSelect = jest.fn();
    act(() =>
      root.render(
        <FloatingChatRecentList
          items={[
            { id: 'a', title: 'Polished message', timeLabel: '2h' },
            { id: 'b', title: 'Release notes', timeLabel: '1d' },
          ]}
          onSelect={onSelect}
        />,
      ),
    );

    expect(container.textContent).toContain('Recent chats');
    // The heading reads as a label above quieter rows, with room below it.
    const heading = container.querySelector('h3');
    expect(heading?.className).toContain('fg-primary');
    expect(heading?.className).toContain('pb-2');
    // Rows round like the sidebar's rows.
    expect(
      container.querySelector('[data-testid="floating-chat-recent-item"]')
        ?.className,
    ).toContain('rounded-row');
    const rows = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="floating-chat-recent-item"]',
    );
    expect(Array.from(rows).map((row) => row.textContent)).toEqual([
      'Polished message2h',
      'Release notes1d',
    ]);
    act(() => rows[1]?.click());
    expect(onSelect).toHaveBeenCalledWith('b');
    // The rest of the chats are in the title menu.
    expect(container.textContent).not.toContain('See all');
  });

  it('renders nothing without recent chats', () => {
    act(() =>
      root.render(<FloatingChatRecentList items={[]} onSelect={jest.fn()} />),
    );

    expect(container.firstElementChild).toBeNull();
  });
});
