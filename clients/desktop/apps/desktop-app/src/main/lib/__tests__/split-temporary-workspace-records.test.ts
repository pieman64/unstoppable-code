import '../../../__tests__/worktree-replica-compatibility';
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({ recordAppDiagnostic: jest.fn() })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  WorktreeData,
  WorkspaceIndexEntry,
} from '@canopy/desktop-shared/types';
import {
  getWorkspaceDir,
  getWorkspaceWorktreesFilePath,
  getWorkspaceIndexFilePath,
} from '../paths';
import {
  type SplitRecordIdentity,
  recordSplitArchiveDestination,
  reserveSplitDestinationRecord,
  removeSplitDestinationRecord,
  markSplitRecoveryRecord,
  promoteSplitDestinationRecord,
  removeSplitCreatedWorkspace,
} from '../split-temporary-workspace-records';
import {
  updateWorkspaceWorktrees,
  readWorkspaceWorktrees,
  removeWorkspaceWorktrees,
} from '../workspace-persistence';

const createdAt = '2026-10-01T00:00:00.000Z';
function row(id: string, extra: Partial<WorktreeData> = {}): WorktreeData {
  return { id, createdAt, branchName: id, ...extra };
}
let dataDir: string;
let originalDataDir: string | undefined;
let counter = 0;
let workspaceId: string;
async function seed(id: string, rows: unknown[]): Promise<void> {
  const file = getWorkspaceWorktreesFilePath(id);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({ version: 1, worktrees: rows, futureFile: true }),
  );
}
beforeEach(async () => {
  originalDataDir = process.env.CANOPY_DATA_DIR;
  dataDir = await mkdtemp(join(tmpdir(), 'canopy-split-records-'));
  process.env.CANOPY_DATA_DIR = dataDir;
  workspaceId = `destination-${++counter}`;
});
afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

it('keeps fields and rows written after the archive reservation', async () => {
  const sourceId = `${workspaceId}-source`;
  await seed(sourceId, [row('source-worktree'), row('source-existing')]);
  await seed(workspaceId, [
    {
      ...row('reserved', {
        hidden: true,
        setupPhase: 'git-pending',
        splitRecoveryRequired: true,
      }),
      futureRow: 'retained',
    },
  ]);
  await updateWorkspaceWorktrees(workspaceId, (rows) => [
    ...rows.map((entry) => ({
      ...entry,
      pinned: true,
      label: 'Concurrent label',
    })),
    row('concurrent'),
  ]);
  await updateWorkspaceWorktrees(sourceId, (rows) => [
    ...rows.map((entry) =>
      entry.id === 'source-existing' ? { ...entry, pinned: true } : entry,
    ),
    row('source-concurrent'),
  ]);
  await recordSplitArchiveDestination({
    source: 'temporary_split',
    workspaceId,
    worktree: row('reserved', { branchName: 'moved' }),
  });
  // Source teardown still removes its row through the existing archive writer.
  await removeWorkspaceWorktrees(
    sourceId,
    (entry) => entry.id === 'source-worktree',
  );
  expect(await readWorkspaceWorktrees(sourceId)).toEqual([
    row('source-existing', { pinned: true }),
    row('source-concurrent'),
  ]);
  expect(await readWorkspaceWorktrees(workspaceId)).toEqual([
    {
      ...row('reserved', {
        branchName: 'moved',
        pinned: true,
        label: 'Concurrent label',
      }),
      futureRow: 'retained',
    },
    row('concurrent'),
  ]);
  expect(
    await readFile(getWorkspaceWorktreesFilePath(workspaceId), 'utf8'),
  ).toContain('futureFile');
  expect(
    await readFile(getWorkspaceWorktreesFilePath(workspaceId), 'utf8'),
  ).toContain('futureRow');
});

function identity(worktreeId = 'reserved'): SplitRecordIdentity {
  return {
    source: 'temporary_split' as const,
    workspaceId,
    worktreeId,
    createdAt,
  };
}

it('rolls back only its own reservation after a destination failure', async () => {
  const otherWorkspace = `${workspaceId}-other`;
  await seed(workspaceId, [row('existing')]);
  await seed(otherWorkspace, []);
  await reserveSplitDestinationRecord({
    source: 'temporary_split',
    workspaceId,
    worktree: row('reserved', {
      setupPhase: 'git-pending',
      splitRecoveryRequired: true,
    }),
  });
  await writeFile(getWorkspaceWorktreesFilePath(otherWorkspace), 'unreadable');
  await expect(
    reserveSplitDestinationRecord({
      source: 'temporary_split',
      workspaceId: otherWorkspace,
      worktree: row('reserved'),
    }),
  ).rejects.toMatchObject({ reason: 'worktrees-unavailable' });
  await updateWorkspaceWorktrees(workspaceId, (rows) => [
    ...rows.map((entry) =>
      entry.id === 'existing' ? { ...entry, pinned: true } : entry,
    ),
    row('concurrent'),
  ]);
  await removeSplitDestinationRecord(identity());
  expect(await readWorkspaceWorktrees(workspaceId)).toEqual([
    row('existing', { pinned: true }),
    row('concurrent'),
  ]);
  // A replacement incarnation is never removed by the original split.
  await updateWorkspaceWorktrees(workspaceId, (rows) => [
    ...rows,
    row('reserved', { createdAt: '2026-10-02T00:00:00.000Z' }),
  ]);
  await removeSplitDestinationRecord(identity());
  expect(
    (await readWorkspaceWorktrees(workspaceId)).map((entry) => entry.id),
  ).toEqual(['existing', 'concurrent', 'reserved']);
});

it('retries partial destination promotion without duplicate or lost membership', async () => {
  const secondWorkspace = `${workspaceId}-second`;
  for (const id of [workspaceId, secondWorkspace]) {
    await seed(id, [row('existing')]);
    await reserveSplitDestinationRecord({
      source: 'temporary_split',
      workspaceId: id,
      worktree: row('reserved', {
        setupPhase: 'git-pending',
        splitRecoveryRequired: true,
      }),
    });
  }
  await promoteSplitDestinationRecord({ ...identity(), branchName: 'moved' });
  const contents = await readFile(
    getWorkspaceWorktreesFilePath(secondWorkspace),
    'utf8',
  );
  await writeFile(getWorkspaceWorktreesFilePath(secondWorkspace), 'unreadable');
  await expect(
    promoteSplitDestinationRecord({
      ...identity(),
      workspaceId: secondWorkspace,
      branchName: 'moved',
    }),
  ).rejects.toMatchObject({ reason: 'worktrees-unavailable' });
  await writeFile(getWorkspaceWorktreesFilePath(secondWorkspace), contents);
  for (const id of [workspaceId, secondWorkspace]) {
    await reserveSplitDestinationRecord({
      source: 'temporary_split',
      workspaceId: id,
      worktree: row('reserved'),
    });
    await promoteSplitDestinationRecord({
      ...identity(),
      workspaceId: id,
      branchName: 'moved',
    });
    expect(await readWorkspaceWorktrees(id)).toEqual([
      row('existing'),
      row('reserved', { branchName: 'moved', setupPhase: 'git-ready' }),
    ]);
  }
});

it('marks retained recovery fields and clears them on promotion without resetting other fields', async () => {
  const transitionFields: Partial<WorktreeData> = {
    compatibilitySymlinks: [
      {
        path: '/old',
        targetPath: '/new',
        reason: 'adhoc-multi-repo-transition',
        sourceWorkspaceId: 'source',
        sourceWorktreeId: 'source-wt',
        createdAt,
      },
    ],
    adhocTransitionSource: {
      sourceWorkspaceId: 'source',
      sourceWorktreeId: 'source-wt',
      sourceRepoIds: ['repo'],
      createdAt,
    },
  };
  await seed(workspaceId, [
    row('reserved', {
      hidden: true,
      pinned: true,
      setupPhase: 'git-pending',
      ...transitionFields,
    }),
  ]);
  const healthIssue = {
    status: 'broken' as const,
    code: 'git-error' as const,
    message: 'retained',
    checkedAt: createdAt,
    worktreePath: '/checkout',
    gitError: 'failed',
  };
  await markSplitRecoveryRecord({
    ...identity(),
    fallbackWorktree: row('reserved'),
    healthIssue,
  });
  expect((await readWorkspaceWorktrees(workspaceId))[0]).toMatchObject({
    splitRecoveryRequired: true,
    healthIssue,
    pinned: true,
  });
  expect((await readWorkspaceWorktrees(workspaceId))[0]).not.toHaveProperty(
    'hidden',
  );
  await promoteSplitDestinationRecord({ ...identity(), branchName: 'moved' });
  expect((await readWorkspaceWorktrees(workspaceId))[0]).not.toHaveProperty(
    'splitRecoveryRequired',
  );
  expect((await readWorkspaceWorktrees(workspaceId))[0]).toMatchObject({
    pinned: true,
    ...transitionFields,
  });
  await markSplitRecoveryRecord({
    ...identity('fallback'),
    fallbackWorktree: row('fallback'),
    healthIssue,
  });
  expect(
    (await readWorkspaceWorktrees(workspaceId)).map((entry) => entry.id),
  ).toEqual(['reserved', 'fallback']);
});

it.each(['absent', 'unreadable', 'partial'])(
  'refuses a %s list without writing',
  async (state) => {
    const file = getWorkspaceWorktreesFilePath(workspaceId);
    await mkdir(dirname(file), { recursive: true });
    if (state === 'unreadable') await writeFile(file, 'unreadable');
    if (state === 'partial') await seed(workspaceId, [{ id: 'unknown' }]);
    const before = await readFile(file, 'utf8').catch(() => null);
    await expect(
      reserveSplitDestinationRecord({
        source: 'temporary_split',
        workspaceId,
        worktree: row('reserved'),
      }),
    ).rejects.toMatchObject({ reason: 'worktrees-unavailable' });
    await expect(
      removeSplitDestinationRecord(identity()),
    ).rejects.toMatchObject({ reason: 'worktrees-unavailable' });
    expect(await readFile(file, 'utf8').catch(() => null)).toBe(before);
  },
);

it('refuses invalid requests, changed identities and vanished promotion reservations', async () => {
  await seed(workspaceId, [row('reserved', { createdAt: 'replacement' })]);
  await expect(
    removeSplitDestinationRecord({ ...identity(), workspaceId: '../invalid' }),
  ).rejects.toMatchObject({ reason: 'invalid-request' });
  await expect(
    reserveSplitDestinationRecord({
      source: 'temporary_split',
      workspaceId,
      worktree: row('reserved'),
    }),
  ).rejects.toMatchObject({
    reason: 'identity-changed',
    message: 'Destination worktree id "reserved" is already reserved.',
  });
  await expect(
    promoteSplitDestinationRecord({
      ...identity('missing'),
      branchName: 'moved',
    }),
  ).rejects.toMatchObject({ reason: 'not-found' });
  expect(await readWorkspaceWorktrees(workspaceId)).toEqual([
    row('reserved', { createdAt: 'replacement' }),
  ]);
  await removeWorkspaceWorktrees(
    workspaceId,
    (entry) => entry.id === 'reserved',
  );
  const before = await readFile(
    getWorkspaceWorktreesFilePath(workspaceId),
    'utf8',
  );
  await expect(
    reserveSplitDestinationRecord({
      source: 'temporary_split',
      workspaceId,
      worktree: row('reserved', { createdAt: 'replacement' }),
    }),
  ).rejects.toMatchObject({ reason: 'not-found' });
  expect(
    await readFile(getWorkspaceWorktreesFilePath(workspaceId), 'utf8'),
  ).toBe(before);
});

it('cleanup removes only its own entry and keeps a concurrently created project', async () => {
  await seed(workspaceId, [row('reserved')]);
  await removeSplitDestinationRecord(identity());
  // An older sidebar snapshot can still put a tombstoned row on disk.
  await seed(workspaceId, [row('reserved')]);
  const indexFile = getWorkspaceIndexFilePath();
  const entry = (id: string): WorkspaceIndexEntry => ({
    id,
    name: id,
    type: 'single-repo',
    color: '#fff',
    collapsed: false,
    order: 0,
  });
  await writeFile(
    indexFile,
    JSON.stringify({
      version: 1,
      workspaces: [entry(workspaceId)],
      futureIndex: true,
    }),
  );
  await expect(
    removeSplitCreatedWorkspace({
      source: 'temporary_split',
      workspaceId,
      worktreeIds: [],
      containsRollbackData: async () => {
        // Runs after the split has entered its cleanup decision.
        const { getWorkspaceIndexRepository } =
          await import('../sidebar-items');
        await getWorkspaceIndexRepository().update(({ entries }) => ({
          result: undefined,
          entries: [...entries, entry('concurrent-project')],
        }));
        return false;
      },
    }),
  ).resolves.toBe(true);
  expect(await readFile(indexFile, 'utf8')).toContain('concurrent-project');
  expect(await readFile(indexFile, 'utf8')).not.toContain(workspaceId);
  expect(await readFile(indexFile, 'utf8')).toContain('futureIndex');
  await expect(
    readFile(join(getWorkspaceDir(workspaceId), 'worktrees.json')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

it('cleanup refuses an unreadable index before removing files and preserves a populated list', async () => {
  await seed(workspaceId, [row('concurrent')]);
  const request = {
    source: 'temporary_split' as const,
    workspaceId,
    worktreeIds: [],
    containsRollbackData: (): Promise<boolean> => Promise.resolve(false),
  };
  await expect(removeSplitCreatedWorkspace(request)).resolves.toBe(false);
  await seed(workspaceId, []);
  await writeFile(getWorkspaceIndexFilePath(), 'unreadable');
  await expect(removeSplitCreatedWorkspace(request)).rejects.toMatchObject({
    reason: 'index-unavailable',
  });
  expect(await readWorkspaceWorktrees(workspaceId)).toEqual([]);
  expect(await readFile(getWorkspaceIndexFilePath(), 'utf8')).toBe(
    'unreadable',
  );
});
