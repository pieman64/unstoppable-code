/** @jest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SubagentNode, SubagentTree } from '@canopy/ui-shared';
import {
  SubagentChatPanel,
  type SubagentChatPanelProps,
} from '../SubagentChatPanel';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const NODE: SubagentNode = {
  id: 'subagent-1',
  kind: 'managed',
  parentId: null,
  depth: 1,
  title: 'Review the cost work',
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

const TREE: SubagentTree = {
  root: { id: 'root-chat', title: 'Root chat' },
  nodes: new Map([[NODE.id, NODE]]),
  rootChildIds: [NODE.id],
  complete: true,
};

function panelProps(costDetails?: ReactNode): SubagentChatPanelProps {
  return {
    tree: TREE,
    subagentId: NODE.id,
    capabilities: {
      stop: true,
      messaging: true,
      worktreeDetails: true,
      nativeInterrupt: true,
      openWorkflow: false,
      stopWorkflow: false,
    },
    transcript: <p>Transcript</p>,
    onOpenLineage: (): void => {},
    costDetails,
  };
}

describe('SubagentChatPanel Cost section slot', () => {
  const roots: Array<{
    readonly root: Root;
    readonly container: HTMLDivElement;
  }> = [];

  afterEach(() => {
    for (const mounted of roots.splice(0)) {
      act(() => mounted.root.unmount());
      mounted.container.remove();
    }
  });

  function renderExpanded(costDetails?: ReactNode): HTMLDivElement {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push({ root, container });
    act(() => root.render(<SubagentChatPanel {...panelProps(costDetails)} />));
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="subagent-chat-details-toggle"]',
        )
        ?.click();
    });
    return container;
  }

  it('shows the slot only when costDetails is passed', () => {
    const withoutCost = renderExpanded();
    expect(
      withoutCost.querySelector('[data-testid="subagent-chat-details-cost"]'),
    ).toBeNull();

    const withCost = renderExpanded(
      <div data-testid="host-cost-details">Loaded cost</div>,
    );
    expect(
      withCost.querySelector('[data-testid="subagent-chat-details-cost"]'),
    ).not.toBeNull();
    expect(
      withCost.querySelector('[data-testid="host-cost-details"]')?.textContent,
    ).toBe('Loaded cost');
  });
});
