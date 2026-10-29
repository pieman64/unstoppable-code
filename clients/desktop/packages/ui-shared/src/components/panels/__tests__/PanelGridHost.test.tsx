/** @jest-environment jsdom */
import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Direction, Grid, Sizing } from '../../../panels/grid';
import {
  createPanelLeafElement,
  PanelLeafView,
} from '../../../panels/grid-leaf-adapter';
import type {
  PanelContentProps,
  PanelGroupModel,
  PanelIntentCallbacks,
  PanelLayoutViewModel,
  PanelRootDropEdge,
  PanelTabModel,
} from '../../../panels/registry-types';
import type { PanelGridController } from '../grid-host-types';
import {
  clearPanelTabDrag,
  hasActivePanelTabDrag,
  startPanelTabDrag,
} from '../panel-dnd';
import { PanelGridHost } from '../PanelGridHost';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];

  readonly callback: ResizeObserverCallback;
  readonly targets: Element[] = [];

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverStub.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.push(target);
  }

  unobserve(): void {
    // noop
  }

  disconnect(): void {
    // noop
  }

  trigger(width: number, height: number): void {
    const entry = {
      contentRect: { width, height },
    } as unknown as ResizeObserverEntry;
    this.callback([entry], this as unknown as ResizeObserver);
  }
}

(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
  ResizeObserverStub;

function render(node: JSX.Element): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

function layoutAll(width: number, height: number): void {
  act(() => {
    for (const instance of ResizeObserverStub.instances) {
      if (instance.targets.length > 0) {
        instance.trigger(width, height);
      }
    }
  });
}

interface GridHarness {
  grid: Grid<PanelLeafView>;
  leaves: Map<string, PanelLeafView>;
  addLeaf(id: string, referenceId: string): PanelLeafView;
  controller(revision?: number): PanelGridController;
  dispose(): void;
}

function createGridHarness(ids: readonly string[]): GridHarness {
  const leaves = new Map<string, PanelLeafView>();

  const makeLeaf = (id: string): PanelLeafView => {
    const leaf = new PanelLeafView({
      id,
      element: createPanelLeafElement(document),
    });
    leaves.set(id, leaf);
    return leaf;
  };

  const grid = new Grid<PanelLeafView>(makeLeaf(ids[0]));
  grid.layout(800, 600);

  for (let index = 1; index < ids.length; index++) {
    const reference = leaves.get(ids[index - 1]);

    if (!reference) {
      throw new Error('missing reference leaf');
    }

    grid.addView(
      makeLeaf(ids[index]),
      Sizing.Distribute,
      reference,
      Direction.Right,
    );
  }

  return {
    grid,
    leaves,
    addLeaf(id: string, referenceId: string): PanelLeafView {
      const reference = leaves.get(referenceId);

      if (!reference) {
        throw new Error(`unknown reference leaf: ${referenceId}`);
      }

      const leaf = makeLeaf(id);
      grid.addView(leaf, Sizing.Distribute, reference, Direction.Right);
      return leaf;
    },
    controller(revision = 0): PanelGridController {
      return {
        grid,
        revision,
        getLeafElement: (groupId: string): HTMLElement | null =>
          leaves.get(groupId)?.element ?? null,
      };
    },
    dispose(): void {
      grid.dispose();
      leaves.forEach((leaf) => {
        leaf.dispose();
      });
    },
  };
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
  onMovePanelToRootEdge: jest.Mock;
  onPopOutGroup: jest.Mock;
}

function createCallbacks(options?: {
  withRootEdgeDrops?: boolean;
  canDropPanelAtRootEdge?: (
    panelId: string,
    edge: PanelRootDropEdge,
  ) => boolean;
}): TestCallbacks {
  const onSelectTab = jest.fn();
  const onCloseTab = jest.fn();
  const onCloseGroup = jest.fn();
  const onSplitGroup = jest.fn();
  const onMaximizeGroup = jest.fn();
  const onFocusGroup = jest.fn();
  const onMovePanel = jest.fn();
  const onMovePanelToRootEdge = jest.fn();
  const onPopOutGroup = jest.fn();
  return {
    callbacks: {
      onSelectTab,
      onCloseTab,
      onCloseGroup,
      onSplitGroup,
      onMaximizeGroup,
      onFocusGroup,
      onMovePanel,
      ...(options?.withRootEdgeDrops === false
        ? {}
        : { onMovePanelToRootEdge }),
      ...(options?.canDropPanelAtRootEdge
        ? { canDropPanelAtRootEdge: options.canDropPanelAtRootEdge }
        : {}),
      onPopOutGroup,
    },
    onSelectTab,
    onCloseTab,
    onCloseGroup,
    onSplitGroup,
    onMaximizeGroup,
    onFocusGroup,
    onMovePanel,
    onMovePanelToRootEdge,
    onPopOutGroup,
  };
}

/**
 * Dispatches a synthetic drag event. jsdom does not implement the DragEvent
 * constructor, so feature-detect and fall back to MouseEvent (the root-edge
 * wiring never reads `dataTransfer`), matching the panel-dnd test approach.
 */
function fireDrag(target: Element, type: string): void {
  const Ctor = typeof DragEvent === 'function' ? DragEvent : MouseEvent;
  act(() => {
    target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true }));
  });
}

function tab(panelId: string, kind = 'chat'): PanelTabModel {
  return { panelId, kind, title: panelId.toUpperCase() };
}

function groupModel(
  groupId: string,
  tabs: readonly PanelTabModel[],
  activePanelId: string | null,
): PanelGroupModel {
  return { groupId, tabs, activePanelId };
}

function layoutModel(
  groups: readonly PanelGroupModel[],
  activeGroupId: string | null,
  maximizedGroupId: string | null = null,
): PanelLayoutViewModel {
  return { groups, activeGroupId, maximizedGroupId };
}

function renderPanelContent(props: PanelContentProps): ReactNode {
  return (
    <div
      data-testid={`content-${props.panelId}`}
      data-content-kind={props.kind}
      data-content-active={String(props.isActive)}
      data-content-visible={String(props.isVisible)}
    />
  );
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

describe('PanelGridHost', () => {
  afterEach(() => {
    clearPanelTabDrag();
    document.body.innerHTML = '';
    ResizeObserverStub.instances.length = 0;
    jest.restoreAllMocks();
  });

  it('forwards tab intent through the group to its real tab header', () => {
    const harness = createGridHarness(['group-a']);
    const { callbacks } = createCallbacks();
    const target = tab('p2');
    const onTabIntent = jest.fn();
    const { container, root } = render(
      <PanelGridHost
        layout={layoutModel(
          [groupModel('group-a', [tab('p1'), target], 'p1')],
          'group-a',
        )}
        gridController={harness.controller()}
        callbacks={callbacks}
        renderPanelContent={renderPanelContent}
        onTabIntent={onTabIntent}
      />,
    );
    try {
      layoutAll(800, 600);
      const header = getByTestId(container, 'panel-tab-p2');
      act(() => {
        header.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
        header.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
        header.focus();
        header.blur();
      });
      expect(onTabIntent.mock.calls).toEqual([
        ['group-a', target, 'start', 'pointer'],
        ['group-a', target, 'end', 'pointer'],
        ['group-a', target, 'start', 'focus'],
        ['group-a', target, 'end', 'focus'],
      ]);
    } finally {
      act(() => root.unmount());
      harness.dispose();
    }
  });

  it('attaches the grid and renders group content into the right leaf elements', () => {
    const harness = createGridHarness(['group-a', 'group-b']);
    const { callbacks } = createCallbacks();
    const layout = layoutModel(
      [
        groupModel('group-a', [tab('p1'), tab('p2', 'files')], 'p1'),
        groupModel('group-b', [tab('p3', 'terminal')], 'p3'),
      ],
      'group-a',
    );

    const { container, root } = render(
      <PanelGridHost
        layout={layout}
        gridController={harness.controller()}
        callbacks={callbacks}
        renderPanelContent={renderPanelContent}
      />,
    );

    try {
      layoutAll(800, 600);

      const gridRoot = getByTestId(container, 'panel-grid-root');
      expect(gridRoot.getAttribute('data-window')).toBe('main');
      expect(gridRoot.contains(harness.grid.element)).toBe(true);

      // Each group renders inside its own leaf element.
      const leafA = harness.leaves.get('group-a');
      const leafB = harness.leaves.get('group-b');

      if (!leafA || !leafB) {
        throw new Error('Expected leaves');
      }

      const groupA = getByTestId(leafA.element, 'panel-group-group-a');
      const groupB = getByTestId(leafB.element, 'panel-group-group-b');
      expect(groupA.getAttribute('data-group-id')).toBe('group-a');
      expect(groupA.getAttribute('data-active')).toBe('true');
      expect(groupB.getAttribute('data-active')).toBe('false');
      expect(leafA.element.contains(getByTestId(container, 'content-p1'))).toBe(
        true,
      );
      expect(leafB.element.contains(getByTestId(container, 'content-p3'))).toBe(
        true,
      );

      // Contract testids + data attributes.
      getByTestId(container, 'panel-group-title-group-a');
      getByTestId(container, 'panel-group-body-group-a');
      getByTestId(container, 'panel-tab-close-p1');
      // Split / pop-out / maximize / close now live inside the overflow ("…")
      // menu (only restore, while maximized, is a direct button).
      getByTestId(container, 'panel-group-menu-group-a');

      const tabP1 = getByTestId(container, 'panel-tab-p1');
      expect(tabP1.getAttribute('data-panel-kind')).toBe('chat');
      expect(tabP1.getAttribute('data-active')).toBe('true');
      expect(tabP1.getAttribute('data-group-id')).toBe('group-a');

      const tabP2 = getByTestId(container, 'panel-tab-p2');
      expect(tabP2.getAttribute('data-panel-kind')).toBe('files');
      expect(tabP2.getAttribute('data-active')).toBe('false');

      // Non-active tab content is mounted but hidden.
      const contentP2 = getByTestId(container, 'content-p2');
      expect(contentP2.parentElement?.hasAttribute('hidden')).toBe(true);

      // Active-tab-of-active-group is active; group-b's active tab is
      // visible but not active.
      expect(
        getByTestId(container, 'content-p1').getAttribute(
          'data-content-active',
        ),
      ).toBe('true');
      const contentP3 = getByTestId(container, 'content-p3');
      expect(contentP3.getAttribute('data-content-active')).toBe('false');
      expect(contentP3.getAttribute('data-content-visible')).toBe('true');
    } finally {
      act(() => {
        root.unmount();
      });
      harness.dispose();
    }
  });

  it('keeps content DOM identity across tab switch, topology change, and maximize flip', () => {
    const harness = createGridHarness(['group-a', 'group-b']);
    const { callbacks } = createCallbacks();

    const makeElement = (
      layout: PanelLayoutViewModel,
      revision: number,
    ): JSX.Element => (
      <PanelGridHost
        layout={layout}
        gridController={harness.controller(revision)}
        callbacks={callbacks}
        renderPanelContent={renderPanelContent}
      />
    );

    const initialLayout = layoutModel(
      [
        groupModel('group-a', [tab('p1'), tab('p2')], 'p1'),
        groupModel('group-b', [tab('p3')], 'p3'),
      ],
      'group-a',
    );
    const { container, root } = render(makeElement(initialLayout, 0));

    try {
      layoutAll(800, 600);

      const contentP1 = getByTestId(container, 'content-p1');
      const contentP3 = getByTestId(container, 'content-p3');

      // (a) Tab switch: p2 becomes active; p1 stays mounted, same node.
      act(() => {
        root.render(
          makeElement(
            layoutModel(
              [
                groupModel('group-a', [tab('p1'), tab('p2')], 'p2'),
                groupModel('group-b', [tab('p3')], 'p3'),
              ],
              'group-a',
            ),
            0,
          ),
        );
      });
      expect(getByTestId(container, 'content-p1')).toBe(contentP1);
      expect(contentP1.parentElement?.hasAttribute('hidden')).toBe(true);
      expect(
        getByTestId(container, 'content-p2').parentElement?.hasAttribute(
          'hidden',
        ),
      ).toBe(false);

      // (b) Topology change: add a third leaf + group, bump revision.
      act(() => {
        harness.addLeaf('group-c', 'group-b');
      });
      act(() => {
        root.render(
          makeElement(
            layoutModel(
              [
                groupModel('group-a', [tab('p1'), tab('p2')], 'p2'),
                groupModel('group-b', [tab('p3')], 'p3'),
                groupModel('group-c', [tab('p4')], 'p4'),
              ],
              'group-a',
            ),
            1,
          ),
        );
      });
      const leafC = harness.leaves.get('group-c');

      if (!leafC) {
        throw new Error('Expected leaf c');
      }

      expect(leafC.element.contains(getByTestId(container, 'content-p4'))).toBe(
        true,
      );
      expect(getByTestId(container, 'content-p1')).toBe(contentP1);
      expect(getByTestId(container, 'content-p3')).toBe(contentP3);

      // (c) Maximize flip: group-a maximized hides other groups' content
      // (isVisible=false) without remounting anything.
      act(() => {
        root.render(
          makeElement(
            layoutModel(
              [
                groupModel('group-a', [tab('p1'), tab('p2')], 'p2'),
                groupModel('group-b', [tab('p3')], 'p3'),
                groupModel('group-c', [tab('p4')], 'p4'),
              ],
              'group-a',
              'group-a',
            ),
            1,
          ),
        );
      });
      expect(getByTestId(container, 'content-p1')).toBe(contentP1);
      expect(getByTestId(container, 'content-p3')).toBe(contentP3);
      expect(
        getByTestId(container, 'content-p2').getAttribute(
          'data-content-visible',
        ),
      ).toBe('true');
      expect(contentP3.getAttribute('data-content-visible')).toBe('false');
      // A maximized group shows the direct restore button (Full screen moves
      // out of the overflow menu while maximized).
      getByTestId(container, 'panel-group-restore-group-a');
    } finally {
      act(() => {
        root.unmount();
      });
      harness.dispose();
    }
  });

  it('does not relayout an unchanged grid during unrelated host renders', () => {
    const harness = createGridHarness(['group-a']);
    const { callbacks } = createCallbacks();
    const onLayoutGrid = jest.fn();
    const layout = layoutModel(
      [groupModel('group-a', [tab('p1')], 'p1')],
      'group-a',
    );
    const makeElement = (className: string): JSX.Element => (
      <PanelGridHost
        layout={layout}
        gridController={harness.controller(0)}
        callbacks={callbacks}
        renderPanelContent={renderPanelContent}
        className={className}
        onLayoutGrid={onLayoutGrid}
      />
    );
    const { root } = render(makeElement('initial-class'));

    try {
      layoutAll(800, 600);
      expect(onLayoutGrid).toHaveBeenCalledWith(800, 600);
      const callsAfterLayout = onLayoutGrid.mock.calls.length;

      act(() => {
        root.render(makeElement('unrelated-class-change'));
      });

      expect(onLayoutGrid).toHaveBeenCalledTimes(callsAfterLayout);
    } finally {
      act(() => {
        root.unmount();
      });
      harness.dispose();
    }
  });

  it('waits for ResizeObserver sizing instead of forcing layout during grid attachment', () => {
    const harness = createGridHarness(['group-a']);
    const { callbacks } = createCallbacks();
    const onLayoutGrid = jest.fn();
    const clientWidth = jest
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(800);
    const clientHeight = jest
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockReturnValue(600);
    const layout = layoutModel(
      [groupModel('group-a', [tab('p1')], 'p1')],
      'group-a',
    );
    const { container, root } = render(
      <PanelGridHost
        layout={layout}
        gridController={harness.controller()}
        callbacks={callbacks}
        renderPanelContent={renderPanelContent}
        onLayoutGrid={onLayoutGrid}
      />,
    );

    try {
      const gridRoot = getByTestId(container, 'panel-grid-root');

      expect(onLayoutGrid).not.toHaveBeenCalled();
      expect(clientWidth.mock.instances).not.toContain(gridRoot);
      expect(clientHeight.mock.instances).not.toContain(gridRoot);

      layoutAll(800, 600);
      expect(onLayoutGrid).toHaveBeenCalledTimes(1);
      expect(onLayoutGrid).toHaveBeenCalledWith(800, 600);
    } finally {
      act(() => {
        root.unmount();
      });
      harness.dispose();
    }
  });

  it('sizes synchronously when ResizeObserver is unavailable', () => {
    const harness = createGridHarness(['group-a']);
    const { callbacks } = createCallbacks();
    const onLayoutGrid = jest.fn();
    const originalResizeObserver = window.ResizeObserver;
    const clientWidth = jest
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(800);
    const clientHeight = jest
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockReturnValue(600);
    const layout = layoutModel(
      [groupModel('group-a', [tab('p1')], 'p1')],
      'group-a',
    );
    Reflect.deleteProperty(window, 'ResizeObserver');

    let rendered: ReturnType<typeof render> | undefined;
    try {
      rendered = render(
        <PanelGridHost
          layout={layout}
          gridController={harness.controller()}
          callbacks={callbacks}
          renderPanelContent={renderPanelContent}
          onLayoutGrid={onLayoutGrid}
        />,
      );
      expect(onLayoutGrid).toHaveBeenCalledTimes(1);
      expect(onLayoutGrid).toHaveBeenCalledWith(800, 600);
      const gridRoot = getByTestId(rendered.container, 'panel-grid-root');
      expect(clientWidth.mock.instances).toContain(gridRoot);
      expect(clientHeight.mock.instances).toContain(gridRoot);
    } finally {
      window.ResizeObserver = originalResizeObserver;
      if (rendered) {
        act(() => {
          rendered?.root.unmount();
        });
      }
      harness.dispose();
    }
  });

  it('re-attaches when the grid identity changes (wholesale rebuild)', () => {
    const harnessA = createGridHarness(['group-a']);
    const harnessB = createGridHarness(['group-a']);
    const { callbacks } = createCallbacks();
    const layout = layoutModel(
      [groupModel('group-a', [tab('p1')], 'p1')],
      'group-a',
    );

    const { container, root } = render(
      <PanelGridHost
        layout={layout}
        gridController={harnessA.controller()}
        callbacks={callbacks}
        renderPanelContent={renderPanelContent}
        windowLabel="aux"
      />,
    );

    try {
      layoutAll(800, 600);

      const gridRoot = getByTestId(container, 'panel-grid-root');
      expect(gridRoot.getAttribute('data-window')).toBe('aux');
      expect(gridRoot.contains(harnessA.grid.element)).toBe(true);

      act(() => {
        root.render(
          <PanelGridHost
            layout={layout}
            gridController={harnessB.controller()}
            callbacks={callbacks}
            renderPanelContent={renderPanelContent}
            windowLabel="aux"
          />,
        );
      });

      expect(gridRoot.contains(harnessA.grid.element)).toBe(false);
      expect(gridRoot.contains(harnessB.grid.element)).toBe(true);

      const leafInB = harnessB.leaves.get('group-a');

      if (!leafInB) {
        throw new Error('Expected rebuilt leaf');
      }

      expect(
        leafInB.element.contains(getByTestId(container, 'content-p1')),
      ).toBe(true);
    } finally {
      act(() => {
        root.unmount();
      });
      harnessA.dispose();
      harnessB.dispose();
    }
  });

  it('does not re-render panel content during engine relayouts or a grid sash drag (perf guard)', () => {
    const harness = createGridHarness(['group-a', 'group-b']);
    const { callbacks } = createCallbacks();
    const renderCount = jest.fn();

    function CountingContent(): JSX.Element {
      renderCount();
      return <div data-testid="counting-content" />;
    }

    const countingRenderPanelContent = (props: PanelContentProps): ReactNode =>
      props.panelId === 'p1' ? <CountingContent /> : renderPanelContent(props);

    const layout = layoutModel(
      [
        groupModel('group-a', [tab('p1')], 'p1'),
        groupModel('group-b', [tab('p3')], 'p3'),
      ],
      'group-a',
    );

    const { container, root } = render(
      <PanelGridHost
        layout={layout}
        gridController={harness.controller()}
        callbacks={callbacks}
        renderPanelContent={countingRenderPanelContent}
      />,
    );

    try {
      layoutAll(800, 600);
      getByTestId(container, 'counting-content');
      const callsAfterMount = renderCount.mock.calls.length;
      expect(callsAfterMount).toBeGreaterThan(0);

      // Host resizes drive grid.layout() imperatively — no React work.
      layoutAll(1000, 700);
      layoutAll(640, 480);

      // Dragging an engine sash between the two leaves is likewise pure
      // engine DOM mutation.
      const sash = harness.grid.element.querySelector('.canopy-sash');

      if (!(sash instanceof HTMLElement)) {
        throw new Error('Expected a grid sash element');
      }

      const pointerEvent = (
        type: string,
        pageX: number,
        pageY: number,
      ): MouseEvent => {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'pageX', { value: pageX });
        Object.defineProperty(event, 'pageY', { value: pageY });
        return event;
      };

      act(() => {
        sash.dispatchEvent(pointerEvent('pointerdown', 320, 100));
        window.dispatchEvent(pointerEvent('pointermove', 360, 100));
        window.dispatchEvent(pointerEvent('pointermove', 400, 100));
        window.dispatchEvent(pointerEvent('pointerup', 400, 100));
      });

      expect(renderCount.mock.calls.length).toBe(callsAfterMount);
    } finally {
      act(() => {
        root.unmount();
      });
      harness.dispose();
    }
  });

  it('fires onFocusGroup on capture-phase mousedown anywhere inside a group', () => {
    const harness = createGridHarness(['group-a', 'group-b']);
    const { callbacks, onFocusGroup } = createCallbacks();
    const layout = layoutModel(
      [
        groupModel('group-a', [tab('p1')], 'p1'),
        groupModel('group-b', [tab('p3')], 'p3'),
      ],
      'group-a',
    );

    const { container, root } = render(
      <PanelGridHost
        layout={layout}
        gridController={harness.controller()}
        callbacks={callbacks}
        renderPanelContent={renderPanelContent}
      />,
    );

    try {
      layoutAll(800, 600);

      act(() => {
        getByTestId(container, 'content-p3').dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true }),
        );
      });

      expect(onFocusGroup).toHaveBeenCalledWith('group-b');
    } finally {
      act(() => {
        root.unmount();
      });
      harness.dispose();
    }
  });

  it('arms root-edge drop zones only during a panel-tab drag and fires onMovePanelToRootEdge on drop', () => {
    const harness = createGridHarness(['group-a', 'group-b']);
    const { callbacks, onMovePanelToRootEdge } = createCallbacks();
    const layout = layoutModel(
      [
        groupModel('group-a', [tab('p1')], 'p1'),
        groupModel('group-b', [tab('p3')], 'p3'),
      ],
      'group-a',
    );

    const { container, root } = render(
      <PanelGridHost
        layout={layout}
        gridController={harness.controller()}
        callbacks={callbacks}
        renderPanelContent={renderPanelContent}
      />,
    );

    try {
      layoutAll(800, 600);
      const gridRoot = getByTestId(container, 'panel-grid-root');

      // Not armed: no strips in the DOM (pointer-transparent by absence).
      expect(queryByTestId(container, 'panel-drop-zone-root-right')).toBeNull();

      // A dragenter WITHOUT an in-process panel-tab drag must not arm.
      fireDrag(gridRoot, 'dragenter');
      expect(queryByTestId(container, 'panel-drop-zone-root-right')).toBeNull();
      fireDrag(gridRoot, 'dragend');

      // A dragenter DURING an active panel-tab drag arms all four strips.
      act(() => {
        startPanelTabDrag({ panelId: 'p3', sourceGroupId: 'group-b' });
      });
      fireDrag(gridRoot, 'dragenter');
      for (const edge of ['top', 'bottom', 'left', 'right']) {
        const zone = getByTestId(container, `panel-drop-zone-root-${edge}`);
        expect(zone.getAttribute('data-edge')).toBe(edge);
      }
      // No strip hovered yet: no root overlay.
      expect(queryByTestId(container, 'panel-drop-overlay-root')).toBeNull();

      // Hovering a strip (real drags always dragenter before dragover)
      // renders the full-edge highlight for that edge.
      const rightZone = getByTestId(container, 'panel-drop-zone-root-right');
      fireDrag(rightZone, 'dragenter');
      fireDrag(rightZone, 'dragover');
      const overlay = getByTestId(container, 'panel-drop-overlay-root');
      expect(overlay.getAttribute('data-edge')).toBe('right');
      expect(overlay.getAttribute('aria-hidden')).toBe('true');

      // Leaving the strip clears the highlight but stays armed (the host's
      // counter-based observer saw the strip's dragenter bubble up).
      fireDrag(rightZone, 'dragleave');
      expect(queryByTestId(container, 'panel-drop-overlay-root')).toBeNull();
      getByTestId(container, 'panel-drop-zone-root-right');

      // Dropping on a strip consumes the transfer, dispatches the intent,
      // and disarms.
      fireDrag(rightZone, 'dragenter');
      fireDrag(rightZone, 'dragover');
      fireDrag(rightZone, 'drop');
      expect(onMovePanelToRootEdge).toHaveBeenCalledTimes(1);
      expect(onMovePanelToRootEdge).toHaveBeenCalledWith('p3', 'right');
      expect(hasActivePanelTabDrag()).toBe(false);
      expect(queryByTestId(container, 'panel-drop-zone-root-right')).toBeNull();
      expect(queryByTestId(container, 'panel-drop-overlay-root')).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
      harness.dispose();
    }
  });

  it('disarms root-edge zones on dragend and renders none without the intent callback', () => {
    const harness = createGridHarness(['group-a', 'group-b']);
    const withRootEdge = createCallbacks();
    const layout = layoutModel(
      [
        groupModel('group-a', [tab('p1')], 'p1'),
        groupModel('group-b', [tab('p3')], 'p3'),
      ],
      'group-a',
    );

    const { container, root } = render(
      <PanelGridHost
        layout={layout}
        gridController={harness.controller()}
        callbacks={withRootEdge.callbacks}
        renderPanelContent={renderPanelContent}
      />,
    );

    try {
      layoutAll(800, 600);
      const gridRoot = getByTestId(container, 'panel-grid-root');

      // Aborted drag: dragend disarms without a drop.
      act(() => {
        startPanelTabDrag({ panelId: 'p1', sourceGroupId: 'group-a' });
      });
      fireDrag(gridRoot, 'dragenter');
      getByTestId(container, 'panel-drop-zone-root-left');
      fireDrag(gridRoot, 'dragend');
      expect(queryByTestId(container, 'panel-drop-zone-root-left')).toBeNull();
      act(() => {
        clearPanelTabDrag();
      });

      // Without onMovePanelToRootEdge the host renders no strips at all
      // (e.g. auxiliary-window layouts): display still works, zones absent.
      const withoutRootEdge = createCallbacks({ withRootEdgeDrops: false });
      act(() => {
        root.render(
          <PanelGridHost
            layout={layout}
            gridController={harness.controller()}
            callbacks={withoutRootEdge.callbacks}
            renderPanelContent={renderPanelContent}
          />,
        );
      });
      act(() => {
        startPanelTabDrag({ panelId: 'p1', sourceGroupId: 'group-a' });
      });
      fireDrag(gridRoot, 'dragenter');
      expect(queryByTestId(container, 'panel-drop-zone-root-left')).toBeNull();
      expect(queryByTestId(container, 'panel-drop-overlay-root')).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
      harness.dispose();
    }
  });

  it('suppresses root-edge strips for edges whose drop the layout owner reports as a no-op', () => {
    const harness = createGridHarness(['group-a', 'group-b']);
    const canDropPanelAtRootEdge = jest.fn(
      (_panelId: string, edge: PanelRootDropEdge): boolean => edge !== 'right',
    );
    const { callbacks, onMovePanelToRootEdge } = createCallbacks({
      canDropPanelAtRootEdge,
    });
    const layout = layoutModel(
      [
        groupModel('group-a', [tab('p1')], 'p1'),
        groupModel('group-b', [tab('p3')], 'p3'),
      ],
      'group-a',
    );

    const { container, root } = render(
      <PanelGridHost
        layout={layout}
        gridController={harness.controller()}
        callbacks={callbacks}
        renderPanelContent={renderPanelContent}
      />,
    );

    try {
      layoutAll(800, 600);
      const gridRoot = getByTestId(container, 'panel-grid-root');

      act(() => {
        startPanelTabDrag({ panelId: 'p3', sourceGroupId: 'group-b' });
      });
      fireDrag(gridRoot, 'dragenter');

      // The refused edge renders NO strip (its band falls through to the
      // group-body zones underneath); the other edges keep theirs.
      expect(queryByTestId(container, 'panel-drop-zone-root-right')).toBeNull();
      for (const edge of ['top', 'bottom', 'left']) {
        getByTestId(container, `panel-drop-zone-root-${edge}`);
      }
      expect(canDropPanelAtRootEdge).toHaveBeenCalledWith('p3', 'right');

      // An offered edge still accepts the drop end-to-end.
      const leftZone = getByTestId(container, 'panel-drop-zone-root-left');
      fireDrag(leftZone, 'dragenter');
      fireDrag(leftZone, 'dragover');
      fireDrag(leftZone, 'drop');
      expect(onMovePanelToRootEdge).toHaveBeenCalledTimes(1);
      expect(onMovePanelToRootEdge).toHaveBeenCalledWith('p3', 'left');
      expect(hasActivePanelTabDrag()).toBe(false);
    } finally {
      act(() => {
        root.unmount();
      });
      harness.dispose();
    }
  });

  it('dispatches a root-edge drop even when the drop event lands on the highlight overlay', () => {
    // Real pointer drops target the DEEPEST element under the cursor; the
    // root-edge intent is dispatched by the HOST observer (which sees every
    // bubbled drop) while a strip is hovered, so a drop landing on any
    // decorative layer above the strip — like the full-edge highlight
    // overlay — must still move the panel.
    const harness = createGridHarness(['group-a', 'group-b']);
    const { callbacks, onMovePanelToRootEdge } = createCallbacks();
    const layout = layoutModel(
      [
        groupModel('group-a', [tab('p1')], 'p1'),
        groupModel('group-b', [tab('p3')], 'p3'),
      ],
      'group-a',
    );

    const { container, root } = render(
      <PanelGridHost
        layout={layout}
        gridController={harness.controller()}
        callbacks={callbacks}
        renderPanelContent={renderPanelContent}
      />,
    );

    try {
      layoutAll(800, 600);
      const gridRoot = getByTestId(container, 'panel-grid-root');

      act(() => {
        startPanelTabDrag({ panelId: 'p3', sourceGroupId: 'group-b' });
      });
      fireDrag(gridRoot, 'dragenter');

      const rightZone = getByTestId(container, 'panel-drop-zone-root-right');
      fireDrag(rightZone, 'dragenter');
      fireDrag(rightZone, 'dragover');
      const overlay = getByTestId(container, 'panel-drop-overlay-root');

      // Drop dispatched on the OVERLAY (not the strip): still handled.
      fireDrag(overlay, 'drop');
      expect(onMovePanelToRootEdge).toHaveBeenCalledTimes(1);
      expect(onMovePanelToRootEdge).toHaveBeenCalledWith('p3', 'right');
      expect(hasActivePanelTabDrag()).toBe(false);
      expect(queryByTestId(container, 'panel-drop-zone-root-right')).toBeNull();
      expect(queryByTestId(container, 'panel-drop-overlay-root')).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
      harness.dispose();
    }
  });
});
