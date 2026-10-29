import { APP_ADVISOR_ACTION_CATALOG } from '../app-advisor-actions';
import {
  isSidebarItemGroupAction,
  orderedSidebarItemGroups,
  sidebarItemGroupIds,
} from '../sidebar-item-group-actions';
import type { SidebarItemGroup } from '@canopy/protocol/sidebar';

it('discovers and validates each local sidebar group action example', () => {
  const entries = APP_ADVISOR_ACTION_CATALOG.filter((entry) =>
    entry.type.startsWith('sidebar.item_groups.'),
  );
  expect(entries).toHaveLength(8);
  for (const entry of entries)
    expect(isSidebarItemGroupAction(entry.example)).toBe(true);
});

it('reports canonical group order and inherited branch-stack membership', () => {
  const groups: SidebarItemGroup[] = [
    {
      id: 'grp-first',
      name: 'First',
      color: 'neutral',
      collapsed: false,
      memberIds: ['root-one'],
    },
    {
      id: 'grp-second',
      name: 'Second',
      color: 'categorical-2',
      collapsed: true,
      memberIds: ['root-two'],
    },
  ];
  expect(
    orderedSidebarItemGroups(groups, ['root-two', 'child-two', 'root-one']),
  ).toEqual([
    { ...groups[1], order: 0 },
    { ...groups[0], order: 1 },
  ]);
  expect([
    ...sidebarItemGroupIds(groups, [['root-two', 'child-two'], ['root-one']]),
  ]).toEqual([
    ['root-one', 'grp-first'],
    ['root-two', 'grp-second'],
    ['child-two', 'grp-second'],
  ]);
});

it('reads each group membership once while ordering', () => {
  const members = ['second', 'first'];
  const map = jest.spyOn(members, 'map');
  const groups: SidebarItemGroup[] = [
    {
      id: 'grp-one',
      name: '',
      color: 'neutral',
      collapsed: false,
      memberIds: members,
    },
    {
      id: 'grp-two',
      name: '',
      color: 'neutral',
      collapsed: false,
      memberIds: ['third'],
    },
    {
      id: 'grp-three',
      name: '',
      color: 'neutral',
      collapsed: false,
      memberIds: ['fourth'],
    },
  ];
  expect(
    orderedSidebarItemGroups(groups, ['first', 'second', 'third', 'fourth']),
  ).toEqual([
    { ...groups[0], order: 0 },
    { ...groups[1], order: 1 },
    { ...groups[2], order: 2 },
  ]);
  expect(map).toHaveBeenCalledTimes(1);
});
it('rejects untrusted group commands before canonical mutation', () => {
  for (const value of [
    {
      type: 'sidebar.item_groups.set_item',
      scope: { appAdvisor: true },
      itemId: 'entry-one',
      newGroup: [],
    },
    {
      type: 'sidebar.item_groups.list',
      scope: { appAdvisor: true },
      authority: 'external',
    },
    null,
    {},
    { type: 'sidebar.item_groups.list', scope: { appAdvisor: false } },
    {
      type: 'sidebar.item_groups.list',
      scope: { appAdvisor: true, workspaceLocalId: 'workspace-one' },
    },
    {
      type: 'sidebar.item_groups.list',
      scope: { workspaceLocalId: '../workspace' },
    },
    {
      type: 'sidebar.item_groups.move_item',
      scope: { appAdvisor: true },
      itemId: 'entry-one',
      groupId: null,
      before: 'one',
      after: 'two',
    },
    {
      type: 'sidebar.item_groups.update',
      scope: { appAdvisor: true },
      groupId: 'grp-one',
      collapsed: 'yes',
    },
    {
      type: 'sidebar.item_groups.update',
      scope: { appAdvisor: true },
      groupId: 'not-a-group',
    },
  ])
    expect(isSidebarItemGroupAction(value)).toBe(false);
});

it('accepts label visibility controls on supported group mutations', () => {
  for (const action of [
    {
      type: 'sidebar.item_groups.set_item',
      scope: { appAdvisor: true },
      itemId: 'entry-one',
      newGroup: { name: 'Tasks', labelHidden: true },
    },
    {
      type: 'sidebar.item_groups.create',
      scope: { workspaceLocalId: 'workspace-one' },
      itemId: 'worktree-one',
      labelHidden: false,
    },
    {
      type: 'sidebar.item_groups.update',
      scope: { workspaceLocalId: 'workspace-one' },
      groupId: 'grp-one',
      labelHidden: true,
    },
  ]) {
    expect(isSidebarItemGroupAction(action)).toBe(true);
  }

  expect(
    isSidebarItemGroupAction({
      type: 'sidebar.item_groups.update',
      scope: { appAdvisor: true },
      groupId: 'grp-one',
      labelHidden: 'yes',
    }),
  ).toBe(false);
  expect(
    isSidebarItemGroupAction({
      type: 'sidebar.item_groups.set_item',
      scope: { appAdvisor: true },
      itemId: 'entry-one',
      newGroup: { name: 'Tasks', labelHidden: 'yes' },
    }),
  ).toBe(false);
});

it('orders empty headers before their anchor block with stable shared slots', () => {
  const populated: SidebarItemGroup = {
    id: 'grp-populated',
    name: 'Populated',
    color: 'neutral',
    collapsed: false,
    memberIds: ['a', 'c'],
  };
  const first: SidebarItemGroup = {
    id: 'grp-first',
    name: 'First',
    color: 'neutral',
    collapsed: false,
    memberIds: [],
    keepWhenEmpty: true,
    emptyAnchorId: 'c',
  };
  const second: SidebarItemGroup = {
    ...first,
    id: 'grp-second',
    name: 'Second',
  };
  const last: SidebarItemGroup = {
    ...first,
    id: 'grp-last',
    name: 'Last',
    emptyAnchorId: undefined,
  };
  expect(
    orderedSidebarItemGroups(
      [populated, first, second, last],
      ['a', 'b', 'c'],
    ).map(({ id, order }) => ({ id, order })),
  ).toEqual([
    { id: first.id, order: 0 },
    { id: second.id, order: 1 },
    { id: populated.id, order: 2 },
    { id: last.id, order: 3 },
  ]);
});
