/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import type { SubagentNode, SubagentTree } from '@canopy/agent-transcript';
import { SubagentBanner } from '../SubagentBanner';
import { SubagentDetailsGrid } from '../SubagentDetailsGrid';
import { SubagentLineageDetails } from '../SubagentLineageDetails';
import { SubagentRunDivider } from '../SubagentRunDivider';
import { SubagentSetupDetails } from '../SubagentSetupDetails';
import { SubagentWorkflowDetails } from '../SubagentWorkflowDetails';
import { SubagentTaskBubble } from '../SubagentTaskBubble';
import { SubagentUserMessageBubble } from '../SubagentUserMessageBubble';
import { SubagentWorktreeDetails } from '../SubagentWorktreeDetails';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function makeNode(
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

function makeTree(): SubagentTree {
  const root = makeNode('parent', 'Plan', null, ['ancestor']);
  const ancestor = makeNode('ancestor', 'Implement', 'parent', [
    'current',
    'sibling',
  ]);
  const current = makeNode('current', 'Review changes', 'ancestor', [], {
    errorMessage: 'The review found an issue',
    status: 'failed',
  });
  const sibling = makeNode('sibling', 'Explore', 'ancestor', []);
  return {
    root: { id: 'root-chat', title: 'Root chat' },
    nodes: new Map([
      [root.id, root],
      [ancestor.id, ancestor],
      [current.id, current],
      [sibling.id, sibling],
    ]),
    rootChildIds: [root.id],
    complete: true,
  };
}

function makeWorkflowTree(): SubagentTree {
  const workflow = {
    runId: 'wf_billing-123',
    runName: 'Billing workflow',
    runOrdinal: 1,
    runCount: 1,
    phaseCount: 3,
    agentCount: 7,
  };
  const run = makeNode('run-node', 'Billing workflow', null, ['phase-node'], {
    kind: 'workflow-run',
    runs: [],
    workflow,
  });
  const phase = makeNode('phase-node', 'Review', 'run-node', [], {
    kind: 'workflow-phase',
    runs: [],
    workflow: { ...workflow, phaseTitle: 'Review', phaseIndex: 1 },
  });
  const agentIds = Array.from(
    { length: 9 },
    (_, index) => `agent-${index + 1}`,
  );
  const agents = agentIds.map((id, index) =>
    makeNode(id, `Agent ${index + 1}`, 'phase-node', [], {
      kind: 'workflow-agent',
      depth: 3,
      runs: [],
      status: index === 1 || index === 7 ? 'failed' : 'completed',
      workflow: {
        ...workflow,
        phaseTitle: 'Review',
        phaseIndex: 1,
        agentPosition: index + 1,
        tokens: index === 4 ? 12 : undefined,
        toolCalls: index === 4 ? 3 : undefined,
      },
      ...(index === 4 ? { workspace: 'shared' as const } : {}),
    }),
  );
  const selected = agents[4];
  if (!selected) throw new Error('workflow fixture is incomplete');
  const completePhase: SubagentNode = { ...phase, childIds: agentIds };
  return {
    root: { id: 'root-chat', title: 'Root chat' },
    nodes: new Map([
      [run.id, run],
      [completePhase.id, completePhase],
      ...agents.map((agent) => [agent.id, agent] as const),
    ]),
    rootChildIds: [run.id],
    complete: true,
  };
}

describe('subagent conversation display', () => {
  it.each(['task', 'user'] as const)(
    'blocks the %s message content while keeping bubble controls recorded',
    (kind) => {
      const container = document.createElement('div');
      container.innerHTML = renderToString(
        kind === 'task' ? (
          <SubagentTaskBubble sender="Plan" kind="task" text="Private task" />
        ) : (
          <SubagentUserMessageBubble copyText="Private task" steering>
            Private task
          </SubagentUserMessageBubble>
        ),
      );
      const blocked = container.querySelector('.ph-no-capture');
      expect(blocked?.textContent).toBe('Private task');
      expect(blocked?.querySelector('button')).toBeNull();
      expect(blocked?.textContent).not.toContain('Task from Plan');
      expect(blocked?.textContent).not.toContain('Steering');
    },
  );

  it('opens root and ancestor breadcrumbs but keeps the current task as plain text', () => {
    const tree = makeTree();
    const node = tree.nodes.get('current');
    const ancestor = tree.nodes.get('ancestor');
    const parent = tree.nodes.get('parent');
    if (!node || !ancestor || !parent) {
      throw new Error('conversation fixture is incomplete');
    }
    const opened: string[] = [];
    const container = document.createElement('div');
    const root = createRoot(container);
    act((): void => {
      root.render(
        <SubagentBanner
          tree={tree}
          node={node}
          ancestors={[parent, ancestor]}
          expanded={false}
          onToggle={(): void => {}}
          onOpenLineage={(target): void => {
            opened.push(target.id);
          }}
        />,
      );
    });

    act((): void => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="subagent-chat-breadcrumb-root-chat"]',
        )
        ?.click();
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="subagent-chat-breadcrumb-ancestor"]',
        )
        ?.click();
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="subagent-chat-breadcrumb-parent"]',
        )
        ?.click();
    });
    expect(opened).toEqual(['root-chat', 'ancestor', 'parent']);
    expect(
      container.querySelector(
        '[data-testid="subagent-chat-breadcrumb-current"]',
      ),
    ).toBeNull();
    expect(container.textContent).toContain('The review found an issue');
    act((): void => root.unmount());
  });

  it('shows workflow run and phase breadcrumbs with full titles and workflow facts', () => {
    const tree = makeWorkflowTree();
    const node = tree.nodes.get('agent-5');
    const run = tree.nodes.get('run-node');
    const phase = tree.nodes.get('phase-node');
    if (!node || !run || !phase) {
      throw new Error('workflow conversation fixture is incomplete');
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    act((): void => {
      root.render(
        <SubagentBanner
          tree={tree}
          node={node}
          ancestors={[run, phase]}
          expanded={false}
          onToggle={(): void => {}}
          onOpenLineage={(): void => {}}
        />,
      );
    });

    const rootButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="subagent-chat-breadcrumb-root-chat"]',
    );
    const runButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="subagent-chat-breadcrumb-run-node"]',
    );
    const phaseButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="subagent-chat-breadcrumb-phase-node"]',
    );
    const currentTitle = container.querySelector<HTMLElement>(
      '[data-testid="subagent-chat-banner"] nav > span:last-child',
    );
    const runSegment = runButton?.parentElement;
    const runChildren = Array.from(runSegment?.children ?? []);
    expect(rootButton?.querySelector('span')?.title).toBe('Root chat');
    expect(rootButton?.querySelector('span')?.className).toContain('ph-mask');
    expect(runButton?.querySelector('span')?.title).toBe('Billing workflow');
    expect(
      runSegment?.querySelector('[data-testid="subagent-workflow-mark"]'),
    ).not.toBeNull();
    expect(runChildren[1]?.getAttribute('data-testid')).toBe(
      'subagent-workflow-mark',
    );
    expect(runChildren[2]).toBe(runButton);
    expect(phaseButton?.querySelector('span')?.title).toBe('Review');
    expect(phaseButton?.parentElement?.className).toContain('shrink-0');
    expect(phaseButton?.className).toContain('shrink-0');
    expect(phaseButton?.className).not.toContain('truncate');
    expect(
      phaseButton?.parentElement?.querySelector(
        '[data-testid="subagent-workflow-mark"]',
      ),
    ).toBeNull();
    expect(currentTitle?.title).toBe('Agent 5');
    expect(container.textContent).toContain('Workflow agent');
    expect(container.textContent).not.toContain('Shared');
    expect(container.textContent).not.toContain('Isolated');

    const setup = renderToString(<SubagentSetupDetails node={node} />);
    expect(setup).toContain('Workflow agent');
    expect(setup).toContain('>Type</dt>');
    const nativeSetup = renderToString(
      <SubagentSetupDetails
        node={{ ...node, kind: 'claude-native', subagentType: 'Explore' }}
      />,
    );
    expect(nativeSetup).toContain('>Explore</dd>');

    act((): void => root.unmount());
  });

  it('renders workflow details instead of worktree details and opens the run', () => {
    const tree = makeWorkflowTree();
    const node = tree.nodes.get('agent-5');
    const run = tree.nodes.get('run-node');
    const phase = tree.nodes.get('phase-node');
    if (!node || !run || !phase) {
      throw new Error('workflow conversation fixture is incomplete');
    }
    const worktree = {
      status: 'unavailable' as const,
      reason: 'Not available',
    };
    let openedRunId: string | undefined;
    const container = document.createElement('div');
    const root = createRoot(container);
    act((): void => {
      root.render(
        <SubagentDetailsGrid
          layout="columns"
          tree={tree}
          node={node}
          ancestors={[run, phase]}
          worktree={worktree}
          onOpenLineage={(): void => {}}
          onOpenWorkflow={(runId): void => {
            openedRunId = runId;
          }}
        />,
      );
    });

    const details = container.querySelector<HTMLElement>(
      '[data-testid="subagent-chat-details-workflow"]',
    );
    expect(details).not.toBeNull();
    expect(details?.textContent).toContain('Workflow');
    expect(details?.textContent).toContain('Billing workflow');
    expect(details?.textContent).toContain('wf_billing-123');
    expect(details?.textContent).toContain('Done · 2 of 9 failed');
    expect(details?.textContent).toContain('Agent 5 of 7 · phase 2 of 3');
    expect(details?.textContent).toContain('12 tokens · 3 tool calls');
    expect(
      container.querySelector<HTMLElement>(
        '[data-testid="subagent-chat-details"]',
      )?.style.gridTemplateColumns,
    ).toContain('1.2fr');
    expect(
      container.querySelector('[data-testid="subagent-chat-details-worktree"]'),
    ).toBeNull();
    const openButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="subagent-chat-open-workflow"]',
    );
    expect(openButton?.textContent).toContain('Open workflow');
    act((): void => openButton?.click());
    expect(openedRunId).toBe('wf_billing-123');

    act((): void =>
      root.render(<SubagentWorkflowDetails tree={tree} node={node} />),
    );
    expect(
      container.querySelector('[data-testid="subagent-chat-open-workflow"]'),
    ).toBeNull();
    act((): void => root.unmount());
  });

  it('uses run-node data when workflow-agent details are incomplete', () => {
    const sourceTree = makeWorkflowTree();
    const phase = sourceTree.nodes.get('phase-node');
    if (!phase) throw new Error('workflow conversation fixture is incomplete');
    const run = makeNode('run-node', 'Fallback run title', null, [phase.id], {
      kind: 'workflow-run',
      runs: [],
    });
    const node = makeNode('agent-no-workflow', 'Agent', phase.id, [], {
      kind: 'workflow-agent',
      runs: [],
    });
    const nodes = new Map(sourceTree.nodes);
    nodes.set(run.id, run);
    nodes.set(node.id, node);
    const tree: SubagentTree = { ...sourceTree, nodes };
    const html = renderToString(
      <SubagentWorkflowDetails tree={tree} node={node} />,
    );

    expect(html).toContain('Fallback run title');
    expect(html).toContain('Status');
    expect(html).not.toContain('Position');
    expect(html).not.toContain('Usage');
    expect(html).not.toContain('subagent-chat-open-workflow');
  });

  it('renders the requested details layout and the worktree actions only when provided', () => {
    const tree = makeTree();
    const node = tree.nodes.get('current');
    const ancestor = tree.nodes.get('ancestor');
    const parent = tree.nodes.get('parent');
    if (!node || !ancestor || !parent) {
      throw new Error('conversation fixture is incomplete');
    }
    const worktree = {
      status: 'ready' as const,
      summary: {
        checkout: 'retained' as const,
        startingRevision: '1234567890abcdef',
        startingSubject: 'Start point',
        startingBranch: 'main',
        filesChanged: 1,
        additions: 3,
        deletions: 1,
        commitsAhead: 1,
        untrackedFiles: 0,
        applyState: 'not_applied' as const,
        topFiles: [
          {
            path: 'src/review.ts',
            status: 'modified' as const,
            additions: 3,
            deletions: 1,
          },
        ],
        truncated: false,
      },
    };
    const onShowChanges = (): void => {};
    const columns = renderToString(
      <SubagentDetailsGrid
        layout="columns"
        tree={tree}
        node={node}
        ancestors={[parent, ancestor]}
        worktree={worktree}
        onOpenLineage={(): void => {}}
        onShowChanges={onShowChanges}
      />,
    );
    const stacked = renderToString(
      <SubagentDetailsGrid
        layout="stacked"
        tree={tree}
        node={node}
        ancestors={[parent, ancestor]}
        onOpenLineage={(): void => {}}
      />,
    );
    expect(columns).toContain('data-layout="columns"');
    expect(columns).toContain('subagent-chat-details-worktree');
    expect(columns).toContain('subagent-chat-lineage-sibling');
    expect(columns).toContain('Alongside');
    expect(columns).toContain('Show changes');
    expect(columns).toContain('Started without your uncommitted changes.');
    expect(stacked).toContain('data-layout="stacked"');
    expect(stacked).not.toContain('subagent-chat-details-worktree');
  });

  it('lists long write paths with a toggle and keeps every section scrollable', () => {
    const tree = makeTree();
    const node = tree.nodes.get('current');
    const ancestor = tree.nodes.get('ancestor');
    const parent = tree.nodes.get('parent');
    if (!node || !ancestor || !parent) {
      throw new Error('conversation fixture is incomplete');
    }
    const writePaths = Array.from(
      { length: 20 },
      (_, index) =>
        `apps/web/src/lib/cloud-client/__tests__/cloud-item-group-${index}.test.ts`,
    );
    const withPaths: SubagentNode = {
      ...node,
      snapshot: {
        delegationId: node.id,
        status: 'failed',
        outputTruncated: false,
        permissions: { writePaths },
      },
    };
    const container = document.createElement('div');
    const root = createRoot(container);
    act((): void => {
      root.render(
        <SubagentDetailsGrid
          layout="columns"
          tree={tree}
          node={withPaths}
          ancestors={[parent, ancestor]}
          maxHeight={300}
          onOpenLineage={(): void => {}}
        />,
      );
    });
    const details = container.querySelector<HTMLElement>(
      '[data-testid="subagent-chat-details"]',
    );
    expect(details?.style.maxHeight).toBe('300px');
    expect(details?.className).toContain('overflow-y-auto');
    // Setup and Lineage share the width when there is no Worktree section.
    expect(details?.style.gridTemplateColumns).toBe(
      'minmax(0, 1.2fr) minmax(0, 1fr)',
    );

    const paths = (): string[] =>
      Array.from(
        container.querySelectorAll(
          '[data-testid="subagent-chat-permissions-paths"] li',
        ),
        (item) => item.textContent ?? '',
      );
    const toggle = (): HTMLButtonElement | null =>
      container.querySelector<HTMLButtonElement>(
        '[data-testid="subagent-chat-permissions-toggle"]',
      );
    expect(container.textContent).toContain(
      'Read/search and edits within 20 paths',
    );
    expect(container.textContent).toContain('Parent approvals apply.');
    expect(paths()).toEqual(writePaths.slice(0, 5));
    expect(toggle()?.textContent).toBe('Show more (15)');
    expect(toggle()?.getAttribute('aria-label')).toBe(
      'Show more paths (15 remaining)',
    );
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');

    act((): void => toggle()?.click());
    expect(paths()).toEqual(writePaths);
    expect(toggle()?.textContent).toBe('Show less');
    expect(toggle()?.getAttribute('aria-label')).toBe('Show fewer paths');
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    for (const item of Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="subagent-chat-permissions-paths"] li',
      ),
    )) {
      expect(item.querySelector('.ph-no-capture')?.textContent).toBe(
        item.textContent,
      );
    }
    expect(toggle()?.closest('.ph-no-capture')).toBeNull();
    act((): void => root.unmount());
  });

  it('preserves duplicate write paths through expansion and collapse without key warnings', () => {
    const base = makeTree().nodes.get('sibling');
    if (!base) throw new Error('conversation fixture is incomplete');
    const writePaths = ['a.ts', 'a.ts', 'b.ts', 'c.ts', 'd.ts', 'a.ts', 'a.ts'];
    const container = document.createElement('div');
    const root = createRoot(container);
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      act((): void => {
        root.render(
          <SubagentSetupDetails
            node={{
              ...base,
              snapshot: {
                delegationId: base.id,
                status: 'completed',
                outputTruncated: false,
                permissions: { writePaths },
              },
            }}
          />,
        );
      });
      const paths = (): string[] =>
        Array.from(
          container.querySelectorAll('li'),
          (item) => item.textContent ?? '',
        );
      const toggle = container.querySelector<HTMLButtonElement>(
        '[data-testid="subagent-chat-permissions-toggle"]',
      );
      expect(paths()).toEqual(writePaths.slice(0, 5));
      act((): void => toggle?.click());
      expect(paths()).toEqual(writePaths);
      act((): void => toggle?.click());
      expect(paths()).toEqual(writePaths.slice(0, 5));
      expect(errors).not.toHaveBeenCalled();
    } finally {
      act((): void => root.unmount());
      errors.mockRestore();
    }
  });

  it('shows a few write paths without a toggle and read-only access plainly', () => {
    const base = makeTree().nodes.get('sibling');
    if (!base) throw new Error('conversation fixture is incomplete');
    const snapshot = {
      delegationId: base.id,
      status: 'completed' as const,
      outputTruncated: false,
    };
    const few = renderToString(
      <SubagentSetupDetails
        node={{
          ...base,
          snapshot: {
            ...snapshot,
            permissions: {
              writePaths: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
            },
          },
        }}
      />,
    );
    const readOnly = renderToString(
      <SubagentSetupDetails node={{ ...base, snapshot }} />,
    );
    expect(few).toContain('Read/search and edits within 6 paths');
    expect(few).toContain('f.ts');
    expect(few).not.toContain('subagent-chat-permissions-toggle');
    expect(readOnly).toContain('Read and search');
    expect(readOnly).not.toContain('subagent-chat-permissions-paths');
  });

  it('lists siblings under Alongside one per row', () => {
    const base = makeTree();
    const node = base.nodes.get('current');
    const ancestor = base.nodes.get('ancestor');
    const parent = base.nodes.get('parent');
    if (!node || !ancestor || !parent) {
      throw new Error('conversation fixture is incomplete');
    }
    const extra = makeNode('sibling-2', 'Explore more', 'ancestor', []);
    const nodes = new Map(base.nodes);
    nodes.set(extra.id, extra);
    nodes.set(ancestor.id, {
      ...ancestor,
      childIds: [...ancestor.childIds, extra.id],
    });
    const tree: SubagentTree = { ...base, nodes };
    const container = document.createElement('div');
    container.innerHTML = renderToString(
      <SubagentLineageDetails
        tree={tree}
        node={node}
        ancestors={[parent, ancestor]}
        onOpenLineage={(): void => {}}
      />,
    );
    const rows = container.querySelectorAll(
      '[data-testid="subagent-chat-lineage-alongside"] > li',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toBe('ExploreDone');
    expect(rows[1]?.textContent).toBe('Explore moreDone');
    expect(container.textContent).not.toContain(',');
  });

  it('shows a long failure in Setup with a toggle and leaves short ones to the facts line', () => {
    const base = makeTree().nodes.get('current');
    if (!base) throw new Error('conversation fixture is incomplete');
    const longError = `Delegated runner failed: ${'stack frame '.repeat(40)}end`;
    const container = document.createElement('div');
    const root = createRoot(container);
    act((): void => {
      root.render(
        <SubagentSetupDetails node={{ ...base, errorMessage: longError }} />,
      );
    });
    const error = (): string =>
      container.querySelector('[data-testid="subagent-chat-setup-error"]')
        ?.textContent ?? '';
    const toggle = (): HTMLButtonElement | null =>
      container.querySelector<HTMLButtonElement>(
        '[data-testid="subagent-chat-setup-error-toggle"]',
      );
    expect(error().endsWith('…')).toBe(true);
    expect(error().length).toBeLessThan(longError.length);
    expect(toggle()?.textContent).toBe('Show more');
    expect(toggle()?.getAttribute('aria-label')).toBe('Show full error');
    act((): void => toggle()?.click());
    expect(error()).toBe(longError);
    expect(toggle()?.textContent).toBe('Show less');
    act((): void => root.unmount());

    const short = renderToString(<SubagentSetupDetails node={base} />);
    expect(short).not.toContain('subagent-chat-setup-error');
  });

  it('labels task and follow-up messages and supports every worktree state', () => {
    const task = renderToString(
      <SubagentTaskBubble sender="Plan" kind="task" text="Review this" />,
    );
    const followUp = renderToString(
      <SubagentTaskBubble
        sender="Plan"
        kind="follow_up"
        text="Follow-up text"
      />,
    );
    const loading = renderToString(
      <SubagentWorktreeDetails state={{ status: 'loading' }} />,
    );
    const unavailable = renderToString(
      <SubagentWorktreeDetails
        state={{ status: 'unavailable', reason: 'No checkout is available' }}
      />,
    );
    expect(task).toContain('Task from Plan');
    expect(followUp).toContain('Follow-up from Plan');
    expect(loading).toContain('Loading worktree');
    expect(unavailable).toContain('No checkout is available');
  });

  it('hides system instructions and shows watcher messages like the main chat', () => {
    const watcher = renderToString(
      <SubagentTaskBubble
        sender="Plan"
        kind="follow_up"
        text={[
          '<system_instruction>',
          'Canopy watcher internal event details.',
          '<canopy_watcher_event>',
          JSON.stringify({
            watcherId: 'watcher-1',
            label: 'Delegate completion',
            target: { kind: 'managed_delegation', outcome: 'completed' },
          }),
          '</canopy_watcher_event>',
          '</system_instruction>',
        ].join('\n')}
      />,
    );
    expect(watcher).toContain('Delegate watch completed watcher has fired');
    expect(watcher).toContain('Delegate completion');
    expect(watcher).not.toContain('watcher-1');
    expect(watcher).not.toContain('system_instruction');
    expect(watcher).not.toContain('Follow-up from Plan');

    const request = renderToString(
      <SubagentTaskBubble
        sender="Plan"
        kind="follow_up"
        text={[
          '<system_instruction>',
          'A managed subordinate (Write B1) requested steering from its direct parent.',
          '<subordinate_request>',
          'Which tone?',
          '</subordinate_request>',
          '</system_instruction>',
        ].join('\n')}
      />,
    );
    expect(request).toContain('Steering request from Write B1');
    expect(request).toContain('Which tone?');
    expect(request).not.toContain('managed subordinate');

    const hidden = renderToString(
      <SubagentTaskBubble
        sender="Plan"
        kind="task"
        text="<system_instruction>Reload tools.</system_instruction>"
      />,
    );
    expect(hidden).toContain('Task from Plan');
    expect(hidden).toContain('Hidden system instructions');
    expect(hidden).not.toContain('Reload tools.');
  });

  it('shows a watcher folded into a follow-up apart from the message already shown', () => {
    const watcher = [
      '<system_instruction>',
      'Canopy watcher internal event details.',
      '<canopy_watcher_event>',
      JSON.stringify({
        watcherId: 'watcher-1',
        label: 'Delegate completion',
        target: { kind: 'managed_delegation', outcome: 'completed' },
      }),
      '</canopy_watcher_event>',
      '</system_instruction>',
    ].join('\n');
    const folded = renderToString(
      <SubagentTaskBubble
        sender="Plan"
        kind="task"
        text={`hi\n\n${watcher}`}
        shownTexts={['hi']}
      />,
    );
    expect(folded).toContain('Delegate watch completed watcher has fired');
    expect(folded).toContain('Delegate completion');
    expect(folded).not.toContain('>hi<');
    expect(folded).not.toContain('Task from Plan');

    const unshown = renderToString(
      <SubagentTaskBubble
        sender="Plan"
        kind="task"
        text={`hi\n\n${watcher}`}
      />,
    );
    expect(unshown).toContain('Task from Plan');
    expect(unshown).toContain('Delegate watch completed watcher has fired');

    expect(
      renderToString(
        <SubagentTaskBubble
          sender="Plan"
          kind="task"
          text="hi"
          shownTexts={[' hi ']}
        />,
      ),
    ).toBe('');
  });

  it('renders steering messages as user bubbles and separates later runs', () => {
    const steering = renderToString(
      <SubagentUserMessageBubble copyText="Please continue" steering>
        Please continue
      </SubagentUserMessageBubble>,
    );
    const ordinary = renderToString(
      <SubagentUserMessageBubble copyText="A message">
        A message
      </SubagentUserMessageBubble>,
    );
    const divider = renderToString(<SubagentRunDivider runGeneration={2} />);
    expect(steering).toContain('Steering');
    expect(steering).toContain('Please continue');
    expect(ordinary).toContain('A message');
    expect(divider).toContain('Run 2');
  });
});
