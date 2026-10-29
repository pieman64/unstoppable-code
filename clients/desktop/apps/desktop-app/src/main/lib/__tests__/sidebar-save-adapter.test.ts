jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({ recordAppDiagnostic: jest.fn() })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
}));
jest.mock('../archived-containers', () => ({
  countArchivedContainers: jest.fn(() => Promise.resolve(0)),
}));
jest.mock('../script-resolver', () => ({
  resolveProjectScripts: jest.fn(() => Promise.resolve({})),
  toScriptOverrides: jest.fn(),
}));
jest.mock('../hook-resolver', () => ({
  resolveProjectHooks: jest.fn(() => Promise.resolve({})),
  toHookOverrides: jest.fn(),
}));
jest.mock('../../services/foreign-activity-sources', () => ({
  markForeignPipelineResultsSeen: jest.fn(),
}));

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  SidebarItem,
  SidebarItemsSaveOptions,
  SidebarItemsFile,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { PROJECT_COLORS } from '@canopy/desktop-shared/constants/project-colors';
import { markForeignPipelineResultsSeen } from '../../services/foreign-activity-sources';
import {
  getWorkspaceConfigPath,
  getWorkspaceIndexFilePath,
  getWorkspaceWorktreesFilePath,
} from '../paths';
import {
  __resetSidebarItemsStateForTests,
  readAllSidebarItems,
} from '../sidebar-items';

import { readWorkspaceWorktrees } from '../workspace-persistence';
import { getWorkspaceIndexRepository } from '../sidebar-items';
import {
  saveSidebarItems,
  SidebarSaveRefusedError,
} from '../sidebar-save-adapter';
async function save(
  items: SidebarItem[],
  options?: SidebarItemsSaveOptions,
  previousItems?: SidebarItem[],
): Promise<SidebarItemsFile> {
  return saveSidebarItems({
    source: 'projects_save',
    items,
    options,
    previousItems,
  });
}

const row = (extra: Partial<WorktreeData> = {}): WorktreeData => ({
  id: 'wt',
  createdAt: '2026-10-01T00:00:00Z',
  branchName: 'feature/old',
  ...extra,
});
let root: string;
let previousDataDir: string | undefined;
async function seed(id: string, worktrees: unknown[] = [row()]): Promise<void> {
  const config = getWorkspaceConfigPath(id);
  await mkdir(dirname(config), { recursive: true });
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      type: 'single-repo',
      repos: [],
      repoPath: root,
      scripts: { setup: 'latest' },
      futureConfig: true,
    }),
  );
  await writeFile(
    getWorkspaceWorktreesFilePath(id),
    JSON.stringify({ version: 1, worktrees, futureList: true }),
  );
}
async function index(ids: string[]): Promise<void> {
  await mkdir(dirname(getWorkspaceIndexFilePath()), { recursive: true });
  await writeFile(
    getWorkspaceIndexFilePath(),
    JSON.stringify({
      version: 1,
      futureIndex: true,
      workspaces: ids.map((id, order) => ({
        id,
        name: id,
        type: 'single-repo',
        color: PROJECT_COLORS[0],
        collapsed: false,
        order,
        futureEntry: true,
      })),
    }),
  );
}
beforeEach(async () => {
  jest.clearAllMocks();
  previousDataDir = process.env.CANOPY_DATA_DIR;
  root = await mkdtemp(join(tmpdir(), 'sidebar-save-adapter-'));
  process.env.CANOPY_DATA_DIR = root;
  __resetSidebarItemsStateForTests();
  await index(['one', 'two']);
  await seed('one');
  await seed('two');
});
afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
  await rm(root, { recursive: true, force: true });
});
it('changes collapse from a stale projection without rolling back canonical fields or another workspace', async () => {
  const baseline = (await readAllSidebarItems()).items;
  const incoming = baseline.map((item) =>
    item.id === 'one' ? { ...item, collapsed: true } : item,
  );
  const newer = row({
    branchName: 'feature/new',
    lastKnownPrStatus: null,
    status: 'done',
    discovery: {
      slashCommands: [],
      mcpServers: [],
      discoveredAt: '2026-10-12T00:00:00Z',
    },
    seenPipelineExecutionIds: ['new-run'],
    pendingArchiveBranchDeletion: {
      branchName: 'obsolete',
      expectedTip: 'abc',
      referenceRepoPath: root,
      repositoryIdentity: 'repo',
    },
  });
  await seed('one', [
    {
      ...newer,
      futureRow: true,
      healthIssue: {
        status: 'broken',
        code: 'missing-worktree-path',
        message: 'Missing checkout',
        checkedAt: '2026-10-12T00:00:00Z',
        worktreePath: join(root, 'worktrees', 'wt'),
      },
    },
    { ...row(), id: 'concurrent' },
  ]);
  await writeFile(
    getWorkspaceConfigPath('two'),
    JSON.stringify({
      version: 1,
      type: 'single-repo',
      repos: [],
      repoPath: root,
      scripts: { setup: 'concurrent' },
    }),
  );
  const currentRows = await readWorkspaceWorktrees('one');
  const oneConfig = await readFile(getWorkspaceConfigPath('one'), 'utf8');
  const oneList = await readFile(getWorkspaceWorktreesFilePath('one'), 'utf8');
  const twoConfig = await readFile(getWorkspaceConfigPath('two'), 'utf8');
  const twoList = await readFile(getWorkspaceWorktreesFilePath('two'), 'utf8');
  await save(incoming, undefined, baseline);
  expect(
    (await readAllSidebarItems()).items.find((item) => item.id === 'one')
      ?.collapsed,
  ).toBe(true);
  expect(await readWorkspaceWorktrees('one')).toEqual(currentRows);
  expect(await readFile(getWorkspaceConfigPath('one'), 'utf8')).toBe(oneConfig);
  expect(await readFile(getWorkspaceWorktreesFilePath('one'), 'utf8')).toBe(
    oneList,
  );
  expect(await readFile(getWorkspaceConfigPath('two'), 'utf8')).toBe(twoConfig);
  expect(await readFile(getWorkspaceWorktreesFilePath('two'), 'utf8')).toBe(
    twoList,
  );
});
it('does not replay worktree fields changed elsewhere since the delivered projection', async () => {
  const baseline = (await readAllSidebarItems()).items;
  // A targeted command (tracked base, label) and a merge retarget changed the
  // row after the window's last load; the renderer store already shows them.
  const changed = row({
    label: 'Renamed',
    trackedBaseBranch: 'release',
    branchGroupingParentWorktreeId: 'parent',
  });
  await seed('one', [changed]);
  const listBefore = await readFile(
    getWorkspaceWorktreesFilePath('one'),
    'utf8',
  );
  const incoming = baseline.map((item) =>
    item.id === 'one' && item.type !== 'cowork'
      ? {
          ...item,
          collapsed: true,
          worktrees: item.worktrees.map((worktree) => ({
            ...worktree,
            label: 'Renamed',
            trackedBaseBranch: 'release',
          })),
        }
      : item,
  );
  await save(incoming, undefined, baseline);
  expect(await readFile(getWorkspaceWorktreesFilePath('one'), 'utf8')).toBe(
    listBefore,
  );
});
it('reorders only on replaceWorkspaceOrder and keeps unmentioned slots', async () => {
  await index(['one', 'unmentioned', 'two']);
  await seed('unmentioned');
  const incoming = (await readAllSidebarItems()).items
    .filter((item) => item.id !== 'unmentioned')
    .reverse();
  await save(incoming);
  expect((await readAllSidebarItems()).items.map((item) => item.id)).toEqual([
    'one',
    'unmentioned',
    'two',
  ]);
  await save(incoming, { replaceWorkspaceOrder: true });
  expect((await readAllSidebarItems()).items.map((item) => item.id)).toEqual([
    'two',
    'unmentioned',
    'one',
  ]);
});
it('ignores private writer options and preserves an unmentioned workspace', async () => {
  const items = (await readAllSidebarItems()).items.filter(
    (item) => item.id === 'one',
  );
  const options: SidebarItemsSaveOptions = {};
  Reflect.set(options, 'deletedWorkspaceIds', ['two']);
  Reflect.set(options, 'replaceOwnershipWorkspaceIds', ['one']);
  const outcome = await save(items, options);
  expect((await readAllSidebarItems()).items.map((item) => item.id)).toEqual([
    'one',
    'two',
  ]);
  expect(outcome.preservedWorkspaceIds).toContain('two');
});
it('does not create snapshot-only workspaces or resurrect snapshot-only rows', async () => {
  const items = (await readAllSidebarItems()).items;
  const source = items[0];
  if (!source || source.type === 'cowork') throw new Error('Fixture missing');
  await save([
    {
      ...source,
      worktrees: [...source.worktrees, { ...row(), id: 'removed' }],
    },
    { ...source, id: 'new-project' },
  ]);
  await expect(
    readFile(getWorkspaceConfigPath('new-project'), 'utf8'),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await readAllSidebarItems()).items.map((item) => item.id)).toEqual([
    'one',
    'two',
  ]);
  const persisted = await readWorkspaceWorktrees('one');
  expect(persisted.map((item) => item.id)).toEqual(['wt']);
});
it.each(['unreadable', 'missing', 'partial-list'] as const)(
  'preserves %s state without editing its index metadata',
  async (kind) => {
    const items = (await readAllSidebarItems()).items.map((item) => ({
      ...item,
      collapsed: true,
    }));
    if (kind === 'missing') await rm(getWorkspaceConfigPath('one'));
    else if (kind === 'unreadable')
      await writeFile(getWorkspaceConfigPath('one'), '{broken');
    else await seed('one', [row(), { id: 'unknown-row' }]);
    const list = await readFile(getWorkspaceWorktreesFilePath('one'), 'utf8');
    const outcome = await save(items);
    expect(outcome.preservedWorkspaceIds).toContain('one');
    const written = await getWorkspaceIndexRepository().read();
    expect(written.entries.find((item) => item.id === 'one')?.collapsed).toBe(
      false,
    );
    expect(await readFile(getWorkspaceWorktreesFilePath('one'), 'utf8')).toBe(
      list,
    );
    if (kind === 'unreadable')
      expect(await readFile(getWorkspaceConfigPath('one'), 'utf8')).toBe(
        '{broken',
      );
    if (kind === 'missing')
      await expect(
        readFile(getWorkspaceConfigPath('one'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
  },
);
it('applies explicit seen and unseen changes while retaining executions observed since the delivered projection', async () => {
  await seed('one', [row({ seenPipelineExecutionIds: ['remove', 'keep'] })]);
  const baseline = (await readAllSidebarItems()).items;
  const incoming = baseline.map((item) =>
    item.id === 'one' && item.type !== 'cowork'
      ? {
          ...item,
          worktrees: item.worktrees.map((wt) => ({
            ...wt,
            label: 'Edited',
            seenPipelineExecutionIds: ['keep', 'add'],
          })),
        }
      : item,
  );
  await seed('one', [
    row({ seenPipelineExecutionIds: ['remove', 'keep', 'concurrent'] }),
  ]);
  await save(incoming, undefined, baseline);
  const persisted = await readWorkspaceWorktrees('one');
  expect(persisted[0]?.label).toBe('Edited');
  expect(persisted[0]?.seenPipelineExecutionIds).toEqual([
    'keep',
    'concurrent',
    'add',
  ]);
  expect(markForeignPipelineResultsSeen).toHaveBeenCalledWith('one', 'wt', [
    'add',
  ]);
});

it.each(['source', 'id', 'index'] as const)(
  'refuses an invalid %s without writing',
  async (kind) => {
    const items = (await readAllSidebarItems()).items;
    const request: Parameters<typeof saveSidebarItems>[0] = {
      source: 'projects_save',
      items,
    };
    if (kind === 'source') Reflect.set(request, 'source', 'unknown');
    if (kind === 'id')
      request.items = items.map((item) => ({ ...item, id: '../invalid' }));
    if (kind === 'index')
      await writeFile(getWorkspaceIndexFilePath(), '{broken');
    const contents = await readFile(getWorkspaceIndexFilePath(), 'utf8');
    const error = await saveSidebarItems(request).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SidebarSaveRefusedError);
    expect(error).toMatchObject({
      reason: kind === 'index' ? 'index-unavailable' : 'invalid-request',
    });
    expect(await readFile(getWorkspaceIndexFilePath(), 'utf8')).toBe(contents);
  },
);
