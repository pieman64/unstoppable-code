/** @jest-environment jsdom */
import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DropDirection } from '../../../panels/drop-geometry';
import type {
  PanelContentProps,
  PanelDropEdge,
  PanelGroupModel,
  PanelIntentCallbacks,
  PanelTabModel,
} from '../../../panels/registry-types';
import {
  clearPanelTabDrag,
  dropDirectionToDropEdge,
  hasActivePanelTabDrag,
  readPanelTabDrag,
  startPanelTabDrag,
} from '../panel-dnd';
import { PanelGroup, type PanelGroupProps } from '../PanelGroup';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Deterministic dragover throttling: run rAF callbacks synchronously so the
// overlay classification lands inside the same act() as the dispatch.
beforeAll(() => {
  window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    callback(0);
    return 0;
  };
  window.cancelAnimationFrame = (): void => {};
});

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
  onMovePanel: jest.Mock;
  onReorderTab: jest.Mock;
}

function createCallbacks(): TestCallbacks {
  const onMovePanel = jest.fn();
  const onReorderTab = jest.fn();
  const callbacks: PanelIntentCallbacks = {
    onSelectTab: jest.fn(),
    onCloseTab: jest.fn(),
    onCloseGroup: jest.fn(),
    onSplitGroup: jest.fn(),
    onMaximizeGroup: jest.fn(),
    onFocusGroup: jest.fn(),
    onMovePanel,
    onReorderTab,
  };
  return { callbacks, onMovePanel, onReorderTab };
}

function tab(panelId: string, kind = 'chat'): PanelTabModel {
  return { panelId, kind, title: panelId.toUpperCase() };
}

const THREE_TABS: PanelGroupModel = {
  groupId: 'g1',
  tabs: [tab('p1'), tab('p2', 'files'), tab('p3', 'terminal')],
  activePanelId: 'p1',
};

const ONE_TAB: PanelGroupModel = {
  groupId: 'g1',
  tabs: [tab('p1')],
  activePanelId: 'p1',
};

function renderPanelContent(props: PanelContentProps): ReactNode {
  return <div data-testid={`content-${props.panelId}`} />;
}

function makeProps(
  callbacks: PanelIntentCallbacks,
  overrides: Partial<PanelGroupProps> = {},
): PanelGroupProps {
  return {
    group: THREE_TABS,
    isActiveGroup: true,
    isMaximized: false,
    isGroupVisible: true,
    hasMultipleGroups: true,
    callbacks,
    renderPanelContent,
    ...overrides,
  };
}

function getByTestId(scope: ParentNode, testId: string): HTMLElement {
  const element = scope.querySelector(`[data-testid="${testId}"]`);

  if (!(element instanceof HTMLElement)) {
    throw new Error(`Expected element with data-testid ${testId}`);
  }

  return element;
}

function queryByTestId(scope: ParentNode, testId: string): HTMLElement | null {
  const element = scope.querySelector(`[data-testid="${testId}"]`);
  return element instanceof HTMLElement ? element : null;
}

/**
 * Dispatches a synthetic drag event. jsdom does not implement the DragEvent
 * constructor, so feature-detect and fall back to MouseEvent (the wiring only
 * reads `clientX`/`clientY` and feature-guards `dataTransfer`), matching the
 * dnd-observer test approach.
 */
function fireDrag(
  target: Element,
  type: string,
  init: { clientX?: number; clientY?: number } = {},
): Event {
  const Ctor = typeof DragEvent === 'function' ? DragEvent : MouseEvent;
  const event = new Ctor(type, {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function mockRect(
  element: HTMLElement,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  element.getBoundingClientRect = (): DOMRect =>
    new DOMRect(x, y, width, height);
}

/** Body at (0,0) 200×100; tabs p1/p2/p3 side by side, 100px wide each. */
function mockDefaultRects(container: ParentNode): void {
  mockRect(getByTestId(container, 'panel-group-body-g1'), 0, 0, 200, 100);
  mockRect(getByTestId(container, 'panel-tab-p1'), 0, 0, 100, 20);
  const p2 = queryByTestId(container, 'panel-tab-p2');
  const p3 = queryByTestId(container, 'panel-tab-p3');
  if (p2) {
    mockRect(p2, 100, 0, 100, 20);
  }
  if (p3) {
    mockRect(p3, 200, 0, 100, 20);
  }
}

describe('dropDirectionToDropEdge', () => {
  it.each<[DropDirection, PanelDropEdge]>([
    ['up', 'top'],
    ['down', 'bottom'],
    ['left', 'left'],
    ['right', 'right'],
    ['center', 'center'],
  ])('maps %s -> %s', (direction, edge) => {
    expect(dropDirectionToDropEdge(direction)).toBe(edge);
  });
});

describe('panel tab drag source', () => {
  afterEach(() => {
    clearPanelTabDrag();
    document.body.innerHTML = '';
  });

  it('dragstart writes the tab identity into the transfer and dims the tab; dragend clears both', () => {
    const { callbacks } = createCallbacks();
    const { container, root } = render(
      <PanelGroup {...makeProps(callbacks)} />,
    );

    try {
      const tabP1 = getByTestId(container, 'panel-tab-p1');
      expect(hasActivePanelTabDrag()).toBe(false);

      fireDrag(tabP1, 'dragstart');
      expect(hasActivePanelTabDrag()).toBe(true);
      expect(readPanelTabDrag()).toEqual({
        panelId: 'p1',
        sourceGroupId: 'g1',
      });
      expect(tabP1.classList.contains('canopy-panel-tab-dragging')).toBe(true);

      fireDrag(tabP1, 'dragend');
      expect(hasActivePanelTabDrag()).toBe(false);
      expect(readPanelTabDrag()).toBeNull();
      expect(tabP1.classList.contains('canopy-panel-tab-dragging')).toBe(false);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });
});

describe('group body drop target', () => {
  afterEach(() => {
    clearPanelTabDrag();
    document.body.innerHTML = '';
  });

  it('classifies dragover positions, shows the overlay + zones, and prevents default', () => {
    const { callbacks } = createCallbacks();
    const { container, root } = render(
      <PanelGroup {...makeProps(callbacks)} />,
    );

    try {
      mockDefaultRects(container);
      const body = getByTestId(container, 'panel-group-body-g1');
      startPanelTabDrag({ panelId: 'p9', sourceGroupId: 'g0' });

      // No overlay before the drag enters the body.
      expect(queryByTestId(container, 'panel-drop-overlay-g1')).toBeNull();

      fireDrag(body, 'dragenter');
      const overlay = getByTestId(container, 'panel-drop-overlay-g1');
      expect(overlay.hasAttribute('data-direction')).toBe(false);
      // Zones render while a drag is over the body (spec targets).
      expect(queryByTestId(container, 'panel-drop-zone-g1-left')).not.toBe(
        null,
      );

      // Left edge strip (x=5 of 200 is inside the 10% edge threshold).
      const overEvent = fireDrag(body, 'dragover', { clientX: 5, clientY: 50 });
      expect(overEvent.defaultPrevented).toBe(true);
      expect(
        getByTestId(container, 'panel-drop-overlay-g1').getAttribute(
          'data-direction',
        ),
      ).toBe('left');

      // Center merge zone.
      fireDrag(body, 'dragover', { clientX: 100, clientY: 50 });
      expect(
        getByTestId(container, 'panel-drop-overlay-g1').getAttribute(
          'data-direction',
        ),
      ).toBe('center');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('keeps the overlay stable across child enter/leave and hides it on a true leave', () => {
    const { callbacks } = createCallbacks();
    const { container, root } = render(
      <PanelGroup {...makeProps(callbacks)} />,
    );

    try {
      mockDefaultRects(container);
      const body = getByTestId(container, 'panel-group-body-g1');
      const child = getByTestId(container, 'content-p1');
      startPanelTabDrag({ panelId: 'p9', sourceGroupId: 'g0' });

      fireDrag(body, 'dragenter'); // counter: 1
      fireDrag(child, 'dragenter'); // bubbles, counter: 2
      expect(queryByTestId(container, 'panel-drop-overlay-g1')).not.toBeNull();

      fireDrag(child, 'dragleave'); // counter: 1 — still inside the subtree
      expect(queryByTestId(container, 'panel-drop-overlay-g1')).not.toBeNull();

      fireDrag(body, 'dragleave'); // counter: 0 — truly left
      expect(queryByTestId(container, 'panel-drop-overlay-g1')).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('does not show drop feedback for foreign drags (no panel-tab transfer)', () => {
    const { callbacks } = createCallbacks();
    const { container, root } = render(
      <PanelGroup {...makeProps(callbacks)} />,
    );

    try {
      mockDefaultRects(container);
      const body = getByTestId(container, 'panel-group-body-g1');

      fireDrag(body, 'dragenter');
      fireDrag(body, 'dragover', { clientX: 100, clientY: 50 });
      expect(queryByTestId(container, 'panel-drop-overlay-g1')).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('drop on an edge fires onMovePanel with the mapped edge, clears the transfer, and hides the overlay', () => {
    const { callbacks, onMovePanel } = createCallbacks();
    const { container, root } = render(
      <PanelGroup {...makeProps(callbacks)} />,
    );

    try {
      mockDefaultRects(container);
      const body = getByTestId(container, 'panel-group-body-g1');
      startPanelTabDrag({ panelId: 'p9', sourceGroupId: 'g0' });

      fireDrag(body, 'dragenter');
      fireDrag(body, 'dragover', { clientX: 100, clientY: 3 });
      // Top edge strip, middle column -> 'up' -> intent edge 'top'.
      fireDrag(body, 'drop', { clientX: 100, clientY: 3 });

      expect(onMovePanel).toHaveBeenCalledTimes(1);
      expect(onMovePanel).toHaveBeenCalledWith('p9', 'g1', 'top');
      expect(hasActivePanelTabDrag()).toBe(false);
      expect(queryByTestId(container, 'panel-drop-overlay-g1')).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('drop in the center merges the dragged tab into this group', () => {
    const { callbacks, onMovePanel } = createCallbacks();
    const { container, root } = render(
      <PanelGroup {...makeProps(callbacks)} />,
    );

    try {
      mockDefaultRects(container);
      const body = getByTestId(container, 'panel-group-body-g1');
      startPanelTabDrag({ panelId: 'p9', sourceGroupId: 'g0' });

      fireDrag(body, 'drop', { clientX: 100, clientY: 50 });
      expect(onMovePanel).toHaveBeenCalledWith('p9', 'g1', 'center');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("dropping a group's only tab onto its own center is a no-op (still clears the transfer)", () => {
    const { callbacks, onMovePanel } = createCallbacks();
    const { container, root } = render(
      <PanelGroup {...makeProps(callbacks, { group: ONE_TAB })} />,
    );

    try {
      mockRect(getByTestId(container, 'panel-group-body-g1'), 0, 0, 200, 100);
      const body = getByTestId(container, 'panel-group-body-g1');
      startPanelTabDrag({ panelId: 'p1', sourceGroupId: 'g1' });

      fireDrag(body, 'drop', { clientX: 100, clientY: 50 });
      expect(onMovePanel).not.toHaveBeenCalled();
      expect(hasActivePanelTabDrag()).toBe(false);

      // An EDGE drop of the same only tab is meaningful (moves the group).
      startPanelTabDrag({ panelId: 'p1', sourceGroupId: 'g1' });
      fireDrag(body, 'drop', { clientX: 195, clientY: 50 });
      expect(onMovePanel).toHaveBeenCalledWith('p1', 'g1', 'right');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });
});

describe('drops the layout owner refuses', () => {
  afterEach(() => {
    clearPanelTabDrag();
    document.body.innerHTML = '';
  });

  it('the body highlights and drops only the moves canDropPanel accepts', () => {
    const { callbacks, onMovePanel } = createCallbacks();
    const canDropPanel = jest.fn(
      (_panelId: string, _groupId: string, edge: PanelDropEdge): boolean =>
        edge === 'center',
    );
    const { container, root } = render(
      <PanelGroup {...makeProps({ ...callbacks, canDropPanel })} />,
    );

    try {
      mockDefaultRects(container);
      const body = getByTestId(container, 'panel-group-body-g1');
      startPanelTabDrag({ panelId: 'p9', sourceGroupId: 'g0' });

      fireDrag(body, 'dragenter');
      fireDrag(body, 'dragover', { clientX: 5, clientY: 50 });
      expect(
        getByTestId(container, 'panel-drop-overlay-g1').hasAttribute(
          'data-direction',
        ),
      ).toBe(false);
      expect(canDropPanel).toHaveBeenCalledWith('p9', 'g1', 'left');

      fireDrag(body, 'dragover', { clientX: 100, clientY: 50 });
      expect(
        getByTestId(container, 'panel-drop-overlay-g1').getAttribute(
          'data-direction',
        ),
      ).toBe('center');

      fireDrag(body, 'drop', { clientX: 5, clientY: 50 });
      expect(onMovePanel).not.toHaveBeenCalled();

      startPanelTabDrag({ panelId: 'p9', sourceGroupId: 'g0' });
      fireDrag(body, 'drop', { clientX: 100, clientY: 50 });
      expect(onMovePanel).toHaveBeenCalledWith('p9', 'g1', 'center');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('the tab strip shows no indicator and ignores a refused merge', () => {
    const { callbacks, onMovePanel } = createCallbacks();
    const canDropPanel = jest.fn((): boolean => false);
    const { container, root } = render(
      <PanelGroup {...makeProps({ ...callbacks, canDropPanel })} />,
    );

    try {
      mockDefaultRects(container);
      const tabP3 = getByTestId(container, 'panel-tab-p3');
      startPanelTabDrag({ panelId: 'p9', sourceGroupId: 'g0' });

      fireDrag(tabP3, 'dragover', { clientX: 280, clientY: 10 });
      expect(tabP3.classList.contains('canopy-panel-tab-drop-after')).toBe(
        false,
      );
      fireDrag(tabP3, 'drop', { clientX: 280, clientY: 10 });
      expect(onMovePanel).not.toHaveBeenCalled();
      expect(canDropPanel).toHaveBeenCalledWith('p9', 'g1', 'center');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });
});

describe('tab-strip reorder + merge drop target', () => {
  afterEach(() => {
    clearPanelTabDrag();
    document.body.innerHTML = '';
  });

  it('dragover shows the insertion indicator and drop reorders with the final-array index', () => {
    const { callbacks, onReorderTab, onMovePanel } = createCallbacks();
    const { container, root } = render(
      <PanelGroup {...makeProps(callbacks)} />,
    );

    try {
      mockDefaultRects(container);
      const tabP1 = getByTestId(container, 'panel-tab-p1');
      const tabP3 = getByTestId(container, 'panel-tab-p3');

      fireDrag(tabP1, 'dragstart');

      // Right half of p3 (x=280 of the 200-300 span) -> insert at the end.
      fireDrag(tabP3, 'dragover', { clientX: 280, clientY: 10 });
      expect(tabP3.classList.contains('canopy-panel-tab-drop-after')).toBe(
        true,
      );

      fireDrag(tabP3, 'drop', { clientX: 280, clientY: 10 });
      // Insertion index 3 in [p1,p2,p3]; removing p1 first -> final index 2.
      expect(onReorderTab).toHaveBeenCalledTimes(1);
      expect(onReorderTab).toHaveBeenCalledWith('g1', 'p1', 2);
      expect(onMovePanel).not.toHaveBeenCalled();
      expect(hasActivePanelTabDrag()).toBe(false);
      expect(tabP3.classList.contains('canopy-panel-tab-drop-after')).toBe(
        false,
      );
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('shows the before-indicator on a left half and skips the intent when the position is unchanged', () => {
    const { callbacks, onReorderTab } = createCallbacks();
    const { container, root } = render(
      <PanelGroup {...makeProps(callbacks)} />,
    );

    try {
      mockDefaultRects(container);
      const tabP1 = getByTestId(container, 'panel-tab-p1');

      fireDrag(tabP1, 'dragstart');

      // Left half of p1 -> insertion index 0 == current position.
      fireDrag(tabP1, 'dragover', { clientX: 10, clientY: 10 });
      expect(tabP1.classList.contains('canopy-panel-tab-drop-before')).toBe(
        true,
      );

      fireDrag(tabP1, 'drop', { clientX: 10, clientY: 10 });
      expect(onReorderTab).not.toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('a cross-group strip drop merges the dragged tab at the indicated index', () => {
    const { callbacks, onReorderTab, onMovePanel } = createCallbacks();
    const { container, root } = render(
      <PanelGroup {...makeProps(callbacks)} />,
    );

    try {
      mockDefaultRects(container);
      const tabP2 = getByTestId(container, 'panel-tab-p2');
      startPanelTabDrag({ panelId: 'p9', sourceGroupId: 'g0' });

      // Left half of p2 means the indicator sits between p1 and p2, so the
      // cross-group move must preserve that intended insertion index.
      fireDrag(tabP2, 'drop', { clientX: 110, clientY: 10 });
      expect(onMovePanel).toHaveBeenCalledWith('p9', 'g1', 'center', 1);
      expect(onReorderTab).not.toHaveBeenCalled();
      expect(hasActivePanelTabDrag()).toBe(false);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('a fixed layout reorders its own tabs but refuses tabs from other groups', () => {
    const { callbacks, onReorderTab, onMovePanel } = createCallbacks();
    const { container, root } = render(
      <PanelGroup {...makeProps(callbacks, { fixedTopology: true })} />,
    );

    try {
      mockDefaultRects(container);
      const tabP1 = getByTestId(container, 'panel-tab-p1');
      const tabP3 = getByTestId(container, 'panel-tab-p3');
      expect(tabP1.getAttribute('draggable')).toBe('true');

      fireDrag(tabP1, 'dragstart');
      fireDrag(tabP3, 'dragover', { clientX: 280, clientY: 10 });
      expect(tabP3.classList.contains('canopy-panel-tab-drop-after')).toBe(
        true,
      );
      fireDrag(tabP3, 'drop', { clientX: 280, clientY: 10 });
      expect(onReorderTab).toHaveBeenCalledWith('g1', 'p1', 2);

      startPanelTabDrag({ panelId: 'p9', sourceGroupId: 'g0' });
      fireDrag(tabP3, 'dragover', { clientX: 280, clientY: 10 });
      expect(tabP3.classList.contains('canopy-panel-tab-drop-after')).toBe(
        false,
      );
      fireDrag(tabP3, 'drop', { clientX: 280, clientY: 10 });
      expect(onMovePanel).not.toHaveBeenCalled();
      expect(onReorderTab).toHaveBeenCalledTimes(1);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });
});
