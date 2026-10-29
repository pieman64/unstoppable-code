import {
  collectBranchGroupingDescendantIds,
  computeBranchGroups,
  type BranchGroupingNode,
} from '../worktree-grouping';

const node = (
  id: string,
  branch: string,
  baseBranch: string | null,
  extra: Partial<BranchGroupingNode> = {},
): BranchGroupingNode => ({ id, branch, baseBranch, ...extra });

describe('computeBranchGroups', () => {
  it('groups chains beneath their top-level non-default ancestor', () => {
    const result = computeBranchGroups(
      [
        node('parent', 'feature-a', 'main'),
        node('child', 'feature-b', 'feature-a'),
        node('grandchild', 'feature-c', 'feature-b'),
      ],
      new Set(['main']),
      true,
    );
    expect(result.groups.map((group) => group.node.id)).toEqual(['parent']);
    expect(result.groups[0]?.children.map((child) => child.id)).toEqual([
      'child',
      'grandchild',
    ]);
    expect(result.stateById.get('grandchild')).toMatchObject({
      parentId: 'child',
      rootId: 'parent',
      ancestryDepth: 2,
      topMostAncestorId: 'parent',
    });
  });

  it('keeps each parent above its descendants when newer rows lead', () => {
    // New worktrees lead the manual order, so a chain created in sequence
    // arrives grandchild-first. Depth wins inside a group; rows at the same
    // depth keep their own (newest-first) order.
    const result = computeBranchGroups(
      [
        node('grandchild', 'feature-c', 'feature-b'),
        node('sibling', 'feature-d', 'feature-a'),
        node('child', 'feature-b', 'feature-a'),
        node('parent', 'feature-a', 'main'),
      ],
      new Set(['main']),
      true,
    );
    expect(result.groups.map((group) => group.node.id)).toEqual(['parent']);
    expect(result.groups[0]?.children.map((child) => child.id)).toEqual([
      'sibling',
      'child',
      'grandchild',
    ]);
    expect(result.stateById.get('parent')?.nestedChildIds).toEqual([
      'sibling',
      'child',
      'grandchild',
    ]);
  });

  it('excludes default branches and honors explicit group/ungroup overrides', () => {
    const nodes = [
      node('main', 'main', null),
      node('parent', 'feature-a', 'main'),
      node('child', 'feature-b', 'feature-a', {
        groupingOverride: 'ungroup',
      }),
      node('forced', 'feature-c', 'feature-a', {
        groupingOverride: 'group',
      }),
    ];
    const result = computeBranchGroups(nodes, new Set(['main']), false);
    expect(result.groups.map((group) => group.node.id)).toEqual([
      'main',
      'parent',
      'child',
    ]);
    expect(result.groups[1]?.children.map((child) => child.id)).toEqual([
      'forced',
    ]);
  });

  it('gives a valid retained parent precedence over the operational base', () => {
    const result = computeBranchGroups(
      [
        node('retained', 'merged-feature', 'main'),
        node('other', 'other-feature', 'main'),
        node('child', 'child', 'other-feature', {
          retainedParentId: 'retained',
        }),
      ],
      new Set(['main']),
      true,
    );
    expect(result.stateById.get('child')?.parentId).toBe('retained');
  });

  it('chooses the first other duplicate branch in input sort order', () => {
    const result = computeBranchGroups(
      [
        node('duplicate-first', 'feature-a', 'main'),
        node('duplicate-second', 'feature-a', 'feature-a'),
        node('child', 'feature-b', 'feature-a'),
      ],
      new Set(['main']),
      true,
    );

    expect(result.stateById.get('duplicate-second')?.parentId).toBe(
      'duplicate-first',
    );
    expect(result.stateById.get('child')?.parentId).toBe('duplicate-first');
  });

  it('collects structural descendants once and guards cycles', () => {
    expect(
      collectBranchGroupingDescendantIds(
        'a',
        new Map([
          ['a', ['b']],
          ['b', ['c']],
          ['c', ['a']],
        ]),
      ),
    ).toEqual(['b', 'c']);
  });
});
