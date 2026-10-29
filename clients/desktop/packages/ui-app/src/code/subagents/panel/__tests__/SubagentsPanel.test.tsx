/** @jest-environment jsdom */
import { act, useEffect, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DiagramCanvasProps } from '@canopy/ui-rich/diagram';
import {
  SubagentsViewProvider,
  type SubagentNode,
  type SubagentTree,
} from '@canopy/ui-shared';
import { SubagentsPanel, type SubagentsPanelProps } from '../SubagentsPanel';
import type { SubagentCommandResult } from '../../types';
import {
  hydrateSubagentViewState,
  useSubagentViewStateStore,
  type SubagentViewStatePersistence,
  type SubagentViewStateSnapshot,
} from '../subagent-view-state-store';

let panelWidth = 800;
let canvasWidth = 1040;
const mountedRoots: Root[] = [];

class MemoryPersistence implements SubagentViewStatePersistence {
  public snapshot: SubagentViewStateSnapshot | null;

  public constructor(snapshot: SubagentViewStateSnapshot | null = null) {
    this.snapshot = snapshot;
  }

  public load(_scopeKey: string): Promise<SubagentViewStateSnapshot | null> {
    void _scopeKey;
    return Promise.resolve(this.snapshot);
  }

  public save(_scopeKey: string, snapshot: SubagentViewStateSnapshot): void {
    void _scopeKey;
    this.snapshot = snapshot;
  }
}

class ResizeObserverStub {
  public constructor(callback: ResizeObserverCallback) {
    void callback;
  }

  public observe(target: Element): void {
    void target;
  }

  public unobserve(target: Element): void {
    void target;
  }

  public disconnect(): void {}
}

Object.defineProperty(window, 'ResizeObserver', {
  configurable: true,
  value: ResizeObserverStub,
});
Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: (): DOMRect => DOMRect.fromRect({ width: panelWidth, height: 700 }),
});

function makeNode(
  id: string,
  parentId: string | null,
  depth: number,
  status: SubagentNode['status'] = 'running',
  childIds: readonly string[] = [],
): SubagentNode {
  return {
    id,
    kind: 'managed',
    parentId,
    depth,
    title: id,
    status,
    childIds,
    liveDescendantCount: 0,
    approvalPending: false,
    runs: [],
  };
}

function makeTree(
  nodes: readonly SubagentNode[],
  complete = true,
  rootId = 'root-chat',
): SubagentTree {
  return {
    root: { id: rootId, title: rootId === 'root-chat' ? 'Root chat' : rootId },
    nodes: new Map(nodes.map((node) => [node.id, node])),
    rootChildIds: nodes
      .filter((node) => node.parentId === null)
      .map((node) => node.id),
    complete,
  };
}

function FakeCanvas({
  nodes,
  edges,
  minZoom,
  onNodeClick,
  onNodeDoubleClick,
  onPaneClick,
  onViewportSize,
}: DiagramCanvasProps): JSX.Element {
  useEffect(() => {
    onViewportSize?.({ width: canvasWidth, height: 500 });
  }, [onViewportSize]);

  return (
    <div data-testid="fake-canvas" data-min-zoom={minZoom ?? 'default'}>
      {nodes.map((node) => (
        <button
          key={node.id}
          type="button"
          data-testid={node.testId}
          aria-label={node.ariaLabel}
          data-selected={node.selected}
          data-width={node.width}
          data-height={node.height}
          onClick={(): void => onNodeClick?.(node.id)}
          onDoubleClick={(): void => onNodeDoubleClick?.(node.id)}
        >
          {node.content}
        </button>
      ))}
      {edges.map((edge) => (
        <span
          key={edge.id}
          data-testid={`edge-${edge.id}`}
          data-dashed={edge.dashed ?? false}
          data-label={edge.label ?? ''}
        />
      ))}
      <button
        type="button"
        data-testid="fake-pane"
        onClick={(): void => onPaneClick?.()}
      />
    </div>
  );
}

function baseProps(
  tree: SubagentTree,
  overrides: Partial<SubagentsPanelProps> = {},
): SubagentsPanelProps {
  return {
    scopeKey: `test-${Math.random()}`,
    rootChats: [
      {
        id: 'root-chat',
        title: 'Root chat',
        total: tree.nodes.size,
        live: 1,
      },
    ],
    selectedRootId: 'root-chat',
    tree,
    capabilities: {
      stop: false,
      messaging: false,
      worktreeDetails: true,
      nativeInterrupt: false,
      openWorkflow: false,
      stopWorkflow: false,
    },
    now: 0,
    onSelectRoot: jest.fn(),
    onOpenChat: jest.fn(),
    onStop: jest.fn(() => Promise.resolve({ ok: true as const })),
    CanvasComponent: FakeCanvas,
    ...overrides,
  };
}

function workflowRun(
  id: string,
  title: string,
  status: SubagentNode['status'],
  childIds: readonly string[],
  runOrdinal: number,
): SubagentNode {
  return {
    ...makeNode(id, null, 1, status, childIds),
    kind: 'workflow-run',
    title,
    workflow: {
      runId: id,
      runName: title,
      runOrdinal,
      runCount: 3,
      phaseCount: 1,
      agentCount: 1,
    },
  };
}

function workflowPhase(
  id: string,
  run: SubagentNode,
  title: string,
  childIds: readonly string[],
): SubagentNode {
  return {
    ...makeNode(id, run.id, 2, run.status, childIds),
    kind: 'workflow-phase',
    title,
    workflow: {
      runId: run.workflow?.runId ?? run.id,
      runName: run.workflow?.runName ?? run.title,
      runOrdinal: run.workflow?.runOrdinal ?? 1,
      runCount: run.workflow?.runCount ?? 1,
      phaseCount: 1,
      phaseTitle: title,
      phaseIndex: 0,
      agentCount: childIds.length,
    },
  };
}

function workflowAgent(
  id: string,
  phase: SubagentNode,
  status: SubagentNode['status'],
  agentPosition: number,
): SubagentNode {
  return {
    ...makeNode(id, phase.id, 3, status),
    kind: 'workflow-agent',
    workflow: {
      runId: phase.workflow?.runId ?? phase.id,
      runName: phase.workflow?.runName ?? phase.title,
      runOrdinal: phase.workflow?.runOrdinal ?? 1,
      runCount: phase.workflow?.runCount ?? 1,
      phaseCount: phase.workflow?.phaseCount ?? 1,
      phaseTitle: phase.title,
      phaseIndex: phase.workflow?.phaseIndex ?? 0,
      agentPosition,
      agentCount: phase.workflow?.agentCount ?? 1,
    },
  };
}

function makeWorkflowTree(
  liveRunStatus: SubagentNode['status'] = 'running',
  rootId = 'root-chat',
): SubagentTree {
  const finishedRun = workflowRun(
    'run-finished',
    'Finished workflow',
    'completed',
    ['phase-finished'],
    1,
  );
  const finishedPhase = workflowPhase('phase-finished', finishedRun, 'Build', [
    'agent-failed',
  ]);
  const failedAgent = workflowAgent('agent-failed', finishedPhase, 'failed', 1);
  const secondFinishedRun = workflowRun(
    'run-finished-two',
    'Another workflow',
    'completed',
    ['phase-finished-two'],
    2,
  );
  const secondFinishedPhase = workflowPhase(
    'phase-finished-two',
    secondFinishedRun,
    'Test',
    ['agent-finished'],
  );
  const finishedAgent = workflowAgent(
    'agent-finished',
    secondFinishedPhase,
    'completed',
    1,
  );
  const runningRun = workflowRun(
    'run-live',
    'Live workflow',
    liveRunStatus,
    ['phase-live'],
    3,
  );
  const runningPhase = workflowPhase('phase-live', runningRun, 'Review', [
    'agent-live',
    'agent-live-failed',
  ]);
  const runningAgent = workflowAgent('agent-live', runningPhase, 'running', 1);
  const runningFailedAgent = workflowAgent(
    'agent-live-failed',
    runningPhase,
    'failed',
    2,
  );
  const managed = makeNode('managed-task', null, 1, 'completed');
  return makeTree(
    [
      finishedRun,
      finishedPhase,
      failedAgent,
      secondFinishedRun,
      secondFinishedPhase,
      finishedAgent,
      runningRun,
      runningPhase,
      runningAgent,
      runningFailedAgent,
      managed,
    ],
    true,
    rootId,
  );
}

interface MountedPanel {
  readonly container: HTMLElement;
  rerender(props: SubagentsPanelProps): void;
}

function mountPanelWithRerender(props: SubagentsPanelProps): MountedPanel {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  // These cover the Subagents view; SubagentsPanel.classic.test.tsx covers
  // the classic panel.
  act(() =>
    root.render(
      <SubagentsViewProvider value>
        <SubagentsPanel {...props} />
      </SubagentsViewProvider>,
    ),
  );
  return {
    container,
    rerender(nextProps): void {
      act(() =>
        root.render(
          <SubagentsViewProvider value>
            <SubagentsPanel {...nextProps} />
          </SubagentsViewProvider>,
        ),
      );
    },
  };
}

function mountPanel(props: SubagentsPanelProps): HTMLElement {
  return mountPanelWithRerender(props).container;
}

function clickTestId(testId: string): void {
  const target = document.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  if (!target) throw new Error(`Missing element: ${testId}`);
  act(() => target.click());
}

function doubleClickTestId(testId: string): void {
  const target = document.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  if (!target) throw new Error(`Missing element: ${testId}`);
  act(() => {
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
}

beforeEach(() => {
  panelWidth = 800;
  canvasWidth = 1040;
  useSubagentViewStateStore.setState({ scopes: {} });
});

afterEach(() => {
  for (const root of mountedRoots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe('SubagentsPanel', () => {
  it.each([759, 760])('uses a %spx detail surface threshold', (width) => {
    panelWidth = width;
    const task = makeNode('task', null, 1);
    const container = mountPanel(baseProps(makeTree([task])));

    clickTestId('subagents-tree-node-task');

    expect(
      container.querySelector('[data-testid="subagents-drawer"]') !== null,
    ).toBe(width < 760);
    expect(
      container.querySelector('[data-testid="subagents-inspector"]') !== null,
    ).toBe(width >= 760);
  });

  it('uses the inspector at 760px and the drawer at 759px', () => {
    const task = makeNode('task', null, 1);
    for (const width of [759, 760]) {
      panelWidth = width;
      const container = mountPanel(
        baseProps(makeTree([task]), { scopeKey: `threshold-${width}` }),
      );
      clickTestId('subagents-tree-node-task');

      if (width === 760) {
        expect(
          container.querySelector('[data-testid="subagents-inspector"]'),
        ).not.toBeNull();
        expect(
          container.querySelector('[data-testid="subagents-drawer"]'),
        ).toBeNull();
      } else {
        expect(
          container.querySelector('[data-testid="subagents-drawer"]'),
        ).not.toBeNull();
        expect(
          container.querySelector('[data-testid="subagents-inspector"]'),
        ).toBeNull();
      }
      for (const root of mountedRoots.splice(0)) act(() => root.unmount());
      document.body.replaceChildren();
    }
  });

  it('offers Show changes only for an isolated checkout that still exists', () => {
    const cases: ReadonlyArray<
      readonly [string, Partial<SubagentNode>, boolean]
    > = [
      ['shared', { workspace: 'shared' }, false],
      ['unknown', {}, false],
      ['isolated-pending', { workspace: 'isolated' }, false],
      [
        'isolated-discarded',
        {
          workspace: 'isolated',
          isolatedRevision: 'rev-1',
          workspaceDiscarded: true,
        },
        false,
      ],
      [
        'native',
        {
          kind: 'claude-native',
          workspace: 'isolated',
          isolatedRevision: 'rev-1',
        },
        false,
      ],
      ['isolated', { workspace: 'isolated', isolatedRevision: 'rev-1' }, true],
    ];
    for (const [id, fields, shown] of cases) {
      const task: SubagentNode = { ...makeNode(id, null, 1), ...fields };
      const onShowChanges = jest.fn();
      mountPanel(
        baseProps(makeTree([task]), {
          scopeKey: `show-changes-${id}`,
          onShowChanges,
        }),
      );
      clickTestId(`subagents-tree-node-${id}`);
      expect({
        id,
        shown:
          document.querySelector(
            '[data-testid="subagents-inspector-show-changes"]',
          ) !== null,
      }).toEqual({ id, shown });
      for (const root of mountedRoots.splice(0)) act(() => root.unmount());
      document.body.replaceChildren();
    }
  });

  it('dismisses the inspector or drawer with Close and Escape', () => {
    const task = makeNode('task', null, 1);
    for (const width of [759, 760]) {
      panelWidth = width;
      const container = mountPanel(
        baseProps(makeTree([task]), { scopeKey: `dismiss-${width}` }),
      );
      clickTestId('subagents-tree-node-task');
      expect(
        container.querySelector(
          `[data-testid="${width === 760 ? 'subagents-inspector' : 'subagents-drawer'}"]`,
        ),
      ).not.toBeNull();

      clickTestId('subagents-inspector-close');
      expect(
        container.querySelector('[data-testid="subagents-inspector"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="subagents-drawer"]'),
      ).toBeNull();

      clickTestId('subagents-tree-node-task');
      act(() => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
      expect(
        container.querySelector('[data-testid="subagents-inspector"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="subagents-drawer"]'),
      ).toBeNull();
      for (const root of mountedRoots.splice(0)) act(() => root.unmount());
      document.body.replaceChildren();
    }
  });

  it('keeps bare filter labels and the partial notice for an incomplete tree', () => {
    const task = makeNode('task', null, 1);
    const container = mountPanel(baseProps(makeTree([task], false)));

    expect(
      container.querySelector('[data-testid="subagents-partial-tree"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="subagents-filter"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="subagents-filter-all"]')
        ?.textContent,
    ).toBe('All');
    expect(
      container.querySelector('[data-testid="subagents-filter-active"]')
        ?.textContent,
    ).toBe('Active');
    expect(
      container.querySelector('[data-testid="subagents-filter-attention"]')
        ?.textContent,
    ).toBe('Needs attention');
    expect(
      container.querySelector('[data-testid="subagents-levels"]'),
    ).not.toBeNull();
  });

  it('keeps the root picker and hides controls for an empty selected tree', () => {
    const container = mountPanel(baseProps(makeTree([])));

    expect(
      container.querySelector('[data-testid="subagents-root-picker"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="subagents-empty"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="subagents-filter"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="subagents-levels"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="subagents-view"]'),
    ).toBeNull();
  });

  /** The grid cells one List row shows; the list has no header row. */
  function rowCellCount(container: Element, id: string): number {
    const row = container.querySelector(
      `[data-testid="subagents-list-row-${id}"]`,
    );
    return row?.querySelectorAll('[role="gridcell"]').length ?? -1;
  }

  it('uses the minimal list columns in a narrow panel so titles keep their width', () => {
    panelWidth = 330;
    const task = makeNode('task', null, 1);
    const panel = mountPanel(
      baseProps(makeTree([task]), { scopeKey: 'minimal-columns' }),
    );
    clickTestId('subagents-view-list');
    expect(panel.querySelector('[role="columnheader"]')).toBeNull();
    // Task and Time.
    expect(rowCellCount(panel, 'task')).toBe(2);
    expect(
      panel.querySelector('[data-testid="subagents-list-select-task"]'),
    ).not.toBeNull();
  });

  it('switches between full, no-workspace and compact list columns', () => {
    const task = makeNode('task', null, 1);
    const full = mountPanel(baseProps(makeTree([task])));
    clickTestId('subagents-view-list');
    expect(full.querySelector('[role="columnheader"]')).toBeNull();
    // Task, Status, Model, Workspace and Time; no listed task has changes.
    expect(rowCellCount(full, 'task')).toBe(5);
    clickTestId('subagents-list-select-task');
    // Task, Status and Time beside the details.
    expect(rowCellCount(full, 'task')).toBe(3);

    for (const root of mountedRoots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
    const noWorkspace = mountPanel(
      baseProps(makeTree([task]), {
        scopeKey: 'no-workspace-columns',
        showWorkspaceDetails: false,
      }),
    );
    clickTestId('subagents-view-list');
    // Task, Status, Model and Time.
    expect(rowCellCount(noWorkspace, 'task')).toBe(4);

    for (const root of mountedRoots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
    panelWidth = 700;
    const narrow = mountPanel(
      baseProps(makeTree([task]), { scopeKey: 'narrow-columns' }),
    );
    clickTestId('subagents-view-list');
    expect(rowCellCount(narrow, 'task')).toBe(3);
  });

  it('keeps skipped ancestors out of Active-filtered List rows and drops the Status column', () => {
    const hidden = {
      ...makeNode('hidden', null, 1, 'completed', ['visible']),
      title: 'Finished parent',
    };
    const visible = {
      ...makeNode('visible', 'hidden', 2, 'running'),
      title: 'Live child',
    };
    const container = mountPanel(baseProps(makeTree([hidden, visible])));

    clickTestId('subagents-view-list');
    const allCells = rowCellCount(container, 'visible');
    clickTestId('subagents-filter-active');

    const row = container.querySelector(
      '[data-testid="subagents-list-row-visible"]',
    );
    expect(row?.textContent).toContain('Live child');
    expect(row?.textContent).not.toContain('via Finished parent');
    // Every Active row is running, so the Status column goes.
    expect(rowCellCount(container, 'visible')).toBe(allCells - 1);

    clickTestId('subagents-filter-all');
    expect(rowCellCount(container, 'visible')).toBe(allCells);
  });

  it('stores a clicked depth stub as focus and supports Up and Show all', () => {
    const nodes: SubagentNode[] = [];
    for (let depth = 1; depth <= 5; depth += 1) {
      nodes.push(
        makeNode(
          `node-${depth}`,
          depth === 1 ? null : `node-${depth - 1}`,
          depth,
          'running',
          depth < 5 ? [`node-${depth + 1}`] : [],
        ),
      );
    }
    const props = baseProps(makeTree(nodes), { scopeKey: 'focus-tree' });
    const container = mountPanel(props);

    clickTestId('subagents-tree-stub-node-3');
    expect(
      useSubagentViewStateStore.getState().scopes['focus-tree']?.roots[
        'root-chat'
      ]?.focusId,
    ).toBe('node-3');
    expect(
      container.querySelector('[data-testid="subagents-focus-bar"]'),
    ).not.toBeNull();

    doubleClickTestId('subagents-tree-node-node-4');
    const up = container.querySelector<HTMLElement>(
      '[aria-label="Up to node-3"]',
    );
    expect(up).not.toBeNull();
    act(() => up?.click());
    expect(
      useSubagentViewStateStore.getState().scopes['focus-tree']?.roots[
        'root-chat'
      ]?.focusId,
    ).toBe('node-3');
    const showAll = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="subagents-focus-bar"] button',
      ),
    ).find((button) => button.textContent === 'Show all');
    expect(showAll).not.toBeUndefined();
    act(() => showAll?.click());
    expect(
      useSubagentViewStateStore.getState().scopes['focus-tree']?.roots[
        'root-chat'
      ]?.focusId,
    ).toBeNull();
  });

  it('keeps a saved focus while the tree is still loading', () => {
    const focusId = 'workflow-run:wf_late';
    useSubagentViewStateStore
      .getState()
      .setFocus('pending-focus', 'root-chat', focusId);
    mountPanel(
      baseProps(makeTree([makeNode('task', null, 1)]), {
        scopeKey: 'pending-focus',
        treeState: { status: 'loading' },
      }),
    );

    expect(
      useSubagentViewStateStore.getState().scopes['pending-focus']?.roots[
        'root-chat'
      ]?.focusId,
    ).toBe(focusId);
  });

  it('double-clicking a node with children focuses it and stores the root preference', () => {
    const parent = makeNode('parent', null, 1, 'running', ['child']);
    const child = makeNode('child', 'parent', 2);
    const container = mountPanel(
      baseProps(makeTree([parent, child]), { scopeKey: 'double-click-focus' }),
    );

    doubleClickTestId('subagents-tree-node-parent');

    expect(
      useSubagentViewStateStore.getState().scopes['double-click-focus']?.roots[
        'root-chat'
      ]?.focusId,
    ).toBe('parent');
    expect(
      container.querySelector('[data-testid="subagents-focus-bar"]')
        ?.textContent,
    ).toContain('parent');
  });

  it('remembers Levels and Focus per root chat through switching and a persisted remount', async () => {
    const rootA = makeTree(
      [
        makeNode('a-1', null, 1, 'running', ['a-2']),
        makeNode('a-2', 'a-1', 2, 'running', ['a-3']),
        makeNode('a-3', 'a-2', 3, 'running', ['a-4']),
        makeNode('a-4', 'a-3', 4, 'running', ['a-5']),
        makeNode('a-5', 'a-4', 5),
      ],
      true,
      'root-a',
    );
    const rootB = makeTree([makeNode('b-1', null, 1)], true, 'root-b');
    const roots = [
      { id: 'root-a', title: 'Root A', total: 5, live: 1 },
      { id: 'root-b', title: 'Root B', total: 1, live: 0 },
    ];
    const persistence = new MemoryPersistence();
    const rootAProps = baseProps(rootA, {
      scopeKey: 'root-preferences',
      rootChats: roots,
      selectedRootId: 'root-a',
      persistence,
    });
    const mounted = mountPanelWithRerender(rootAProps);
    await act(async () => {
      await hydrateSubagentViewState('root-preferences', persistence);
    });

    clickTestId('subagents-levels');
    clickTestId('subagents-levels-option-5');
    doubleClickTestId('subagents-tree-node-a-3');
    expect(
      useSubagentViewStateStore.getState().scopes['root-preferences']?.roots[
        'root-a'
      ],
    ).toEqual({ levels: 5, focusId: 'a-3' });

    mounted.rerender({
      ...rootAProps,
      selectedRootId: 'root-b',
      tree: rootB,
    });
    expect(
      mounted.container.querySelector('[data-testid="subagents-levels"]')
        ?.textContent,
    ).toContain('Auto · 3');
    expect(
      mounted.container.querySelector('[data-testid="subagents-focus-bar"]'),
    ).toBeNull();

    mounted.rerender({
      ...rootAProps,
      selectedRootId: 'root-a',
      tree: rootA,
    });
    expect(
      mounted.container.querySelector('[data-testid="subagents-levels"]')
        ?.textContent,
    ).toContain('5');
    expect(
      mounted.container.querySelector('[data-testid="subagents-focus-bar"]')
        ?.textContent,
    ).toContain('a-3');
    expect(persistence.snapshot?.roots['root-a']).toEqual({
      levels: 5,
      focusId: 'a-3',
    });

    for (const root of mountedRoots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
    useSubagentViewStateStore.setState({ scopes: {} });
    const fresh = mountPanel(rootAProps);
    await act(async () => {
      await hydrateSubagentViewState('root-preferences', persistence);
    });
    expect(
      fresh.querySelector('[data-testid="subagents-levels"]')?.textContent,
    ).toContain('5');
    expect(
      fresh.querySelector('[data-testid="subagents-focus-bar"]')?.textContent,
    ).toContain('a-3');
    expect(
      useSubagentViewStateStore.getState().scopes['root-preferences']?.roots[
        'root-a'
      ],
    ).toEqual({ levels: 5, focusId: 'a-3' });
  });

  it('opens a selected node chat and shows Focus only in Tree view', () => {
    const parent = makeNode('parent', null, 1, 'running', ['child']);
    const child = makeNode('child', 'parent', 2);
    const onOpenChat = jest.fn();
    const container = mountPanel(
      baseProps(makeTree([parent, child]), {
        scopeKey: 'inspector-actions',
        onOpenChat,
      }),
    );
    clickTestId('subagents-tree-node-parent');

    expect(
      container.querySelector('[data-testid="subagents-inspector-focus"]'),
    ).not.toBeNull();
    clickTestId('subagents-inspector-open-chat');
    expect(onOpenChat).toHaveBeenCalledWith(parent);

    clickTestId('subagents-view-list');
    clickTestId('subagents-list-select-parent');
    expect(
      container.querySelector('[data-testid="subagents-inspector-focus"]'),
    ).toBeNull();

    clickTestId('subagents-view-tree');
    clickTestId('subagents-tree-node-parent');
    const focus = container.querySelector<HTMLElement>(
      '[data-testid="subagents-inspector-focus"]',
    );
    expect(focus).not.toBeNull();
    act(() => focus?.click());
    expect(
      useSubagentViewStateStore.getState().scopes['inspector-actions']?.roots[
        'root-chat'
      ]?.focusId,
    ).toBe('parent');
  });

  it('applies Auto, All and numbered Levels choices', () => {
    const task = makeNode('task', null, 1);
    const container = mountPanel(
      baseProps(makeTree([task]), { scopeKey: 'levels-menu' }),
    );

    clickTestId('subagents-levels');
    expect(
      document.querySelector('[data-testid="subagents-levels-option-auto"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="subagents-levels-option-all"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="subagents-levels-option-3"]'),
    ).not.toBeNull();
    clickTestId('subagents-levels-option-4');
    expect(
      container.querySelector('[data-testid="subagents-levels"]')?.textContent,
    ).toContain('4');

    clickTestId('subagents-levels');
    clickTestId('subagents-levels-option-all');
    expect(
      container
        .querySelector('[data-testid="fake-canvas"]')
        ?.getAttribute('data-min-zoom'),
    ).toBe('0.05');

    clickTestId('subagents-levels');
    clickTestId('subagents-levels-option-auto');
    expect(
      container.querySelector('[data-testid="subagents-levels"]')?.textContent,
    ).toContain('Auto · 3');
  });

  it('gates Stop by capability and reports a refused Stop inline', async () => {
    const task = makeNode('task', null, 1);
    const onStop = jest.fn(() =>
      Promise.resolve({ ok: false as const, error: 'Not available' }),
    );
    const container = mountPanel(
      baseProps(makeTree([task]), {
        capabilities: {
          stop: true,
          messaging: false,
          worktreeDetails: true,
          nativeInterrupt: false,
          openWorkflow: false,
          stopWorkflow: false,
        },
        onStop,
      }),
    );
    clickTestId('subagents-tree-node-task');

    const stopButton = container.querySelector<HTMLElement>(
      '[data-testid="subagents-inspector-stop"]',
    );
    expect(stopButton).not.toBeNull();
    await act(async () => {
      stopButton?.click();
      await Promise.resolve();
    });
    expect(onStop).toHaveBeenCalledWith(task);
    expect(container.textContent).toContain("Couldn't stop the delegation.");
    expect(container.textContent).toContain('Not available');
  });

  it('omits Stop without capability and for native subagents', () => {
    const task = makeNode('task', null, 1);
    const withoutCapability = mountPanel(baseProps(makeTree([task])));
    clickTestId('subagents-tree-node-task');
    expect(
      withoutCapability.querySelector(
        '[data-testid="subagents-inspector-stop"]',
      ),
    ).toBeNull();

    for (const root of mountedRoots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
    const nativeTask: SubagentNode = { ...task, kind: 'claude-native' };
    const native = mountPanel(
      baseProps(makeTree([nativeTask]), {
        capabilities: {
          stop: true,
          messaging: false,
          worktreeDetails: true,
          nativeInterrupt: true,
          openWorkflow: false,
          stopWorkflow: false,
        },
      }),
    );
    clickTestId('subagents-tree-node-task');
    expect(
      native.querySelector('[data-testid="subagents-inspector-stop"]'),
    ).toBeNull();
  });

  it('orders live roots before finished roots and auto-selects the first', () => {
    const task = makeNode('task', null, 1);
    const onSelectRoot = jest.fn();
    mountPanel(
      baseProps(makeTree([task]), {
        selectedRootId: null,
        onSelectRoot,
        rootChats: [
          {
            id: 'finished',
            title: 'Finished',
            total: 2,
            live: 0,
            lastActivityAt: 300,
          },
          {
            id: 'live-old',
            title: 'Live old',
            total: 3,
            live: 1,
            lastActivityAt: 100,
          },
          {
            id: 'live-new',
            title: 'Live new',
            total: 1,
            live: 1,
            lastActivityAt: 200,
          },
        ],
      }),
    );

    expect(onSelectRoot).toHaveBeenCalledWith('live-new');
    clickTestId('subagents-root-picker');
    const optionIds = Array.from(
      document.querySelectorAll('[data-testid^="subagents-root-option-"]'),
    ).map((option) => option.getAttribute('data-testid'));
    expect(optionIds).toEqual([
      'subagents-root-option-live-new',
      'subagents-root-option-live-old',
      'subagents-root-option-finished',
    ]);

    // Chat titles are user-authored: session replay masks their text.
    expect(
      Array.from(
        document.querySelectorAll(
          '[data-testid^="subagents-root-option-"] .ph-mask',
        ),
      ).map((element) => element.textContent),
    ).toEqual(['Live new', 'Live old', 'Finished']);
  });

  it('masks the selected root chat title for session replay', () => {
    const container = mountPanel(
      baseProps(makeTree([makeNode('task', null, 1)])),
    );
    expect(
      Array.from(
        container.querySelectorAll(
          '[data-testid="subagents-root-picker"] .ph-mask',
        ),
      ).map((element) => element.textContent),
    ).toEqual(['Root chat']);
  });

  it('shows Auto Levels based on two canvas widths', () => {
    const task = makeNode('task', null, 1);
    const props = baseProps(makeTree([task]));
    const first = mountPanel(props);
    expect(
      first.querySelector('[data-testid="subagents-levels"]')?.textContent,
    ).toContain('Auto · 3');

    for (const root of mountedRoots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
    canvasWidth = 1440;
    const second = mountPanel({ ...props, scopeKey: 'wide-auto-levels' });
    const label =
      second.querySelector('[data-testid="subagents-levels"]')?.textContent ??
      '';
    expect(label).toMatch(/Auto · (?:[4-9]|10)/);
  });

  it('reports inspector node changes and clears to null', () => {
    const task = makeNode('reported-task', null, 1);
    const onSelectedNodeChange = jest.fn();
    const container = mountPanel(
      baseProps(makeTree([task]), { onSelectedNodeChange }),
    );

    expect(onSelectedNodeChange).toHaveBeenLastCalledWith(null);
    clickTestId('subagents-tree-node-reported-task');
    expect(onSelectedNodeChange).toHaveBeenLastCalledWith(task);

    clickTestId('subagents-inspector-close');
    expect(onSelectedNodeChange).toHaveBeenLastCalledWith(null);
    expect(
      container.querySelector('[data-testid="subagents-inspector"]'),
    ).toBeNull();
  });

  it('folds finished workflow runs on first sight and leaves running runs open', () => {
    const tree = makeWorkflowTree();
    const container = mountPanel(
      baseProps(tree, { scopeKey: 'workflow-default-folds' }),
    );

    expect(
      container.querySelector(
        '[data-testid="subagents-tree-node-run-finished"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="subagents-tree-stub-run-finished"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="subagents-tree-node-phase-finished"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="subagents-tree-node-agent-failed"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="subagents-tree-stub-run-finished-two"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="subagents-tree-node-phase-live"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="subagents-tree-node-agent-live"]'),
    ).not.toBeNull();
    expect(
      container
        .querySelector('[data-testid="subagents-tree-node-phase-live"]')
        ?.getAttribute('aria-label'),
    ).toBe('Review phase of Live workflow');
    expect(
      container
        .querySelector('[data-testid="subagents-tree-node-phase-live"]')
        ?.getAttribute('data-width'),
    ).toBe('176');
    expect(
      container
        .querySelector('[data-testid="subagents-tree-node-phase-live"]')
        ?.getAttribute('data-height'),
    ).toBe('44');
  });

  it('keeps a run open when it finishes after first appearing live', () => {
    const initialTree = makeWorkflowTree('running');
    const mounted = mountPanelWithRerender(
      baseProps(initialTree, { scopeKey: 'workflow-finish-while-open' }),
    );
    expect(
      mounted.container.querySelector(
        '[data-testid="subagents-tree-node-agent-live"]',
      ),
    ).not.toBeNull();

    mounted.rerender({
      ...baseProps(makeWorkflowTree('completed'), {
        scopeKey: 'workflow-finish-while-open',
      }),
    });

    expect(
      mounted.container.querySelector(
        '[data-testid="subagents-tree-node-phase-live"]',
      ),
    ).not.toBeNull();
    expect(
      mounted.container.querySelector(
        '[data-testid="subagents-tree-node-agent-live"]',
      ),
    ).not.toBeNull();
    expect(
      mounted.container.querySelector(
        '[data-testid="subagents-tree-stub-run-live"]',
      ),
    ).toBeNull();
  });

  it('uses the same run fold state in List and does not undo a user expansion', () => {
    const tree = makeWorkflowTree();
    const props = baseProps(tree, { scopeKey: 'workflow-list-folds' });
    const mounted = mountPanelWithRerender(props);

    clickTestId('subagents-view-list');
    expect(
      mounted.container.querySelector(
        '[data-testid="subagents-list-row-run-finished"]',
      ),
    ).not.toBeNull();
    expect(
      mounted.container.querySelector(
        '[data-testid="subagents-list-row-agent-failed"]',
      ),
    ).toBeNull();
    expect(
      mounted.container.querySelector(
        '[data-testid="subagents-list-row-agent-live"]',
      ),
    ).not.toBeNull();

    clickTestId('subagents-list-toggle-run-finished');
    expect(
      mounted.container.querySelector(
        '[data-testid="subagents-list-row-agent-failed"]',
      ),
    ).not.toBeNull();
    clickTestId('subagents-view-tree');
    mounted.rerender({ ...props, tree: makeWorkflowTree() });
    expect(
      mounted.container.querySelector(
        '[data-testid="subagents-tree-node-agent-failed"]',
      ),
    ).not.toBeNull();
  });

  it('shows filtered descendants even when their workflow run is folded', () => {
    const container = mountPanel(
      baseProps(makeWorkflowTree(), { scopeKey: 'workflow-folded-filters' }),
    );

    expect(
      container.querySelector(
        '[data-testid="subagents-tree-stub-run-finished"]',
      ),
    ).not.toBeNull();
    clickTestId('subagents-view-list');
    clickTestId('subagents-list-toggle-run-live');
    expect(
      container.querySelector('[data-testid="subagents-list-row-agent-live"]'),
    ).toBeNull();
    clickTestId('subagents-view-tree');
    expect(
      container.querySelector('[data-testid="subagents-tree-stub-run-live"]'),
    ).not.toBeNull();
    clickTestId('subagents-filter-attention');
    expect(
      container.querySelector(
        '[data-testid="subagents-tree-node-agent-failed"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="subagents-tree-node-agent-live-failed"]',
      ),
    ).not.toBeNull();
    clickTestId('subagents-filter-active');
    expect(
      container.querySelector('[data-testid="subagents-tree-node-agent-live"]'),
    ).not.toBeNull();
  });

  it('does not select a phase, and clicking a folded run stub focuses its run', () => {
    const tree = makeWorkflowTree();
    const container = mountPanel(
      baseProps(tree, { scopeKey: 'workflow-phase-stub-clicks' }),
    );

    clickTestId('subagents-tree-node-phase-live');
    expect(
      container.querySelector('[data-testid="subagents-inspector"]'),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-testid="subagents-tree-node-phase-live"]')
        ?.getAttribute('data-selected'),
    ).toBe('false');

    clickTestId('subagents-tree-stub-run-finished');
    expect(
      useSubagentViewStateStore.getState().scopes['workflow-phase-stub-clicks']
        ?.roots['root-chat']?.focusId,
    ).toBe('run-finished');
  });

  it('selects workflow runs and gates Open workflow in the inspector and list', () => {
    const tree = makeWorkflowTree();
    const cases: readonly {
      readonly openWorkflow: boolean;
      readonly includeCallback: boolean;
      readonly shown: boolean;
    }[] = [
      { openWorkflow: false, includeCallback: true, shown: false },
      { openWorkflow: true, includeCallback: false, shown: false },
      { openWorkflow: true, includeCallback: true, shown: true },
    ];

    for (let index = 0; index < cases.length; index += 1) {
      const testCase = cases[index];
      if (!testCase) continue;
      const openedRuns: SubagentNode[] = [];
      const onOpenWorkflow = (run: SubagentNode): void => {
        openedRuns.push(run);
      };
      const container = mountPanel(
        baseProps(tree, {
          scopeKey: `workflow-open-gating-${index}`,
          capabilities: {
            stop: false,
            messaging: false,
            worktreeDetails: true,
            nativeInterrupt: false,
            openWorkflow: testCase.openWorkflow,
            stopWorkflow: false,
          },
          onOpenWorkflow: testCase.includeCallback ? onOpenWorkflow : undefined,
        }),
      );
      clickTestId('subagents-tree-node-run-finished');

      expect(
        container.querySelector('[data-testid="subagents-inspector"]'),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '[data-testid="subagents-inspector-open-workflow"]',
        ) !== null,
      ).toBe(testCase.shown);
      expect(
        container
          .querySelector('[data-testid="subagents-tree-node-run-finished"]')
          ?.getAttribute('data-selected'),
      ).toBe('true');

      clickTestId('subagents-view-list');
      expect(
        container.querySelector(
          '[data-testid="subagents-list-open-run-finished"]',
        ) !== null,
      ).toBe(testCase.shown);
      if (testCase.shown) {
        clickTestId('subagents-inspector-open-workflow');
        expect(openedRuns).toEqual([tree.nodes.get('run-finished')]);
        clickTestId('subagents-list-open-run-finished');
        expect(openedRuns).toEqual([
          tree.nodes.get('run-finished'),
          tree.nodes.get('run-finished'),
        ]);
      }

      for (const root of mountedRoots.splice(0)) act(() => root.unmount());
      document.body.replaceChildren();
    }
  });

  it('gates workflow Stop by capability, callback and running status', async () => {
    const cases: readonly {
      readonly status: SubagentNode['status'];
      readonly stopWorkflow: boolean;
      readonly includeCallback: boolean;
      readonly shown: boolean;
    }[] = [
      {
        status: 'running',
        stopWorkflow: false,
        includeCallback: true,
        shown: false,
      },
      {
        status: 'running',
        stopWorkflow: true,
        includeCallback: false,
        shown: false,
      },
      {
        status: 'completed',
        stopWorkflow: true,
        includeCallback: true,
        shown: false,
      },
      {
        status: 'running',
        stopWorkflow: true,
        includeCallback: true,
        shown: true,
      },
    ];

    for (let index = 0; index < cases.length; index += 1) {
      const testCase = cases[index];
      if (!testCase) continue;
      const stoppedRuns: SubagentNode[] = [];
      const onStopWorkflow = (
        run: SubagentNode,
      ): Promise<SubagentCommandResult> => {
        stoppedRuns.push(run);
        return Promise.resolve({ ok: false, error: 'Workflow is locked' });
      };
      const caseTree = makeWorkflowTree(testCase.status);
      const container = mountPanel(
        baseProps(caseTree, {
          scopeKey: `workflow-stop-gating-${index}`,
          capabilities: {
            stop: false,
            messaging: false,
            worktreeDetails: true,
            nativeInterrupt: false,
            openWorkflow: false,
            stopWorkflow: testCase.stopWorkflow,
          },
          onStopWorkflow: testCase.includeCallback ? onStopWorkflow : undefined,
        }),
      );
      clickTestId('subagents-tree-node-run-live');
      const stopButton = container.querySelector<HTMLButtonElement>(
        '[data-testid="subagents-inspector-stop-workflow"]',
      );
      expect(stopButton !== null).toBe(testCase.shown);
      if (testCase.shown) {
        await act(async () => {
          stopButton?.click();
          await Promise.resolve();
        });
        expect(stoppedRuns).toEqual([caseTree.nodes.get('run-live')]);
        expect(container.textContent).toContain('Workflow is locked');
      }

      for (const root of mountedRoots.splice(0)) act(() => root.unmount());
      document.body.replaceChildren();
    }
  });

  it('disables workflow Stop while it is in flight', async () => {
    const tree = makeWorkflowTree();
    let resolveStop: (result: SubagentCommandResult) => void = (): void =>
      undefined;
    const onStopWorkflow = (): Promise<SubagentCommandResult> =>
      new Promise((resolve) => {
        resolveStop = resolve;
      });
    const container = mountPanel(
      baseProps(tree, {
        scopeKey: 'workflow-stop-pending',
        capabilities: {
          stop: false,
          messaging: false,
          worktreeDetails: true,
          nativeInterrupt: false,
          openWorkflow: false,
          stopWorkflow: true,
        },
        onStopWorkflow,
      }),
    );
    clickTestId('subagents-tree-node-run-live');
    const stopButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="subagents-inspector-stop-workflow"]',
    );
    expect(stopButton?.disabled).toBe(false);
    await act(async () => {
      stopButton?.click();
      await Promise.resolve();
    });
    expect(stopButton?.disabled).toBe(true);
    await act(async () => {
      resolveStop({ ok: true });
      await Promise.resolve();
    });
    expect(stopButton?.disabled).toBe(false);
  });

  it('guards chat opening to chat nodes while keeping workflow agents openable', () => {
    const tree = makeWorkflowTree();
    const openedChats: SubagentNode[] = [];
    const onOpenChat = (node: SubagentNode): void => {
      openedChats.push(node);
    };
    const container = mountPanel(
      baseProps(tree, {
        scopeKey: 'workflow-open-chat-guard',
        onOpenChat,
      }),
    );

    clickTestId('subagents-view-list');
    clickTestId('subagents-list-select-run-finished');
    expect(openedChats).toEqual([]);
    expect(
      container.querySelector('[data-testid="subagents-list-open-phase-live"]'),
    ).toBeNull();
    clickTestId('subagents-list-open-agent-live');
    expect(openedChats).toEqual([tree.nodes.get('agent-live')]);
    expect(openedChats.every((node) => node.kind === 'workflow-agent')).toBe(
      true,
    );
  });

  it('counts only chat nodes in filter totals and the root active fallback', () => {
    const tree = makeWorkflowTree();
    const container = mountPanel(
      baseProps(tree, { scopeKey: 'workflow-counts' }),
    );

    expect(
      container.querySelector('[data-testid="subagents-filter-all"]')
        ?.textContent,
    ).toBe('All 5');
    expect(
      container.querySelector('[data-testid="subagents-filter-active"]')
        ?.textContent,
    ).toBe('Active 1');
    expect(
      container.querySelector('[data-testid="subagents-filter-attention"]')
        ?.textContent,
    ).toBe('Needs attention 2');

    const noMatchingSummary = mountPanel(
      baseProps(tree, {
        scopeKey: 'workflow-count-fallback',
        rootChats: [
          { id: 'another-root', title: 'Another root', total: 1, live: 0 },
        ],
      }),
    );
    expect(
      noMatchingSummary.querySelector('[data-testid="subagents-tree-root"]')
        ?.textContent,
    ).toContain('1 active');
  });

  it('offers Stop all delegates for the live managed tasks, with a confirm step', async () => {
    const onStopAllDelegations = jest.fn(
      (): Promise<boolean> => Promise.resolve(true),
    );
    const tree = makeTree([
      makeNode('live-a', null, 1, 'running'),
      makeNode('live-b', null, 1, 'queued'),
      makeNode('done', null, 1, 'completed'),
    ]);
    mountPanel(
      baseProps(tree, {
        scopeKey: 'stop-all',
        onStopAllDelegations,
        capabilities: {
          stop: true,
          messaging: false,
          worktreeDetails: true,
          nativeInterrupt: false,
          openWorkflow: false,
          stopWorkflow: false,
        },
      }),
    );
    clickTestId('agent-activity-stop-all');
    expect(
      document.querySelector(
        '[data-testid="agent-activity-stop-all-confirmation"]',
      )?.textContent,
    ).toContain('2');
    await act(async () => {
      clickTestId('agent-activity-stop-all-confirm');
      await Promise.resolve();
    });
    expect(onStopAllDelegations).toHaveBeenCalledTimes(1);
  });

  it('puts the picker and red Stop all on the first toolbar row, filters then icon Tree/List on the second', () => {
    const tree = makeTree([makeNode('live', null, 1, 'running')]);
    const container = mountPanel(
      baseProps(tree, {
        scopeKey: 'one-toolbar-row',
        onStopAllDelegations: (): Promise<boolean> => Promise.resolve(true),
        capabilities: {
          stop: true,
          messaging: false,
          worktreeDetails: true,
          nativeInterrupt: false,
          openWorkflow: false,
          stopWorkflow: false,
        },
      }),
    );
    const headers = container.querySelectorAll(
      '[data-testid="subagents-panel"] > header',
    );
    expect(headers).toHaveLength(1);
    const toolbar = container.querySelector<HTMLElement>(
      '[data-testid="subagents-toolbar"]',
    );
    expect(toolbar).not.toBeNull();
    for (const testId of [
      'subagents-root-picker',
      'subagents-filter',
      'subagents-filter-all',
      'subagents-filter-active',
      'subagents-filter-attention',
      'subagents-levels',
      'subagents-view-tree',
      'subagents-view-list',
      'agent-activity-stop-all',
    ]) {
      expect(
        toolbar?.querySelector(`[data-testid="${testId}"]`),
      ).not.toBeNull();
    }
    // The filters use the same segmented control as Tree/List.
    const filter = toolbar?.querySelector('[data-testid="subagents-filter"]');
    expect(filter?.getAttribute('role')).toBe('group');
    expect(filter?.className).toBe(
      toolbar?.querySelector('[data-testid="subagents-view"]')?.className,
    );
    expect(
      toolbar
        ?.querySelector('[data-testid="subagents-filter-all"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    // Row 1: the picker on the left, Stop all at the right end.
    const [firstRow, secondRow] = Array.from(toolbar?.children ?? []);
    expect(toolbar?.children).toHaveLength(2);
    expect(
      firstRow?.querySelector('[data-testid="subagents-root-picker"]'),
    ).not.toBeNull();
    const stopAllCluster = firstRow
      ?.querySelector('[data-testid="agent-activity-stop-all"]')
      ?.closest('.ml-auto');
    expect(stopAllCluster?.parentElement).toBe(firstRow);
    // Row 2: the filters on the left; Levels (Tree only) and the view on
    // the right.
    expect(secondRow?.getAttribute('data-testid')).toBe(
      'subagents-toolbar-views',
    );
    expect(secondRow?.className).toContain('justify-between');
    const [leftGroup, rightGroup] = Array.from(secondRow?.children ?? []);
    expect(leftGroup?.getAttribute('data-testid')).toBe('subagents-filter');
    const rightOrder = Array.from(
      rightGroup?.querySelectorAll(
        '[data-testid="subagents-levels"], [data-testid="subagents-view"]',
      ) ?? [],
    ).map((element) => element.getAttribute('data-testid'));
    expect(rightOrder).toEqual(['subagents-levels', 'subagents-view']);
    // Counts read in tertiary ink after the label; the name stays `All 1`.
    const all = toolbar?.querySelector('[data-testid="subagents-filter-all"]');
    expect(all?.textContent).toBe('All 1');
    expect(all?.querySelector('.fg-tertiary')?.textContent).toBe(' 1');
    // Tree/List are icon-only segments named by their labels.
    for (const [testId, name] of [
      ['subagents-view-tree', 'Tree'],
      ['subagents-view-list', 'List'],
    ] as const) {
      const segment = toolbar?.querySelector(`[data-testid="${testId}"]`);
      expect(segment?.getAttribute('aria-label')).toBe(name);
      expect(segment?.textContent).toBe('');
      expect(segment?.querySelector('svg')).not.toBeNull();
      expect(segment?.querySelector('svg')?.getAttribute('width')).toBe('12px');
    }
    // Stop all rests as a quiet ghost in destructive ink, without a fill.
    const stopAll = toolbar?.querySelector<HTMLElement>(
      '[data-testid="agent-activity-stop-all"]',
    );
    const stopAllClasses = stopAll?.className.split(/\s+/) ?? [];
    expect(stopAllClasses).toContain('fg-destructive');
    expect(stopAllClasses).not.toContain('bg-destructive');
    expect(stopAll?.textContent).toBe('Stop all');
    expect(stopAll?.getAttribute('aria-label')).toBe('Stop all delegates');
  });

  it('drops an open Stop all confirmation when another chat is selected', () => {
    const tree = makeTree([makeNode('live', null, 1, 'running')]);
    const props = baseProps(tree, {
      scopeKey: 'stop-all-root-switch',
      rootChats: [
        { id: 'root-chat', title: 'Root chat', total: 1, live: 1 },
        { id: 'other-chat', title: 'Other chat', total: 1, live: 1 },
      ],
      onStopAllDelegations: (): Promise<boolean> => Promise.resolve(true),
      capabilities: {
        stop: true,
        messaging: false,
        worktreeDetails: true,
        nativeInterrupt: false,
        openWorkflow: false,
        stopWorkflow: false,
      },
    });
    const panel = mountPanelWithRerender(props);
    clickTestId('agent-activity-stop-all');
    expect(
      panel.container.querySelector(
        '[data-testid="agent-activity-stop-all-confirmation"]',
      ),
    ).not.toBeNull();

    // The confirm would now stop the other chat's delegates; it must ask again.
    panel.rerender({ ...props, selectedRootId: 'other-chat' });
    expect(
      panel.container.querySelector(
        '[data-testid="agent-activity-stop-all-confirmation"]',
      ),
    ).toBeNull();
    expect(
      panel.container.querySelector('[data-testid="agent-activity-stop-all"]'),
    ).not.toBeNull();
  });

  it('offers no Stop all when no managed task is live or the host cannot stop', () => {
    const settled = makeTree([makeNode('done', null, 1, 'completed')]);
    mountPanel(
      baseProps(settled, {
        scopeKey: 'stop-all-settled',
        onStopAllDelegations: (): Promise<boolean> => Promise.resolve(true),
        capabilities: {
          stop: true,
          messaging: false,
          worktreeDetails: true,
          nativeInterrupt: false,
          openWorkflow: false,
          stopWorkflow: false,
        },
      }),
    );
    expect(
      document.querySelector('[data-testid="agent-activity-stop-all"]'),
    ).toBeNull();
    mountPanel(
      baseProps(makeTree([makeNode('live', null, 1)]), {
        scopeKey: 'stop-all-no-host',
      }),
    );
    expect(
      document.querySelector('[data-testid="agent-activity-stop-all"]'),
    ).toBeNull();
  });
});
