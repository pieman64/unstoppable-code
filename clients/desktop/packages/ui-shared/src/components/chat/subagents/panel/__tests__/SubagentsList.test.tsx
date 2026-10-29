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
  SubagentsListRow,
  type SubagentsListColumns,
} from '../SubagentsList';
import { subagentStatusInk } from '../../common/SubagentStatusGlyph';
import { subagentStatusDetail } from '../../subagent-copy';
import { SubagentsViewProvider } from '../../subagents-view';

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
    ['full', true, 6],
    ['full', false, 5],
    ['no-workspace', true, 4],
    ['compact', true, 3],
    ['minimal', true, 2],
  ] as const)(
    'renders the %s D9 column set (changes %s) without a header row',
    (columns: SubagentsListColumns, showChanges: boolean, cells: number) => {
      const markup = renderToStaticMarkup(
        <SubagentsListRow
          node={makeNode(1)}
          depth={0}
          absoluteDepth={1}
          hasChildren={false}
          selected={false}
          columns={columns}
          showChanges={showChanges}
          showWorkspaceDetails
          now={0}
          changeTotals={{ additions: 1, deletions: 0, filesChanged: 1 }}
          onSelect={(): void => undefined}
          onOpenChat={(): void => undefined}
        />,
      );

      expect(markup).not.toContain('columnheader');
      expect(markup.match(/role="gridcell"/g) ?? []).toHaveLength(cells);
    },
  );

  it('drops the Status column in the minimal set but keeps the status for assistive technology', () => {
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
    expect(row).toContain('h-10 shrink-0');
  });

  it('names a settled status beside the title in the minimal set', () => {
    const row = renderToStaticMarkup(
      <SubagentsListRow
        node={{ ...makeNode(1), status: 'failed' }}
        depth={0}
        absoluteDepth={1}
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
    expect(row).toContain('>Failed</span>');
    // Shown, so the title does not repeat it for assistive technology.
    expect(row).not.toContain(', Failed');
  });

  function renderRow(
    node: SubagentNode,
    extra: { readonly showStatus?: boolean } = {},
  ): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <SubagentsListRow
        node={node}
        depth={0}
        absoluteDepth={node.depth}
        hasChildren={false}
        selected={false}
        columns="compact"
        showChanges={false}
        showWorkspaceDetails
        now={0}
        onSelect={(): void => undefined}
        onOpenChat={(): void => undefined}
        {...extra}
      />,
    );
    const row = host.querySelector<HTMLElement>(
      `[data-testid="subagents-list-row-${node.id}"]`,
    );
    if (!row) throw new Error('row not rendered');
    return row;
  }

  it('puts the shared spinner before a running title, in the 14px icon slot', () => {
    const row = renderRow(makeNode(1));
    const slot = row.querySelector<HTMLElement>(
      '[data-testid="subagents-list-status-node-1"]',
    );
    // The chat tab's thinking spinner, sized to the 14px icon column.
    const spinner = slot?.firstElementChild;
    expect(spinner).not.toBeNull();
    expect(spinner?.getAttribute('style')).toBe('gap:4px');
    expect(slot?.className).toContain('w-3.5');
    // The spinner says it runs; the title is not also shimmered.
    const title = row.querySelector(
      '[data-testid="subagents-list-title-node-1"]',
    );
    expect(title?.className).not.toContain('canopy-text-shimmer');
  });

  it('keeps the slot empty for a settled task, so titles still line up', () => {
    const row = renderRow({ ...makeNode(1), status: 'completed' });
    const slot = row.querySelector<HTMLElement>(
      '[data-testid="subagents-list-status-node-1"]',
    );
    expect(slot?.className).toContain('w-3.5');
    expect(slot?.childElementCount).toBe(0);
    expect(
      row.querySelector('[data-testid="subagents-list-title-node-1"]')
        ?.className,
    ).not.toContain('canopy-text-shimmer');
  });

  it('shows Running in neutral secondary text, keeping intent ink for failure', () => {
    const running = renderRow(makeNode(1));
    const runningStatus = Array.from(
      running.querySelectorAll('[role="gridcell"]'),
    ).find((cell) => cell.textContent === 'Running');
    expect(runningStatus?.className).toContain('fg-secondary');
    expect(runningStatus?.className).not.toContain(
      subagentStatusInk('running'),
    );

    const failed = renderRow({ ...makeNode(1), status: 'failed' });
    const failedStatus = Array.from(
      failed.querySelectorAll('[role="gridcell"]'),
    ).find((cell) => cell.textContent === 'Failed');
    expect(failedStatus?.className).toContain(subagentStatusInk('failed'));
  });

  it.each(['queued', 'approval'] as const)(
    'still names a %s row beside its title when the Active filter hides the Status column',
    (status) => {
      const row = renderRow({ ...makeNode(1), status }, { showStatus: false });
      // No spinner for a task that is not running yet, so the words say it.
      expect(
        row.querySelector('[data-testid="subagents-list-status-node-1"]')
          ?.childElementCount,
      ).toBe(0);
      const visible = Array.from(row.querySelectorAll('span')).find(
        (span) =>
          !span.classList.contains('sr-only') &&
          span.className.includes('truncate') &&
          span.textContent !== '' &&
          span.textContent !== 'Task 1' &&
          !span.className.includes('text-right'),
      );
      expect(visible?.textContent).toBe(
        subagentStatusDetail({ status, liveDescendantCount: 0 }),
      );
    },
  );

  it('drops the Status column when the list hides it', () => {
    const row = renderRow(makeNode(1), { showStatus: false });
    expect(row.querySelectorAll('[role="gridcell"]')).toHaveLength(2);
    // Still announced to assistive technology.
    expect(row.querySelector('.sr-only')?.textContent).toContain('Running');
  });

  it('lines up the time column at one fixed width on every row', () => {
    for (const columns of [
      'full',
      'no-workspace',
      'compact',
      'minimal',
    ] as const) {
      const markup = renderToStaticMarkup(
        <SubagentsListRow
          node={makeNode(1)}
          depth={0}
          absoluteDepth={1}
          hasChildren={false}
          selected={false}
          columns={columns}
          showChanges={false}
          showWorkspaceDetails
          now={0}
          onSelect={(): void => undefined}
          onOpenChat={(): void => undefined}
        />,
      );
      expect(markup).toContain('_3rem_1.75rem]');
      expect(markup).not.toContain('_auto_');
    }
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

  it('keeps hidden-ancestor lineage out of the row', () => {
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
      <SubagentsViewProvider value>
        <SubagentsList
          tree={tree}
          projection={projectSubagentSkipEdges(tree, 'active')}
          selectedId={null}
          columns="full"
          showWorkspaceDetails
          now={0}
          onSelectNode={(): void => undefined}
          onOpenChat={(): void => undefined}
        />
      </SubagentsViewProvider>,
    );

    expect(markup).toContain('data-testid="subagents-list-row-visible"');
    expect(markup).toContain('Live child');
    // Lineage stays in the details card, not on the row.
    expect(markup).not.toContain('via Finished parent');
    expect(markup).not.toContain('Finished parent');
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
      <SubagentsViewProvider value>
        <SubagentsList
          tree={familyTree()}
          selectedId={null}
          columns="full"
          showWorkspaceDetails
          now={0}
          onSelectNode={(): void => undefined}
          onOpenChat={(): void => undefined}
        />
      </SubagentsViewProvider>,
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
          <SubagentsViewProvider value>
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
            />
          </SubagentsViewProvider>,
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

  it('renders the classic list, with its column header, while the Subagents view is off', () => {
    const props = {
      tree: familyTree(),
      selectedId: null,
      columns: 'full' as const,
      showWorkspaceDetails: true,
      now: 0,
      onSelectNode: (): void => undefined,
      onOpenChat: (): void => undefined,
    };
    const classic = renderToStaticMarkup(<SubagentsList {...props} />);
    expect(classic).toContain('role="columnheader"');
    expect(classic).not.toContain('subagents-list-status-');

    const view = renderToStaticMarkup(
      <SubagentsViewProvider value>
        <SubagentsList {...props} />
      </SubagentsViewProvider>,
    );
    expect(view).not.toContain('role="columnheader"');
    expect(view).toContain('subagents-list-status-');
  });

  it('shows the Changes column only when a listed task has changes', () => {
    const list = (withChanges: boolean): string =>
      renderToStaticMarkup(
        <SubagentsViewProvider value>
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
          />
        </SubagentsViewProvider>,
      );
    const parentCells = (markup: string): number => {
      const host = document.createElement('div');
      host.innerHTML = markup;
      return (
        host
          .querySelector('[data-testid="subagents-list-row-parent"]')
          ?.querySelectorAll('[role="gridcell"]').length ?? -1
      );
    };
    // One task with changes adds the column to every row, empty where a
    // task has none.
    expect(parentCells(list(true))).toBe(parentCells(list(false)) + 1);
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
          <SubagentsViewProvider value>
            <SubagentsList
              tree={tree}
              selectedId={null}
              columns="full"
              showWorkspaceDetails
              now={61_000}
              onSelectNode={onSelectNode}
              onOpenChat={onOpenChat}
              onOpenWorkflow={onOpenWorkflow}
            />
          </SubagentsViewProvider>,
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
        <SubagentsViewProvider value>
          <SubagentsList
            tree={tree}
            selectedId={null}
            columns="full"
            showWorkspaceDetails
            now={61_000}
            onSelectNode={(): void => undefined}
            onOpenChat={(): void => undefined}
          />
        </SubagentsViewProvider>,
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
      <SubagentsViewProvider value>
        <SubagentsList
          tree={tree}
          selectedId={null}
          columns="full"
          showWorkspaceDetails
          now={61_000}
          onSelectNode={(): void => undefined}
          onOpenChat={(): void => undefined}
        />
      </SubagentsViewProvider>,
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
          <SubagentsViewProvider value>
            <SubagentsList
              tree={tree}
              selectedId={null}
              columns="full"
              showWorkspaceDetails
              now={61_000}
              onToggleCollapsed={onToggleCollapsed}
              onSelectNode={onSelectNode}
              onOpenChat={onOpenChat}
            />
          </SubagentsViewProvider>,
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
      <SubagentsViewProvider value>
        <SubagentsList
          tree={tree}
          selectedId={null}
          columns="full"
          showWorkspaceDetails
          now={61_000}
          onSelectNode={(): void => undefined}
          onOpenChat={(): void => undefined}
        />
      </SubagentsViewProvider>,
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
      <SubagentsViewProvider value>
        <SubagentsList
          tree={tree}
          selectedId={null}
          columns="full"
          showWorkspaceDetails
          now={61_000}
          onSelectNode={(): void => undefined}
          onOpenChat={(): void => undefined}
        />
      </SubagentsViewProvider>,
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
      <SubagentsViewProvider value>
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
        />
      </SubagentsViewProvider>,
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
      <SubagentsViewProvider value>
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
        />
      </SubagentsViewProvider>,
    );
    expect(collapsed).toContain('subagents-list-row-workflow-run-1');
    expect(collapsed).not.toContain('subagents-list-row-workflow-phase-1');
    expect(collapsed).not.toContain('subagents-list-row-workflow-agent-1');

    const projected = renderToStaticMarkup(
      <SubagentsViewProvider value>
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
        />
      </SubagentsViewProvider>,
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
        <SubagentsViewProvider value>
          <SubagentsList
            tree={tree}
            selectedId={null}
            columns="full"
            showWorkspaceDetails
            now={0}
            onSelectNode={(): void => undefined}
            onOpenChat={(): void => undefined}
          />
        </SubagentsViewProvider>,
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
