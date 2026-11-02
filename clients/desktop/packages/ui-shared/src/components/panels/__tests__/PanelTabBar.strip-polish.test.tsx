/**
 * @jest-environment jsdom
 */
// The fill tab row's ⌄, its unread dot, the ⌄ list's status slot, and the
// thin scrollbar's drag (tab strip polish). jsdom has no layout, so each test
// lays the strip out by hand.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PanelTabModel } from '../../../panels/registry-types';
import { PanelFillChatTabGlyph, PanelTabBar } from '../PanelTabBar';
import { SCROLL_TRACK_HOVER_DELAY_MS } from '../../../lib/useHorizontalOverflowScroll';
import { UNREAD_DOT_DELAY_MS } from '../usePanelTabStripState';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const TAB_WIDTH = 224;

function tabs(count: number): PanelTabModel[] {
  return Array.from({ length: count }, (_, index) => ({
    panelId: `panel-${index + 1}`,
    kind: 'chat',
    title: `Chat ${index + 1}`,
  }));
}

describe('PanelTabBar fill row polish', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    Element.prototype.scrollIntoView = jest.fn();
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    jest.useRealTimers();
  });

  function strip(): HTMLDivElement {
    const element = container.querySelector(
      '[data-testid="panel-tab-strip-group-1"]',
    );
    if (!(element instanceof HTMLDivElement)) throw new Error('no strip');
    return element;
  }

  function listRoot(): HTMLElement {
    const element = container.querySelector<HTMLElement>(
      '[data-testid="panel-tab-list-root-group-1"]',
    );
    if (!element) throw new Error('no ⌄');
    return element;
  }

  /**
   * Lays the strip out in a `viewport`-wide box: tabs at their resting
   * width while they fit, 96px once they do not, scrolled to `scrollLeft`.
   */
  function layOut(viewport: number, scrollLeft = 0): void {
    const element = strip();
    const all = Array.from(
      element.querySelectorAll<HTMLElement>('.canopy-panel-tab'),
    );
    const natural = all.length * TAB_WIDTH + (all.length - 1) * 4 + 8;
    const fits = natural <= viewport;
    const width = fits ? TAB_WIDTH : 96;
    const content = all.length * width + (all.length - 1) * 4 + 8;
    Object.defineProperty(element, 'clientWidth', {
      configurable: true,
      value: fits ? natural : viewport,
    });
    Object.defineProperty(element, 'scrollWidth', {
      configurable: true,
      value: fits ? natural : content,
    });
    element.scrollLeft = scrollLeft;
    element.getBoundingClientRect = (): DOMRect =>
      new DOMRect(0, 0, fits ? natural : viewport, 28);
    all.forEach((tab, index) => {
      tab.getBoundingClientRect = (): DOMRect =>
        new DOMRect(4 + index * (width + 4) - scrollLeft, 0, width, 28);
    });
    act(() => {
      element.dispatchEvent(new Event('scroll'));
    });
  }

  function render(
    overrides: Partial<Parameters<typeof PanelTabBar>[0]> = {},
  ): void {
    act(() => {
      root.render(
        <PanelTabBar
          tabStyle="fill"
          groupId="group-1"
          tabs={tabs(3)}
          activePanelId="panel-1"
          onSelectTab={jest.fn()}
          onCloseTab={jest.fn()}
          {...overrides}
        />,
      );
    });
  }

  it('shows ⌄ only once the tabs no longer fit', () => {
    render();
    layOut(2000);
    expect(listRoot().dataset.hidden).toBeDefined();
    layOut(400);
    expect(listRoot().dataset.hidden).toBeUndefined();
  });

  it('shows ⌄ and dots it for an unread pinned tab when only the pinned strip overflows', () => {
    jest.useFakeTimers();
    render({
      tabs: tabs(10).map((tab, index) => ({ ...tab, pinned: index < 8 })),
      activePanelId: 'panel-9',
      renderTabIcon: (tab) => (
        <span data-unread={tab.panelId === 'panel-8' ? true : undefined} />
      ),
    });
    layOut(2000);
    const pinned = container.querySelector<HTMLDivElement>(
      '[data-testid="panel-tab-strip-pinned-group-1"]',
    );
    if (!pinned) throw new Error('no pinned strip');
    // Eight 28px tiles in a 100px pinned strip: the last ones are out of view.
    Object.defineProperty(pinned, 'clientWidth', {
      configurable: true,
      value: 100,
    });
    Object.defineProperty(pinned, 'scrollWidth', {
      configurable: true,
      value: 8 * 32 + 4,
    });
    pinned.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 100, 28);
    pinned
      .querySelectorAll<HTMLElement>('.canopy-panel-tab')
      .forEach((tab, index) => {
        tab.getBoundingClientRect = (): DOMRect =>
          new DOMRect(4 + index * 32, 0, 28, 28);
      });
    act(() => {
      pinned.dispatchEvent(new Event('scroll'));
    });
    act(() => {
      jest.advanceTimersByTime(UNREAD_DOT_DELAY_MS + 50);
    });
    expect(listRoot().dataset.hidden).toBeUndefined();
    expect(listRoot().dataset.unread).toBeDefined();
  });

  it('draws no "N running" hint in a fill row', () => {
    render({
      tabs: tabs(12),
      activePanelId: 'panel-12',
      renderTabIcon: (tab) => (
        <PanelFillChatTabGlyph busy={tab.panelId === 'panel-1'} />
      ),
    });
    layOut(400, 800);
    expect(container.querySelector('.canopy-panel-tab-edge-count')).toBeNull();
  });

  it('dots ⌄ only after an unread tab has stayed out of view, and clears it the same way', () => {
    jest.useFakeTimers();
    render({
      tabs: tabs(12),
      activePanelId: 'panel-1',
      renderTabIcon: (tab) => (
        <span data-unread={tab.panelId === 'panel-10' ? true : undefined} />
      ),
    });
    layOut(400, 0);
    act(() => {
      jest.advanceTimersByTime(UNREAD_DOT_DELAY_MS - 50);
    });
    expect(listRoot().dataset.unread).toBeUndefined();
    act(() => {
      jest.advanceTimersByTime(100);
    });
    expect(listRoot().dataset.unread).toBeDefined();

    // Scrolled so the unread tab shows: the dot waits as long to go.
    layOut(400, 700);
    act(() => {
      jest.advanceTimersByTime(UNREAD_DOT_DELAY_MS - 50);
    });
    expect(listRoot().dataset.unread).toBeDefined();
    act(() => {
      jest.advanceTimersByTime(100);
    });
    expect(listRoot().dataset.unread).toBeUndefined();
  });

  it('never flicks the dot when scrolling passes over an unread tab', () => {
    jest.useFakeTimers();
    render({
      tabs: tabs(12),
      renderTabIcon: (tab) => (
        <span data-unread={tab.panelId === 'panel-10' ? true : undefined} />
      ),
    });
    layOut(400, 700);
    act(() => {
      jest.advanceTimersByTime(UNREAD_DOT_DELAY_MS + 50);
    });
    // Scrolled past it and back within the delay.
    layOut(400, 0);
    act(() => {
      jest.advanceTimersByTime(100);
    });
    layOut(400, 700);
    // Step through the window where a stale timer would fire, so even a
    // brief blink fails the test.
    for (let step = 0; step < (UNREAD_DOT_DELAY_MS * 3) / 10; step += 1) {
      act(() => {
        jest.advanceTimersByTime(10);
      });
      expect(listRoot().dataset.unread).toBeUndefined();
    }
  });

  describe('⌄ list rows', () => {
    function open(): void {
      act(() => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="panel-tab-list-group-1"]',
          )
          ?.click();
      });
    }

    function row(panelId: string): HTMLElement {
      const option = document.querySelector(
        `[data-testid="panel-tab-list-row-${panelId}"]`,
      );
      const element = option?.closest<HTMLElement>(
        '.canopy-panel-tab-list-row',
      );
      if (!element) throw new Error(`no row ${panelId}`);
      return element;
    }

    it('keeps a running row numbered and moves its spinner to the status slot', () => {
      render({
        tabs: tabs(4),
        renderTabIcon: (tab) => (
          <PanelFillChatTabGlyph busy={tab.panelId === 'panel-2'} />
        ),
      });
      layOut(400);
      open();
      const running = row('panel-2');
      expect(
        running.querySelector('[data-testid="panel-tab-number"]')?.textContent,
      ).toBe('2');
      expect(
        running.querySelector(
          '.canopy-panel-tab-list-busy [data-panel-tab-busy], .canopy-panel-tab-list-busy[data-panel-tab-busy]',
        ),
      ).not.toBeNull();
    });

    it('swaps the highlighted row for × only after the keyboard moves it', () => {
      render({ tabs: tabs(4) });
      layOut(400);
      open();
      const list = document.querySelector<HTMLElement>(
        '.canopy-panel-tab-list',
      );
      expect(list?.dataset.keyboardMoved).toBeUndefined();
      act(() => {
        list?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
        );
      });
      expect(list?.dataset.keyboardMoved).toBeDefined();
    });
  });

  describe('thin scrollbar', () => {
    /** Strip 400 wide, content 1200: the thumb is a third of the track. */
    function layOutScroll(): {
      element: HTMLDivElement;
      track: HTMLElement;
      thumb: HTMLElement;
    } {
      const element = strip();
      Object.defineProperty(element, 'clientWidth', {
        configurable: true,
        value: 400,
      });
      Object.defineProperty(element, 'scrollWidth', {
        configurable: true,
        value: 1200,
      });
      act(() => {
        element.dispatchEvent(new Event('scroll'));
      });
      const wrap = element.parentElement;
      const track = wrap?.querySelector<HTMLElement>('.canopy-scroll-track');
      const thumb = wrap?.querySelector<HTMLElement>('.canopy-scroll-thumb');
      if (!track || !thumb) throw new Error('no track or thumb');
      Object.defineProperty(thumb, 'offsetWidth', {
        configurable: true,
        value: 132,
      });
      thumb.getBoundingClientRect = (): DOMRect => {
        const left = 2 + (element.scrollLeft / 800) * (396 - 132);
        return new DOMRect(left, 0, 132, 2);
      };
      track.setPointerCapture = jest.fn();
      track.hasPointerCapture = jest.fn(() => true);
      track.releasePointerCapture = jest.fn();
      return { element, track, thumb };
    }

    function pointer(target: HTMLElement, type: string, clientX: number): void {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        button: 0,
      });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      act(() => {
        target.dispatchEvent(event);
      });
    }

    it('drags from the grab point, clamped at both ends, selecting no text', () => {
      render({ tabs: tabs(12) });
      const { element, track } = layOutScroll();
      // Grab the thumb 50px in, drag 66px: the thumb moves 66px of its
      // 264px travel, a quarter of the 800px range.
      pointer(track, 'pointerdown', 52);
      expect(document.documentElement.style.userSelect).toBe('none');
      pointer(track, 'pointermove', 118);
      expect(element.scrollLeft).toBeCloseTo(200, 0);
      pointer(track, 'pointermove', 5000);
      expect(element.scrollLeft).toBe(800);
      pointer(track, 'pointermove', -5000);
      expect(element.scrollLeft).toBe(0);
      pointer(track, 'pointerup', 0);
      expect(document.documentElement.style.userSelect).toBe('');
    });

    it('shows the line only once the pointer rests on its track', () => {
      jest.useFakeTimers();
      render({ tabs: tabs(12) });
      const { track, thumb } = layOutScroll();
      const enter = (): void => {
        act(() => {
          track.dispatchEvent(new Event('pointerenter'));
        });
      };
      const leave = (): void => {
        act(() => {
          track.dispatchEvent(new Event('pointerleave'));
        });
      };
      // Crossing the zone on the way to the tabs: the line stays hidden.
      enter();
      act(() => {
        jest.advanceTimersByTime(SCROLL_TRACK_HOVER_DELAY_MS - 100);
      });
      expect(thumb.dataset.revealed).toBe('false');
      expect(thumb.dataset.active).toBe('false');
      leave();
      act(() => {
        jest.advanceTimersByTime(1000);
      });
      expect(thumb.dataset.revealed).toBe('false');
      expect(thumb.dataset.active).toBe('false');
      // Resting there shows and grows it.
      enter();
      act(() => {
        jest.advanceTimersByTime(SCROLL_TRACK_HOVER_DELAY_MS + 10);
      });
      expect(thumb.dataset.revealed).toBe('true');
      expect(thumb.dataset.active).toBe('true');
      leave();
    });

    it('jumps when the track beside the thumb is pressed', () => {
      render({ tabs: tabs(12) });
      const { element, track } = layOutScroll();
      // Thumb spans 2..134 at rest; press at 168, 100px past its centre:
      // the thumb centres there.
      pointer(track, 'pointerdown', 168);
      expect(element.scrollLeft).toBeCloseTo((100 * 800) / 264, 0);
      pointer(track, 'pointerup', 168);
    });
  });
});
