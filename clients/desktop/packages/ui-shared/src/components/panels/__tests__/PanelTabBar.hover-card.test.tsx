/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PanelTabModel } from '../../../panels/registry-types';
import { PanelTabBar, type PanelTabStyle } from '../PanelTabBar';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

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
      jest.useFakeTimers();
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
    ): void {
      act(() =>
        root.render(
          <PanelTabBar
            groupId="group"
            tabs={TABS}
            activePanelId="active"
            onSelectTab={jest.fn()}
            onCloseTab={jest.fn()}
            tabStyle={tabStyle}
            renderTabHoverCard={renderTabHoverCard}
          />,
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
      expect(renderCard.mock.calls.map(([tab]) => tab.panelId)).toEqual([
        'background',
      ]);
      expect(titleOf('active')?.getAttribute('title')).toBe('Active chat');
    });

    it('replaces the native title and opens the card after 500ms', () => {
      render((tab) => (
        <span data-testid="preview-body">{tab.title} preview</span>
      ));
      expect(titleOf('background')?.hasAttribute('title')).toBe(false);
      hover('background');
      act(() => jest.advanceTimersByTime(499));
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
