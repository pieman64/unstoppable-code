/** @jest-environment jsdom */
import type { SidebarItemGroup } from '@canopy/protocol/sidebar';
jest.mock('../workspaceContextStore', () => ({
  useWorkspaceContextStore: { subscribe: jest.fn() },
}));
jest.mock('../projectsStore', () => ({
  useProjectsStore: {
    getState: (): {
      projects: typeof mockProjects;
      loadProjects: typeof mockLoadProjects;
    } => ({ projects: mockProjects, loadProjects: mockLoadProjects }),
  },
}));
jest.mock('../standaloneChatStore', () => ({
  getWorkEntrySnapshotRevision: (): number => mockEntryRevision,
  useStandaloneChatStore: {
    getState: (): {
      refreshWorkEntries: typeof mockRefreshEntries;
      activeChatProjectId: string;
      workEntries: { id: string }[];
      sidebarEntriesByProject: Record<string, { id: string }[]>;
      applyWorkEntriesSnapshot: jest.Mock;
    } => ({
      refreshWorkEntries: mockRefreshEntries,
      activeChatProjectId:
        mockDetachedCowork || mockProjects.length > 0 ? 'ws-one' : 'other',
      workEntries: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      sidebarEntriesByProject: mockSidebarEntries,
      applyWorkEntriesSnapshot: mockApplyEntries,
    }),
  },
}));
const mockLoadProjects = jest.fn(() => Promise.resolve());
const mockRefreshEntries = jest.fn(() => Promise.resolve());
const mockApplyEntries = jest.fn();
let mockEntryRevision = 0;
let mockProjects: { id: string; type: 'cowork' }[] = [];
let mockDetachedCowork = false;
let mockSidebarEntries: Record<string, { id: string }[]> = {};
import type { SessionViewModel } from '@canopy/app-core';
import {
  buildSidebarItemGroupBlocks,
  type SidebarItemGroupView,
} from '@canopy/ui-app/sidebar';
import {
  overlaySidebarItemGroups,
  resetSidebarItemGroupPlacementRequestsForTests,
  useSidebarItemGroupsStore as store,
} from '../sidebarItemGroupsStore';

const scope = { workspaceLocalId: 'ws-one' };
const group: SidebarItemGroup = {
  id: 'grp-one',
  name: 'Before',
  color: 'neutral',
  collapsed: false,
  memberIds: ['a'],
};
const list = jest.fn(() => Promise.resolve([group]));
const update = jest.fn(() => Promise.resolve());
const createGroup = jest.fn(() => Promise.resolve(group));
const moveItem = jest.fn(() => Promise.resolve());
beforeEach(() => {
  mockProjects = [];
  mockDetachedCowork = false;
  mockSidebarEntries = {};
  store.setState({ byScope: {}, errors: {} });
  resetSidebarItemGroupPlacementRequestsForTests();
  list.mockReset().mockResolvedValue([group]);
  update.mockReset().mockResolvedValue();
  createGroup.mockReset().mockResolvedValue(group);
  moveItem.mockReset().mockResolvedValue();
  mockLoadProjects.mockReset().mockResolvedValue();
  mockRefreshEntries.mockReset().mockResolvedValue();
  mockApplyEntries.mockReset();
  mockEntryRevision = 0;
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      workEntries: {
        list: jest.fn().mockResolvedValue({
          entries: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        }),
      },
      sidebarItemGroups: { list, update, create: createGroup, moveItem },
    },
  });
});

it('does not reload every project to reconcile a Cowork placement', async () => {
  mockProjects = [{ id: scope.workspaceLocalId, type: 'cowork' }];
  await store.getState().hydrate(scope);
  await store.getState().moveItem({ scope, itemId: 'a', groupId: null });
  expect(mockLoadProjects).not.toHaveBeenCalled();
});

it('retries placement reconciliation if another entry snapshot wins while its read is pending', async () => {
  jest.useFakeTimers();
  try {
    mockProjects = [{ id: scope.workspaceLocalId, type: 'cowork' }];
    await store.getState().hydrate(scope);
    let release:
      | ((response: { entries: { id: string }[] }) => void)
      | undefined;
    window.api.workEntries.list = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue({ entries: [{ id: 'c' }, { id: 'a' }, { id: 'b' }] });
    await store
      .getState()
      .moveItem({ scope, itemId: 'c', groupId: null, before: 'a' });
    mockEntryRevision += 1;
    release?.({ entries: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(mockApplyEntries).not.toHaveBeenCalled();
    expect(store.getState().orderByScope['workspace:ws-one']).toEqual([
      'c',
      'a',
      'b',
    ]);
    await jest.advanceTimersByTimeAsync(250);
    expect(mockApplyEntries).toHaveBeenCalledWith('ws-one', [
      { id: 'c' },
      { id: 'a' },
      { id: 'b' },
    ]);
    expect(window.api.workEntries.list).toHaveBeenCalledTimes(2);
  } finally {
    resetSidebarItemGroupPlacementRequestsForTests();
    jest.useRealTimers();
  }
});

/** What the Code sidebar shows while its snapshot still has only `a` in the group. */
function shownWhileOrderIsStale(): SessionViewModel['workspaces'][number]['itemGroups'] {
  const stale = {
    workspaces: [{ localId: 'ws-one', itemGroups: [group] }],
  } as unknown as SessionViewModel;
  return overlaySidebarItemGroups(stale, store.getState().byScope)
    .workspaces?.[0]?.itemGroups;
}

function isSidebarItemGroupView(
  group: SidebarItemGroup,
): group is SidebarItemGroupView {
  return 'retainedMemberIds' in group;
}

function shownPendingPlacements(): SidebarItemGroupView['pendingPlacements'] {
  const group = shownWhileOrderIsStale()?.[0];
  if (!group || !isSidebarItemGroupView(group)) return undefined;
  return group.pendingPlacements;
}

it('creates an optimistic group with a hidden default name unique in the scope', async () => {
  const occupiedDefault = {
    ...group,
    id: 'grp-other',
    name: 'Group 1',
    memberIds: ['other-item'],
  };
  list.mockResolvedValueOnce([group, occupiedDefault]);
  await store.getState().hydrate(scope);

  let finishCreate: (created: SidebarItemGroup) => void = (): void => undefined;
  createGroup.mockReturnValueOnce(
    new Promise<SidebarItemGroup>((resolve) => {
      finishCreate = resolve;
    }),
  );
  const pending = store
    .getState()
    .create({ scope, itemId: 'created-item', color: 'neutral' });
  await Promise.resolve();
  await Promise.resolve();

  expect(
    store
      .getState()
      .byScope['workspace:ws-one']?.find((item) => item.id === 'grp-pending'),
  ).toEqual({
    id: 'grp-pending',
    name: 'Group 2',
    color: 'neutral',
    collapsed: false,
    labelHidden: true,
    memberIds: ['created-item'],
  });

  const created: SidebarItemGroup = {
    id: 'grp-created',
    name: 'Group 2',
    color: 'neutral',
    collapsed: false,
    labelHidden: true,
    memberIds: ['created-item'],
  };
  list.mockResolvedValueOnce([group, occupiedDefault, created]);
  finishCreate(created);
  await pending;
});

it('shows a custom name optimistically when labelHidden is explicitly false', async () => {
  const hidden = { ...group, labelHidden: true };
  list.mockResolvedValueOnce([hidden]);
  await store.getState().hydrate(scope);

  let finishUpdate: () => void = (): void => undefined;
  update.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finishUpdate = resolve;
    }),
  );
  const mutation = store
    .getState()
    .update({ scope, groupId: group.id, name: 'Frontend', labelHidden: false });
  await Promise.resolve();
  await Promise.resolve();

  const shown = { ...group, name: 'Frontend' };
  expect(store.getState().byScope['workspace:ws-one']).toEqual([shown]);
  expect(update).toHaveBeenCalledWith({
    scope,
    groupId: group.id,
    name: 'Frontend',
    labelHidden: false,
  });

  list.mockResolvedValueOnce([shown]);
  finishUpdate();
  await mutation;
  expect(store.getState().byScope['workspace:ws-one']).toEqual([shown]);
});

it('hides an existing custom name optimistically when labelHidden is true', async () => {
  list.mockResolvedValueOnce([group]);
  await store.getState().hydrate(scope);

  let finishUpdate: () => void = (): void => undefined;
  update.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finishUpdate = resolve;
    }),
  );
  const mutation = store
    .getState()
    .update({ scope, groupId: group.id, labelHidden: true });
  await Promise.resolve();
  await Promise.resolve();

  expect(store.getState().byScope['workspace:ws-one']?.[0]).toEqual({
    ...group,
    labelHidden: true,
  });
  expect(update).toHaveBeenCalledWith({
    scope,
    groupId: group.id,
    labelHidden: true,
  });

  const hidden = { ...group, labelHidden: true };
  list.mockResolvedValueOnce([hidden]);
  finishUpdate();
  await mutation;
  expect(store.getState().byScope['workspace:ws-one']).toEqual([hidden]);
});

it('turns a blank updated name into a hidden default name', async () => {
  await store.getState().hydrate(scope);
  const defaulted = {
    ...group,
    name: 'Group 1',
    labelHidden: true,
  };
  list.mockResolvedValueOnce([defaulted]);

  await store.getState().update({ scope, groupId: group.id, name: '' });

  expect(store.getState().byScope['workspace:ws-one']).toEqual([defaulted]);
});

it('keeps a generated default name when its color changes', async () => {
  const defaultNamed = { ...group, name: 'Group 1', labelHidden: true };
  list.mockResolvedValueOnce([defaultNamed]);
  await store.getState().hydrate(scope);

  let finishUpdate: () => void = (): void => undefined;
  update.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finishUpdate = resolve;
    }),
  );
  const mutation = store.getState().update({
    scope,
    groupId: group.id,
    color: 'categorical-2',
  });
  await Promise.resolve();
  await Promise.resolve();

  const recolored: SidebarItemGroup = {
    ...group,
    name: 'Group 1',
    color: 'categorical-2',
    labelHidden: true,
  };
  expect(store.getState().byScope['workspace:ws-one']).toEqual([recolored]);

  list.mockResolvedValueOnce([recolored]);
  finishUpdate();
  await mutation;
  expect(store.getState().byScope['workspace:ws-one']).toEqual([recolored]);
});

it('preserves a custom hidden name when its color changes', async () => {
  const hidden = { ...group, labelHidden: true };
  list.mockResolvedValueOnce([hidden]);
  await store.getState().hydrate(scope);
  const recolored: SidebarItemGroup = {
    ...hidden,
    color: 'categorical-2',
  };
  list.mockResolvedValueOnce([recolored]);

  await store
    .getState()
    .update({ scope, groupId: group.id, color: 'categorical-2' });

  expect(store.getState().byScope['workspace:ws-one']).toEqual([recolored]);
});

it('committed creation keeps the real group identity when membership refresh fails', async () => {
  await store.getState().hydrate(scope);
  list.mockRejectedValueOnce(new Error('refresh unavailable'));
  const created = { ...group, id: 'grp-created', memberIds: ['b'] };
  createGroup.mockResolvedValueOnce(created);
  await expect(
    store.getState().create({ scope, itemId: 'b' }),
  ).resolves.toEqual(created);
  expect(
    store
      .getState()
      .byScope[
        'workspace:ws-one'
      ]?.find((item) => item.memberIds.includes('b')),
  ).toEqual(created);
});

it.each(['membership', 'order'] as const)(
  'post-commit %s refresh failure preserves success and optimism',
  async (owner) => {
    await store.getState().hydrate(scope);
    if (owner === 'membership')
      list.mockRejectedValueOnce(new Error('refresh unavailable'));
    else
      mockLoadProjects.mockRejectedValueOnce(new Error('refresh unavailable'));
    list.mockResolvedValue([{ ...group, name: 'Committed' }]);
    await expect(
      store.getState().update({ scope, groupId: group.id, name: 'Committed' }),
    ).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledTimes(1);
    expect(store.getState().byScope['workspace:ws-one']?.[0]?.name).toBe(
      'Committed',
    );
    expect(store.getState().errors['workspace:ws-one']).toBe(
      'refresh unavailable',
    );
  },
);

it('keeps the projected group snapshot until the canonical row refresh finishes', async () => {
  await store.getState().hydrate(scope);
  let releaseOrder: () => void = (): void => undefined;
  mockLoadProjects.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      releaseOrder = resolve;
    }),
  );
  const pending = store
    .getState()
    .update({ scope, groupId: group.id, name: 'Committed' });
  await Promise.resolve();
  await Promise.resolve();
  expect(list).toHaveBeenCalledTimes(1);
  releaseOrder();
  await pending;
  expect(list).toHaveBeenCalledTimes(2);
});

it('a change broadcast during a move keeps the retained anchor until canonical row order lands', async () => {
  await store.getState().hydrate(scope);
  let releaseOrder: () => void = (): void => undefined;
  mockLoadProjects.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      releaseOrder = resolve;
    }),
  );
  const committed = { ...group, memberIds: ['a', 'moved'] };
  list.mockResolvedValue([committed]);
  const moving = store
    .getState()
    .moveItem({ scope, itemId: 'moved', groupId: group.id });
  await Promise.resolve();
  await Promise.resolve();
  expect(moveItem).toHaveBeenCalledTimes(1);
  // The host hydrates on main's commit broadcast, before the row order reload.
  const broadcast = store.getState().hydrate(scope);
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getState().byScope['workspace:ws-one']).toEqual([
      {
        ...committed,
        retainedMemberIds: ['a'],
        pendingPlacements: [{ itemId: 'moved' }],
      },
    ]);
  } finally {
    releaseOrder();
    await moving;
    await broadcast;
  }
  // Registry-shaped again: other consumers read `byScope` as plain groups.
  expect(store.getState().byScope['workspace:ws-one']).toEqual([committed]);
  // The request itself outlives the read, for a sidebar whose row order
  // still predates the move.
  expect(shownWhileOrderIsStale()).toEqual([
    {
      ...committed,
      retainedMemberIds: ['a'],
      pendingPlacements: [{ itemId: 'moved' }],
    },
  ]);
});

it.each([
  ['before', { before: 'a' }],
  ['after', { after: 'a' }],
] as const)(
  'a positioned move records the requested slot (%s) after the earlier request',
  async (_side, position) => {
    list.mockResolvedValue([{ ...group, memberIds: ['a', 'moved'] }]);
    await store.getState().hydrate(scope);
    await store
      .getState()
      .moveItem({ scope, itemId: 'moved', groupId: group.id });
    await store
      .getState()
      .moveItem({ scope, itemId: 'moved', groupId: group.id, ...position });
    expect(shownPendingPlacements()).toEqual([
      { itemId: 'moved' },
      { itemId: 'moved', ...position },
    ]);
  },
);

it.each([
  ['rename', { name: 'Renamed' }],
  ['recolor', { color: 'categorical-1' }],
  ['collapse', { collapsed: true }],
] as const)(
  'a %s keeps the slot a joined row asked for, through the edit and its read',
  async (_edit, patch) => {
    await store.getState().hydrate(scope);
    const joined = { ...group, memberIds: ['a', 'moved'] };
    list.mockResolvedValue([joined]);
    await store
      .getState()
      .moveItem({ scope, itemId: 'moved', groupId: group.id, before: 'a' });
    let finishWrite: () => void = (): void => undefined;
    update.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishWrite = resolve;
      }),
    );
    list.mockResolvedValue([{ ...joined, ...patch }]);
    const editing = store
      .getState()
      .update({ scope, groupId: group.id, ...patch });
    await Promise.resolve();
    await Promise.resolve();
    const placement = [{ itemId: 'moved', before: 'a' }];
    try {
      expect(shownPendingPlacements()).toEqual(placement);
    } finally {
      finishWrite();
      await editing;
    }
    expect(store.getState().byScope['workspace:ws-one']).toEqual([
      { ...joined, ...patch },
    ]);
    expect(shownPendingPlacements()).toEqual(placement);
  },
);

it('replays every pending move in order, so a row moved twice lands where main puts it', async () => {
  await store.getState().hydrate(scope);
  const settled = { ...group, memberIds: ['a', 'x', 'b'] };
  list.mockResolvedValue([settled]);
  // Main: x joins last [a, x]; b goes before x [a, b, x]; x goes before b [a, x, b].
  await store.getState().moveItem({ scope, itemId: 'x', groupId: group.id });
  await store
    .getState()
    .moveItem({ scope, itemId: 'b', groupId: group.id, before: 'x' });
  await store
    .getState()
    .moveItem({ scope, itemId: 'x', groupId: group.id, before: 'b' });
  const shown = shownWhileOrderIsStale();
  // The snapshot's order still predates all three moves: x, b above a.
  const blocks = buildSidebarItemGroupBlocks(
    ['x', 'b', 'a'].map((rootId) => ({ rootId, itemIds: [rootId] })),
    shown ?? [],
    'manual',
  );
  expect(blocks[0]?.units.map((unit) => unit.rootId)).toEqual(['a', 'x', 'b']);
});

it('drops a recorded request once the row has left the group', async () => {
  await store.getState().hydrate(scope);
  const joined = { ...group, memberIds: ['a', 'moved'] };
  list.mockResolvedValue([joined]);
  await store
    .getState()
    .moveItem({ scope, itemId: 'moved', groupId: group.id });
  list.mockResolvedValue([group]);
  await store.getState().hydrate(scope);
  // It rejoins from another surface: nothing recorded here applies to it.
  list.mockResolvedValue([joined]);
  await store.getState().hydrate(scope);
  expect(shownWhileOrderIsStale()).toEqual([
    { ...joined, retainedMemberIds: ['a'] },
  ]);
});

it('a created row records no request and clears an older one for a reused id', async () => {
  await store.getState().hydrate(scope);
  const joined = { ...group, memberIds: ['a', 'reused'] };
  list.mockResolvedValue([joined]);
  await store
    .getState()
    .moveItem({ scope, itemId: 'reused', groupId: group.id });
  store.getState().confirmCreatedItem(scope, group.id, 'reused');
  expect(shownWhileOrderIsStale()).toEqual([
    { ...joined, retainedMemberIds: ['a'] },
  ]);
});

it('a failed move leaves no request behind', async () => {
  await store.getState().hydrate(scope);
  moveItem.mockRejectedValueOnce(new Error('move failed'));
  await expect(
    store.getState().moveItem({ scope, itemId: 'moved', groupId: group.id }),
  ).rejects.toThrow('move failed');
  list.mockResolvedValue([{ ...group, memberIds: ['a', 'moved'] }]);
  await store.getState().hydrate(scope);
  expect(shownPendingPlacements()).toBeUndefined();
});

it('rolls back then refetches membership and canonical order after a partial write failure', async () => {
  await store.getState().hydrate(scope);
  let reject: (error: Error) => void = (): void => undefined;
  const held = new Promise<void>((_resolve, rejectValue) => {
    reject = rejectValue;
  });
  update.mockReturnValueOnce(held);
  const mutation = store
    .getState()
    .update({ scope, groupId: group.id, name: 'Optimistic' });
  await Promise.resolve();
  await Promise.resolve();
  expect(store.getState().byScope['workspace:ws-one']?.[0]?.name).toBe(
    'Optimistic',
  );
  list.mockResolvedValueOnce([{ ...group, name: 'Durable' }]);
  reject(new Error('membership write failed'));
  await expect(mutation).rejects.toThrow('membership write failed');
  expect(store.getState().byScope['workspace:ws-one']?.[0]?.name).toBe(
    'Durable',
  );
  expect(store.getState().errors['workspace:ws-one']).toBe(
    'membership write failed',
  );
  expect(mockLoadProjects).toHaveBeenCalledWith({ silent: true });
});

it('a read started before a mutation cannot erase its optimistic state', async () => {
  await store.getState().hydrate(scope);
  let finishRead: (groups: SidebarItemGroup[]) => void = (): void => undefined;
  const staleRead = new Promise<SidebarItemGroup[]>((resolve) => {
    finishRead = resolve;
  });
  list.mockReturnValueOnce(staleRead);
  const reading = store.getState().hydrate(scope);
  let finishWrite: () => void = (): void => undefined;
  update.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finishWrite = resolve;
    }),
  );
  const writing = store
    .getState()
    .update({ scope, groupId: group.id, collapsed: true });
  await Promise.resolve();
  await Promise.resolve();
  finishRead([group]);
  await reading;
  expect(store.getState().byScope['workspace:ws-one']?.[0]?.collapsed).toBe(
    true,
  );
  list.mockResolvedValueOnce([{ ...group, collapsed: true }]);
  finishWrite();
  await writing;
  expect(store.getState().byScope['workspace:ws-one']?.[0]?.collapsed).toBe(
    true,
  );
});

it('keeps scopes isolated and serializes concurrent mutations without dropping the second intent', async () => {
  await store.getState().hydrate(scope);
  let finish: () => void = (): void => undefined;
  update.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const first = store
    .getState()
    .update({ scope, groupId: group.id, name: 'First' });
  const second = store
    .getState()
    .update({ scope, groupId: group.id, collapsed: true });
  await Promise.resolve();
  await Promise.resolve();
  expect(update).toHaveBeenCalledTimes(1);
  finish();
  await first;
  await second;
  expect(update).toHaveBeenCalledTimes(2);
  expect(store.getState().byScope['app-advisor']).toBeUndefined();
});

it('creation ACK retains membership against an older held hydration', async () => {
  await store.getState().hydrate(scope);
  let finishRead: (groups: SidebarItemGroup[]) => void = (): void => undefined;
  list.mockReturnValueOnce(
    new Promise<SidebarItemGroup[]>((resolve) => {
      finishRead = resolve;
    }),
  );
  const reading = store.getState().hydrate(scope);
  store.getState().confirmCreatedItem(scope, group.id, 'created');
  finishRead([group]);
  await reading;
  expect(store.getState().byScope['workspace:ws-one']?.[0]?.memberIds).toEqual([
    'a',
    'created',
  ]);
});

it.each([false, true])(
  'confirmation before hydration (read already pending: %s) preserves all groups and confirmed membership',
  async (readAlreadyPending) => {
    let finishRead: (groups: SidebarItemGroup[]) => void = (): void =>
      undefined;
    list.mockReturnValueOnce(
      new Promise<SidebarItemGroup[]>((resolve) => {
        finishRead = resolve;
      }),
    );
    const reading = readAlreadyPending
      ? store.getState().hydrate(scope)
      : undefined;
    store.getState().confirmCreatedItem(scope, group.id, 'newly-created');
    const beforeHydration = store.getState().byScope['workspace:ws-one'];
    const hydrated = reading ?? store.getState().hydrate(scope);
    const other = { ...group, id: 'grp-other', memberIds: ['other-item'] };
    finishRead([group, other]);
    await hydrated;
    expect(beforeHydration).toBeUndefined();
    expect(store.getState().byScope['workspace:ws-one']).toEqual([
      { ...group, memberIds: ['a', 'newly-created'] },
      other,
    ]);
  },
);

it.each([false, true])(
  'root creation ACK clears reused membership despite an older hydration (source has another member: %s)',
  async (hasOtherMember) => {
    const original = {
      ...group,
      memberIds: hasOtherMember ? ['reused', 'remaining'] : ['reused'],
    };
    list.mockResolvedValueOnce([original]);
    await store.getState().hydrate(scope);
    let finishRead: (groups: SidebarItemGroup[]) => void = (): void =>
      undefined;
    list.mockReturnValueOnce(
      new Promise<SidebarItemGroup[]>((resolve) => {
        finishRead = resolve;
      }),
    );
    const reading = store.getState().hydrate(scope);
    store.getState().confirmCreatedItem(scope, null, 'reused');
    const expected = hasOtherMember
      ? [{ ...original, memberIds: ['remaining'] }]
      : [];
    expect(store.getState().byScope['workspace:ws-one']).toEqual(expected);
    finishRead([original]);
    await reading;
    expect(store.getState().byScope['workspace:ws-one']).toEqual(expected);
  },
);

it('unhydrated root ACK replaces an earlier grouped confirmation', async () => {
  store.getState().confirmCreatedItem(scope, group.id, 'reused');
  store.getState().confirmCreatedItem(scope, null, 'reused');
  list.mockResolvedValueOnce([{ ...group, memberIds: ['a', 'reused'] }]);
  await store.getState().hydrate(scope);
  expect(store.getState().byScope['workspace:ws-one']).toEqual([
    { ...group, memberIds: ['a'] },
  ]);
});

it.each([false, true])(
  'creation ACK transfers reused membership and prunes an empty source (source has another member: %s)',
  async (hasOtherMember) => {
    const original = {
      ...group,
      id: 'grp-original',
      memberIds: hasOtherMember ? ['reused', 'remaining'] : ['reused'],
    };
    list.mockResolvedValueOnce([original, group]);
    await store.getState().hydrate(scope);
    let finishRead: (groups: SidebarItemGroup[]) => void = (): void =>
      undefined;
    list.mockReturnValueOnce(
      new Promise<SidebarItemGroup[]>((resolve) => {
        finishRead = resolve;
      }),
    );
    const reading = store.getState().hydrate(scope);
    store.getState().confirmCreatedItem(scope, group.id, 'reused');
    const expected = [
      ...(hasOtherMember ? [{ ...original, memberIds: ['remaining'] }] : []),
      {
        ...group,
        memberIds: ['a', 'reused'],
        retainedMemberIds: ['a'],
      },
    ];
    expect(store.getState().byScope['workspace:ws-one']).toEqual(expected);
    finishRead([original, group]);
    await reading;
    expect(store.getState().byScope['workspace:ws-one']).toEqual(expected);
  },
);

it.each([false, true])(
  'unhydrated creation confirmations transfer reused membership (second destination: %s)',
  async (movesAgain) => {
    const original = { ...group, id: 'grp-original', memberIds: ['reused'] };
    const last = { ...group, id: 'grp-last', memberIds: ['last'] };
    let finishRead: (groups: SidebarItemGroup[]) => void = (): void =>
      undefined;
    list.mockReturnValueOnce(
      new Promise<SidebarItemGroup[]>((resolve) => {
        finishRead = resolve;
      }),
    );
    const reading = store.getState().hydrate(scope);
    store.getState().confirmCreatedItem(scope, group.id, 'reused');
    if (movesAgain)
      store.getState().confirmCreatedItem(scope, last.id, 'reused');
    finishRead([original, group, last]);
    await reading;
    expect(store.getState().byScope['workspace:ws-one']).toEqual([
      { ...group, memberIds: movesAgain ? ['a'] : ['a', 'reused'] },
      { ...last, memberIds: movesAgain ? ['last', 'reused'] : ['last'] },
    ]);
  },
);

// The Code sidebar orders rows from the session snapshot, which main rebuilds
// on its own schedule; hydrated membership can be newer than that order.
it.each([
  ['an incoming member', ['a', 'moved'], ['a']],
  ['a removed member', ['a'], ['a', 'removed']],
])(
  'anchors a group by the snapshot membership its row order was built from (%s)',
  (_label, hydrated, projected) => {
    const snapshot = {
      workspaces: [
        { localId: 'ws-one', itemGroups: [{ ...group, memberIds: projected }] },
      ],
    } as unknown as SessionViewModel;
    const overlaid = overlaySidebarItemGroups(snapshot, {
      'workspace:ws-one': [{ ...group, memberIds: hydrated }],
    });
    expect(overlaid.workspaces?.[0]?.itemGroups).toEqual([
      { ...group, memberIds: hydrated, retainedMemberIds: projected },
    ]);
  },
);

it('stops retaining a pending anchor once the snapshot order includes the change', () => {
  const snapshot = {
    workspaces: [
      {
        localId: 'ws-one',
        itemGroups: [{ ...group, memberIds: ['a', 'moved'] }],
      },
    ],
  } as unknown as SessionViewModel;
  expect(
    overlaySidebarItemGroups(snapshot, {
      'workspace:ws-one': [
        { ...group, memberIds: ['a', 'moved'], retainedMemberIds: ['a'] },
      ],
    }).workspaces?.[0]?.itemGroups,
  ).toEqual([{ ...group, memberIds: ['a', 'moved'] }]);
});

it('uses hydrated groups as they are once the snapshot has the same membership', () => {
  const hydrated = [{ ...group, memberIds: ['a', 'moved'] }];
  const snapshot = {
    workspaces: [
      {
        localId: 'ws-one',
        itemGroups: [{ ...group, memberIds: ['a', 'moved'] }],
      },
    ],
  } as unknown as SessionViewModel;
  expect(
    overlaySidebarItemGroups(snapshot, { 'workspace:ws-one': hydrated })
      .workspaces?.[0]?.itemGroups,
  ).toBe(hydrated);
});

it('keeps an empty group anchored while its collapse is optimistic', async () => {
  const empty: SidebarItemGroup = {
    ...group,
    keepWhenEmpty: true,
    emptyAnchorId: 'x',
    memberIds: [],
  };
  list.mockResolvedValueOnce([empty]);
  await store.getState().hydrate(scope);
  let finishUpdate: () => void = (): void => undefined;
  update.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finishUpdate = resolve;
    }),
  );
  const mutation = store
    .getState()
    .update({ scope, groupId: group.id, collapsed: true });
  await Promise.resolve();
  await Promise.resolve();
  // Losing the anchor here moved the group to the end until the next read.
  expect(store.getState().byScope['workspace:ws-one']).toEqual([
    { ...empty, collapsed: true },
  ]);
  list.mockResolvedValueOnce([{ ...empty, collapsed: true }]);
  finishUpdate();
  await mutation;
});

it.each([
  [
    'an empty group gains its first member',
    [],
    'new',
    group.id,
    true,
    false,
    ['new'],
  ],
  ['a group loses its last member', ['a'], 'a', null, false, true, []],
  [
    'a nonempty group keeps its manual toggle',
    ['a', 'b'],
    'a',
    null,
    true,
    true,
    ['b'],
  ],
  [
    'an empty group keeps its manual toggle',
    [],
    'unrelated',
    null,
    false,
    false,
    [],
  ],
] as const)(
  'optimistic move disclosure: %s',
  async (_label, members, itemId, destination, collapsed, expected, after) => {
    const kept: SidebarItemGroup = {
      ...group,
      keepWhenEmpty: true,
      collapsed,
      memberIds: [...members],
    };
    list.mockResolvedValueOnce([kept]);
    await store.getState().hydrate(scope);
    let finishMove: () => void = (): void => undefined;
    moveItem.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishMove = resolve;
      }),
    );
    const moving = store.getState().moveItem({
      scope,
      itemId,
      groupId: destination,
    });
    await Promise.resolve();
    await Promise.resolve();
    list.mockResolvedValueOnce([
      { ...kept, memberIds: [...after], collapsed: expected },
    ]);
    try {
      expect(store.getState().byScope['workspace:ws-one']?.[0]).toMatchObject({
        memberIds: [...after],
        collapsed: expected,
      });
    } finally {
      finishMove();
      await moving;
    }
  },
);

it('optimistic creation collapses a retained source only after its last member leaves', async () => {
  const kept: SidebarItemGroup = {
    ...group,
    keepWhenEmpty: true,
    collapsed: false,
  };
  list.mockResolvedValueOnce([kept]);
  await store.getState().hydrate(scope);
  let finishCreate: (created: SidebarItemGroup) => void = (): void => undefined;
  createGroup.mockReturnValueOnce(
    new Promise<SidebarItemGroup>((resolve) => {
      finishCreate = resolve;
    }),
  );
  const creating = store.getState().create({ scope, itemId: 'a' });
  await Promise.resolve();
  await Promise.resolve();
  const created = { ...group, id: 'grp-created' };
  list.mockResolvedValueOnce([
    { ...kept, memberIds: [], collapsed: true },
    created,
  ]);
  try {
    expect(store.getState().byScope['workspace:ws-one']?.[0]).toMatchObject({
      id: kept.id,
      memberIds: [],
      collapsed: true,
    });
  } finally {
    finishCreate(created);
    await creating;
  }
});

it.each([false, true])(
  'creation ACK opens a retained empty destination (hydrated: %s)',
  async (hydrated) => {
    const kept: SidebarItemGroup = {
      ...group,
      keepWhenEmpty: true,
      collapsed: true,
      memberIds: [],
    };
    list.mockResolvedValue([kept]);
    if (hydrated) await store.getState().hydrate(scope);
    store.getState().confirmCreatedItem(scope, kept.id, 'created');
    if (!hydrated) await store.getState().hydrate(scope);
    expect(store.getState().byScope['workspace:ws-one']?.[0]).toMatchObject({
      memberIds: ['created'],
      collapsed: false,
    });
  },
);

it('a rejected final-member move restores the retained group disclosure', async () => {
  const kept: SidebarItemGroup = { ...group, keepWhenEmpty: true };
  list.mockResolvedValue([kept]);
  await store.getState().hydrate(scope);
  moveItem.mockRejectedValueOnce(new Error('move refused'));
  await expect(
    store.getState().moveItem({ scope, itemId: 'a', groupId: null }),
  ).rejects.toThrow('move refused');
  expect(store.getState().byScope['workspace:ws-one']?.[0]).toMatchObject({
    memberIds: ['a'],
    collapsed: false,
  });
});

it('projects a second Cowork drop before the first save and read finish', async () => {
  mockProjects = [{ id: scope.workspaceLocalId, type: 'cowork' }];
  let releaseSave: (() => void) | undefined;
  const saveBarrier = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  moveItem.mockImplementationOnce(() => saveBarrier);
  const readBarrier = new Promise<never>(() => undefined);
  window.api.workEntries.list = jest.fn(() => readBarrier);
  await store.getState().hydrate(scope);
  const one = store
    .getState()
    .moveItem({ scope, itemId: 'c', groupId: null, before: 'a' });
  const two = store
    .getState()
    .moveItem({ scope, itemId: 'b', groupId: null, before: 'c' });
  expect(store.getState().orderByScope['workspace:ws-one']).toEqual([
    'b',
    'c',
    'a',
  ]);
  expect(moveItem).toHaveBeenCalledTimes(1);
  releaseSave?.();
  await one;
  await two;
  expect(moveItem).toHaveBeenCalledTimes(2);
  expect(mockLoadProjects).not.toHaveBeenCalled();
});

it.each([true, false])(
  'does not discover all projects for a loaded Cowork list (active=%s)',
  async (active) => {
    mockDetachedCowork = active;
    if (!active) mockSidebarEntries = { 'ws-one': [{ id: 'a' }, { id: 'b' }] };
    await store.getState().hydrate(scope);
    await store
      .getState()
      .moveItem({ scope, itemId: 'b', groupId: null, before: 'a' });
    expect(
      store.getState().orderByScope['workspace:ws-one']?.slice(0, 2),
    ).toEqual(['b', 'a']);
    expect(mockLoadProjects).not.toHaveBeenCalled();
  },
);

it('does not apply a hydration read started before the first Cowork intent', async () => {
  mockProjects = [{ id: scope.workspaceLocalId, type: 'cowork' }];
  let releaseGroups: ((groups: SidebarItemGroup[]) => void) | undefined;
  const initialGroups = new Promise<SidebarItemGroup[]>((resolve) => {
    releaseGroups = resolve;
  });
  list.mockImplementationOnce(() => initialGroups).mockResolvedValue([]);
  let releaseSave: (() => void) | undefined;
  moveItem.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        releaseSave = resolve;
      }),
  );
  const hydrating = store.getState().hydrate(scope);
  const moving = store
    .getState()
    .moveItem({ scope, itemId: 'a', groupId: null });
  releaseGroups?.([group]);
  await hydrating;
  try {
    expect(store.getState().byScope['workspace:ws-one']).toEqual([]);
  } finally {
    releaseSave?.();
    await moving;
  }
});
