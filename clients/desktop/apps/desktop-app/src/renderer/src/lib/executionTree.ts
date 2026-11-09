import type { ExecutionSummary } from '@canopy/execution-engine/types/pipeline';
import {
  buildExecutionTree as buildExecutionTreeImpl,
  pruneExpandedIdsToExpandableNodes as pruneExpandedIdsToExpandableNodesImpl,
  type ExecutionTreeNode as SharedExecutionTreeNode,
  type ExecutionTreeSummary,
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

export function collectVisibleExecutionTreeNodes<
  Summary extends ExecutionTreeSummary,
>(
  tree: SharedExecutionTreeNode<Summary>[],
  expandedIds: ReadonlySet<string>,
): SharedExecutionTreeNode<Summary>[] {
  const visible: SharedExecutionTreeNode<Summary>[] = [];
  const visit = (nodes: SharedExecutionTreeNode<Summary>[]): void => {
    for (const node of nodes) {
      visible.push(node);
      if (expandedIds.has(node.summary.id)) visit(node.children);
    }
  };
  visit(tree);
  return visible;
}
