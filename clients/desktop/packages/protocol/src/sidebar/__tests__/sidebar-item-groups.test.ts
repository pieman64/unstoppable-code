import {
  anchorKeptSidebarItemGroups,
  normalizeSidebarItemGroups,
  readProjectedSidebarItemGroups,
  normalizeGroupedOrder,
  parseSidebarItemGroupsFile,
  nextSidebarItemGroupColor,
  resolveSidebarItemGroupCollapsed,
  SIDEBAR_ITEM_GROUP_COLORS,
  type SidebarItemGroup,
} from '..';

function group(id: string, memberIds: string[]): SidebarItemGroup {
  return {
    id,
    name: 'Group',
    color: 'neutral',
    collapsed: false,
    memberIds,
  };
}

describe('sidebar item group normalization', () => {
  const inventory = {
    liveItemIds: ['a', 'b', 'child', 'pinned', 'hidden'],
    ineligibleItemIds: ['child', 'pinned', 'hidden'],
  };

  it.each(['', 'grp-', '../group', 'grp-UPPER', 'grp-with space'])(
    'rejects invalid group id %p without consuming valid membership',
    (id) => {
      expect(
        normalizeSidebarItemGroups(
          [group(id, ['a']), group('grp-valid', ['a'])],
          inventory,
        ),
      ).toEqual([group('grp-valid', ['a'])]);
    },
  );

  it('repairs fields and removes stale, ineligible, duplicate and malformed members', () => {
    const input = [
      {
        id: 'grp-a',
        name: '  Frontend  ',
        color: 'future-color',
        collapsed: 'yes',
        memberIds: [
          'a',
          'a',
          'child',
          'pinned',
          'hidden',
          'gone',
          123,
          '../bad',
        ],
      },
      { id: 'grp-b', name: 4, collapsed: true, memberIds: ['a', 'b'] },
      group('grp-a', ['b']),
      group('../bad', ['b']),
      null,
    ];
    const original = JSON.stringify(input);
    const result = normalizeSidebarItemGroups(input, inventory);
    expect(result).toEqual([
      { ...group('grp-a', ['a']), name: 'Frontend' },
      // A non-string name becomes the color's hidden default name.
      {
        ...group('grp-b', ['b']),
        name: 'Group 1',
        collapsed: true,
        labelHidden: true,
      },
    ]);
    expect(normalizeSidebarItemGroups(result, inventory)).toEqual(result);
    expect(JSON.stringify(input)).toBe(original);
  });

  it('drops empty groups and caps names by characters and surviving groups at 100', () => {
    const ids = Array.from({ length: 102 }, (_, i) => `wt-${i}`);
    const groups = ids.map((id, i) => ({
      ...group(`grp-${i}`, [id]),
      name: '  ' + '😀'.repeat(81) + '  ',
    }));
    const result = normalizeSidebarItemGroups(
      [group('grp-empty', ['stale']), ...groups],
      { liveItemIds: ids },
    );
    expect(result).toHaveLength(100);
    expect(Array.from(result[0].name)).toHaveLength(80);
    expect(result[0].id).toBe('grp-0');
  });

  it.each([' ', '\t', '\u00a0'])(
    'trims whitespace %p at the name limit and remains idempotent',
    (whitespace) => {
      const input = [
        { ...group('grp-a', ['a']), name: '😀'.repeat(79) + whitespace + 'x' },
      ];
      const result = normalizeSidebarItemGroups(input, inventory);
      expect(result[0].name).toBe('😀'.repeat(79));
      expect(normalizeSidebarItemGroups(result, inventory)).toEqual(result);
    },
  );

  it.each([
    undefined,
    null,
    {},
    'groups',
    [false, { id: 'grp-x', memberIds: 'a' }],
  ])('tolerates malformed recoverable groups %p', (input) => {
    expect(normalizeSidebarItemGroups(input, inventory)).toEqual([]);
  });

  it('uses the complete inventory, retains valid members and prunes after inventory changes', () => {
    const input = [group('grp-a', ['a', 'b'])];
    expect(normalizeSidebarItemGroups(input, inventory)[0].memberIds).toEqual([
      'a',
      'b',
    ]);
    expect(
      normalizeSidebarItemGroups(input, { liveItemIds: ['b'] })[0].memberIds,
    ).toEqual(['b']);
  });

  it('picks unused colors deterministically and wraps only after the palette is exhausted', () => {
    expect(nextSidebarItemGroupColor([])).toBe('neutral');
    const groups = SIDEBAR_ITEM_GROUP_COLORS.map((color, i) => ({
      ...group(`grp-${i}`, ['a']),
      color,
    }));
    expect(nextSidebarItemGroupColor(groups.slice(0, 3))).toBe('categorical-3');
    expect(nextSidebarItemGroupColor(groups)).toBe('neutral');
  });
});

describe('versioned group data', () => {
  it.each([undefined, null])('distinguishes absent data %p', (value) => {
    expect(parseSidebarItemGroupsFile(value, { liveItemIds: [] })).toEqual({
      status: 'missing',
    });
  });
  it.each([
    {},
    [],
    'bad',
    { version: 0 },
    { version: 1.5 },
    { version: '1' },
    { version: 1, groups: {} },
  ])('rejects malformed envelopes %p', (value) => {
    expect(parseSidebarItemGroupsFile(value, { liveItemIds: [] })).toEqual({
      status: 'malformed',
    });
  });
  it('preserves future versions without interpreting or rewriting their groups', () => {
    expect(
      parseSidebarItemGroupsFile(
        { version: 2, future: true },
        { liveItemIds: [] },
      ),
    ).toEqual({ status: 'unsupported-version', version: 2 });
    expect(
      parseSidebarItemGroupsFile(
        { version: 1, groups: [group('grp-a', ['a'])] },
        { liveItemIds: ['a'] },
      ),
    ).toEqual({
      status: 'ok',
      value: { version: 1, groups: [group('grp-a', ['a'])] },
    });
  });
});

describe('grouped order', () => {
  it('keeps group registry order, moves blocks at their first slot and is idempotent', () => {
    const groups = [group('grp-one', ['d', 'a']), group('grp-two', ['e', 'b'])];
    const input = ['x', 'a', 'b', 'c', 'd', 'e', 'z'];
    const result = normalizeGroupedOrder(input, groups);
    expect(result).toEqual(['x', 'a', 'd', 'b', 'e', 'c', 'z']);
    expect(normalizeGroupedOrder(result, groups)).toEqual(result);
    expect(input).toEqual(['x', 'a', 'b', 'c', 'd', 'e', 'z']);
  });

  it('moves whole nested stacks while preserving child and sibling order', () => {
    const options = {
      stackUnits: [
        ['a', 'a-child', 'a-grandchild'],
        ['b', 'b-child'],
      ],
    };
    const groups = [group('grp-one', ['b', 'a'])];
    const order = [
      'x',
      'a',
      'a-child',
      'a-grandchild',
      'middle',
      'b',
      'b-child',
      'z',
    ];
    const result = normalizeGroupedOrder(order, groups, options);
    expect(result).toEqual([
      'x',
      'a',
      'a-child',
      'a-grandchild',
      'b',
      'b-child',
      'middle',
      'z',
    ]);
    expect(normalizeGroupedOrder(result, groups, options)).toEqual(result);
  });

  it('anchors a child-first grouped stack at its root after preceding rows and groups', () => {
    const groups = [
      group('grp-parent', ['parent']),
      group('grp-other', ['other']),
    ];
    const order = ['child', 'outside', 'other', 'parent', 'tail'];
    const options = { stackUnits: [['parent', 'child']] };

    const result = normalizeGroupedOrder(order, groups, options);

    expect(result).toEqual(['outside', 'other', 'parent', 'child', 'tail']);
    expect(normalizeGroupedOrder(result, groups, options)).toEqual(result);
    expect(order).toEqual(['child', 'outside', 'other', 'parent', 'tail']);
  });

  it('anchors an ungrouped child-first stack at its root while another group exists', () => {
    const groups = [group('grp-other', ['other'])];
    const order = ['child', 'outside', 'other', 'parent', 'tail'];
    const options = { stackUnits: [['parent', 'child']] };

    expect(normalizeGroupedOrder(order, groups, options)).toEqual([
      'outside',
      'other',
      'parent',
      'child',
      'tail',
    ]);
  });

  it('anchors nested child-first stacks at the root and ignores malformed overlapping units', () => {
    const groups = [group('grp-root', ['root']), group('grp-other', ['other'])];
    const order = ['grandchild', 'child', 'outside', 'root', 'other', 'tail'];
    const options = {
      stackUnits: [
        ['root', 'child', 'grandchild'],
        ['child', 'other'],
        ['missing', 'ghost'],
        [],
      ],
    };

    const result = normalizeGroupedOrder(order, groups, options);

    expect(result).toEqual([
      'outside',
      'root',
      'child',
      'grandchild',
      'other',
      'tail',
    ]);
    expect(normalizeGroupedOrder(result, groups, options)).toEqual(result);
    expect(new Set(result)).toEqual(new Set(order));
    expect(result).toHaveLength(order.length);
  });

  it('does not group children independently or invent missing rows', () => {
    expect(
      normalizeGroupedOrder(
        ['a', 'child', 'x'],
        [group('grp-one', ['child', 'gone'])],
        { stackUnits: [['a', 'child', 'gone']] },
      ),
    ).toEqual(['a', 'child', 'x']);
    expect(
      normalizeGroupedOrder(['a', 'a', 'b'], [], {
        stackUnits: [['gone', 'b'], ['a'], ['a', 'b']],
      }),
    ).toEqual(['a', 'b']);
  });
});

it('retains projected cloud task identities while rejecting path-like members', () => {
  expect(
    readProjectedSidebarItemGroups([
      {
        id: 'grp-release',
        name: 'Release',
        color: 'neutral',
        collapsed: false,
        memberIds: ['cloud:task:chat-a', '../chat-b'],
      },
    ])[0]?.memberIds,
  ).toEqual(['cloud:task:chat-a']);
});

describe('sidebar item groups kept when empty', () => {
  it.each([
    { previous: 0, members: ['a'], collapsed: true, expected: false },
    { previous: 1, members: [], collapsed: false, expected: true },
    { previous: 1, members: ['b', 'c'], collapsed: true, expected: true },
    { previous: 2, members: ['a'], collapsed: false, expected: false },
    { previous: 0, members: [], collapsed: false, expected: false },
  ])(
    'changes disclosure only across an empty boundary: %p',
    ({ previous, members, collapsed, expected }) => {
      expect(
        resolveSidebarItemGroupCollapsed(
          {
            ...group('grp-kept', members),
            keepWhenEmpty: true,
            collapsed,
          },
          previous,
        ),
      ).toBe(expected);
      expect(
        resolveSidebarItemGroupCollapsed(
          {
            ...group('grp-normal', members),
            collapsed,
          },
          previous,
        ),
      ).toBe(collapsed);
    },
  );
  it('keeps an empty group only when it opts out of deletion', () => {
    expect(
      normalizeSidebarItemGroups(
        [
          { ...group('grp-kept', ['gone']), keepWhenEmpty: true },
          group('grp-deleted', ['gone']),
        ],
        { liveItemIds: ['a'] },
      ),
    ).toEqual([
      { ...group('grp-kept', []), keepWhenEmpty: true, collapsed: true },
    ]);
  });

  it('carries the flag through transport projections', () => {
    expect(
      readProjectedSidebarItemGroups([
        { ...group('grp-kept', []), keepWhenEmpty: true },
      ]),
    ).toEqual([{ ...group('grp-kept', []), keepWhenEmpty: true }]);
  });
});

describe('kept group anchors', () => {
  it('points a kept group at the item after its rows and keeps it once empty', () => {
    const kept = { ...group('grp-kept', ['b']), keepWhenEmpty: true };
    const [anchored] = anchorKeptSidebarItemGroups(
      [kept, group('grp-plain', ['a'])],
      ['a', 'b', 'b-child', 'c'],
      { stackUnits: [['b', 'b-child']] },
    );
    expect(anchored).toEqual({ ...kept, emptyAnchorId: 'c' });
    const emptied = { ...anchored, memberIds: [] };
    expect(anchorKeptSidebarItemGroups([emptied], ['a', 'c'])).toEqual([
      emptied,
    ]);
    expect(
      anchorKeptSidebarItemGroups(
        [{ ...emptied, memberIds: ['c'] }],
        ['a', 'c'],
      ),
    ).toEqual([{ ...kept, memberIds: ['c'] }]);
  });

  it('drops an anchor that is no longer live', () => {
    expect(
      normalizeSidebarItemGroups(
        [{ ...group('grp-kept', []), keepWhenEmpty: true, emptyAnchorId: 'x' }],
        { liveItemIds: ['a'] },
      ),
    ).toEqual([{ ...group('grp-kept', []), keepWhenEmpty: true }]);
  });
});

describe('kept group anchors skip ineligible rows', () => {
  const kept = { ...group('grp-kept', ['b']), keepWhenEmpty: true };

  it('anchors past a pinned row that follows the group in registry order', () => {
    expect(
      anchorKeptSidebarItemGroups([kept], ['a', 'b', 'pinned', 'c'], {
        ineligibleItemIds: ['pinned'],
      }),
    ).toEqual([{ ...kept, emptyAnchorId: 'c' }]);
  });

  it('moves an empty group past an anchor that became ineligible', () => {
    const empty = { ...kept, memberIds: [], emptyAnchorId: 'pinned' };
    expect(
      anchorKeptSidebarItemGroups([empty], ['a', 'pinned', 'c'], {
        ineligibleItemIds: ['pinned'],
      }),
    ).toEqual([{ ...empty, emptyAnchorId: 'c' }]);
  });
});
