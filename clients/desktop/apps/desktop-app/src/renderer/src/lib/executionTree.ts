import type { ExecutionSummary } from '@canopy/desktop-shared/types/pipeline';
import {
  buildExecutionTree as buildExecutionTreeImpl,
  pruneExpandedIdsToExpandableNodes as pruneExpandedIdsToExpandableNodesImpl,
  type ExecutionTreeNode as SharedExecutionTreeNode,
} from '@canopy/ui-shared/lib/execution-tree';

export type ExecutionTreeNode = SharedExecutionTreeNode<ExecutionSummary>;

export function buildExecutionTree(
  summaries: ExecutionSummary[],
): ExecutionTreeNode[] {
  return buildExecutionTreeImpl(summaries);
}

export function pruneExpandedIdsToExpandableNodes(
  tree: ExecutionTreeNode[],
  existing: Set<string>,
): Set<string> {
  return pruneExpandedIdsToExpandableNodesImpl(tree, existing);
}

export function collectVisibleExecutionTreeNodes(
  tree: ExecutionTreeNode[],
  expandedIds: ReadonlySet<string>,
): ExecutionTreeNode[] {
  const visible: ExecutionTreeNode[] = [];
  const visit = (nodes: ExecutionTreeNode[]): void => {
    for (const node of nodes) {
      visible.push(node);
      if (expandedIds.has(node.summary.id)) visit(node.children);
    }
  };
  visit(tree);
  return visible;
}
