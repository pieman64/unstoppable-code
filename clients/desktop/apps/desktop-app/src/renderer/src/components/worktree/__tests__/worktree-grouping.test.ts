import {
  WORKSPACE_ROOT_REPO_ID,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import {
  collectStructuralDescendantIds,
  computeWorktreeGroups,
  flattenVisibleWorktreeGroupOrder,
  resolveTrackedBaseBranchFallback,
  type WorktreeGroupingInput,
} from '../worktree-grouping';

function makeWorktree(
  id: string,
  branchName: string,
  overrides: Partial<WorktreeData> = {},
): WorktreeData {
  return {
    id,
    branchName,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function run(
  partial: Partial<WorktreeGroupingInput> & {
    worktrees: WorktreeData[];
    baseBranchByWorktreeId: Map<string, string | null | undefined>;
  },
): ReturnType<typeof computeWorktreeGroups> {
  return computeWorktreeGroups({
    defaultBranchNames: new Set(['main']),
    groupingEnabled: true,
    ...partial,
  });
}

describe('computeWorktreeGroups', () => {
  it('nests a child under the worktree whose branch is its base', () => {
    const parent = makeWorktree('p', 'feature-a');
    const child = makeWorktree('c', 'feature-b');
    const result = run({
      worktrees: [parent, child],
      baseBranchByWorktreeId: new Map([
        ['p', 'main'],
        ['c', 'feature-a'],
      ]),
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].worktree.id).toBe('p');
    expect(result.entries[0].children.map((c) => c.id)).toEqual(['c']);
    expect(result.stateByWorktreeId.get('c')?.isChild).toBe(true);
    expect(result.stateByWorktreeId.get('c')?.hasEligibleParent).toBe(true);
    expect(result.stateByWorktreeId.get('p')?.isChild).toBe(false);
  });

  it('keeps a retargeted child nested under its merged visual parent', () => {
    const parent = makeWorktree('p', 'feature-parent', { status: 'done' });
    const child = makeWorktree('c', 'feature-child', {
      trackedBaseBranch: 'main',
      branchGroupingParentWorktreeId: 'p',
    });
    const result = run({
      worktrees: [parent, child],
      baseBranchByWorktreeId: new Map([
        ['p', 'main'],
        // The operational base was retargeted after the parent merged.
        ['c', 'main'],
      ]),
    });

    expect(result.entries.map((entry) => entry.worktree.id)).toEqual(['p']);
    expect(result.entries[0]?.children.map((entry) => entry.id)).toEqual(['c']);
    expect(result.stateByWorktreeId.get('c')?.parentWorktreeId).toBe('p');
  });

  it('keeps worktrees based on the default branch at the top level', () => {
    const a = makeWorktree('a', 'feature-a');
    const b = makeWorktree('b', 'feature-b');
    const result = run({
      worktrees: [a, b],
      baseBranchByWorktreeId: new Map([
        ['a', 'main'],
        ['b', 'main'],
      ]),
    });

    expect(result.entries.map((e) => e.worktree.id)).toEqual(['a', 'b']);
    expect(result.entries.every((e) => e.children.length === 0)).toBe(true);
  });

  it('ignores the default branch as a parent even when it is open as a worktree', () => {
    const mainWt = makeWorktree('m', 'main');
    const child = makeWorktree('c', 'feature-a');
    const result = run({
      worktrees: [mainWt, child],
      baseBranchByWorktreeId: new Map([
        ['m', 'main'],
        ['c', 'main'],
      ]),
    });

    // The child's base is the default branch, so it stays top-level.
    expect(result.entries.map((e) => e.worktree.id)).toEqual(['m', 'c']);
    expect(result.stateByWorktreeId.get('c')?.hasEligibleParent).toBe(false);
  });

  it('flattens deep chains under the top-most ancestor only', () => {
    const a = makeWorktree('a', 'feat-a');
    const b = makeWorktree('b', 'feat-b');
    const c = makeWorktree('c', 'feat-c');
    const result = run({
      worktrees: [a, b, c],
      baseBranchByWorktreeId: new Map([
        ['a', 'main'],
        ['b', 'feat-a'],
        ['c', 'feat-b'],
      ]),
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].worktree.id).toBe('a');
    expect(result.entries[0].children.map((c) => c.id)).toEqual(['b', 'c']);
    expect(result.stateByWorktreeId.get('c')?.rootWorktreeId).toBe('a');
  });

  it('keeps each parent above its descendants when newer rows lead', () => {
    // New worktrees are inserted at the top of the manual order, so a chain
    // created in sequence arrives grandchild-first. Depth wins inside a group;
    // rows at the same depth keep their own (newest-first) order.
    const result = run({
      worktrees: [
        makeWorktree('grandchild', 'feature-c'),
        makeWorktree('sibling', 'feature-d'),
        makeWorktree('child', 'feature-b'),
        makeWorktree('root', 'feature-a'),
      ],
      baseBranchByWorktreeId: new Map([
        ['root', 'main'],
        ['child', 'feature-a'],
        ['sibling', 'feature-a'],
        ['grandchild', 'feature-b'],
      ]),
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].worktree.id).toBe('root');
    expect(result.entries[0].children.map((c) => c.id)).toEqual([
      'sibling',
      'child',
      'grandchild',
    ]);
    expect(result.stateByWorktreeId.get('root')?.nestedChildIds).toEqual([
      'sibling',
      'child',
      'grandchild',
    ]);
  });

  it('materializes the rendered parent-and-children order before flattening', () => {
    const parent = makeWorktree('parent', 'feat-parent');
    const unrelated = makeWorktree('unrelated', 'feat-unrelated');
    const firstChild = makeWorktree('first-child', 'feat-child-1');
    const secondChild = makeWorktree('second-child', 'feat-child-2');
    const result = run({
      // Children were appended after an unrelated row, as happens when split
      // or branch-from worktrees are created.
      worktrees: [parent, unrelated, firstChild, secondChild],
      baseBranchByWorktreeId: new Map([
        ['parent', 'main'],
        ['unrelated', 'main'],
        ['first-child', 'feat-parent'],
        ['second-child', 'feat-parent'],
      ]),
    });

    const flattened = flattenVisibleWorktreeGroupOrder(
      [parent, unrelated, firstChild, secondChild],
      result,
    );

    expect(flattened.map((worktree) => worktree.id)).toEqual([
      'parent',
      'first-child',
      'second-child',
      'unrelated',
    ]);
    expect(
      flattened
        .filter((worktree) => worktree.id !== 'parent')
        .map((worktree) => worktree.id),
    ).toEqual(['first-child', 'second-child', 'unrelated']);
  });

  it('keeps hidden slots fixed while materializing visible grouping order', () => {
    const parent = makeWorktree('parent', 'feat-parent');
    const hidden = makeWorktree('hidden', 'feat-hidden', { hidden: true });
    const unrelated = makeWorktree('unrelated', 'feat-unrelated');
    const child = makeWorktree('child', 'feat-child');
    const visible = [parent, unrelated, child];
    const result = run({
      worktrees: visible,
      baseBranchByWorktreeId: new Map([
        ['parent', 'main'],
        ['unrelated', 'main'],
        ['child', 'feat-parent'],
      ]),
    });

    expect(
      flattenVisibleWorktreeGroupOrder(
        [parent, hidden, unrelated, child],
        result,
      ).map((worktree) => worktree.id),
    ).toEqual(['parent', 'hidden', 'child', 'unrelated']);
  });

  it('materializes grouping order for hidden worktrees rendered flattened', () => {
    const parent = makeWorktree('parent', 'feat-parent', { hidden: true });
    const unrelated = makeWorktree('unrelated', 'feat-unrelated', {
      hidden: true,
    });
    const child = makeWorktree('child', 'feat-child', { hidden: true });
    const worktrees = [parent, unrelated, child];
    const result = run({
      worktrees,
      baseBranchByWorktreeId: new Map([
        ['parent', 'main'],
        ['unrelated', 'main'],
        ['child', 'feat-parent'],
      ]),
    });

    expect(
      flattenVisibleWorktreeGroupOrder(worktrees, result, {
        includeHidden: true,
      }).map((worktree) => worktree.id),
    ).toEqual(['parent', 'child', 'unrelated']);
  });

  it('disables grouping globally but honors a per-worktree group override', () => {
    const parent = makeWorktree('p', 'feature-a');
    const child = makeWorktree('c', 'feature-b', {
      branchGroupingOverride: 'group',
    });
    const ungroupedChild = makeWorktree('d', 'feature-c');
    const result = run({
      worktrees: [parent, child, ungroupedChild],
      baseBranchByWorktreeId: new Map([
        ['p', 'main'],
        ['c', 'feature-a'],
        ['d', 'feature-a'],
      ]),
      groupingEnabled: false,
    });

    // c is force-grouped, d follows the (disabled) global preference.
    expect(result.entries.map((e) => e.worktree.id)).toEqual(['p', 'd']);
    const parentEntry = result.entries.find((e) => e.worktree.id === 'p');
    expect(parentEntry?.children.map((c) => c.id)).toEqual(['c']);
  });

  it('honors a per-worktree ungroup override when grouping is globally on', () => {
    const parent = makeWorktree('p', 'feature-a');
    const child = makeWorktree('c', 'feature-b', {
      branchGroupingOverride: 'ungroup',
    });
    const result = run({
      worktrees: [parent, child],
      baseBranchByWorktreeId: new Map([
        ['p', 'main'],
        ['c', 'feature-a'],
      ]),
    });

    expect(result.entries.map((e) => e.worktree.id)).toEqual(['p', 'c']);
    expect(result.stateByWorktreeId.get('c')?.isChild).toBe(false);
    // It still has an eligible parent, so the menu toggle remains available.
    expect(result.stateByWorktreeId.get('c')?.hasEligibleParent).toBe(true);
  });

  it('guards against base-branch cycles', () => {
    const a = makeWorktree('a', 'branch-a');
    const b = makeWorktree('b', 'branch-b');
    const result = run({
      worktrees: [a, b],
      baseBranchByWorktreeId: new Map([
        ['a', 'branch-b'],
        ['b', 'branch-a'],
      ]),
    });

    // Whatever the resolution, it must terminate and not throw.
    expect(result.entries.length).toBeGreaterThanOrEqual(1);
  });

  it('lets an ungrouped middle parent take its descendants with it', () => {
    const a = makeWorktree('a', 'feat-a');
    const b = makeWorktree('b', 'feat-b', {
      branchGroupingOverride: 'ungroup',
    });
    const c = makeWorktree('c', 'feat-c');
    const result = run({
      worktrees: [a, b, c],
      baseBranchByWorktreeId: new Map([
        ['a', 'main'],
        ['b', 'feat-a'],
        ['c', 'feat-b'],
      ]),
    });

    // b pops out to the top level and c nests under b (not the top-most a).
    expect(result.entries.map((e) => e.worktree.id)).toEqual(['a', 'b']);
    const aEntry = result.entries.find((e) => e.worktree.id === 'a');
    const bEntry = result.entries.find((e) => e.worktree.id === 'b');
    expect(aEntry?.children).toHaveLength(0);
    expect(bEntry?.children.map((child) => child.id)).toEqual(['c']);
    expect(result.stateByWorktreeId.get('c')?.rootWorktreeId).toBe('b');
  });

  it('reports structural-children state for parent worktrees', () => {
    const a = makeWorktree('a', 'feat-a');
    const b = makeWorktree('b', 'feat-b');
    const result = run({
      worktrees: [a, b],
      baseBranchByWorktreeId: new Map([
        ['a', 'main'],
        ['b', 'feat-a'],
      ]),
    });

    expect(result.stateByWorktreeId.get('a')?.hasStructuralChildren).toBe(true);
    expect(result.stateByWorktreeId.get('a')?.nestedChildIds).toEqual(['b']);
    expect(result.stateByWorktreeId.get('b')?.hasStructuralChildren).toBe(
      false,
    );
  });

  it('collects all structural descendants of a parent', () => {
    const a = makeWorktree('a', 'feat-a');
    const b = makeWorktree('b', 'feat-b');
    const c = makeWorktree('c', 'feat-c');
    const result = run({
      worktrees: [a, b, c],
      baseBranchByWorktreeId: new Map([
        ['a', 'main'],
        ['b', 'feat-a'],
        ['c', 'feat-b'],
      ]),
    });

    expect(
      collectStructuralDescendantIds(
        'a',
        result.structuralChildIdsByWorktreeId,
      ).sort(),
    ).toEqual(['b', 'c']);
  });

  it('treats a worktree whose base matches no other branch as top-level', () => {
    const a = makeWorktree('a', 'feature-a', {
      branchGroupingParentWorktreeId: 'deleted-parent',
    });
    const result = run({
      worktrees: [a],
      baseBranchByWorktreeId: new Map([['a', 'some-deleted-branch']]),
    });

    expect(result.entries.map((e) => e.worktree.id)).toEqual(['a']);
    expect(result.stateByWorktreeId.get('a')?.hasEligibleParent).toBe(false);
  });

  it('reports ancestry depth and top-most ancestor along a chain', () => {
    const a = makeWorktree('a', 'feat-a');
    const b = makeWorktree('b', 'feat-b');
    const c = makeWorktree('c', 'feat-c');
    const result = run({
      worktrees: [a, b, c],
      baseBranchByWorktreeId: new Map([
        ['a', 'main'],
        ['b', 'feat-a'],
        ['c', 'feat-b'],
      ]),
    });

    expect(result.stateByWorktreeId.get('a')?.ancestryDepth).toBe(0);
    expect(result.stateByWorktreeId.get('a')?.topMostAncestorId).toBeNull();
    expect(result.stateByWorktreeId.get('b')?.ancestryDepth).toBe(1);
    expect(result.stateByWorktreeId.get('b')?.topMostAncestorId).toBe('a');
    expect(result.stateByWorktreeId.get('c')?.ancestryDepth).toBe(2);
    expect(result.stateByWorktreeId.get('c')?.topMostAncestorId).toBe('a');
  });

  it('reports depth 0 for a worktree based on the default branch', () => {
    const a = makeWorktree('a', 'feat-a');
    const result = run({
      worktrees: [a],
      baseBranchByWorktreeId: new Map([['a', 'main']]),
    });

    expect(result.stateByWorktreeId.get('a')?.ancestryDepth).toBe(0);
    expect(result.stateByWorktreeId.get('a')?.topMostAncestorId).toBeNull();
  });

  it('reports true ancestry depth even when an intermediate is ungrouped', () => {
    const a = makeWorktree('a', 'feat-a');
    const b = makeWorktree('b', 'feat-b', {
      branchGroupingOverride: 'ungroup',
    });
    const c = makeWorktree('c', 'feat-c');
    const result = run({
      worktrees: [a, b, c],
      baseBranchByWorktreeId: new Map([
        ['a', 'main'],
        ['b', 'feat-a'],
        ['c', 'feat-b'],
      ]),
    });

    // b renders top-level (ungrouped) but still has a real parent.
    expect(result.stateByWorktreeId.get('b')?.ancestryDepth).toBe(1);
    expect(result.stateByWorktreeId.get('b')?.topMostAncestorId).toBe('a');
    expect(result.stateByWorktreeId.get('c')?.ancestryDepth).toBe(2);
    expect(result.stateByWorktreeId.get('c')?.topMostAncestorId).toBe('a');
  });

  it('reports true ancestry depth even when global grouping is disabled', () => {
    const a = makeWorktree('a', 'feat-a');
    const b = makeWorktree('b', 'feat-b');
    const result = run({
      worktrees: [a, b],
      baseBranchByWorktreeId: new Map([
        ['a', 'main'],
        ['b', 'feat-a'],
      ]),
      groupingEnabled: false,
    });

    expect(result.stateByWorktreeId.get('b')?.ancestryDepth).toBe(1);
    expect(result.stateByWorktreeId.get('b')?.topMostAncestorId).toBe('a');
  });

  it('does not loop on a base-branch cycle when computing depth', () => {
    const a = makeWorktree('a', 'feat-a');
    const b = makeWorktree('b', 'feat-b');
    const c = makeWorktree('c', 'feat-c');
    const result = run({
      worktrees: [a, b, c],
      baseBranchByWorktreeId: new Map([
        ['a', 'feat-b'],
        ['b', 'feat-a'],
        ['c', 'feat-a'],
      ]),
    });

    // A corrupted cycle has no well-defined top-most ancestor, and neither
    // does any worktree whose ancestry chain points into it.
    for (const worktreeId of ['a', 'b', 'c']) {
      expect(result.stateByWorktreeId.get(worktreeId)?.ancestryDepth).toBe(0);
      expect(
        result.stateByWorktreeId.get(worktreeId)?.topMostAncestorId,
      ).toBeNull();
    }
  });
});

describe('resolveTrackedBaseBranchFallback', () => {
  it('uses workspace-root tracked base branches for source-backed multi-repo worktrees', () => {
    expect(
      resolveTrackedBaseBranchFallback(
        'multi-repo',
        makeWorktree('c', 'feature-b', {
          trackedBaseBranch: 'single-repo-base',
          trackedRepoBaseBranches: {
            [WORKSPACE_ROOT_REPO_ID]: 'feature-a',
            child: 'child-base',
          },
        }),
      ),
    ).toBe('feature-a');
  });

  it('falls back to the available per-repo base for multi-repo worktrees without a project root', () => {
    expect(
      resolveTrackedBaseBranchFallback(
        'multi-repo',
        makeWorktree('c', 'feature-b', {
          trackedRepoBaseBranches: {
            child: 'feature-a',
          },
        }),
      ),
    ).toBe('feature-a');
  });
});
