/** @jest-environment jsdom */
import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PanelContentProps,
  PanelGroupModel,
  PanelIntentCallbacks,
  PanelTabModel,
} from '../../../panels/registry-types';
import { PANEL_CONTENT_ADOPTED_EVENT } from '../../../panels/panel-content-adoption';
import { PanelGroup, type PanelGroupProps } from '../PanelGroup';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function render(node: JSX.Element): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

interface TestCallbacks {
  callbacks: PanelIntentCallbacks;
  onSelectTab: jest.Mock;
  onCloseTab: jest.Mock;
  onCloseGroup: jest.Mock;
  onSplitGroup: jest.Mock;
  onMaximizeGroup: jest.Mock;
  onFocusGroup: jest.Mock;
  onMovePanel: jest.Mock;
  onPopOutGroup: jest.Mock;
  onCollapseGroup: jest.Mock;
  onExpandGroupToTab: jest.Mock;
}

function createCallbacks(options?: { withPopOut?: boolean }): TestCallbacks {
  const onSelectTab = jest.fn();
  const onCloseTab = jest.fn();
  const onCloseGroup = jest.fn();
  const onSplitGroup = jest.fn();
  const onMaximizeGroup = jest.fn();
  const onFocusGroup = jest.fn();
  const onMovePanel = jest.fn();
  const onPopOutGroup = jest.fn();
  const onCollapseGroup = jest.fn();
  const onExpandGroupToTab = jest.fn();
  const callbacks: PanelIntentCallbacks = {
    onSelectTab,
    onCloseTab,
    onCloseGroup,
    onSplitGroup,
    onMaximizeGroup,
    onFocusGroup,
    onMovePanel,
    onCollapseGroup,
    onExpandGroupToTab,
    ...(options?.withPopOut === false ? {} : { onPopOutGroup }),
  };
  return {
    callbacks,
    onSelectTab,
    onCloseTab,
    onCloseGroup,
    onSplitGroup,
    onMaximizeGroup,
    onFocusGroup,
    onMovePanel,
    onPopOutGroup,
    onCollapseGroup,
    onExpandGroupToTab,
  };
}

function tab(panelId: string, kind = 'chat'): PanelTabModel {
  return { panelId, kind, title: panelId.toUpperCase() };
}

const DEFAULT_GROUP: PanelGroupModel = {
  groupId: 'g1',
  tabs: [tab('p1'), tab('p2', 'files'), tab('p3', 'terminal')],
  activePanelId: 'p1',
};

function renderPanelContent(props: PanelContentProps): ReactNode {
  return (
    <div
      data-testid={`content-${props.panelId}`}
      data-content-active={String(props.isActive)}
      data-content-visible={String(props.isVisible)}
    />
  );
}

function makeProps(
  callbacks: PanelIntentCallbacks,
  overrides: Partial<PanelGroupProps> = {},
): PanelGroupProps {
  return {
    group: DEFAULT_GROUP,
    isActiveGroup: true,
    isMaximized: false,
    isGroupVisible: true,
    hasMultipleGroups: true,
    callbacks,
    renderPanelContent,
    ...overrides,
  };
}

/**
 * jsdom lays nothing out: give every element outside a hidden tab one box,
 * so the title-edge measurement sees only the visible content.
 */
function rectsOutsideHiddenTabs(element: Element): DOMRectList {
  const list = element.closest('[hidden]') === null ? [new DOMRect()] : [];
  return Object.assign(list, {
    item: (index: number): DOMRect | null => list[index] ?? null,
  });
}

/** Runs the pending animation frames (the edge is measured once a frame). */
function flushFrames(): void {
  act(() => {
    jest.advanceTimersByTime(50);
  });
}

function mockRenderedBoxes(): jest.SpyInstance {
  jest.useFakeTimers();
  return jest
    .spyOn(Element.prototype, 'getClientRects')
    .mockImplementation(function (this: Element): DOMRectList {
      return rectsOutsideHiddenTabs(this);
    });
}

function getByTestId(scope: ParentNode, testId: string): HTMLElement {
  const element =
    scope.querySelector(`[data-testid="${testId}"]`) ??
    (scope === document.body
      ? null
      : document.body.querySelector(`[data-testid="${testId}"]`));

  if (!(element instanceof HTMLElement)) {
    throw new Error(`Expected element with data-testid ${testId}`);
  }

  return element;
}

function queryByTestId(scope: ParentNode, testId: string): HTMLElement | null {
  const element =
    scope.querySelector(`[data-testid="${testId}"]`) ??
    (scope === document.body
      ? null
      : document.body.querySelector(`[data-testid="${testId}"]`));
  return element instanceof HTMLElement ? element : null;
}

function click(element: HTMLElement): void {
  act(() => {
    element.click();
  });
}

describe('PanelGroup', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    jest.restoreAllMocks();
  });

  it('forwards intent to its tab bar without selecting the tab', () => {
    const { callbacks, onSelectTab } = createCallbacks();
    const onTabIntent = jest.fn();
    const { container, root } = render(
      <PanelGroup {...makeProps(callbacks, { onTabIntent })} />,
    );
    try {
      const header = getByTestId(container, 'panel-tab-p2');
      act(() => {
        header.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
        header.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
      });
      expect(onTabIntent.mock.calls).toEqual([
        ['g1', DEFAULT_GROUP.tabs[1], 'start', 'pointer'],
        ['g1', DEFAULT_GROUP.tabs[1], 'end', 'pointer'],
      ]);
      expect(onSelectTab).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('renders the title/body structure with contract testids and data attributes', () => {
    const { callbacks } = createCallbacks();
    const { container, root } = render(
      <PanelGroup {...makeProps(callbacks, { isActiveGroup: false })} />,
    );

    try {
      const group = getByTestId(container, 'panel-group-g1');
      expect(group.getAttribute('data-group-id')).toBe('g1');
      expect(group.getAttribute('data-active')).toBe('false');
      getByTestId(container, 'panel-group-title-g1');
      getByTestId(container, 'panel-group-body-g1');

      const tabP2 = getByTestId(container, 'panel-tab-p2');
      expect(tabP2.getAttribute('data-panel-kind')).toBe('files');
      expect(tabP2.getAttribute('data-group-id')).toBe('g1');
      expect(tabP2.getAttribute('data-active')).toBe('false');
      expect(
        getByTestId(container, 'panel-tab-p1').getAttribute('data-active'),
      ).toBe('true');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('shows the fill-tab strip edge only while content scrolls under it', () => {
    const rects = mockRenderedBoxes();
    const { callbacks } = createCallbacks();
    const { container, root } = render(
      <PanelGroup {...makeProps(callbacks, { tabStyle: 'fill' })} />,
    );
    try {
      const group = getByTestId(container, 'panel-group-g1');
      expect(group.getAttribute('data-title-edge')).toBe('top');
      const scroller = document.createElement('div');
      getByTestId(container, 'panel-group-body-g1').appendChild(scroller);
      Object.defineProperty(scroller, 'scrollHeight', { value: 800 });
      Object.defineProperty(scroller, 'clientHeight', { value: 400 });
      const scrollTo = (top: number): void => {
        Object.defineProperty(scroller, 'scrollTop', {
          value: top,
          configurable: true,
        });
        act(() => {
          scroller.dispatchEvent(new Event('scroll'));
        });
        flushFrames();
      };
      scrollTo(120);
      expect(group.getAttribute('data-title-edge')).toBe('scrolled');
      scrollTo(0);
      expect(group.getAttribute('data-title-edge')).toBe('top');
    } finally {
      act(() => {
        root.unmount();
      });
      rects.mockRestore();
      jest.useRealTimers();
    }
  });

  it('measures content from a popped-out window realm', () => {
    const rects = mockRenderedBoxes();
    // A popped-out panel window has its own constructors: its elements fail
    // the opener's `instanceof HTMLElement`.
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const childDocument = frame.contentDocument;
    if (childDocument === null) throw new Error('no child document');
    const { callbacks } = createCallbacks();
    const { container, root } = render(
      <PanelGroup {...makeProps(callbacks, { tabStyle: 'fill' })} />,
    );
    try {
      const group = getByTestId(container, 'panel-group-g1');
      const wrapper = childDocument.createElement('div');
      const scroller = childDocument.createElement('div');
      expect(wrapper instanceof HTMLElement).toBe(false);
      for (const element of [wrapper, scroller]) {
        Object.defineProperty(element, 'getClientRects', {
          value: (): DOMRectList => rectsOutsideHiddenTabs(element),
        });
      }
      Object.defineProperty(scroller, 'scrollHeight', { value: 800 });
      Object.defineProperty(scroller, 'clientHeight', { value: 400 });
      Object.defineProperty(scroller, 'scrollTop', { value: 120 });
      wrapper.appendChild(scroller);
      act(() => {
        getByTestId(container, 'content-p1').appendChild(wrapper);
        scroller.dispatchEvent(new Event('scroll'));
      });
      flushFrames();
      expect(group.getAttribute('data-title-edge')).toBe('scrolled');
    } finally {
      act(() => {
        root.unmount();
      });
      frame.remove();
      rects.mockRestore();
      jest.useRealTimers();
    }
  });

  it('measures the strip edge when a collapsed group expands', () => {
    jest.useFakeTimers();
    // A collapsed group's body has no boxes, like hidden tab content.
    jest
      .spyOn(Element.prototype, 'getClientRects')
      .mockImplementation(function (this: Element): DOMRectList {
        const list =
          this.closest('[hidden], [data-collapsed]') === null
            ? [new DOMRect()]
            : [];
        return Object.assign(list, {
          item: (index: number): DOMRect | null => list[index] ?? null,
        });
      });
    const { callbacks } = createCallbacks();
    const groupProps = (collapsed: boolean): PanelGroupProps =>
      makeProps(callbacks, {
        tabStyle: 'fill',
        group: collapsed
          ? { ...DEFAULT_GROUP, collapsed: { edge: 'left' } }
          : DEFAULT_GROUP,
      });
    const { container, root } = render(<PanelGroup {...groupProps(true)} />);
    try {
      const group = getByTestId(container, 'panel-group-g1');
      const scroller = getByTestId(container, 'content-p1');
      Object.defineProperty(scroller, 'scrollHeight', { value: 800 });
      Object.defineProperty(scroller, 'clientHeight', { value: 400 });
      Object.defineProperty(scroller, 'scrollTop', { value: 120 });
      flushFrames();
      expect(group.getAttribute('data-title-edge')).toBe('top');

      // Expanding fires no scroll event; the kept offset is measured.
      act(() => {
        root.render(<PanelGroup {...groupProps(false)} />);
      });
      flushFrames();
      expect(group.getAttribute('data-title-edge')).toBe('scrolled');
    } finally {
      act(() => {
        root.unmount();
      });
      jest.restoreAllMocks();
      jest.useRealTimers();
    }
  });

  it('measures the strip edge when a scrolled tab is shown again', () => {
    const rects = mockRenderedBoxes();
    const { callbacks } = createCallbacks();
    const fillProps = (activePanelId: string): PanelGroupProps =>
      makeProps(callbacks, {
        tabStyle: 'fill',
        group: { ...DEFAULT_GROUP, activePanelId },
      });
    const { container, root } = render(<PanelGroup {...fillProps('p1')} />);
    try {
      const group = getByTestId(container, 'panel-group-g1');
      const scroller = getByTestId(container, 'content-p1');
      Object.defineProperty(scroller, 'scrollHeight', { value: 800 });
      Object.defineProperty(scroller, 'clientHeight', { value: 400 });
      Object.defineProperty(scroller, 'scrollTop', { value: 120 });
      act(() => {
        scroller.dispatchEvent(new Event('scroll'));
      });
      flushFrames();
      expect(group.getAttribute('data-title-edge')).toBe('scrolled');

      // A tab at its top shows the bare strip...
      act(() => {
        root.render(<PanelGroup {...fillProps('p2')} />);
      });
      flushFrames();
      expect(group.getAttribute('data-title-edge')).toBe('top');

      // ...and switching back to the scrolled tab, which fires no scroll
      // event, brings the edge back.
      act(() => {
        root.render(<PanelGroup {...fillProps('p1')} />);
      });
      flushFrames();
      expect(group.getAttribute('data-title-edge')).toBe('scrolled');

      // Turning fill tabs on over scrolled content measures it too.
      act(() => {
        root.render(
          <PanelGroup
            {...makeProps(callbacks, {
              group: { ...DEFAULT_GROUP, activePanelId: 'p1' },
            })}
          />,
        );
      });
      flushFrames();
      expect(group.hasAttribute('data-title-edge')).toBe(false);
      act(() => {
        root.render(<PanelGroup {...fillProps('p1')} />);
      });
      flushFrames();
      expect(group.getAttribute('data-title-edge')).toBe('scrolled');
    } finally {
      act(() => {
        root.unmount();
      });
      rects.mockRestore();
      jest.useRealTimers();
    }
  });

  it('keeps the classic strip edge untracked', () => {
    const { callbacks } = createCallbacks();
    const { container, root } = render(
      <PanelGroup {...makeProps(callbacks)} />,
    );
    try {
      expect(
        getByTestId(container, 'panel-group-g1').hasAttribute(
          'data-title-edge',
        ),
      ).toBe(false);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('renders the empty-group placeholder only when the group has no tabs', () => {
    const { callbacks } = createCallbacks();
    const emptyGroup: PanelGroupModel = {
      groupId: 'empty',
      tabs: [],
      activePanelId: null,
    };
    const empty = render(
      <PanelGroup {...makeProps(callbacks, { group: emptyGroup })} />,
    );

    try {
      getByTestId(empty.container, 'panel-empty-group-empty');
    } finally {
      act(() => {
        empty.root.unmount();
      });
    }

    const populated = render(<PanelGroup {...makeProps(callbacks)} />);
    try {
      expect(queryByTestId(populated.container, 'panel-empty-group-g1')).toBe(
        null,
      );
    } finally {
      act(() => {
        populated.root.unmount();
      });
    }
  });

  it('placeholder add button toggles the menu without double-mounting it', () => {
    const { callbacks } = createCallbacks();
    const onAddTab = jest.fn();
    const emptyGroup: PanelGroupModel = {
      groupId: 'empty',
      tabs: [],
      activePanelId: null,
    };
    const { container, root } = render(
      <PanelGroup
        {...makeProps(callbacks, {
          group: emptyGroup,
          addTab: {
            label: 'Add panel',
            onAddTab,
            menu: <div data-testid="empty-add-menu" />,
          },
        })}
      />,
    );

    try {
      const addButton = getByTestId(container, 'panel-empty-group-add-empty');
      // The menu node mounts exactly ONCE — in the tab bar's anchored add
      // button — even while the empty-group placeholder offers a second
      // trigger. Two mounts would double-portal the app's menu.
      expect(
        container.querySelectorAll('[data-testid="empty-add-menu"]').length,
      ).toBe(1);
      expect(addButton.getAttribute('aria-haspopup')).toBe('menu');
      expect(addButton.getAttribute('aria-expanded')).toBe('true');
      click(addButton);
      expect(onAddTab).toHaveBeenCalledWith('empty');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('closes an empty group when multiple groups exist', () => {
    const { callbacks, onCloseGroup } = createCallbacks();
    const emptyGroup: PanelGroupModel = {
      groupId: 'empty',
      tabs: [],
      activePanelId: null,
    };
    const { container, root } = render(
      <PanelGroup {...makeProps(callbacks, { group: emptyGroup })} />,
    );

    try {
      click(getByTestId(container, 'panel-empty-group-close-empty'));
      expect(onCloseGroup).toHaveBeenCalledWith('empty');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('disables closing the last empty group', () => {
    const { callbacks, onCloseGroup } = createCallbacks();
    const emptyGroup: PanelGroupModel = {
      groupId: 'empty',
      tabs: [],
      activePanelId: null,
    };
    const { container, root } = render(
      <PanelGroup
        {...makeProps(callbacks, {
          group: emptyGroup,
          hasMultipleGroups: false,
        })}
      />,
    );

    try {
      const closeButton = getByTestId(
        container,
        'panel-empty-group-close-empty',
      );
      expect(closeButton).toBeInstanceOf(HTMLButtonElement);
      expect(closeButton).toHaveProperty('disabled', true);
      click(closeButton);
      expect(onCloseGroup).not.toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('keeps non-active tab content mounted but hidden', () => {
    const { callbacks } = createCallbacks();
    const { container, root } = render(
      <PanelGroup {...makeProps(callbacks)} />,
    );

    try {
      const contentP1 = getByTestId(container, 'content-p1');
      const contentP2 = getByTestId(container, 'content-p2');
      expect(contentP1.parentElement?.hasAttribute('hidden')).toBe(false);
      expect(contentP2.parentElement?.hasAttribute('hidden')).toBe(true);
      expect(contentP2.parentElement?.getAttribute('data-panel-kind')).toBe(
        'files',
      );
      expect(contentP1.getAttribute('data-content-active')).toBe('true');
      expect(contentP2.getAttribute('data-content-active')).toBe('false');
      expect(contentP2.getAttribute('data-content-visible')).toBe('false');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('forwards a tab right-click to onTabContextMenu (group id, panel id, coords)', () => {
    const { callbacks } = createCallbacks();
    const onTabContextMenu = jest.fn();
    const { container, root } = render(
      <PanelGroup {...makeProps(callbacks, { onTabContextMenu })} />,
    );

    try {
      const tabP2 = getByTestId(container, 'panel-tab-p2');
      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 12,
        clientY: 34,
      });
      act(() => {
        tabP2.dispatchEvent(event);
      });
      expect(onTabContextMenu).toHaveBeenCalledWith('g1', 'p2', 12, 34);
      expect(event.defaultPrevented).toBe(true);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('selects a tab on click and closes it via the close button without selecting', () => {
    const { callbacks, onSelectTab, onCloseTab } = createCallbacks();
    const { container, root } = render(
      <PanelGroup {...makeProps(callbacks)} />,
    );

    try {
      click(getByTestId(container, 'panel-tab-p2'));
      expect(onSelectTab).toHaveBeenCalledWith('g1', 'p2');
      expect(onCloseTab).not.toHaveBeenCalled();

      onSelectTab.mockClear();
      click(getByTestId(container, 'panel-tab-close-p3'));
      expect(onCloseTab).toHaveBeenCalledWith('g1', 'p3');
      expect(onSelectTab).not.toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('moves tab focus with arrow keys and selects with Enter', () => {
    const { callbacks, onSelectTab } = createCallbacks();
    const { container, root } = render(
      <PanelGroup {...makeProps(callbacks)} />,
    );

    try {
      const tabP1 = getByTestId(container, 'panel-tab-p1');
      const tabP2 = getByTestId(container, 'panel-tab-p2');

      // Roving tabindex: only the active tab is tabbable initially.
      expect(tabP1.tabIndex).toBe(0);
      expect(tabP2.tabIndex).toBe(-1);

      act(() => {
        tabP1.focus();
        tabP1.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
        );
      });
      expect(document.activeElement).toBe(tabP2);
      expect(tabP2.tabIndex).toBe(0);
      expect(tabP1.tabIndex).toBe(-1);

      act(() => {
        tabP2.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
      });
      expect(onSelectTab).toHaveBeenCalledWith('g1', 'p2');

      // ArrowLeft moves back.
      act(() => {
        tabP2.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
        );
      });
      expect(document.activeElement).toBe(tabP1);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('maximizes from the menu, restores from the direct button, and disables close/maximize for a lone group', () => {
    const { callbacks, onMaximizeGroup, onCloseGroup } = createCallbacks();
    const { container, root } = render(
      <PanelGroup {...makeProps(callbacks)} />,
    );

    try {
      // Not maximized: no direct restore button; Full screen lives in the menu.
      expect(queryByTestId(container, 'panel-group-restore-g1')).toBeNull();
      click(getByTestId(container, 'panel-group-menu-g1'));
      click(getByTestId(container, 'panel-group-maximize-g1'));
      expect(onMaximizeGroup).toHaveBeenCalledWith('g1', true);

      // Maximized: the direct restore button appears; the Full screen menu
      // item is gone.
      act(() => {
        root.render(
          <PanelGroup {...makeProps(callbacks, { isMaximized: true })} />,
        );
      });
      const restore = getByTestId(container, 'panel-group-restore-g1');
      click(restore);
      expect(onMaximizeGroup).toHaveBeenLastCalledWith('g1', false);
      click(getByTestId(container, 'panel-group-menu-g1'));
      expect(queryByTestId(container, 'panel-group-maximize-g1')).toBeNull();

      // Close-all lives inside the overflow menu; open it, then click.
      const close = getByTestId(container, 'panel-group-close-g1');
      click(close);
      expect(onCloseGroup).toHaveBeenCalledWith('g1');

      // Lone root group: the Full screen + Close-all menu items are disabled.
      onCloseGroup.mockClear();
      onMaximizeGroup.mockClear();
      act(() => {
        root.render(
          <PanelGroup
            {...makeProps(callbacks, {
              isMaximized: false,
              hasMultipleGroups: false,
            })}
          />,
        );
      });

      click(getByTestId(container, 'panel-group-menu-g1'));
      const disabledMaximize = getByTestId(
        container,
        'panel-group-maximize-g1',
      );
      const disabledClose = getByTestId(container, 'panel-group-close-g1');
      expect(disabledMaximize.hasAttribute('disabled')).toBe(true);
      expect(disabledClose.hasAttribute('disabled')).toBe(true);
      click(disabledMaximize);
      click(disabledClose);
      expect(onCloseGroup).not.toHaveBeenCalled();
      expect(onMaximizeGroup).not.toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('renders direct full-screen and hide controls for a fixed-topology group', () => {
    const { callbacks, onMaximizeGroup, onCollapseGroup } = createCallbacks();
    const { container, root } = render(
      <PanelGroup
        {...makeProps(callbacks, {
          fixedTopology: true,
          fixedTopologyChrome: { hideLabel: 'Hide Side Panel' },
        })}
      />,
    );

    try {
      expect(queryByTestId(container, 'panel-group-menu-g1')).toBeNull();
      click(getByTestId(container, 'panel-group-maximize-g1'));
      expect(onMaximizeGroup).toHaveBeenCalledWith('g1', true);

      act(() => {
        root.render(
          <PanelGroup
            {...makeProps(callbacks, {
              isMaximized: true,
              fixedTopology: true,
              fixedTopologyChrome: { hideLabel: 'Hide Side Panel' },
            })}
          />,
        );
      });
      click(getByTestId(container, 'panel-group-hide-g1'));
      expect(onMaximizeGroup).toHaveBeenLastCalledWith('g1', false);
      expect(onCollapseGroup).toHaveBeenCalledWith('g1', true);
      expect(
        getByTestId(container, 'panel-group-hide-g1').getAttribute(
          'aria-label',
        ),
      ).toBe('Hide Side Panel');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('uses the shared Lucide chrome glyphs for classic and fill tabs', () => {
    const { callbacks } = createCallbacks();
    const sizeOf = (button: HTMLElement): string | null =>
      button.querySelector('svg')?.getAttribute('width') ?? null;
    const glyphOf = (button: HTMLElement): string | null =>
      button.querySelector('svg')?.getAttribute('data-glyph') ?? null;
    const fixedProps = (overrides: Partial<PanelGroupProps>): PanelGroupProps =>
      makeProps(callbacks, {
        fixedTopology: true,
        fixedTopologyChrome: { hideLabel: 'Hide Side Panel' },
        ...overrides,
      });
    const { container, root } = render(<PanelGroup {...fixedProps({})} />);

    try {
      // Classic and fill tabs use the same Lucide glyphs at 14px.
      let maximize = getByTestId(container, 'panel-group-maximize-g1');
      expect(glyphOf(maximize)).toBe('maximize-2');
      expect(sizeOf(maximize)).toBe('14px');
      expect(glyphOf(getByTestId(container, 'panel-group-hide-g1'))).toBe('x');

      // The fill-tab treatment keeps the same icon family and size.
      act(() => {
        root.render(<PanelGroup {...fixedProps({ tabStyle: 'fill' })} />);
      });
      maximize = getByTestId(container, 'panel-group-maximize-g1');
      expect(glyphOf(maximize)).toBe('maximize-2');
      expect(sizeOf(maximize)).toBe('14px');
      expect(glyphOf(getByTestId(container, 'panel-group-hide-g1'))).toBe('x');

      // Restore follows the same style.
      act(() => {
        root.render(
          <PanelGroup
            {...fixedProps({ tabStyle: 'fill', isMaximized: true })}
          />,
        );
      });
      expect(glyphOf(getByTestId(container, 'panel-group-restore-g1'))).toBe(
        'minimize-2',
      );
      act(() => {
        root.render(<PanelGroup {...fixedProps({ isMaximized: true })} />);
      });
      expect(glyphOf(getByTestId(container, 'panel-group-restore-g1'))).toBe(
        'minimize-2',
      );
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('opens the overflow menu and dispatches a split direction, then closes', () => {
    const { callbacks, onSplitGroup } = createCallbacks();
    const { container, root } = render(
      <PanelGroup {...makeProps(callbacks)} />,
    );

    try {
      expect(queryByTestId(container, 'panel-group-split-g1-down')).toBeNull();

      const trigger = getByTestId(container, 'panel-group-menu-g1');
      trigger.focus();
      click(trigger);
      for (const direction of ['up', 'down', 'left', 'right']) {
        expect(
          queryByTestId(container, `panel-group-split-g1-${direction}`),
        ).not.toBeNull();
      }

      const splitDown = getByTestId(document.body, 'panel-group-split-g1-down');
      expect(splitDown.className).toContain('h-8');
      expect(splitDown.className).toContain('rounded-md');
      expect(splitDown.className).toContain('text-xs');
      expect(splitDown.className).toContain('enabled:hover:bg-subtle');
      expect(splitDown.className).toContain('focus-visible:bg-subtle');
      expect(splitDown.className).not.toContain('bg-muted');
      click(splitDown);
      expect(onSplitGroup).toHaveBeenCalledWith('g1', 'down');
      expect(queryByTestId(container, 'panel-group-split-g1-down')).toBeNull();
      expect(document.activeElement).toBe(trigger);

      // Escape also closes the reopened menu.
      click(trigger);
      expect(
        queryByTestId(container, 'panel-group-split-g1-up'),
      ).not.toBeNull();
      const menu = getByTestId(document.body, 'panel-group-actions-menu-g1');
      act(() => {
        menu.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
        );
      });
      expect(document.activeElement).toBe(
        getByTestId(document.body, 'panel-group-close-g1'),
      );
      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
      expect(queryByTestId(container, 'panel-group-split-g1-up')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('renders the pop-out menu item only when allowed and wired', () => {
    const withoutPopOut = createCallbacks();
    const first = render(
      <PanelGroup {...makeProps(withoutPopOut.callbacks)} />,
    );

    try {
      // canPopOut not set: no item even with the menu open and the callback
      // present.
      click(getByTestId(first.container, 'panel-group-menu-g1'));
      expect(
        queryByTestId(first.container, 'panel-group-pop-out-g1'),
      ).toBeNull();
    } finally {
      act(() => {
        first.root.unmount();
      });
    }

    const noCallback = createCallbacks({ withPopOut: false });
    const second = render(
      <PanelGroup {...makeProps(noCallback.callbacks, { canPopOut: true })} />,
    );

    try {
      // canPopOut without the optional callback: still no item.
      click(getByTestId(second.container, 'panel-group-menu-g1'));
      expect(
        queryByTestId(second.container, 'panel-group-pop-out-g1'),
      ).toBeNull();
    } finally {
      act(() => {
        second.root.unmount();
      });
    }

    const wired = createCallbacks();
    const third = render(
      <PanelGroup {...makeProps(wired.callbacks, { canPopOut: true })} />,
    );

    try {
      click(getByTestId(third.container, 'panel-group-menu-g1'));
      const popOut = getByTestId(third.container, 'panel-group-pop-out-g1');
      click(popOut);
      expect(wired.onPopOutGroup).toHaveBeenCalledWith('g1');
    } finally {
      act(() => {
        third.root.unmount();
      });
    }
  });

  it('renders the add-tab button only when the affordance is provided, and forwards clicks + the menu slot', () => {
    const withoutAddTab = createCallbacks();
    const first = render(
      <PanelGroup {...makeProps(withoutAddTab.callbacks)} />,
    );

    try {
      expect(queryByTestId(first.container, 'panel-add-tab-g1')).toBeNull();
    } finally {
      act(() => {
        first.root.unmount();
      });
    }

    const onAddTab = jest.fn();
    const { callbacks } = createCallbacks();
    const second = render(
      <PanelGroup
        {...makeProps(callbacks, {
          addTab: { label: 'Add panel', onAddTab },
        })}
      />,
    );

    try {
      const button = getByTestId(second.container, 'panel-add-tab-g1');
      expect(button.getAttribute('aria-label')).toBe('Add panel');
      expect(button.getAttribute('aria-expanded')).toBe('false');
      // The button anchors OUTSIDE the scrollable strip so its menu is not
      // clipped by the strip's overflow.
      expect(button.closest('.canopy-panel-tab-strip')).toBeNull();
      expect(button.closest('.canopy-panel-tab-bar')).not.toBeNull();

      click(button);
      expect(onAddTab).toHaveBeenCalledWith('g1');

      // App-supplied menu node renders inside the anchored wrapper and
      // flips aria-expanded.
      act(() => {
        second.root.render(
          <PanelGroup
            {...makeProps(callbacks, {
              addTab: {
                label: 'Add panel',
                onAddTab,
                menu: <div data-testid="app-add-menu" />,
              },
            })}
          />,
        );
      });
      const menu = getByTestId(second.container, 'app-add-menu');
      expect(
        getByTestId(second.container, 'panel-add-tab-g1').getAttribute(
          'aria-expanded',
        ),
      ).toBe('true');
      expect(menu.closest('.canopy-panel-add-tab-root')).not.toBeNull();
    } finally {
      act(() => {
        second.root.unmount();
      });
    }
  });

  it('does not announce popup semantics for a direct New Chat action', () => {
    const onAddChat = jest.fn();
    const { callbacks } = createCallbacks();
    const { container, root } = render(
      <PanelGroup
        {...makeProps(callbacks, {
          addTab: {
            label: 'Add panel',
            onAddTab: jest.fn(),
            addChat: { label: 'New Chat', onAddChat },
          },
        })}
      />,
    );

    try {
      const button = getByTestId(container, 'panel-add-tab-g1');
      expect(button.getAttribute('aria-label')).toBe('New Chat');
      expect(button.hasAttribute('aria-haspopup')).toBe(false);
      expect(button.hasAttribute('aria-expanded')).toBe(false);
      click(button);
      expect(onAddChat).toHaveBeenCalledWith('g1');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('renders the distinct quick-add control without the primary add button when requested', () => {
    const onQuickAdd = jest.fn();
    const { callbacks } = createCallbacks();
    const { container, root } = render(
      <PanelGroup
        {...makeProps(callbacks, {
          addTab: {
            label: 'Add panel',
            onAddTab: jest.fn(),
            hidePrimary: true,
            quickAdd: {
              label: 'Add another Terminal',
              onQuickAdd,
            },
          },
        })}
      />,
    );

    try {
      expect(queryByTestId(container, 'panel-add-tab-g1')).toBeNull();
      const quickAdd = getByTestId(container, 'panel-quick-add-g1');
      expect(quickAdd.getAttribute('aria-label')).toBe('Add another Terminal');
      click(quickAdd);
      expect(onQuickAdd).toHaveBeenCalledWith('g1');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('orders the trailing cluster add-panel → accessory → menu → collapse', () => {
    const { callbacks, onCollapseGroup } = createCallbacks();
    const { container, root } = render(
      <PanelGroup
        {...makeProps(callbacks, {
          group: {
            ...DEFAULT_GROUP,
            collapseAffordance: { state: 'enabled', edge: 'right' },
          },
          addTab: {
            label: 'Add tab',
            onAddTab: jest.fn(),
            addPanel: { label: 'Add panel', onAddPanel: jest.fn() },
          },
          tabStripAccessory: <div data-testid="strip-accessory" />,
        })}
      />,
    );

    try {
      const follows = (a: HTMLElement, b: HTMLElement): boolean =>
        Boolean(
          a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
        );
      // Both "add" affordances stay adjacent; the app accessory (desktop:
      // archived chats) trails them, ahead of the group chrome cluster.
      expect(
        follows(
          getByTestId(container, 'panel-add-panel-g1'),
          getByTestId(container, 'strip-accessory'),
        ),
      ).toBe(true);
      expect(
        follows(
          getByTestId(container, 'strip-accessory'),
          getByTestId(container, 'panel-group-menu-g1'),
        ),
      ).toBe(true);
      // The collapse caret trails the layout menu as the cluster's last
      // control.
      const collapse = getByTestId(container, 'panel-group-collapse-g1');
      expect(
        follows(getByTestId(container, 'panel-group-menu-g1'), collapse),
      ).toBe(true);
      const chromeButtons = Array.from(
        container.querySelectorAll('.canopy-panel-chrome button'),
      );
      expect(chromeButtons.at(-1)).toBe(collapse);
      click(collapse);
      expect(onCollapseGroup).toHaveBeenCalledWith('g1', true);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('keeps the collapse caret after the menu without the optional add-panel or accessory controls', () => {
    const { callbacks } = createCallbacks();
    const { container, root } = render(
      <PanelGroup
        {...makeProps(callbacks, {
          group: {
            ...DEFAULT_GROUP,
            collapseAffordance: { state: 'blocked', edge: 'bottom' },
          },
        })}
      />,
    );

    try {
      expect(queryByTestId(container, 'panel-add-panel-g1')).toBeNull();
      const menu = getByTestId(container, 'panel-group-menu-g1');
      const collapse = getByTestId(container, 'panel-group-collapse-g1');
      expect(
        Boolean(
          menu.compareDocumentPosition(collapse) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ).toBe(true);
      const chromeButtons = Array.from(
        container.querySelectorAll('.canopy-panel-chrome button'),
      );
      expect(chromeButtons.at(-1)).toBe(collapse);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('places restore before the menu and drops the collapse caret while maximized', () => {
    const { callbacks } = createCallbacks();
    const { container, root } = render(
      <PanelGroup
        {...makeProps(callbacks, {
          isMaximized: true,
          group: {
            ...DEFAULT_GROUP,
            collapseAffordance: { state: 'enabled', edge: 'right' },
          },
        })}
      />,
    );

    try {
      const restore = getByTestId(container, 'panel-group-restore-g1');
      const menu = getByTestId(container, 'panel-group-menu-g1');
      expect(
        Boolean(
          restore.compareDocumentPosition(menu) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ).toBe(true);
      expect(queryByTestId(container, 'panel-group-collapse-g1')).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  describe('content adoption mode (getPanelContentElement)', () => {
    /** Opener-realm container registry stub, one element per panel id. */
    function createContainers(panelIds: readonly string[]): {
      containers: Map<string, HTMLElement>;
      getPanelContentElement: (panelId: string) => HTMLElement | null;
    } {
      const containers = new Map<string, HTMLElement>();
      for (const panelId of panelIds) {
        const element = document.createElement('div');
        element.setAttribute('data-panel-content-host', panelId);
        // App-rendered content the adopter must never touch.
        const marker = document.createElement('span');
        marker.setAttribute('data-testid', `adopted-content-${panelId}`);
        element.appendChild(marker);
        containers.set(panelId, element);
      }
      return {
        containers,
        getPanelContentElement: (panelId): HTMLElement | null =>
          containers.get(panelId) ?? null,
      };
    }

    it('adopts each container into its tab wrapper instead of rendering inline', () => {
      const { callbacks } = createCallbacks();
      const { containers, getPanelContentElement } = createContainers([
        'p1',
        'p2',
        'p3',
      ]);
      const inlineRender = jest.fn(renderPanelContent);
      const { container, root } = render(
        <PanelGroup
          {...makeProps(callbacks, {
            renderPanelContent: inlineRender,
            getPanelContentElement,
          })}
        />,
      );

      try {
        // Inline rendering is fully bypassed in adoption mode.
        expect(inlineRender).not.toHaveBeenCalled();

        containers.forEach((element, panelId) => {
          const wrapper = element.parentElement;
          expect(wrapper).not.toBeNull();
          expect(wrapper?.classList.contains('canopy-panel-content')).toBe(
            true,
          );
          expect(
            container
              .querySelector(`[data-testid="panel-group-body-g1"]`)
              ?.contains(element),
          ).toBe(true);
          // App content inside the container is untouched.
          expect(
            element.querySelector(`[data-testid="adopted-content-${panelId}"]`),
          ).not.toBeNull();
        });

        // Hidden-not-unmounted semantics carry over: only the active tab's
        // wrapper is visible.
        expect(
          containers.get('p1')?.parentElement?.hasAttribute('hidden'),
        ).toBe(false);
        expect(
          containers.get('p2')?.parentElement?.hasAttribute('hidden'),
        ).toBe(true);
        expect(
          containers.get('p2')?.parentElement?.getAttribute('data-panel-kind'),
        ).toBe('files');
      } finally {
        act(() => {
          root.unmount();
        });
      }
    });

    it('keeps the same adopted parent across active-tab changes (no re-adopt)', () => {
      const { callbacks } = createCallbacks();
      const { containers, getPanelContentElement } = createContainers([
        'p1',
        'p2',
        'p3',
      ]);
      const { root } = render(
        <PanelGroup {...makeProps(callbacks, { getPanelContentElement })} />,
      );

      try {
        const wrapperBefore = containers.get('p2')?.parentElement;
        expect(wrapperBefore).not.toBeNull();

        act(() => {
          root.render(
            <PanelGroup
              {...makeProps(callbacks, {
                getPanelContentElement,
                group: { ...DEFAULT_GROUP, activePanelId: 'p2' },
              })}
            />,
          );
        });

        expect(containers.get('p2')?.parentElement).toBe(wrapperBefore);
        expect(wrapperBefore?.hasAttribute('hidden')).toBe(false);
        expect(
          containers.get('p1')?.parentElement?.hasAttribute('hidden'),
        ).toBe(true);
      } finally {
        act(() => {
          root.unmount();
        });
      }
    });

    it('announces every move on the container, and only moves', () => {
      const { callbacks } = createCallbacks();
      const { containers, getPanelContentElement } = createContainers([
        'p1',
        'p2',
        'p3',
      ]);
      const p1 = containers.get('p1');
      const adoptions = jest.fn();
      p1?.addEventListener(PANEL_CONTENT_ADOPTED_EVENT, adoptions);
      const { root } = render(
        <PanelGroup {...makeProps(callbacks, { getPanelContentElement })} />,
      );

      try {
        expect(adoptions).toHaveBeenCalledTimes(1);

        // Switching the active tab keeps the parent, so nothing moved.
        act(() => {
          root.render(
            <PanelGroup
              {...makeProps(callbacks, {
                getPanelContentElement,
                group: { ...DEFAULT_GROUP, activePanelId: 'p2' },
              })}
            />,
          );
        });
        expect(adoptions).toHaveBeenCalledTimes(1);
      } finally {
        act(() => {
          root.unmount();
        });
      }

      // A new adopter moves the container again, e.g. after a grid rebuild.
      const { root: nextRoot } = render(
        <PanelGroup {...makeProps(callbacks, { getPanelContentElement })} />,
      );
      try {
        expect(adoptions).toHaveBeenCalledTimes(2);
      } finally {
        act(() => {
          nextRoot.unmount();
        });
        p1?.removeEventListener(PANEL_CONTENT_ADOPTED_EVENT, adoptions);
      }
    });

    it('detaches WITHOUT destroying when a tab is removed', () => {
      const { callbacks } = createCallbacks();
      const { containers, getPanelContentElement } = createContainers([
        'p1',
        'p2',
        'p3',
      ]);
      const { root } = render(
        <PanelGroup {...makeProps(callbacks, { getPanelContentElement })} />,
      );

      try {
        const p3 = containers.get('p3');
        expect(p3?.parentElement).not.toBeNull();

        act(() => {
          root.render(
            <PanelGroup
              {...makeProps(callbacks, {
                getPanelContentElement,
                group: {
                  ...DEFAULT_GROUP,
                  tabs: DEFAULT_GROUP.tabs.filter((t) => t.panelId !== 'p3'),
                },
              })}
            />,
          );
        });

        // Detached from the group body…
        expect(p3?.parentElement).toBeNull();
        // …but the container's subtree is intact (detach, never destroy).
        expect(
          p3?.querySelector('[data-testid="adopted-content-p3"]'),
        ).not.toBeNull();
      } finally {
        act(() => {
          root.unmount();
        });
      }
    });

    it('a stale cleanup never steals the container from a newer adopter', () => {
      const { callbacks } = createCallbacks();
      const { containers, getPanelContentElement } = createContainers(['p1']);
      const singleTabGroup: PanelGroupModel = {
        groupId: 'g1',
        tabs: [tab('p1')],
        activePanelId: 'p1',
      };
      const { root } = render(
        <PanelGroup
          {...makeProps(callbacks, {
            getPanelContentElement,
            group: singleTabGroup,
          })}
        />,
      );

      const p1 = containers.get('p1');
      expect(p1).toBeDefined();
      expect(p1?.parentElement).not.toBeNull();

      // Simulate a NEWER adopter winning the move first (attach-before-detach
      // ordering): appendChild atomically re-parents the container.
      const newerAdopter = document.createElement('div');
      document.body.appendChild(newerAdopter);
      if (p1) {
        newerAdopter.appendChild(p1);
      }

      // The old adopter's cleanup runs now — it must be a no-op because it is
      // no longer the container's parent.
      act(() => {
        root.unmount();
      });

      expect(p1?.parentElement).toBe(newerAdopter);
      expect(
        p1?.querySelector('[data-testid="adopted-content-p1"]'),
      ).not.toBeNull();
      newerAdopter.remove();
    });

    it('renders an empty wrapper when the container resolver returns null', () => {
      const { callbacks } = createCallbacks();
      const { container, root } = render(
        <PanelGroup
          {...makeProps(callbacks, {
            getPanelContentElement: (): HTMLElement | null => null,
          })}
        />,
      );

      try {
        const body = getByTestId(container, 'panel-group-body-g1');
        const wrappers = body.querySelectorAll('.canopy-panel-content');
        expect(wrappers).toHaveLength(3);
        wrappers.forEach((wrapper) => {
          expect(wrapper.childElementCount).toBe(0);
        });
      } finally {
        act(() => {
          root.unmount();
        });
      }
    });
  });

  it('fires onFocusGroup for any mousedown inside the group', () => {
    const { callbacks, onFocusGroup } = createCallbacks();
    const { container, root } = render(
      <PanelGroup {...makeProps(callbacks)} />,
    );

    try {
      act(() => {
        getByTestId(container, 'content-p1').dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true }),
        );
      });
      expect(onFocusGroup).toHaveBeenCalledWith('g1');

      onFocusGroup.mockClear();
      act(() => {
        getByTestId(container, 'panel-tab-p2').dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true }),
        );
      });
      expect(onFocusGroup).toHaveBeenCalledWith('g1');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('renders the collapsed bar with in-place controls and drops the title when collapsed', () => {
    const { callbacks } = createCallbacks();
    const { container, root } = render(
      <PanelGroup
        {...makeProps(callbacks, {
          group: { ...DEFAULT_GROUP, collapsed: { edge: 'left' } },
        })}
      />,
    );

    try {
      expect(getByTestId(container, 'panel-collapsed-bar-g1')).toBeTruthy();
      const root_ = getByTestId(container, 'panel-group-g1');
      expect(root_.dataset.collapsed).toBe('left');
      // The title bar is not rendered while collapsed, so its controls exist
      // only once (in the collapse bar) — no duplicate test ids.
      expect(queryByTestId(container, 'panel-group-title-g1')).toBeNull();
      expect(
        container.querySelectorAll('[data-testid="panel-group-menu-g1"]'),
      ).toHaveLength(1);
      expect(getByTestId(container, 'panel-group-expand-g1')).toBeTruthy();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('shows an enabled collapse chevron when affordance is enabled', () => {
    const { callbacks, onCollapseGroup } = createCallbacks();
    const { container, root } = render(
      <PanelGroup
        {...makeProps(callbacks, {
          group: {
            ...DEFAULT_GROUP,
            collapseAffordance: { state: 'enabled', edge: 'right' },
          },
        })}
      />,
    );

    try {
      const button = getByTestId(container, 'panel-group-collapse-g1');
      expect(button.hasAttribute('disabled')).toBe(false);
      click(button);
      expect(onCollapseGroup).toHaveBeenCalledWith('g1', true);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('disables the collapse chevron with a tooltip when blocked, hides it when none or maximized', () => {
    const { callbacks } = createCallbacks();
    const blocked = render(
      <PanelGroup
        {...makeProps(callbacks, {
          group: {
            ...DEFAULT_GROUP,
            collapseAffordance: { state: 'blocked', edge: 'right' },
          },
        })}
      />,
    );

    try {
      const button = getByTestId(blocked.container, 'panel-group-collapse-g1');
      expect(button.hasAttribute('disabled')).toBe(true);
      // The shared TitlebarIconButton routes `title` into the custom tooltip
      // (never the native one). A DISABLED button is not focusable, so the
      // reason surfaces via the Tooltip wrapper's hover. React synthesizes
      // `onMouseEnter` from bubbling `mouseover`, so dispatch that.
      act(() => {
        button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      expect(
        document.body.querySelector('[role="tooltip"]')?.textContent,
      ).toContain('stay expanded');
    } finally {
      act(() => {
        blocked.root.unmount();
      });
    }

    const none = render(<PanelGroup {...makeProps(callbacks)} />);
    try {
      expect(
        queryByTestId(none.container, 'panel-group-collapse-g1'),
      ).toBeNull();
    } finally {
      act(() => {
        none.root.unmount();
      });
    }

    const maximized = render(
      <PanelGroup
        {...makeProps(callbacks, {
          isMaximized: true,
          group: {
            ...DEFAULT_GROUP,
            collapseAffordance: { state: 'enabled', edge: 'right' },
          },
        })}
      />,
    );
    try {
      expect(
        queryByTestId(maximized.container, 'panel-group-collapse-g1'),
      ).toBeNull();
    } finally {
      act(() => {
        maximized.root.unmount();
      });
    }
  });
});
