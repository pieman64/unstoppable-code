/** @jest-environment jsdom */

import type { JSX } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  SubagentNode,
  SubagentTree,
  SubagentWorkflowInfo,
} from '@canopy/agent-transcript';
import {
  SubagentsDrawer,
  SubagentsInspector,
  type SubagentsDetailsProps,
} from '../SubagentsDetails';

interface MountedView {
  readonly container: HTMLDivElement;
  readonly unmount: () => void;
}

interface RunOptions {
  readonly workflow?: SubagentWorkflowInfo | null;
  readonly status?: SubagentNode['status'];
  readonly startedAt?: number;
  readonly childIds?: readonly string[];
}

function makeWorkflowInfo(
  overrides: Partial<SubagentWorkflowInfo> = {},
): SubagentWorkflowInfo {
  return {
    runId: 'wf_private-run-id',
    runName: 'Package updates',
    runOrdinal: 3,
    runCount: 3,
    phaseCount: 2,
    agentCount: 4,
    tokens: 3_900_000,
    toolCalls: 598,
    durationMs: 125_000,
    ...overrides,
  };
}

function makeRun(options: RunOptions = {}): SubagentNode {
  const node: SubagentNode = {
    id: 'workflow-run-node',
    kind: 'workflow-run',
    parentId: null,
    depth: 0,
    title: 'Package updates',
    status: options.status ?? 'completed',
    childIds: options.childIds ?? ['phase-plan', 'phase-release'],
    liveDescendantCount: 0,
    approvalPending: false,
    runs: [],
    ...(options.startedAt !== undefined
      ? { startedAt: options.startedAt }
      : {}),
  };
  const workflow =
    options.workflow === null
      ? undefined
      : (options.workflow ?? makeWorkflowInfo());
  return workflow ? { ...node, workflow } : node;
}

function makePhase(
  run: SubagentNode,
  id: string,
  title: string,
  index: number,
  childIds: readonly string[],
  status: SubagentNode['status'],
): SubagentNode {
  return {
    id,
    kind: 'workflow-phase',
    parentId: run.id,
    depth: 1,
    title,
    status,
    childIds,
    liveDescendantCount: 0,
    approvalPending: false,
    runs: [],
    workflow: makeWorkflowInfo({ phaseTitle: title, phaseIndex: index }),
  };
}

function makeWorkflowAgent(
  id: string,
  parentId: string | null,
  status: SubagentNode['status'],
): SubagentNode {
  return {
    id,
    kind: 'workflow-agent',
    parentId,
    depth: parentId === null ? 1 : 2,
    title: `Agent ${id}`,
    status,
    childIds: [],
    liveDescendantCount: 0,
    approvalPending: false,
    runs: [],
  };
}

function makeTree(run: SubagentNode = makeRun()): SubagentTree {
  const phasePlan = makePhase(
    run,
    'phase-plan',
    'Plan the work',
    0,
    ['agent-1', 'agent-2', 'agent-3'],
    'failed',
  );
  const phaseRelease = makePhase(
    run,
    'phase-release',
    'Prepare release',
    1,
    ['agent-4'],
    'completed',
  );
  const agents = [
    makeWorkflowAgent('agent-1', phasePlan.id, 'completed'),
    makeWorkflowAgent('agent-2', phasePlan.id, 'failed'),
    makeWorkflowAgent('agent-3', phasePlan.id, 'completed'),
    makeWorkflowAgent('agent-4', phaseRelease.id, 'completed'),
  ];
  const nodes = new Map<string, SubagentNode>([
    [run.id, run],
    [phasePlan.id, phasePlan],
    [phaseRelease.id, phaseRelease],
  ]);
  for (const agent of agents) nodes.set(agent.id, agent);
  return {
    root: { id: 'root-chat-id', title: 'Private root chat title' },
    nodes,
    rootChildIds: [run.id],
    complete: true,
  };
}

function nodeFromTree(tree: SubagentTree, id: string): SubagentNode {
  const node = tree.nodes.get(id);
  if (!node) throw new Error(`Missing fixture node ${id}`);
  return node;
}

function mount(element: JSX.Element): MountedView {
  const container = document.createElement('div');
  const root = createRoot(container);
  act((): void => root.render(element));
  return {
    container,
    unmount: (): void => act((): void => root.unmount()),
  };
}

function renderInspector(
  tree: SubagentTree,
  node: SubagentNode,
  overrides: Partial<SubagentsDetailsProps> = {},
): MountedView {
  const props: SubagentsDetailsProps = {
    tree,
    node,
    showWorkspaceDetails: true,
    onOpenChat: (): void => undefined,
    onClose: (): void => undefined,
    ...overrides,
  };
  return mount(<SubagentsInspector {...props} />);
}

function rowValue(container: ParentNode, label: string): Element | null {
  const matchingLabel = Array.from(container.querySelectorAll('dt')).find(
    (candidate) => candidate.textContent === label,
  );
  return matchingLabel?.nextElementSibling ?? null;
}

beforeAll((): void => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
    writable: true,
  });
});

describe('subagents details', () => {
  it('renders workflow run status and detail rows', () => {
    const tree = makeTree();
    const run = nodeFromTree(tree, 'workflow-run-node');
    const view = renderInspector(tree, run);
    try {
      const inspector = view.container.querySelector(
        '[data-testid="subagents-inspector"]',
      );
      expect(inspector).not.toBeNull();
      expect(
        inspector?.querySelector('[data-testid="subagent-workflow-mark"]'),
      ).not.toBeNull();
      expect(inspector?.querySelector('h4')?.textContent).toBe(
        'Package updates',
      );
      expect(
        inspector?.querySelector('[data-testid="subagents-inspector-close"]'),
      ).not.toBeNull();

      const statusLine = inspector?.querySelector('span.text-xs');
      expect(statusLine?.textContent).toBe('Done · 1 of 4 failed');
      expect(
        statusLine?.querySelector('.fg-destructive-strong')?.textContent,
      ).toBe('1 of 4 failed');

      const chat = rowValue(view.container, 'Chat');
      expect(chat?.querySelector('.ph-mask')?.textContent).toBe(
        'Private root chat title',
      );
      expect(rowValue(view.container, 'Run')?.textContent).toContain(
        '3 of 3 in this chat',
      );
      expect(
        rowValue(view.container, 'Run')?.querySelector('.font-mono')
          ?.textContent,
      ).toBe('wf_private-run-id');
      expect(rowValue(view.container, 'Phases')?.textContent).toContain(
        'Plan the work1 of 3 failed',
      );
      expect(rowValue(view.container, 'Phases')?.textContent).toContain(
        'Prepare release1 of 1 done',
      );
      expect(rowValue(view.container, 'Usage')?.textContent).toBe(
        '3.9M tokens · 598 tool calls',
      );
      expect(rowValue(view.container, 'Time')?.textContent).toBe('2m');
      expect(
        view.container.querySelector(
          '[data-testid="subagents-inspector-open-chat"]',
        ),
      ).toBeNull();
      expect(
        view.container.querySelector(
          '[data-testid="subagents-inspector-show-changes"]',
        ),
      ).toBeNull();
      expect(
        view.container.querySelector(
          '[data-testid="subagents-inspector-stop"]',
        ),
      ).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it('uses the supplied clock when run duration is missing', () => {
    const run = makeRun({
      workflow: makeWorkflowInfo({ durationMs: undefined }),
      status: 'running',
      startedAt: 1_000,
    });
    const tree = makeTree(run);
    const view = renderInspector(tree, run, { now: 6_100 });
    try {
      expect(rowValue(view.container, 'Time')?.textContent).toBe('5s');
      expect(rowValue(view.container, 'Run')?.textContent).toContain(
        '3 of 3 in this chat',
      );
    } finally {
      view.unmount();
    }
  });

  it('omits empty workflow rows when there is no metadata to show', () => {
    const run = makeRun({
      workflow: makeWorkflowInfo({
        phaseCount: 0,
        tokens: undefined,
        toolCalls: undefined,
        durationMs: undefined,
      }),
      childIds: [],
    });
    const tree = makeTree(run);
    const view = renderInspector(tree, run);
    try {
      expect(rowValue(view.container, 'Phases')).toBeNull();
      expect(rowValue(view.container, 'Usage')).toBeNull();
      expect(rowValue(view.container, 'Time')).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it('offers Open workflow and Focus only when their callbacks are supplied', () => {
    const tree = makeTree();
    const run = nodeFromTree(tree, 'workflow-run-node');
    const withoutCallbacks = renderInspector(tree, run);
    try {
      expect(
        withoutCallbacks.container.querySelector(
          '[data-testid="subagents-inspector-open-workflow"]',
        ),
      ).toBeNull();
      expect(
        withoutCallbacks.container.querySelector(
          '[data-testid="subagents-inspector-focus"]',
        ),
      ).toBeNull();
    } finally {
      withoutCallbacks.unmount();
    }

    const onOpenWorkflow = jest.fn();
    const onFocus = jest.fn();
    const withCallbacks = renderInspector(tree, run, {
      onOpenWorkflow,
      onFocus,
    });
    try {
      const openButton =
        withCallbacks.container.querySelector<HTMLButtonElement>(
          '[data-testid="subagents-inspector-open-workflow"]',
        );
      const focusButton =
        withCallbacks.container.querySelector<HTMLButtonElement>(
          '[data-testid="subagents-inspector-focus"]',
        );
      expect(openButton?.textContent).toContain('Open workflow');
      expect(focusButton?.textContent).toBe('Focus');
      if (!openButton || !focusButton) throw new Error('Missing run actions');
      act((): void => openButton.click());
      act((): void => focusButton.click());
      expect(onOpenWorkflow).toHaveBeenCalledWith(run);
      expect(onFocus).toHaveBeenCalledWith(run);
    } finally {
      withCallbacks.unmount();
    }
  });

  it('offers workflow Stop only when supplied and reflects pending and failed states', () => {
    const tree = makeTree();
    const run = nodeFromTree(tree, 'workflow-run-node');
    const withoutCallback = renderInspector(tree, run);
    try {
      expect(
        withoutCallback.container.querySelector(
          '[data-testid="subagents-inspector-stop-workflow"]',
        ),
      ).toBeNull();
    } finally {
      withoutCallback.unmount();
    }

    const onStopWorkflow = jest.fn();
    const stopping = renderInspector(tree, run, {
      onStopWorkflow,
      stoppingWorkflow: true,
      stopWorkflowError: 'The host refused the request',
    });
    try {
      const stopButton = stopping.container.querySelector<HTMLButtonElement>(
        '[data-testid="subagents-inspector-stop-workflow"]',
      );
      expect(stopButton?.textContent).toContain('Stopping…');
      expect(stopButton?.disabled).toBe(true);
      expect(
        stopping.container.querySelector('[role="alert"]')?.textContent,
      ).toBe("Couldn't stop the workflow. The host refused the request");
      if (!stopButton) throw new Error('Missing workflow Stop action');
      act((): void => stopButton.click());
      expect(onStopWorkflow).not.toHaveBeenCalled();
    } finally {
      stopping.unmount();
    }

    const ready = renderInspector(tree, run, { onStopWorkflow });
    try {
      const stopButton = ready.container.querySelector<HTMLButtonElement>(
        '[data-testid="subagents-inspector-stop-workflow"]',
      );
      expect(stopButton?.textContent).toContain('Stop workflow');
      if (!stopButton) throw new Error('Missing workflow Stop action');
      act((): void => stopButton.click());
      expect(onStopWorkflow).toHaveBeenCalledWith(run);
    } finally {
      ready.unmount();
    }
  });

  it('never offers chat or actions for a workflow phase', () => {
    const tree = makeTree();
    const phase = nodeFromTree(tree, 'phase-plan');
    const view = renderInspector(tree, phase, {
      onOpenWorkflow: (): void => undefined,
      onFocus: (): void => undefined,
      onStopWorkflow: (): void => undefined,
    });
    try {
      expect(view.container.querySelector('h4')?.textContent).toBe(
        'Plan the work',
      );
      expect(
        view.container.querySelector(
          '[data-testid="subagents-inspector-open-chat"]',
        ),
      ).toBeNull();
      expect(
        view.container.querySelector(
          '[data-testid="subagents-inspector-open-workflow"]',
        ),
      ).toBeNull();
      expect(
        view.container.querySelector(
          '[data-testid="subagents-inspector-focus"]',
        ),
      ).toBeNull();
      expect(
        view.container.querySelector(
          '[data-testid="subagents-inspector-stop-workflow"]',
        ),
      ).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it('keeps the existing chat details for workflow agents', () => {
    const agent = makeWorkflowAgent('standalone-agent', null, 'running');
    const tree: SubagentTree = {
      root: { id: 'root-chat-id', title: 'Private root chat title' },
      nodes: new Map([[agent.id, agent]]),
      rootChildIds: [agent.id],
      complete: true,
    };
    const view = renderInspector(tree, agent);
    try {
      expect(
        view.container.querySelector(
          '[data-testid="subagents-inspector-open-chat"]',
        ),
      ).not.toBeNull();
      expect(rowValue(view.container, 'Workspace')?.textContent).toBe(
        'Workflow agent',
      );
    } finally {
      view.unmount();
    }
  });

  it('renders the same workflow run body in the drawer', () => {
    const tree = makeTree();
    const run = nodeFromTree(tree, 'workflow-run-node');
    const props: SubagentsDetailsProps = {
      tree,
      node: run,
      showWorkspaceDetails: true,
      onOpenChat: (): void => undefined,
      onClose: (): void => undefined,
      onOpenWorkflow: (): void => undefined,
    };
    const view = mount(<SubagentsDrawer {...props} over="list" />);
    try {
      expect(
        view.container.querySelector('[data-testid="subagents-drawer"] h4')
          ?.textContent,
      ).toBe('Package updates');
      expect(view.container.querySelector('span.text-xs')?.textContent).toBe(
        'Done · 1 of 4 failed',
      );
      expect(rowValue(view.container, 'Run')?.textContent).toContain(
        '3 of 3 in this chat',
      );
      expect(
        view.container.querySelector(
          '[data-testid="subagents-inspector-open-workflow"]',
        ),
      ).not.toBeNull();
      expect(
        view.container.querySelector(
          '[data-testid="subagents-inspector-open-chat"]',
        ),
      ).toBeNull();
    } finally {
      view.unmount();
    }
  });
});
