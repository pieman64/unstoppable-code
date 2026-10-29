/** @jest-environment jsdom */
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import type { SubagentNode, SubagentTree } from '@canopy/agent-transcript';
import type { SubagentWorktreeSummaryState } from '../../types';
import { SubagentDetailsGrid } from '../SubagentDetailsGrid';

function fixture(): {
  readonly node: SubagentNode;
  readonly tree: SubagentTree;
} {
  const node: SubagentNode = {
    id: 'subagent-1',
    kind: 'managed',
    parentId: null,
    depth: 1,
    title: 'Explore the audit stream',
    status: 'completed',
    childIds: [],
    liveDescendantCount: 0,
    approvalPending: false,
    runs: [{ runGeneration: 1 }],
    snapshot: {
      delegationId: 'subagent-1',
      status: 'completed',
      outputTruncated: false,
      usage: { inputTokens: 100, outputTokens: 25, costUsd: 0.2 },
    },
  };
  return {
    node,
    tree: {
      root: { id: 'root-chat', title: 'Root chat' },
      nodes: new Map([[node.id, node]]),
      rootChildIds: [node.id],
      complete: true,
    },
  };
}

function renderGrid(
  layout: 'columns' | 'stacked',
  cost?: ReactNode,
  worktree?: SubagentWorktreeSummaryState,
): HTMLDivElement {
  const { node, tree } = fixture();
  const container = document.createElement('div');
  container.innerHTML = renderToString(
    <SubagentDetailsGrid
      layout={layout}
      tree={tree}
      node={node}
      ancestors={[]}
      onOpenLineage={() => {}}
      cost={cost}
      worktree={worktree}
    />,
  );
  return container;
}

describe('SubagentDetailsGrid cost section', () => {
  it('places Cost between Setup and Lineage, hides Setup Usage and adds a column', () => {
    const container = renderGrid('columns', <div>Observed cost</div>);
    const sections = Array.from(container.querySelectorAll('section')).map(
      (section) => section.getAttribute('data-testid'),
    );
    expect(sections).toEqual([
      'subagent-chat-details-setup',
      'subagent-chat-details-cost',
      'subagent-chat-details-lineage',
    ]);
    expect(
      container.querySelector('[data-testid="subagent-chat-details-cost"]')
        ?.textContent,
    ).toContain('CostObserved cost');
    expect(
      container.querySelector('[data-testid="subagent-chat-details-setup"]')
        ?.textContent,
    ).not.toContain('Usage');
    expect(
      container.querySelector<HTMLElement>('[data-layout="columns"]')?.style
        .gridTemplateColumns,
    ).toBe('minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr)');
  });

  it('gives Cost its own column beside a Worktree section', () => {
    const container = renderGrid('columns', <div>Observed cost</div>, {
      status: 'loading',
    });
    expect(
      container.querySelector<HTMLElement>('[data-layout="columns"]')?.style
        .gridTemplateColumns,
    ).toBe('minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.2fr)');
  });

  it('keeps Setup Usage and the layout without Cost', () => {
    const container = renderGrid('columns');
    expect(
      container.querySelector('[data-testid="subagent-chat-details-cost"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="subagent-chat-details-setup"]')
        ?.textContent,
    ).toContain('Usage');
    expect(
      container.querySelector<HTMLElement>('[data-layout="columns"]')?.style
        .gridTemplateColumns,
    ).toBe('minmax(0, 1.2fr) minmax(0, 1fr)');
    expect(
      renderGrid('columns', undefined, {
        status: 'loading',
      }).querySelector<HTMLElement>('[data-layout="columns"]')?.style
        .gridTemplateColumns,
    ).toBe('minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.2fr)');
  });

  it('adds the slot to the stacked scroll area without changing its height cap', () => {
    const container = renderGrid('stacked', <div>Observed cost</div>);
    const grid = container.querySelector<HTMLElement>(
      '[data-layout="stacked"]',
    );
    expect(
      container.querySelector('[data-testid="subagent-chat-details-cost"]'),
    ).not.toBeNull();
    expect(grid?.style.maxHeight).toBe('256px');
    expect(grid?.className).toContain('overflow-y-auto');
    expect(grid?.style.gridTemplateColumns).toBe('');
  });
});
