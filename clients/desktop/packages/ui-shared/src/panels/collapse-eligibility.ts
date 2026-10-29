/**
 * Pure collapse-eligibility algorithm for the panel grid.
 *
 * Leaves collapse on their parent's axis. A branch with no expanded leaves
 * becomes one bar on its own parent's axis. The root retains an expanded leaf.
 *
 * Batch affordances share one O(nodes) index. Geometry comes from the engine;
 * no DOM measurement or pixel-matching between unrelated branches is needed.
 *
 * Engine-layer purity: no React, no stores, no runtime deps; the
 * `@canopy/protocol` import is type-only.
 */

import type { PanelCollapseEdge } from '@canopy/protocol';
import {
  type Grid,
  type GridNode,
  type IView,
  isGridBranchNode,
  Orientation,
} from './grid';

/**
 * Fixed extent, in px, of a collapsed group's bar along its collapse axis.
 *
 * Sized so a collapsed BOTTOM bar's top hairline lands on the same line as the
 * sidebar account section's divider, since the two sit edge to edge along the
 * window's bottom: the account band is its `border-t` plus 8px, a 32px row and
 * the footer's 8px bottom padding. That makes it 1.5px taller than the
 * expanded title bar (46.5px), so a bottom group's controls shift by that much
 * when it collapses — the cross-surface alignment reads as the more visible of
 * the two.
 */
export const PANEL_COLLAPSED_BAR_SIZE = 48;

/** Border-adjacency tolerance, in px, for layout rounding. */
const COLLAPSE_BORDER_EPSILON = 1;

/**
 * Layout axis of a branch: `'horizontal'` lays children side by side
 * (splitview HORIZONTAL); `'vertical'` stacks them (splitview VERTICAL).
 */
export type CollapseBranchOrientation = 'horizontal' | 'vertical';

/** Absolute box of a node within the laid-out grid, in px. */
export interface CollapseNodeBox {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface CollapseSnapshotLeaf {
  readonly type: 'leaf';
  readonly groupId: string;
  readonly box: CollapseNodeBox;
  /** Edge this leaf is currently collapsed toward, or `null` if expanded. */
  readonly collapsedEdge: PanelCollapseEdge | null;
  readonly tabCount: number;
}

export interface CollapseSnapshotBranch {
  readonly type: 'branch';
  readonly orientation: CollapseBranchOrientation;
  readonly children: readonly CollapseSnapshotNode[];
}

export type CollapseSnapshotNode =
  | CollapseSnapshotLeaf
  | CollapseSnapshotBranch;

/** Geometry + collapse-state snapshot of one grid container. */
export interface CollapseSnapshot {
  readonly root: CollapseSnapshotNode;
  readonly width: number;
  readonly height: number;
}

/** The collapse affordance of one group, driving chrome rendering. */
export type PanelCollapseAffordance =
  | { readonly state: 'none' }
  | {
      readonly state: 'enabled';
      readonly edge: PanelCollapseEdge;
      readonly branchEdge?: PanelCollapseEdge;
    }
  | { readonly state: 'blocked'; readonly edge: PanelCollapseEdge };

const NONE: PanelCollapseAffordance = { state: 'none' };

/** The axis a collapse toward `edge` shrinks the panel along. */
export function collapseEdgeAxis(
  edge: PanelCollapseEdge,
): CollapseBranchOrientation {
  return edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical';
}

interface LeafLookup {
  readonly leaf: CollapseSnapshotLeaf;
  readonly parent: CollapseSnapshotBranch | null;
  readonly index: number;
}

interface CollapseIndex {
  readonly leaves: ReadonlyMap<string, LeafLookup>;
  readonly parents: ReadonlyMap<
    CollapseSnapshotNode,
    { parent: CollapseSnapshotBranch; index: number }
  >;
  readonly expanded: ReadonlyMap<CollapseSnapshotNode, number>;
  readonly recipients: ReadonlyMap<CollapseSnapshotNode, CollapseSnapshotNode>;
  readonly firstExpanded: ReadonlyMap<
    CollapseSnapshotNode,
    CollapseSnapshotLeaf
  >;
}

function currentEdge(
  leaf: CollapseSnapshotLeaf,
  overrides: ReadonlyMap<string, PanelCollapseEdge | null>,
): PanelCollapseEdge | null {
  return overrides.has(leaf.groupId)
    ? (overrides.get(leaf.groupId) ?? null)
    : leaf.collapsedEdge;
}

function indexSnapshot(
  snapshot: CollapseSnapshot,
  overrides: ReadonlyMap<string, PanelCollapseEdge | null>,
): CollapseIndex {
  const leaves = new Map<string, LeafLookup>();
  const parents = new Map<
    CollapseSnapshotNode,
    { parent: CollapseSnapshotBranch; index: number }
  >();
  const expanded = new Map<CollapseSnapshotNode, number>();
  const recipients = new Map<CollapseSnapshotNode, CollapseSnapshotNode>();
  const firstExpanded = new Map<CollapseSnapshotNode, CollapseSnapshotLeaf>();
  const visit = (
    node: CollapseSnapshotNode,
    parent: CollapseSnapshotBranch | null,
    index: number,
  ): number => {
    if (parent !== null) parents.set(node, { parent, index });
    if (node.type === 'leaf') {
      leaves.set(node.groupId, { leaf: node, parent, index });
      const count = currentEdge(node, overrides) === null ? 1 : 0;
      expanded.set(node, count);
      if (count > 0) firstExpanded.set(node, node);
      return count;
    }
    let count = 0;
    node.children.forEach((child, i) => {
      count += visit(child, node, i);
      const first = firstExpanded.get(child);
      if (!firstExpanded.has(node) && first !== undefined)
        firstExpanded.set(node, first);
    });
    let previous: CollapseSnapshotNode | undefined;
    for (const child of node.children) {
      if (previous !== undefined) recipients.set(child, previous);
      if ((expanded.get(child) ?? 0) > 0) previous = child;
    }
    let following: CollapseSnapshotNode | undefined;
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i];
      if (following !== undefined) recipients.set(child, following);
      if ((expanded.get(child) ?? 0) > 0) following = child;
    }
    for (let i = 0; i < node.children.length; i++) {
      const next = node.children[i + 1];
      const previous = node.children[i - 1];
      if (next !== undefined && (expanded.get(next) ?? 0) > 0)
        recipients.set(node.children[i], next);
      else if (previous !== undefined && (expanded.get(previous) ?? 0) > 0)
        recipients.set(node.children[i], previous);
    }
    expanded.set(node, count);
    return count;
  };
  visit(snapshot.root, null, 0);
  return { leaves, parents, expanded, firstExpanded, recipients };
}

function recipient(
  index: CollapseIndex,
  parent: CollapseSnapshotBranch,
  position: number,
): CollapseSnapshotNode | undefined {
  return index.recipients.get(parent.children[position]);
}

function edgeFor(
  parent: CollapseSnapshotBranch,
  position: number,
  receiving?: number,
): PanelCollapseEdge {
  const following =
    receiving === undefined
      ? position < parent.children.length - 1
      : receiving > position;
  return parent.orientation === 'horizontal'
    ? following
      ? 'left'
      : 'right'
    : following
      ? 'top'
      : 'bottom';
}

function touchesBorder(
  snapshot: CollapseSnapshot,
  box: CollapseNodeBox,
  edge: PanelCollapseEdge,
): boolean {
  switch (edge) {
    case 'left':
      return box.left <= COLLAPSE_BORDER_EPSILON;
    case 'right':
      return (
        Math.abs(box.left + box.width - snapshot.width) <=
        COLLAPSE_BORDER_EPSILON
      );
    case 'top':
      return box.top <= COLLAPSE_BORDER_EPSILON;
    case 'bottom':
      return (
        Math.abs(box.top + box.height - snapshot.height) <=
        COLLAPSE_BORDER_EPSILON
      );
  }
}

function borderEdges(
  snapshot: CollapseSnapshot,
  found: LeafLookup,
): readonly PanelCollapseEdge[] {
  const candidates: readonly PanelCollapseEdge[] =
    found.parent?.orientation === 'horizontal'
      ? ['left', 'right']
      : ['top', 'bottom'];
  return candidates.filter((edge) =>
    touchesBorder(snapshot, found.leaf.box, edge),
  );
}

function affordanceWithOverrides(
  snapshot: CollapseSnapshot,
  groupId: string,
  overrides: ReadonlyMap<string, PanelCollapseEdge | null>,
  index: CollapseIndex,
  requestedEdge?: PanelCollapseEdge,
): PanelCollapseAffordance {
  const found = index.leaves.get(groupId);
  if (found === undefined || found.parent === null) return NONE;
  const { leaf, parent } = found;
  const collapsed = currentEdge(leaf, overrides);
  if (collapsed !== null) return { state: 'enabled', edge: collapsed };
  if (leaf.tabCount === 0 || parent.children.length < 2) return NONE;

  const borders = borderEdges(snapshot, found);
  const receiving = recipient(index, parent, found.index);
  const edge =
    borders[0] ??
    edgeFor(
      parent,
      found.index,
      receiving === undefined ? undefined : index.parents.get(receiving)?.index,
    );
  if (
    requestedEdge !== undefined &&
    collapseEdgeAxis(requestedEdge) !== parent.orientation
  )
    return NONE;
  const resolvedEdge = requestedEdge ?? edge;
  if ((index.expanded.get(snapshot.root) ?? 0) <= 1)
    return { state: 'blocked', edge: resolvedEdge };
  let target: CollapseSnapshotNode = leaf;
  let location = index.parents.get(target);
  while (
    location !== undefined &&
    location.parent !== snapshot.root &&
    index.expanded.get(location.parent) === 1
  ) {
    target = location.parent;
    location = index.parents.get(target);
  }
  if (target.type === 'branch' && location !== undefined) {
    return {
      state: 'enabled',
      edge: resolvedEdge,
      branchEdge: edgeFor(
        location.parent,
        location.index,
        index.parents.get(
          recipient(index, location.parent, location.index) ?? target,
        )?.index,
      ),
    };
  }
  return { state: 'enabled', edge: resolvedEdge };
}

/** Computes every group's affordance with one linear tree traversal. */
export function getCollapseAffordances(
  snapshot: CollapseSnapshot,
): ReadonlyMap<string, PanelCollapseAffordance> {
  const overrides = new Map<string, PanelCollapseEdge | null>();
  const index = indexSnapshot(snapshot, overrides);
  const result = new Map<string, PanelCollapseAffordance>();
  for (const groupId of index.leaves.keys()) {
    result.set(
      groupId,
      affordanceWithOverrides(snapshot, groupId, overrides, index),
    );
  }
  return result;
}

/** Computes the collapse affordance of `groupId` against the snapshot. */
export function getCollapseAffordance(
  snapshot: CollapseSnapshot,
  groupId: string,
): PanelCollapseAffordance {
  const overrides = new Map<string, PanelCollapseEdge | null>();
  return affordanceWithOverrides(
    snapshot,
    groupId,
    overrides,
    indexSnapshot(snapshot, overrides),
  );
}

/**
 * Preferred expanded sibling subtree for an INNER collapse/expand operation.
 * Outer panels keep the engine's existing distribution policy. On expand,
 * prefer the saved direction, falling back if that sibling is now collapsed.
 */
export function getInnerCollapseSibling(
  snapshot: CollapseSnapshot,
  groupId: string,
  edge: PanelCollapseEdge,
): string | null {
  const overrides = new Map<string, PanelCollapseEdge | null>();
  const index = indexSnapshot(snapshot, overrides);
  const found = index.leaves.get(groupId);
  if (
    found === undefined ||
    found.parent === null ||
    collapseEdgeAxis(edge) !== found.parent.orientation ||
    borderEdges(snapshot, found).length > 0
  )
    return null;
  const siblings = found.parent.children;
  const direction = edge === 'left' || edge === 'top' ? 1 : -1;
  let receiving: CollapseSnapshotNode | undefined;
  for (
    let i = found.index + direction;
    i >= 0 && i < siblings.length;
    i += direction
  ) {
    if ((index.expanded.get(siblings[i]) ?? 0) > 0) {
      receiving = siblings[i];
      break;
    }
  }
  receiving ??= recipient(index, found.parent, found.index);
  return receiving === undefined
    ? null
    : (index.firstExpanded.get(receiving)?.groupId ?? null);
}

/**
 * Replay persisted claims with all requested leaves provisionally expanded.
 * Invalid claims degrade to expanded. Restore is infrequent; each accepted
 * claim gets a fresh index so subsequent claims see the updated constraints.
 */
export function planRestoredCollapses(
  snapshot: CollapseSnapshot,
  requested: ReadonlyMap<string, PanelCollapseEdge>,
): ReadonlyMap<string, PanelCollapseEdge> {
  const accepted = new Map<string, PanelCollapseEdge>();
  const overrides = new Map<string, PanelCollapseEdge | null>();
  for (const groupId of requested.keys()) overrides.set(groupId, null);
  for (const [groupId, edge] of requested) {
    const affordance = affordanceWithOverrides(
      snapshot,
      groupId,
      overrides,
      indexSnapshot(snapshot, overrides),
      edge,
    );
    if (affordance.state === 'enabled') {
      accepted.set(groupId, edge);
      overrides.set(groupId, edge);
    }
  }
  return accepted;
}

/** Per-leaf metadata resolver used by {@link buildCollapseSnapshotFromGrid}. */
export interface CollapseLeafMeta {
  readonly collapsedEdge: PanelCollapseEdge | null;
  readonly tabCount: number;
}

/**
 * Builds a {@link CollapseSnapshot} from a live grid. Returns `null` before
 * the grid's first real layout (zero-sized root box). The grid's own
 * `orientation` is the root branch axis; children alternate with depth.
 */
export function buildCollapseSnapshotFromGrid<
  T extends IView & { readonly id: string },
>(
  grid: Grid<T>,
  getLeafMeta: (groupId: string) => CollapseLeafMeta,
): CollapseSnapshot | null {
  const rootNode = grid.getViews();
  const { width, height } = rootNode.box;
  if (width <= 0 || height <= 0) {
    return null;
  }
  const rootOrientation: CollapseBranchOrientation =
    grid.orientation === Orientation.HORIZONTAL ? 'horizontal' : 'vertical';

  const convert = (
    node: GridNode<T>,
    orientation: CollapseBranchOrientation,
  ): CollapseSnapshotNode => {
    if (isGridBranchNode(node)) {
      const childOrientation: CollapseBranchOrientation =
        orientation === 'horizontal' ? 'vertical' : 'horizontal';
      return {
        type: 'branch',
        orientation,
        children: node.children.map((child) =>
          convert(child, childOrientation),
        ),
      };
    }
    const meta = getLeafMeta(node.view.id);
    return {
      type: 'leaf',
      groupId: node.view.id,
      box: node.box,
      collapsedEdge: meta.collapsedEdge,
      tabCount: meta.tabCount,
    };
  };

  return { root: convert(rootNode, rootOrientation), width, height };
}
