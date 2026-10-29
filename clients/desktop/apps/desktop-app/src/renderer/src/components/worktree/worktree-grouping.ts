import type { WorktreeData } from '@canopy/desktop-shared/types';
import {
  resolveTrackedBaseBranchFallback,
  resolveWorktreeGroupingParentId,
} from '@canopy/desktop-shared/lib/worktree-grouping';

export { resolveTrackedBaseBranchFallback };

/**
 * Pure logic for the sidebar's child-branch grouping. A worktree is a "child"
 * when its resolved base branch is another (non-default) worktree's branch. We
 * visually nest children under the nearest *top-level* ancestor in their
 * base-branch chain. By default a deep chain flattens under its single top-most
 * ancestor, but when an intermediate parent is explicitly ungrouped it becomes
 * a new top-level grouping root and carries its descendants with it. The repo's
 * default branch is never treated as a parent, even when it is itself open in a
 * worktree.
 *
 * Grouping is governed by the global `groupChildBranchesWithBase` preference,
 * which each worktree can override via {@link WorktreeData.branchGroupingOverride}.
 *
 * This module has no React/IPC dependencies so it can be unit-tested directly.
 */

export interface WorktreeGroupingInput {
  /** Worktrees in display order for this grouping pass. */
  worktrees: WorktreeData[];
  /** Resolved base branch name per worktree id (null/undefined when unknown). */
  baseBranchByWorktreeId: Map<string, string | null | undefined>;
  /**
   * Repo default branch names for this project. Worktrees on these branches are
   * excluded from parent consideration so children of the default branch stay
   * at the top level.
   */
  defaultBranchNames: Set<string>;
  /** Global preference: nest child branches under their base-branch worktree. */
  groupingEnabled: boolean;
}

/** A top-level sidebar entry plus any child worktrees nested beneath it. */
export interface WorktreeGroupEntry {
  worktree: WorktreeData;
  /** Children nested under this entry, in display order. Empty when none. */
  children: WorktreeData[];
}

/** Per-worktree grouping state used to drive the context-menu toggle. */
export interface WorktreeGroupingState {
  /** Whether the worktree currently renders nested under a parent. */
  isChild: boolean;
  /**
   * Whether the worktree has an eligible base-branch parent at all. When false,
   * the worktree cannot itself be grouped under another worktree.
   */
  hasEligibleParent: boolean;
  /** The direct parent worktree id (nearest base-branch ancestor), if any. */
  parentWorktreeId: string | null;
  /** The top-level ancestor worktree id this worktree nests under, if grouped. */
  rootWorktreeId: string | null;
  /**
   * Whether at least one other worktree has this worktree's branch as its base
   * branch (i.e. this worktree is structurally a parent), regardless of whether
   * those children are currently grouped.
   */
  hasStructuralChildren: boolean;
  /** Worktree ids currently nested directly under this worktree. */
  nestedChildIds: string[];
  /**
   * Hops from this worktree up to its top-most non-default base-branch
   * ancestor. `0` for a root or a worktree based directly on a default branch.
   * Reflects the true base-branch chain, independent of grouping overrides.
   */
  ancestryDepth: number;
  /**
   * The top-most non-default base-branch ancestor id, or `null` when
   * {@link ancestryDepth} is `0`.
   */
  topMostAncestorId: string | null;
}

export interface WorktreeGroupingResult {
  /** Ordered top-level entries with their nested children. */
  entries: WorktreeGroupEntry[];
  /** Per-worktree grouping state keyed by worktree id. */
  stateByWorktreeId: Map<string, WorktreeGroupingState>;
  /** Direct structural children (worktrees based on this one), keyed by id. */
  structuralChildIdsByWorktreeId: Map<string, string[]>;
}

/**
 * Reorders the visible slots in `worktrees` to match the sidebar's current
 * rendered order. Hidden worktrees keep their slots because they are rendered
 * in a separate section and are not part of the visible grouping pass.
 *
 * This is used immediately before a grouping relationship disappears. A child
 * worktree's persisted slot is unrelated to where it renders under its parent
 * (new worktrees are inserted at the top), so retaining the raw persisted
 * order would otherwise make it jump across the list when it becomes a
 * top-level row. Hidden worktrees can be included when an all-hidden
 * workspace renders them through the same grouping pass.
 */
export function flattenVisibleWorktreeGroupOrder(
  worktrees: WorktreeData[],
  grouping: Pick<WorktreeGroupingResult, 'entries'>,
  options?: { includeHidden?: boolean },
): WorktreeData[] {
  const flattenedVisible = grouping.entries.flatMap((entry) => [
    entry.worktree,
    ...entry.children,
  ]);
  let visibleIndex = 0;

  return worktrees.map((worktree) => {
    if (worktree.hidden && options?.includeHidden !== true) {
      return worktree;
    }
    const next = flattenedVisible[visibleIndex];
    visibleIndex += 1;
    return next ?? worktree;
  });
}

/**
 * Resolves the direct base-branch parent for each worktree. Returns `null` when
 * the worktree has no eligible parent (base unknown, base is a default branch,
 * base matches no other worktree, or base resolves to itself).
 */
function computeDirectParents(
  input: WorktreeGroupingInput,
): Map<string, string | null> {
  const directParents = new Map<string, string | null>();
  for (const worktree of input.worktrees) {
    const baseBranch = input.baseBranchByWorktreeId.get(worktree.id);
    const parentWorktreeId = resolveWorktreeGroupingParentId(
      worktree,
      input.worktrees,
      baseBranch,
    );
    const usesRetainedParent =
      parentWorktreeId === worktree.branchGroupingParentWorktreeId;
    directParents.set(
      worktree.id,
      !usesRetainedParent &&
        baseBranch &&
        input.defaultBranchNames.has(baseBranch.trim())
        ? null
        : parentWorktreeId,
    );
  }
  return directParents;
}

export function computeWorktreeGroups(
  input: WorktreeGroupingInput,
): WorktreeGroupingResult {
  const directParents = computeDirectParents(input);

  // Resolve each worktree's true base-branch ancestry depth and top-most
  // ancestor. Memoized so shared chain suffixes are walked only once (O(n)).
  // The in-progress stack breaks accidental cycles and suppresses badges for
  // any worktree in, or pointing into, the corrupted chain.
  type AncestryResolution = {
    depth: number;
    topMostId: string | null;
    hasCycle: boolean;
  };
  const rootAncestry: AncestryResolution = {
    depth: 0,
    topMostId: null,
    hasCycle: false,
  };
  const cyclicAncestry: AncestryResolution = {
    depth: 0,
    topMostId: null,
    hasCycle: true,
  };
  const ancestryCache = new Map<string, AncestryResolution>();
  const ancestryStack: string[] = [];
  const inProgress = new Map<string, number>();
  const resolveAncestry = (worktreeId: string): AncestryResolution => {
    const cached = ancestryCache.get(worktreeId);
    if (cached) {
      return cached;
    }
    const parent = directParents.get(worktreeId) ?? null;
    if (parent === null) {
      ancestryCache.set(worktreeId, rootAncestry);
      return rootAncestry;
    }

    const currentIndex = ancestryStack.length;
    ancestryStack.push(worktreeId);
    inProgress.set(worktreeId, currentIndex);

    const parentCycleIndex = inProgress.get(parent);
    let result: AncestryResolution;
    if (parentCycleIndex !== undefined) {
      for (const cyclicId of ancestryStack.slice(parentCycleIndex)) {
        ancestryCache.set(cyclicId, cyclicAncestry);
      }
      result = ancestryCache.get(worktreeId) ?? cyclicAncestry;
    } else {
      const parentAncestry = resolveAncestry(parent);
      const cachedAfterParent = ancestryCache.get(worktreeId);
      if (cachedAfterParent) {
        result = cachedAfterParent;
      } else if (parentAncestry.hasCycle) {
        result = cyclicAncestry;
      } else {
        result = {
          depth: parentAncestry.depth + 1,
          topMostId: parentAncestry.topMostId ?? parent,
          hasCycle: false,
        };
      }
    }

    inProgress.delete(worktreeId);
    ancestryStack.pop();
    ancestryCache.set(worktreeId, result);
    return result;
  };

  // Whether a worktree (with an eligible parent) opts into nesting under it.
  const groupedDecision = new Map<string, boolean>();
  for (const worktree of input.worktrees) {
    if ((directParents.get(worktree.id) ?? null) === null) {
      groupedDecision.set(worktree.id, false);
      continue;
    }
    const override = worktree.branchGroupingOverride;
    groupedDecision.set(
      worktree.id,
      override === 'group'
        ? true
        : override === 'ungroup'
          ? false
          : input.groupingEnabled,
    );
  }

  // Direct structural children (worktrees whose base is this worktree's branch).
  const structuralChildIdsByWorktreeId = new Map<string, string[]>();
  for (const worktree of input.worktrees) {
    const parentId = directParents.get(worktree.id) ?? null;
    if (!parentId) {
      continue;
    }
    const bucket = structuralChildIdsByWorktreeId.get(parentId);
    if (bucket) {
      bucket.push(worktree.id);
    } else {
      structuralChildIdsByWorktreeId.set(parentId, [worktree.id]);
    }
  }

  // Resolve, for each worktree, the nearest top-level ancestor it nests under.
  // Returns null when the worktree is itself top-level or a cycle prevents
  // resolving a top-level root.
  const resolveAttachmentRoot = (worktreeId: string): string | null => {
    const visited = new Set<string>([worktreeId]);
    let current = worktreeId;
    for (;;) {
      const parent = directParents.get(current) ?? null;
      // `current` is top-level when it has no parent or opts out of nesting.
      const currentIsTopLevel =
        parent === null || groupedDecision.get(current) !== true;
      if (currentIsTopLevel) {
        return current === worktreeId ? null : current;
      }
      // `current` nests into `parent`; keep walking toward a top-level node.
      if (parent === null || visited.has(parent)) {
        return null;
      }
      visited.add(parent);
      current = parent;
    }
  };

  const rootById = new Map<string, string | null>();
  for (const worktree of input.worktrees) {
    rootById.set(worktree.id, resolveAttachmentRoot(worktree.id));
  }

  // Build children buckets keyed by attachment root, preserving array order.
  const childrenByRoot = new Map<string, WorktreeData[]>();
  for (const worktree of input.worktrees) {
    const rootId = rootById.get(worktree.id) ?? null;
    if (!rootId) {
      continue;
    }
    const bucket = childrenByRoot.get(rootId);
    if (bucket) {
      bucket.push(worktree);
    } else {
      childrenByRoot.set(rootId, [worktree]);
    }
  }
  // New worktrees lead the manual order, so a chain created in sequence
  // arrives grandchild-first. A stable sort by depth keeps every parent above
  // its descendants while rows at the same depth keep their array order.
  childrenByRoot.forEach((bucket) => {
    bucket.sort(
      (left, right) =>
        resolveAncestry(left.id).depth - resolveAncestry(right.id).depth,
    );
  });

  const stateByWorktreeId = new Map<string, WorktreeGroupingState>();
  const entries: WorktreeGroupEntry[] = [];
  for (const worktree of input.worktrees) {
    const parentId = directParents.get(worktree.id) ?? null;
    const rootId = rootById.get(worktree.id) ?? null;
    const isChild = rootId !== null;
    const nestedChildren = childrenByRoot.get(worktree.id) ?? [];
    const ancestry = resolveAncestry(worktree.id);
    stateByWorktreeId.set(worktree.id, {
      isChild,
      hasEligibleParent: parentId !== null,
      parentWorktreeId: parentId,
      rootWorktreeId: rootId,
      hasStructuralChildren:
        (structuralChildIdsByWorktreeId.get(worktree.id)?.length ?? 0) > 0,
      nestedChildIds: nestedChildren.map((child) => child.id),
      ancestryDepth: ancestry.depth,
      topMostAncestorId: ancestry.topMostId,
    });
    if (isChild) {
      continue;
    }
    entries.push({ worktree, children: nestedChildren });
  }

  return { entries, stateByWorktreeId, structuralChildIdsByWorktreeId };
}

/**
 * Collects every structural descendant id of `worktreeId` (children, their
 * children, and so on), guarding against cycles. Used by the parent-worktree
 * "Group children" / "Ungroup children" actions.
 */
export function collectStructuralDescendantIds(
  worktreeId: string,
  structuralChildIdsByWorktreeId: Map<string, string[]>,
): string[] {
  const descendants: string[] = [];
  const visited = new Set<string>([worktreeId]);
  const queue = [...(structuralChildIdsByWorktreeId.get(worktreeId) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined || visited.has(next)) {
      continue;
    }
    visited.add(next);
    descendants.push(next);
    queue.push(...(structuralChildIdsByWorktreeId.get(next) ?? []));
  }
  return descendants;
}
