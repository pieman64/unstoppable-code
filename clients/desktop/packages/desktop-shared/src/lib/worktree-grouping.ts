import { WORKSPACE_ROOT_REPO_ID, type WorktreeData } from '../types';

function normalizeBranch(branch: string | null | undefined): string | null {
  const trimmed = branch?.trim();
  return trimmed ? trimmed : null;
}

export function resolveTrackedBaseBranchFallback(
  projectType: 'single-repo' | 'multi-repo',
  worktree: Pick<WorktreeData, 'trackedBaseBranch' | 'trackedRepoBaseBranches'>,
): string | null {
  const repoBaseBranches = worktree.trackedRepoBaseBranches;
  if (projectType === 'multi-repo' && repoBaseBranches) {
    return (
      repoBaseBranches[WORKSPACE_ROOT_REPO_ID] ??
      Object.values(repoBaseBranches)[0] ??
      null
    );
  }
  return worktree.trackedBaseBranch ?? null;
}

/**
 * Resolves a worktree's direct visual parent from the same sibling set.
 * A valid retained override takes precedence over a base-branch match.
 */
export function resolveWorktreeGroupingParentId(
  worktree: Pick<WorktreeData, 'id' | 'branchGroupingParentWorktreeId'>,
  siblingWorktrees: ReadonlyArray<Pick<WorktreeData, 'id' | 'branchName'>>,
  resolvedBaseBranch: string | null | undefined,
): string | null {
  const retainedParentId = worktree.branchGroupingParentWorktreeId;
  if (
    retainedParentId &&
    retainedParentId !== worktree.id &&
    siblingWorktrees.some((sibling) => sibling.id === retainedParentId)
  ) {
    return retainedParentId;
  }

  const baseBranch = normalizeBranch(resolvedBaseBranch);
  if (!baseBranch) return null;

  const parent = siblingWorktrees.find(
    (sibling) => normalizeBranch(sibling.branchName) === baseBranch,
  );
  return parent && parent.id !== worktree.id ? parent.id : null;
}

/** Complete root-first units; cycles fall back to independent rows. */
export function sidebarGroupStackUnits(
  worktrees: readonly WorktreeData[],
  groupingEnabled = true,
): string[][] {
  const parents = new Map<string, string>();
  for (const item of worktrees) {
    if (
      item.branchGroupingOverride === 'ungroup' ||
      (!groupingEnabled && item.branchGroupingOverride !== 'group')
    )
      continue;
    const parent = resolveWorktreeGroupingParentId(
      item,
      worktrees,
      resolveTrackedBaseBranchFallback(
        item.trackedRepoBaseBranches ? 'multi-repo' : 'single-repo',
        item,
      ),
    );
    if (parent) parents.set(item.id, parent);
  }
  const roots = new Map<string, string>();
  for (const item of worktrees) {
    let root = item.id;
    const seen = new Set<string>();
    while (parents.has(root) && !seen.has(root)) {
      seen.add(root);
      root = parents.get(root) ?? root;
    }
    roots.set(item.id, seen.has(root) ? item.id : root);
  }
  const childrenByRoot = new Map<string, string[]>();
  for (const item of worktrees) {
    const root = roots.get(item.id);
    if (!root || root === item.id) continue;
    const children = childrenByRoot.get(root) ?? [];
    children.push(item.id);
    childrenByRoot.set(root, children);
  }
  const units: string[][] = [];
  for (const item of worktrees) {
    if (roots.get(item.id) !== item.id) continue;
    units.push([item.id, ...(childrenByRoot.get(item.id) ?? [])]);
  }
  return units;
}
