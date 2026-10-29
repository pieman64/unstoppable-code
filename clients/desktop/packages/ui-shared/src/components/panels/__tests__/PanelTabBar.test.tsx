/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PanelTabModel } from '../../../panels/registry-types';
import { PanelTabBar, type PanelTabStyle } from '../PanelTabBar';
import { PanelTabLiveReorderContext } from '../panel-tab-live-reorder-context';

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

const TAB_STYLE_CASES: readonly {
  style: PanelTabStyle;
  overrides: Partial<Parameters<typeof PanelTabBar>[0]>;
}[] = [
  { style: 'classic', overrides: {} },
  { style: 'fill', overrides: { tabStyle: 'fill' } },
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

describe('PanelTabBar label/trailing seams', () => {
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

  it.each(TAB_STYLE_CASES)(
    '$style: reports header intent without selecting or changing markup',
    ({ overrides }) => {
      const onTabIntent = jest.fn();
      const onSelectTab = jest.fn();
      render({ ...overrides, onSelectTab, draggable: false });
      const markup = container.innerHTML;
      render({ ...overrides, onSelectTab, draggable: false, onTabIntent });
      expect(container.innerHTML).toBe(markup);
      const tab = container.querySelector('[data-testid="panel-tab-panel-2"]');
      const close = container.querySelector(
        '[data-testid="panel-tab-close-panel-2"]',
      );
      if (!(tab instanceof HTMLElement) || !(close instanceof HTMLElement))
        throw new Error('Missing tab header');
      act(() => {
        tab.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
        tab.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
        tab.focus();
        tab.blur();
        close.focus();
        close.blur();
      });
      expect(onTabIntent.mock.calls).toEqual([
        ['group-1', TABS[1], 'start', 'pointer'],
        ['group-1', TABS[1], 'end', 'pointer'],
        ['group-1', TABS[1], 'start', 'focus'],
        ['group-1', TABS[1], 'end', 'focus'],
      ]);
      expect(onSelectTab).not.toHaveBeenCalled();
    },
  );

  it('still readies a live reorder with its pointer event when reporting intent', () => {
    // React clears `currentTarget` after dispatch, so read it during the call.
    const prepare = jest.fn(
      (event: { currentTarget: EventTarget | null }) => event.currentTarget,
    );
    const onTabIntent = jest.fn();
    act(() => {
      root.render(
        <PanelTabLiveReorderContext.Provider
          value={() => ({
            prepare,
            dragStart: (): void => {},
            dragEnd: (): void => {},
          })}
        >
          <PanelTabBar
            groupId="group-1"
            tabs={TABS}
            activePanelId="panel-1"
            onSelectTab={jest.fn()}
            onCloseTab={jest.fn()}
            tabStyle="fill"
            draggable
            onTabIntent={onTabIntent}
          />
        </PanelTabLiveReorderContext.Provider>,
      );
    });
    const tab = container.querySelector('[data-testid="panel-tab-panel-2"]');
    act(() => {
      tab?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.results[0]?.value).toBe(tab);
    expect(onTabIntent).toHaveBeenCalledWith(
      'group-1',
      TABS[1],
      'start',
      'pointer',
    );
  });

  it.each(TAB_STYLE_CASES)(
    '$style: renders a close control for every tab when canCloseTab is omitted',
    ({ overrides }) => {
      // Historical behaviour, which desktop relies on.
      render(overrides);
      expect(
        container.querySelector('[data-testid="panel-tab-close-panel-1"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="panel-tab-close-panel-2"]'),
      ).not.toBeNull();
    },
  );

  it.each(TAB_STYLE_CASES)(
    '$style: hides the close control for tabs canCloseTab rejects',
    ({ overrides }) => {
      // A host that refuses the close in its handler (the portal will not close a
      // streaming chat) must not render an enabled button that does nothing.
      render({
        ...overrides,
        canCloseTab: (tab): boolean => tab.panelId !== 'panel-1',
      });
      expect(
        container.querySelector('[data-testid="panel-tab-close-panel-1"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="panel-tab-close-panel-2"]'),
      ).not.toBeNull();
    },
  );

  it.each(TAB_STYLE_CASES)(
    '$style: renders the plain title with a string title attribute by default',
    ({ overrides }) => {
      render(overrides);
      const label = container.querySelector(
        '[data-testid="panel-tab-panel-1"] .canopy-panel-tab-title',
      );
      expect(label?.textContent).toBe('Chat One');
      expect(label?.getAttribute('title')).toBe('Chat One');
    },
  );

  it.each(TAB_STYLE_CASES)(
    '$style: renderTabLabel replaces the plain text but keeps the title attribute',
    ({ overrides }) => {
      const renderTabLabel = jest.fn(
        (tab: PanelTabModel): JSX.Element => (
          <span
            data-testid={`custom-label-${tab.panelId}`}
          >{`live:${tab.title}`}</span>
        ),
      );
      render({ ...overrides, renderTabLabel });

      const label = container.querySelector(
        '[data-testid="panel-tab-panel-2"] .canopy-panel-tab-title',
      );
      expect(label?.getAttribute('title')).toBe('file.ts');
      expect(
        label?.querySelector('[data-testid="custom-label-panel-2"]')
          ?.textContent,
      ).toBe('live:file.ts');
      // The renderer receives the full tab model, including its instance.
      expect(renderTabLabel).toHaveBeenCalledWith(
        expect.objectContaining({
          panelId: 'panel-2',
          instance: { fileTabId: 'file-1', filePath: '/tmp/file.ts' },
        }),
      );
    },
  );

  it('renderTabTrailing renders between the label and the close button', () => {
    render({
      renderTabTrailing: (tab: PanelTabModel): JSX.Element => (
        <span data-testid={`trailing-${tab.panelId}`} />
      ),
    });

    const tab = container.querySelector('[data-testid="panel-tab-panel-1"]');
    // The label lives inside the icon+label `-main` wrapper (which carries
    // the active underline); trailing content and the close button stay
    // direct children after it.
    const children = Array.from(tab?.children ?? []);
    const labelIndex = children.findIndex(
      (child) =>
        child.classList.contains('canopy-panel-tab-main') &&
        child.querySelector('.canopy-panel-tab-title') !== null,
    );
    const trailingIndex = children.findIndex(
      (child) => child.getAttribute('data-testid') === 'trailing-panel-1',
    );
    const closeIndex = children.findIndex(
      (child) =>
        child.classList.contains('canopy-panel-tab-close-slot') &&
        child.querySelector('.canopy-panel-tab-close') !== null,
    );
    expect(labelIndex).toBeGreaterThanOrEqual(0);
    expect(trailingIndex).toBeGreaterThan(labelIndex);
    expect(closeIndex).toBeGreaterThan(trailingIndex);
  });

  it('keeps tab ARIA and testids identical with renderers provided', () => {
    render({
      renderTabLabel: (tab: PanelTabModel): string => tab.title,
      renderTabTrailing: (): null => null,
    });
    const tab = container.querySelector('[data-testid="panel-tab-panel-1"]');
    expect(tab?.getAttribute('role')).toBe('tab');
    expect(tab?.getAttribute('aria-selected')).toBe('true');
    expect(
      container.querySelector('[data-testid="panel-tab-close-panel-1"]'),
    ).not.toBeNull();
  });

  describe('pinned / unpinned split', () => {
    const MIXED_TABS: PanelTabModel[] = [
      { panelId: 'panel-p', kind: 'chat', title: 'Pinned', pinned: true },
      { panelId: 'panel-1', kind: 'chat', title: 'Chat One' },
      { panelId: 'panel-2', kind: 'file-diff', title: 'file.ts' },
    ];

    it('renders pinned tabs in their own strip with a divider, and unpinned in the main strip', () => {
      render({ tabs: MIXED_TABS, activePanelId: 'panel-1' });

      const pinnedWrap = container.querySelector(
        '.canopy-panel-tab-strip-wrap-pinned',
      );
      const unpinnedWrap = container.querySelector(
        '.canopy-panel-tab-strip-wrap-unpinned',
      );
      expect(pinnedWrap).not.toBeNull();
      expect(unpinnedWrap).not.toBeNull();
      expect(
        container.querySelector('.canopy-panel-tab-pinned-divider'),
      ).not.toBeNull();

      // The pinned tab lives in the pinned strip and carries data-pinned.
      const pinnedTab = pinnedWrap?.querySelector(
        '[data-testid="panel-tab-panel-p"]',
      );
      expect(pinnedTab).not.toBeNull();
      expect(pinnedTab?.getAttribute('data-pinned')).toBe('true');
      // Unpinned tabs live in the unpinned strip.
      expect(
        unpinnedWrap?.querySelector('[data-testid="panel-tab-panel-1"]'),
      ).not.toBeNull();
      expect(
        unpinnedWrap?.querySelector('[data-testid="panel-tab-panel-2"]'),
      ).not.toBeNull();
      // The pinned tab is NOT in the unpinned strip.
      expect(
        unpinnedWrap?.querySelector('[data-testid="panel-tab-panel-p"]'),
      ).toBeNull();
    });

    it.each(TAB_STYLE_CASES)(
      '$style: renders pinned tabs icon-only (no label or close button) with the title as the accessible name',
      ({ overrides }) => {
        render({
          ...overrides,
          tabs: MIXED_TABS,
          activePanelId: 'panel-1',
          renderTabIcon: (tab: PanelTabModel): JSX.Element => (
            <span data-testid={`icon-${tab.panelId}`} />
          ),
          getTabTitle: (tab: PanelTabModel): string => `title:${tab.title}`,
        });

        const pinnedTab = container.querySelector(
          '[data-testid="panel-tab-panel-p"]',
        );
        expect(pinnedTab).not.toBeNull();
        // Icon-only: no visible label text and no close button.
        expect(pinnedTab?.querySelector('.canopy-panel-tab-title')).toBeNull();
        expect(pinnedTab?.querySelector('.canopy-panel-tab-close')).toBeNull();
        // The app-provided kind icon still renders.
        expect(
          pinnedTab?.querySelector('[data-testid="icon-panel-p"]'),
        ).not.toBeNull();
        // The resolved title is the tab's accessible name.
        expect(pinnedTab?.getAttribute('aria-label')).toBe('title:Pinned');
        expect(pinnedTab?.classList.contains('canopy-panel-tab-pinned')).toBe(
          true,
        );

        // Unpinned tabs keep their full label and close button.
        const unpinnedTab = container.querySelector(
          '[data-testid="panel-tab-panel-1"]',
        );
        expect(
          unpinnedTab?.querySelector('.canopy-panel-tab-title'),
        ).not.toBeNull();
        expect(
          unpinnedTab?.querySelector('.canopy-panel-tab-close'),
        ).not.toBeNull();
      },
    );

    it('shows a rich hover tooltip with the icon and full title for a pinned tab', () => {
      render({
        tabs: MIXED_TABS,
        activePanelId: 'panel-1',
        renderTabIcon: (tab: PanelTabModel): JSX.Element => (
          <span data-testid={`tip-icon-${tab.panelId}`} />
        ),
        getTabTitle: (tab: PanelTabModel): string => `title:${tab.title}`,
      });

      const pinnedTab = container.querySelector(
        '[data-testid="panel-tab-panel-p"]',
      );
      if (!(pinnedTab instanceof HTMLElement)) {
        throw new Error('pinned tab not rendered');
      }

      // Hovering the pinned tab mounts the shared Tooltip portal (on body).
      act(() => {
        pinnedTab.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });

      const tooltip = document.body.querySelector('[role="tooltip"]');
      expect(tooltip).not.toBeNull();
      expect(tooltip?.textContent).toContain('title:Pinned');
      // The tooltip carries the rich icon slot, not just plain text.
      expect(
        tooltip?.querySelector('[data-testid="tip-icon-panel-p"]'),
      ).not.toBeNull();
    });

    it('omits the pinned strip and divider when no tab is pinned', () => {
      render();
      expect(
        container.querySelector('.canopy-panel-tab-strip-wrap-pinned'),
      ).toBeNull();
      expect(
        container.querySelector('.canopy-panel-tab-pinned-divider'),
      ).toBeNull();
      // Unpinned tabs still carry data-pinned="false".
      expect(
        container
          .querySelector('[data-testid="panel-tab-panel-1"]')
          ?.getAttribute('data-pinned'),
      ).toBe('false');
    });
  });

  describe('onTabContextMenu', () => {
    it('fires with the group id, panel id, and event coordinates and prevents default', () => {
      const onTabContextMenu = jest.fn();
      render({ onTabContextMenu });

      const tab = container.querySelector('[data-testid="panel-tab-panel-2"]');
      if (!(tab instanceof HTMLElement)) {
        throw new Error('tab not rendered');
      }
      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 42,
        clientY: 84,
      });
      act(() => {
        tab.dispatchEvent(event);
      });

      expect(onTabContextMenu).toHaveBeenCalledWith(
        'group-1',
        'panel-2',
        42,
        84,
      );
      expect(event.defaultPrevented).toBe(true);
    });
  });

  describe('strip overflow scrolling', () => {
    function strip(): HTMLDivElement {
      const element = container.querySelector('.canopy-panel-tab-strip');
      if (!(element instanceof HTMLDivElement)) {
        throw new Error('tab strip not rendered');
      }
      return element;
    }

    /** Marks the strip as overflowing (jsdom has no layout engine). */
    function setStripMetrics(
      element: HTMLDivElement,
      scrollWidth: number,
      clientWidth: number,
    ): void {
      Object.defineProperty(element, 'scrollWidth', {
        configurable: true,
        value: scrollWidth,
      });
      Object.defineProperty(element, 'clientWidth', {
        configurable: true,
        value: clientWidth,
      });
    }

    it('translates vertical wheel deltas into horizontal scroll when overflowing', () => {
      render();
      const element = strip();
      setStripMetrics(element, 400, 100);

      const proceeded = element.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 50, cancelable: true }),
      );

      expect(element.scrollLeft).toBe(50);
      // The handled wheel event is preventDefault()ed (no page scroll).
      expect(proceeded).toBe(false);

      // Clamps at the scrollable maximum (scrollWidth - clientWidth).
      element.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 10000, cancelable: true }),
      );
      expect(element.scrollLeft).toBe(300);
    });

    it('ignores wheel events when the strip does not overflow', () => {
      render();
      const element = strip();
      setStripMetrics(element, 100, 100);

      const proceeded = element.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 50, cancelable: true }),
      );

      expect(element.scrollLeft).toBe(0);
      expect(proceeded).toBe(true);
    });

    it('ignores dominant horizontal wheel deltas (native strip scrolling)', () => {
      render();
      const element = strip();
      setStripMetrics(element, 400, 100);

      const proceeded = element.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 5, deltaX: 50, cancelable: true }),
      );

      expect(element.scrollLeft).toBe(0);
      expect(proceeded).toBe(true);
    });

    it('remeasures overflow when tab content mutates', async () => {
      render();
      const element = strip();
      setStripMetrics(element, 400, 100);
      const title = element.querySelector('.canopy-panel-tab-title');
      if (!(title instanceof HTMLElement)) {
        throw new Error('tab title not rendered');
      }

      await act(async () => {
        title.textContent = 'A much longer title';
        await Promise.resolve();
      });

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
    });

    it('keeps a hover-revealed scrollbar visible while moving onto its thumb', () => {
      document.documentElement.dataset.scrollbarBehavior = 'hover';
      render();
      const element = strip();
      setStripMetrics(element, 400, 100);
      act(() => {
        element.dispatchEvent(new Event('scroll'));
      });

      const wrapper = element.parentElement;
      const thumb = wrapper?.querySelector('.canopy-scroll-thumb');
      if (
        !(wrapper instanceof HTMLElement) ||
        !(thumb instanceof HTMLElement)
      ) {
        throw new Error('overflow strip wrapper or thumb not rendered');
      }

      act(() => {
        wrapper.dispatchEvent(new Event('pointerenter'));
      });
      expect(thumb.getAttribute('data-revealed')).toBe('true');

      act(() => {
        element.dispatchEvent(new Event('pointerleave'));
        thumb.dispatchEvent(new Event('pointerenter'));
      });
      expect(thumb.getAttribute('data-revealed')).toBe('true');
    });

    it('does not measure layout to reveal the only tab in a strip', () => {
      const clientWidth = jest
        .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
        .mockReturnValue(100);
      const getBoundingClientRect = jest
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockReturnValue(new DOMRect(0, 0, 100, 30));

      render({
        tabs: [{ panelId: 'panel-1', kind: 'chat', title: 'Chat One' }],
        activePanelId: 'panel-1',
      });

      expect(
        getBoundingClientRect.mock.contexts.some(
          (element) =>
            element instanceof HTMLElement &&
            element.dataset.testid === 'panel-tab-panel-1',
        ),
      ).toBe(false);

      clientWidth.mockRestore();
      getBoundingClientRect.mockRestore();
    });

    it('does not measure the first active tab when its strip is already at the start', () => {
      const clientWidth = jest
        .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
        .mockReturnValue(100);
      const getBoundingClientRect = jest
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockReturnValue(new DOMRect(0, 0, 100, 30));

      render({ activePanelId: 'panel-1' });

      expect(
        getBoundingClientRect.mock.contexts.some(
          (element) =>
            element instanceof HTMLElement &&
            element.dataset.testid === 'panel-tab-panel-1',
        ),
      ).toBe(false);

      clientWidth.mockRestore();
      getBoundingClientRect.mockRestore();
    });

    it('does not measure a newly active tab when the strip is known to fit', () => {
      render({ activePanelId: 'panel-1' });
      const element = strip();
      setStripMetrics(element, 100, 100);
      act(() => {
        element.dispatchEvent(new Event('scroll'));
      });
      const getBoundingClientRect = jest.spyOn(
        HTMLElement.prototype,
        'getBoundingClientRect',
      );

      render({ activePanelId: 'panel-2' });

      expect(
        getBoundingClientRect.mock.contexts.some(
          (candidate) =>
            candidate instanceof HTMLElement &&
            candidate.dataset.testid === 'panel-tab-panel-2',
        ),
      ).toBe(false);

      getBoundingClientRect.mockRestore();
    });

    it('scrolls the newly active tab into view on selection', () => {
      render();
      const element = strip();
      setStripMetrics(element, 400, 100);
      act(() => {
        element.dispatchEvent(new Event('scroll'));
      });
      element.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 100, 30);
      const tab2 = container.querySelector('[data-testid="panel-tab-panel-2"]');
      if (!(tab2 instanceof HTMLDivElement)) {
        throw new Error('tab not rendered');
      }
      // Off-screen to the right of the 100px viewport.
      tab2.getBoundingClientRect = (): DOMRect => new DOMRect(150, 0, 50, 30);

      render({ activePanelId: 'panel-2' });

      // Right-aligned reveal: tabRight (200) - clientWidth (100).
      expect(element.scrollLeft).toBe(100);
    });

    it('reveals an active tab when overflow state has not caught up with the DOM', () => {
      render();
      const element = strip();
      // Model the first overflowing commit or a tab insertion that crosses the
      // overflow threshold. The hook's passive observer/effect has not updated
      // hasOverflow yet, but the DOM metrics already reflect the new layout.
      setStripMetrics(element, 400, 100);
      element.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 100, 30);
      const tab2 = container.querySelector('[data-testid="panel-tab-panel-2"]');
      if (!(tab2 instanceof HTMLDivElement)) {
        throw new Error('tab not rendered');
      }
      tab2.getBoundingClientRect = (): DOMRect => new DOMRect(150, 0, 50, 30);

      render({ activePanelId: 'panel-2' });

      expect(element.scrollLeft).toBe(100);
    });

    it('does not force tab geometry on selection when the strip does not overflow', () => {
      render();
      const element = strip();
      setStripMetrics(element, 100, 100);
      const tab2 = container.querySelector('[data-testid="panel-tab-panel-2"]');
      if (!(tab2 instanceof HTMLDivElement)) {
        throw new Error('tab not rendered');
      }
      const stripGeometry = jest.spyOn(element, 'getBoundingClientRect');
      const tabGeometry = jest.spyOn(tab2, 'getBoundingClientRect');

      render({ activePanelId: 'panel-2' });

      expect(stripGeometry).not.toHaveBeenCalled();
      expect(tabGeometry).not.toHaveBeenCalled();
    });

    it('does not scroll the active tab when its strip is not laid out yet (0 width)', () => {
      // On worktree navigation the panel grid sizes the tab strip AFTER the tab
      // bar's own layout effect runs, so a synchronous reveal would measure a
      // 0-width strip. Guard: skip rather than compute a garbage offset.
      render();
      const element = strip();
      // scrollWidth set, clientWidth 0 => not laid out.
      setStripMetrics(element, 400, 0);
      act(() => {
        element.dispatchEvent(new Event('scroll'));
      });
      element.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 0, 30);
      const tab2 = container.querySelector('[data-testid="panel-tab-panel-2"]');
      if (!(tab2 instanceof HTMLDivElement)) {
        throw new Error('tab not rendered');
      }
      tab2.getBoundingClientRect = (): DOMRect => new DOMRect(150, 0, 50, 30);

      render({ activePanelId: 'panel-2' });

      expect(element.scrollLeft).toBe(0);
    });

    it('binds wheel scrolling to a pinned strip that only appears after the initial mount', () => {
      // First commit has no pinned tabs, so the pinned strip is not rendered.
      render();
      expect(
        container.querySelector('.canopy-panel-tab-strip-wrap-pinned'),
      ).toBeNull();

      // Pinning a tab mounts the pinned strip on a later commit. The overflow
      // hook must still bind wheel listeners to it — a one-shot mount effect
      // would miss this conditionally-rendered element and leave its mouse
      // wheel dead.
      render({
        tabs: [
          { panelId: 'panel-p', kind: 'chat', title: 'Pinned', pinned: true },
          { panelId: 'panel-1', kind: 'chat', title: 'Chat One' },
        ],
        activePanelId: 'panel-p',
      });

      const pinnedStrip = container.querySelector(
        '[data-testid="panel-tab-strip-pinned-group-1"]',
      );
      if (!(pinnedStrip instanceof HTMLDivElement)) {
        throw new Error('pinned tab strip not rendered');
      }
      setStripMetrics(pinnedStrip, 400, 100);

      const proceeded = pinnedStrip.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 50, cancelable: true }),
      );

      expect(pinnedStrip.scrollLeft).toBe(50);
      expect(proceeded).toBe(false);
    });
  });
});

describe('PanelTabBar renderTabTooltip seam', () => {
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

  function render(
    overrides: Partial<Parameters<typeof PanelTabBar>[0]> = {},
  ): void {
    act(() => {
      root.render(
        <PanelTabBar
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

  const richTooltip = (tab: PanelTabModel): JSX.Element | null =>
    tab.panelId === 'panel-1' ? (
      <span data-testid="rich-tooltip-content">Rich for {tab.title}</span>
    ) : null;

  it.each(TAB_STYLE_CASES)(
    '$style: a non-null custom tooltip REPLACES the native title attribute',
    ({ overrides }) => {
      render({ ...overrides, renderTabTooltip: richTooltip });

      const customized = container.querySelector(
        '[data-testid="panel-tab-panel-1"] .canopy-panel-tab-title',
      );
      // Never both: the label span drops its native `title` tooltip.
      expect(customized?.getAttribute('title')).toBeNull();
      expect(customized?.textContent).toBe('Chat One');

      // Tabs whose renderer returns null keep the plain string tooltip.
      const plain = container.querySelector(
        '[data-testid="panel-tab-panel-2"] .canopy-panel-tab-title',
      );
      expect(plain?.getAttribute('title')).toBe('file.ts');
    },
  );

  it.each(TAB_STYLE_CASES)(
    '$style: close-button accessible names still come from getTabTitle',
    ({ overrides }) => {
      render({
        ...overrides,
        renderTabTooltip: richTooltip,
        getTabTitle: (tab: PanelTabModel): string => `Friendly ${tab.title}`,
      });
      expect(
        container
          .querySelector('[data-testid="panel-tab-close-panel-1"]')
          ?.getAttribute('aria-label'),
      ).toBe('Close Friendly Chat One');
    },
  );

  it.each(TAB_STYLE_CASES)(
    '$style: shows the custom tooltip content on hover (portal, no native title)',
    ({ overrides }) => {
      jest.useFakeTimers();
      try {
        render({ ...overrides, renderTabTooltip: richTooltip });
        const label = container.querySelector(
          '[data-testid="panel-tab-panel-1"] .canopy-panel-tab-title',
        );
        const trigger = label?.parentElement;
        expect(trigger).not.toBeNull();
        act(() => {
          trigger?.dispatchEvent(
            new MouseEvent('mouseover', { bubbles: true }),
          );
          jest.runOnlyPendingTimers();
        });
        expect(
          document.querySelector('[data-testid="rich-tooltip-content"]'),
        ).not.toBeNull();
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('pinned tabs use the custom tooltip in place of the default rich content', () => {
    jest.useFakeTimers();
    try {
      render({
        tabs: [{ ...TABS[0], pinned: true }, TABS[1]],
        renderTabTooltip: richTooltip,
      });
      const pinned = container.querySelector(
        '[data-testid="panel-tab-panel-1"]',
      );
      expect(pinned?.getAttribute('data-pinned')).toBe('true');
      act(() => {
        pinned?.parentElement?.dispatchEvent(
          new MouseEvent('mouseover', { bubbles: true }),
        );
        jest.runOnlyPendingTimers();
      });
      expect(
        document.querySelector('[data-testid="rich-tooltip-content"]'),
      ).not.toBeNull();
      // The default pinned rich tooltip content is replaced, not doubled.
      expect(
        document.querySelector('.canopy-panel-tab-pinned-tooltip'),
      ).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('PanelTabBar close button tooltip (CAN-2799)', () => {
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
          groupId="group-1"
          tabs={TABS}
          activePanelId="panel-1"
          onSelectTab={jest.fn()}
          onCloseTab={jest.fn()}
        />,
      );
    });
  }

  it('renders the close button inside an absolutely positioned tooltip slot with no native title', () => {
    render();
    const close = container.querySelector<HTMLButtonElement>(
      '[data-testid="panel-tab-close-panel-1"]',
    );
    expect(close).not.toBeNull();
    // Native title tooltips lag on macOS; the rich tooltip replaces them.
    expect(close?.hasAttribute('title')).toBe(false);
    expect(close?.getAttribute('aria-label')).toBe('Close Chat One');
    // The slot is the tab's own element around the Tooltip wrapper (not the
    // button), an inline-flex box the size of the button, so the button
    // stays exactly where it was before the migration.
    const wrapper = close?.parentElement;
    expect(wrapper?.classList.contains('canopy-panel-tab-close-slot')).toBe(
      false,
    );
    const slot = wrapper?.parentElement;
    expect(slot?.classList.contains('canopy-panel-tab-close-slot')).toBe(true);
    expect(slot?.classList.contains('inline-flex')).toBe(true);
    expect(slot?.parentElement?.getAttribute('data-testid')).toBe(
      'panel-tab-panel-1',
    );
  });

  it('opens a rich tooltip naming the tab on hover and focus', () => {
    render();
    const close = container.querySelector<HTMLButtonElement>(
      '[data-testid="panel-tab-close-panel-1"]',
    );
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    act(() => {
      close?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Close Chat One',
    );
    act(() => {
      close?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    act(() => {
      focusViaKeyboard(close);
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Close Chat One',
    );
  });
});
