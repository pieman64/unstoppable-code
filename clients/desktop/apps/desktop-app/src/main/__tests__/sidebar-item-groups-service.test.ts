import { IdentifierValidationError } from '../lib/validation';
import { dispatchSidebarItemGroupAction } from '../canopy-tools/sidebar-item-group-actions';
import * as WorkspacePersistence from '../lib/workspace-persistence';
import { serializeWorkspaceMutation } from '../lib/chat-project-operation-queue';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type * as AtomicFile from '../lib/atomic-file';
import type * as PreferencesStore from '../lib/preferences-store';
import type { WorktreeData } from '@canopy/desktop-shared/types';
import type { SidebarItemGroup } from '@canopy/protocol/sidebar';

jest.mock('../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../lib/read-only-scope', () => ({ assertWritableScope: jest.fn() }));
jest.mock('../lib/atomic-file', () => {
  const actual = jest.requireActual<typeof AtomicFile>('../lib/atomic-file');
  return {
    ...actual,
    writeFileAtomically: jest.fn(actual.writeFileAtomically),
    renameWithRetry: jest.fn(actual.renameWithRetry),
  };
});
import { writeFileAtomically, renameWithRetry } from '../lib/atomic-file';
import { readPreferencesFile } from '../lib/preferences-store';
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({ groupChildBranchesWithBase: true }),
  ),
}));
import { assertWritableScope } from '../lib/read-only-scope';
import { notifyPortalStructureChanged } from '../portal/portal-event-bus';
import { schedulePortalStructuralSync } from '../portal/portal-structural-sync';
import {
  getSidebarItemGroupsFilePath,
  getWorkspaceConfigPath,
  getWorkspaceWorktreesFilePath,
  getWorkspaceWorkEntriesFilePath,
} from '../lib/paths';
import {
  updateWorkspaceWorktrees,
  readWorkspaceWorktrees,
  removeWorkspaceWorktrees,
  restoreWorkspaceWorktrees,
} from '../lib/workspace-persistence';
import {
  sidebarItemGroupsService as service,
  initializeSidebarItemGroups,
  projectSidebarItemGroups,
  SidebarItemGroupRefusalError,
} from '../services/sidebar-item-groups-service';
import {
  readSidebarItemGroupsEnvelope,
  onSidebarItemGroupsChanged,
} from '../lib/sidebar-item-groups';
import {
  createWorkEntry,
  removeWorkEntryRow,
  updateWorkEntry,
  readWorkEntriesFile,
  clearWorkEntrySummariesForWorkspace,
  activateWorkEntryWorkspace,
  updateWorkEntryRegistry,
  onWorkEntryListChanged,
} from '../lib/cowork-work-entries';

let root = '';
const previousDataDir = process.env.CANOPY_DATA_DIR;
const scope = { workspaceLocalId: 'group-code' };
const row = (id: string): WorktreeData => ({
  id,
  branchName: `feature/${id}`,
  createdAt: '2026-10-04T00:00:00Z',
});
const ids = async (): Promise<string[]> =>
  (await readWorkspaceWorktrees(scope.workspaceLocalId)).map((item) => item.id);
const groups = async (): Promise<SidebarItemGroup[]> => service.list(scope);
const assignToNamedGroup = async (input: unknown): Promise<SidebarItemGroup> =>
  (await service.assignItemToNamedGroup(input)).group;
beforeAll(() => initializeSidebarItemGroups());
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sidebar-groups-service-'));
  process.env.CANOPY_DATA_DIR = root;
  jest.mocked(assertWritableScope).mockReset();
  jest
    .mocked(readPreferencesFile)
    .mockReset()
    .mockImplementation(() =>
      Promise.resolve(
        jest.requireActual<typeof PreferencesStore>('../lib/preferences-store')
          .DEFAULT_PREFERENCES,
      ),
    );
  jest
    .mocked(renameWithRetry)
    .mockReset()
    .mockImplementation(
      jest.requireActual<typeof AtomicFile>('../lib/atomic-file')
        .renameWithRetry,
    );
  jest
    .mocked(writeFileAtomically)
    .mockReset()
    .mockImplementation(
      jest.requireActual<typeof AtomicFile>('../lib/atomic-file')
        .writeFileAtomically,
    );
  jest.mocked(notifyPortalStructureChanged).mockClear();
  const config = getWorkspaceConfigPath(scope.workspaceLocalId);
  await mkdir(dirname(config), { recursive: true });
  await writeFile(
    config,
    JSON.stringify({ version: 1, type: 'single-repo', repoPath: root }),
  );
  await updateWorkspaceWorktrees(scope.workspaceLocalId, () =>
    ['a', 'b', 'c', 'd'].map(row),
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
});

it('moves complete membership blocks and keeps order durable across reads', async () => {
  const first = await service.create({ scope, itemId: 'a', name: 'First' });
  await service.moveItem({ scope, itemId: 'c', groupId: first.id });
  expect(await ids()).toEqual(['a', 'c', 'b', 'd']);
  const second = await service.create({ scope, itemId: 'd', name: 'Second' });
  await service.moveGroup({ scope, groupId: second.id, before: first.id });
  expect(await ids()).toEqual(['d', 'a', 'c', 'b']);
  expect(
    (await service.describe(scope)).map(({ id, order }) => ({ id, order })),
  ).toEqual([
    { id: second.id, order: 0 },
    { id: first.id, order: 1 },
  ]);
  expect(
    (await groups()).find((group) => group.id === first.id)?.memberIds,
  ).toEqual(['a', 'c']);
  await service.ungroup({ scope, groupId: first.id });
  expect(await ids()).toEqual(['d', 'a', 'c', 'b']);
});

it('keeps an opted-out group in its slot when emptied and lets rows rejoin it there', async () => {
  const kept = await service.create({ scope, itemId: 'b', name: 'Kept' });
  await service.update({ scope, groupId: kept.id, keepWhenEmpty: true });
  await service.moveItem({ scope, itemId: 'b', groupId: null });
  // The group stays above `c`, the row that followed it.
  expect(await groups()).toEqual([
    {
      ...kept,
      keepWhenEmpty: true,
      emptyAnchorId: 'c',
      memberIds: [],
      collapsed: true,
    },
  ]);
  // Lifecycle reconciliation must not prune it either.
  await updateWorkspaceWorktrees(scope.workspaceLocalId, (rows) =>
    rows.filter((item) => item.id !== 'd'),
  );
  await service.moveItem({ scope, itemId: 'a', groupId: kept.id });
  expect(await ids()).toEqual(['b', 'a', 'c']);
  expect((await groups())[0]).toMatchObject({
    memberIds: ['a'],
    emptyAnchorId: 'c',
    collapsed: false,
  });
  // The anchor row itself joins in place.
  await service.moveItem({ scope, itemId: 'a', groupId: null });
  await service.moveItem({ scope, itemId: 'c', groupId: kept.id });
  expect(await ids()).toEqual(['b', 'a', 'c']);
  await service.moveItem({ scope, itemId: 'c', groupId: null });
  await service.update({ scope, groupId: kept.id, keepWhenEmpty: false });
  expect(await groups()).toEqual([]);
});

it.each(['menu', 'drop', 'automation', 'creation'] as const)(
  'expands an empty retained group through %s and preserves manual collapse while populated',
  async (source) => {
    const kept = await service.create({ scope, itemId: 'b', name: 'Kept' });
    await service.update({ scope, groupId: kept.id, keepWhenEmpty: true });
    await service.moveItem({ scope, itemId: 'b', groupId: null });
    await service.update({ scope, groupId: kept.id, collapsed: true });
    if (source === 'automation') {
      const assigned = await assignToNamedGroup({
        scope,
        itemId: 'a',
        name: 'Kept',
      });
      expect(assigned.collapsed).toBe(false);
    } else if (source === 'creation') {
      await updateWorkspaceWorktrees(
        scope.workspaceLocalId,
        (rows) => [row('new'), ...rows],
        { sidebarItemGroupId: kept.id, newItemId: 'new' },
      );
    } else {
      await service.moveItem({
        scope,
        itemId: 'a',
        groupId: kept.id,
        ...(source === 'drop' ? { before: 'c' } : {}),
      });
    }
    expect((await groups())[0]?.collapsed).toBe(false);
    await service.update({ scope, groupId: kept.id, collapsed: true });
    await service.moveItem({ scope, itemId: 'd', groupId: kept.id });
    expect((await groups())[0]?.collapsed).toBe(true);
    await service.moveItem({ scope, itemId: 'd', groupId: kept.id });
    expect((await groups())[0]?.collapsed).toBe(true);
  },
);

it.each(['removed', 'pinned', 'hidden'] as const)(
  'collapses a retained group when its last member is %s',
  async (change) => {
    const kept = await service.create({ scope, itemId: 'b', name: 'Kept' });
    await service.update({ scope, groupId: kept.id, keepWhenEmpty: true });
    await updateWorkspaceWorktrees(scope.workspaceLocalId, (rows) =>
      change === 'removed'
        ? rows.filter((item) => item.id !== 'b')
        : rows.map((item) =>
            item.id === 'b' ? { ...item, [change]: true } : item,
          ),
    );
    // Inspect the owner write before a read can reconcile it.
    const envelope = await readSidebarItemGroupsEnvelope(
      scope.workspaceLocalId,
    );
    expect(envelope).toMatchObject({
      groups: [
        expect.objectContaining({
          id: kept.id,
          memberIds: [],
          collapsed: true,
        }),
      ],
    });
  },
);

it.each(['removed', 'pinned', 'hidden'] as const)(
  'keeps an empty group above the next eligible row when its anchor is %s',
  async (change) => {
    const kept = await service.create({ scope, itemId: 'b', name: 'Kept' });
    await service.update({ scope, groupId: kept.id, keepWhenEmpty: true });
    await service.moveItem({ scope, itemId: 'b', groupId: null });
    await updateWorkspaceWorktrees(scope.workspaceLocalId, (rows) =>
      change === 'removed'
        ? rows.filter((item) => item.id !== 'c')
        : rows.map((item) =>
            item.id === 'c' ? { ...item, [change]: true } : item,
          ),
    );
    expect((await groups())[0]?.emptyAnchorId).toBe('d');
    await service.moveItem({ scope, itemId: 'a', groupId: kept.id });
    expect(await ids()).toEqual(
      change === 'removed' ? ['b', 'a', 'd'] : ['b', 'c', 'a', 'd'],
    );
  },
);

it.each([true, false])(
  'creates the first member at an empty group slot (anchored: %s)',
  async (anchored) => {
    const kept = await service.create({
      scope,
      itemId: anchored ? 'b' : 'd',
      name: 'Kept',
    });
    await service.update({ scope, groupId: kept.id, keepWhenEmpty: true });
    await service.moveItem({
      scope,
      itemId: anchored ? 'b' : 'd',
      groupId: null,
    });
    await updateWorkspaceWorktrees(
      scope.workspaceLocalId,
      (rows) => [row('new'), ...rows],
      { sidebarItemGroupId: kept.id, newItemId: 'new' },
    );
    expect(await ids()).toEqual(
      anchored ? ['a', 'b', 'new', 'c', 'd'] : ['a', 'b', 'c', 'd', 'new'],
    );
  },
);

it('retains the Work Entry group slot through anchor removal and first-member creation', async () => {
  const advisor = { appAdvisor: true } as const;
  await updateWorkEntryRegistry('app-advisor', () =>
    Promise.resolve(
      ['a', 'b', 'c', 'd'].map((id) => ({
        id,
        title: id,
        createdAt: '2026-10-04T00:00:00Z',
      })),
    ),
  );
  const kept = await service.create({
    scope: advisor,
    itemId: 'b',
    name: 'Kept',
  });
  await service.update({
    scope: advisor,
    groupId: kept.id,
    keepWhenEmpty: true,
  });
  await service.moveItem({ scope: advisor, itemId: 'b', groupId: null });
  await removeWorkEntryRow('app-advisor', 'c');
  expect((await service.list(advisor))[0]?.emptyAnchorId).toBe('d');
  await updateWorkEntryRegistry(
    'app-advisor',
    (entries) =>
      Promise.resolve([
        { id: 'new', title: 'New', createdAt: '2026-10-04T00:00:00Z' },
        ...entries,
      ]),
    { sidebarItemGroupId: kept.id, newItemId: 'new' },
  );
  expect(
    (await readWorkEntriesFile('app-advisor')).entries.map((entry) => entry.id),
  ).toEqual(['a', 'b', 'new', 'd']);
});

it.each(['move', 'assign', 'group', 'registry'])(
  'keeps an empty group in its slot when its anchor moves through %s',
  async (path) => {
    const kept = await service.create({ scope, itemId: 'b', name: 'Kept' });
    await service.update({ scope, groupId: kept.id, keepWhenEmpty: true });
    await service.moveItem({ scope, itemId: 'b', groupId: null });
    if (path === 'move')
      await service.moveItem({
        scope,
        itemId: 'c',
        groupId: null,
        before: 'a',
      });
    else if (path === 'registry')
      await updateWorkspaceWorktrees(scope.workspaceLocalId, (rows) =>
        ['c', 'a', 'b', 'd'].map(
          (id) => rows.find((item) => item.id === id) ?? row(id),
        ),
      );
    else {
      const target = await service.create({
        scope,
        itemId: path === 'group' ? 'c' : 'a',
        name: 'Target',
      });
      if (path === 'group')
        await service.moveGroup({ scope, groupId: target.id, before: 'a' });
      else await assignToNamedGroup({ scope, itemId: 'c', name: 'Target' });
    }
    expect(
      (await groups()).find((group) => group.id === kept.id)?.emptyAnchorId,
    ).toBe('d');
  },
);

it.each(['before-anchor', 'after-previous'])(
  'keeps a row drop on the indicated side of an empty group (%s)',
  async (edge) => {
    const kept = await service.create({ scope, itemId: 'b', name: 'Kept' });
    await service.update({ scope, groupId: kept.id, keepWhenEmpty: true });
    await service.moveItem({ scope, itemId: 'b', groupId: null });
    await service.moveItem({
      scope,
      itemId: 'd',
      groupId: null,
      ...(edge === 'before-anchor' ? { before: 'c' } : { after: 'b' }),
    });
    expect((await groups())[0]?.emptyAnchorId).toBe(
      edge === 'before-anchor' ? 'd' : 'c',
    );
  },
);

it.each(['move', 'create'])(
  'fills an empty group above its anchor block through %s',
  async (path) => {
    const neighbor = await service.create({
      scope,
      itemId: 'a',
      name: 'Neighbor',
    });
    await service.moveItem({ scope, itemId: 'c', groupId: neighbor.id });
    const kept = await service.create({ scope, itemId: 'b', name: 'Kept' });
    await service.update({ scope, groupId: kept.id, keepWhenEmpty: true });
    await service.moveItem({ scope, itemId: 'b', groupId: null });
    const file = getSidebarItemGroupsFilePath(scope.workspaceLocalId);
    const saved = (await groups()).map((group) =>
      group.id === kept.id ? { ...group, emptyAnchorId: 'c' } : group,
    );
    await writeFile(file, JSON.stringify({ version: 1, groups: saved }));
    if (path === 'move')
      await service.moveItem({ scope, itemId: 'd', groupId: kept.id });
    else
      await updateWorkspaceWorktrees(
        scope.workspaceLocalId,
        (rows) => [row('new'), ...rows],
        { sidebarItemGroupId: kept.id, newItemId: 'new' },
      );
    expect(await ids()).toEqual(
      path === 'move' ? ['d', 'a', 'c', 'b'] : ['new', 'a', 'c', 'b', 'd'],
    );
  },
);

it('orders empty headers sharing an anchor when one is explicitly moved', async () => {
  const first = await service.create({ scope, itemId: 'a', name: 'First' });
  const second = await service.create({ scope, itemId: 'b', name: 'Second' });
  for (const [group, itemId] of [
    [first, 'a'],
    [second, 'b'],
  ] as const) {
    await service.update({ scope, groupId: group.id, keepWhenEmpty: true });
    await service.moveItem({ scope, itemId, groupId: null });
  }
  await service.moveGroup({ scope, groupId: second.id, before: first.id });
  expect((await groups()).map((group) => group.id)).toEqual([
    second.id,
    first.id,
  ]);
  await service.moveGroup({ scope, groupId: second.id, after: first.id });
  expect((await groups()).map((group) => group.id)).toEqual([
    first.id,
    second.id,
  ]);
});

it('anchors an emptied group past pinned rows and moves an empty group by its anchor', async () => {
  // A pinned row shows at the top, so it can never hold an unpinned group's slot.
  await updateWorkspaceWorktrees(scope.workspaceLocalId, (rows) =>
    rows.map((item) => (item.id === 'c' ? { ...item, pinned: true } : item)),
  );
  const kept = await service.create({ scope, itemId: 'b', name: 'Kept' });
  await service.update({ scope, groupId: kept.id, keepWhenEmpty: true });
  await service.moveItem({ scope, itemId: 'b', groupId: null, after: 'd' });
  expect((await groups())[0]).toMatchObject({
    memberIds: [],
    emptyAnchorId: 'd',
  });
  await service.moveGroup({ scope, groupId: kept.id, before: 'a' });
  expect((await groups())[0]?.emptyAnchorId).toBe('a');
  await service.moveGroup({ scope, groupId: kept.id, after: 'a' });
  expect((await groups())[0]?.emptyAnchorId).toBe('d');
  await service.moveGroup({ scope, groupId: kept.id, after: 'b' });
  expect((await groups())[0]).not.toHaveProperty('emptyAnchorId');
  // Moving an empty group never reorders rows.
  expect(await ids()).toEqual(['a', 'c', 'd', 'b']);
});

it('lists groups in left-nav order without description fields', async () => {
  const first = await service.create({ scope, itemId: 'a', name: 'First' });
  const second = await service.create({ scope, itemId: 'd', name: 'Second' });
  await service.moveGroup({ scope, groupId: second.id, before: first.id });
  const listed = await groups();
  expect(listed.map((group) => group.id)).toEqual([second.id, first.id]);
  expect(listed[0]).not.toHaveProperty('order');
});

it('lists and describes an empty header before its neighboring populated block', async () => {
  const populated = await service.create({
    scope,
    itemId: 'a',
    name: 'Populated',
  });
  await service.moveItem({ scope, itemId: 'c', groupId: populated.id });
  const empty = await service.create({ scope, itemId: 'b', name: 'Empty' });
  await service.update({ scope, groupId: empty.id, keepWhenEmpty: true });
  await service.moveItem({ scope, itemId: 'b', groupId: null });
  await service.moveGroup({ scope, groupId: empty.id, before: populated.id });
  expect((await groups()).map((group) => group.id)).toEqual([
    empty.id,
    populated.id,
  ]);
  expect(
    (await service.describe(scope)).map(({ id, order }) => ({ id, order })),
  ).toEqual([
    { id: empty.id, order: 0 },
    { id: populated.id, order: 1 },
  ]);
});

it('assigns a duplicate name to the empty group shown before a populated group', async () => {
  const populated = await service.create({
    scope,
    itemId: 'a',
    name: 'Release',
  });
  const empty = await service.create({ scope, itemId: 'b', name: 'Release' });
  await service.update({ scope, groupId: empty.id, keepWhenEmpty: true });
  await service.moveItem({ scope, itemId: 'b', groupId: null });
  await service.moveGroup({ scope, groupId: empty.id, before: populated.id });
  expect(
    (await assignToNamedGroup({ scope, itemId: 'd', name: 'Release' })).id,
  ).toBe(empty.id);
});

it.each([true, false])(
  'preserves sibling empty slots when creating the middle group first member (anchored: %s)',
  async (anchored) => {
    const entries = [];
    for (const [itemId, name] of [
      ['a', 'First'],
      ['b', 'Second'],
      ['c', 'Third'],
    ] as const) {
      const group = await service.create({ scope, itemId, name });
      await service.update({ scope, groupId: group.id, keepWhenEmpty: true });
      await service.moveItem({ scope, itemId, groupId: null });
      await service.moveGroup({
        scope,
        groupId: group.id,
        ...(anchored ? { before: 'd' } : { after: 'd' }),
      });
      entries.push(group);
    }
    const [first, second, third] = entries;
    if (!first || !second || !third)
      throw new Error('Expected three group fixtures');
    await service.moveGroup({ scope, groupId: first.id, before: second.id });
    await service.moveGroup({ scope, groupId: third.id, after: second.id });
    await updateWorkspaceWorktrees(
      scope.workspaceLocalId,
      (rows) => [row('new'), ...rows],
      { sidebarItemGroupId: second.id, newItemId: 'new' },
    );
    const result = await groups();
    expect(result.find((group) => group.id === first.id)?.emptyAnchorId).toBe(
      'new',
    );
    expect(result.find((group) => group.id === third.id)?.emptyAnchorId).toBe(
      anchored ? 'd' : undefined,
    );
    expect(result.map((group) => group.id)).toEqual([
      first.id,
      second.id,
      third.id,
    ]);
  },
);

it('preserves sibling slots when raw anchors resolve to different rows of one block', async () => {
  const neighbor = await service.create({
    scope,
    itemId: 'a',
    name: 'Neighbor',
  });
  await service.moveItem({ scope, itemId: 'c', groupId: neighbor.id });
  const first = await service.create({ scope, itemId: 'b', name: 'First' });
  const second = await service.create({ scope, itemId: 'd', name: 'Second' });
  for (const [group, itemId] of [
    [first, 'b'],
    [second, 'd'],
  ] as const) {
    await service.update({ scope, groupId: group.id, keepWhenEmpty: true });
    await service.moveItem({ scope, itemId, groupId: null });
  }
  const saved = await groups();
  const metadata = [first, second, neighbor].map((group) => ({
    ...saved.find((candidate) => candidate.id === group.id),
    ...(group.id === first.id
      ? { emptyAnchorId: 'c' }
      : group.id === second.id
        ? { emptyAnchorId: 'a' }
        : {}),
  }));
  await writeFile(
    getSidebarItemGroupsFilePath(scope.workspaceLocalId),
    JSON.stringify({ version: 1, groups: metadata }),
  );
  await updateWorkspaceWorktrees(
    scope.workspaceLocalId,
    (rows) => [row('new'), ...rows],
    { sidebarItemGroupId: second.id, newItemId: 'new' },
  );
  const result = await groups();
  expect(result.map((group) => group.id)).toEqual([
    first.id,
    second.id,
    neighbor.id,
  ]);
  expect(result.find((group) => group.id === first.id)?.emptyAnchorId).toBe(
    'new',
  );
});

it.each(['move', 'archive', 'assign', 'create'])(
  'keeps a newly empty group above its existing empty neighbor through %s',
  async (path) => {
    await updateWorkspaceWorktrees(scope.workspaceLocalId, () =>
      ['a', 'b', 'x', 'c'].map(row),
    );
    const below = await service.create({ scope, itemId: 'x', name: 'Below' });
    await service.update({ scope, groupId: below.id, keepWhenEmpty: true });
    await service.moveItem({ scope, itemId: 'x', groupId: null, after: 'c' });
    const above = await service.create({ scope, itemId: 'b', name: 'Above' });
    await service.update({ scope, groupId: above.id, keepWhenEmpty: true });
    expect((await groups()).map((group) => group.id)).toEqual([
      above.id,
      below.id,
    ]);
    if (path === 'move')
      await service.moveItem({
        scope,
        itemId: 'b',
        groupId: null,
        before: 'a',
      });
    else if (path === 'archive')
      await updateWorkspaceWorktrees(scope.workspaceLocalId, (rows) =>
        rows.filter((item) => item.id !== 'b'),
      );
    else if (path === 'assign')
      await assignToNamedGroup({ scope, itemId: 'b', name: 'New' });
    else await service.create({ scope, itemId: 'b', name: 'New' });
    expect(
      (await groups())
        .filter((group) => group.id === above.id || group.id === below.id)
        .map((group) => group.id),
    ).toEqual([above.id, below.id]);
  },
);

it('rebases a retained slot from its displayed block boundary during registry reorder', async () => {
  const neighbor = await service.create({
    scope,
    itemId: 'a',
    name: 'Neighbor',
  });
  await service.moveItem({ scope, itemId: 'c', groupId: neighbor.id });
  const empty = await service.create({ scope, itemId: 'b', name: 'Empty' });
  await service.update({ scope, groupId: empty.id, keepWhenEmpty: true });
  await service.moveItem({ scope, itemId: 'b', groupId: null });
  const saved = (await groups()).map((group) =>
    group.id === empty.id ? { ...group, emptyAnchorId: 'c' } : group,
  );
  await writeFile(
    getSidebarItemGroupsFilePath(scope.workspaceLocalId),
    JSON.stringify({ version: 1, groups: saved }),
  );
  await updateWorkspaceWorktrees(scope.workspaceLocalId, (rows) =>
    ['c', 'a', 'b', 'd'].map(
      (id) => rows.find((item) => item.id === id) ?? row(id),
    ),
  );
  const result = await groups();
  expect(result.map((group) => group.id)).toEqual([empty.id, neighbor.id]);
  expect(result.find((group) => group.id === empty.id)?.emptyAnchorId).toBe(
    'c',
  );
});

it('applies the shared label policy on create and update and persists only true', async () => {
  const blank = await service.create({
    scope,
    itemId: 'a',
    name: '  ',
    color: 'neutral',
  });
  expect(blank).toMatchObject({
    name: 'Group 1',
    color: 'neutral',
    labelHidden: true,
  });

  const custom = await service.create({
    scope,
    itemId: 'b',
    name: ' Docs ',
    color: 'neutral',
  });
  expect(custom.name).toBe('Docs');
  expect(custom.labelHidden).toBeUndefined();
  await expect(
    service.create({
      scope,
      itemId: 'd',
      name: 'Invalid visibility',
      labelHidden: 'true',
    }),
  ).rejects.toThrow();
  await expect(
    service.update({
      scope,
      groupId: custom.id,
      labelHidden: 'false',
    }),
  ).rejects.toThrow();

  const hiddenCustom = await service.create({
    scope,
    itemId: 'c',
    name: 'Notes',
    labelHidden: true,
  });
  expect(hiddenCustom.labelHidden).toBe(true);

  const generatedName = await service.create({
    scope,
    itemId: 'd',
    name: 'group 4',
    color: 'neutral',
    labelHidden: false,
  });
  expect(generatedName).toMatchObject({ name: 'group 4', labelHidden: true });

  await service.update({ scope, groupId: custom.id, name: '' });
  expect((await groups()).find(({ id }) => id === custom.id)).toMatchObject({
    name: 'Group 2',
    labelHidden: true,
  });
  await service.update({ scope, groupId: custom.id, name: 'Docs' });
  expect((await groups()).find(({ id }) => id === custom.id)).toMatchObject({
    name: 'Docs',
  });
  expect(
    (await groups()).find(({ id }) => id === custom.id)?.labelHidden,
  ).toBeUndefined();

  await service.update({ scope, groupId: custom.id, labelHidden: true });
  expect((await groups()).find(({ id }) => id === custom.id)?.labelHidden).toBe(
    true,
  );
  await service.update({ scope, groupId: custom.id, labelHidden: false });
  expect((await groups()).find(({ id }) => id === custom.id)?.labelHidden).toBe(
    undefined,
  );

  await service.update({ scope, groupId: custom.id, name: '  ' });
  await service.update({
    scope,
    groupId: custom.id,
    color: 'categorical-2',
  });
  // A default name does not depend on the group's color.
  expect((await groups()).find(({ id }) => id === custom.id)).toMatchObject({
    name: 'Group 2',
    color: 'categorical-2',
    labelHidden: true,
  });
  await service.update({ scope, groupId: custom.id, collapsed: true });
  expect((await groups()).find(({ id }) => id === custom.id)).toMatchObject({
    name: 'Group 2',
    color: 'categorical-2',
    collapsed: true,
    labelHidden: true,
  });

  const persisted = await readFile(
    getSidebarItemGroupsFilePath(scope.workspaceLocalId),
    'utf8',
  );
  expect(persisted).toContain('"labelHidden": true');
  expect(persisted).not.toContain('"labelHidden": false');
});

it('assigns a whole stack to a case-insensitive existing group at its block end', async () => {
  await updateWorkspaceWorktrees(scope.workspaceLocalId, () => [
    row('a'),
    { ...row('child'), branchGroupingParentWorktreeId: 'a' },
    row('b'),
    row('c'),
    row('d'),
  ]);
  const source = await service.create({ scope, itemId: 'a', name: 'Source' });
  const target = await service.create({ scope, itemId: 'b', name: 'Target' });
  await service.moveItem({ scope, itemId: 'd', groupId: target.id });

  const assigned = await assignToNamedGroup({
    scope,
    itemId: 'a',
    name: '  tArGeT  ',
  });

  expect(assigned).toMatchObject({ id: target.id, name: 'Target' });
  expect(await ids()).toEqual(['b', 'd', 'a', 'child', 'c']);
  expect(await groups()).toEqual([
    expect.objectContaining({
      id: target.id,
      memberIds: ['b', 'd', 'a'],
    }),
  ]);
  expect((await groups()).some(({ id }) => id === source.id)).toBe(false);
});

it('assigns a duplicate name to the same-named group the left nav shows first', async () => {
  const stored = await service.create({ scope, itemId: 'a', name: 'Release' });
  const shown = await service.create({ scope, itemId: 'd', name: 'Release' });
  await service.moveGroup({ scope, groupId: shown.id, before: stored.id });

  const assigned = await assignToNamedGroup({
    scope,
    itemId: 'b',
    name: 'Release',
  });

  expect(assigned.id).toBe(shown.id);
  expect(
    (await groups()).find((group) => group.id === shown.id)?.memberIds,
  ).toEqual(['d', 'b']);
});

it('creates a normalized new named group with a preferably-unused color', async () => {
  const random = jest.spyOn(Math, 'random').mockReturnValue(0);
  try {
    await service.create({
      scope,
      itemId: 'a',
      name: 'First',
      color: 'neutral',
    });
    await service.create({
      scope,
      itemId: 'b',
      name: 'Second',
      color: 'categorical-1',
    });
    await service.create({
      scope,
      itemId: 'c',
      name: 'Third',
      color: 'categorical-2',
    });

    const assigned = await assignToNamedGroup({
      scope,
      itemId: 'd',
      name: '  Group 8  ',
    });

    expect(assigned).toMatchObject({
      name: 'Group 8',
      color: 'categorical-3',
      labelHidden: true,
      memberIds: ['d'],
    });
    expect(await ids()).toEqual(['a', 'b', 'c', 'd']);
  } finally {
    random.mockRestore();
  }
});

it('rejects invalid item ids and blank names without creating a group', async () => {
  await expect(
    assignToNamedGroup({ scope, itemId: 'bad/id', name: 'Docs' }),
  ).rejects.toBeInstanceOf(IdentifierValidationError);
  await expect(
    assignToNamedGroup({ scope, itemId: 'missing', name: 'Docs' }),
  ).rejects.toThrow('cannot be grouped');
  await expect(
    assignToNamedGroup({ scope, itemId: 'a', name: '   ' }),
  ).rejects.toThrow('name');
  expect(await groups()).toEqual([]);
  expect(await ids()).toEqual(['a', 'b', 'c', 'd']);
});

it('rolls back a new named assignment when the sidecar write fails', async () => {
  const native = jest.requireActual<typeof AtomicFile>('../lib/atomic-file');
  jest.mocked(notifyPortalStructureChanged).mockClear();
  jest
    .mocked(writeFileAtomically)
    .mockImplementation((path, data, options) =>
      path === getSidebarItemGroupsFilePath(scope.workspaceLocalId)
        ? Promise.reject(new Error('membership unavailable'))
        : native.writeFileAtomically(path, data, options),
    );

  await expect(
    assignToNamedGroup({ scope, itemId: 'a', name: 'New group' }),
  ).rejects.toThrow('membership unavailable');

  expect(await groups()).toEqual([]);
  expect(await ids()).toEqual(['a', 'b', 'c', 'd']);
});

it.each(['code', 'cowork', 'advisor'] as const)(
  '%s membership moves keep the destination between its existing neighbors',
  async (kind) => {
    const workspaceId =
      kind === 'advisor' ? 'app-advisor' : scope.workspaceLocalId;
    const targetScope =
      kind === 'advisor' ? ({ appAdvisor: true } as const) : scope;
    if (kind !== 'code') {
      if (kind === 'cowork')
        await writeFile(
          getWorkspaceConfigPath(workspaceId),
          JSON.stringify({ version: 1, type: 'cowork' }),
        );
      await updateWorkEntryRegistry(workspaceId, () =>
        ['a', 'b', 'c', 'd'].map((id) => ({
          id,
          title: id,
          createdAt: '2026-10-07T00:00:00Z',
        })),
      );
    }
    const readOrder = async (): Promise<string[]> =>
      kind === 'code'
        ? ids()
        : (await readWorkEntriesFile(workspaceId)).entries.map(
            (entry) => entry.id,
          );
    const neighbor = await service.create({
      scope: targetScope,
      itemId: 'b',
      name: 'Neighbor',
    });
    const destination = await service.create({
      scope: targetScope,
      itemId: 'c',
      name: 'Destination',
    });
    await service.moveItem({
      scope: targetScope,
      itemId: 'a',
      groupId: destination.id,
    });
    expect(await readOrder()).toEqual(['b', 'c', 'a', 'd']);
    expect(
      (await service.describe(targetScope)).map((group) => group.id),
    ).toEqual([neighbor.id, destination.id]);
    await service.moveItem({
      scope: targetScope,
      itemId: 'd',
      groupId: destination.id,
      before: 'c',
    });
    expect(await readOrder()).toEqual(['b', 'd', 'c', 'a']);
    await service.moveItem({
      scope: targetScope,
      itemId: 'd',
      groupId: destination.id,
    });
    expect(await readOrder()).toEqual(['b', 'd', 'c', 'a']);
    expect(
      (await service.describe(targetScope)).map((group) => group.id),
    ).toEqual([neighbor.id, destination.id]);
  },
);

it.each(['before', 'after'] as const)(
  'an explicit %s member drop carries a branch stack without moving its group',
  async (edge) => {
    const preferences = jest.requireActual<typeof PreferencesStore>(
      '../lib/preferences-store',
    ).DEFAULT_PREFERENCES;
    jest
      .mocked(readPreferencesFile)
      .mockResolvedValue({ ...preferences, groupChildBranchesWithBase: true });
    await updateWorkspaceWorktrees(scope.workspaceLocalId, () => [
      row('a'),
      { ...row('child'), branchGroupingParentWorktreeId: 'a' },
      row('b'),
      row('c'),
      row('d'),
    ]);
    const neighbor = await service.create({ scope, itemId: 'b' });
    const destination = await service.create({ scope, itemId: 'c' });
    await service.moveItem({
      scope,
      itemId: 'a',
      groupId: destination.id,
      [edge]: 'c',
    });
    expect(await ids()).toEqual(
      edge === 'before'
        ? ['b', 'a', 'child', 'c', 'd']
        : ['b', 'c', 'a', 'child', 'd'],
    );
    expect((await service.describe(scope)).map((group) => group.id)).toEqual([
      neighbor.id,
      destination.id,
    ]);
  },
);

it('branching from a grouped worktree at the registry head keeps its parent group below other rows', async () => {
  const preferences = jest.requireActual<typeof PreferencesStore>(
    '../lib/preferences-store',
  ).DEFAULT_PREFERENCES;
  jest
    .mocked(readPreferencesFile)
    .mockResolvedValue({ ...preferences, groupChildBranchesWithBase: true });
  await service.create({ scope, itemId: 'a', name: 'Neighbor' });
  const destination = await service.create({
    scope,
    itemId: 'c',
    name: 'Destination',
  });

  await updateWorkspaceWorktrees(
    scope.workspaceLocalId,
    (rows) => [row('new'), ...rows],
    { sidebarItemGroupId: destination.id, newItemId: 'new' },
  );
  expect(await ids()).toEqual(['a', 'b', 'new', 'c', 'd']);
  const description = await service.describe(scope);

  await updateWorkspaceWorktrees(
    scope.workspaceLocalId,
    (rows) => [{ ...row('child'), trackedBaseBranch: 'feature/c' }, ...rows],
    { newItemId: 'child' },
  );
  expect(await ids()).toEqual(['a', 'b', 'new', 'c', 'child', 'd']);
  expect(await service.describe(scope)).toEqual(description);

  await updateWorkspaceWorktrees(
    scope.workspaceLocalId,
    (rows) => [
      { ...row('grandchild'), trackedBaseBranch: 'feature/child' },
      ...rows,
    ],
    { newItemId: 'grandchild' },
  );
  expect(await ids()).toEqual([
    'a',
    'b',
    'new',
    'c',
    'grandchild',
    'child',
    'd',
  ]);
  expect(await service.describe(scope)).toEqual(description);
});

it('creating a grouped worktree at the start of the registry keeps its group below other rows', async () => {
  const neighbor = await service.create({ scope, itemId: 'a' });
  const destination = await service.create({ scope, itemId: 'c' });
  await updateWorkspaceWorktrees(
    scope.workspaceLocalId,
    (rows) => [row('new'), ...rows],
    { sidebarItemGroupId: destination.id, newItemId: 'new' },
  );
  expect(await ids()).toEqual(['a', 'b', 'new', 'c', 'd']);
  expect((await service.describe(scope)).map((group) => group.id)).toEqual([
    neighbor.id,
    destination.id,
  ]);
});

it.each(['code', 'cowork'] as const)(
  'scoped %s actions persist inline creation, assignment, metadata and item-only ungrouping',
  async (kind) => {
    const projectId = kind === 'code' ? scope.workspaceLocalId : 'group-cowork';
    if (kind === 'cowork') {
      const config = getWorkspaceConfigPath(projectId);
      await mkdir(dirname(config), { recursive: true });
      await writeFile(
        config,
        JSON.stringify({
          version: 1,
          type: 'cowork',
          name: 'Tasks',
          cwd: root,
        }),
      );
      await updateWorkEntryRegistry(projectId, () => [
        { id: 'a', title: 'First', createdAt: '2026-10-05T00:00:00Z' },
        { id: 'b', title: 'Second', createdAt: '2026-10-05T00:00:00Z' },
      ]);
    }
    const target = { projectId, worktreeId: 'a' };
    const created = await dispatchSidebarItemGroupAction(
      {
        type: 'sidebar.item_groups.set_item',
        newGroup: { name: 'Tasks', color: 'categorical-3' },
      },
      target,
    );
    expect(created).toMatchObject({ ok: true });
    const group = (await service.list({ workspaceLocalId: projectId }))[0];
    if (!group) throw new Error('Expected a persisted group');
    expect(group).toMatchObject({
      name: 'Tasks',
      color: 'categorical-3',
      memberIds: ['a'],
    });
    expect(
      await dispatchSidebarItemGroupAction(
        { type: 'sidebar.item_groups.set_item', groupId: group.id },
        { projectId, worktreeId: 'b' },
      ),
    ).toMatchObject({ ok: true, result: { groupId: group.id, itemId: 'b' } });
    expect(
      await dispatchSidebarItemGroupAction(
        {
          type: 'sidebar.item_groups.update',
          groupId: group.id,
          name: 'Renamed',
          color: 'categorical-4',
        },
        target,
      ),
    ).toMatchObject({ ok: true });
    expect(
      await dispatchSidebarItemGroupAction(
        { type: 'sidebar.item_groups.list_items', groupId: group.id },
        target,
      ),
    ).toMatchObject({
      ok: true,
      result: {
        group: { name: 'Renamed', color: 'categorical-4' },
        items: [
          { id: 'a', groupId: group.id },
          { id: 'b', groupId: group.id },
        ],
      },
    });
    expect(
      await dispatchSidebarItemGroupAction(
        { type: 'sidebar.item_groups.set_item', groupId: null },
        target,
      ),
    ).toMatchObject({ ok: true, result: { itemId: 'a', groupId: null } });
    expect(
      (await service.list({ workspaceLocalId: projectId }))[0]?.memberIds,
    ).toEqual(['b']);
    expect(
      await dispatchSidebarItemGroupAction(
        { type: 'sidebar.item_groups.list_items', groupId: 'grp-unknown' },
        target,
      ),
    ).toMatchObject({ ok: false });
  },
);

it('reports committed scoped mutations as successful when describe fails', async () => {
  const describe = jest
    .spyOn(service, 'describe')
    .mockRejectedValue(new Error('Refresh failed'));
  try {
    const target = { projectId: scope.workspaceLocalId, worktreeId: 'a' };
    const created = await dispatchSidebarItemGroupAction(
      { type: 'sidebar.item_groups.set_item', newGroup: { name: 'Tasks' } },
      target,
    );
    expect(created).toMatchObject({ ok: true, result: { itemId: 'a' } });
    const group = (await groups())[0];
    expect(group?.name).toBe('Tasks');
    if (!group) throw new Error('Expected committed group');
    expect(created).toMatchObject({ result: { groupId: group.id } });
    expect(
      await dispatchSidebarItemGroupAction(
        { type: 'sidebar.item_groups.set_item', groupId: group.id },
        { projectId: scope.workspaceLocalId, worktreeId: 'b' },
      ),
    ).toMatchObject({ ok: true, result: { itemId: 'b', groupId: group.id } });
    expect(
      await dispatchSidebarItemGroupAction(
        {
          type: 'sidebar.item_groups.update',
          groupId: group.id,
          name: 'Renamed',
        },
        target,
      ),
    ).toMatchObject({ ok: true });
    expect((await groups())[0]).toMatchObject({
      name: 'Renamed',
      memberIds: ['a', 'b'],
    });
  } finally {
    describe.mockRestore();
  }
});

it('lists complete branch stacks with inherited group IDs without independent child membership', async () => {
  await updateWorkspaceWorktrees(scope.workspaceLocalId, () => [
    row('a'),
    { ...row('b'), branchGroupingParentWorktreeId: 'a' },
    row('c'),
  ]);
  const group = await service.create({ scope, itemId: 'a', name: 'Stack' });
  expect(await service.listItems({ scope, groupId: group.id })).toMatchObject({
    group: { memberIds: ['a'] },
    items: [
      { id: 'a', groupId: group.id },
      { id: 'b', groupId: group.id },
    ],
  });
});

it('leaves worktree order unchanged when group membership cannot be committed', async () => {
  const group = await service.create({ scope, itemId: 'a' });
  const native = jest.requireActual<typeof AtomicFile>('../lib/atomic-file');
  jest.mocked(notifyPortalStructureChanged).mockClear();
  jest.mocked(writeFileAtomically).mockImplementation((path, data, options) => {
    if (path === getSidebarItemGroupsFilePath(scope.workspaceLocalId))
      return Promise.reject(new Error('disk unavailable'));
    return native.writeFileAtomically(path, data, options);
  });
  await expect(
    service.moveItem({ scope, itemId: 'c', groupId: group.id }),
  ).rejects.toThrow('disk unavailable');
  expect(await ids()).toEqual(['a', 'b', 'c', 'd']);
  expect(notifyPortalStructureChanged).not.toHaveBeenCalled();
  expect(schedulePortalStructuralSync).toHaveBeenCalled();
  expect((await groups())[0]?.memberIds).toEqual(['a']);
});

// A22(a): membership stays desktop-only, and its sidecar-before-list order
// is the documented compatibility behavior.
it('commits membership before order, so a failed list write leaves membership advanced', async () => {
  const group = await service.create({ scope, itemId: 'a' });
  const sidecar = getSidebarItemGroupsFilePath(scope.workspaceLocalId);
  const list = getWorkspaceWorktreesFilePath(scope.workspaceLocalId);
  const before = await readFile(list, 'utf8');
  const native = jest.requireActual<typeof AtomicFile>('../lib/atomic-file');
  const writes: string[] = [];
  jest.mocked(writeFileAtomically).mockImplementation((path, data, options) => {
    writes.push(path);
    return path === list
      ? Promise.reject(new Error('registry unavailable'))
      : native.writeFileAtomically(path, data, options);
  });
  await expect(
    service.moveItem({ scope, itemId: 'c', groupId: group.id }),
  ).rejects.toThrow('registry unavailable');
  expect(writes).toEqual([sidecar, list]);
  expect(await readFile(list, 'utf8')).toBe(before);
  expect(await readSidebarItemGroupsEnvelope(scope.workspaceLocalId)).toEqual({
    version: 1,
    groups: [{ ...group, memberIds: ['a', 'c'] }],
  });
});

it('fresh root worktree creation retains its row when stale membership cleanup fails', async () => {
  await writeFile(
    getSidebarItemGroupsFilePath(scope.workspaceLocalId),
    JSON.stringify({
      version: 1,
      groups: [
        {
          id: 'grp-stale',
          name: 'Stale',
          color: 'blue',
          collapsed: false,
          memberIds: ['removed-row'],
        },
      ],
    }),
  );
  const native = jest.requireActual<typeof AtomicFile>('../lib/atomic-file');
  jest
    .mocked(writeFileAtomically)
    .mockImplementation((path, data, options) =>
      path === getSidebarItemGroupsFilePath(scope.workspaceLocalId)
        ? Promise.reject(new Error('membership unavailable'))
        : native.writeFileAtomically(path, data, options),
    );
  await expect(
    updateWorkspaceWorktrees(
      scope.workspaceLocalId,
      (rows) => [...rows, row('created')],
      { newItemId: 'created' },
    ),
  ).rejects.toThrow('membership unavailable');
  expect(await ids()).toContain('created');
});

it('invalidates worktree lifecycle changes when membership cleanup fails after commit', async () => {
  await service.create({ scope, itemId: 'a' });
  const native = jest.requireActual<typeof AtomicFile>('../lib/atomic-file');
  const groupChanges = jest.fn();
  const unsubscribe = onSidebarItemGroupsChanged(groupChanges);
  jest.mocked(notifyPortalStructureChanged).mockClear();
  jest.mocked(schedulePortalStructuralSync).mockClear();
  jest
    .mocked(writeFileAtomically)
    .mockImplementation((path, data, options) =>
      path === getSidebarItemGroupsFilePath(scope.workspaceLocalId)
        ? Promise.reject(new Error('membership unavailable'))
        : native.writeFileAtomically(path, data, options),
    );
  try {
    await expect(
      updateWorkspaceWorktrees(scope.workspaceLocalId, (rows) =>
        rows.map((item) =>
          item.id === 'a' ? { ...item, pinned: true } : item,
        ),
      ),
    ).rejects.toThrow('membership unavailable');
    expect(
      (await readWorkspaceWorktrees(scope.workspaceLocalId))[0].pinned,
    ).toBe(true);
    expect(notifyPortalStructureChanged).toHaveBeenCalledTimes(1);
    expect(schedulePortalStructuralSync).toHaveBeenCalledTimes(1);
    expect(groupChanges).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
  }
});

it.each(['reconciliation', 'command'] as const)(
  'invalidates a committed Work Entry change after %s membership failure',
  async (stage) => {
    await createWorkEntry('app-advisor', { id: 'entry-root', title: 'Root' });
    await service.create({ scope: { appAdvisor: true }, itemId: 'entry-root' });
    const changed = jest.fn();
    const groupChanges = jest.fn();
    const unsubscribe = onWorkEntryListChanged(changed);
    const unsubscribeGroups = onSidebarItemGroupsChanged(groupChanges);
    const native = jest.requireActual<typeof AtomicFile>('../lib/atomic-file');
    if (stage === 'reconciliation') {
      jest
        .mocked(writeFileAtomically)
        .mockImplementation((path, data, options) =>
          path === getSidebarItemGroupsFilePath('app-advisor')
            ? Promise.reject(new Error('membership unavailable'))
            : native.writeFileAtomically(path, data, options),
        );
    }
    try {
      const operation =
        stage === 'reconciliation'
          ? updateWorkEntry('app-advisor', 'entry-root', { pinned: true })
          : updateWorkEntryRegistry(
              'app-advisor',
              (rows) =>
                Promise.resolve(
                  rows.map((item) => ({ ...item, title: 'Committed' })),
                ),
              {
                groupMutation: true,
                afterWrite: () =>
                  Promise.reject(new Error('membership unavailable')),
              },
            );
      await expect(operation).rejects.toThrow('membership unavailable');
      const entries = (await readWorkEntriesFile('app-advisor')).entries;
      expect(
        stage === 'reconciliation' ? entries[0].pinned : entries[0].title,
      ).toBe(stage === 'reconciliation' ? true : 'Committed');
      expect(changed).toHaveBeenCalledTimes(1);
      expect(changed).toHaveBeenCalledWith('app-advisor');
      expect(groupChanges).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      unsubscribeGroups();
    }
  },
);

it.each(['pinned', 'hidden'] as const)(
  'removes %s membership before acknowledgement and does not restore it when cleared',
  async (field) => {
    await service.create({ scope, itemId: 'a' });
    await updateWorkspaceWorktrees(scope.workspaceLocalId, (rows) =>
      rows.map((item) => (item.id === 'a' ? { ...item, [field]: true } : item)),
    );
    expect(await readSidebarItemGroupsEnvelope(scope.workspaceLocalId)).toEqual(
      { version: 1, groups: [] },
    );
    await updateWorkspaceWorktrees(scope.workspaceLocalId, (rows) =>
      rows.map((item) => ({ ...item, [field]: undefined })),
    );
    expect(await groups()).toEqual([]);
  },
);

it('archive followed by restore without an intervening read cannot rejoin a group', async () => {
  await service.create({ scope, itemId: 'a' });
  await removeWorkspaceWorktrees(
    scope.workspaceLocalId,
    (item) => item.id === 'a',
  );
  await restoreWorkspaceWorktrees(
    scope.workspaceLocalId,
    ['a', 'b', 'c', 'd'].map(row),
  );
  expect(await groups()).toEqual([]);
  expect(await readSidebarItemGroupsEnvelope(scope.workspaceLocalId)).toEqual({
    version: 1,
    groups: [],
  });
});

it('never prunes membership from an unreadable authoritative registry', async () => {
  const group = await service.create({ scope, itemId: 'a' });
  await writeFile(
    getWorkspaceWorktreesFilePath(scope.workspaceLocalId),
    '{bad',
  );
  await expect(groups()).rejects.toThrow('registry is unreadable');
  expect(await readSidebarItemGroupsEnvelope(scope.workspaceLocalId)).toEqual({
    version: 1,
    groups: [group],
  });
});

it('rejects read-only, forged scopes, children, unknown anchors and missing groups without writes', async () => {
  const group = await service.create({ scope, itemId: 'a' });
  const before = await readFile(
    getSidebarItemGroupsFilePath(scope.workspaceLocalId),
    'utf8',
  );
  await expect(
    service.moveGroup({ scope, groupId: group.id, before: 'missing' }),
  ).rejects.toThrow('anchor');
  await expect(
    service.create({ scope: { workspaceLocalId: '../escape' }, itemId: 'a' }),
  ).rejects.toThrow();
  await expect(
    service.create({ scope: { workspaceLocalId: 'unknown' }, itemId: 'a' }),
  ).rejects.toThrow('unavailable');
  await expect(
    service.moveItem({ scope, itemId: 'b', groupId: 'grp-missing' }),
  ).rejects.toThrow('no longer exists');
  jest.mocked(assertWritableScope).mockImplementation(() => {
    throw new Error('read only');
  });
  await expect(
    service.update({ scope, groupId: group.id, name: 'changed' }),
  ).rejects.toThrow('read only');
  expect(
    await readFile(
      getSidebarItemGroupsFilePath(scope.workspaceLocalId),
      'utf8',
    ),
  ).toEqual(before);
});

it('changes membership without changing canonical manual order in recency mode', async () => {
  await writeFile(
    getWorkspaceConfigPath(scope.workspaceLocalId),
    JSON.stringify({
      version: 1,
      type: 'single-repo',
      repoPath: root,
      itemSortMode: 'last-updated',
    }),
  );
  const group = await service.create({ scope, itemId: 'a' });
  await service.moveItem({
    scope,
    itemId: 'c',
    groupId: group.id,
    before: 'b',
  });
  expect(await ids()).toEqual(['a', 'b', 'c', 'd']);
  expect((await groups())[0]?.memberIds).toEqual(['a', 'c']);
  await updateWorkspaceWorktrees(scope.workspaceLocalId, (rows) =>
    rows.map((item) => ({ ...item, name: 'Renamed' })),
  );
  expect(await ids()).toEqual(['a', 'b', 'c', 'd']);
});

it('detaching a child preserves membership and places it after its former complete stack', async () => {
  await updateWorkspaceWorktrees(scope.workspaceLocalId, () => [
    {
      ...row('b'),
      branchGroupingParentWorktreeId: 'a',
      trackedBaseBranch: 'feature/a',
    },
    row('a'),
    row('c'),
    row('d'),
  ]);
  const group = await service.create({ scope, itemId: 'a' });
  await expect(service.create({ scope, itemId: 'b' })).rejects.toThrow(
    'cannot be grouped',
  );
  await updateWorkspaceWorktrees(scope.workspaceLocalId, (rows) =>
    rows.map((item) =>
      item.id === 'b' ? { ...item, branchGroupingOverride: 'ungroup' } : item,
    ),
  );
  expect((await groups())[0]?.memberIds).toEqual(['a', 'b']);
  expect(await ids()).toEqual(['a', 'b', 'c', 'd']);
  await service.moveGroup({ scope, groupId: group.id, after: 'd' });
  expect(await ids()).toEqual(['c', 'd', 'a', 'b']);
});

it('independent children stay outside a group across ordinary writes when global stacking is off', async () => {
  const defaults = jest.requireActual<typeof PreferencesStore>(
    '../lib/preferences-store',
  ).DEFAULT_PREFERENCES;
  jest
    .mocked(readPreferencesFile)
    .mockResolvedValue({ ...defaults, groupChildBranchesWithBase: false });
  await updateWorkspaceWorktrees(scope.workspaceLocalId, () => [
    row('a'),
    row('c'),
    {
      ...row('b'),
      trackedBaseBranch: 'feature/a',
      branchGroupingParentWorktreeId: 'a',
    },
    row('d'),
  ]);
  const group = await service.create({ scope, itemId: 'a' });
  await service.moveItem({ scope, itemId: 'b', groupId: group.id });
  await service.moveItem({ scope, itemId: 'b', groupId: null });
  const order = await ids();
  await updateWorkspaceWorktrees(scope.workspaceLocalId, (rows) =>
    rows.map((item) => ({ ...item, name: 'Renamed' })),
  );
  expect(await readSidebarItemGroupsEnvelope(scope.workspaceLocalId)).toEqual({
    version: 1,
    groups: [group],
  });
  expect(await ids()).toEqual(order);
});

it.each(['pinned', 'hidden', 'archive'] as const)(
  'failed worktree %s writes preserve membership and registry bytes',
  async (field) => {
    const group = await service.create({ scope, itemId: 'a' });
    const path = getWorkspaceWorktreesFilePath(scope.workspaceLocalId);
    const before = await readFile(path, 'utf8');
    const native = jest.requireActual<typeof AtomicFile>('../lib/atomic-file');
    jest
      .mocked(writeFileAtomically)
      .mockImplementation((target, data, options) =>
        target === path
          ? Promise.reject(new Error('registry unavailable'))
          : native.writeFileAtomically(target, data, options),
      );
    await expect(
      updateWorkspaceWorktrees(scope.workspaceLocalId, (rows) =>
        field === 'archive'
          ? rows.filter((item) => item.id !== 'a')
          : rows.map((item) =>
              item.id === 'a' ? { ...item, [field]: true } : item,
            ),
      ),
    ).rejects.toThrow('registry unavailable');
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(await readSidebarItemGroupsEnvelope(scope.workspaceLocalId)).toEqual(
      { version: 1, groups: [group] },
    );
  },
);

it('failed Work Entry rename preserves membership and the canonical registry', async () => {
  await createWorkEntry('app-advisor', { id: 'entry-root', title: 'Root' });
  const group = await service.create({
    scope: { appAdvisor: true },
    itemId: 'entry-root',
  });
  const path = getWorkspaceWorkEntriesFilePath('app-advisor');
  const before = await readFile(path, 'utf8');
  jest
    .mocked(renameWithRetry)
    .mockRejectedValueOnce(new Error('registry unavailable'));
  await expect(
    updateWorkEntry('app-advisor', 'entry-root', { pinned: true }),
  ).rejects.toThrow('registry unavailable');
  expect(await readFile(path, 'utf8')).toBe(before);
  expect(await readSidebarItemGroupsEnvelope('app-advisor')).toEqual({
    version: 1,
    groups: [group],
  });
});

it('failed grouped creation restores the sidecar instead of retaining a phantom member', async () => {
  await createWorkEntry('app-advisor', { id: 'entry-root', title: 'Root' });
  const group = await service.create({
    scope: { appAdvisor: true },
    itemId: 'entry-root',
  });
  jest
    .mocked(renameWithRetry)
    .mockRejectedValueOnce(new Error('registry unavailable'));
  await expect(
    createWorkEntry('app-advisor', {
      id: 'entry-new',
      title: 'New',
      sidebarItemGroupId: group.id,
    }),
  ).rejects.toThrow('registry unavailable');
  expect(
    (await readWorkEntriesFile('app-advisor')).entries.map((entry) => entry.id),
  ).toEqual(['entry-root']);
  expect(await readSidebarItemGroupsEnvelope('app-advisor')).toEqual({
    version: 1,
    groups: [group],
  });
});

it('grouped reservation requires a created item ID without modifying valid membership', async () => {
  const group = await service.create({ scope, itemId: 'a' });
  const before = await ids();
  await expect(
    updateWorkspaceWorktrees(
      scope.workspaceLocalId,
      (rows) => [...rows, row('new')],
      {
        sidebarItemGroupId: group.id,
      },
    ),
  ).rejects.toThrow('Created item ID is required for a sidebar group');
  expect(await ids()).toEqual(before);
  expect(await groups()).toEqual([group]);
});

it('failed grouped worktree reservation restores its prior membership', async () => {
  const group = await service.create({ scope, itemId: 'a' });
  const path = getWorkspaceWorktreesFilePath(scope.workspaceLocalId);
  const before = await readFile(path, 'utf8');
  const native = jest.requireActual<typeof AtomicFile>('../lib/atomic-file');
  jest
    .mocked(writeFileAtomically)
    .mockImplementation((target, data, options) =>
      target === path
        ? Promise.reject(new Error('registry unavailable'))
        : native.writeFileAtomically(target, data, options),
    );
  await expect(
    updateWorkspaceWorktrees(
      scope.workspaceLocalId,
      (rows) => [...rows, row('new')],
      {
        sidebarItemGroupId: group.id,
        newItemId: 'new',
      },
    ),
  ).rejects.toThrow('registry unavailable');
  expect(await readFile(path, 'utf8')).toBe(before);
  expect(await readSidebarItemGroupsEnvelope(scope.workspaceLocalId)).toEqual({
    version: 1,
    groups: [group],
  });
});

it.each(['sidecar', 'registry'] as const)(
  'grouped creation cannot acknowledge retirement during the %s write',
  async (stage) => {
    await createWorkEntry('app-advisor', { id: 'entry-root', title: 'Root' });
    const group = await service.create({
      scope: { appAdvisor: true },
      itemId: 'entry-root',
    });
    let enter = (): void => undefined;
    let release = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const native = jest.requireActual<typeof AtomicFile>('../lib/atomic-file');
    if (stage === 'sidecar')
      jest
        .mocked(writeFileAtomically)
        .mockImplementation(async (path, data, options) => {
          if (path === getSidebarItemGroupsFilePath('app-advisor')) {
            enter();
            await held;
          }
          return native.writeFileAtomically(path, data, options);
        });
    else
      jest.mocked(renameWithRetry).mockImplementation(async (from, to) => {
        enter();
        await held;
        return native.renameWithRetry(from, to);
      });
    const creating = createWorkEntry('app-advisor', {
      id: 'entry-new',
      title: 'New',
      sidebarItemGroupId: group.id,
    });
    const outcome = creating.then(
      () => 'acknowledged',
      () => 'rejected',
    );
    await entered;
    const retiring = clearWorkEntrySummariesForWorkspace('app-advisor');
    release();
    try {
      await retiring;
      expect(await outcome).toBe('rejected');
    } finally {
      activateWorkEntryWorkspace('app-advisor');
    }
  },
);

it('replacing the sole member group at the limit succeeds but adding an extra group fails', async () => {
  const entries = Array.from({ length: 101 }, (_, index) =>
    row(`item-${index}`),
  );
  await updateWorkspaceWorktrees(scope.workspaceLocalId, () => entries);
  const existing: SidebarItemGroup[] = entries
    .slice(0, 100)
    .map((item, index) => ({
      id: `grp-${index}`,
      name: '',
      color: 'neutral',
      collapsed: false,
      memberIds: [item.id],
    }));
  await writeFile(
    getSidebarItemGroupsFilePath(scope.workspaceLocalId),
    JSON.stringify({ version: 1, groups: existing }),
  );
  await expect(service.create({ scope, itemId: 'item-100' })).rejects.toThrow(
    'limit',
  );
  const replacement = await service.create({
    scope,
    itemId: 'item-0',
    name: 'Replacement',
  });
  const saved = await groups();
  expect(saved).toHaveLength(100);
  expect(saved.some((group) => group.id === 'grp-0')).toBe(false);
  expect(saved.find((group) => group.id === replacement.id)?.memberIds).toEqual(
    ['item-0'],
  );
});

it.each(['cowork-default', 'group-cowork'])(
  '%s root creation detaches a reused grouped entry before acknowledgement',
  async (workspaceId) => {
    const config = getWorkspaceConfigPath(workspaceId);
    await mkdir(dirname(config), { recursive: true });
    await writeFile(config, JSON.stringify({ version: 1, type: 'cowork' }));
    const workScope = { workspaceLocalId: workspaceId };
    await createWorkEntry(workspaceId, { id: 'root', title: 'Existing task' });
    const group = await service.create({ scope: workScope, itemId: 'root' });
    const grouped = await createWorkEntry(workspaceId, {
      sidebarItemGroupId: group.id,
    });
    expect((await service.list(workScope))[0]?.memberIds).toContain(
      grouped.entry.id,
    );
    const created = await createWorkEntry(workspaceId);
    expect(created.entry.id).toBe(grouped.entry.id);
    expect(created.reusedExistingEmpty).toBe(true);
    expect((await service.list(workScope))[0]?.memberIds).toEqual(['root']);
    await service.moveItem({ scope: workScope, itemId: 'root', groupId: null });
    expect(await service.list(workScope)).toEqual([]);
  },
);

it('a grouped Cowork chat created before its first send keeps membership after reload', async () => {
  // The exact Work Entry creation `createStandaloneChatTab` performs for a
  // New Task Cowork chat with attachments: the entry id is the chat id.
  const workspaceId = 'group-cowork-attachments';
  const config = getWorkspaceConfigPath(workspaceId);
  await mkdir(dirname(config), { recursive: true });
  await writeFile(config, JSON.stringify({ version: 1, type: 'cowork' }));
  const workScope = { workspaceLocalId: workspaceId };
  await createWorkEntry(workspaceId, { id: 'root', title: 'Existing task' });
  const group = await service.create({ scope: workScope, itemId: 'root' });
  await createWorkEntry(workspaceId, {
    id: 'new-attachment-chat',
    sidebarItemGroupId: group.id,
    assertCanCommit: () => undefined,
  });
  expect((await service.list(workScope))[0]?.memberIds).toEqual([
    'root',
    'new-attachment-chat',
  ]);
  expect(
    (await readWorkEntriesFile(workspaceId)).entries.map((entry) => entry.id),
  ).toContain('new-attachment-chat');
  // Reload: the durable sidecar on disk holds the membership.
  const envelope = await readSidebarItemGroupsEnvelope(workspaceId);
  expect(JSON.stringify(envelope)).toContain('new-attachment-chat');
});

it('root creation restores reused membership when its registry write fails', async () => {
  const advisor = { appAdvisor: true } as const;
  await createWorkEntry('app-advisor', { id: 'empty' });
  const group = await service.create({ scope: advisor, itemId: 'empty' });
  const before = await readFile(
    getWorkspaceWorkEntriesFilePath('app-advisor'),
    'utf8',
  );
  jest
    .mocked(renameWithRetry)
    .mockRejectedValueOnce(new Error('registry unavailable'));
  await expect(createWorkEntry('app-advisor')).rejects.toThrow(
    'registry unavailable',
  );
  expect(
    await readFile(getWorkspaceWorkEntriesFilePath('app-advisor'), 'utf8'),
  ).toBe(before);
  expect(await service.list(advisor)).toEqual([group]);
  await createWorkEntry('app-advisor');
  expect(await service.list(advisor)).toEqual([]);
});

it.each(['cowork-default', 'group-cowork'])(
  '%s can remove a group while preserving its entries',
  async (workspaceId) => {
    const config = getWorkspaceConfigPath(workspaceId);
    await mkdir(dirname(config), { recursive: true });
    await writeFile(config, JSON.stringify({ version: 1, type: 'cowork' }));
    const workScope = { workspaceLocalId: workspaceId };
    await createWorkEntry(workspaceId, { id: 'root', title: 'Existing task' });
    const group = await service.create({ scope: workScope, itemId: 'root' });
    await service.ungroup({ scope: workScope, groupId: group.id });
    expect(await service.list(workScope)).toEqual([]);
    expect(
      (await readWorkEntriesFile(workspaceId)).entries.map((entry) => entry.id),
    ).toEqual(['root']);
  },
);

it('grouped creation reuses an empty entry and transfers its membership before acknowledgement', async () => {
  const advisor = { appAdvisor: true } as const;
  const first = await createWorkEntry('app-advisor', {
    id: 'empty-a',
  });
  const destination = await service.create({
    scope: advisor,
    itemId: first.entry.id,
  });
  await createWorkEntry('app-advisor', { id: 'empty-b' });
  await service.create({ scope: advisor, itemId: 'empty-b' });
  const result = await createWorkEntry('app-advisor', {
    sidebarItemGroupId: destination.id,
  });
  expect(result).toMatchObject({
    reusedExistingEmpty: true,
    entry: { id: 'empty-b' },
  });
  expect((await readWorkEntriesFile('app-advisor')).entries).toHaveLength(2);
  expect(await service.list(advisor)).toEqual([
    expect.objectContaining({
      id: destination.id,
      memberIds: ['empty-a', 'empty-b'],
    }),
  ]);
  const repeated = await createWorkEntry('app-advisor', {
    sidebarItemGroupId: destination.id,
  });
  expect(repeated.entry.id).toBe('empty-b');
  expect(repeated.reusedExistingEmpty).toBe(true);
  expect((await service.list(advisor))[0]?.memberIds).toEqual([
    'empty-a',
    'empty-b',
  ]);
});

it('grouped creation skips pinned empty entries and restores reused membership if the registry write fails', async () => {
  const advisor = { appAdvisor: true } as const;
  await createWorkEntry('app-advisor', { id: 'empty-a' });
  const destination = await service.create({
    scope: advisor,
    itemId: 'empty-a',
  });
  await createWorkEntry('app-advisor', { id: 'empty-b' });
  const original = await service.create({ scope: advisor, itemId: 'empty-b' });
  await createWorkEntry('app-advisor', { id: 'empty-pin', title: 'Pin' });
  await updateWorkEntry('app-advisor', 'empty-pin', { pinned: true });
  const before = await readFile(
    getWorkspaceWorkEntriesFilePath('app-advisor'),
    'utf8',
  );
  jest
    .mocked(renameWithRetry)
    .mockRejectedValueOnce(new Error('reuse registry failure'));
  await expect(
    createWorkEntry('app-advisor', { sidebarItemGroupId: destination.id }),
  ).rejects.toThrow('reuse registry failure');
  expect(
    await readFile(getWorkspaceWorkEntriesFilePath('app-advisor'), 'utf8'),
  ).toBe(before);
  // Left-nav order: the newer entry sits above the older one.
  expect(await service.list(advisor)).toEqual([
    expect.objectContaining({ id: original.id, memberIds: ['empty-b'] }),
    expect.objectContaining({ id: destination.id, memberIds: ['empty-a'] }),
  ]);
  const result = await createWorkEntry('app-advisor', {
    sidebarItemGroupId: destination.id,
  });
  expect(result.entry.id).toBe('empty-b');
  expect(result.reusedExistingEmpty).toBe(true);
  expect(
    (await readWorkEntriesFile('app-advisor')).entries.find(
      (row) => row.id === 'empty-pin',
    )?.pinned,
  ).toBe(true);
});

it('App Advisor grouped creation persists membership before its row is exposed, and pin/delete reconcile immediately', async () => {
  const advisor = { appAdvisor: true } as const;
  const first = await createWorkEntry('app-advisor', {
    id: 'entry-a',
    title: 'First',
  });
  const second = await createWorkEntry('app-advisor', {
    id: 'entry-b',
    title: 'Second',
  });
  const group = await service.create({
    scope: advisor,
    itemId: first.entry.id,
  });
  const created = await createWorkEntry('app-advisor', {
    title: 'Grouped',
    sidebarItemGroupId: group.id,
  });
  expect(created.reusedExistingEmpty).toBe(false);
  expect((await service.list(advisor))[0]?.memberIds).toEqual([
    'entry-a',
    created.entry.id,
  ]);
  expect(
    (await readWorkEntriesFile('app-advisor')).entries.map((entry) => entry.id),
  ).toEqual(['entry-b', created.entry.id, 'entry-a']);
  await updateWorkEntry('app-advisor', created.entry.id, { pinned: true });
  expect((await service.list(advisor))[0]?.memberIds).toEqual(['entry-a']);
  await removeWorkEntryRow('app-advisor', first.entry.id);
  expect(await service.list(advisor)).toEqual([]);
  expect(second.entry.id).toBe('entry-b');
});

it('read repair persists external deletions before a later restore', async () => {
  await service.create({ scope, itemId: 'a' });
  await writeFile(
    getWorkspaceWorktreesFilePath(scope.workspaceLocalId),
    JSON.stringify({ version: 1, worktrees: ['b', 'c', 'd'].map(row) }),
  );
  expect(await groups()).toEqual([]);
  await writeFile(
    getWorkspaceWorktreesFilePath(scope.workspaceLocalId),
    JSON.stringify({ version: 1, worktrees: ['a', 'b', 'c', 'd'].map(row) }),
  );
  expect(await groups()).toEqual([]);
});

it('projects Work Entry groups without the workspace queue, registry lock or repair write', async () => {
  const advisor = { appAdvisor: true } as const;
  await createWorkEntry('app-advisor', { id: 'entry-a', title: 'A' });
  await createWorkEntry('app-advisor', { id: 'entry-b', title: 'B' });
  const group = await service.create({ scope: advisor, itemId: 'entry-a' });
  await service.moveItem({
    scope: advisor,
    itemId: 'entry-b',
    groupId: group.id,
  });
  const registryPath = getWorkspaceWorkEntriesFilePath('app-advisor');
  const registry = await readWorkEntriesFile('app-advisor');
  await writeFile(
    registryPath,
    JSON.stringify({
      ...registry,
      entries: registry.entries.filter((entry) => entry.id !== 'entry-b'),
    }),
  );
  const sidecar = await readFile(
    getSidebarItemGroupsFilePath('app-advisor'),
    'utf8',
  );
  let release: () => void = (): void => undefined;
  const held = serializeWorkspaceMutation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  try {
    expect((await projectSidebarItemGroups(advisor))?.[0]?.memberIds).toEqual([
      'entry-a',
    ]);
    expect(
      await readFile(getSidebarItemGroupsFilePath('app-advisor'), 'utf8'),
    ).toBe(sidecar);
    await writeFile(registryPath, '{bad');
    await expect(projectSidebarItemGroups(advisor)).resolves.toBeUndefined();
  } finally {
    release();
    await held;
  }
});

it('holds grouped creation before visibility and serializes competing reads behind the same owner', async () => {
  const advisor = { appAdvisor: true } as const;
  await createWorkEntry('app-advisor', { id: 'entry-root', title: 'Root' });
  const group = await service.create({ scope: advisor, itemId: 'entry-root' });
  let enter: () => void = (): void => undefined;
  let release: () => void = (): void => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const fence = new Promise<void>((resolve) => {
    release = resolve;
  });
  const native = jest.requireActual<typeof AtomicFile>('../lib/atomic-file');
  jest
    .mocked(writeFileAtomically)
    .mockImplementation(async (path, data, options) => {
      if (path === getSidebarItemGroupsFilePath('app-advisor')) {
        enter();
        await fence;
      }
      return native.writeFileAtomically(path, data, options);
    });
  const creation = createWorkEntry('app-advisor', {
    id: 'entry-held',
    title: 'Held',
    sidebarItemGroupId: group.id,
  });
  await entered;
  expect(
    (await readWorkEntriesFile('app-advisor')).entries.map((entry) => entry.id),
  ).toEqual(['entry-root']);
  let readCompleted = false;
  const queuedRead = service.list(advisor).then((value) => {
    readCompleted = true;
    return value;
  });
  await Promise.resolve();
  expect(readCompleted).toBe(false);
  release();
  await creation;
  expect((await queuedRead)[0]?.memberIds).toEqual([
    'entry-root',
    'entry-held',
  ]);
});

it('failed grouped creation never publishes a newly reserved row', async () => {
  await expect(
    createWorkEntry('app-advisor', {
      id: 'entry-new',
      title: 'Missing group',
      sidebarItemGroupId: 'grp-missing',
    }),
  ).rejects.toThrow('unavailable');
  expect((await readWorkEntriesFile('app-advisor')).entries).toEqual([]);
});

it('a queued group mutation cannot acknowledge after workspace retirement closes admission', async () => {
  await createWorkEntry('app-advisor', { id: 'entry-root', title: 'Root' });
  let enter: () => void = (): void => undefined;
  let release: () => void = (): void => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const fence = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = updateWorkEntryRegistry('app-advisor', async (entries) => {
    enter();
    await fence;
    return entries;
  });
  await entered;
  const queued = service.create({
    scope: { appAdvisor: true },
    itemId: 'entry-root',
  });
  // Scope resolution is async; let the accepted mutation reach the owner queue.
  await Promise.resolve();
  const retiring = clearWorkEntrySummariesForWorkspace('app-advisor');
  release();
  try {
    await Promise.all([
      expect(blocker).rejects.toThrow('deleted'),
      expect(queued).rejects.toThrow('deleted'),
      retiring,
    ]);
    expect(await readSidebarItemGroupsEnvelope('app-advisor')).toBeUndefined();
  } finally {
    activateWorkEntryWorkspace('app-advisor');
  }
});

it('queued groups cannot cross a canonical workspace deletion in progress', async () => {
  let enter: () => void = (): void => undefined;
  let release: () => void = (): void => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const fence = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deleting = serializeWorkspaceMutation(async () => {
    enter();
    await fence;
    await rm(dirname(getWorkspaceConfigPath(scope.workspaceLocalId)), {
      recursive: true,
      force: true,
    });
  });
  await entered;
  const read = jest.spyOn(WorkspacePersistence, 'readWorkspaceConfigDetailed');
  const pending = service.create({ scope, itemId: 'a' });
  const outcome = pending.then(
    () => 'acknowledged',
    () => 'rejected',
  );
  try {
    expect(read).not.toHaveBeenCalled();
  } finally {
    release();
    await deleting;
    await outcome;
    read.mockRestore();
  }
  expect(await outcome).toBe('rejected');
  await expect(
    readFile(getSidebarItemGroupsFilePath(scope.workspaceLocalId)),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects unsafe IPC item, group and anchor IDs through the shared validation boundary', async () => {
  const group = await service.create({ scope, itemId: 'a' });
  await expect(service.create({ scope, itemId: '../a' })).rejects.toThrow(
    IdentifierValidationError,
  );
  await expect(
    service.update({ scope, groupId: 'grp-../a', name: 'Changed' }),
  ).rejects.toThrow(IdentifierValidationError);
  await expect(
    service.moveItem({ scope, itemId: 'b', groupId: group.id, before: '../a' }),
  ).rejects.toThrow(IdentifierValidationError);
  expect((await groups())[0]?.memberIds).toEqual(['a']);
});

it.each(['partial', 'missing'] as const)(
  'refuses a group transaction on a %s worktree list before touching membership',
  async (kind) => {
    const listPath = getWorkspaceWorktreesFilePath(scope.workspaceLocalId);
    const group = await service.create({ scope, itemId: 'a' });
    const membership = await readFile(
      getSidebarItemGroupsFilePath(scope.workspaceLocalId),
      'utf8',
    );
    const partial = JSON.stringify({
      version: 1,
      worktrees: [row('a'), { id: 'unknown' }],
    });
    if (kind === 'missing') await rm(listPath);
    else await writeFile(listPath, partial);
    await expect(
      service.moveItem({ scope, itemId: 'a', groupId: group.id }),
    ).rejects.toMatchObject({ reason: 'worktrees-unavailable' });
    expect(
      await readFile(
        getSidebarItemGroupsFilePath(scope.workspaceLocalId),
        'utf8',
      ),
    ).toBe(membership);
    if (kind === 'missing')
      await expect(readFile(listPath, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    else expect(await readFile(listPath, 'utf8')).toBe(partial);
  },
);

describe('named assignment color and typed refusals', () => {
  it('applies color only to a group the assignment creates', async () => {
    const first = await service.assignItemToNamedGroup({
      scope,
      itemId: 'a',
      name: 'Reviews',
      color: 'categorical-2',
    });
    const second = await service.assignItemToNamedGroup({
      scope,
      itemId: 'b',
      name: 'Reviews',
      color: 'categorical-5',
    });

    expect(first.created).toBe(true);
    expect(first.group.color).toBe('categorical-2');
    expect(second.created).toBe(false);
    expect(second.group).toMatchObject({
      id: first.group.id,
      color: 'categorical-2',
    });
  });

  it('picks a color for a created group when none is given', async () => {
    const random = jest.spyOn(Math, 'random').mockReturnValue(0);
    try {
      await service.create({ scope, itemId: 'a', color: 'neutral' });
      const assigned = await service.assignItemToNamedGroup({
        scope,
        itemId: 'b',
        name: 'Fresh',
      });

      expect(assigned.created).toBe(true);
      expect(assigned.group.color).toBe('categorical-1');
    } finally {
      random.mockRestore();
    }
  });

  it('types the group limit refusal', async () => {
    const entries = Array.from({ length: 101 }, (_, index) =>
      row(`item-${index}`),
    );
    await updateWorkspaceWorktrees(scope.workspaceLocalId, () => entries);
    await writeFile(
      getSidebarItemGroupsFilePath(scope.workspaceLocalId),
      JSON.stringify({
        version: 1,
        groups: entries.slice(0, 100).map((item, index) => ({
          id: `grp-${index}`,
          name: `Group ${index}`,
          color: 'neutral',
          collapsed: false,
          memberIds: [item.id],
        })),
      }),
    );

    const refusal = service
      .assignItemToNamedGroup({ scope, itemId: 'item-100', name: 'One more' })
      .catch((error: unknown) => error);

    const error = await refusal;
    expect(error).toBeInstanceOf(SidebarItemGroupRefusalError);
    expect(error).toMatchObject({
      code: 'group_limit_reached',
      message: 'Sidebar item group limit reached',
    });
  });

  it('types a stacked child worktree as not groupable', async () => {
    const preferences = jest.requireActual<typeof PreferencesStore>(
      '../lib/preferences-store',
    ).DEFAULT_PREFERENCES;
    jest
      .mocked(readPreferencesFile)
      .mockResolvedValue({ ...preferences, groupChildBranchesWithBase: true });
    await updateWorkspaceWorktrees(scope.workspaceLocalId, () => [
      row('a'),
      { ...row('child'), branchGroupingParentWorktreeId: 'a' },
      row('b'),
    ]);
    const group = await service.create({ scope, itemId: 'b', name: 'Other' });

    for (const attempt of [
      service.assignItemToNamedGroup({ scope, itemId: 'child', name: 'Docs' }),
      service.moveItem({ scope, itemId: 'child', groupId: group.id }),
    ]) {
      const error = await attempt.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SidebarItemGroupRefusalError);
      expect(error).toMatchObject({
        code: 'item_not_groupable',
        message: 'Sidebar item cannot be grouped',
      });
    }
  });

  it('types an unknown group id as group_not_found', async () => {
    const error = await service
      .moveItem({ scope, itemId: 'a', groupId: 'grp-missing' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SidebarItemGroupRefusalError);
    expect(error).toMatchObject({
      code: 'group_not_found',
      message: 'Sidebar item group no longer exists',
    });
  });

  it('removing an ungrouped item from its group is a no-op', async () => {
    await expect(
      service.moveItem({ scope, itemId: 'a', groupId: null }),
    ).resolves.toBeUndefined();
    expect(await groups()).toEqual([]);
  });
});
