import '../../../__tests__/worktree-replica-compatibility';
// CAN-3823 part A: real repositories and files; the atomic-write seam only injects failures.
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({ recordAppDiagnostic: jest.fn() })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
let mockFailPath: string | undefined;
jest.mock('../atomic-file', () => {
  const actual = jest.requireActual<typeof AtomicFile>('../atomic-file');
  return {
    ...actual,
    writeFileAtomically: async (
      ...args: Parameters<typeof actual.writeFileAtomically>
    ): Promise<void> => {
      if (args[0] === mockFailPath) {
        mockFailPath = undefined;
        throw new Error('disk full');
      }
      await actual.writeFileAtomically(...args);
    },
  };
});
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type {
  MultiRepoSidebarItem,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import type * as AtomicFile from '../atomic-file';
import {
  getWorkspaceConfigPath,
  getWorkspaceIndexFilePath,
  getWorkspaceWorktreesFilePath,
} from '../paths';
import {
  __resetSidebarItemsStateForTests,
  getWorkspaceIndexRepository,
} from '../sidebar-items';
import {
  readWorkspaceConfig,
  readWorkspaceWorktrees,
  updateWorkspaceConfig,
  updateWorkspaceWorktrees,
} from '../workspace-persistence';
import {
  recordJoinedWorktree,
  undoJoinedWorktree,
  removeCompositionWorktree,
  restoreCompositionWorktrees,
  recordCompositionSource,
  undoCompositionSource,
  undoCompositionRepositories,
  createTemporaryCompositionRecords,
  indexTemporaryCompositionWorkspace,
  promoteCompositionWorkspace,
  cleanupCompositionDestination,
  type JoinedWorktreeRecord,
} from '../workspace-composition-records';

const moved: WorktreeData = {
  id: 'moved',
  branchName: 'feature',
  createdAt: '2026-10-01T00:00:00.000Z',
};
const other: WorktreeData = {
  id: 'other',
  branchName: 'main',
  createdAt: moved.createdAt,
};
let root: string;
let previous: string | undefined;
let count = 0;
let sourceId: string;
let destinationId: string;
beforeEach(async () => {
  previous = process.env.CANOPY_DATA_DIR;
  await mkdir(join(process.cwd(), '.playwright/can-3823'), { recursive: true });
  root = await mkdtemp(join(process.cwd(), '.playwright/can-3823/data-'));
  process.env.CANOPY_DATA_DIR = root;
  sourceId = `source-${++count}`;
  destinationId = `destination-${count}`;
  mockFailPath = undefined;
  __resetSidebarItemsStateForTests();
});
afterEach(async () => {
  if (previous === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previous;
  await rm(root, { recursive: true, force: true });
});
async function seed(workspaceId: string, rows: unknown[]): Promise<void> {
  const file = getWorkspaceWorktreesFilePath(workspaceId);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({ version: 1, worktrees: rows, futureListField: true }),
  );
}
function recording(): JoinedWorktreeRecord {
  return {
    source: 'existing_worktree_join',
    workspaceId: destinationId,
    worktreeId: moved.id,
    sourceWorktree: moved,
    repoIdRewrites: { original: 'joined' },
    compatibilitySymlinks: [],
    transition: {
      sourceWorkspaceId: sourceId,
      sourceWorktreeId: moved.id,
      sourceRepoIds: ['original'],
      createdAt: moved.createdAt,
    },
  };
}
function removal(
  workspaceId = sourceId,
): Parameters<typeof removeCompositionWorktree>[0] {
  return { source: 'existing_worktree_join', workspaceId, worktree: moved };
}
function temporary(): MultiRepoSidebarItem {
  return {
    type: 'multi-repo',
    id: destinationId,
    name: 'Temporary',
    color: '#123456',
    repos: [],
    worktrees: [],
    collapsed: false,
    order: 0,
    temporary: true,
    temporarySourceWorkspaceIds: [sourceId],
    temporaryRepoIdentityKeys: ['path:repo'],
  };
}
async function json(file: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Expected object');
  return value;
}
async function concurrentEdit(workspaceId: string): Promise<void> {
  await updateWorkspaceWorktrees(workspaceId, (rows) => [
    { ...other, id: 'concurrent' },
    ...rows.map((row) => ({ ...row, label: 'Concurrent label' })),
  ]);
}
it('moves a row while keeping unrelated rows and fields in both lists', async () => {
  await seed(sourceId, [moved, { ...other, futureRowField: 'kept' }]);
  await seed(destinationId, [other]);
  await Promise.all([
    concurrentEdit(sourceId),
    recordJoinedWorktree(recording()),
    concurrentEdit(destinationId),
  ]);
  await removeCompositionWorktree(removal());
  for (const workspaceId of [sourceId, destinationId]) {
    expect(await readWorkspaceWorktrees(workspaceId)).toEqual(
      expect.arrayContaining([
        { ...other, id: 'concurrent' },
        {
          ...other,
          label: 'Concurrent label',
          ...(workspaceId === sourceId ? { futureRowField: 'kept' } : {}),
        },
      ]),
    );
    expect(
      await json(getWorkspaceWorktreesFilePath(workspaceId)),
    ).toMatchObject({ futureListField: true });
  }
  expect(
    (await readWorkspaceWorktrees(sourceId)).some((row) => row.id === moved.id),
  ).toBe(false);
  expect(
    (await readWorkspaceWorktrees(destinationId)).filter(
      (row) => row.id === moved.id,
    ),
  ).toHaveLength(1);
});
it('rollback keeps an unrelated row and field committed after movement', async () => {
  await seed(sourceId, [{ ...moved, futureRowField: 'restore' }, other]);
  await seed(destinationId, [other]);
  const destination = await recordJoinedWorktree(recording());
  const removed = await removeCompositionWorktree(removal());
  await Promise.all([concurrentEdit(sourceId), concurrentEdit(destinationId)]);
  if (!destination.undo) throw new Error('Expected destination undo');
  await undoJoinedWorktree(destination.undo);
  await restoreCompositionWorktrees({
    source: 'existing_worktree_join',
    workspaceId: sourceId,
    ...removed,
  });
  expect(await readWorkspaceWorktrees(sourceId)).toEqual([
    { ...other, id: 'concurrent' },
    { ...moved, futureRowField: 'restore' },
    { ...other, label: 'Concurrent label' },
  ]);
  expect(await readWorkspaceWorktrees(destinationId)).toEqual([
    { ...other, id: 'concurrent' },
    { ...other, label: 'Concurrent label' },
  ]);
});
it('a destination write failure leaves both lists intact; retry after partial movement loses no membership', async () => {
  await seed(sourceId, [moved, other]);
  await seed(destinationId, [other]);
  const before = await readFile(
    getWorkspaceWorktreesFilePath(destinationId),
    'utf8',
  );
  mockFailPath = getWorkspaceWorktreesFilePath(destinationId);
  await expect(recordJoinedWorktree(recording())).rejects.toThrow('disk full');
  expect(
    await readFile(getWorkspaceWorktreesFilePath(destinationId), 'utf8'),
  ).toBe(before);
  expect(await readWorkspaceWorktrees(sourceId)).toEqual([moved, other]);
  await recordJoinedWorktree(recording());
  mockFailPath = getWorkspaceWorktreesFilePath(sourceId);
  await expect(removeCompositionWorktree(removal())).rejects.toThrow(
    'disk full',
  );
  expect(await readWorkspaceWorktrees(sourceId)).toEqual([moved, other]);
  await concurrentEdit(destinationId);
  await recordJoinedWorktree(recording());
  await removeCompositionWorktree(removal());
  await removeCompositionWorktree(removal());
  expect(
    (await readWorkspaceWorktrees(destinationId)).filter(
      (row) => row.id === moved.id,
    ),
  ).toEqual([expect.objectContaining({ ...moved, label: 'Concurrent label' })]);
  expect(await readWorkspaceWorktrees(sourceId)).toEqual([other]);
});
it('undo restores only source fields and repository entries written by this join', async () => {
  const oldBranch = { original: 'main', replaced: 'old' };
  await seed(sourceId, [
    { ...moved, trackedRepoBaseBranches: oldBranch },
    other,
  ]);
  await updateWorkspaceConfig(sourceId, (config) => {
    config.type = 'multi-repo';
    config.repos = [
      { id: 'original', name: 'Original', repoPath: '/original' },
      { id: 'added', name: 'Added', repoPath: '/added' },
    ];
  });
  const undo = await recordCompositionSource({
    ...removal(),
    trackedBranches: { joined: 'base', replaced: 'new' },
    compatibilitySymlinks: [],
    transition: recording().transition,
  });
  await updateWorkspaceWorktrees(sourceId, (rows) =>
    rows.map((row) =>
      row.id === moved.id
        ? {
            ...row,
            label: 'Later label',
            trackedRepoBaseBranches: {
              ...row.trackedRepoBaseBranches,
              joined: 'later',
              another: 'kept',
            },
          }
        : row,
    ),
  );
  await updateWorkspaceConfig(sourceId, (config) => {
    config.alwaysShow = true;
    config.repos.push({ id: 'concurrent', name: 'Later', repoPath: '/later' });
  });
  await undoCompositionSource(undo);
  await undoCompositionRepositories({
    source: 'existing_worktree_join',
    workspaceId: sourceId,
    repositories: [{ id: 'added', name: 'Added', repoPath: '/added' }],
  });
  expect((await readWorkspaceWorktrees(sourceId))[0]).toEqual({
    ...moved,
    label: 'Later label',
    trackedRepoBaseBranches: { ...oldBranch, joined: 'later', another: 'kept' },
  });
  expect(await readWorkspaceConfig(sourceId)).toMatchObject({
    alwaysShow: true,
    repos: [{ id: 'original' }, { id: 'concurrent' }],
  });
});
it.each(['missing', 'unreadable', 'partial'])(
  'refuses a %s list without writing or removing rows',
  async (state) => {
    const file = getWorkspaceWorktreesFilePath(destinationId);
    if (state !== 'missing') {
      await seed(destinationId, [other, { id: moved.id }]);
      if (state === 'unreadable') await writeFile(file, '{broken');
    }
    const before = await readFile(file, 'utf8').catch(() => undefined);
    await expect(recordJoinedWorktree(recording())).rejects.toMatchObject({
      reason: 'worktrees-unavailable',
    });
    await expect(
      removeCompositionWorktree(removal(destinationId)),
    ).rejects.toMatchObject({ reason: 'worktrees-unavailable' });
    expect(await readFile(file, 'utf8').catch(() => undefined)).toBe(before);
  },
);
it('undo of an extended reservation keeps the row and concurrent metadata', async () => {
  const reserved = {
    ...moved,
    label: 'Reserved',
    trackedRepoBaseBranches: { other: 'keep' },
  };
  await seed(destinationId, [reserved]);
  const destination = await recordJoinedWorktree(recording());
  if (!destination.undo) throw new Error('Expected reservation undo');
  await concurrentEdit(destinationId);
  await undoJoinedWorktree(destination.undo);
  expect(await readWorkspaceWorktrees(destinationId)).toEqual([
    { ...other, id: 'concurrent' },
    { ...reserved, label: 'Concurrent label' },
  ]);
});
it('refuses changed row identities and leaves later incarnations intact on restore', async () => {
  const newer = { ...moved, createdAt: '2026-10-02T00:00:00.000Z' };
  await seed(destinationId, [newer]);
  const before = await readFile(
    getWorkspaceWorktreesFilePath(destinationId),
    'utf8',
  );
  await expect(recordJoinedWorktree(recording())).rejects.toMatchObject({
    reason: 'identity-changed',
  });
  await expect(
    removeCompositionWorktree(removal(destinationId)),
  ).rejects.toMatchObject({ reason: 'identity-changed' });
  await expect(
    restoreCompositionWorktrees({
      source: 'existing_worktree_join',
      workspaceId: destinationId,
      rows: [moved],
    }),
  ).rejects.toMatchObject({ reason: 'identity-changed' });
  expect(
    await readFile(getWorkspaceWorktreesFilePath(destinationId), 'utf8'),
  ).toBe(before);
});
it('refuses invalid requests and a source row that no longer exists', async () => {
  await expect(
    recordJoinedWorktree({ ...recording(), workspaceId: '../escape' }),
  ).rejects.toMatchObject({ reason: 'invalid-request' });
  await seed(sourceId, []);
  await expect(
    recordCompositionSource({
      ...removal(),
      compatibilitySymlinks: [],
      transition: recording().transition,
    }),
  ).rejects.toMatchObject({ reason: 'not-found' });
});
it('creates the temporary manifest, list and index without changing another project', async () => {
  await createTemporaryCompositionRecords({
    source: 'temporary_workspace_create',
    workspace: temporary(),
  });
  await indexTemporaryCompositionWorkspace({
    source: 'temporary_workspace_create',
    workspace: temporary(),
  });
  expect(await readWorkspaceConfig(destinationId)).toMatchObject({
    temporary: true,
    temporarySourceWorkspaceIds: [sourceId],
    temporaryRepoIdentityKeys: ['path:repo'],
  });
  expect(await readWorkspaceWorktrees(destinationId)).toEqual([]);
  await expect(
    createTemporaryCompositionRecords({
      source: 'temporary_workspace_create',
      workspace: temporary(),
    }),
  ).rejects.toMatchObject({ reason: 'identity-changed' });
});
it('promotes only its own entry and composition fields, keeping a concurrent project and settings', async () => {
  await createTemporaryCompositionRecords({
    source: 'temporary_workspace_create',
    workspace: temporary(),
  });
  await indexTemporaryCompositionWorkspace({
    source: 'temporary_workspace_create',
    workspace: temporary(),
  });
  await updateWorkspaceConfig(destinationId, (config) => {
    config.alwaysShow = true;
    config.repos.push({ id: 'later', name: 'Later', repoPath: '/later' });
  });
  const listBefore = await readFile(
    getWorkspaceWorktreesFilePath(destinationId),
    'utf8',
  );
  await Promise.all([
    getWorkspaceIndexRepository().update(({ entries }) => ({
      result: undefined,
      entries: [
        ...entries,
        {
          id: 'concurrent',
          name: 'Concurrent',
          type: 'single-repo',
          color: '#654321',
          collapsed: false,
          order: entries.length,
        },
      ],
    })),
    promoteCompositionWorkspace({
      source: 'temporary_promote',
      workspaceId: destinationId,
      name: 'Permanent',
      sourceRepoPath: '/source',
    }),
  ]);
  expect(
    (await getWorkspaceIndexRepository().read()).entries.map(
      (entry) => entry.name,
    ),
  ).toEqual(['Permanent', 'Concurrent']);
  expect(await readWorkspaceConfig(destinationId)).toMatchObject({
    alwaysShow: true,
    sourceRepoPath: '/source',
    repos: [{ id: 'later' }],
  });
  expect(await json(getWorkspaceConfigPath(destinationId))).not.toHaveProperty(
    'temporary',
  );
  expect(
    await readFile(getWorkspaceWorktreesFilePath(destinationId), 'utf8'),
  ).toBe(listBefore);
  await cleanupCompositionDestination({
    source: 'workspace_combine',
    workspaceId: destinationId,
  });
  expect(
    (await getWorkspaceIndexRepository().read()).entries.map(
      (entry) => entry.id,
    ),
  ).toEqual(['concurrent']);
});
it('refuses unavailable manifests, an unreadable index and a non-temporary promotion without writes', async () => {
  await expect(
    undoCompositionRepositories({
      source: 'workspace_combine',
      workspaceId: sourceId,
      repositories: [],
    }),
  ).rejects.toMatchObject({ reason: 'not-found' });
  await createTemporaryCompositionRecords({
    source: 'temporary_workspace_create',
    workspace: temporary(),
  });
  await indexTemporaryCompositionWorkspace({
    source: 'temporary_workspace_create',
    workspace: temporary(),
  });
  const promotion = {
    source: 'temporary_promote' as const,
    workspaceId: destinationId,
    name: 'Permanent',
    sourceRepoPath: '/source',
  };
  const indexBefore = await readFile(getWorkspaceIndexFilePath(), 'utf8');
  const manifest = getWorkspaceConfigPath(destinationId);
  await writeFile(manifest, '{broken');
  await expect(promoteCompositionWorkspace(promotion)).rejects.toMatchObject({
    reason: 'configuration-unavailable',
  });
  expect(await readFile(manifest, 'utf8')).toBe('{broken');
  expect(await readFile(getWorkspaceIndexFilePath(), 'utf8')).toBe(indexBefore);
  await writeFile(
    manifest,
    JSON.stringify({ version: 1, type: 'multi-repo', repos: [] }),
  );
  await expect(promoteCompositionWorkspace(promotion)).rejects.toMatchObject({
    reason: 'not-temporary',
  });
  await writeFile(
    manifest,
    JSON.stringify({
      version: 1,
      type: 'multi-repo',
      repos: [],
      temporary: true,
    }),
  );
  const manifestBefore = await readFile(manifest, 'utf8');
  await writeFile(getWorkspaceIndexFilePath(), '{broken');
  await expect(promoteCompositionWorkspace(promotion)).rejects.toMatchObject({
    reason: 'index-unavailable',
  });
  expect(await readFile(manifest, 'utf8')).toBe(manifestBefore);
});
