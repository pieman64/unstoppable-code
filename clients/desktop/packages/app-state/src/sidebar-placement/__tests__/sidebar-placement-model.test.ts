import {
  moveSidebarItemMembership,
  projectPlacements,
  type SidebarPlacementIntent,
} from '../sidebar-placement-model';
import type { SidebarItemGroup } from '@canopy/protocol/sidebar';

const groups: SidebarItemGroup[] = [
  {
    id: 'one',
    name: 'One',
    color: 'neutral',
    collapsed: false,
    memberIds: ['a', 'b'],
  },
  {
    id: 'two',
    name: 'Two',
    color: 'neutral',
    collapsed: true,
    keepWhenEmpty: true,
    memberIds: ['c'],
  },
];

describe('shared membership projection', () => {
  it('moves one membership while preserving metadata and the input', () => {
    const moved = moveSidebarItemMembership(groups, 'a', 'two');
    expect(moved.map((g) => g.memberIds)).toEqual([['b'], ['c', 'a']]);
    expect(moved[1]).toMatchObject({ collapsed: true, keepWhenEmpty: true });
    expect(groups[0]?.memberIds).toEqual(['a', 'b']);
  });
  it('projects null membership without dropping empty groups', () => {
    expect(
      moveSidebarItemMembership(groups, 'c', null).map((g) => g.memberIds),
    ).toEqual([['a', 'b'], []]);
  });
});

describe('placement projection', () => {
  const base = {
    order: ['pin', 'a', 'b', 'c'],
    groups,
    movableItemIds: new Set(['a', 'b', 'c']),
  };
  const intent = (
    itemId: string,
    groupId: string | null,
    position: { before?: string; after?: string } = {},
    membershipOnly = false,
  ): SidebarPlacementIntent => ({
    id: 1,
    generation: 0,
    status: 'saving',
    request: {
      scope: { workspaceLocalId: 'ws' },
      itemId,
      groupId,
      ...position,
    } as SidebarPlacementIntent['request'],
    membershipOnly,
  });
  it('keeps the pin partition and normalizes a joined group as a contiguous unit', () => {
    const result = projectPlacements(base, [
      intent('a', 'two', { after: 'c' }),
    ]);
    expect(result.order).toEqual(['pin', 'b', 'c', 'a']);
    expect(result.groups.map((g) => g.memberIds)).toEqual([['b'], ['c', 'a']]);
    expect(result.groups[1]?.collapsed).toBe(true);
  });
  it.each([
    intent('a', null, { before: 'a' }),
    intent('pin', null, { before: 'a' }),
    intent('a', 'missing'),
    intent('a', null, { before: 'missing' }),
    intent('a', null, { before: 'pin' }),
  ])('ignores invalid or unavailable placement %#', (move) => {
    const result = projectPlacements(base, [move]);
    expect(result.order).toEqual(base.order);
    expect(result.groups.map((g) => g.memberIds)).toEqual(
      base.groups.map((g) => g.memberIds),
    );
  });
  it('changes only membership in recency mode', () => {
    const result = projectPlacements(base, [intent('a', 'two', {}, true)]);
    expect(result.order).toEqual(base.order);
    expect(result.groups[1]?.memberIds).toEqual(['c', 'a']);
  });
  it('retains the empty kept group at its previous anchor', () => {
    const kept: SidebarItemGroup = {
      id: 'kept',
      name: 'Kept',
      color: 'neutral',
      collapsed: false,
      keepWhenEmpty: true,
      memberIds: ['b'],
    };
    const result = projectPlacements({ ...base, groups: [kept] }, [
      intent('b', null, { after: 'c' }),
    ]);
    expect(result.groups[0]).toMatchObject({
      memberIds: [],
      collapsed: true,
      emptyAnchorId: 'c',
    });
    const joining = projectPlacements(result, [intent('a', 'kept')]);
    expect(joining.groups[0]?.collapsed).toBe(false);
  });
  it('removes deleted rows from membership and never revives deleted groups', () => {
    const deleted = {
      ...base,
      order: ['pin', 'a'],
      movableItemIds: new Set(['a']),
      groups: [],
    };
    const result = projectPlacements(deleted, [
      intent('b', 'two', { before: 'a' }),
    ]);
    expect(result.order).toEqual(['pin', 'a']);
    expect(result.groups).toEqual([]);
  });
});

it('joins an empty kept group at its retained slot instead of appending to the list', () => {
  const group: SidebarItemGroup = {
    id: 'empty',
    name: 'Empty',
    color: 'neutral',
    collapsed: true,
    keepWhenEmpty: true,
    emptyAnchorId: 'b',
    memberIds: [],
  };
  const base = {
    order: ['a', 'b', 'c'],
    groups: [group],
    movableItemIds: new Set(['a', 'b', 'c']),
  };
  const change: SidebarPlacementIntent = {
    id: 1,
    generation: 0,
    status: 'saving',
    request: {
      scope: { workspaceLocalId: 'ws' },
      itemId: 'c',
      groupId: 'empty',
    },
    membershipOnly: false,
  };
  expect(projectPlacements(base, [change]).order).toEqual(['a', 'c', 'b']);
});

it('preserves manual position for an unanchored remove-from-group menu move', () => {
  const base = {
    order: ['a', 'b', 'c'],
    groups: [
      {
        id: 'one',
        name: 'One',
        color: 'neutral' as const,
        collapsed: false,
        memberIds: ['a', 'b'],
      },
    ],
    movableItemIds: new Set(['a', 'b', 'c']),
  };
  const change: SidebarPlacementIntent = {
    id: 1,
    generation: 0,
    status: 'saving',
    request: { scope: { workspaceLocalId: 'ws' }, itemId: 'a', groupId: null },
    membershipOnly: false,
  };
  expect(projectPlacements(base, [change]).order).toEqual(['a', 'b', 'c']);
});
