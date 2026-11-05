import { useState, type JSX } from 'react';
import {
  SubagentsList,
  type SubagentNode,
  type SubagentsListColumns,
  type SubagentTree,
} from '@canopy/ui-shared';
import type { SubagentChangeTotals } from '@canopy/ui-shared/components';
import { SpecimenCell, SpecimenPanel } from './componentsLabParts';

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const MINUTE = 60_000;

function task(
  id: string,
  title: string,
  parentId: string | null,
  depth: number,
  overrides: Partial<SubagentNode> = {},
): SubagentNode {
  return {
    id,
    kind: 'managed',
    parentId,
    depth,
    title,
    status: 'running',
    childIds: [],
    liveDescendantCount: 0,
    approvalPending: false,
    runs: [],
    modelLabel: 'Sonnet 5.5',
    harnessId: 'claude',
    workspace: 'isolated',
    startedAt: NOW - 4 * MINUTE,
    ...overrides,
  };
}

function buildTree(nodes: readonly SubagentNode[]): SubagentTree {
  const byId = new Map<string, SubagentNode>();
  for (const node of nodes) byId.set(node.id, node);
  const withChildren = new Map<string, SubagentNode>();
  for (const node of nodes) {
    withChildren.set(node.id, {
      ...node,
      childIds: nodes
        .filter((candidate) => candidate.parentId === node.id)
        .map((child) => child.id),
    });
  }
  return {
    root: { id: 'root', title: 'Ship the release' },
    nodes: withChildren,
    rootChildIds: nodes
      .filter((node) => node.parentId === null)
      .map((node) => node.id),
    complete: true,
  };
}

const WORKFLOW = {
  runId: 'wf-1',
  runName: 'Nightly review',
  runOrdinal: 1,
  runCount: 1,
  phaseCount: 2,
  agentCount: 3,
};

const NODES: readonly SubagentNode[] = [
  task('plan', 'Plan the slices', null, 1, {
    liveDescendantCount: 3,
    status: 'idle',
  }),
  task('port', 'Port the handlers', 'plan', 2),
  task('approve', 'Run the migration', 'plan', 2, {
    status: 'approval',
    approvalPending: true,
  }),
  task('fix', 'Fix the failing tests', 'plan', 2, {
    status: 'failed',
    errorMessage: 'The test runner exited with code 1.',
    settledAt: NOW - MINUTE,
  }),
  task('docs', 'Update the docs', 'plan', 2, {
    status: 'completed',
    settledAt: NOW - 2 * MINUTE,
    modelLabel: 'Haiku 5.5',
    workspace: 'shared',
  }),
  task('queued', 'Prepare the release notes', null, 1, {
    status: 'queued',
    startedAt: undefined,
    modelLabel: undefined,
    harnessId: undefined,
    workspace: undefined,
  }),
  task('cut', 'Back up the database', null, 1, {
    status: 'interrupted',
    settledAt: NOW - 8 * MINUTE,
  }),
  task('stopped', 'Warm the caches', null, 1, {
    status: 'stopped-by-parent',
    settledAt: NOW - 9 * MINUTE,
  }),
  task(
    'long',
    'Investigate why the nightly export job intermittently times out for customers with more than ten thousand invoices',
    null,
    1,
    { modelLabel: 'A model with a very long display name' },
  ),
  task('d2', 'Level two', 'port', 3),
  task('d3', 'Level three', 'd2', 4),
  task('d4', 'Level four', 'd3', 5),
  task('d5', 'Level five, indent is capped', 'd4', 6),
  task('run', 'Nightly review', null, 1, {
    kind: 'workflow-run',
    workflow: WORKFLOW,
  }),
  task('phase', 'Review', 'run', 2, {
    kind: 'workflow-phase',
    workflow: { ...WORKFLOW, phaseTitle: 'Review', phaseIndex: 0 },
  }),
  task('agent-1', 'Agent 1', 'phase', 3, {
    kind: 'workflow-agent',
    status: 'completed',
    settledAt: NOW - MINUTE,
    workflow: {
      ...WORKFLOW,
      phaseTitle: 'Review',
      phaseIndex: 0,
      agentPosition: 1,
      agentCount: 3,
    },
  }),
  task('agent-2', 'Agent 2', 'phase', 3, {
    kind: 'workflow-agent',
    workflow: {
      ...WORKFLOW,
      phaseTitle: 'Review',
      phaseIndex: 0,
      agentPosition: 2,
      agentCount: 3,
    },
  }),
];

const TREE = buildTree(NODES);

const TOTALS: Readonly<Record<string, SubagentChangeTotals>> = {
  port: { filesChanged: 6, additions: 148, deletions: 31 },
  docs: { filesChanged: 2, additions: 40, deletions: 3 },
};

const noop = (): void => undefined;

function ListDemo({
  columns,
  tree = TREE,
  withChanges = true,
  showWorkspaceDetails = true,
  collapsible = false,
  initialSelectedId = null,
}: {
  readonly columns: SubagentsListColumns;
  readonly tree?: SubagentTree;
  readonly withChanges?: boolean;
  readonly showWorkspaceDetails?: boolean;
  readonly collapsible?: boolean;
  readonly initialSelectedId?: string | null;
}): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSelectedId,
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  return (
    <div className="flex w-full flex-col overflow-hidden rounded-lg border bg-base">
      <SubagentsList
        tree={tree}
        selectedId={selectedId}
        columns={columns}
        showWorkspaceDetails={showWorkspaceDetails}
        now={NOW}
        collapsedIds={collapsed}
        {...(collapsible
          ? {
              onToggleCollapsed: (node: SubagentNode): void =>
                setCollapsed((current) => {
                  const next = new Set(current);
                  if (!next.delete(node.id)) next.add(node.id);
                  return next;
                }),
            }
          : {})}
        {...(withChanges
          ? { changeTotals: (node: SubagentNode) => TOTALS[node.id] }
          : {})}
        onSelectNode={(node): void => setSelectedId(node.id)}
        onOpenChat={noop}
        onOpenWorkflow={noop}
      />
    </div>
  );
}

export function SubagentsListSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="Column sets by panel width">
        <SpecimenCell
          label="Full: task, status, model, workspace, changes, time (select a row)"
          wide
        >
          <ListDemo columns="full" initialSelectedId="port" />
        </SpecimenCell>
        <SpecimenCell
          label="Full without a Changes column when no task has changes"
          wide
        >
          <ListDemo columns="full" withChanges={false} />
        </SpecimenCell>
        <SpecimenCell label="No workspace column" wide>
          <ListDemo columns="no-workspace" />
        </SpecimenCell>
        <SpecimenCell label="Compact" wide>
          <ListDemo columns="compact" />
        </SpecimenCell>
        <SpecimenCell label="Minimal: task and time only" wide>
          <ListDemo columns="minimal" />
        </SpecimenCell>
      </SpecimenPanel>
      <SpecimenPanel title="Other states">
        <SpecimenCell
          label="A surface without workspace or change details"
          wide
        >
          <ListDemo columns="full" showWorkspaceDetails={false} />
        </SpecimenCell>
        <SpecimenCell label="Parents fold their children" wide>
          <ListDemo columns="compact" collapsible />
        </SpecimenCell>
        <SpecimenCell label="Empty: a root with no subagents yet" wide>
          <ListDemo columns="compact" tree={buildTree([])} />
        </SpecimenCell>
      </SpecimenPanel>
    </div>
  );
}
