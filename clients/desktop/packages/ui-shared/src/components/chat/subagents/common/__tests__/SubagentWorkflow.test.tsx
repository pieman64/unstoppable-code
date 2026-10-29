/** @jest-environment jsdom */

import type {
  SubagentNode,
  SubagentTree,
  SubagentWorkflowInfo,
} from '@canopy/agent-transcript';
import {
  subagentWorkflowCounts,
  subagentWorkflowCurrentPhase,
  subagentWorkflowPhaseCountLine,
  subagentWorkflowPhases,
  subagentWorkflowRunOf,
  subagentWorkflowRunPhaseLine,
  subagentWorkflowRunProgressNote,
  subagentWorkflowRunStatusLine,
} from '../SubagentWorkflow';

function workflowInfo(
  overrides: Partial<SubagentWorkflowInfo> = {},
): SubagentWorkflowInfo {
  return {
    runId: 'workflow-1',
    runName: 'Nightly review',
    runOrdinal: 1,
    runCount: 1,
    phaseCount: 3,
    agentCount: 3,
    ...overrides,
  };
}

function makeNode(
  id: string,
  kind: SubagentNode['kind'],
  parentId: string | null,
  depth: number,
  title: string,
  status: SubagentNode['status'],
  childIds: readonly string[],
  workflow?: SubagentWorkflowInfo,
): SubagentNode {
  return {
    id,
    kind,
    parentId,
    depth,
    title,
    status,
    childIds,
    liveDescendantCount: 0,
    approvalPending: false,
    runs: [],
    ...(workflow ? { workflow } : {}),
  };
}

function makeTree(nodes: readonly SubagentNode[]): SubagentTree {
  const byId = new Map<string, SubagentNode>();
  for (const node of nodes) byId.set(node.id, node);
  const rootChildIds = nodes
    .filter((node) => node.parentId === null)
    .map((node) => node.id);
  return {
    root: { id: 'root-chat', title: 'Root chat' },
    nodes: byId,
    rootChildIds,
    complete: true,
  };
}

function makeCountsTree(): SubagentTree {
  const run = makeNode(
    'run',
    'workflow-run',
    null,
    1,
    'Nightly review',
    'running',
    ['phase-1', 'phase-2'],
    workflowInfo({ phaseCount: 2, agentCount: 3 }),
  );
  const firstPhase = makeNode(
    'phase-1',
    'workflow-phase',
    run.id,
    2,
    'Preparation',
    'completed',
    ['agent-1', 'agent-2'],
    workflowInfo({ phaseCount: 2, phaseIndex: 0, phaseTitle: 'Preparation' }),
  );
  const secondPhase = makeNode(
    'phase-2',
    'workflow-phase',
    run.id,
    2,
    'Consistency',
    'queued',
    ['agent-3'],
    workflowInfo({ phaseCount: 2, phaseIndex: 1, phaseTitle: 'Consistency' }),
  );
  const agents: readonly SubagentNode[] = [
    makeNode(
      'agent-1',
      'workflow-agent',
      firstPhase.id,
      3,
      'Agent 1',
      'completed',
      [],
      workflowInfo({ phaseIndex: 0, agentPosition: 1 }),
    ),
    makeNode(
      'agent-2',
      'workflow-agent',
      firstPhase.id,
      3,
      'Agent 2',
      'failed',
      [],
      workflowInfo({ phaseIndex: 0, agentPosition: 2 }),
    ),
    makeNode(
      'agent-3',
      'workflow-agent',
      secondPhase.id,
      3,
      'Agent 3',
      'running',
      [],
      workflowInfo({ phaseIndex: 1, agentPosition: 3 }),
    ),
  ];
  return makeTree([run, firstPhase, secondPhase, ...agents]);
}

function makeNoPhaseTree(
  runStatus: SubagentNode['status'],
  agentStatuses: readonly SubagentNode['status'][],
): SubagentTree {
  const agentIds = agentStatuses.map((_status, index) => `agent-${index + 1}`);
  const run = makeNode(
    'run',
    'workflow-run',
    null,
    1,
    'No-phase workflow',
    runStatus,
    agentIds,
    workflowInfo({ phaseCount: 0, agentCount: agentIds.length }),
  );
  const agents = agentStatuses.map((status, index) =>
    makeNode(
      agentIds[index] ?? `agent-${index + 1}`,
      'workflow-agent',
      run.id,
      2,
      `Agent ${index + 1}`,
      status,
      [],
      workflowInfo({ phaseCount: 0, agentPosition: index + 1 }),
    ),
  );
  return makeTree([run, ...agents]);
}

describe('Subagent workflow helpers', () => {
  it('counts descendant agents without counting phase groups', () => {
    const tree = makeCountsTree();
    const run = tree.nodes.get('run');
    const phase = tree.nodes.get('phase-1');
    if (!run || !phase) throw new Error('missing workflow group');

    expect(subagentWorkflowCounts(tree, run)).toEqual({
      total: 3,
      done: 1,
      failed: 1,
      live: 1,
    });
    expect(subagentWorkflowCounts(tree, phase)).toEqual({
      total: 2,
      done: 1,
      failed: 1,
      live: 0,
    });
    expect(subagentWorkflowPhaseCountLine(tree, phase)).toBe('1 of 2 failed');
  });

  it('chooses a running phase before a queued phase and falls back in order', () => {
    const queuedTree = makeCountsTree();
    const queuedRun = queuedTree.nodes.get('run');
    const queuedPhase = queuedTree.nodes.get('phase-2');
    if (!queuedRun || !queuedPhase) throw new Error('missing queued phase');
    expect(subagentWorkflowPhases(queuedTree, queuedRun)).toHaveLength(2);
    expect(subagentWorkflowCurrentPhase(queuedTree, queuedRun)).toBe(
      queuedPhase,
    );

    const runningPhase = makeNode(
      'phase-1',
      'workflow-phase',
      'run',
      2,
      'Preparation',
      'running',
      ['agent-1', 'agent-2'],
      workflowInfo({ phaseIndex: 0, phaseTitle: 'Preparation' }),
    );
    const runningTree = makeTree([
      runningPhase,
      ...Array.from(queuedTree.nodes.values()).filter(
        (node) => node.id !== 'phase-1',
      ),
    ]);
    const runningRun = runningTree.nodes.get('run');
    if (!runningRun) throw new Error('missing workflow run');
    expect(subagentWorkflowCurrentPhase(runningTree, runningRun)).toBe(
      runningPhase,
    );

    const settledPhases: readonly SubagentNode[] = Array.from(
      runningTree.nodes.values(),
    ).map(
      (node): SubagentNode =>
        node.id === 'phase-1' || node.id === 'phase-2'
          ? { ...node, status: 'completed' }
          : node,
    );
    const settledTree = makeTree(settledPhases);
    const settledRun = settledTree.nodes.get('run');
    const lastPhase = settledTree.nodes.get('phase-2');
    if (!settledRun || !lastPhase) throw new Error('missing settled phase');
    expect(subagentWorkflowCurrentPhase(settledTree, settledRun)).toBe(
      lastPhase,
    );
  });

  it('finds the nearest workflow run and returns no phase for a run without phases', () => {
    const tree = makeCountsTree();
    const run = tree.nodes.get('run');
    const agent = tree.nodes.get('agent-3');
    if (!run || !agent) throw new Error('missing workflow node');
    expect(subagentWorkflowRunOf(tree, agent)).toBe(run);

    const noPhaseTree = makeNoPhaseTree('running', ['running']);
    const noPhaseRun = noPhaseTree.nodes.get('run');
    if (!noPhaseRun) throw new Error('missing phase-free run');
    expect(subagentWorkflowPhases(noPhaseTree, noPhaseRun)).toHaveLength(0);
    expect(
      subagentWorkflowCurrentPhase(noPhaseTree, noPhaseRun),
    ).toBeUndefined();
    expect(subagentWorkflowRunPhaseLine(noPhaseTree, noPhaseRun)).toEqual({
      label: '1 agent',
    });
    expect(subagentWorkflowRunProgressNote(noPhaseTree, noPhaseRun)).toBe(
      '0 of 1 done',
    );
  });

  it('formats running, failed, and clean run status lines', () => {
    const runningTree = makeCountsTree();
    const runningRun = runningTree.nodes.get('run');
    if (!runningRun) throw new Error('missing running run');
    expect(subagentWorkflowRunStatusLine(runningTree, runningRun)).toBe(
      'Running · 1 of 3 done',
    );

    const failedTree = makeNoPhaseTree('completed', ['failed', 'completed']);
    const failedRun = failedTree.nodes.get('run');
    if (!failedRun) throw new Error('missing failed run');
    expect(subagentWorkflowRunStatusLine(failedTree, failedRun)).toBe(
      'Done · 1 of 2 failed',
    );

    const cleanTree = makeNoPhaseTree('completed', ['completed', 'completed']);
    const cleanRun = cleanTree.nodes.get('run');
    if (!cleanRun) throw new Error('missing clean run');
    expect(subagentWorkflowRunStatusLine(cleanTree, cleanRun)).toBe(
      'Done · 2 agents',
    );
  });

  it('formats live and settled progress notes with or without phases', () => {
    const tree = makeCountsTree();
    const run = tree.nodes.get('run');
    if (!run) throw new Error('missing workflow run');
    expect(subagentWorkflowRunProgressNote(tree, run)).toBe(
      '1 of 3 done · phase 2 of 2',
    );

    const completedRun: SubagentNode = { ...run, status: 'completed' };
    const completedTree = makeTree([
      completedRun,
      ...Array.from(tree.nodes.values()).filter((node) => node.id !== 'run'),
    ]);
    const settledRun = completedTree.nodes.get('run');
    if (!settledRun) throw new Error('missing settled workflow run');
    expect(subagentWorkflowRunProgressNote(completedTree, settledRun)).toBe(
      '3 agents · 2 phases',
    );

    const noPhaseTree = makeNoPhaseTree('completed', ['completed', 'failed']);
    const noPhaseRun = noPhaseTree.nodes.get('run');
    if (!noPhaseRun) throw new Error('missing phase-free workflow run');
    expect(subagentWorkflowRunProgressNote(noPhaseTree, noPhaseRun)).toBe(
      '2 agents',
    );
  });
});
