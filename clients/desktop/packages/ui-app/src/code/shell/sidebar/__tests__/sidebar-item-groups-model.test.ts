import type { SidebarItemGroup } from '@canopy/protocol/sidebar';
import {
  buildSidebarItemGroupBlocks,
  capSidebarItemGroupBlocks,
  resolveSidebarItemGroupDrop,
  sidebarItemGroupDragCapabilities,
  sidebarItemGroupMultiMoves,
  stepSidebarItemGroupKeyboardDrag,
  type SidebarItemGroupUnit,
} from '../sidebar-item-groups-model';

const groups: SidebarItemGroup[] = [
  {
    id: 'grp-one',
    name: 'One',
    color: 'neutral',
    collapsed: false,
    memberIds: ['a', 'b'],
  },
];
const units: SidebarItemGroupUnit[] = [
  { rootId: 'a', itemIds: ['a', 'a-child'], recencyMs: 1 },
  { rootId: 'x', itemIds: ['x'] },
  { rootId: 'b', itemIds: ['b'], recencyMs: 3 },
  { rootId: 'pin', itemIds: ['pin'], pinned: true },
  { rootId: 'z', itemIds: ['z'], recencyMs: 5 },
];
const build = (
  mode: 'manual' | 'last-updated' = 'manual',
): ReturnType<typeof buildSidebarItemGroupBlocks> =>
  buildSidebarItemGroupBlocks(units, groups, mode);

it('keeps pins first and makes the first member slot a complete stack-aware block', () => {
  const blocks = build();
  expect(blocks.map((block) => block.id)).toEqual(['pin', 'grp-one', 'x', 'z']);
  expect(blocks[1]?.visibleItemIds).toEqual(['a', 'a-child', 'b']);
  expect(groups[0]?.memberIds).toEqual(['a', 'b']);
});
it('keeps an existing group anchored while an earlier row is optimistically added', () => {
  const rows = ['incoming', 'neighbor', 'middle', 'anchor', 'tail'].map(
    (rootId) => ({ rootId, itemIds: [rootId] }),
  );
  const destination = { ...groups[0], memberIds: ['anchor'] };
  const neighbor = {
    ...groups[0],
    id: 'grp-neighbor',
    memberIds: ['neighbor'],
  };
  expect(
    buildSidebarItemGroupBlocks(rows, [neighbor, destination], 'manual').map(
      (block) => block.id,
    ),
  ).toEqual(['incoming', 'grp-neighbor', 'middle', 'grp-one', 'tail']);
  expect(
    buildSidebarItemGroupBlocks(
      rows,
      [
        neighbor,
        {
          ...destination,
          memberIds: ['anchor', 'incoming'],
          retainedMemberIds: ['anchor'],
        },
      ],
      'manual',
    ).map((block) => block.id),
  ).toEqual(['grp-neighbor', 'middle', 'grp-one', 'tail']);
});
it('places a row that joined without a position after the retained members, where the registry appends it', () => {
  const rows = ['incoming', 'middle', 'anchor', 'second', 'tail'].map(
    (rootId) => ({ rootId, itemIds: [rootId] }),
  );
  const pending = {
    ...groups[0],
    memberIds: ['anchor', 'second', 'incoming'],
    retainedMemberIds: ['anchor', 'second'],
    pendingPlacements: [{ itemId: 'incoming' }],
  };
  const blocks = buildSidebarItemGroupBlocks(rows, [pending], 'manual');
  expect(blocks.map((block) => block.id)).toEqual([
    'middle',
    'grp-one',
    'tail',
  ]);
  expect(blocks[1]?.units.map((unit) => unit.rootId)).toEqual([
    'anchor',
    'second',
    'incoming',
  ]);
  // Once the row order has caught up there is nothing to retain.
  const settled = buildSidebarItemGroupBlocks(
    ['middle', 'anchor', 'second', 'incoming', 'tail'].map((rootId) => ({
      rootId,
      itemIds: [rootId],
    })),
    [{ ...groups[0], memberIds: ['anchor', 'second', 'incoming'] }],
    'manual',
  );
  expect(settled.map((block) => block.id)).toEqual(blocks.map((b) => b.id));
  expect(settled[1]?.units.map((unit) => unit.rootId)).toEqual(
    blocks[1]?.units.map((unit) => unit.rootId),
  );
});
it.each([
  ['above, dropped before the first member', 'incoming', { before: 'anchor' }],
  ['below, dropped before the first member', 'tail', { before: 'anchor' }],
  ['above, dropped after the first member', 'incoming', { after: 'anchor' }],
  ['below, dropped before the last member', 'tail', { before: 'second' }],
])(
  'places a row joining from %s in the slot it was dropped on',
  (_label, itemId, position) => {
    const rows = ['incoming', 'middle', 'anchor', 'second', 'tail'].map(
      (rootId) => ({ rootId, itemIds: [rootId] }),
    );
    const blocks = buildSidebarItemGroupBlocks(
      rows,
      [
        {
          ...groups[0],
          memberIds: ['anchor', 'second', itemId],
          retainedMemberIds: ['anchor', 'second'],
          pendingPlacements: [{ itemId, ...position }],
        },
      ],
      'manual',
    );
    const expected =
      'before' in position
        ? position.before === 'anchor'
          ? [itemId, 'anchor', 'second']
          : ['anchor', itemId, 'second']
        : ['anchor', itemId, 'second'];
    expect(
      blocks
        .find((block) => block.id === 'grp-one')
        ?.units.map((unit) => unit.rootId),
    ).toEqual(expected);
    // The group itself stays at its retained member's slot.
    expect(blocks.findIndex((block) => block.id === 'grp-one')).toBeGreaterThan(
      blocks.findIndex((block) => block.id === 'middle'),
    );
  },
);
it('keeps canonical row order for a row that joined with no recorded request', () => {
  // A created chat arrives already ordered by the registry, here in the first slot.
  const rows = ['created', 'anchor', 'second', 'tail'].map((rootId) => ({
    rootId,
    itemIds: [rootId],
  }));
  const blocks = buildSidebarItemGroupBlocks(
    rows,
    [
      {
        ...groups[0],
        memberIds: ['anchor', 'second', 'created'],
        retainedMemberIds: ['anchor', 'second'],
      },
    ],
    'manual',
  );
  expect(blocks[0]?.units.map((unit) => unit.rootId)).toEqual([
    'created',
    'anchor',
    'second',
  ]);
});
it('ignores a pending placement whose anchor is not in the group or whose row already has a slot', () => {
  const rows = ['incoming', 'anchor', 'second', 'tail'].map((rootId) => ({
    rootId,
    itemIds: [rootId],
  }));
  const blocks = buildSidebarItemGroupBlocks(
    rows,
    [
      {
        ...groups[0],
        memberIds: ['anchor', 'second', 'incoming'],
        retainedMemberIds: ['anchor', 'second'],
        pendingPlacements: [
          { itemId: 'incoming', before: 'tail' },
          // Stale: `second` is part of the order on screen.
          { itemId: 'second' },
        ],
      },
    ],
    'manual',
  );
  expect(blocks[0]?.units.map((unit) => unit.rootId)).toEqual([
    'incoming',
    'anchor',
    'second',
  ]);
});
it('anchors authoritative groups at their first registry member even when memberIds differ', () => {
  const rows = ['a', 'x', 'b', 'tail'].map((rootId) => ({
    rootId,
    itemIds: [rootId],
  }));
  const group = { ...groups[0], memberIds: ['b', 'a'] };
  const blocks = buildSidebarItemGroupBlocks(rows, [group], 'manual');
  expect(blocks.map((block) => block.id)).toEqual(['grp-one', 'x', 'tail']);
  expect(blocks[0]?.units.map((unit) => unit.rootId)).toEqual(['a', 'b']);
  expect(
    resolveSidebarItemGroupDrop(
      blocks,
      { kind: 'item', id: 'tail' },
      { kind: 'block', blockId: 'grp-one', edge: 'before' },
      'manual',
    ),
  ).toMatchObject({ groupId: null, before: 'a' });
});
it('keeps the same manual position after grouping in last-updated mode and registry reconciliation', () => {
  const rows = ['a', 'x', 'b', 'tail'].map((rootId) => ({
    rootId,
    itemIds: [rootId],
  }));
  const group = { ...groups[0], memberIds: ['b', 'a'] };
  expect(
    buildSidebarItemGroupBlocks(rows, [group], 'last-updated')[0]?.id,
  ).toBe('grp-one');
  const before = buildSidebarItemGroupBlocks(rows, [group], 'manual');
  const after = buildSidebarItemGroupBlocks(
    [rows[0], rows[2], rows[1], rows[3]],
    [group],
    'manual',
  );
  expect(before.map((block) => block.id)).toEqual(
    after.map((block) => block.id),
  );
});
it('falls back to a visible eligible member when the original group anchor is off-page or pinned', () => {
  const rows = [
    { rootId: 'pin', itemIds: ['pin'], pinned: true },
    { rootId: 'middle', itemIds: ['middle'] },
    { rootId: 'anchor', itemIds: ['anchor'] },
  ];
  expect(
    buildSidebarItemGroupBlocks(
      rows,
      [{ ...groups[0], memberIds: ['missing', 'pin', 'anchor'] }],
      'manual',
    ).map((block) => block.id),
  ).toEqual(['pin', 'middle', 'grp-one']);
});
it('sorts timestamped blocks and member units stably, leaving unknown manual slots', () => {
  const blocks = build('last-updated');
  expect(blocks.map((block) => block.id)).toEqual(['pin', 'z', 'x', 'grp-one']);
  expect(blocks[3]?.visibleItemIds).toEqual(['b', 'a', 'a-child']);
});
it('never lets hidden or pinned roots join a displayed group or mutates authority', () => {
  const blocks = buildSidebarItemGroupBlocks(
    units.map((unit) => ({ ...unit, hidden: unit.rootId === 'b' })),
    [{ ...groups[0], memberIds: ['a', 'b', 'pin'] }],
    'manual',
  );
  expect(blocks[1]?.visibleItemIds).toEqual(['a', 'a-child']);
  expect(blocks[0]?.id).toBe('pin');
  expect(groups[0]?.memberIds).toEqual(['a', 'b']);
});
it('retains a selected descendant in a collapsed group without expanding it', () => {
  const blocks = buildSidebarItemGroupBlocks(
    units,
    [{ ...groups[0], collapsed: true }],
    'manual',
    'a-child',
  );
  expect(blocks[1]?.visibleItemIds).toEqual(['a-child']);
  expect(blocks[1]?.units).toHaveLength(2);
});
it('renders a whole group that starts within the cap and hides later blocks', () => {
  const result = capSidebarItemGroupBlocks(build(), 2);
  expect(result.visible.map((block) => block.id)).toEqual(['pin', 'grp-one']);
  expect(result.visible[1]?.visibleItemIds).toHaveLength(3);
  expect(result.hidden.map((block) => block.id)).toEqual(['x', 'z']);
});
it('reports a hidden block even when it contains no hidden members', () => {
  const empty = {
    ...groups[0],
    id: 'grp-empty',
    memberIds: [],
    keepWhenEmpty: true,
  };
  const result = capSidebarItemGroupBlocks(
    buildSidebarItemGroupBlocks(
      [{ rootId: 'row', itemIds: ['row'] }],
      [empty],
      'manual',
    ),
    1,
  );
  expect(result.hidden.map((block) => block.id)).toEqual(['grp-empty']);
  expect(result.hidden.flatMap((block) => block.units)).toEqual([]);
});
it('retains the header and just the selected member beyond the cap', () => {
  const result = capSidebarItemGroupBlocks(build(), 1, 'a-child');
  expect(result.visible[1]).toMatchObject({
    id: 'grp-one',
    retainedSelection: true,
    visibleItemIds: ['a-child'],
  });
  expect(result.hidden[0]?.units).toHaveLength(2);
});
it('counts a collapsed group as one even when selection is visible', () => {
  const blocks = buildSidebarItemGroupBlocks(
    units,
    [{ ...groups[0], collapsed: true }],
    'manual',
    'a',
  );
  expect(
    capSidebarItemGroupBlocks(blocks, 3).visible.map((block) => block.id),
  ).toEqual(['pin', 'grp-one', 'x']);
});
it.each(['before', 'after'] as const)(
  'a member row %s half stays in its group',
  (half) => {
    expect(
      resolveSidebarItemGroupDrop(
        build(),
        { kind: 'item', id: 'x' },
        { kind: 'row', rootId: 'b', half },
        'manual',
      ),
    ).toMatchObject({ groupId: 'grp-one', [half]: 'b', membershipOnly: false });
  },
);
it.each(['before', 'after'] as const)(
  'an outside row %s half remains outside',
  (half) => {
    expect(
      resolveSidebarItemGroupDrop(
        build(),
        { kind: 'item', id: 'a' },
        { kind: 'row', rootId: 'x', half },
        'manual',
      ),
    ).toMatchObject({ groupId: null, [half]: 'x' });
  },
);
it.each(['before', 'inside', 'after'] as const)(
  'collapsed header %s third has explicit membership',
  (third) => {
    expect(
      resolveSidebarItemGroupDrop(
        build(),
        { kind: 'item', id: 'x' },
        { kind: 'collapsed-group', groupId: 'grp-one', third },
        'manual',
      ),
    ).toMatchObject({
      groupId: third === 'inside' ? 'grp-one' : null,
      ...(third === 'before' ? { before: 'a' } : { after: 'b' }),
    });
  },
);
it('rejects nesting, dropping above pins, child drags and group reordering in recency mode', () => {
  expect(
    resolveSidebarItemGroupDrop(
      build(),
      { kind: 'group', id: 'grp-one' },
      { kind: 'collapsed-group', groupId: 'grp-one', third: 'inside' },
      'manual',
    ),
  ).toBeNull();
  expect(
    resolveSidebarItemGroupDrop(
      build(),
      { kind: 'item', id: 'a' },
      { kind: 'row', rootId: 'pin', half: 'before' },
      'manual',
    ),
  ).toBeNull();
  expect(
    resolveSidebarItemGroupDrop(
      build(),
      { kind: 'item', id: 'a-child' },
      { kind: 'row', rootId: 'x', half: 'before' },
      'manual',
    ),
  ).toBeNull();
  expect(
    resolveSidebarItemGroupDrop(
      build(),
      { kind: 'group', id: 'grp-one' },
      { kind: 'block', blockId: 'z', edge: 'before' },
      'last-updated',
    ),
  ).toBeNull();
});
it('keeps membership dragging available under recency without writing manual anchors', () => {
  expect(sidebarItemGroupDragCapabilities('last-updated', units[0])).toEqual({
    membership: true,
    reorder: false,
  });
  expect(
    resolveSidebarItemGroupDrop(
      build(),
      { kind: 'item', id: 'x' },
      { kind: 'row', rootId: 'a', half: 'after' },
      'last-updated',
    ),
  ).toEqual({
    groupId: 'grp-one',
    before: undefined,
    after: undefined,
    membershipOnly: true,
  });
});

it('Space lifts, arrows move between valid whole-block zones, Space drops and Escape cancels', () => {
  const source = { kind: 'group', id: 'grp-one' } as const;
  const lifted = stepSidebarItemGroupKeyboardDrag(
    build(),
    source,
    'manual',
    null,
    ' ',
  );
  expect(lifted.state).toEqual({ targetIndex: 0 });
  const moved = stepSidebarItemGroupKeyboardDrag(
    build(),
    source,
    'manual',
    lifted.state,
    'ArrowDown',
  );
  const dropped = stepSidebarItemGroupKeyboardDrag(
    build(),
    source,
    'manual',
    moved.state,
    ' ',
  );
  expect(dropped).toMatchObject({
    state: null,
    handled: true,
    drop: { groupId: null, after: 'x' },
  });
  expect(
    stepSidebarItemGroupKeyboardDrag(
      build(),
      source,
      'manual',
      moved.state,
      'Escape',
    ),
  ).toEqual({ state: null, handled: true, drop: null });
  expect(
    stepSidebarItemGroupKeyboardDrag(build(), source, 'last-updated', null, ' ')
      .handled,
  ).toBe(false);
});

it.each([
  { kind: 'item', id: 'z' },
  { kind: 'group', id: 'grp-one' },
] as const)('Space then Space leaves $id at its current slot', (source) => {
  const lifted = stepSidebarItemGroupKeyboardDrag(
    build(),
    source,
    'manual',
    null,
    ' ',
  );
  expect(
    stepSidebarItemGroupKeyboardDrag(
      build(),
      source,
      'manual',
      lifted.state,
      ' ',
    ),
  ).toEqual({ state: null, drop: null, handled: true });
});
it('recency keyboard movement visits a group once rather than once per row half', () => {
  const blocks = build();
  const source = { kind: 'item', id: 'x' } as const;
  const lifted = stepSidebarItemGroupKeyboardDrag(
    blocks,
    source,
    'last-updated',
    null,
    ' ',
  );
  const moved = stepSidebarItemGroupKeyboardDrag(
    blocks,
    source,
    'last-updated',
    lifted.state,
    'ArrowUp',
  );
  expect(
    stepSidebarItemGroupKeyboardDrag(
      blocks,
      source,
      'last-updated',
      moved.state,
      ' ',
    ).drop,
  ).toMatchObject({ groupId: 'grp-one', membershipOnly: true });
  const returned = stepSidebarItemGroupKeyboardDrag(
    blocks,
    source,
    'last-updated',
    moved.state,
    'ArrowUp',
  );
  expect(
    stepSidebarItemGroupKeyboardDrag(
      blocks,
      source,
      'last-updated',
      returned.state,
      ' ',
    ).drop,
  ).toBeNull();
});
it.each([
  { rootId: 'z', half: 'before' },
  { rootId: 'x', half: 'after' },
] as const)(
  'group drag rejects internal $rootId/$half target halves',
  (target) => {
    const blocks = buildSidebarItemGroupBlocks(
      units,
      [...groups, { ...groups[0], id: 'grp-two', memberIds: ['x', 'z'] }],
      'manual',
    );
    expect(
      resolveSidebarItemGroupDrop(
        blocks,
        { kind: 'group', id: 'grp-one' },
        { kind: 'row', ...target },
        'manual',
      ),
    ).toBeNull();
  },
);
it('group drag accepts the outer boundary of another whole group', () => {
  const blocks = buildSidebarItemGroupBlocks(
    units,
    [...groups, { ...groups[0], id: 'grp-two', memberIds: ['x', 'z'] }],
    'manual',
  );
  expect(
    resolveSidebarItemGroupDrop(
      blocks,
      { kind: 'group', id: 'grp-one' },
      { kind: 'row', rootId: 'x', half: 'before' },
      'manual',
    ),
  ).toMatchObject({ groupId: null, before: 'x' });
});

it.each(['manual', 'last-updated'] as const)(
  'pinned rows reorder only among pins in %s mode',
  (mode) => {
    const blocks = buildSidebarItemGroupBlocks(
      [...units, { rootId: 'pin-two', itemIds: ['pin-two'], pinned: true }],
      groups,
      mode,
    );
    expect(
      resolveSidebarItemGroupDrop(
        blocks,
        { kind: 'item', id: 'pin-two' },
        { kind: 'row', rootId: 'pin', half: 'before' },
        mode,
      ),
    ).toEqual({
      groupId: null,
      before: 'pin',
      after: undefined,
      membershipOnly: false,
    });
    expect(
      resolveSidebarItemGroupDrop(
        blocks,
        { kind: 'item', id: 'pin-two' },
        { kind: 'row', rootId: 'a', half: 'before' },
        mode,
      ),
    ).toBeNull();
    expect(
      resolveSidebarItemGroupDrop(
        blocks,
        { kind: 'item', id: 'a' },
        { kind: 'row', rootId: 'pin', half: 'after' },
        mode,
      ),
    ).toBeNull();
  },
);

it('trails an empty kept group that only accepts members dropped inside it', () => {
  const kept: SidebarItemGroup = {
    id: 'grp-kept',
    name: 'Kept',
    color: 'neutral',
    collapsed: false,
    keepWhenEmpty: true,
    memberIds: [],
  };
  const blocks = buildSidebarItemGroupBlocks(
    units,
    [...groups, kept, { ...kept, id: 'grp-gone', keepWhenEmpty: undefined }],
    'manual',
  );
  expect(blocks.map((block) => block.id)).toEqual([
    'pin',
    'grp-one',
    'x',
    'z',
    'grp-kept',
  ]);
  expect(blocks.at(-1)).toMatchObject({ units: [], visibleItemIds: [] });
  const source = { kind: 'item' as const, id: 'x' };
  expect(
    resolveSidebarItemGroupDrop(
      blocks,
      source,
      { kind: 'collapsed-group', groupId: 'grp-kept', third: 'inside' },
      'manual',
    ),
  ).toEqual({ groupId: 'grp-kept', membershipOnly: false });
  expect(
    resolveSidebarItemGroupDrop(
      blocks,
      source,
      { kind: 'block', blockId: 'grp-kept', edge: 'before' },
      'manual',
    ),
  ).toBeNull();
});

it('keeps an empty kept group above its anchor, including while its first row joins', () => {
  const kept: SidebarItemGroup = {
    id: 'grp-kept',
    name: 'Kept',
    color: 'neutral',
    collapsed: false,
    keepWhenEmpty: true,
    emptyAnchorId: 'x',
    memberIds: [],
  };
  const ids = (blocks: readonly { id: string }[]): string[] =>
    blocks.map((block) => block.id);
  expect(
    ids(buildSidebarItemGroupBlocks(units, [...groups, kept], 'manual')),
  ).toEqual(['pin', 'grp-one', 'grp-kept', 'x', 'z']);
  // `z` joined, but the order still predates the move: it shows at the slot.
  expect(
    ids(
      buildSidebarItemGroupBlocks(
        units,
        [...groups, { ...kept, memberIds: ['z'], retainedMemberIds: [] }],
        'manual',
      ),
    ),
  ).toEqual(['pin', 'grp-one', 'grp-kept', 'x']);
  // The anchor itself joining stays where it is.
  expect(
    ids(
      buildSidebarItemGroupBlocks(
        units,
        [...groups, { ...kept, memberIds: ['x'], retainedMemberIds: [] }],
        'manual',
      ),
    ),
  ).toEqual(['pin', 'grp-one', 'grp-kept', 'z']);
});

it('joins the end of an expanded group from its header or body', () => {
  const blocks = buildSidebarItemGroupBlocks(units, groups, 'manual');
  expect(
    resolveSidebarItemGroupDrop(
      blocks,
      { kind: 'item', id: 'x' },
      { kind: 'collapsed-group', groupId: 'grp-one', third: 'inside' },
      'manual',
    ),
  ).toEqual({ groupId: 'grp-one', after: 'b', membershipOnly: false });
});

describe('sidebarItemGroupMultiMoves (CAN-3975)', () => {
  // pin | grp-one (a, b) | x | z
  const blocks = buildSidebarItemGroupBlocks(units, groups, 'manual');
  const moves = (
    itemIds: string[],
    drop: Parameters<typeof sidebarItemGroupMultiMoves>[2],
  ): [string, unknown][] =>
    sidebarItemGroupMultiMoves(blocks, itemIds, drop).map((move) => [
      move.itemId,
      move.drop,
    ]);

  it('lands the selection together, in rail order, at the dragged row slot', () => {
    expect(
      moves(['x', 'z'], {
        groupId: 'grp-one',
        after: 'b',
        membershipOnly: false,
      }),
    ).toEqual([
      ['x', { groupId: 'grp-one', after: 'b', membershipOnly: false }],
      ['z', { groupId: 'grp-one', after: 'x', membershipOnly: false }],
    ]);
  });

  it('moves only the rows not already in the group when order is not manual', () => {
    expect(
      moves(['a', 'x', 'z'], { groupId: 'grp-one', membershipOnly: true }),
    ).toEqual([
      ['x', { groupId: 'grp-one', membershipOnly: true }],
      ['z', { groupId: 'grp-one', membershipOnly: true }],
    ]);
  });

  it('re-anchors a slot beside another selected row on the nearest row staying put', () => {
    expect(
      moves(['a', 'x'], {
        groupId: 'grp-one',
        before: 'a',
        membershipOnly: false,
      }),
    ).toEqual([
      ['a', { groupId: 'grp-one', before: 'b', membershipOnly: false }],
      ['x', { groupId: 'grp-one', after: 'a', membershipOnly: false }],
    ]);
    expect(
      moves(['a', 'z'], {
        groupId: 'grp-one',
        after: 'a',
        membershipOnly: false,
      }),
    ).toEqual([
      ['a', { groupId: 'grp-one', before: 'b', membershipOnly: false }],
      ['z', { groupId: 'grp-one', after: 'a', membershipOnly: false }],
    ]);
  });

  it('fills a group the selection already owns from its first slot', () => {
    expect(
      moves(['a', 'b', 'x'], {
        groupId: 'grp-one',
        after: 'b',
        membershipOnly: false,
      }),
    ).toEqual([
      ['a', { groupId: 'grp-one', membershipOnly: false }],
      ['b', { groupId: 'grp-one', after: 'a', membershipOnly: false }],
      ['x', { groupId: 'grp-one', after: 'b', membershipOnly: false }],
    ]);
  });

  it('ungroups the selection beside a row outside any group', () => {
    expect(
      moves(['a', 'b'], { groupId: null, after: 'z', membershipOnly: false }),
    ).toEqual([
      ['a', { groupId: null, after: 'z', membershipOnly: false }],
      ['b', { groupId: null, after: 'a', membershipOnly: false }],
    ]);
  });
});
