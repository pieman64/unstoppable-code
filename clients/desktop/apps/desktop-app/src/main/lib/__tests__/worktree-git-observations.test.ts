import '../../../__tests__/worktree-replica-compatibility';
// CAN-3820: the W5 Git and pull-request observations of the worktree list
// (`internal.worktree.git.observe`). Runs the real workspace persistence
// module against a temporary data dir, so each observation is checked through
// the persisted `worktrees.json`.
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
// writer while an observation holds its read; `mockFailNextWrite` fails it
// instead.
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

import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  WORKSPACE_ROOT_REPO_ID,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import type { WorktreePrStatus } from '@canopy/desktop-shared/types/github';
import type * as AtomicFile from '../atomic-file';
import { getWorkspaceWorktreesFilePath } from '../paths';
import {
  clearWorktreesSelfWriteTracking,
  readWorkspaceWorktrees,
  removeWorkspaceWorktrees,
  updateWorkspaceWorktrees,
  writeWorkspaceWorktrees,
} from '../workspace-persistence';
import {
  observeWorktreeGit,
  type WorktreeRowGitObservation,
} from '../worktree-git-observations';
import type { WorktreeRecordOutcome } from '../worktree-repair';
import { updateWorktree } from '../worktree-update';

// Each test gets its own workspace: removals are remembered per process.
let WORKSPACE_ID = 'project';
let workspaceCount = 0;
const CREATED_AT = '2026-10-01T00:00:00.000Z';

function row(id: string, extra: Partial<WorktreeData> = {}): WorktreeData {
  return {
    id,
    branchName: `branch-${id}`,
    createdAt: CREATED_AT,
    ...extra,
  };
}

function prStatus(state: 'open' | 'merged' | 'closed'): WorktreePrStatus {
  return {
    lastCheckedAt: '2026-10-02T00:00:00.000Z',
    repos: [
      {
        repoId: 'repo',
        repoName: 'repo',
        prLookupAvailable: true,
        status: {
          prNumber: 7,
          prUrl: 'https://github.com/acme/repo/pull/7',
          state,
          title: 'Change',
          checkStatus: 'passing',
          checkDetails: [],
          reviewStatus: 'approved',
          reviewers: [],
          hasConflicts: false,
          commentCount: 0,
          updatedAt: '2026-10-02T00:00:00.000Z',
          baseRefName: 'main',
        },
      },
    ],
  };
}

/** One row observation of each kind, all on `wt-1`. */
const ROW_OBSERVATIONS: [string, () => WorktreeRowGitObservation][] = [
  [
    'HEAD branch',
    (): WorktreeRowGitObservation => ({
      kind: 'branch',
      workspaceId: WORKSPACE_ID,
      worktreeId: 'wt-1',
      branchName: 'feature/checked-out',
    }),
  ],
  [
    'PR status',
    (): WorktreeRowGitObservation => ({
      kind: 'pr-status',
      workspaceId: WORKSPACE_ID,
      worktreeId: 'wt-1',
      status: prStatus('open'),
    }),
  ],
  [
    'split child grouping',
    (): WorktreeRowGitObservation => ({
      kind: 'split-child-grouping',
      workspaceId: WORKSPACE_ID,
      worktreeId: 'wt-1',
    }),
  ],
  [
    'split original retarget',
    (): WorktreeRowGitObservation => ({
      kind: 'split-original-retarget',
      workspaceId: WORKSPACE_ID,
      worktreeId: 'wt-1',
      branchName: 'split/integration',
      trackedBaseBranch: 'main',
    }),
  ],
];

describe('worktree Git observations (real fs)', () => {
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

  async function readRow(id: string): Promise<WorktreeData | undefined> {
    const worktrees = await readWorkspaceWorktrees(WORKSPACE_ID);
    return worktrees.find((worktree) => worktree.id === id);
  }

  async function readDocument(): Promise<unknown> {
    return JSON.parse(await readFile(listPath, 'utf8'));
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

  function observeRow(
    observation: WorktreeRowGitObservation,
  ): Promise<WorktreeRecordOutcome> {
    return observeWorktreeGit(observation);
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    mockGate = null;
    mockFailNextWrite = false;
    workspaceCount += 1;
    WORKSPACE_ID = `project-${workspaceCount}`;
    clearWorktreesSelfWriteTracking(WORKSPACE_ID);
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-git-observe-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    listPath = getWorkspaceWorktreesFilePath(WORKSPACE_ID);
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('every row observation', () => {
    it.each(ROW_OBSERVATIONS)(
      '%s keeps a row another writer creates while it holds its read',
      async (_label, observation) => {
        await writeList([row('wt-1')]);
        const release = holdNextWrite();

        const observing = observeRow(observation());
        await settle();
        const creating = updateWorkspaceWorktrees(WORKSPACE_ID, (rows) => [
          row('wt-new'),
          ...rows,
        ]);
        await settle();
        release();
        await Promise.all([observing, creating]);

        const ids = (await readWorkspaceWorktrees(WORKSPACE_ID)).map(
          (worktree) => worktree.id,
        );
        expect(ids).toEqual(['wt-new', 'wt-1']);
      },
    );

    it.each(ROW_OBSERVATIONS)(
      '%s keeps a field another writer sets on the same row meanwhile',
      async (_label, observation) => {
        await writeList([row('wt-1')]);
        const release = holdNextWrite();

        const observing = observeRow(observation());
        await settle();
        const labelling = updateWorktree({
          workspaceId: WORKSPACE_ID,
          worktreeId: 'wt-1',
          patch: { label: 'Renamed', pinned: true },
        });
        await settle();
        release();
        const [outcome] = await Promise.all([observing, labelling]);

        expect(outcome.status).toBe('recorded');
        expect(await readRow('wt-1')).toMatchObject({
          ...outcome.worktree,
          label: 'Renamed',
          pinned: true,
        });
      },
    );

    it.each(ROW_OBSERVATIONS)(
      '%s and an independent observation of the same row both land',
      async (_label, observation) => {
        await writeList([row('wt-1')]);
        const release = holdNextWrite();

        const observing = observeRow(observation());
        await settle();
        // Another observer writes fields this observation does not own.
        const other =
          observation().kind === 'split-child-grouping'
            ? observeRow({
                kind: 'pr-status',
                workspaceId: WORKSPACE_ID,
                worktreeId: 'wt-1',
                status: prStatus('merged'),
              })
            : observeRow({
                kind: 'split-child-grouping',
                workspaceId: WORKSPACE_ID,
                worktreeId: 'wt-1',
              });
        await settle();
        release();
        const [first, second] = await Promise.all([observing, other]);

        expect(first.status).toBe('recorded');
        expect(second.status).toBe('recorded');
        expect(await readRow('wt-1')).toEqual(second.worktree);
        expect(second.worktree).toMatchObject({ ...first.worktree });
      },
    );

    it.each(ROW_OBSERVATIONS)(
      '%s never writes an unreadable list',
      async (_label, observation) => {
        await mkdir(path.dirname(listPath), { recursive: true });
        await writeFile(listPath, '{"version": 1, "worktrees": [');

        await expect(observeRow(observation())).resolves.toEqual({
          status: 'not-found',
          worktree: null,
        });

        expect(await readFile(listPath, 'utf8')).toBe(
          '{"version": 1, "worktrees": [',
        );
      },
    );

    it.each(ROW_OBSERVATIONS)(
      '%s creates no list for a workspace without one',
      async (_label, observation) => {
        await expect(observeRow(observation())).resolves.toEqual({
          status: 'not-found',
          worktree: null,
        });

        await expect(readdir(dataDir)).resolves.toEqual([]);
      },
    );

    it.each(ROW_OBSERVATIONS)(
      '%s leaves the list unchanged for a worktree that disappeared',
      async (_label, observation) => {
        const contents = await writeList([row('wt-2')]);

        await expect(observeRow(observation())).resolves.toEqual({
          status: 'not-found',
          worktree: null,
        });

        expect(await readFile(listPath, 'utf8')).toBe(contents);
      },
    );

    it.each(ROW_OBSERVATIONS)(
      '%s does not bring back a row archived in this process',
      async (_label, observation) => {
        await writeList([row('wt-1')]);
        await removeWorkspaceWorktrees(
          WORKSPACE_ID,
          (worktree) => worktree.id === 'wt-1',
        );

        await expect(observeRow(observation())).resolves.toMatchObject({
          status: 'not-found',
        });

        expect(await readDocument()).toEqual({ version: 1, worktrees: [] });
      },
    );

    it.each(ROW_OBSERVATIONS)(
      '%s keeps every row and field when its write fails, and applies on retry',
      async (_label, observation) => {
        const contents = await writeList(
          [
            { ...row('wt-1', { label: 'One' }), future: 1 },
            row('wt-2', { trackedBaseBranch: 'develop' }),
            { id: 'wt-unreadable' },
          ],
          { futureFileKey: true },
        );
        mockFailNextWrite = true;

        await expect(observeRow(observation())).rejects.toThrow('disk full');
        expect(await readFile(listPath, 'utf8')).toBe(contents);

        // A restart reads the file the failed write left.
        clearWorktreesSelfWriteTracking(WORKSPACE_ID);
        const outcome = await observeRow(observation());
        expect(outcome.status).toBe('recorded');
        expect(await readDocument()).toEqual({
          version: 1,
          futureFileKey: true,
          worktrees: [
            { ...outcome.worktree, future: 1 },
            row('wt-2', { trackedBaseBranch: 'develop' }),
            { id: 'wt-unreadable' },
          ],
        });
        expect(outcome.worktree).toMatchObject({ label: 'One' });
      },
    );

    it.each(ROW_OBSERVATIONS)(
      '%s writes nothing when the row already holds the observation',
      async (_label, observation) => {
        await writeList([row('wt-1')]);
        const first = await observeRow(observation());
        const contents = await readFile(listPath, 'utf8');
        mockFailNextWrite = true;

        const second = await observeRow(observation());

        expect(second).toEqual({
          status: 'unchanged',
          worktree: first.worktree,
        });
        expect(await readFile(listPath, 'utf8')).toBe(contents);
        mockFailNextWrite = false;
      },
    );

    it.each([
      ['an invalid workspace id', 'Not A Workspace', 'wt-1'],
      ['an invalid worktree id', 'project', '../wt-1'],
    ])('refuses %s before reading the list', async (_label, ws, wt) => {
      const contents = await writeList([row('wt-1')]);

      for (const [, observation] of ROW_OBSERVATIONS) {
        await expect(
          observeRow({ ...observation(), workspaceId: ws, worktreeId: wt }),
        ).rejects.toMatchObject({
          name: 'WorktreeRecordRefusedError',
          reason: 'invalid-request',
        });
      }
      expect(await readFile(listPath, 'utf8')).toBe(contents);
    });
  });

  describe('HEAD branch observation', () => {
    it('stores the root branch and clears the PR status of the old branch', async () => {
      await writeList([
        row('wt-1', { lastKnownPrStatus: prStatus('merged'), status: 'done' }),
      ]);

      const outcome = await observeRow({
        kind: 'branch',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'wt-1',
        repoId: WORKSPACE_ROOT_REPO_ID,
        branchName: 'feature/next',
      });

      expect(outcome.status).toBe('recorded');
      expect(await readRow('wt-1')).toEqual(
        row('wt-1', { branchName: 'feature/next', lastKnownPrStatus: null }),
      );
    });

    it('keeps the sidebar branch for a member repository change', async () => {
      await writeList([row('wt-1', { lastKnownPrStatus: prStatus('open') })]);

      await observeRow({
        kind: 'branch',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'wt-1',
        repoId: 'repo-b',
        branchName: 'feature/member',
      });

      expect(await readRow('wt-1')).toEqual(
        row('wt-1', { lastKnownPrStatus: null }),
      );
    });

    it('refuses a blank branch name or an invalid repository id', async () => {
      const contents = await writeList([row('wt-1')]);

      await expect(
        observeRow({
          kind: 'branch',
          workspaceId: WORKSPACE_ID,
          worktreeId: 'wt-1',
          branchName: ' ',
        }),
      ).rejects.toMatchObject({ reason: 'invalid-request' });
      await expect(
        observeRow({
          kind: 'branch',
          workspaceId: WORKSPACE_ID,
          worktreeId: 'wt-1',
          repoId: '../repo',
          branchName: 'feature',
        }),
      ).rejects.toMatchObject({ reason: 'invalid-request' });
      expect(await readFile(listPath, 'utf8')).toBe(contents);
    });
  });

  describe('PR status observation', () => {
    it('marks the worktree done when every known PR merged', async () => {
      await writeList([row('wt-1')]);

      await observeRow({
        kind: 'pr-status',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'wt-1',
        status: prStatus('merged'),
      });

      expect(await readRow('wt-1')).toEqual(
        row('wt-1', { lastKnownPrStatus: prStatus('merged'), status: 'done' }),
      );
    });

    it('clears done when an open PR appears and keeps it otherwise', async () => {
      await writeList([row('wt-1', { status: 'done' })]);

      await observeRow({
        kind: 'pr-status',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'wt-1',
        status: null,
      });
      expect(await readRow('wt-1')).toEqual(
        row('wt-1', { status: 'done', lastKnownPrStatus: null }),
      );

      await observeRow({
        kind: 'pr-status',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'wt-1',
        status: prStatus('open'),
      });
      expect(await readRow('wt-1')).toEqual(
        row('wt-1', { lastKnownPrStatus: prStatus('open') }),
      );
    });

    it('does not rewrite an equivalent status that only has a newer check time', async () => {
      await writeList([row('wt-1', { lastKnownPrStatus: prStatus('open') })]);
      const contents = await readFile(listPath, 'utf8');

      const outcome = await observeRow({
        kind: 'pr-status',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'wt-1',
        status: {
          ...prStatus('open'),
          lastCheckedAt: '2026-10-09T00:00:00.000Z',
        },
      });

      expect(outcome.status).toBe('unchanged');
      expect(await readFile(listPath, 'utf8')).toBe(contents);
    });

    it('refuses a malformed status', async () => {
      const contents = await writeList([row('wt-1')]);

      await expect(
        observeWorktreeGit({
          kind: 'pr-status',
          workspaceId: WORKSPACE_ID,
          worktreeId: 'wt-1',
          // A status without repos, as untyped data can carry.
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- deliberately untyped input
          status: JSON.parse('{"lastCheckedAt": "now"}'),
        }),
      ).rejects.toMatchObject({ reason: 'invalid-request' });
      expect(await readFile(listPath, 'utf8')).toBe(contents);
    });
  });

  describe('PR splitter observations', () => {
    it('groups a split child without touching its bases', async () => {
      await writeList([row('wt-1', { trackedBaseBranch: 'split/base' })]);

      await observeRow({
        kind: 'split-child-grouping',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'wt-1',
      });

      expect(await readRow('wt-1')).toEqual(
        row('wt-1', {
          trackedBaseBranch: 'split/base',
          branchGroupingOverride: 'group',
        }),
      );
    });

    it('moves the original worktree to the integration branch and base', async () => {
      await writeList([
        row('wt-1', {
          trackedBaseBranch: 'develop',
          branchGroupingParentWorktreeId: 'parent',
        }),
      ]);

      await observeRow({
        kind: 'split-original-retarget',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'wt-1',
        branchName: 'split/integration',
        trackedBaseBranch: 'main',
      });

      expect(await readRow('wt-1')).toEqual(
        row('wt-1', {
          branchName: 'split/integration',
          trackedBaseBranch: 'main',
          branchGroupingParentWorktreeId: 'parent',
        }),
      );
    });

    it('refuses a retarget without a branch or base', async () => {
      const contents = await writeList([row('wt-1')]);

      await expect(
        observeRow({
          kind: 'split-original-retarget',
          workspaceId: WORKSPACE_ID,
          worktreeId: 'wt-1',
          branchName: 'split/integration',
          trackedBaseBranch: '',
        }),
      ).rejects.toMatchObject({ reason: 'invalid-request' });
      expect(await readFile(listPath, 'utf8')).toBe(contents);
    });
  });

  describe('merged PR base retarget', () => {
    it('retargets the scalar and per-repository bases that tracked the merged branch', async () => {
      await writeList([
        row('wt-merged', { trackedBaseBranch: 'feature/merged' }),
        row('wt-1', { trackedBaseBranch: 'feature/merged' }),
        row('wt-2', {
          trackedRepoBaseBranches: {
            'repo-a': 'feature/merged',
            'repo-b': 'feature/merged',
          },
        }),
        row('wt-3', { trackedBaseBranch: 'develop' }),
      ]);

      const outcome = await observeWorktreeGit({
        kind: 'merged-base-retarget',
        workspaceId: WORKSPACE_ID,
        repoIds: [null, 'repo-a'],
        mergedBranchName: 'feature/merged',
        mergedIntoBranchName: 'main',
        mergedWorktreeId: 'wt-merged',
      });

      expect(outcome).toEqual({
        status: 'recorded',
        updates: [
          {
            projectId: WORKSPACE_ID,
            worktreeId: 'wt-1',
            previousBaseBranch: 'feature/merged',
            nextBaseBranch: 'main',
            branchGroupingParentWorktreeId: 'wt-merged',
          },
          {
            projectId: WORKSPACE_ID,
            worktreeId: 'wt-2',
            repoId: 'repo-a',
            previousBaseBranch: 'feature/merged',
            nextBaseBranch: 'main',
            branchGroupingParentWorktreeId: 'wt-merged',
          },
        ],
      });
      expect(await readWorkspaceWorktrees(WORKSPACE_ID)).toEqual([
        row('wt-merged', { trackedBaseBranch: 'feature/merged' }),
        row('wt-1', {
          trackedBaseBranch: 'main',
          branchGroupingParentWorktreeId: 'wt-merged',
        }),
        row('wt-2', {
          trackedRepoBaseBranches: {
            'repo-a': 'main',
            'repo-b': 'feature/merged',
          },
          branchGroupingParentWorktreeId: 'wt-merged',
        }),
        row('wt-3', { trackedBaseBranch: 'develop' }),
      ]);
    });

    it('leaves a cleared base cleared and groups nothing in another workspace', async () => {
      const contents = await writeList([
        row('wt-1', { trackedBaseBranch: null }),
        row('wt-2', { trackedBaseBranch: 'feature/merged' }),
      ]);

      const outcome = await observeWorktreeGit({
        kind: 'merged-base-retarget',
        workspaceId: WORKSPACE_ID,
        repoIds: [null],
        mergedBranchName: 'feature/merged',
        mergedIntoBranchName: 'main',
      });

      expect(outcome.updates).toEqual([
        {
          projectId: WORKSPACE_ID,
          worktreeId: 'wt-2',
          previousBaseBranch: 'feature/merged',
          nextBaseBranch: 'main',
        },
      ]);
      expect(await readWorkspaceWorktrees(WORKSPACE_ID)).toEqual([
        row('wt-1', { trackedBaseBranch: null }),
        row('wt-2', { trackedBaseBranch: 'main' }),
      ]);
      expect(contents).not.toBe(await readFile(listPath, 'utf8'));
    });

    it('writes nothing when no base tracked the merged branch', async () => {
      const contents = await writeList([
        row('wt-1', { trackedBaseBranch: 'develop' }),
      ]);
      mockFailNextWrite = true;

      await expect(
        observeWorktreeGit({
          kind: 'merged-base-retarget',
          workspaceId: WORKSPACE_ID,
          repoIds: [null],
          mergedBranchName: 'feature/merged',
          mergedIntoBranchName: 'main',
        }),
      ).resolves.toEqual({ status: 'unchanged', updates: [] });
      expect(await readFile(listPath, 'utf8')).toBe(contents);
      mockFailNextWrite = false;
    });

    it('creates no list and never writes an unreadable one', async () => {
      const retarget = (): ReturnType<typeof observeWorktreeGit> =>
        observeWorktreeGit({
          kind: 'merged-base-retarget',
          workspaceId: WORKSPACE_ID,
          repoIds: [null],
          mergedBranchName: 'feature/merged',
          mergedIntoBranchName: 'main',
        });

      await expect(retarget()).resolves.toEqual({
        status: 'unchanged',
        updates: [],
      });
      await expect(readdir(dataDir)).resolves.toEqual([]);

      await mkdir(path.dirname(listPath), { recursive: true });
      await writeFile(listPath, '{"version": 1, "worktrees": [');
      await expect(retarget()).resolves.toEqual({
        status: 'unchanged',
        updates: [],
      });
      expect(await readFile(listPath, 'utf8')).toBe(
        '{"version": 1, "worktrees": [',
      );
    });

    it('keeps a row created and a base cleared while it holds its read', async () => {
      await writeList([
        row('wt-1', { trackedBaseBranch: 'feature/merged' }),
        row('wt-2', { trackedBaseBranch: 'feature/merged' }),
      ]);
      const release = holdNextWrite();

      const retargeting = observeWorktreeGit({
        kind: 'merged-base-retarget',
        workspaceId: WORKSPACE_ID,
        repoIds: [null],
        mergedBranchName: 'feature/merged',
        mergedIntoBranchName: 'main',
      });
      await settle();
      const creating = updateWorkspaceWorktrees(WORKSPACE_ID, (rows) => [
        row('wt-new', { trackedBaseBranch: 'feature/merged' }),
        ...rows,
      ]);
      const clearing = updateWorktree({
        workspaceId: WORKSPACE_ID,
        worktreeId: 'wt-2',
        patch: { trackedBaseBranch: null },
      });
      await settle();
      release();
      await Promise.all([retargeting, creating, clearing]);

      // The retarget committed first; the create and the clear apply on top.
      expect(await readWorkspaceWorktrees(WORKSPACE_ID)).toEqual([
        row('wt-new', { trackedBaseBranch: 'feature/merged' }),
        row('wt-1', { trackedBaseBranch: 'main' }),
        row('wt-2', { trackedBaseBranch: null }),
      ]);
    });

    it('fails without writing when the write fails, and applies on retry', async () => {
      const contents = await writeList([
        row('wt-1', { trackedBaseBranch: 'feature/merged' }),
      ]);
      mockFailNextWrite = true;
      const retarget = (): ReturnType<typeof observeWorktreeGit> =>
        observeWorktreeGit({
          kind: 'merged-base-retarget',
          workspaceId: WORKSPACE_ID,
          repoIds: [null],
          mergedBranchName: 'feature/merged',
          mergedIntoBranchName: 'main',
        });

      await expect(retarget()).rejects.toThrow('disk full');
      expect(await readFile(listPath, 'utf8')).toBe(contents);

      clearWorktreesSelfWriteTracking(WORKSPACE_ID);
      await expect(retarget()).resolves.toMatchObject({ status: 'recorded' });
      expect(await readRow('wt-1')).toEqual(
        row('wt-1', { trackedBaseBranch: 'main' }),
      );
    });

    it('refuses an invalid repository id or branch before reading', async () => {
      const contents = await writeList([
        row('wt-1', { trackedBaseBranch: 'feature/merged' }),
      ]);

      for (const invalid of [
        { repoIds: ['../repo'] },
        { mergedBranchName: ' ' },
        { mergedIntoBranchName: '' },
        { mergedWorktreeId: 'Not An Id' },
      ]) {
        await expect(
          observeWorktreeGit({
            kind: 'merged-base-retarget',
            workspaceId: WORKSPACE_ID,
            repoIds: [null],
            mergedBranchName: 'feature/merged',
            mergedIntoBranchName: 'main',
            ...invalid,
          }),
        ).rejects.toMatchObject({
          name: 'WorktreeRecordRefusedError',
          reason: 'invalid-request',
        });
      }
      expect(await readFile(listPath, 'utf8')).toBe(contents);
    });
  });

  describe('a stale whole-list save', () => {
    it('does not bring back a base or grouping parent an observation changed', async () => {
      await writeList([
        row('wt-1', { trackedBaseBranch: 'feature/merged' }),
        row('wt-2', {
          trackedRepoBaseBranches: { 'repo-a': 'feature/merged' },
        }),
      ]);
      const staleSnapshot = await readWorkspaceWorktrees(WORKSPACE_ID);
      await observeWorktreeGit({
        kind: 'merged-base-retarget',
        workspaceId: WORKSPACE_ID,
        repoIds: [null, 'repo-a'],
        mergedBranchName: 'feature/merged',
        mergedIntoBranchName: 'main',
        mergedWorktreeId: 'wt-merged',
      });
      // The user then clears the retargeted scalar base.
      await updateWorktree({
        workspaceId: WORKSPACE_ID,
        worktreeId: 'wt-1',
        patch: { trackedBaseBranch: null },
      });

      await writeWorkspaceWorktrees(WORKSPACE_ID, staleSnapshot);

      expect(await readWorkspaceWorktrees(WORKSPACE_ID)).toEqual([
        row('wt-1', { trackedBaseBranch: null }),
        row('wt-2', {
          trackedRepoBaseBranches: { 'repo-a': 'main' },
          branchGroupingParentWorktreeId: 'wt-merged',
        }),
      ]);
    });

    it('does not bring back a split child grouping', async () => {
      await writeList([row('wt-1')]);
      const staleSnapshot = await readWorkspaceWorktrees(WORKSPACE_ID);
      await observeRow({
        kind: 'split-child-grouping',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'wt-1',
      });

      await writeWorkspaceWorktrees(WORKSPACE_ID, staleSnapshot);

      expect(await readRow('wt-1')).toEqual(
        row('wt-1', { branchGroupingOverride: 'group' }),
      );
    });
  });
});
