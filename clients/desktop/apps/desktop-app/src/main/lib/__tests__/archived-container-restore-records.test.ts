import '../../../__tests__/worktree-replica-compatibility';
// CAN-3824: the destination worktree records of `core.archive.container.restore`.
// Runs the real workspace persistence module against a temporary data dir, so
// each record is checked through the persisted `worktrees.json`.
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
// The next list write waits for `mockGate`, so a test can start another
// writer while a record holds its read; `mockFailNextWrite` fails it instead.
let mockGate: Promise<void> | null = null;
let mockFailNextWrite = false;
jest.mock('../atomic-file', () => {
  const actual = jest.requireActual<typeof AtomicFile>('../atomic-file');
  return {
    ...actual,
    writeFileAtomically: async (
      ...args: Parameters<typeof actual.writeFileAtomically>
    ): Promise<void> => {
      const gate = mockGate;
      mockGate = null;
      if (gate) await gate;
      if (mockFailNextWrite) {
        mockFailNextWrite = false;
        throw new Error('disk full');
      }
      return actual.writeFileAtomically(...args);
    },
  };
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WorktreeData } from '@canopy/desktop-shared/types';
import { notifyPortalStructureChanged } from '../../portal/portal-event-bus';
import type * as AtomicFile from '../atomic-file';
import {
  recordRestoredWorktree,
  removeRestoredWorktreeRecord,
  RestoredWorktreeRecordRefusedError,
  type RestoredWorktreeRecord,
} from '../archived-container-restore-records';
import { getWorkspaceWorktreesFilePath } from '../paths';
import {
  clearWorktreesSelfWriteTracking,
  readWorkspaceWorktrees,
  removeWorkspaceWorktrees,
  updateWorkspaceWorktrees,
} from '../workspace-persistence';
import { updateWorktree } from '../worktree-update';

// Each test gets its own workspace: removals are remembered per process.
let WORKSPACE_ID = 'project';
let workspaceCount = 0;
const ARCHIVE_ID = 'archive-1';
const STAGED_AT = '2026-10-01T00:00:00.000Z';

function row(id: string, extra: Partial<WorktreeData> = {}): WorktreeData {
  return {
    id,
    branchName: `branch-${id}`,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...extra,
  };
}

function record(
  extra: Partial<RestoredWorktreeRecord['worktree']> = {},
): RestoredWorktreeRecord {
  return {
    source: 'archived_container_restore',
    workspaceId: WORKSPACE_ID,
    archiveId: ARCHIVE_ID,
    worktree: {
      id: 'recovery-1',
      branchName: 'feature/archived',
      createdAt: STAGED_AT,
      label: 'Archived work',
      ...extra,
    },
  };
}

const RECORDED_ROW: WorktreeData = {
  id: 'recovery-1',
  branchName: 'feature/archived',
  createdAt: STAGED_AT,
  label: 'Archived work',
  restoredFromFilesOnlyArchiveId: ARCHIVE_ID,
};

describe('archived container restore records (real fs)', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;
  let listPath: string;

  async function writeList(worktrees: unknown[], extra = {}): Promise<string> {
    await mkdir(path.dirname(listPath), { recursive: true });
    const contents = JSON.stringify(
      { version: 1, worktrees, ...extra },
      null,
      2,
    );
    await writeFile(listPath, contents);
    return contents;
  }

  async function ids(): Promise<string[]> {
    return (await readWorkspaceWorktrees(WORKSPACE_ID)).map(
      (worktree) => worktree.id,
    );
  }

  function holdNextWrite(): () => void {
    let release = (): void => {};
    mockGate = new Promise((resolve) => {
      release = resolve;
    });
    return release;
  }

  /** Lets queued filesystem work run, so a held writer reaches its gate. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  async function refusal(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => undefined,
      (caught: unknown) => caught,
    );
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    mockGate = null;
    mockFailNextWrite = false;
    workspaceCount += 1;
    WORKSPACE_ID = `project-${workspaceCount}`;
    clearWorktreesSelfWriteTracking(WORKSPACE_ID);
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-restore-records-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    listPath = getWorkspaceWorktreesFilePath(WORKSPACE_ID);
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('recordRestoredWorktree', () => {
    it('appends the staged destination row after the existing rows', async () => {
      await writeList([row('wt-1')]);

      await expect(
        recordRestoredWorktree(record({ includedRepoIds: ['repo-a'] })),
      ).resolves.toEqual({
        status: 'recorded',
        worktree: { ...RECORDED_ROW, includedRepoIds: ['repo-a'] },
      });

      expect(await readWorkspaceWorktrees(WORKSPACE_ID)).toEqual([
        row('wt-1'),
        { ...RECORDED_ROW, includedRepoIds: ['repo-a'] },
      ]);
      expect(notifyPortalStructureChanged).toHaveBeenCalled();
    });

    it('creates the list of a project that has none', async () => {
      await expect(recordRestoredWorktree(record())).resolves.toMatchObject({
        status: 'recorded',
      });

      expect(await readWorkspaceWorktrees(WORKSPACE_ID)).toEqual([
        RECORDED_ROW,
      ]);
    });

    it('keeps a row another writer creates while it holds its read', async () => {
      await writeList([row('wt-1')]);
      const release = holdNextWrite();

      const recording = recordRestoredWorktree(record());
      await settle();
      const creating = updateWorkspaceWorktrees(WORKSPACE_ID, (rows) => [
        row('wt-new'),
        ...rows,
      ]);
      await settle();
      release();
      await Promise.all([recording, creating]);

      expect(await ids()).toEqual(['wt-new', 'wt-1', 'recovery-1']);
    });

    it('reports a repeated record of the same incarnation without writing it again', async () => {
      await recordRestoredWorktree(record());
      await updateWorktree({
        workspaceId: WORKSPACE_ID,
        worktreeId: 'recovery-1',
        patch: { label: 'Renamed' },
      });
      const contents = await readFile(listPath, 'utf8');

      await expect(recordRestoredWorktree(record())).resolves.toEqual({
        status: 'already-recorded',
        worktree: { ...RECORDED_ROW, label: 'Renamed' },
      });

      expect(await readFile(listPath, 'utf8')).toBe(contents);
    });

    it('records one row when two restores of the same incarnation race', async () => {
      await writeList([row('wt-1')]);

      const outcomes = await Promise.all([
        recordRestoredWorktree(record()),
        recordRestoredWorktree(record()),
      ]);

      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
        'already-recorded',
        'recorded',
      ]);
      expect(await ids()).toEqual(['wt-1', 'recovery-1']);
    });

    it('refuses a row of another incarnation with the same id and keeps it', async () => {
      const contents = await writeList([
        row('recovery-1', { createdAt: '2026-10-05T00:00:00.000Z' }),
      ]);

      const error = await refusal(recordRestoredWorktree(record()));

      expect(error).toBeInstanceOf(RestoredWorktreeRecordRefusedError);
      expect(error).toMatchObject({
        reason: 'identity-changed',
        message:
          'Staged recovery worktree recovery-1 no longer matches its destination identity; the archived container was preserved.',
      });
      expect(await readFile(listPath, 'utf8')).toBe(contents);
    });

    it('refuses a destination archived in this process instead of reporting it recorded', async () => {
      await recordRestoredWorktree(record());
      await removeWorkspaceWorktrees(
        WORKSPACE_ID,
        (worktree) => worktree.id === 'recovery-1',
      );

      const error = await refusal(recordRestoredWorktree(record()));

      expect(error).toBeInstanceOf(RestoredWorktreeRecordRefusedError);
      expect(error).toMatchObject({ reason: 'destination-removed' });
      expect(await ids()).toEqual([]);
    });

    it.each([
      ['unreadable', '{"version": 1, "worktrees": ['],
      [
        'partially readable',
        JSON.stringify({
          version: 1,
          worktrees: [row('wt-1'), { id: 'recovery-1' }],
        }),
      ],
    ])('never writes an %s list', async (_label, contents) => {
      await mkdir(path.dirname(listPath), { recursive: true });
      await writeFile(listPath, contents);

      const error = await refusal(recordRestoredWorktree(record()));

      expect(error).toBeInstanceOf(RestoredWorktreeRecordRefusedError);
      expect(error).toMatchObject({ reason: 'worktrees-unavailable' });
      expect(await readFile(listPath, 'utf8')).toBe(contents);
    });

    it('keeps the list when its write fails and records on retry', async () => {
      const contents = await writeList([row('wt-1')], { futureFileKey: true });
      mockFailNextWrite = true;

      await expect(recordRestoredWorktree(record())).rejects.toThrow(
        'disk full',
      );
      expect(await readFile(listPath, 'utf8')).toBe(contents);

      await expect(recordRestoredWorktree(record())).resolves.toMatchObject({
        status: 'recorded',
      });
      expect(await ids()).toEqual(['wt-1', 'recovery-1']);
      expect(JSON.parse(await readFile(listPath, 'utf8'))).toMatchObject({
        futureFileKey: true,
      });
    });

    it.each<[string, () => RestoredWorktreeRecord]>([
      [
        'workspace id',
        (): RestoredWorktreeRecord => ({
          ...record(),
          workspaceId: '../escape',
        }),
      ],
      [
        'worktree id',
        (): RestoredWorktreeRecord => record({ id: '../escape' }),
      ],
      ['createdAt', (): RestoredWorktreeRecord => record({ createdAt: '' })],
      [
        'branch name',
        (): RestoredWorktreeRecord => record({ branchName: ' ' }),
      ],
      [
        'archive id',
        (): RestoredWorktreeRecord => ({ ...record(), archiveId: '' }),
      ],
      [
        'source',
        (): RestoredWorktreeRecord => {
          const untrusted = record();
          Reflect.set(untrusted, 'source', 'renderer');
          return untrusted;
        },
      ],
    ])(
      'refuses an invalid %s before reading the list',
      async (_label, make) => {
        const error = await refusal(recordRestoredWorktree(make()));

        expect(error).toBeInstanceOf(RestoredWorktreeRecordRefusedError);
        expect(error).toMatchObject({ reason: 'invalid-request' });
        await expect(readFile(listPath, 'utf8')).rejects.toMatchObject({
          code: 'ENOENT',
        });
      },
    );
  });

  describe('removeRestoredWorktreeRecord', () => {
    function removal(
      createdAt = STAGED_AT,
    ): Parameters<typeof removeRestoredWorktreeRecord>[0] {
      return {
        source: 'archived_container_restore',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'recovery-1',
        createdAt,
      };
    }

    it('removes only the incarnation the restore recorded', async () => {
      await writeList([row('wt-1'), RECORDED_ROW, row('wt-2')]);

      await expect(removeRestoredWorktreeRecord(removal())).resolves.toEqual({
        status: 'removed',
      });

      expect(await ids()).toEqual(['wt-1', 'wt-2']);
    });

    it('keeps a row and a field other writers commit while it holds its read', async () => {
      await writeList([row('wt-1'), RECORDED_ROW]);
      const release = holdNextWrite();

      const removing = removeRestoredWorktreeRecord(removal());
      await settle();
      const creating = updateWorkspaceWorktrees(WORKSPACE_ID, (rows) => [
        row('wt-new'),
        ...rows,
      ]);
      const labelling = updateWorktree({
        workspaceId: WORKSPACE_ID,
        worktreeId: 'wt-1',
        patch: { label: 'Renamed' },
      });
      await settle();
      release();
      await Promise.all([removing, creating, labelling]);

      expect(await readWorkspaceWorktrees(WORKSPACE_ID)).toEqual([
        row('wt-new'),
        row('wt-1', { label: 'Renamed' }),
      ]);
    });

    it('leaves a row of another incarnation and the list untouched', async () => {
      const contents = await writeList([
        row('recovery-1', { createdAt: '2026-10-05T00:00:00.000Z' }),
      ]);

      await expect(removeRestoredWorktreeRecord(removal())).resolves.toEqual({
        status: 'not-found',
      });

      expect(await readFile(listPath, 'utf8')).toBe(contents);
    });

    it('creates no list for a destination that was never recorded', async () => {
      await expect(removeRestoredWorktreeRecord(removal())).resolves.toEqual({
        status: 'not-found',
      });

      await expect(readFile(listPath, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('refuses a removal without the recorded createdAt before reading', async () => {
      const contents = await writeList([RECORDED_ROW]);

      const error = await refusal(removeRestoredWorktreeRecord(removal('')));

      expect(error).toBeInstanceOf(RestoredWorktreeRecordRefusedError);
      expect(error).toMatchObject({ reason: 'invalid-request' });
      expect(await readFile(listPath, 'utf8')).toBe(contents);
    });
  });
});
