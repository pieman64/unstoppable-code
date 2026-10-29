// CAN-3810: round trips through the worktree creation boundary with real Git
// and the real workspace persistence on a temporary data dir. Each create is
// read back from `worktrees.json`: the persisted row, projected to the typed
// creation record, must equal the outcome the boundary returned, and the Git
// checkout must match the requested branch.
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
    recordUsageMetricEvent: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../code-graph-eager-seed', () => ({
  eagerSeedNewWorktreeCodeGraph: jest.fn(() => Promise.resolve()),
}));

import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import {
  getSidebarItemGroupsFilePath,
  getWorkspaceConfigPath,
  getWorkspaceIndexFilePath,
  getWorkspaceWorktreeRepoDir,
  getWorktreeDir,
} from '../paths';
import {
  readWorkspaceWorktrees,
  setWorktreeRegistryReconciler,
} from '../workspace-persistence';
import { initializeSidebarItemGroups } from '../../services/sidebar-item-groups-service';
import {
  createWorktreeFromSelection,
  projectWorktreeCreationRecord,
  type WorktreeCreationRecord,
} from '../worktree-creation';

const TEST_TIMEOUT_MS = 60_000;
const SINGLE = 'single';
const MULTI = 'multi';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A clone of a bare origin with `main` and `develop`, both pushed. */
function createRepository(root: string, name: string): string {
  const origin = path.join(root, `${name}.git`);
  const work = path.join(root, name);
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, work]);
  git(work, ['config', 'user.name', 'Canopy Test']);
  git(work, ['config', 'user.email', 'test@canopy.example']);
  git(work, ['config', 'commit.gpgsign', 'false']);
  execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: work });
  execFileSync('sh', ['-c', 'echo base > README.md'], { cwd: work });
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'base']);
  git(work, ['push', '-q', '-u', 'origin', 'main']);
  git(work, ['branch', 'develop']);
  git(work, ['push', '-q', 'origin', 'develop']);
  return work;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function persistedRow(
  workspaceId: string,
  worktreeId: string,
): Promise<WorktreeData> {
  const rows = await readWorkspaceWorktrees(workspaceId);
  const row = rows.find((entry) => entry.id === worktreeId);
  if (!row) throw new Error(`No persisted row for ${worktreeId}`);
  return row;
}

async function expectRecordPersisted(
  workspaceId: string,
  record: WorktreeCreationRecord,
): Promise<void> {
  expect(
    projectWorktreeCreationRecord(
      await persistedRow(workspaceId, record.worktreeId),
    ),
  ).toEqual(record);
}

describe('worktree creation boundary round trips (real git and fs)', () => {
  let root: string;
  let originalDataDir: string | undefined;
  let singleRepo: string;
  let apiRepo: string;
  let webRepo: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'canopy-worktree-create-'));
    const repos = path.join(root, 'repos');
    await mkdir(repos, { recursive: true });
    singleRepo = createRepository(repos, 'app');
    apiRepo = createRepository(repos, 'api');
    webRepo = createRepository(repos, 'web');
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    originalDataDir = process.env.CANOPY_DATA_DIR;
    const dataDir = await mkdtemp(path.join(root, 'data-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    await writeJson(getWorkspaceIndexFilePath(), {
      version: 1,
      workspaces: [
        {
          id: SINGLE,
          name: 'App',
          type: 'single-repo',
          color: 'blue',
          collapsed: false,
          order: 0,
        },
        {
          id: MULTI,
          name: 'Stack',
          type: 'multi-repo',
          color: 'green',
          collapsed: false,
          order: 1,
        },
      ],
    });
    await writeJson(getWorkspaceConfigPath(SINGLE), {
      version: 1,
      type: 'single-repo',
      repoPath: singleRepo,
    });
    await writeJson(getWorkspaceConfigPath(MULTI), {
      version: 1,
      type: 'multi-repo',
      repos: [
        { id: 'api', name: 'api', repoPath: apiRepo },
        { id: 'web', name: 'web', repoPath: webRepo },
      ],
    });
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
  });

  describe('single-repository', () => {
    it(
      'creates the default branch from the repository default',
      async () => {
        const outcome = await createWorktreeFromSelection({
          workspaceId: SINGLE,
          workspaceKind: 'single-repo',
          branch: { kind: 'default' },
          base: { kind: 'repository-default' },
        });

        const { record } = outcome;
        expect(record.worktreeId).toMatch(/^[a-z-]+$/);
        // The default branch is `<worktree id>-<epoch ms>`.
        expect(record.branchName).toMatch(
          new RegExp(`^${record.worktreeId}-\\d+$`),
        );
        expect(record).toEqual({
          worktreeId: record.worktreeId,
          branchName: record.branchName,
          createdAt: record.createdAt,
          setupPhase: 'git-ready',
          trackedBaseBranch: null,
          trackedRepoBaseBranches: {},
          includedRepoIds: null,
        });
        await expectRecordPersisted(SINGLE, record);
        expect(
          git(getWorktreeDir(SINGLE, record.worktreeId), [
            'branch',
            '--show-current',
          ]),
        ).toBe(record.branchName);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'creates a new branch from a base branch and tracks it',
      async () => {
        const { record } = await createWorktreeFromSelection({
          workspaceId: SINGLE,
          workspaceKind: 'single-repo',
          branch: { kind: 'new', branchName: ' feature/new ' },
          base: { kind: 'branch', baseBranch: 'develop' },
        });

        expect(record).toMatchObject({
          branchName: 'feature/new',
          trackedBaseBranch: 'develop',
          setupPhase: 'git-ready',
        });
        await expectRecordPersisted(SINGLE, record);
        const checkout = getWorktreeDir(SINGLE, record.worktreeId);
        expect(git(checkout, ['branch', '--show-current'])).toBe('feature/new');
        expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(
          git(singleRepo, ['rev-parse', 'develop']),
        );
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'checks out an existing branch and still tracks a base branch',
      async () => {
        git(singleRepo, ['branch', 'feature/existing', 'main']);

        const { record } = await createWorktreeFromSelection({
          workspaceId: SINGLE,
          workspaceKind: 'single-repo',
          branch: { kind: 'existing', branchName: 'feature/existing' },
          base: { kind: 'branch', baseBranch: 'main' },
        });

        expect(record).toMatchObject({
          branchName: 'feature/existing',
          trackedBaseBranch: 'main',
        });
        await expectRecordPersisted(SINGLE, record);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'creates a suggested branch that does not exist yet',
      async () => {
        const { record } = await createWorktreeFromSelection({
          workspaceId: SINGLE,
          workspaceKind: 'single-repo',
          branch: { kind: 'suggested', branchName: 'feature/suggested' },
          base: { kind: 'repository-default' },
        });

        expect(record.branchName).toBe('feature/suggested');
        await expectRecordPersisted(SINGLE, record);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "tracks a base worktree's current branch",
      async () => {
        const base = await createWorktreeFromSelection({
          workspaceId: SINGLE,
          workspaceKind: 'single-repo',
          branch: { kind: 'new', branchName: 'feature/base' },
          base: { kind: 'repository-default' },
        });

        const { record } = await createWorktreeFromSelection({
          workspaceId: SINGLE,
          workspaceKind: 'single-repo',
          branch: { kind: 'default' },
          base: { kind: 'worktree', baseWorktreeId: base.record.worktreeId },
        });

        expect(record.trackedBaseBranch).toBe('feature/base');
        await expectRecordPersisted(SINGLE, record);
        const rows = await readWorkspaceWorktrees(SINGLE);
        // New worktrees lead the manual order.
        expect(rows.map((row) => row.id)).toEqual([
          record.worktreeId,
          base.record.worktreeId,
        ]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'returns the git-pending reservation and promotes it after deferred setup',
      async () => {
        let settled: (outcome: string) => void = () => {};
        const setupSettled = new Promise<string>((resolve) => {
          settled = resolve;
        });

        const { record } = await createWorktreeFromSelection({
          workspaceId: SINGLE,
          workspaceKind: 'single-repo',
          branch: { kind: 'new', branchName: 'feature/deferred' },
          base: { kind: 'branch', baseBranch: 'main' },
          deferGitSetup: true,
          onGitSetupSettled: (event) => settled(event.outcome),
        });

        expect(record).toMatchObject({
          branchName: 'feature/deferred',
          setupPhase: 'git-pending',
          trackedBaseBranch: 'main',
        });
        const reserved = projectWorktreeCreationRecord(
          await persistedRow(SINGLE, record.worktreeId),
        );
        // The row may already be promoted when Git setup is fast; every other
        // field is fixed at reservation.
        expect({ ...reserved, setupPhase: 'git-pending' }).toEqual(record);

        await expect(setupSettled).resolves.toBe('ready');
        await expectRecordPersisted(SINGLE, {
          ...record,
          setupPhase: 'git-ready',
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'files the new worktree in the requested sidebar group',
      async () => {
        initializeSidebarItemGroups();
        try {
          const existing = await createWorktreeFromSelection({
            workspaceId: SINGLE,
            workspaceKind: 'single-repo',
            branch: { kind: 'default' },
            base: { kind: 'repository-default' },
          });
          const group = {
            id: 'grp-review',
            name: 'Review',
            color: 'neutral',
            collapsed: false,
            memberIds: [existing.record.worktreeId],
          };
          await writeJson(getSidebarItemGroupsFilePath(SINGLE), {
            version: 1,
            groups: [group],
          });

          const { record } = await createWorktreeFromSelection({
            workspaceId: SINGLE,
            workspaceKind: 'single-repo',
            branch: { kind: 'default' },
            base: { kind: 'repository-default' },
            sidebarItemGroupId: 'grp-review',
          });

          await expectRecordPersisted(SINGLE, record);
          const groups: unknown = JSON.parse(
            await readFile(getSidebarItemGroupsFilePath(SINGLE), 'utf8'),
          );
          expect(groups).toEqual({
            version: 1,
            groups: [
              {
                ...group,
                memberIds: [existing.record.worktreeId, record.worktreeId],
              },
            ],
          });
        } finally {
          setWorktreeRegistryReconciler((_workspaceId, _current, next) =>
            Promise.resolve({ rows: next }),
          );
        }
      },
      TEST_TIMEOUT_MS,
    );

    it('refuses a per-repository base before reserving anything', async () => {
      await expect(
        createWorktreeFromSelection({
          workspaceId: SINGLE,
          workspaceKind: 'single-repo',
          branch: { kind: 'default' },
          base: { kind: 'per-repository', baseBranches: { app: 'main' } },
        }),
      ).rejects.toMatchObject({
        reason: 'invalid-selection',
        message:
          'baseBranchesByRepo is only supported for multi-repository projects',
      });
      expect(await readWorkspaceWorktrees(SINGLE)).toEqual([]);
    });

    it('refuses a workspace of the other kind with the existing message', async () => {
      await expect(
        createWorktreeFromSelection({
          workspaceId: MULTI,
          workspaceKind: 'single-repo',
          branch: { kind: 'default' },
          base: { kind: 'repository-default' },
        }),
      ).rejects.toMatchObject({
        reason: 'unsupported-workspace',
        message: `Project ${MULTI} is not a single-repo project`,
      });
      expect(await readWorkspaceWorktrees(MULTI)).toEqual([]);
    });

    it('denies the read-only shared-container scope before reading it', async () => {
      await expect(
        createWorktreeFromSelection({
          workspaceId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
          workspaceKind: 'single-repo',
          branch: { kind: 'default' },
          base: { kind: 'repository-default' },
        }),
      ).rejects.toMatchObject({
        reason: 'read-only-scope',
        message: 'Shared-container recipient workspaces are read-only',
      });
    });
  });

  describe('multi-repository', () => {
    it(
      'persists per-repository bases',
      async () => {
        const outcome = await createWorktreeFromSelection({
          workspaceId: MULTI,
          workspaceKind: 'multi-repo',
          branch: { kind: 'new', branchName: 'feature/stack' },
          base: {
            kind: 'per-repository',
            baseBranches: { api: 'main', web: 'develop' },
          },
        });

        if (outcome.status !== 'created') throw new Error('Expected a create');
        expect(outcome.record).toMatchObject({
          branchName: 'feature/stack',
          setupPhase: 'git-ready',
          trackedBaseBranch: null,
          trackedRepoBaseBranches: { api: 'main', web: 'develop' },
          includedRepoIds: null,
        });
        await expectRecordPersisted(MULTI, outcome.record);
        for (const [repoId, repoPath, base] of [
          ['api', apiRepo, 'main'],
          ['web', webRepo, 'develop'],
        ]) {
          const checkout = getWorkspaceWorktreeRepoDir(
            MULTI,
            outcome.record.worktreeId,
            repoId,
          );
          expect(git(checkout, ['branch', '--show-current'])).toBe(
            'feature/stack',
          );
          expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(
            git(repoPath, ['rev-parse', base]),
          );
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'resolves one base branch for every repository',
      async () => {
        const outcome = await createWorktreeFromSelection({
          workspaceId: MULTI,
          workspaceKind: 'multi-repo',
          branch: { kind: 'default' },
          base: { kind: 'branch', baseBranch: 'develop' },
        });

        if (outcome.status !== 'created') throw new Error('Expected a create');
        expect(outcome.record.trackedRepoBaseBranches).toEqual({
          api: 'develop',
          web: 'develop',
        });
        await expectRecordPersisted(MULTI, outcome.record);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'scopes the checkout to the included repositories',
      async () => {
        const outcome = await createWorktreeFromSelection({
          workspaceId: MULTI,
          workspaceKind: 'multi-repo',
          branch: { kind: 'default' },
          base: { kind: 'repository-default' },
          includedRepoIds: ['web'],
        });

        if (outcome.status !== 'created') throw new Error('Expected a create');
        expect(outcome.record.includedRepoIds).toEqual(['web']);
        await expectRecordPersisted(MULTI, outcome.record);
        const repos = await readdir(
          path.dirname(
            getWorkspaceWorktreeRepoDir(
              MULTI,
              outcome.record.worktreeId,
              'web',
            ),
          ),
        );
        expect(repos).toEqual(['web']);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "tracks a base worktree's per-repository branches",
      async () => {
        const base = await createWorktreeFromSelection({
          workspaceId: MULTI,
          workspaceKind: 'multi-repo',
          branch: { kind: 'new', branchName: 'feature/stack-base' },
          base: { kind: 'repository-default' },
        });
        if (base.status !== 'created') throw new Error('Expected a create');

        const outcome = await createWorktreeFromSelection({
          workspaceId: MULTI,
          workspaceKind: 'multi-repo',
          branch: { kind: 'default' },
          base: { kind: 'worktree', baseWorktreeId: base.record.worktreeId },
        });

        if (outcome.status !== 'created') throw new Error('Expected a create');
        expect(outcome.record.trackedRepoBaseBranches).toEqual({
          api: 'feature/stack-base',
          web: 'feature/stack-base',
        });
        await expectRecordPersisted(MULTI, outcome.record);
      },
      TEST_TIMEOUT_MS,
    );

    it('refuses an unknown included repository before reserving', async () => {
      await expect(
        createWorktreeFromSelection({
          workspaceId: MULTI,
          workspaceKind: 'multi-repo',
          branch: { kind: 'default' },
          base: { kind: 'repository-default' },
          includedRepoIds: ['docs'],
        }),
      ).rejects.toMatchObject({
        reason: 'invalid-repository-selection',
        message:
          'Cannot create worktree: included repo docs is not in the project.',
      });
      expect(await readWorkspaceWorktrees(MULTI)).toEqual([]);
    });

    it('refuses a suggested branch without a source repository', async () => {
      await expect(
        createWorktreeFromSelection({
          workspaceId: MULTI,
          workspaceKind: 'multi-repo',
          branch: { kind: 'suggested', branchName: 'feature/x' },
          base: { kind: 'repository-default' },
        }),
      ).rejects.toMatchObject({
        reason: 'invalid-selection',
        message: `Project ${MULTI} has no source repository; suggestedBranch requires a source-backed multi-repo project`,
      });
      expect(await readWorkspaceWorktrees(MULTI)).toEqual([]);
    });

    it('keeps the existing error for an absent workspace', async () => {
      await expect(
        createWorktreeFromSelection({
          workspaceId: 'missing',
          workspaceKind: 'multi-repo',
          branch: { kind: 'default' },
          base: { kind: 'repository-default' },
        }),
      ).rejects.toThrow('Project missing not found');
    });
  });
});
