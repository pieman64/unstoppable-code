import {
  defaultSidebarItemGroupName,
  findSidebarItemGroupByName,
  isDefaultSidebarItemGroupName,
  normalizeSidebarItemGroups,
  pickSidebarItemGroupColor,
  resolveSidebarItemGroupLabel,
  SIDEBAR_ITEM_GROUP_COLORS,
  type SidebarItemGroup,
  type SidebarItemGroupColor,
} from '..';

function group(
  id: string,
  name: string,
  color: SidebarItemGroupColor = 'neutral',
  extra: Partial<SidebarItemGroup> = {},
): SidebarItemGroup {
  return { id, name, color, collapsed: false, memberIds: [id], ...extra };
}

describe('sidebar item group default names', () => {
  it('counts from 1 and takes the lowest number no group uses', () => {
    expect(defaultSidebarItemGroupName([])).toBe('Group 1');
    expect(
      defaultSidebarItemGroupName([
        group('grp-a', 'Group 1'),
        group('grp-b', 'group   3'),
        group('grp-c', 'Docs', 'categorical-3'),
      ]),
    ).toBe('Group 2');
    expect(
      defaultSidebarItemGroupName([
        group('grp-a', 'Group 1'),
        group('grp-b', 'GROUP 2'),
      ]),
    ).toBe('Group 3');
  });

  it('recognizes only the generated format', () => {
    expect(isDefaultSidebarItemGroupName('Group 4')).toBe(true);
    expect(isDefaultSidebarItemGroupName('  group   12 ')).toBe(true);
    expect(isDefaultSidebarItemGroupName('Group 0')).toBe(false);
    expect(isDefaultSidebarItemGroupName('Group')).toBe(false);
    expect(isDefaultSidebarItemGroupName('Group team')).toBe(false);
    expect(isDefaultSidebarItemGroupName('My Group 1')).toBe(false);
  });

  it('names legacy unnamed groups and hides their labels on normalize', () => {
    const groups = normalizeSidebarItemGroups(
      [
        group('grp-a', ''),
        group('grp-b', 'Group 1'),
        group('grp-c', '', 'categorical-1'),
        group('grp-d', 'Docs', 'neutral', { labelHidden: true }),
      ],
      { liveItemIds: ['grp-a', 'grp-b', 'grp-c', 'grp-d'] },
    );
    expect(
      groups.map(({ id, name, labelHidden }) => ({ id, name, labelHidden })),
    ).toEqual([
      { id: 'grp-a', name: 'Group 2', labelHidden: true },
      { id: 'grp-b', name: 'Group 1', labelHidden: true },
      { id: 'grp-c', name: 'Group 3', labelHidden: true },
      { id: 'grp-d', name: 'Docs', labelHidden: true },
    ]);
  });
});

describe('resolveSidebarItemGroupLabel', () => {
  const others = [group('grp-x', 'Group 1')];

  it('stores a hidden default name for blank creation', () => {
    expect(resolveSidebarItemGroupLabel({ name: '  ', others })).toEqual({
      name: 'Group 2',
      labelHidden: true,
    });
    expect(resolveSidebarItemGroupLabel({ others })).toEqual({
      name: 'Group 2',
      labelHidden: true,
    });
  });

  it('shows a typed name unless asked to hide it', () => {
    expect(resolveSidebarItemGroupLabel({ name: ' Docs ', others })).toEqual({
      name: 'Docs',
      labelHidden: false,
    });
    expect(
      resolveSidebarItemGroupLabel({ name: 'Docs', labelHidden: true, others }),
    ).toEqual({ name: 'Docs', labelHidden: true });
  });

  it('keeps an existing default name when the name is blanked again', () => {
    expect(
      resolveSidebarItemGroupLabel({
        name: '',
        previous: { name: 'Group 5', labelHidden: true },
        others: [],
      }),
    ).toEqual({ name: 'Group 5', labelHidden: true });
  });

  it('gives a blanked custom name the next default name', () => {
    expect(
      resolveSidebarItemGroupLabel({
        name: '',
        previous: { name: 'Docs' },
        others,
      }),
    ).toEqual({ name: 'Group 2', labelHidden: true });
  });

  it('shows the label once a default-named group gets a real name', () => {
    expect(
      resolveSidebarItemGroupLabel({
        name: 'Docs',
        previous: { name: 'Group 2', labelHidden: true },
        others,
      }),
    ).toEqual({ name: 'Docs', labelHidden: false });
  });

  it('toggles visibility without touching the name', () => {
    expect(
      resolveSidebarItemGroupLabel({
        labelHidden: true,
        previous: { name: 'Docs' },
        others,
      }),
    ).toEqual({ name: 'Docs', labelHidden: true });
    expect(
      resolveSidebarItemGroupLabel({
        labelHidden: false,
        previous: { name: 'Docs', labelHidden: true },
        others,
      }),
    ).toEqual({ name: 'Docs', labelHidden: false });
  });

  it('keeps a custom hidden name hidden across a rename', () => {
    expect(
      resolveSidebarItemGroupLabel({
        name: 'Guides',
        previous: { name: 'Docs', labelHidden: true },
        others,
      }),
    ).toEqual({ name: 'Guides', labelHidden: true });
  });
});

describe('generated default names stay hidden', () => {
  const others = [group('grp-x', 'Docs')];

  it('ignores a request to show a default name', () => {
    expect(
      resolveSidebarItemGroupLabel({
        labelHidden: false,
        previous: { name: 'Group 1', labelHidden: true },
        others,
      }),
    ).toEqual({ name: 'Group 1', labelHidden: true });
  });

  it('treats a typed default-format name as the default name', () => {
    expect(
      resolveSidebarItemGroupLabel({
        name: 'group 4',
        labelHidden: false,
        others,
      }),
    ).toEqual({ name: 'group 4', labelHidden: true });
  });
});

describe('findSidebarItemGroupByName', () => {
  it('matches case- and whitespace-insensitively', () => {
    const groups = [group('grp-a', 'Docs'), group('grp-b', 'Group 1')];
    expect(findSidebarItemGroupByName(groups, '  docs ')?.id).toBe('grp-a');
    expect(
      findSidebarItemGroupByName(
        [group('grp-c', 'Daily review'), group('grp-d', 'daily   review')],
        'DAILY \t review',
      )?.id,
    ).toBe('grp-c');
    expect(findSidebarItemGroupByName(groups, 'GROUP 1')?.id).toBe('grp-b');
    expect(findSidebarItemGroupByName(groups, 'Other')).toBeUndefined();
    expect(findSidebarItemGroupByName(groups, '  ')).toBeUndefined();
  });
});

describe('pickSidebarItemGroupColor', () => {
  it('picks randomly among unused colors', () => {
    const used = SIDEBAR_ITEM_GROUP_COLORS.slice(0, 5).map((color, index) =>
      group(`grp-${index}`, `G${index}`, color),
    );
    expect(pickSidebarItemGroupColor(used, () => 0)).toBe('categorical-5');
    expect(pickSidebarItemGroupColor(used, () => 0.99)).toBe('categorical-6');
  });

  it('falls back to the least-used colors once all are used', () => {
    const used = SIDEBAR_ITEM_GROUP_COLORS.map((color, index) =>
      group(`grp-${index}`, `G${index}`, color),
    );
    used.push(group('grp-extra', 'Extra', 'neutral'));
    expect(pickSidebarItemGroupColor(used, () => 0)).toBe('categorical-1');
  });
});
