/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PanelGroupModel,
  PanelIntentCallbacks,
} from '../../../panels/registry-types';
import { clearPanelTabDrag, startPanelTabDrag } from '../panel-dnd';
import { PanelBranchCollapsedBar } from '../PanelBranchCollapsedBar';
import { PanelCollapsedBar } from '../PanelCollapsedBar';

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
  onCollapseGroup: jest.Mock;
  onExpandGroupToTab: jest.Mock;
}

function createCallbacks(): TestCallbacks {
  const onSelectTab = jest.fn();
  const onCloseTab = jest.fn();
  const onCloseGroup = jest.fn();
  const onSplitGroup = jest.fn();
  const onMaximizeGroup = jest.fn();
  const onFocusGroup = jest.fn();
  const onMovePanel = jest.fn();
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
    onCollapseGroup,
    onExpandGroupToTab,
  };
}

function getByTestId(scope: ParentNode, testId: string): HTMLElement {
  const element = scope.querySelector(`[data-testid="${testId}"]`);

  if (!(element instanceof HTMLElement)) {
    throw new Error(`Expected element with data-testid ${testId}`);
  }

  return element;
}

function click(element: HTMLElement): void {
  act(() => {
    element.click();
  });
}

const GROUP: PanelGroupModel = {
  groupId: 'g1',
  tabs: [
    { panelId: 'p1', kind: 'chat', title: 'Chat' },
    { panelId: 'p2', kind: 'terminal', title: 'Terminal' },
  ],
  activePanelId: 'p1',
  collapsed: { edge: 'right' },
};

describe('PanelCollapsedBar', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    jest.restoreAllMocks();
  });

  it('renders one icon button per tab with the title as tooltip', () => {
    const { callbacks } = createCallbacks();
    const { container, root } = render(
      <PanelCollapsedBar
        group={GROUP}
        edge="right"
        isActiveGroup={false}
        hasMultipleGroups
        callbacks={callbacks}
        getTabTitle={(tab): string => tab.title}
      />,
    );

    try {
      const bar = getByTestId(container, 'panel-collapsed-bar-g1');
      expect(bar.dataset.edge).toBe('right');
      // Icons use the rich Tooltip; the accessible name carries the title.
      expect(
        getByTestId(container, 'panel-collapsed-tab-p1').getAttribute(
          'aria-label',
        ),
      ).toBe('Chat');
      expect(
        getByTestId(container, 'panel-collapsed-tab-p2').getAttribute(
          'aria-label',
        ),
      ).toBe('Terminal');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('clicking a tab icon expands to that tab; chevron expands to the active tab', () => {
    const { callbacks, onExpandGroupToTab, onCollapseGroup } =
      createCallbacks();
    const { container, root } = render(
      <PanelCollapsedBar
        group={GROUP}
        edge="right"
        isActiveGroup={false}
        hasMultipleGroups
        callbacks={callbacks}
      />,
    );

    try {
      click(getByTestId(container, 'panel-collapsed-tab-p2'));
      expect(onExpandGroupToTab).toHaveBeenCalledWith('g1', 'p2');
      click(getByTestId(container, 'panel-group-expand-g1'));
      expect(onCollapseGroup).toHaveBeenCalledWith('g1', false);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('uses the injected chrome expand label on the vertical strip toggle', () => {
    const { callbacks } = createCallbacks();
    const { container, root } = render(
      <PanelCollapsedBar
        group={GROUP}
        edge="right"
        isActiveGroup={false}
        hasMultipleGroups
        callbacks={callbacks}
        chrome={{
          maximize: 'Max',
          restore: 'Restore',
          more: 'More',
          close: 'Close',
          split: 'Split',
          splitUp: 'Split up',
          splitDown: 'Split down',
          splitLeft: 'Split left',
          splitRight: 'Split right',
          collapse: 'Collapse',
          collapseBlocked: 'Blocked',
          expand: 'Show panel group',
        }}
      />,
    );

    try {
      expect(
        getByTestId(container, 'panel-group-expand-g1').getAttribute(
          'aria-label',
        ),
      ).toBe('Show panel group');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('keeps the add button and overflow (…) menu in the collapsed bar', () => {
    const { callbacks } = createCallbacks();
    const onAddTab = jest.fn();
    const { container, root } = render(
      <PanelCollapsedBar
        group={GROUP}
        edge="right"
        isActiveGroup={false}
        hasMultipleGroups
        callbacks={callbacks}
        addTab={{ label: 'Add panel', onAddTab }}
      />,
    );

    try {
      expect(getByTestId(container, 'panel-group-expand-g1')).toBeTruthy();
      const add = getByTestId(container, 'panel-add-tab-g1');
      click(add);
      expect(onAddTab).toHaveBeenCalledWith('g1');
      // Overflow menu opens (portaled to the document body so it escapes the
      // collapse bar's clipped grid leaf) and exposes the same group actions.
      click(getByTestId(container, 'panel-group-menu-g1'));
      expect(
        getByTestId(document.body, 'panel-group-split-g1-up'),
      ).toBeTruthy();
      expect(getByTestId(document.body, 'panel-group-close-g1')).toBeTruthy();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('maximize from the collapsed overflow menu routes through onMaximizeGroup', () => {
    const { callbacks, onMaximizeGroup } = createCallbacks();
    const { container, root } = render(
      <PanelCollapsedBar
        group={GROUP}
        edge="right"
        isActiveGroup={false}
        hasMultipleGroups
        callbacks={callbacks}
      />,
    );

    try {
      click(getByTestId(container, 'panel-group-menu-g1'));
      click(getByTestId(document.body, 'panel-group-maximize-g1'));
      // The store expands-then-maximizes a collapsed group; the component
      // just dispatches the intent.
      expect(onMaximizeGroup).toHaveBeenCalledWith('g1', true);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('stacks controls above the tab icons on a vertical strip, expand toggle last', () => {
    for (const edge of ['left', 'right'] as const) {
      const { callbacks, onCollapseGroup } = createCallbacks();
      const { container, root } = render(
        <PanelCollapsedBar
          group={{ ...GROUP, collapsed: { edge } }}
          edge={edge}
          isActiveGroup={false}
          hasMultipleGroups
          callbacks={callbacks}
          addTab={{ label: 'Add panel', onAddTab: jest.fn() }}
        />,
      );

      try {
        const bar = getByTestId(container, 'panel-collapsed-bar-g1');
        const order = Array.from(bar.querySelectorAll('[data-testid]')).map(
          (el) => el.getAttribute('data-testid'),
        );
        const toggleIndex = order.indexOf('panel-group-expand-g1');
        const addIndex = order.indexOf('panel-add-tab-g1');
        const menuIndex = order.indexOf('panel-group-menu-g1');
        const firstTabIndex = order.indexOf('panel-collapsed-tab-p1');
        // add → … → toggle → tab icons (controls stacked at the top, the
        // expand toggle closing the control stack like the expanded caret).
        expect(addIndex).toBeGreaterThanOrEqual(0);
        expect(addIndex).toBeLessThan(menuIndex);
        expect(menuIndex).toBeLessThan(toggleIndex);
        expect(toggleIndex).toBeLessThan(firstTabIndex);
        // Exactly one expand control, outside the menu-only chrome.
        expect(
          bar.querySelectorAll('[data-testid="panel-group-expand-g1"]'),
        ).toHaveLength(1);
        const toggle = getByTestId(bar, 'panel-group-expand-g1');
        expect(toggle.closest('.canopy-panel-chrome')).toBeNull();
        click(toggle);
        expect(onCollapseGroup).toHaveBeenCalledWith('g1', false);
      } finally {
        act(() => {
          root.unmount();
        });
        document.body.innerHTML = '';
      }
    }
  });

  it('embeds the expand toggle as the last chrome button on a horizontal bar', () => {
    for (const edge of ['bottom', 'top'] as const) {
      const { callbacks, onCollapseGroup } = createCallbacks();
      const { container, root } = render(
        <PanelCollapsedBar
          group={{ ...GROUP, collapsed: { edge } }}
          edge={edge}
          isActiveGroup={false}
          hasMultipleGroups
          callbacks={callbacks}
        />,
      );

      try {
        // No standalone strip button — the toggle is a chrome button, sitting
        // in the same trailing slot as the expanded collapse chevron so it
        // lines up.
        expect(
          container.querySelector('.canopy-panel-collapsed-expand'),
        ).toBeNull();
        const toggle = getByTestId(container, 'panel-group-expand-g1');
        expect(toggle.classList.contains('canopy-panel-chrome-button')).toBe(
          true,
        );
        const menu = getByTestId(container, 'panel-group-menu-g1');
        expect(
          Boolean(
            menu.compareDocumentPosition(toggle) &
            Node.DOCUMENT_POSITION_FOLLOWING,
          ),
        ).toBe(true);
        const bar = getByTestId(container, 'panel-collapsed-bar-g1');
        const buttons = Array.from(bar.querySelectorAll('button'));
        expect(buttons.at(-1)).toBe(toggle);
        click(toggle);
        expect(onCollapseGroup).toHaveBeenCalledWith('g1', false);
      } finally {
        act(() => {
          root.unmount();
        });
        document.body.innerHTML = '';
      }
    }
  });
  it('orders controls add-tab → add-panel → accessory → menu → expand in both orientations', () => {
    const follows = (a: HTMLElement, b: HTMLElement): boolean =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

    for (const edge of ['bottom', 'right'] as const) {
      const { callbacks } = createCallbacks();
      const { container, root } = render(
        <PanelCollapsedBar
          group={{ ...GROUP, collapsed: { edge } }}
          edge={edge}
          isActiveGroup={false}
          hasMultipleGroups
          callbacks={callbacks}
          addTab={{
            label: 'Add tab',
            onAddTab: jest.fn(),
            addPanel: { label: 'Add panel', onAddPanel: jest.fn() },
          }}
          tabStripAccessory={<div data-testid="strip-accessory" />}
        />,
      );

      try {
        // Mirrors the expanded title bar: the two "add" affordances stay
        // adjacent and the accessory (desktop: archived chats) trails them,
        // ahead of the overflow menu.
        expect(
          follows(
            getByTestId(container, 'panel-add-tab-g1'),
            getByTestId(container, 'panel-add-panel-g1'),
          ),
        ).toBe(true);
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
        // The expand caret closes the control cluster in both orientations.
        expect(
          follows(
            getByTestId(container, 'panel-group-menu-g1'),
            getByTestId(container, 'panel-group-expand-g1'),
          ),
        ).toBe(true);
      } finally {
        act(() => {
          root.unmount();
        });
        document.body.innerHTML = '';
      }
    }
  });
});

describe('PanelBranchCollapsedBar', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    jest.restoreAllMocks();
  });

  // The expand that a tab DROP performs is incidental: the dropped tab
  // becomes active, so nothing the group already held was revealed. Layout
  // owners hang reveal side effects (desktop terminal auto-start) off this
  // callback, and a reveal queued here can never be claimed by the panel it
  // names — leaving it to fire on a later PASSIVE activation (CAN-2309).
  // The surface-side guard is tested separately; this pins the wiring that
  // tells it which gesture it is looking at.
  it('marks the drop-path expand as a move, not a reveal', () => {
    const { callbacks, onCollapseGroup, onMovePanel } = createCallbacks();
    const { container, root } = render(
      <PanelBranchCollapsedBar
        groups={[GROUP]}
        edge="right"
        callbacks={callbacks}
      />,
    );

    try {
      startPanelTabDrag({ panelId: 'dragged', sourceGroupId: 'other' });
      act(() => {
        container
          .querySelector('[role="group"]')
          ?.dispatchEvent(new Event('drop', { bubbles: true }));
      });

      expect(onCollapseGroup).toHaveBeenCalledWith('g1', false, {
        gesture: 'move',
      });
      expect(onMovePanel).toHaveBeenCalledWith('dragged', 'g1', 'center');
      // Ordering matters: the group must be expanded before the panel moves
      // into it.
      expect(onCollapseGroup.mock.invocationCallOrder[0]).toBeLessThan(
        onMovePanel.mock.invocationCallOrder[0] ?? 0,
      );
    } finally {
      clearPanelTabDrag();
      act(() => {
        root.unmount();
      });
    }
  });

  it('takes no drop, and expands nothing, for a refused move', () => {
    const { callbacks, onCollapseGroup, onMovePanel } = createCallbacks();
    const canDropPanel = jest.fn((): boolean => false);
    const { container, root } = render(
      <PanelBranchCollapsedBar
        groups={[GROUP]}
        edge="right"
        callbacks={{ ...callbacks, canDropPanel }}
      />,
    );

    try {
      startPanelTabDrag({ panelId: 'dragged', sourceGroupId: 'other' });
      const target = container.querySelector('[role="group"]');
      const over = new Event('dragover', { bubbles: true, cancelable: true });
      act(() => {
        target?.dispatchEvent(over);
        target?.dispatchEvent(new Event('drop', { bubbles: true }));
      });

      expect(over.defaultPrevented).toBe(false);
      expect(canDropPanel).toHaveBeenCalledWith('dragged', 'g1', 'center');
      expect(onCollapseGroup).not.toHaveBeenCalled();
      expect(onMovePanel).not.toHaveBeenCalled();
    } finally {
      clearPanelTabDrag();
      act(() => {
        root.unmount();
      });
    }
  });

  it('marks the expand-button gesture as a reveal', () => {
    const { callbacks, onCollapseGroup } = createCallbacks();
    const { container, root } = render(
      <PanelBranchCollapsedBar
        groups={[GROUP]}
        edge="right"
        callbacks={callbacks}
      />,
    );

    try {
      click(getByTestId(container, 'panel-branch-expand-g1'));

      expect(onCollapseGroup).toHaveBeenCalledWith('g1', false);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('gives an empty group non-empty expand and group labels', () => {
    const { callbacks } = createCallbacks();
    const emptyGroup: PanelGroupModel = {
      groupId: 'empty',
      tabs: [],
      activePanelId: null,
      collapsed: { edge: 'right' },
    };
    const { container, root } = render(
      <PanelBranchCollapsedBar
        groups={[emptyGroup]}
        edge="right"
        callbacks={callbacks}
      />,
    );

    try {
      expect(
        container.querySelector('[role="group"]')?.getAttribute('aria-label'),
      ).toBe('Empty panel group');
      expect(
        getByTestId(container, 'panel-branch-expand-empty').getAttribute(
          'aria-label',
        ),
      ).toBe('Expand Empty panel group');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });
});

describe('PanelCollapsedBar renderTabTooltip seam', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    jest.useRealTimers();
  });

  it('collapsed tab icons use the custom tooltip when non-null', () => {
    jest.useFakeTimers();
    const { callbacks } = createCallbacks();
    const { container } = render(
      <PanelCollapsedBar
        group={GROUP}
        edge="right"
        isActiveGroup={false}
        hasMultipleGroups
        callbacks={callbacks}
        renderTabTooltip={(tab): JSX.Element | null =>
          tab.panelId === 'p1' ? (
            <span data-testid="collapsed-rich-tooltip">Rich {tab.title}</span>
          ) : null
        }
      />,
    );

    const icon = getByTestId(container, 'panel-collapsed-tab-p1');
    act(() => {
      icon.parentElement?.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      );
      jest.runOnlyPendingTimers();
    });
    expect(
      document.querySelector('[data-testid="collapsed-rich-tooltip"]'),
    ).not.toBeNull();
    // Accessible names still come from the plain title.
    expect(icon.getAttribute('aria-label')).toBe('Chat');
  });
});
