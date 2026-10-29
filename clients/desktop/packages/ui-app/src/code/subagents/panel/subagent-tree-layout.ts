import {
  autoSubagentLevelCount,
  subagentViaLabel,
  type SubagentTree,
  type SubagentTreeWindow,
  type SubagentWindowItem,
} from '@canopy/ui-shared';

/** Canvas node card geometry shared with the subagent viewer visual spec. */
export const SUBAGENT_TREE_NODE_WIDTH = 224;
/** Canvas node card geometry shared with the subagent viewer visual spec. */
export const SUBAGENT_TREE_NODE_HEIGHT = 74;
/** Workflow phase card width. */
export const SUBAGENT_TREE_PHASE_WIDTH = 176;
/** Workflow phase card height. */
export const SUBAGENT_TREE_PHASE_HEIGHT = 44;
/** Root-chat card width. */
export const SUBAGENT_TREE_ROOT_WIDTH = 240;
/** Root-chat card height. */
export const SUBAGENT_TREE_ROOT_HEIGHT = 58;
/** Depth-stub card width. */
export const SUBAGENT_TREE_STUB_WIDTH = 168;
/** Depth-stub card height. */
export const SUBAGENT_TREE_STUB_HEIGHT = 30;
/** Folded-ancestry card width. */
export const SUBAGENT_TREE_ANCESTORS_WIDTH = 224;
/** Folded-ancestry card height. */
export const SUBAGENT_TREE_ANCESTORS_HEIGHT = 44;
/** Gap between sibling card subtrees. */
export const SUBAGENT_TREE_SIBLING_GAP = 12;
/** Gap between each rank of the left-to-right tree. */
export const SUBAGENT_TREE_COLUMN_GAP = 48;
/** Total horizontal canvas padding reserved by the Auto level formula. */
export const SUBAGENT_TREE_AUTO_PADDING = 56;

/** Semantic target selected by activating a positioned canvas node. */
export type SubagentCanvasTarget =
  | { readonly kind: 'root' }
  | { readonly kind: 'node'; readonly id: string }
  | { readonly kind: 'stub'; readonly parentId: string }
  | { readonly kind: 'ancestors' };

/** One card's position and semantic activation target, without rendered JSX. */
export interface SubagentTreeLayoutNode {
  readonly id: string;
  readonly target: SubagentCanvasTarget;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One directed connection from a parent's right edge to a child's left. */
export interface SubagentTreeLayoutEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly dashed?: boolean;
  readonly label?: string;
}

/** Positioned data for the caller-rendered React Flow diagram. */
export interface SubagentTreeLayout {
  readonly nodes: readonly SubagentTreeLayoutNode[];
  readonly edges: readonly SubagentTreeLayoutEdge[];
  /** Stable canvas id → semantic target lookup used by click handlers. */
  readonly targetByCanvasId: ReadonlyMap<string, SubagentCanvasTarget>;
}

/** Optional spacing overrides for deterministic layout consumers and tests. */
export interface SubagentTreeLayoutOptions {
  readonly siblingGap?: number;
  readonly columnGap?: number;
}

interface MutableLayoutNode {
  readonly id: string;
  readonly target: SubagentCanvasTarget;
  readonly width: number;
  readonly height: number;
  readonly children: string[];
  readonly edgeDashed: boolean;
  readonly edgeLabel?: string;
  skipRanks: number;
}

interface PlacementFrame {
  readonly id: string;
  readonly x: number;
  readonly crossStart: number;
}

interface PlacedTreeNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

function addLayoutNode(
  nodesById: Map<string, MutableLayoutNode>,
  node: MutableLayoutNode,
): void {
  nodesById.set(node.id, node);
}

function nodeForWindowItem(item: SubagentWindowItem): MutableLayoutNode {
  if (item.kind === 'stub') {
    return {
      id: `stub:${item.parentId}`,
      target: { kind: 'stub', parentId: item.parentId },
      width: SUBAGENT_TREE_STUB_WIDTH,
      height: SUBAGENT_TREE_STUB_HEIGHT,
      children: [],
      edgeDashed: true,
      skipRanks: 0,
    };
  }
  const isWorkflowPhase = item.node.kind === 'workflow-phase';
  return {
    id: item.node.id,
    target: { kind: 'node', id: item.node.id },
    width: isWorkflowPhase
      ? SUBAGENT_TREE_PHASE_WIDTH
      : SUBAGENT_TREE_NODE_WIDTH,
    height: isWorkflowPhase
      ? SUBAGENT_TREE_PHASE_HEIGHT
      : SUBAGENT_TREE_NODE_HEIGHT,
    children: [],
    edgeDashed: item.via.length > 0,
    ...(item.via.length > 0 ? { edgeLabel: subagentViaLabel(item.via) } : {}),
    skipRanks: item.via.length,
  };
}

function addWindowItems(
  items: readonly SubagentWindowItem[],
  parentId: string,
  nodesById: Map<string, MutableLayoutNode>,
): void {
  const stack: {
    readonly item: SubagentWindowItem;
    readonly parentId: string;
  }[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item) stack.push({ item, parentId });
  }
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const node = nodeForWindowItem(current.item);
    const parent = nodesById.get(current.parentId);
    if (!parent) continue;
    parent.children.push(node.id);
    addLayoutNode(nodesById, node);
    if (current.item.kind === 'node') {
      for (
        let index = current.item.children.length - 1;
        index >= 0;
        index -= 1
      ) {
        const child = current.item.children[index];
        if (child) stack.push({ item: child, parentId: node.id });
      }
    }
  }
}

function liveWindowCardDepth(node: MutableLayoutNode): number {
  return node.skipRanks;
}

/**
 * Lays out only the already-windowed tree. The iterative post-order sizing
 * and iterative placement passes stay safe for arbitrarily deep trees.
 */
export function layoutSubagentTree(
  window: SubagentTreeWindow,
  tree: SubagentTree,
  options: SubagentTreeLayoutOptions = {},
): SubagentTreeLayout {
  const siblingGap = options.siblingGap ?? SUBAGENT_TREE_SIBLING_GAP;
  const columnGap = options.columnGap ?? SUBAGENT_TREE_COLUMN_GAP;
  const focused = window.focusedNode
    ? tree.nodes.get(window.focusedNode.id)
    : undefined;
  const useAncestorsCard = Boolean(
    focused && window.foldedAncestors.length > 0,
  );
  const anchorId = useAncestorsCard ? 'ancestors' : 'root';
  const anchor: MutableLayoutNode = useAncestorsCard
    ? {
        id: 'ancestors',
        target: { kind: 'ancestors' },
        width: SUBAGENT_TREE_ANCESTORS_WIDTH,
        height: SUBAGENT_TREE_ANCESTORS_HEIGHT,
        children: [],
        edgeDashed: false,
        skipRanks: 0,
      }
    : {
        id: 'root',
        target: { kind: 'root' },
        width: SUBAGENT_TREE_ROOT_WIDTH,
        height: SUBAGENT_TREE_ROOT_HEIGHT,
        children: [],
        edgeDashed: false,
        skipRanks: 0,
      };
  const nodesById = new Map<string, MutableLayoutNode>();
  addLayoutNode(nodesById, anchor);
  addWindowItems(window.items, anchorId, nodesById);

  const depthFirstIds: string[] = [];
  const traversal: string[] = [anchorId];
  while (traversal.length > 0) {
    const currentId = traversal.pop();
    if (currentId === undefined) continue;
    const current = nodesById.get(currentId);
    if (!current) continue;
    depthFirstIds.push(currentId);
    for (let index = current.children.length - 1; index >= 0; index -= 1) {
      const childId = current.children[index];
      if (childId !== undefined) traversal.push(childId);
    }
  }

  const subtreeSpanById = new Map<string, number>();
  for (let index = depthFirstIds.length - 1; index >= 0; index -= 1) {
    const id = depthFirstIds[index];
    const current = id === undefined ? undefined : nodesById.get(id);
    if (!current) continue;
    let childSpan = 0;
    for (const childId of current.children) {
      childSpan += subtreeSpanById.get(childId) ?? 0;
    }
    if (current.children.length > 1) {
      childSpan += siblingGap * (current.children.length - 1);
    }
    subtreeSpanById.set(current.id, Math.max(current.height, childSpan));
  }

  const placedById = new Map<string, PlacedTreeNode>();
  const placements: PlacementFrame[] = [{ id: anchorId, x: 0, crossStart: 0 }];
  while (placements.length > 0) {
    const frame = placements.pop();
    if (!frame) continue;
    const current = nodesById.get(frame.id);
    if (!current) continue;
    const currentSpan = subtreeSpanById.get(current.id) ?? current.height;
    const y = frame.crossStart + (currentSpan - current.height) / 2;
    placedById.set(current.id, { id: current.id, x: frame.x, y });

    let childrenSpan = 0;
    for (const childId of current.children) {
      childrenSpan += subtreeSpanById.get(childId) ?? 0;
    }
    if (current.children.length > 1) {
      childrenSpan += siblingGap * (current.children.length - 1);
    }
    let crossStart = frame.crossStart + (currentSpan - childrenSpan) / 2;
    const childrenFrames: PlacementFrame[] = [];
    for (const childId of current.children) {
      const child = nodesById.get(childId);
      if (!child) continue;
      const childSpan = subtreeSpanById.get(child.id) ?? child.height;
      const x =
        frame.x +
        current.width +
        columnGap +
        liveWindowCardDepth(child) * (SUBAGENT_TREE_NODE_WIDTH + columnGap);
      childrenFrames.push({ id: child.id, x, crossStart });
      crossStart += childSpan + siblingGap;
    }
    for (let index = childrenFrames.length - 1; index >= 0; index -= 1) {
      const childFrame = childrenFrames[index];
      if (childFrame) placements.push(childFrame);
    }
  }

  const layoutNodes: SubagentTreeLayoutNode[] = [];
  const edges: SubagentTreeLayoutEdge[] = [];
  const targetByCanvasId = new Map<string, SubagentCanvasTarget>();
  for (const id of depthFirstIds) {
    const source = nodesById.get(id);
    const placed = placedById.get(id);
    if (!source || !placed) continue;
    layoutNodes.push({
      id: source.id,
      target: source.target,
      x: placed.x,
      y: placed.y,
      width: source.width,
      height: source.height,
    });
    targetByCanvasId.set(source.id, source.target);
    for (const childId of source.children) {
      const child = nodesById.get(childId);
      if (!child) continue;
      edges.push({
        id: `${source.id}->${child.id}`,
        source: source.id,
        target: child.id,
        ...(child.edgeDashed ? { dashed: true } : {}),
        ...(child.edgeLabel ? { label: child.edgeLabel } : {}),
      });
    }
  }

  return { nodes: layoutNodes, edges, targetByCanvasId };
}

/** Applies the shared Auto window formula using this panel's standard sizes. */
export function autoLevelsForCanvasWidth(
  canvasWidth: number,
  maxDepth: number,
): number {
  const normalizedMaxDepth = Number.isFinite(maxDepth)
    ? Math.max(3, Math.floor(maxDepth))
    : 10;
  return autoSubagentLevelCount({
    canvasWidth,
    rootWidth: SUBAGENT_TREE_ROOT_WIDTH,
    nodeWidth: SUBAGENT_TREE_NODE_WIDTH,
    columnGap: SUBAGENT_TREE_COLUMN_GAP,
    stubWidth: SUBAGENT_TREE_STUB_WIDTH,
    padding: SUBAGENT_TREE_AUTO_PADDING,
    min: 3,
    max: normalizedMaxDepth,
  });
}
