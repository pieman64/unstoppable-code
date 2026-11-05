import type {
  SubagentNode,
  SubagentTree,
  SubagentWorktreeSummary,
  SubagentWorktreeSummaryState,
} from '@canopy/ui-shared/components';

/** Fixtures for the subagent chat sheets. */

export function node(
  id: string,
  title: string,
  parentId: string | null,
  childIds: readonly string[],
  overrides: Partial<SubagentNode> = {},
): SubagentNode {
  return {
    id,
    kind: 'managed',
    parentId,
    depth: parentId === null ? 1 : 2,
    title,
    status: 'completed',
    childIds,
    liveDescendantCount: 0,
    approvalPending: false,
    runs: [{ runGeneration: 1 }],
    ...overrides,
  };
}

export function treeOf(nodes: readonly SubagentNode[]): SubagentTree {
  return {
    root: { id: 'root-chat', title: 'Billing cleanup' },
    nodes: new Map(nodes.map((entry) => [entry.id, entry])),
    rootChildIds: nodes
      .filter((entry) => entry.parentId === null)
      .map((entry) => entry.id),
    complete: true,
  };
}

export const PLAN = node('plan', 'Plan the slices', null, [
  'implement',
  'explore',
]);
export const IMPLEMENT = node(
  'implement',
  'Implement the handlers',
  'plan',
  ['review'],
  { status: 'running' },
);
export const REVIEW = node('review', 'Review the changes', 'implement', [], {
  status: 'failed',
  errorMessage: 'The review found an issue',
});
export const EXPLORE = node('explore', 'Explore the codebase', 'plan', [], {
  status: 'queued',
});
export const DOCS = node('docs', 'Write the migration notes', null, [], {
  status: 'idle',
  liveDescendantCount: 2,
});

export const CHAT_TREE = treeOf([PLAN, IMPLEMENT, REVIEW, EXPLORE, DOCS]);

export const LONG_TITLE =
  'Reconcile every invoice line against the ledger export and report the differences per customer';
export const LONG_TITLE_PARENT = node('long-parent', LONG_TITLE, null, [
  'long-child',
]);
export const LONG_TITLE_CHILD = node(
  'long-child',
  `${LONG_TITLE} (second pass)`,
  'long-parent',
  [],
);
export const LONG_TREE = treeOf([LONG_TITLE_PARENT, LONG_TITLE_CHILD]);

const WORKFLOW = {
  runId: 'wf_billing-123',
  runName: 'Billing workflow',
  runOrdinal: 1,
  runCount: 1,
  phaseCount: 3,
  agentCount: 7,
};

function workflowTree(
  runStatus: SubagentNode['status'],
  agents: readonly SubagentNode[],
  runName = WORKFLOW.runName,
): SubagentTree {
  const run = node('run', runName, null, ['phase'], {
    kind: 'workflow-run',
    status: runStatus,
    runs: [],
    workflow: { ...WORKFLOW, runName },
  });
  const phase = node(
    'phase',
    'Review',
    'run',
    agents.map((agent) => agent.id),
    {
      kind: 'workflow-phase',
      runs: [],
      workflow: { ...WORKFLOW, runName, phaseTitle: 'Review', phaseIndex: 1 },
    },
  );
  return treeOf([run, phase, ...agents]);
}

function workflowAgent(
  id: string,
  status: SubagentNode['status'],
  overrides: Partial<NonNullable<SubagentNode['workflow']>> = {},
  nodeOverrides: Partial<SubagentNode> = {},
): SubagentNode {
  return node(id, `Agent ${id}`, 'phase', [], {
    kind: 'workflow-agent',
    depth: 3,
    status,
    runs: [],
    workflow: {
      ...WORKFLOW,
      phaseTitle: 'Review',
      phaseIndex: 1,
      agentPosition: 5,
      ...overrides,
    },
    ...nodeOverrides,
  });
}

export interface WorkflowSpecimen {
  readonly label: string;
  readonly tree: SubagentTree;
  readonly node: SubagentNode;
  readonly openable: boolean;
}

const DONE_AGENT = workflowAgent('five', 'completed', {
  tokens: 12400,
  toolCalls: 31,
});
const FAILED_AGENT = workflowAgent('six', 'failed');
const RUNNING_AGENT = workflowAgent('seven', 'running', { agentPosition: 7 });
const BARE_AGENT = workflowAgent(
  'bare',
  'completed',
  {},
  { workflow: undefined },
);
const LONG_RUN_NAME =
  'Quarterly billing reconciliation and ledger migration across every region';
const LONG_RUN_AGENT = workflowAgent('long', 'completed', {
  runName: LONG_RUN_NAME,
  runId: 'wf_quarterly-billing-reconciliation-and-ledger-migration-2026-q3',
  tokens: 1_200_000,
  toolCalls: 1,
});

export const WORKFLOW_SPECIMENS: readonly WorkflowSpecimen[] = [
  {
    label:
      'Finished run with a failed agent, usage and an Open workflow button',
    tree: workflowTree('completed', [DONE_AGENT, FAILED_AGENT]),
    node: DONE_AGENT,
    openable: true,
  },
  {
    label: 'Run in progress',
    tree: workflowTree('running', [DONE_AGENT, RUNNING_AGENT]),
    node: RUNNING_AGENT,
    openable: true,
  },
  {
    label: 'No handler: the button is left out',
    tree: workflowTree('completed', [DONE_AGENT]),
    node: DONE_AGENT,
    openable: false,
  },
  {
    label: 'Agent without workflow info: the run node fills in',
    tree: workflowTree('completed', [BARE_AGENT]),
    node: BARE_AGENT,
    openable: true,
  },
  {
    label: 'Long run name and id, large usage',
    tree: workflowTree('completed', [LONG_RUN_AGENT], LONG_RUN_NAME),
    node: LONG_RUN_AGENT,
    openable: true,
  },
];

function summary(
  overrides: Partial<SubagentWorktreeSummary> = {},
): SubagentWorktreeSummaryState {
  return {
    status: 'ready',
    summary: {
      checkout: 'retained',
      startingRevision: '1234567890abcdef',
      startingSubject: 'Start the billing cleanup',
      startingBranch: 'main',
      filesChanged: 2,
      additions: 12,
      deletions: 4,
      commitsAhead: 2,
      untrackedFiles: 1,
      applyState: 'not_applied',
      topFiles: [
        {
          path: 'src/billing/ledger.ts',
          status: 'modified',
          additions: 9,
          deletions: 4,
        },
        {
          path: 'src/billing/ledger.test.ts',
          status: 'added',
          additions: 3,
          deletions: 0,
        },
      ],
      truncated: false,
      ...overrides,
    },
  };
}

export const WORKTREE_SPECIMENS: readonly {
  readonly label: string;
  readonly state: SubagentWorktreeSummaryState;
  readonly showChanges?: boolean;
}[] = [
  { label: 'Loading', state: { status: 'loading' } },
  {
    label: 'Read failed, with Try again',
    state: {
      status: 'error',
      error: 'git exited with 128',
      onRetry: () => undefined,
    },
  },
  {
    label: 'Read failed, nothing to retry',
    state: { status: 'error', error: 'The disk is read-only' },
  },
  { label: 'Unavailable', state: { status: 'unavailable' } },
  {
    label: 'Unavailable with a reason',
    state: { status: 'unavailable', reason: 'The checkout was removed' },
  },
  {
    label: 'Kept checkout, not applied, with Show changes',
    state: summary(),
    showChanges: true,
  },
  {
    label: 'Applied work with one commit',
    state: summary({
      applyState: 'applied',
      commitsAhead: 1,
      untrackedFiles: 0,
      filesChanged: 1,
      topFiles: [],
    }),
  },
  {
    label: 'Failed apply, many files cut to the top four',
    state: summary({
      applyState: 'apply_failed',
      filesChanged: 30,
      additions: 480,
      deletions: 212,
      truncated: true,
      topFiles: ['a', 'b', 'c', 'd', 'e'].map((name) => ({
        path: `packages/billing/src/handlers/${name}-handler-with-a-long-name.ts`,
        status: 'modified' as const,
        additions: 40,
        deletions: 12,
      })),
    }),
  },
  {
    label: 'Discarded checkout',
    state: summary({
      checkout: 'discarded',
      applyState: 'discarded',
      startingBranch: undefined,
    }),
  },
  {
    label: 'Missing checkout',
    state: summary({ checkout: 'missing' }),
  },
];
