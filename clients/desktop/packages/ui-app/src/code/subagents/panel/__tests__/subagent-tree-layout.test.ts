import type {
  SubagentNode,
  SubagentTree,
  SubagentTreeWindow,
  SubagentWindowItem,
} from '@canopy/ui-shared';
import {
  autoLevelsForCanvasWidth,
  layoutSubagentTree,
  SUBAGENT_TREE_COLUMN_GAP,
  SUBAGENT_TREE_NODE_HEIGHT,
  SUBAGENT_TREE_NODE_WIDTH,
  SUBAGENT_TREE_PHASE_HEIGHT,
  SUBAGENT_TREE_PHASE_WIDTH,
  SUBAGENT_TREE_ROOT_WIDTH,
  SUBAGENT_TREE_SIBLING_GAP,
} from '../subagent-tree-layout';

function makeNode(
  id: string,
  parentId: string | null,
  depth: number,
  childIds: readonly string[] = [],
): SubagentNode {
  return {
    id,
    kind: 'managed',
    parentId,
    depth,
    title: id,
    status: 'completed',
    childIds,
    liveDescendantCount: 0,
    approvalPending: false,
    runs: [],
  };
}

function makeTree(nodes: readonly SubagentNode[]): SubagentTree {
  const first = nodes[0];
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  return {
    root: { id: 'root-chat', title: 'Root chat' },
    nodes: nodeMap,
    rootChildIds: first ? [first.id] : [],
    complete: true,
  };
}

function findNode(
  layout: ReturnType<typeof layoutSubagentTree>,
  id: string,
): ReturnType<typeof layoutSubagentTree>['nodes'][number] | undefined {
  return layout.nodes.find((node) => node.id === id);
}

describe('layoutSubagentTree', () => {
  it('centers a parent on its children in a tidy left-to-right tree', () => {
    const rootNode = makeNode('parent', null, 1, ['first', 'second']);
    const first = makeNode('first', 'parent', 2);
    const second = makeNode('second', 'parent', 2);
    const tree = makeTree([rootNode, first, second]);
    const window: SubagentTreeWindow = {
      foldedAncestors: [],
      items: [
        {
          kind: 'node',
          node: rootNode,
          via: [],
          children: [
            { kind: 'node', node: first, via: [], children: [] },
            { kind: 'node', node: second, via: [], children: [] },
          ],
        },
      ],
    };

    const layout = layoutSubagentTree(window, tree);
    const rootCard = findNode(layout, 'root');
    const parent = findNode(layout, 'parent');
    const firstCard = findNode(layout, 'first');
    const secondCard = findNode(layout, 'second');

    expect(rootCard?.x).toBe(0);
    expect(parent?.x).toBe(SUBAGENT_TREE_ROOT_WIDTH + SUBAGENT_TREE_COLUMN_GAP);
    expect(firstCard?.y).toBe(0);
    expect(secondCard?.y).toBe(74 + SUBAGENT_TREE_SIBLING_GAP);
    expect((parent?.y ?? 0) + 37).toBe(
      ((firstCard?.y ?? 0) + 37 + (secondCard?.y ?? 0) + 37) / 2,
    );
    expect(layout.edges).toHaveLength(3);
  });

  it('labels and shifts Active-filter skip edges into the hidden ranks', () => {
    const hidden = makeNode('hidden', 'root', 1, ['visible']);
    const visible = makeNode('visible', 'hidden', 2);
    const tree = makeTree([hidden, visible]);
    const window: SubagentTreeWindow = {
      foldedAncestors: [],
      items: [
        {
          kind: 'node',
          node: visible,
          via: [hidden],
          children: [],
        },
      ],
    };

    const layout = layoutSubagentTree(window, tree);
    const visibleCard = findNode(layout, 'visible');

    expect(visibleCard?.x).toBe(
      SUBAGENT_TREE_ROOT_WIDTH +
        SUBAGENT_TREE_COLUMN_GAP +
        SUBAGENT_TREE_NODE_WIDTH +
        SUBAGENT_TREE_COLUMN_GAP,
    );
    expect(layout.edges).toContainEqual({
      id: 'root->visible',
      source: 'root',
      target: 'visible',
      dashed: true,
      label: 'via hidden',
    });
  });

  it('adds a dashed stub card at a window boundary', () => {
    const node = makeNode('parent', null, 1);
    const tree = makeTree([node]);
    const window: SubagentTreeWindow = {
      foldedAncestors: [],
      items: [
        {
          kind: 'node',
          node,
          via: [],
          children: [
            {
              kind: 'stub',
              parentId: 'parent',
              hiddenCount: 5,
              hiddenLiveCount: 2,
            },
          ],
        },
      ],
    };

    const layout = layoutSubagentTree(window, tree);
    expect(layout.targetByCanvasId.get('stub:parent')).toEqual({
      kind: 'stub',
      parentId: 'parent',
    });
    expect(
      layout.edges.find((edge) => edge.id === 'parent->stub:parent')?.dashed,
    ).toBe(true);
  });

  it('uses the compact workflow phase geometry while keeping run and agent cards standard', () => {
    const run: SubagentNode = {
      ...makeNode('run', null, 1, ['phase']),
      kind: 'workflow-run',
    };
    const phase: SubagentNode = {
      ...makeNode('phase', 'run', 2, ['agent']),
      kind: 'workflow-phase',
    };
    const agent: SubagentNode = {
      ...makeNode('agent', 'phase', 3),
      kind: 'workflow-agent',
    };
    const tree = makeTree([run, phase, agent]);
    const window: SubagentTreeWindow = {
      foldedAncestors: [],
      items: [
        {
          kind: 'node',
          node: run,
          via: [],
          children: [
            {
              kind: 'node',
              node: phase,
              via: [],
              children: [{ kind: 'node', node: agent, via: [], children: [] }],
            },
          ],
        },
      ],
    };

    const layout = layoutSubagentTree(window, tree);

    expect(findNode(layout, 'run')).toMatchObject({
      width: SUBAGENT_TREE_NODE_WIDTH,
      height: SUBAGENT_TREE_NODE_HEIGHT,
    });
    expect(findNode(layout, 'phase')).toMatchObject({
      width: SUBAGENT_TREE_PHASE_WIDTH,
      height: SUBAGENT_TREE_PHASE_HEIGHT,
    });
    expect(findNode(layout, 'agent')).toMatchObject({
      width: SUBAGENT_TREE_NODE_WIDTH,
      height: SUBAGENT_TREE_NODE_HEIGHT,
    });
  });

  it('uses a folded-ancestors card when focus has parents', () => {
    const ancestor = makeNode('ancestor', null, 1, ['focused']);
    const focused = makeNode('focused', 'ancestor', 2);
    const tree = makeTree([ancestor, focused]);
    const focusedWindowNode: SubagentWindowItem = {
      kind: 'node',
      node: focused,
      via: [],
      children: [],
    };
    const window: SubagentTreeWindow = {
      focusedNode: focused,
      foldedAncestors: [ancestor],
      items: [focusedWindowNode],
    };

    const layout = layoutSubagentTree(window, tree);
    expect(layout.nodes[0]?.id).toBe('ancestors');
    expect(layout.targetByCanvasId.get('ancestors')).toEqual({
      kind: 'ancestors',
    });
    expect(findNode(layout, 'focused')?.x).toBe(224 + SUBAGENT_TREE_COLUMN_GAP);
  });

  it('handles deep chains without recursive layout traversal', () => {
    const nodes: SubagentNode[] = [];
    for (let depth = 1; depth <= 50; depth += 1) {
      const parentId = depth === 1 ? null : `node-${depth - 1}`;
      const childIds = depth === 50 ? [] : [`node-${depth + 1}`];
      nodes.push(makeNode(`node-${depth}`, parentId, depth, childIds));
    }
    const tree = makeTree(nodes);
    let windowItem: SubagentWindowItem | undefined;
    for (let depth = 50; depth >= 1; depth -= 1) {
      const node = tree.nodes.get(`node-${depth}`);
      if (!node) continue;
      windowItem = {
        kind: 'node',
        node,
        via: [],
        children: windowItem ? [windowItem] : [],
      };
    }
    const window: SubagentTreeWindow = {
      foldedAncestors: [],
      items: windowItem ? [windowItem] : [],
    };

    const layout = layoutSubagentTree(window, tree);
    expect(layout.nodes).toHaveLength(51);
    expect(layout.edges).toHaveLength(50);
    expect(findNode(layout, 'node-50')?.x).toBe(
      SUBAGENT_TREE_ROOT_WIDTH +
        SUBAGENT_TREE_COLUMN_GAP +
        49 * (SUBAGENT_TREE_NODE_WIDTH + SUBAGENT_TREE_COLUMN_GAP),
    );
  });

  it('uses the shared Auto level formula at the canvas width', () => {
    expect(autoLevelsForCanvasWidth(1040, 10)).toBe(3);
    expect(autoLevelsForCanvasWidth(1440, 10)).toBeGreaterThan(3);
  });
});
