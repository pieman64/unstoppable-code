/** @jest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import type { SubagentNode, SubagentTree } from '@canopy/agent-transcript';
import { SubagentsFocusBar } from '../SubagentsPanelParts';

function makeNode(
  id: string,
  kind: SubagentNode['kind'],
  parentId: string | null,
  depth: number,
  title: string,
): SubagentNode {
  return {
    id,
    kind,
    parentId,
    depth,
    title,
    status: 'running',
    childIds: [],
    liveDescendantCount: 0,
    approvalPending: false,
    runs: [],
  };
}

function focusBar(node: SubagentNode): string {
  const parent = node.parentId
    ? makeNode(node.parentId, 'workflow-run', null, 1, 'Nightly review')
    : null;
  const nodes = new Map<string, SubagentNode>([[node.id, node]]);
  if (parent) nodes.set(parent.id, parent);
  const tree: SubagentTree = {
    root: { id: 'root-chat', title: 'Root chat' },
    nodes,
    rootChildIds: parent ? [parent.id] : [node.id],
    complete: true,
  };
  return renderToStaticMarkup(
    <SubagentsFocusBar
      tree={tree}
      focusedNode={node}
      onFocusUp={(): void => undefined}
      onShowAll={(): void => undefined}
    />,
  );
}

describe('SubagentsFocusBar workflow icons', () => {
  it('uses the workflow mark for a run', () => {
    const run = makeNode('run-1', 'workflow-run', null, 1, 'Nightly review');
    expect(focusBar(run)).toContain('data-testid="subagent-workflow-mark"');
  });

  it('shows no icon for a phase', () => {
    const phase = makeNode(
      'phase-1',
      'workflow-phase',
      'run-1',
      2,
      'Consistency',
    );
    const markup = focusBar(phase);
    expect(markup).not.toContain('subagent-workflow-mark');
    const container = document.createElement('div');
    container.innerHTML = markup;
    expect(container.querySelectorAll('svg')).toHaveLength(1);
  });

  it('keeps the robot icon for a managed subagent', () => {
    const managed = makeNode('managed-1', 'managed', null, 1, 'Review files');
    const markup = focusBar(managed);
    expect(markup).not.toContain('subagent-workflow-mark');
    const container = document.createElement('div');
    container.innerHTML = markup;
    expect(container.querySelectorAll('svg')).toHaveLength(2);
  });
});
