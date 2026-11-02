/**
 * @jest-environment jsdom
 */
// The `fill` tab style: Chrome-style tiles that shrink to a square, then the
// strip scrolls, with a "N running" hint for running tabs scrolled out of view
// and the ⌄ list of every tab (PanelTabListButton.test.tsx). The classic
// style, and behaviour both styles share, live in PanelTabBar.test.tsx.
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PanelTabModel } from '../../../panels/registry-types';
import {
  PANEL_TAB_BUSY_ATTRIBUTE,
  PanelFillChatTabGlyph,
  PanelTabBar,
  PanelTabNumber,
  PanelTabStyleProvider,
  usePanelTabPosition,
} from '../PanelTabBar';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const TABS: PanelTabModel[] = [
  { panelId: 'panel-1', kind: 'chat', title: 'Chat One' },
  {
    panelId: 'panel-2',
    kind: 'file-diff',
    title: 'file.ts',
    instance: { fileTabId: 'file-1', filePath: '/tmp/file.ts' },
  },
];

/**
 * Keyboard-driven focus. The shared tooltips follow `:focus-visible`: a Tab
 * keydown reaches the document before focus moves, so the tooltip opens. A
 * bare `.focus()` is programmatic focus and keeps it closed.
 */
function focusViaKeyboard(element: HTMLElement | null | undefined): void {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
  );
  element?.focus();
}

describe('PanelTabBar (fill) label/trailing seams', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.documentElement.dataset.scrollbarBehavior = 'system';
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.documentElement.removeAttribute('data-scrollbar-behavior');
  });

  function render(
    overrides: Partial<Parameters<typeof PanelTabBar>[0]> = {},
  ): void {
    act(() => {
      root.render(
        <PanelTabBar
          tabStyle="fill"
          groupId="group-1"
          tabs={TABS}
          activePanelId="panel-1"
          onSelectTab={jest.fn()}
          onCloseTab={jest.fn()}
          {...overrides}
        />,
      );
    });
  }

  it('tells each tab icon its 1-based place, drawn in a fixed-width slot', () => {
    function NumberedIcon(): JSX.Element | null {
      const position = usePanelTabPosition();
      return position === null ? null : <PanelTabNumber position={position} />;
    }
    const tabs: PanelTabModel[] = Array.from({ length: 12 }, (_, index) => ({
      panelId: `panel-${index + 1}`,
      kind: 'chat',
      title: `Chat ${index + 1}`,
    }));
    render({ tabs, renderTabIcon: () => <NumberedIcon /> });
    const numbers = Array.from(
      container.querySelectorAll('[data-testid="panel-tab-number"]'),
    );
    expect(numbers.map((number) => number.textContent)).toEqual(
      tabs.map((_, index) => String(index + 1)),
    );
    // One and two digits share the same fixed slot.
    expect(numbers[0]?.className).toBe(numbers[11]?.className);
    expect(numbers[0]?.className).toContain('size-4');
    expect(numbers[0]?.className).toContain('fg-tertiary');
    // Digits keep the font's proportional widths; the fixed box holds "20".
    expect(numbers[0]?.className).not.toContain('tabular-nums');
  });

  it('renderTabTrailing renders between the label and the close button', () => {
    render({
      renderTabTrailing: (tab: PanelTabModel): JSX.Element => (
        <span data-testid={`trailing-${tab.panelId}`} />
      ),
    });

    const tab = container.querySelector('[data-testid="panel-tab-panel-1"]');
    // The label and trailing content share one wrapper on the tab's line;
    // the close button follows it as the line's last item.
    const label = tab?.querySelector('.canopy-panel-tab-label');
    const labelChildren = Array.from(label?.children ?? []);
    const titleIndex = labelChildren.findIndex((child) =>
      child.classList.contains('canopy-panel-tab-title'),
    );
    // Trailing content sits in the label's right-end indicator slot.
    const trailingIndex = labelChildren.findIndex(
      (child) =>
        child.classList.contains('canopy-panel-tab-trailing') &&
        child.querySelector('[data-testid="trailing-panel-1"]') !== null,
    );
    expect(titleIndex).toBeGreaterThanOrEqual(0);
    expect(trailingIndex).toBeGreaterThan(titleIndex);
    const main = tab?.querySelector('.canopy-panel-tab-main');
    expect(label?.parentElement).toBe(main);
    // The close button floats over the label's end, in the probe that is
    // the label's last child.
    expect(
      label?.lastElementChild?.classList.contains(
        'canopy-panel-tab-close-probe',
      ),
    ).toBe(true);
    expect(
      label?.lastElementChild?.querySelector('.canopy-panel-tab-close-slot'),
    ).not.toBeNull();
  });

  it('lets the remaining tabs re-share the row at once after a pointer close', () => {
    const tabs: PanelTabModel[] = [
      { panelId: 'panel-1', kind: 'chat', title: 'Chat One' },
      { panelId: 'panel-2', kind: 'chat', title: 'Chat Two' },
      { panelId: 'panel-3', kind: 'chat', title: 'Chat Three' },
    ];
    const onCloseTab = jest.fn();
    render({ tabs, onCloseTab });
    const close = container.querySelector(
      '[data-testid="panel-tab-close-panel-2"]',
    );
    if (!(close instanceof HTMLElement)) throw new Error('tab not rendered');
    act(() => {
      close.dispatchEvent(
        new MouseEvent('click', { bubbles: true, detail: 1 }),
      );
    });
    expect(onCloseTab).toHaveBeenCalledWith('group-1', 'panel-2');
    render({ tabs: tabs.filter((tab) => tab.panelId !== 'panel-2') });
    // No tab is held at an old width: each keeps the strip's own sizing.
    const remaining = Array.from(
      container.querySelectorAll<HTMLElement>('.canopy-panel-tab'),
    );
    expect(remaining.map((tab) => tab.style.flexBasis)).toEqual(['', '']);
  });

  describe('a crowded row', () => {
    const CROWDED: PanelTabModel[] = Array.from({ length: 22 }, (_, index) => ({
      panelId: `panel-${index + 1}`,
      kind: 'chat',
      title: `Chat ${index + 1}`,
    }));
    /** Tabs 4, 19 and 21 are working. */
    const BUSY = new Set(['panel-4', 'panel-19', 'panel-21']);

    function strip(): HTMLDivElement {
      const element = container.querySelector(
        '[data-testid="panel-tab-strip-group-1"]',
      );
      if (!(element instanceof HTMLDivElement)) {
        throw new Error('tab strip not rendered');
      }
      return element;
    }

    /**
     * Lays the strip out as a browser would (jsdom has none): 28px squares
     * 4px apart in a 300px viewport scrolled to `scrollLeft`.
     */
    /** `shift` moves every tab (as a wider selected tab would). */
    function layOut(element: HTMLDivElement, shift = 0): void {
      Object.defineProperty(element, 'scrollWidth', {
        configurable: true,
        value: 22 * 32,
      });
      Object.defineProperty(element, 'clientWidth', {
        configurable: true,
        value: 300,
      });
      element.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 300, 28);
      element
        .querySelectorAll<HTMLElement>('[role="tab"]')
        .forEach((tab, index) => {
          tab.getBoundingClientRect = (): DOMRect =>
            new DOMRect(index * 32 + shift - element.scrollLeft, 0, 28, 28);
        });
    }

    function renderCrowded(activePanelId = 'panel-1'): HTMLDivElement {
      render({
        tabs: CROWDED,
        activePanelId,
        renderTabIcon: (tab) => (
          <PanelFillChatTabGlyph busy={BUSY.has(tab.panelId)} />
        ),
      });
      const element = strip();
      layOut(element);
      act(() => {
        element.dispatchEvent(new Event('scroll'));
      });
      return element;
    }

    it('scrolls instead of shrinking past the square: fades, thumb and wheel panning', () => {
      const element = renderCrowded();
      expect(
        container
          .querySelector('.canopy-scroll-fade-end')
          ?.getAttribute('data-visible'),
      ).toBe('true');
      expect(
        container
          .querySelector('.canopy-scroll-thumb')
          ?.getAttribute('data-overflow'),
      ).toBe('true');

      const proceeded = element.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 50, cancelable: true }),
      );
      expect(element.scrollLeft).toBe(50);
      // The strip took the wheel, so the page does not scroll.
      expect(proceeded).toBe(false);
    });

    it('brings the current tab back into view when it is picked from the list', () => {
      Element.prototype.scrollIntoView = jest.fn();
      const element = renderCrowded('panel-10');
      // The user scrolls tab 10 (288-316) out of view.
      element.scrollLeft = 500;
      act(() => {
        element.dispatchEvent(new Event('scroll'));
      });
      act(() => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="panel-tab-list-group-1"]',
          )
          ?.click();
      });
      act(() => {
        document
          .querySelector<HTMLElement>(
            '[data-testid="panel-tab-list-row-panel-10"]',
          )
          ?.click();
      });
      const rect = container
        .querySelector('[data-testid="panel-tab-panel-10"]')
        ?.getBoundingClientRect();
      expect(rect?.left).toBeGreaterThanOrEqual(0);
      expect(rect?.right).toBeLessThanOrEqual(300);
    });

    it('reveals the selected tab in its new strip when it is pinned', () => {
      renderCrowded('panel-15');
      const pinnedTabs = CROWDED.map((model, index) =>
        index < 10 || model.panelId === 'panel-15'
          ? { ...model, pinned: true }
          : model,
      );
      const renderWith = (models: PanelTabModel[]): void => {
        render({
          tabs: models,
          activePanelId: 'panel-15',
          renderTabIcon: (tab) => (
            <PanelFillChatTabGlyph busy={BUSY.has(tab.panelId)} />
          ),
        });
      };
      renderWith(pinnedTabs);
      const pinnedStrip = container.querySelector<HTMLDivElement>(
        '.canopy-panel-tab-strip-wrap-pinned .canopy-panel-tab-strip',
      );
      if (pinnedStrip === null) throw new Error('No pinned strip');
      // The pinned strip overflows a 100px viewport with its 11 tiles; tiles
      // are measured where they sit, so a remounted tile is laid out too.
      Object.defineProperty(pinnedStrip, 'scrollWidth', {
        configurable: true,
        value: 11 * 32,
      });
      Object.defineProperty(pinnedStrip, 'clientWidth', {
        configurable: true,
        value: 100,
      });
      const rect = jest
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: HTMLElement): DOMRect {
          if (this === pinnedStrip) return new DOMRect(0, 0, 100, 28);
          if (
            pinnedStrip.contains(this) &&
            this.getAttribute('role') === 'tab'
          ) {
            const index = Array.from(
              pinnedStrip.querySelectorAll('[role="tab"]'),
            ).indexOf(this);
            return new DOMRect(index * 32 - pinnedStrip.scrollLeft, 0, 28, 28);
          }
          // Everything else keeps jsdom's empty box (the unpinned strip
          // and its tabs carry their own).
          return new DOMRect(0, 0, 0, 0);
        });
      act(() => {
        pinnedStrip.dispatchEvent(new Event('scroll'));
      });
      // Unpin tab 15 alone, then pin it again: the pin change alone
      // reveals it in the pinned strip.
      renderWith(
        pinnedTabs.map((model) =>
          model.panelId === 'panel-15' ? { ...model, pinned: false } : model,
        ),
      );
      pinnedStrip.scrollLeft = 0;
      renderWith(pinnedTabs);
      rect.mockRestore();
      // The last pinned tile (index 10, 320-348) is right-aligned.
      expect(pinnedStrip.scrollLeft).toBe(348 - 100);
    });

    it('keeps the selected tab in view when the strip gets narrower', async () => {
      const element = renderCrowded('panel-15');
      // Tab 15 (448-476) sits at the right of the 300px strip.
      element.scrollLeft = 196;
      await act(async () => {
        element.dispatchEvent(new Event('scroll'));
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      // The split is dragged narrower; the strip still overflows.
      Object.defineProperty(element, 'clientWidth', {
        configurable: true,
        value: 200,
      });
      element.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 200, 28);
      await act(async () => {
        element.dispatchEvent(new Event('scroll'));
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      const rect = container
        .querySelector('[data-testid="panel-tab-panel-15"]')
        ?.getBoundingClientRect();
      expect(rect?.left).toBeGreaterThanOrEqual(0);
      expect(rect?.right).toBeLessThanOrEqual(200);
    });

    it('shows no running hint while the row fits', () => {
      render({
        tabs: CROWDED.slice(0, 5),
        renderTabIcon: (tab) => (
          <PanelFillChatTabGlyph busy={BUSY.has(tab.panelId)} />
        ),
      });
      expect(
        container.querySelector('.canopy-panel-tab-edge-count'),
      ).toBeNull();
    });

    it('ends the row with the ⌄ list after the `+`, as the same shared control', () => {
      render({
        tabs: CROWDED,
        addTab: { label: 'New Chat', onAddTab: jest.fn() },
      });
      const bar = container.querySelector('.canopy-panel-tab-bar');
      const roots = Array.from(bar?.children ?? []).slice(-2);
      expect(roots.map((root) => root.className)).toEqual([
        'canopy-panel-add-tab-root',
        'canopy-panel-tab-list-root',
      ]);
      const add = container.querySelector(
        '[data-testid="panel-add-tab-group-1"]',
      );
      const list = container.querySelector(
        '[data-testid="panel-tab-list-group-1"]',
      );
      // Both are the shared titlebar icon button on the tab-strip surface.
      expect(add?.classList.contains('canopy-panel-add-tab')).toBe(true);
      expect(list?.classList.contains('canopy-panel-add-tab')).toBe(true);
      expect(list?.getAttribute('aria-label')).toBe('All tabs');
    });
  });
});

describe('PanelFillChatTabGlyph', () => {
  let container: HTMLDivElement;
  let root: Root;

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
  });

  it('draws the running spinner marked busy, else the tab number', () => {
    act(() => {
      root.render(
        <PanelTabStyleProvider value="fill">
          <PanelTabBar
            tabStyle="fill"
            groupId="group-1"
            tabs={TABS}
            activePanelId="panel-1"
            onSelectTab={jest.fn()}
            onCloseTab={jest.fn()}
            renderTabIcon={(tab) => (
              <PanelFillChatTabGlyph
                busy={tab.panelId === 'panel-2'}
                data-testid={`glyph-${tab.panelId}`}
              />
            )}
          />
        </PanelTabStyleProvider>,
      );
    });
    const idle = container.querySelector('[data-testid="glyph-panel-1"]');
    expect(idle?.textContent).toBe('1');
    expect(idle?.hasAttribute(PANEL_TAB_BUSY_ATTRIBUTE)).toBe(false);
    const busy = container.querySelector('[data-testid="glyph-panel-2"]');
    expect(busy?.getAttribute(PANEL_TAB_BUSY_ATTRIBUTE)).toBe('true');
    expect(busy?.querySelector('[data-testid="panel-tab-number"]')).toBeNull();
  });

  it('draws nothing for an idle tab outside a fill tab slot', () => {
    act(() => {
      root.render(<PanelFillChatTabGlyph busy={false} data-testid="glyph" />);
    });
    expect(container.querySelector('[data-testid="glyph"]')).toBeNull();
  });
});

describe('PanelTabBar (fill) close button', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.documentElement.dataset.scrollbarBehavior = 'system';
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.documentElement.removeAttribute('data-scrollbar-behavior');
  });

  function render(): void {
    act(() => {
      root.render(
        <PanelTabBar
          tabStyle="fill"
          groupId="group-1"
          tabs={TABS}
          activePanelId="panel-1"
          onSelectTab={jest.fn()}
          onCloseTab={jest.fn()}
        />,
      );
    });
  }

  it('renders the close button in a slot at the end of the tab line, with no tooltip', () => {
    render();
    const close = container.querySelector<HTMLButtonElement>(
      '[data-testid="panel-tab-close-panel-1"]',
    );
    expect(close).not.toBeNull();
    expect(close?.hasAttribute('title')).toBe(false);
    expect(close?.getAttribute('aria-label')).toBe('Close Chat One');
    // The slot is an inline-flex box the size of the button, alone in the
    // probe that ends the label (the probe hides it on a narrow label).
    const slot = close?.parentElement;
    expect(slot?.classList.contains('canopy-panel-tab-close-slot')).toBe(true);
    expect(slot?.classList.contains('inline-flex')).toBe(true);
    const probe = slot?.parentElement;
    expect(probe?.classList.contains('canopy-panel-tab-close-probe')).toBe(
      true,
    );
    expect(probe?.children).toHaveLength(1);
    expect(
      probe?.parentElement?.classList.contains('canopy-panel-tab-label'),
    ).toBe(true);
    expect(probe?.parentElement?.lastElementChild).toBe(probe);
    expect(slot?.closest('[role="tab"]')?.getAttribute('data-testid')).toBe(
      'panel-tab-panel-1',
    );
  });

  it('opens no tooltip on hover or keyboard focus', () => {
    render();
    const close = container.querySelector<HTMLButtonElement>(
      '[data-testid="panel-tab-close-panel-1"]',
    );
    act(() => {
      close?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    act(() => {
      focusViaKeyboard(close);
    });
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
  });
});
