/**
 * @jest-environment jsdom
 */
// The `fill` tab style (early access): Chrome-style tiles that never scroll.
// The classic style, and behaviour both styles share, live in
// PanelTabBar.test.tsx.
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PanelTabModel } from '../../../panels/registry-types';
import {
  PanelTabBar,
  PanelTabNumber,
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

  describe('full row', () => {
    it('disables the add buttons and explains why on hover', () => {
      const onAddTab = jest.fn();
      const onQuickAdd = jest.fn();
      render({
        addTab: {
          label: 'New Chat',
          onAddTab,
          quickAdd: { label: 'Add another Terminal', onQuickAdd },
          fullNote: 'This tab row is full.',
        },
      });
      const add = container.querySelector<HTMLButtonElement>(
        '[data-testid="panel-add-tab-group-1"]',
      );
      const quickAdd = container.querySelector<HTMLButtonElement>(
        '[data-testid="panel-quick-add-group-1"]',
      );
      expect(add?.disabled).toBe(true);
      expect(quickAdd?.disabled).toBe(true);
      act(() => {
        add?.click();
        quickAdd?.click();
      });
      expect(onAddTab).not.toHaveBeenCalled();
      expect(onQuickAdd).not.toHaveBeenCalled();

      act(() => {
        add?.parentElement?.dispatchEvent(
          new MouseEvent('mouseover', { bubbles: true }),
        );
      });
      expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
        'This tab row is full.',
      );
    });

    it('keeps the add buttons enabled while the row has room', () => {
      render({ addTab: { label: 'New Chat', onAddTab: jest.fn() } });
      expect(
        container.querySelector<HTMLButtonElement>(
          '[data-testid="panel-add-tab-group-1"]',
        )?.disabled,
      ).toBe(false);
    });
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

  describe('fitting a crowded row', () => {
    let barWidth = 1000;
    let sheet: HTMLStyleElement;

    // Sizes the measurement reads; tabs report none here.
    let WIDTHS: Array<[string, number]> = [];

    beforeEach(() => {
      WIDTHS = [
        ['canopy-panel-add-tab-root', 28],
        ['canopy-panel-tab-pinned-divider', 1],
      ];
      // The fill strips' 4px end padding and the pinned divider's 4px
      // margins, as panels.css sets them (read through computed style).
      sheet = document.createElement('style');
      sheet.textContent =
        '.canopy-panel-tab-strip { padding: 0 4px; }' +
        '.canopy-panel-tab-pinned-divider { margin: 0 4px; }';
      document.head.append(sheet);
      jest
        .spyOn(Element.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: Element): DOMRect {
          const width = this.classList.contains('canopy-panel-tab-bar')
            ? barWidth
            : (WIDTHS.find(([name]) => this.classList.contains(name))?.[1] ??
              0);
          return new DOMRect(0, 0, width, 28);
        });
    });

    afterEach(() => {
      jest.restoreAllMocks();
      sheet.remove();
    });

    // `active` names the selected tab; by default none is, so the tiles
    // share the row evenly.
    function renderRow(
      count: number,
      width: number,
      pinned = 0,
      active = 'none',
    ): HTMLElement {
      barWidth = width;
      render({
        activePanelId: active,
        tabs: Array.from({ length: count }, (_value, index) => ({
          panelId: `panel-${index + 1}`,
          kind: 'chat',
          title: `Chat ${index + 1}`,
          ...(index < pinned ? { pinned: true } : {}),
        })),
        addTab: { label: 'New tab', onAddTab: jest.fn() },
      });
      const bar = container.querySelector('.canopy-panel-tab-bar');
      if (!(bar instanceof HTMLElement)) throw new Error('bar not rendered');
      return bar;
    }

    const floor = (bar: HTMLElement): string =>
      bar.style.getPropertyValue('--canopy-panel-tab-floor');
    const gap = (bar: HTMLElement): string =>
      bar.style.getPropertyValue('--canopy-panel-tab-gap');

    // Room for tiles and gaps: the bar less the strip's 8px of end padding and
    // the 28px add button.
    it('keeps the 20px floor and 4px gaps while every tab fits at them', () => {
      const bar = renderRow(3, 1000);
      expect(floor(bar)).toBe('20px');
      expect(gap(bar)).toBe('4px');
    });

    it('lowers the floor so 20 tabs fit a 440px row', () => {
      // (440 - 36 - 19 gaps * 4) / 20 = 16.4, rounded down (never up, so
      // rounding cannot push the last tab out).
      const bar = renderRow(20, 440);
      expect(floor(bar)).toBe('16.39px');
      expect(gap(bar)).toBe('4px');
    });

    it('narrows the gaps before the tiles go below their 14px icon', () => {
      // (320 - 36 - 20 * 14) / 19 gaps = 0.21
      const bar = renderRow(20, 320);
      expect(floor(bar)).toBe('14px');
      expect(gap(bar)).toBe('0.21px');
    });

    it('counts the pinned strip, its divider, and its gaps', () => {
      // Room: 440 - 2 strips * 8 - divider (1 + 8) - 28 = 387; gaps: 3 pinned
      // + 15 unpinned. (387 - 18 * 4) / 20 = 15.75.
      const bar = renderRow(20, 440, 4);
      expect(floor(bar)).toBe('15.75px');
      expect(gap(bar)).toBe('4px');
      expect(bar.style.getPropertyValue('--canopy-panel-pinned-count')).toBe(
        '4',
      );
    });

    it('keeps pinned tiles square while the other tabs can give way', () => {
      // Room: 1000 - 2 strips * 8 - divider (1 + 8) - 28 = 947. One 28px
      // pinned tile leaves 919 for 3 tabs, which still fit at 20px.
      const bar = renderRow(4, 1000, 1);
      expect(bar.style.getPropertyValue('--canopy-panel-pinned-floor')).toBe(
        '28px',
      );
      expect(floor(bar)).toBe('20px');
    });

    it('takes the pinned tiles out of the room the other tabs share', () => {
      // Room: 400 - 16 - 9 - 28 = 347, less 2 square pinned tiles and their
      // gap (60) = 287 for 14 tabs: (287 - 13 * 4) / 14 = 16.78.
      const bar = renderRow(16, 400, 2);
      expect(bar.style.getPropertyValue('--canopy-panel-pinned-floor')).toBe(
        '28px',
      );
      expect(floor(bar)).toBe('16.78px');
    });

    it('shrinks pinned tiles with the rest once the others reach their icons', () => {
      // The 440px row above: square pinned tiles would leave the other 16
      // tabs less than their 14px icons, so all 20 share the floor.
      const bar = renderRow(20, 440, 4);
      expect(bar.style.getPropertyValue('--canopy-panel-pinned-floor')).toBe(
        '15.75px',
      );
    });

    it('clears its sizing when the row turns classic', () => {
      const bar = renderRow(20, 440);
      expect(floor(bar)).not.toBe('');

      render({
        tabs: Array.from({ length: 20 }, (_value, index) => ({
          panelId: `panel-${index + 1}`,
          kind: 'chat',
          title: `Chat ${index + 1}`,
        })),
        tabStyle: 'classic',
      });

      for (const name of [
        '--canopy-panel-tab-floor',
        '--canopy-panel-tab-gap',
        '--canopy-panel-pinned-count',
        '--canopy-panel-pinned-floor',
      ]) {
        expect(bar.style.getPropertyValue(name)).toBe('');
      }
    });

    it('re-measures when the add control grows without the bar resizing', () => {
      const observed: Element[] = [];
      let notify = (): void => undefined;
      class RecordingResizeObserver {
        constructor(callback: () => void) {
          notify = callback;
        }
        observe(target: Element): void {
          observed.push(target);
        }
        disconnect(): void {}
      }
      Object.defineProperty(window, 'ResizeObserver', {
        configurable: true,
        writable: true,
        value: RecordingResizeObserver,
      });
      try {
        const bar = renderRow(20, 440);
        expect(floor(bar)).toBe('16.39px');
        const addRoot = bar.querySelector('.canopy-panel-add-tab-root');
        expect(observed).toContain(addRoot);

        // A quick-add button appears beside `+`: the control doubles.
        const addWidth = WIDTHS.findIndex(
          ([name]) => name === 'canopy-panel-add-tab-root',
        );
        WIDTHS[addWidth] = ['canopy-panel-add-tab-root', 56];
        act(() => notify());
        // (440 - 8 - 56 - 76) / 20 = 15
        expect(floor(bar)).toBe('15px');
      } finally {
        Reflect.deleteProperty(window, 'ResizeObserver');
      }
    });

    it('never floors a lone selected tab above 96px', () => {
      // One tab in a wide row: the floor stays 96px, so the tab keeps its
      // default width instead of stretching across the row.
      const bar = renderRow(1, 1000, 0, 'panel-1');
      expect(
        bar.style.getPropertyValue('--canopy-panel-tab-active-floor'),
      ).toBe('96px');
    });

    it('keeps the selected tab 96px wide while the others can give way', () => {
      // Room 964: the selected tab takes 96, the rest stay at their floor.
      const bar = renderRow(20, 1000, 0, 'panel-5');
      expect(
        bar.style.getPropertyValue('--canopy-panel-tab-active-floor'),
      ).toBe('96px');
      expect(floor(bar)).toBe('20px');
    });

    it('gives the selected tab what the others spare above their icons', () => {
      // Room 404: 404 - 19 gaps * 4 - 19 icons * 14 = 62 for the selected
      // tab; (404 - 62 - 76) / 19 = 14 for each of the others.
      const bar = renderRow(20, 440, 0, 'panel-5');
      expect(
        bar.style.getPropertyValue('--canopy-panel-tab-active-floor'),
      ).toBe('62px');
      expect(floor(bar)).toBe('14px');
      expect(gap(bar)).toBe('4px');
    });

    it('shrinks tiles below their icon only once the gaps are gone', () => {
      // (250 - 36) / 20 = 10.7
      const bar = renderRow(20, 250);
      expect(floor(bar)).toBe('10.7px');
      expect(gap(bar)).toBe('0px');
    });
  });

  describe('no strip scrolling', () => {
    function stripMetrics(element: HTMLElement, scrollWidth: number): void {
      Object.defineProperty(element, 'scrollWidth', {
        configurable: true,
        value: scrollWidth,
      });
      Object.defineProperty(element, 'clientWidth', {
        configurable: true,
        value: 100,
      });
    }

    it('renders no scroll fades or scrollbar thumb', () => {
      render({
        tabs: [{ ...TABS[0], pinned: true }, TABS[1]],
      });
      expect(container.querySelector('.canopy-scroll-fade')).toBeNull();
      expect(container.querySelector('.canopy-scroll-thumb')).toBeNull();
    });

    it('leaves wheel input to the page instead of panning the strip', () => {
      render();
      const strip = container.querySelector(
        '[data-testid="panel-tab-strip-group-1"]',
      );
      if (!(strip instanceof HTMLDivElement)) {
        throw new Error('tab strip not rendered');
      }
      stripMetrics(strip, 400);

      const proceeded = strip.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 50, cancelable: true }),
      );

      expect(proceeded).toBe(true);
      expect(strip.scrollLeft).toBe(0);
    });
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
