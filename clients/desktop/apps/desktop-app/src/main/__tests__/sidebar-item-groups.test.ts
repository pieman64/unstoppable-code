import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let mockRoot = '';
jest.mock('../lib/paths', () => ({
  getSidebarItemGroupsFilePath: (id: string): string =>
    join(mockRoot, id, 'sidebar-item-groups.json'),
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));
import {
  readSidebarItemGroups,
  writeSidebarItemGroups,
  reconcileSidebarItemGroups,
  SidebarItemGroupsVersionError,
  sidebarGroupStackUnits,
  restoreSidebarItemGroupsEnvelope,
} from '../lib/sidebar-item-groups';
import { getSidebarItemGroupsFilePath } from '../lib/paths';
import type { SidebarItemGroup } from '@canopy/protocol/sidebar';

const inventory = { liveItemIds: ['a', 'b', 'c'] };
const group: SidebarItemGroup = {
  id: 'grp-one',
  name: '  Frontend  ',
  color: 'categorical-1',
  collapsed: false,
  memberIds: ['a', 'b'],
};
beforeEach(async () => {
  mockRoot = await mkdtemp(join(tmpdir(), 'sidebar-groups-'));
});
afterEach(async () => {
  await rm(mockRoot, { recursive: true, force: true });
});
async function seed(text: string): Promise<void> {
  await mkdir(join(mockRoot, 'workspace'), { recursive: true });
  await writeFile(getSidebarItemGroupsFilePath('workspace'), text);
}

test('creation rollback refuses to replace a future envelope installed externally', async () => {
  const future = JSON.stringify({ version: 99, groups: [], future: true });
  await seed(future);
  await expect(
    restoreSidebarItemGroupsEnvelope('workspace', {
      version: 1,
      groups: [group],
    }),
  ).rejects.toThrow(SidebarItemGroupsVersionError);
  expect(
    await readFile(getSidebarItemGroupsFilePath('workspace'), 'utf8'),
  ).toBe(future);
});

test('missing state stays absent until a mutation and reopens with normalized membership', async () => {
  expect(await readSidebarItemGroups('workspace', inventory)).toEqual([]);
  await writeSidebarItemGroups('workspace', [group], inventory);
  expect(await readSidebarItemGroups('workspace', inventory)).toEqual([
    { ...group, name: 'Frontend' },
  ]);
  expect(
    JSON.parse(
      await readFile(getSidebarItemGroupsFilePath('workspace'), 'utf8'),
    ),
  ).toEqual({ version: 1, groups: [{ ...group, name: 'Frontend' }] });
});

test('each read rechecks complete inventory even for a cached envelope', async () => {
  await writeSidebarItemGroups('workspace', [group], inventory);
  expect(
    (
      await readSidebarItemGroups('workspace', {
        ...inventory,
        ineligibleItemIds: ['a'],
      })
    )[0]?.memberIds,
  ).toEqual(['b']);
  expect(
    (await readSidebarItemGroups('workspace', inventory))[0]?.memberIds,
  ).toEqual(['a', 'b']);
});

test.each(['{broken', '{"version":1,"groups":{}}', 'null'])(
  'quarantines malformed input before recovery: %s',
  async (raw) => {
    await seed(raw);
    expect(await readSidebarItemGroups('workspace', inventory)).toEqual([]);
    const files = await readdir(join(mockRoot, 'workspace'));
    const quarantined = files.find((file) => file.includes('.corrupt-'));
    expect(quarantined).toBeDefined();
    if (quarantined)
      expect(
        await readFile(join(mockRoot, 'workspace', quarantined), 'utf8'),
      ).toBe(raw);
    await writeSidebarItemGroups('workspace', [group], inventory);
    expect((await readSidebarItemGroups('workspace', inventory))[0]?.id).toBe(
      'grp-one',
    );
  },
);

test('preserves future versions across list, lifecycle cleanup and mutation', async () => {
  const raw = '{"version":9,"groups":[{"id":"future"}],"unknown":true}';
  await seed(raw);
  await expect(
    readSidebarItemGroups('workspace', inventory),
  ).rejects.toBeInstanceOf(SidebarItemGroupsVersionError);
  await reconcileSidebarItemGroups('workspace', { liveItemIds: [] });
  await expect(
    writeSidebarItemGroups('workspace', [], inventory),
  ).rejects.toBeInstanceOf(SidebarItemGroupsVersionError);
  expect(
    await readFile(getSidebarItemGroupsFilePath('workspace'), 'utf8'),
  ).toBe(raw);
  expect(await readdir(join(mockRoot, 'workspace'))).toEqual([
    'sidebar-item-groups.json',
  ]);
});

test('external edits invalidate raw cache and removals are durable before restore', async () => {
  await writeSidebarItemGroups('workspace', [group], inventory);
  await seed(
    JSON.stringify({ version: 1, groups: [{ ...group, name: 'External' }] }),
  );
  expect((await readSidebarItemGroups('workspace', inventory))[0]?.name).toBe(
    'External',
  );
  await reconcileSidebarItemGroups('workspace', { liveItemIds: ['c'] });
  expect(await readSidebarItemGroups('workspace', inventory)).toEqual([]);
});

test('transient read failures do not quarantine or replace original state', async () => {
  await mkdir(getSidebarItemGroupsFilePath('workspace'), { recursive: true });
  await expect(
    readSidebarItemGroups('workspace', inventory),
  ).rejects.toMatchObject({ code: 'EISDIR' });
  expect(await readdir(join(mockRoot, 'workspace'))).toEqual([
    'sidebar-item-groups.json',
  ]);
});

test('complete stack units follow tracked roots and explicit detach', () => {
  const rows = [
    { id: 'root', branchName: 'root-branch', createdAt: 'now' },
    {
      id: 'child',
      branchName: 'child-branch',
      trackedBaseBranch: 'root-branch',
      createdAt: 'now',
    },
    {
      id: 'grandchild',
      branchName: 'nested',
      trackedBaseBranch: 'child-branch',
      createdAt: 'now',
    },
  ];
  expect(sidebarGroupStackUnits(rows)).toEqual([
    ['root', 'child', 'grandchild'],
  ]);
  expect(
    sidebarGroupStackUnits(
      rows.map((row) =>
        row.id === 'child'
          ? { ...row, branchGroupingOverride: 'ungroup' }
          : row,
      ),
    ),
  ).toEqual([['root'], ['child', 'grandchild']]);
});

test('builds independent stack units without rescanning all worktrees per root', () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    id: `root-${index}`,
    branchName: `branch-${index}`,
    createdAt: 'now',
  }));
  const filter = jest.spyOn(rows, 'filter');
  expect(sidebarGroupStackUnits(rows)).toEqual(rows.map((row) => [row.id]));
  expect(filter).not.toHaveBeenCalled();
});
