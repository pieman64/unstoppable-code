export interface BranchGroupingNode {
  readonly id: string;
  readonly branch: string;
  readonly baseBranch?: string | null;
  readonly retainedParentId?: string | null;
  readonly groupingOverride?: 'group' | 'ungroup' | null;
}

export interface BranchGroupingState {
  readonly isChild: boolean;
  readonly hasEligibleParent: boolean;
  readonly parentId: string | null;
  readonly rootId: string | null;
  readonly hasStructuralChildren: boolean;
  readonly nestedChildIds: readonly string[];
  readonly ancestryDepth: number;
  readonly topMostAncestorId: string | null;
}

export interface BranchGroup<T extends BranchGroupingNode> {
  readonly node: T;
  readonly children: readonly T[];
}

export interface BranchGroupingResult<T extends BranchGroupingNode> {
  readonly groups: readonly BranchGroup<T>[];
  readonly stateById: ReadonlyMap<string, BranchGroupingState>;
  readonly structuralChildIdsById: ReadonlyMap<string, readonly string[]>;
}

const normalized = (value: string | null | undefined): string | null =>
  value?.trim() || null;

/** Browser-safe canonical branch-group algorithm shared by desktop and web UI. */
export function computeBranchGroups<T extends BranchGroupingNode>(
  nodes: readonly T[],
  defaultBranches: ReadonlySet<string>,
  groupingEnabled: boolean,
): BranchGroupingResult<T> {
  const ids = new Set(nodes.map((node) => node.id));
  const idsByBranch = new Map<string, string[]>();
  for (const node of nodes) {
    const branch = normalized(node.branch);
    if (branch) {
      const branchIds = idsByBranch.get(branch);
      if (branchIds) branchIds.push(node.id);
      else idsByBranch.set(branch, [node.id]);
    }
  }
  const parentById = new Map<string, string | null>();
  for (const node of nodes) {
    const retained =
      node.retainedParentId &&
      node.retainedParentId !== node.id &&
      ids.has(node.retainedParentId)
        ? node.retainedParentId
        : null;
    const base = normalized(node.baseBranch);
    // Nodes arrive in sidebar sort order. If branch names collide, preserve
    // the desktop `find` semantics by choosing the first other node in that
    // order, while the branch index keeps all parent lookups linear overall.
    const matched = base
      ? idsByBranch.get(base)?.find((candidateId) => candidateId !== node.id)
      : undefined;
    parentById.set(
      node.id,
      retained ??
        (base && !defaultBranches.has(base) ? (matched ?? null) : null),
    );
  }

  const grouped = new Map<string, boolean>();
  for (const node of nodes) {
    grouped.set(
      node.id,
      parentById.get(node.id) != null &&
        (node.groupingOverride === 'group' ||
          (node.groupingOverride !== 'ungroup' && groupingEnabled)),
    );
  }

  const structural = new Map<string, string[]>();
  for (const node of nodes) {
    const parent = parentById.get(node.id);
    if (parent)
      structural.set(parent, [...(structural.get(parent) ?? []), node.id]);
  }

  const rootById = new Map<string, string | null>();
  for (const node of nodes) {
    const seen = new Set([node.id]);
    let current = node.id;
    let root: string | null = null;
    while (grouped.get(current) === true) {
      const parent = parentById.get(current) ?? null;
      if (!parent || seen.has(parent)) {
        root = null;
        break;
      }
      root = parent;
      seen.add(parent);
      current = parent;
    }
    rootById.set(node.id, root);
  }

  const childrenByRoot = new Map<string, T[]>();
  for (const node of nodes) {
    const root = rootById.get(node.id);
    if (root)
      childrenByRoot.set(root, [...(childrenByRoot.get(root) ?? []), node]);
  }

  const ancestry = (id: string): { depth: number; top: string | null } => {
    const seen = new Set([id]);
    let current = id;
    let depth = 0;
    let top: string | null = null;
    for (;;) {
      const parent = parentById.get(current) ?? null;
      if (!parent) return { depth, top };
      if (seen.has(parent)) return { depth: 0, top: null };
      seen.add(parent);
      depth += 1;
      top = parent;
      current = parent;
    }
  };

  // New worktrees lead the manual order, so a chain created in sequence
  // arrives grandchild-first. A stable sort by depth keeps every parent above
  // its descendants while rows at the same depth keep their input order.
  childrenByRoot.forEach((children) => {
    children.sort(
      (left, right) => ancestry(left.id).depth - ancestry(right.id).depth,
    );
  });

  const stateById = new Map<string, BranchGroupingState>();
  const groups: BranchGroup<T>[] = [];
  for (const node of nodes) {
    const rootId = rootById.get(node.id) ?? null;
    const nested = childrenByRoot.get(node.id) ?? [];
    const chain = ancestry(node.id);
    stateById.set(node.id, {
      isChild: rootId !== null,
      hasEligibleParent: parentById.get(node.id) != null,
      parentId: parentById.get(node.id) ?? null,
      rootId,
      hasStructuralChildren: (structural.get(node.id)?.length ?? 0) > 0,
      nestedChildIds: nested.map((child) => child.id),
      ancestryDepth: chain.depth,
      topMostAncestorId: chain.top,
    });
    if (!rootId) groups.push({ node, children: nested });
  }
  return { groups, stateById, structuralChildIdsById: structural };
}

export function collectBranchGroupingDescendantIds(
  id: string,
  childrenById: ReadonlyMap<string, readonly string[]>,
): string[] {
  const result: string[] = [];
  const seen = new Set([id]);
  const queue = [...(childrenById.get(id) ?? [])];
  while (queue.length) {
    const next = queue.shift();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    result.push(next);
    queue.push(...(childrenById.get(next) ?? []));
  }
  return result;
}
