/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  projectSubagentSkipEdges,
  type SubagentNode,
  type SubagentTree,
} from '@canopy/ui-shared';
import {
  SubagentsList,
  SubagentsListHeader,
  SubagentsListRow,
  type SubagentsListColumns,
} from '../SubagentsList';
import { subagentStatusInk } from '../../common/SubagentStatusGlyph';

/** A control's accessible name from the elements its aria-labelledby lists. */
function labelledName(control: Element | null | undefined): string {
  if (!control) return '';
  // Rendered roots here may be detached, so search from the topmost element.
  let root: Element = control;
  while (root.parentElement) root = root.parentElement;
  return (control.getAttribute('aria-labelledby') ?? '')
    .split(' ')
    .map((id) => root.querySelector(`[id="${id}"]`)?.textContent ?? '')
    .join(' ');
}

function makeNode(depth: number): SubagentNode {
  return {
    id: `node-${depth}`,
    kind: 'managed',
    parentId: depth > 1 ? `node-${depth - 1}` : null,
    depth,
    title: `Task ${depth}`,
    status: 'running',
    childIds: [],
    liveDescendantCount: 0,
    approvalPending: false,
    runs: [],
  };
}

describe('Subagents list display pieces', () => {
  it.each([
    ['full', true, 7, 'Workspace', 'Changes'],
    ['full', false, 6, 'Workspace', null],
    ['no-workspace', true, 5, null, null],
    ['compact', true, 4, null, null],
    ['minimal', true, 3, null, null],
  ] as const)(
    'renders the %s D9 column set (changes %s)',
    (
      columns: SubagentsListColumns,
      showChanges: boolean,
      count: number,
      workspace: string | null,
      changes: string | null,
    ) => {
      const markup = renderToStaticMarkup(
        <SubagentsListHeader columns={columns} showChanges={showChanges} />,
      );

      expect(markup.match(/role="columnheader"/g) ?? []).toHaveLength(count);
      if (workspace) expect(markup).toContain(workspace);
      else expect(markup).not.toContain('Workspace');
      if (changes) expect(markup).toContain(changes);
      else expect(markup).not.toContain('Changes');
    },
  );

  it('drops the Status column in the minimal set but keeps the status for assistive technology', () => {
    const header = renderToStaticMarkup(
      <SubagentsListHeader columns="minimal" showChanges={false} />,
    );
    expect(header).not.toContain('Status');

    const row = renderToStaticMarkup(
      <SubagentsListRow
        node={makeNode(2)}
        depth={2}
        absoluteDepth={2}
        hasChildren={false}
        selected={false}
        columns="minimal"
        showChanges={false}
        showWorkspaceDetails
        now={0}
        onSelect={(): void => undefined}
        onOpenChat={(): void => undefined}
      />,
    );
    expect(row.match(/role="gridcell"/g) ?? []).toHaveLength(2);
    expect(row).toContain('class="sr-only"');
    expect(row).toContain('Task 2');
    expect(row).toContain('h-9 shrink-0');
  });

  it.each([1, 2, 3, 4])('indents depth %i without a depth number', (depth) => {
    const markup = renderToStaticMarkup(
      <SubagentsListRow
        node={makeNode(depth)}
        depth={depth}
        absoluteDepth={depth}
        hasChildren={false}
        selected={false}
        columns="compact"
        showChanges={false}
        showWorkspaceDetails
        now={0}
        onSelect={(): void => undefined}
        onOpenChat={(): void => undefined}
      />,
    );

    expect(markup).toContain(`style="width:${depth * 16}px"`);
    expect(markup).not.toContain(`aria-label="Depth ${depth}"`);
  });

  it.each([5, 9])(
    'reports absolute depth %i after capped indentation',
    (depth) => {
      const markup = renderToStaticMarkup(
        <SubagentsListRow
          node={makeNode(depth)}
          depth={depth}
          absoluteDepth={depth}
          hasChildren={false}
          selected={false}
          columns="compact"
          showChanges={false}
          showWorkspaceDetails
          now={0}
          onSelect={(): void => undefined}
          onOpenChat={(): void => undefined}
        />,
      );

      expect(markup).toContain('style="width:64px"');
      expect(markup).toContain(`aria-label="Depth ${depth}"`);
      expect(markup).toContain(`>${depth}</span>`);
    },
  );

  it('shows the hidden-ancestor note after a matching row title', () => {
    const hidden: SubagentNode = {
      ...makeNode(1),
      id: 'hidden',
      title: 'Finished parent',
      status: 'completed',
      childIds: ['visible'],
    };
    const visible: SubagentNode = {
      ...makeNode(2),
      id: 'visible',
      title: 'Live child',
      parentId: 'hidden',
    };
    const tree: SubagentTree = {
      root: { id: 'root-chat', title: 'Root chat' },
      nodes: new Map([
        [hidden.id, hidden],
        [visible.id, visible],
      ]),
      rootChildIds: [hidden.id],
      complete: true,
    };
    const markup = renderToStaticMarkup(
      <SubagentsList
        tree={tree}
        projection={projectSubagentSkipEdges(tree, 'active')}
        selectedId={null}
        columns="full"
        showWorkspaceDetails
        now={0}
        onSelectNode={(): void => undefined}
        onOpenChat={(): void => undefined}
      />,
    );

    const titleIndex = markup.indexOf('Live child</span></button>');
    const viaIndex = markup.indexOf('via Finished parent');
    expect(markup).toContain('data-testid="subagents-list-row-visible"');
    expect(titleIndex).toBeGreaterThanOrEqual(0);
    expect(viaIndex).toBeGreaterThan(titleIndex);
  });

  function familyTree(): SubagentTree {
    const parent: SubagentNode = {
      ...makeNode(1),
      id: 'parent',
      title: 'Parent task',
      status: 'completed',
      childIds: ['child'],
    };
    const child: SubagentNode = {
      ...makeNode(2),
      id: 'child',
      title: 'Child task',
      parentId: 'parent',
    };
    return {
      root: { id: 'root-chat', title: 'Root chat' },
      nodes: new Map([
        [parent.id, parent],
        [child.id, child],
      ]),
      rootChildIds: [parent.id],
      complete: true,
    };
  }

  function workflowTree(
    runStatus: SubagentNode['status'] = 'running',
    secondAgentStatus: SubagentNode['status'] = 'running',
  ): SubagentTree {
    const run: SubagentNode = {
      ...makeNode(1),
      id: 'workflow-run-1',
      kind: 'workflow-run',
      title: 'Nightly review',
      status: runStatus,
      childIds: ['workflow-phase-1'],
      startedAt: 1_000,
      workflow: {
        runId: 'workflow-1',
        runName: 'Nightly review',
        runOrdinal: 1,
        runCount: 1,
        phaseCount: 2,
        agentCount: 2,
      },
    };
    const phase: SubagentNode = {
      ...makeNode(2),
      id: 'workflow-phase-1',
      kind: 'workflow-phase',
      parentId: run.id,
      title: 'Consistency',
      status: runStatus === 'running' ? 'running' : 'completed',
      childIds: ['workflow-agent-1', 'workflow-agent-2'],
      workflow: {
        runId: 'workflow-1',
        runName: 'Nightly review',
        runOrdinal: 1,
        runCount: 1,
        phaseCount: 2,
        phaseTitle: 'Consistency',
        phaseIndex: 1,
        agentCount: 2,
      },
    };
    const agents: readonly SubagentNode[] = [
      {
        ...makeNode(3),
        id: 'workflow-agent-1',
        kind: 'workflow-agent',
        parentId: phase.id,
        title: 'Check output',
        status: 'completed',
        workflow: {
          runId: 'workflow-1',
          runName: 'Nightly review',
          runOrdinal: 1,
          runCount: 1,
          phaseCount: 2,
          phaseTitle: 'Consistency',
          phaseIndex: 1,
          agentPosition: 1,
          agentCount: 2,
        },
      },
      {
        ...makeNode(4),
        id: 'workflow-agent-2',
        kind: 'workflow-agent',
        parentId: phase.id,
        title: 'Check consistency',
        status: secondAgentStatus,
        workflow: {
          runId: 'workflow-1',
          runName: 'Nightly review',
          runOrdinal: 1,
          runCount: 1,
          phaseCount: 2,
          phaseTitle: 'Consistency',
          phaseIndex: 1,
          agentPosition: 2,
          agentCount: 2,
        },
      },
    ];
    const nodes = new Map<string, SubagentNode>();
    nodes.set(run.id, run);
    nodes.set(phase.id, phase);
    for (const agent of agents) nodes.set(agent.id, agent);
    return {
      root: { id: 'root-chat', title: 'Root chat' },
      nodes,
      rootChildIds: [run.id],
      complete: true,
    };
  }

  it('lists subagents without a root chat row, starting flush left', () => {
    const markup = renderToStaticMarkup(
      <SubagentsList
        tree={familyTree()}
        selectedId={null}
        columns="full"
        showWorkspaceDetails
        now={0}
        onSelectNode={(): void => undefined}
        onOpenChat={(): void => undefined}
      />,
    );
    expect(markup).not.toContain('subagents-list-root');
    expect(markup).not.toContain('Root chat');
    const parentRow = markup.slice(
      markup.indexOf('data-testid="subagents-list-row-parent"'),
      markup.indexOf('data-testid="subagents-list-row-child"'),
    );
    // Top-level rows have no indent; their children indent one step.
    expect(parentRow).not.toContain('justify-end');
    expect(markup).toContain('style="width:16px"');
  });

  it('expands and collapses a parent with its toggle', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const onToggleCollapsed = jest.fn();
    const render = (collapsed: ReadonlySet<string>): void =>
      act((): void =>
        root.render(
          <SubagentsList
            tree={familyTree()}
            selectedId={null}
            columns="full"
            showWorkspaceDetails
            now={0}
            collapsedIds={collapsed}
            onToggleCollapsed={onToggleCollapsed}
            onSelectNode={(): void => undefined}
            onOpenChat={(): void => undefined}
          />,
        ),
      );
    try {
      render(new Set());
      const toggle = container.querySelector<HTMLButtonElement>(
        '[data-testid="subagents-list-toggle-parent"]',
      );
      if (!toggle) throw new Error('missing parent toggle');
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(labelledName(toggle)).toBe('Collapse Parent task');
      expect(
        container.querySelector('[data-testid="subagents-list-toggle-child"]'),
      ).toBeNull();
      act((): void => toggle.click());
      expect(onToggleCollapsed).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'parent' }),
      );

      render(new Set(['parent']));
      expect(
        container.querySelector('[data-testid="subagents-list-row-child"]'),
      ).toBeNull();
      const collapsedToggle = container.querySelector(
        '[data-testid="subagents-list-toggle-parent"]',
      );
      expect(collapsedToggle?.getAttribute('aria-expanded')).toBe('false');
      expect(labelledName(collapsedToggle)).toBe('Expand Parent task');
    } finally {
      act((): void => root.unmount());
    }
  });

  it('shows the Changes column only when a listed task has changes', () => {
    const list = (withChanges: boolean): string =>
      renderToStaticMarkup(
        <SubagentsList
          tree={familyTree()}
          selectedId={null}
          columns="full"
          showWorkspaceDetails
          changeTotals={(node) =>
            withChanges && node.id === 'child'
              ? { additions: 3, deletions: 1, filesChanged: 1 }
              : undefined
          }
          now={0}
          onSelectNode={(): void => undefined}
          onOpenChat={(): void => undefined}
        />,
      );
    expect(list(false)).not.toContain('Changes');
    expect(list(true)).toContain('Changes');
  });

  it('renders workflow run progress, short status, time, and an optional open action', () => {
    const tree = workflowTree();
    const run = tree.nodes.get('workflow-run-1');
    if (!run) throw new Error('missing workflow run');
    const container = document.createElement('div');
    const root = createRoot(container);
    const onSelectNode = jest.fn();
    const onOpenChat = jest.fn();
    const onOpenWorkflow = jest.fn();
    try {
      act((): void =>
        root.render(
          <SubagentsList
            tree={tree}
            selectedId={null}
            columns="full"
            showWorkspaceDetails
            now={61_000}
            onSelectNode={onSelectNode}
            onOpenChat={onOpenChat}
            onOpenWorkflow={onOpenWorkflow}
          />,
        ),
      );

      const runRow = container.querySelector<HTMLElement>(
        '[data-testid="subagents-list-row-workflow-run-1"]',
      );
      expect(runRow?.textContent).toContain('1 of 2 done · phase 2 of 2');
      expect(runRow?.textContent).toContain('Running');
      expect(runRow?.textContent).toContain('1m');
      const open = container.querySelector<HTMLButtonElement>(
        '[data-testid="subagents-list-open-workflow-run-1"]',
      );
      expect(labelledName(open)).toBe('Open workflow Nightly review');
      if (!open) throw new Error('missing workflow open action');
      act((): void => open.click());
      expect(onOpenWorkflow).toHaveBeenCalledWith(run);
      expect(onOpenChat).not.toHaveBeenCalled();

      const select = container.querySelector<HTMLButtonElement>(
        '[data-testid="subagents-list-select-workflow-run-1"]',
      );
      if (!select) throw new Error('missing workflow select action');
      act((): void => select.click());
      expect(onSelectNode).toHaveBeenCalledWith(run);

      const noWorkflowAction = renderToStaticMarkup(
        <SubagentsList
          tree={tree}
          selectedId={null}
          columns="full"
          showWorkspaceDetails
          now={61_000}
          onSelectNode={(): void => undefined}
          onOpenChat={(): void => undefined}
        />,
      );
      expect(noWorkflowAction).not.toContain(
        'data-testid="subagents-list-open-workflow-run-1"',
      );
    } finally {
      act((): void => root.unmount());
    }
  });

  it('keeps failed agents visible in a finished run row short status', () => {
    const tree = workflowTree('completed', 'failed');
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <SubagentsList
        tree={tree}
        selectedId={null}
        columns="full"
        showWorkspaceDetails
        now={61_000}
        onSelectNode={(): void => undefined}
        onOpenChat={(): void => undefined}
      />,
    );
    const runRow = container.querySelector(
      '[data-testid="subagents-list-row-workflow-run-1"]',
    );
    expect(runRow?.textContent).toContain('Done · 1 failed');
    const failed = Array.from(runRow?.querySelectorAll('span') ?? []).find(
      (element) =>
        element.textContent === '1 failed' &&
        element.className.includes(subagentStatusInk('failed')),
    );
    expect(failed?.className).toContain(subagentStatusInk('failed'));
  });

  it('renders phase groups without selection or open-chat actions', () => {
    const tree = workflowTree();
    const container = document.createElement('div');
    const root = createRoot(container);
    const onSelectNode = jest.fn();
    const onToggleCollapsed = jest.fn();
    const onOpenChat = jest.fn();
    try {
      act((): void =>
        root.render(
          <SubagentsList
            tree={tree}
            selectedId={null}
            columns="full"
            showWorkspaceDetails
            now={61_000}
            onToggleCollapsed={onToggleCollapsed}
            onSelectNode={onSelectNode}
            onOpenChat={onOpenChat}
          />,
        ),
      );

      const phaseRow = container.querySelector<HTMLElement>(
        '[data-testid="subagents-list-row-workflow-phase-1"]',
      );
      expect(phaseRow?.textContent).toContain('Consistency');
      expect(phaseRow?.textContent).toContain('1 of 2 done');
      expect(
        container.querySelector(
          '[data-testid="subagents-list-select-workflow-phase-1"]',
        ),
      ).toBeNull();
      expect(
        container.querySelector(
          '[data-testid="subagents-list-open-workflow-phase-1"]',
        ),
      ).toBeNull();
      if (!phaseRow) throw new Error('missing workflow phase row');
      act((): void => phaseRow.click());
      expect(onSelectNode).not.toHaveBeenCalled();
      expect(onToggleCollapsed).not.toHaveBeenCalled();
      expect(onOpenChat).not.toHaveBeenCalled();
    } finally {
      act((): void => root.unmount());
    }
  });

  it('keeps workflow agents as selectable chat rows with the provider workspace label', () => {
    const tree = workflowTree();
    const markup = renderToStaticMarkup(
      <SubagentsList
        tree={tree}
        selectedId={null}
        columns="full"
        showWorkspaceDetails
        now={61_000}
        onSelectNode={(): void => undefined}
        onOpenChat={(): void => undefined}
      />,
    );
    const agentRow = markup.slice(
      markup.indexOf('data-testid="subagents-list-row-workflow-agent-1"'),
      markup.indexOf('data-testid="subagents-list-row-workflow-agent-2"'),
    );
    expect(agentRow).toContain('Workflow agent');
    expect(agentRow).toContain(
      'data-testid="subagents-list-open-workflow-agent-1"',
    );
    expect(agentRow).toContain('shrink-0');
  });

  it('masks workflow run, phase and agent titles for session replay', () => {
    const tree = workflowTree();
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <SubagentsList
        tree={tree}
        selectedId={null}
        columns="full"
        showWorkspaceDetails
        now={61_000}
        onSelectNode={(): void => undefined}
        onOpenChat={(): void => undefined}
      />,
    );
    const maskedTitle = (rowId: string): string | null | undefined =>
      container.querySelector(
        `[data-testid="subagents-list-row-${rowId}"] .ph-mask`,
      )?.textContent;
    for (const id of [
      'workflow-run-1',
      'workflow-phase-1',
      'workflow-agent-1',
    ]) {
      expect(maskedTitle(id)).toBe(tree.nodes.get(id)?.title);
    }
  });

  it('names row controls from the masked title instead of an aria-label', () => {
    const tree = workflowTree();
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <SubagentsList
        tree={tree}
        selectedId={null}
        columns="full"
        showWorkspaceDetails
        now={61_000}
        onToggleCollapsed={(): void => undefined}
        onSelectNode={(): void => undefined}
        onOpenChat={(): void => undefined}
        onOpenWorkflow={(): void => undefined}
      />,
    );
    const accessibleName = (testId: string): string => {
      const control = container.querySelector(`[data-testid="${testId}"]`);
      expect(control?.hasAttribute('aria-label')).toBe(false);
      return (control?.getAttribute('aria-labelledby') ?? '')
        .split(' ')
        .map((id) => container.querySelector(`[id="${id}"]`))
        .map((element) => element?.textContent ?? '')
        .join(' ');
    };
    expect(accessibleName('subagents-list-toggle-workflow-run-1')).toBe(
      'Collapse Nightly review',
    );
    expect(accessibleName('subagents-list-open-workflow-run-1')).toBe(
      'Open workflow Nightly review',
    );
    expect(accessibleName('subagents-list-toggle-workflow-phase-1')).toBe(
      'Collapse Consistency',
    );
    expect(accessibleName('subagents-list-open-workflow-agent-1')).toBe(
      'Open Check output',
    );
  });

  it('folds a workflow run in All and ignores group folding under a projection', () => {
    const tree = workflowTree();
    const collapsed = renderToStaticMarkup(
      <SubagentsList
        tree={tree}
        selectedId={null}
        columns="full"
        collapsedIds={new Set(['workflow-run-1'])}
        onToggleCollapsed={(): void => undefined}
        showWorkspaceDetails
        now={61_000}
        onSelectNode={(): void => undefined}
        onOpenChat={(): void => undefined}
      />,
    );
    expect(collapsed).toContain('subagents-list-row-workflow-run-1');
    expect(collapsed).not.toContain('subagents-list-row-workflow-phase-1');
    expect(collapsed).not.toContain('subagents-list-row-workflow-agent-1');

    const projected = renderToStaticMarkup(
      <SubagentsList
        tree={tree}
        projection={projectSubagentSkipEdges(tree, 'active')}
        selectedId={null}
        columns="full"
        collapsedIds={new Set(['workflow-run-1', 'workflow-phase-1'])}
        onToggleCollapsed={(): void => undefined}
        showWorkspaceDetails
        now={61_000}
        onSelectNode={(): void => undefined}
        onOpenChat={(): void => undefined}
      />,
    );
    expect(projected).toContain('subagents-list-row-workflow-run-1');
    expect(projected).toContain('subagents-list-row-workflow-phase-1');
    expect(projected).toContain('subagents-list-row-workflow-agent-2');
    expect(projected).not.toContain(
      'data-testid="subagents-list-toggle-workflow-run-1"',
    );
    expect(projected).not.toContain(
      'data-testid="subagents-list-toggle-workflow-phase-1"',
    );
  });

  it('keeps every row at its natural height', () => {
    const trees = [familyTree(), workflowTree()];
    const rows = trees.flatMap((tree) => {
      const markup = renderToStaticMarkup(
        <SubagentsList
          tree={tree}
          selectedId={null}
          columns="full"
          showWorkspaceDetails
          now={0}
          onSelectNode={(): void => undefined}
          onOpenChat={(): void => undefined}
        />,
      );
      return (
        markup.match(
          /data-testid="subagents-list-row-[^"]+"[^>]*class="[^"]*"/g,
        ) ?? []
      );
    });
    expect(rows).toHaveLength(6);
    for (const row of rows) expect(row).toContain('shrink-0');
  });
});
