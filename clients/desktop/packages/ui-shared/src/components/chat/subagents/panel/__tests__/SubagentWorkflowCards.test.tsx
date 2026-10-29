/** @jest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import type { SubagentNode, SubagentTree } from '@canopy/agent-transcript';
import { SubagentNodeCard } from '../SubagentNodeCard';
import {
  SubagentWorkflowPhaseCard,
  SubagentWorkflowRunCard,
} from '../SubagentCanvasCards';
import { subagentStatusInk } from '../../common/SubagentStatusGlyph';

interface WorkflowFixture {
  readonly tree: SubagentTree;
  readonly run: SubagentNode;
  readonly firstPhase: SubagentNode;
}

function makeBaseNode(
  id: string,
  kind: SubagentNode['kind'],
  parentId: string | null,
  depth: number,
  title: string,
  status: SubagentNode['status'],
  childIds: readonly string[],
  workflow?: SubagentNode['workflow'],
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

function makeAgent(
  id: string,
  phaseId: string,
  phaseIndex: number,
  position: number,
  status: SubagentNode['status'],
): SubagentNode {
  return makeBaseNode(
    id,
    'workflow-agent',
    phaseId,
    3,
    `Agent ${position}`,
    status,
    [],
    {
      runId: 'workflow-1',
      runName: 'Nightly review',
      runOrdinal: 1,
      runCount: 1,
      phaseCount: 4,
      phaseTitle: phaseId === 'phase-3' ? 'Consistency' : 'Review',
      phaseIndex,
      agentPosition: position,
      agentCount: 9,
    },
  );
}

function makeWorkflowFixture(
  runStatus: SubagentNode['status'] = 'completed',
): WorkflowFixture {
  const phaseCount = runStatus === 'running' ? 3 : 4;
  const agentIdsByPhase = [
    ['agent-1', 'agent-2', 'agent-3', 'agent-4'],
    ['agent-5', 'agent-6', 'agent-7'],
    ['agent-8', 'agent-9'],
  ];
  const run = makeBaseNode(
    'run-1',
    'workflow-run',
    null,
    1,
    'Nightly review',
    runStatus,
    ['phase-1', 'phase-2', 'phase-3'],
    {
      runId: 'workflow-1',
      runName: 'Nightly review',
      runOrdinal: 1,
      runCount: 1,
      phaseCount,
      agentCount: 9,
    },
  );
  const phases: readonly SubagentNode[] = [
    makeBaseNode(
      'phase-1',
      'workflow-phase',
      run.id,
      2,
      'Review',
      'completed',
      agentIdsByPhase[0] ?? [],
      {
        runId: 'workflow-1',
        runName: 'Nightly review',
        runOrdinal: 1,
        runCount: 1,
        phaseCount,
        phaseTitle: 'Review',
        phaseIndex: 0,
        agentCount: 9,
      },
    ),
    makeBaseNode(
      'phase-2',
      'workflow-phase',
      run.id,
      2,
      'Validation',
      'completed',
      agentIdsByPhase[1] ?? [],
      {
        runId: 'workflow-1',
        runName: 'Nightly review',
        runOrdinal: 1,
        runCount: 1,
        phaseCount,
        phaseTitle: 'Validation',
        phaseIndex: 1,
        agentCount: 9,
      },
    ),
    makeBaseNode(
      'phase-3',
      'workflow-phase',
      run.id,
      2,
      'Consistency',
      runStatus === 'running' ? 'running' : 'completed',
      agentIdsByPhase[2] ?? [],
      {
        runId: 'workflow-1',
        runName: 'Nightly review',
        runOrdinal: 1,
        runCount: 1,
        phaseCount,
        phaseTitle: 'Consistency',
        phaseIndex: 2,
        agentCount: 9,
      },
    ),
  ];
  const agents: readonly SubagentNode[] = [
    makeAgent('agent-1', 'phase-1', 0, 1, 'failed'),
    makeAgent('agent-2', 'phase-1', 0, 2, 'completed'),
    makeAgent('agent-3', 'phase-1', 0, 3, 'completed'),
    makeAgent('agent-4', 'phase-1', 0, 4, 'completed'),
    makeAgent('agent-5', 'phase-2', 1, 5, 'failed'),
    makeAgent('agent-6', 'phase-2', 1, 6, 'completed'),
    makeAgent('agent-7', 'phase-2', 1, 7, 'completed'),
    makeAgent('agent-8', 'phase-3', 2, 8, 'completed'),
    makeAgent('agent-9', 'phase-3', 2, 9, 'completed'),
  ];
  const firstPhase = phases[0];
  if (!firstPhase) throw new Error('missing workflow phase');
  const nodes = new Map<string, SubagentNode>();
  for (const node of [run, ...phases, ...agents]) nodes.set(node.id, node);
  return {
    tree: {
      root: { id: 'root-chat', title: 'Root chat' },
      nodes,
      rootChildIds: [run.id],
      complete: true,
    },
    run,
    firstPhase,
  };
}

describe('Subagent workflow canvas cards', () => {
  it('shows run status and the failed ink for finished failures', () => {
    const { tree, run } = makeWorkflowFixture();
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <SubagentWorkflowRunCard tree={tree} run={run} />,
    );

    expect(container.textContent).toContain('Nightly review');
    expect(container.textContent).toContain('Done · 2 of 9 failed');
    const failures = Array.from(container.querySelectorAll('span')).find(
      (element) => element.textContent === '2 of 9 failed',
    );
    expect(failures?.className).toContain(subagentStatusInk('failed'));
  });

  it('shows the current phase on a running run card', () => {
    const { tree, run } = makeWorkflowFixture('running');
    const markup = renderToStaticMarkup(
      <SubagentWorkflowRunCard tree={tree} run={run} selected />,
    );
    expect(markup).toContain('Running · 7 of 9 done');
    expect(markup).toContain(
      'Phase 3 of 3 · <span class="ph-mask">Consistency</span>',
    );
    expect(markup).toContain('border-line-accent ring-2 ring-line-accent/30');
  });

  it('shows the phase count on a finished run card', () => {
    const { tree, run } = makeWorkflowFixture();
    const markup = renderToStaticMarkup(
      <SubagentWorkflowRunCard tree={tree} run={run} />,
    );
    expect(markup).toContain('4 phases');
  });

  it('shows phase position and failure count in the failed ink', () => {
    const { tree, firstPhase } = makeWorkflowFixture();
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <SubagentWorkflowPhaseCard tree={tree} phase={firstPhase} />,
    );

    expect(container.textContent).toContain('Review');
    expect(container.textContent).toContain('1 of 4');
    expect(container.textContent).toContain('1 of 4 failed');
    const failures = Array.from(container.querySelectorAll('span')).find(
      (element) =>
        element.textContent === '1 of 4 failed' &&
        element.className.includes(subagentStatusInk('failed')),
    );
    expect(failures?.className).toContain(subagentStatusInk('failed'));
  });

  it('masks run and phase titles for session replay', () => {
    const { tree, run, firstPhase } = makeWorkflowFixture();
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <>
        <SubagentWorkflowRunCard tree={tree} run={run} />
        <SubagentWorkflowPhaseCard tree={tree} phase={firstPhase} />
      </>,
    );
    expect(
      Array.from(container.querySelectorAll('.ph-mask')).map(
        (element) => element.textContent,
      ),
    ).toEqual([run.title, firstPhase.title]);
  });

  it('masks the current phase title on a running run card', () => {
    const { tree, run } = makeWorkflowFixture('running');
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <SubagentWorkflowRunCard tree={tree} run={run} />,
    );
    expect(container.textContent).toContain('Phase 3 of 3 · Consistency');
    expect(
      Array.from(container.querySelectorAll('.ph-mask')).map(
        (element) => element.textContent,
      ),
    ).toEqual([run.title, 'Consistency']);
  });

  it('shows Workflow agent on the existing agent card', () => {
    const { tree } = makeWorkflowFixture();
    const agent = tree.nodes.get('agent-1');
    if (!agent) throw new Error('missing workflow agent');

    expect(renderToStaticMarkup(<SubagentNodeCard node={agent} />)).toContain(
      'Workflow agent',
    );
  });
});
