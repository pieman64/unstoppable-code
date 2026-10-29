export interface ExecutionTreeSummary {
  readonly id: string;
  readonly parent_execution_id?: string;
}

export interface ExecutionTreeNode<
  Summary extends ExecutionTreeSummary = ExecutionTreeSummary,
> {
  summary: Summary;
  children: ExecutionTreeNode<Summary>[];
  depth: number;
}

export function buildExecutionTree<Summary extends ExecutionTreeSummary>(
  summaries: Summary[],
): ExecutionTreeNode<Summary>[] {
  const ids = new Set(summaries.map((s) => s.id));
  const childrenMap = new Map<string, Summary[]>();
  const roots: Summary[] = [];

  for (const s of summaries) {
    if (s.parent_execution_id && ids.has(s.parent_execution_id)) {
      const siblings = childrenMap.get(s.parent_execution_id) ?? [];
      siblings.push(s);
      childrenMap.set(s.parent_execution_id, siblings);
    } else {
      roots.push(s);
    }
  }

  function buildNode(
    summary: Summary,
    depth: number,
  ): ExecutionTreeNode<Summary> {
    const children = (childrenMap.get(summary.id) ?? []).map((child) =>
      buildNode(child, depth + 1),
    );
    return { summary, children, depth };
  }

  return roots.map((root) => buildNode(root, 0));
}

export function pruneExpandedIdsToExpandableNodes<
  Summary extends ExecutionTreeSummary,
>(tree: ExecutionTreeNode<Summary>[], existing: Set<string>): Set<string> {
  if (existing.size === 0) {
    return new Set<string>();
  }

  const expandableIds = new Set<string>();

  function walk(nodes: ExecutionTreeNode<Summary>[]): void {
    for (const node of nodes) {
      if (node.children.length > 0) {
        expandableIds.add(node.summary.id);
      }
      walk(node.children);
    }
  }

  walk(tree);

  const next = new Set<string>();
  existing.forEach((id: string): void => {
    if (expandableIds.has(id)) {
      next.add(id);
    }
  });

  return next;
}
