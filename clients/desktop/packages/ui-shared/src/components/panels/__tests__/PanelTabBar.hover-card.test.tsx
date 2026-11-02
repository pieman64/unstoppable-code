/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PanelTabModel } from '../../../panels/registry-types';
import { HOST_TOOLTIP_TIMINGS, TooltipProvider } from '../../tooltip-handoff';
import { PanelTabBar, type PanelTabStyle } from '../PanelTabBar';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

let testClock = Date.now();

const TABS: PanelTabModel[] = [
  { panelId: 'active', kind: 'chat', title: 'Active chat' },
  { panelId: 'background', kind: 'chat', title: 'Background chat' },
  { panelId: 'pinned', kind: 'chat', title: 'Pinned chat', pinned: true },
];

describe.each<PanelTabStyle>(['classic', 'fill'])(
  'PanelTabBar hover card (%s tabs)',
  (tabStyle) => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
      jest.useFakeTimers({ now: (testClock += 10_000) });
      document.documentElement.dataset.scrollbarBehavior = 'system';
      container = document.createElement('div');
      document.body.append(container);
      root = createRoot(container);
    });

    afterEach(() => {
      act(() => root.unmount());
      document.body.replaceChildren();
      document.documentElement.removeAttribute('data-scrollbar-behavior');
      jest.useRealTimers();
    });

    function render(
      renderTabHoverCard?: (tab: PanelTabModel) => JSX.Element | null,
      activePanelId = 'active',
    ): void {
      act(() =>
        root.render(
          <TooltipProvider {...HOST_TOOLTIP_TIMINGS}>
            <PanelTabBar
              groupId="group"
              tabs={TABS}
              activePanelId={activePanelId}
              onSelectTab={jest.fn()}
              onCloseTab={jest.fn()}
              tabStyle={tabStyle}
              renderTabHoverCard={renderTabHoverCard}
            />
          </TooltipProvider>,
        ),
      );
    }

    const titleOf = (panelId: string): HTMLElement | null =>
      container.querySelector(
        `[data-testid="panel-tab-${panelId}"] .canopy-panel-tab-title`,
      );

    function hover(panelId: string): void {
      const label = titleOf(panelId)?.querySelector('.truncate');
      act(() => {
        label?.dispatchEvent(
          new MouseEvent('mouseover', {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });
    }

    const card = (panelId: string): HTMLElement | null =>
      document.body.querySelector(
        `[data-testid="panel-tab-hover-card-${panelId}"]`,
      );

    it('keeps every native title when no card renderer is given', () => {
      render();
      expect(titleOf('active')?.getAttribute('title')).toBe('Active chat');
      expect(titleOf('background')?.getAttribute('title')).toBe(
        'Background chat',
      );
    });

    it('keeps the native title for a tab whose renderer returns null', () => {
      render(() => null);
      expect(titleOf('background')?.getAttribute('title')).toBe(
        'Background chat',
      );
    });

    it('asks only for background tabs, never the active or pinned tab', () => {
      const renderCard = jest.fn((tab: PanelTabModel) => (
        <span>{tab.title} preview</span>
      ));
      render(renderCard);
      expect(
        new Set(renderCard.mock.calls.map(([tab]) => tab.panelId)),
      ).toEqual(new Set(['background']));
      expect(titleOf('active')?.getAttribute('title')).toBe('Active chat');
    });

    it('replaces the native title and opens the card on the host timing', () => {
      render((tab) => (
        <span data-testid="preview-body">{tab.title} preview</span>
      ));
      expect(titleOf('background')?.hasAttribute('title')).toBe(false);
      hover('background');
      act(() => jest.advanceTimersByTime(HOST_TOOLTIP_TIMINGS.openDelay - 1));
      expect(card('background')).toBeNull();
      act(() => jest.advanceTimersByTime(1));
      const surface = card('background');
      expect(surface?.textContent).toBe('Background chat preview');
      // The sidebar worktree card's surface, 280px wide.
      expect(surface?.className.split(' ')).toEqual(
        expect.arrayContaining([
          'rounded-lg',
          'shadow-xl',
          'px-2',
          'py-1',
          'w-70',
        ]),
      );
    });

    it('opens from anywhere on the label, not only over a short title', () => {
      render((tab) => <span>{tab.title} preview</span>);
      // A short title leaves empty label space; resting there still opens
      // the card without needing to hit the text itself.
      const label = titleOf('background');
      act(() => {
        label?.dispatchEvent(
          new MouseEvent('mouseover', {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
        jest.advanceTimersByTime(HOST_TOOLTIP_TIMINGS.openDelay);
      });
      expect(card('background')).not.toBeNull();
    });

    it('keeps the preview open over close and dismisses after leaving the tab', () => {
      render((tab) => <span>{tab.title} preview</span>);
      hover('background');
      act(() => jest.advanceTimersByTime(HOST_TOOLTIP_TIMINGS.openDelay));
      expect(card('background')).not.toBeNull();
      const label = titleOf('background')?.querySelector('.truncate');
      const close = container.querySelector(
        '[data-testid="panel-tab-close-background"]',
      );
      expect(label).not.toBeNull();
      expect(close).not.toBeNull();
      act(() => {
        label?.dispatchEvent(
          new MouseEvent('mouseout', { bubbles: true, relatedTarget: close }),
        );
        close?.dispatchEvent(
          new MouseEvent('mouseover', { bubbles: true, relatedTarget: label }),
        );
        jest.advanceTimersByTime(1_000);
      });
      expect(card('background')).not.toBeNull();
      act(() => {
        close?.dispatchEvent(
          new MouseEvent('mouseout', {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
        jest.advanceTimersByTime(1_000);
      });
      expect(card('background')).toBeNull();
    });

    it('preserves the tab and its focus when selecting a previewed tab', () => {
      const renderCard = (tab: PanelTabModel): JSX.Element => (
        <span>{tab.title} preview</span>
      );
      render(renderCard);
      const tab = container.querySelector<HTMLElement>(
        '[data-testid="panel-tab-background"]',
      );
      act(() => tab?.focus());
      render(renderCard, 'background');
      expect(
        container.querySelector('[data-testid="panel-tab-background"]'),
      ).toBe(tab);
      expect(document.activeElement).toBe(tab);
      expect(card('background')).toBeNull();
    });

    it('draws the card over a live browser page', () => {
      render((tab) => <span>{tab.title} preview</span>);
      hover('background');
      act(() => jest.advanceTimersByTime(HOST_TOOLTIP_TIMINGS.openDelay));
      expect(
        card('background')?.getAttribute('data-canopy-above-browser'),
      ).toBe('true');
    });

    it('mounts the card content only while the card is open', () => {
      const mounted = jest.fn();
      function Body(): JSX.Element {
        mounted();
        return <span>Body</span>;
      }
      render(() => <Body />);
      expect(mounted).not.toHaveBeenCalled();
    });
  },
);

describe('PanelTabBar hover card handoff', () => {
  let container: HTMLDivElement;
  let root: Root;
  let animate: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers({ now: (testClock += 10_000) });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    // jsdom has no Web Animations; give surfaces one to call.
    animate = jest.fn();
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: animate,
    });
    // Each surface measures further right, so a handoff has distance to
    // cover.
    let calls = 0;
    jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(() => {
        calls += 1;
        return new DOMRect(calls * 40, 10, 30, 20);
      });
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    jest.restoreAllMocks();
    Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    jest.useRealTimers();
  });

  it('slides the card from one background tab to the next', () => {
    const tabs: PanelTabModel[] = [
      { panelId: 'active', kind: 'chat', title: 'Active chat' },
      { panelId: 'first', kind: 'chat', title: 'First chat' },
      { panelId: 'second', kind: 'browser', title: 'Docs' },
    ];
    act(() =>
      root.render(
        <TooltipProvider {...HOST_TOOLTIP_TIMINGS}>
          <PanelTabBar
            groupId="group"
            tabs={tabs}
            activePanelId="active"
            onSelectTab={jest.fn()}
            onCloseTab={jest.fn()}
            tabStyle="fill"
            renderTabHoverCard={(tab): JSX.Element => (
              <span>{tab.title} preview</span>
            )}
          />
        </TooltipProvider>,
      ),
    );
    const label = (panelId: string): Element | null =>
      container.querySelector(
        `[data-testid="panel-tab-${panelId}"] .canopy-panel-tab-title .truncate`,
      );
    const card = (panelId: string): Element | null =>
      document.body.querySelector(
        `[data-testid="panel-tab-hover-card-${panelId}"]`,
      );
    let pointerOn: Element | null = null;
    const moveTo = (next: Element | null): void => {
      const previous = pointerOn;
      act(() => {
        previous?.dispatchEvent(
          new MouseEvent('mouseout', { bubbles: true, relatedTarget: next }),
        );
        next?.dispatchEvent(
          new MouseEvent('mouseover', {
            bubbles: true,
            relatedTarget: previous,
          }),
        );
      });
      pointerOn = next;
    };

    moveTo(label('first'));
    act(() => jest.advanceTimersByTime(HOST_TOOLTIP_TIMINGS.openDelay));
    expect(card('first')).not.toBeNull();
    expect(animate).not.toHaveBeenCalled();

    moveTo(label('second'));
    act(() => jest.advanceTimersByTime(0));
    expect(card('first')).toBeNull();
    expect(card('second')?.textContent).toBe('Docs preview');
    expect(animate).toHaveBeenCalledTimes(1);
  });
});
