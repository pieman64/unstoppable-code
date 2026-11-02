// W6c1: host routing and ordered plain-data decisions through a fake archive
// record port. The fake applies the pure decisions and writes the list plainly,
// so the host's own reads see them; this is not unmodified product lifecycle
// evidence.
import type * as DecisionApply from '../worktree-record-decision-apply';
import type * as Persistence from '../workspace-persistence';
import type * as Paths from '../paths';
import type * as Fs from 'node:fs';
import type * as CostLifecycle from '../../cost-index/lifecycle';
import type * as MainProcessLogging from '../main-process-logging';
import type {
  ArchiveCleanupTombstoneDecision,
  ArchiveJournalDecision,
  ArchivedWorktreeRowRemovalDecision,
  WorktreeRecordTarget,
} from '../worktree-record-decisions';

const mockEvents: unknown[] = [];
function mockRecord(entry: unknown): void {
  mockEvents.push(JSON.parse(JSON.stringify(entry)));
}
jest.mock('../worktree-archive-record-decision-port', () => {
  const pure = jest.requireActual<typeof DecisionApply>(
    '../worktree-record-decision-apply',
  );
  const persistence = jest.requireActual<typeof Persistence>(
    '../workspace-persistence',
  );
  const { getWorkspaceWorktreesFilePath } =
    jest.requireActual<typeof Paths>('../paths');
  const { writeFileSync: write } = jest.requireActual<typeof Fs>('node:fs');
  // A plain write: no lock, commit, lifecycle identity check or tombstones.
  const persist = (workspaceId: string, worktrees: unknown[]): void =>
    write(
      getWorkspaceWorktreesFilePath(workspaceId),
      JSON.stringify({ version: 1, worktrees }),
    );
  return {
    applyArchiveJournalRecord: jest.fn(
      async (
        target: WorktreeRecordTarget,
        decision: ArchiveJournalDecision,
      ) => {
        mockRecord({ target, decision });
        const rows = await persistence.readWorkspaceWorktrees(
          target.workspaceId,
        );
        persist(
          target.workspaceId,
          rows.map((row) =>
            row.id === target.worktreeId
              ? pure.applyArchiveJournalTo(row, decision)
              : row,
          ),
        );
        return rows.some((row) => row.id === target.worktreeId);
      },
    ),
    applyArchivedWorktreeRowRemoval: jest.fn(
      async (
        target: WorktreeRecordTarget,
        decision: ArchivedWorktreeRowRemovalDecision,
      ) => {
        mockRecord({ target, decision });
        const rows = await persistence.readWorkspaceWorktrees(
          target.workspaceId,
        );
        const kept = rows.filter(
          (row) => !pure.removesArchivedWorktree(row, target.worktreeId),
        );
        persist(target.workspaceId, kept);
        return kept.length < rows.length;
      },
    ),
    applyArchiveCleanupTombstone: jest.fn(
      (
        target: WorktreeRecordTarget,
        decision: ArchiveCleanupTombstoneDecision,
      ) => {
        mockRecord({ target, decision });
        return Promise.resolve();
      },
    ),
  };
});
jest.mock('../post-archive-sync', () => ({
  queueTrackedGitHubWorktreeSync: jest.fn(),
}));
jest.mock('../../browser/browser-profile-lifecycle', () => ({
  prepareTaskBrowserRetirement: jest.fn(() => Promise.resolve('retirement')),
  settleFailedTaskBrowserRetirement: jest.fn(() => Promise.resolve()),
  retireRemovedBrowserTask: jest.fn(() => Promise.resolve()),
  commitTaskBrowserRetirement: jest.fn(() => Promise.resolve(false)),
  abortTaskBrowserRetirement: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({
    cancelLocalScope: jest.fn(() => Promise.resolve()),
    commitLocalScopeCancellation: jest.fn(() => Promise.resolve()),
    releaseLocalScopeFence: jest.fn(() => Promise.resolve()),
  })),
}));
jest.mock('../../chat-search/service', () => ({
  getChatSearchService: jest.fn(() => ({
    deleteWorktreeDocs: jest.fn(() => Promise.resolve()),
  })),
}));
jest.mock('../../ledger/lifecycle', () => ({
  captureLedgerWorkspaceIncarnations: jest.fn(() => Promise.resolve(null)),
  notifyLedgerWorkspaceDeleted: jest.fn(),
  notifyLedgerContainerArchived: jest.fn(),
}));
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    purgeWorktreeData: jest.fn(() => Promise.resolve()),
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
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
  recordWorktreeCrudTelemetry: jest.fn(),
}));
jest.mock('../../cost-index/lifecycle', () => ({
  ...jest.requireActual<typeof CostLifecycle>('../../cost-index/lifecycle'),
  prepareEntryCostArchive: jest.fn(() => Promise.resolve()),
  finishEntryCostArchive: jest.fn(() => Promise.resolve()),
}));
jest.mock('../main-process-logging', () => ({
  ...jest.requireActual<typeof MainProcessLogging>('../main-process-logging'),
  logMainProcessWarn: jest.fn(),
}));

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { resetChatStateServiceForTests } from '../../services/chat-state-service';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import * as creationPort from '../worktree-creation-decision-port';
import { deleteWorktree } from '../worktree-archive';
import { archiveSingleRepoWorktree } from '../worktree-service';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';

jest.setTimeout(60_000);
let dir: string;
let root: string;
let repo: string;
let createdAt: string;
let originalDataDir: string | undefined;
const checkout = (): string => join(root, 'a', 'worktrees', 'one');
const listPath = (): string => join(root, 'a', 'worktrees.json');
const target = { workspaceId: 'a', worktreeId: 'one' };

const listSchema = z.object({
  worktrees: z.array(
    z.object({ id: z.string(), createdAt: z.string() }).passthrough(),
  ),
});
function rows(): z.infer<typeof listSchema>['worktrees'] {
  return listSchema.parse(JSON.parse(readFileSync(listPath(), 'utf8')))
    .worktrees;
}
function tip(repository: string, branch: string): string {
  return execFileSync(
    'git',
    ['-C', repository, 'rev-parse', `refs/heads/${branch}`],
    { encoding: 'utf8' },
  ).trim();
}
function guard(repository: string, branch: string): Record<string, string> {
  return {
    referenceRepoPath: repository,
    repositoryIdentity: join(repository, '.git'),
    branchName: branch,
    expectedTip: tip(repository, branch),
  };
}
function multiRepo(): string {
  const child = join(dir, 'child');
  execFileSync('git', ['clone', '-q', '--no-hardlinks', repo, child]);
  writeFileSync(join(checkout(), '.gitignore'), 'repos/\n');
  execFileSync('git', ['-C', checkout(), 'add', '.gitignore']);
  execFileSync('git', [
    '-C',
    checkout(),
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'ignore children',
  ]);
  execFileSync('git', [
    '-C',
    child,
    'worktree',
    'add',
    '-q',
    '-b',
    'child-old',
    join(checkout(), 'repos', 'child'),
  ]);
  writeFileSync(
    join(root, 'a', 'workspace.json'),
    JSON.stringify({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: repo,
      repos: [{ id: 'child', name: 'child', repoPath: child }],
    }),
  );
  const indexPath = join(root, 'index.json');
  writeFileSync(
    indexPath,
    readFileSync(indexPath, 'utf8').replace(
      '"type":"single-repo"',
      '"type":"multi-repo"',
    ),
  );
  __resetSidebarItemsStateForTests();
  return child;
}

beforeEach(() => {
  resetChatStateServiceForTests();
  ({ dir, root, repo } = createW5BoundaryFixture((at) => [
    { id: 'one', branchName: 'old', createdAt: at },
    { id: 'two', branchName: 'second', createdAt: at },
  ]));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  execFileSync('git', [
    '-C',
    repo,
    'worktree',
    'add',
    '-q',
    '-b',
    'old',
    checkout(),
  ]);
  createdAt = rows()[0]?.createdAt ?? '';
  jest.clearAllMocks();
  mockEvents.length = 0;
  const remove = creationPort.applyReservedWorktreeRemoval;
  jest
    .spyOn(creationPort, 'applyReservedWorktreeRemoval')
    .mockImplementation(async (reserved, decision) => {
      mockRecord({ target: reserved, decision });
      return remove(reserved, decision);
    });
});
afterEach(async () => {
  await settleDetachedWork();
  jest.restoreAllMocks();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

const reservedRemoval = (): unknown => ({
  target: { ...target, createdAt },
  decision: { kind: 'worktree.create.reservation.remove' },
});

it('decides a single-repository branch deletion journal, then the reserved row removal', async () => {
  const deletion = guard(repo, 'old');
  await expect(
    deleteWorktree({ ...target, source: 'single_repo', deleteBranch: true }),
  ).resolves.toMatchObject({ success: true });
  expect(mockEvents).toEqual([
    {
      target,
      decision: {
        kind: 'worktree.archive.journal.record',
        workspaceKind: 'single-repo',
        pendingBranchDeletion: deletion,
      },
    },
    reservedRemoval(),
  ]);
  expect(rows().map((row) => row.id)).toEqual(['two']);
});

it('decides one multi-repository journal for every branch, then the reserved row removal', async () => {
  const child = multiRepo();
  const deletions = [
    { repoId: 'child', ...guard(child, 'child-old') },
    { repoId: '__workspace_root__', ...guard(repo, 'old') },
  ];
  await expect(
    deleteWorktree({ ...target, source: 'multi_repo', deleteBranch: true }),
  ).resolves.toMatchObject({ success: true });
  expect(mockEvents).toEqual([
    {
      target,
      decision: {
        kind: 'worktree.archive.journal.record',
        workspaceKind: 'multi-repo',
        pendingBranchDeletions: deletions,
      },
    },
    reservedRemoval(),
  ]);
});

it.each(['single-repo', 'multi-repo'] as const)(
  'decides a %s journal clear for a kept branch, then the reserved row removal',
  async (workspaceKind) => {
    const child = workspaceKind === 'multi-repo' ? multiRepo() : undefined;
    writeFileSync(
      listPath(),
      JSON.stringify({
        version: 1,
        worktrees: rows().map((row) =>
          row.id !== 'one'
            ? row
            : child
              ? {
                  ...row,
                  pendingArchiveBranchDeletions: [
                    { repoId: 'child', ...guard(child, 'child-old') },
                  ],
                }
              : { ...row, pendingArchiveBranchDeletion: guard(repo, 'old') },
        ),
      }),
    );
    await expect(
      deleteWorktree({
        ...target,
        source: child ? 'multi_repo' : 'single_repo',
        deleteBranch: false,
      }),
    ).resolves.toMatchObject({ success: true });
    expect(mockEvents).toEqual([
      {
        target,
        decision: { kind: 'worktree.archive.journal.clear', workspaceKind },
      },
      reservedRemoval(),
    ]);
  },
);

it('decides no journal when no branch is deleted or guarded', async () => {
  await expect(
    deleteWorktree({ ...target, source: 'single_repo', deleteBranch: false }),
  ).resolves.toMatchObject({ success: true });
  expect(mockEvents).toEqual([reservedRemoval()]);
});

it('a needs-repair rollback of a removed row decides the tombstone after the reserved removal', async () => {
  writeFileSync(
    listPath(),
    JSON.stringify({
      version: 1,
      worktrees: rows().filter((row) => row.id !== 'one'),
    }),
  );
  await expect(
    archiveSingleRepoWorktree({
      ...target,
      expectedCreatedAt: createdAt,
      allowMissingRow: true,
      retainAsArchivedContainer: false,
      deleteBranch: false,
    }),
  ).resolves.toMatchObject({ success: true });
  expect(mockEvents).toEqual([
    reservedRemoval(),
    {
      target,
      decision: { kind: 'worktree.archive.cleanup.tombstone', createdAt },
    },
  ]);
});

it('a rollback without a known incarnation decides the row removal by id with its order', async () => {
  writeFileSync(
    listPath(),
    JSON.stringify({
      version: 1,
      worktrees: rows().filter((row) => row.id !== 'one'),
    }),
  );
  await expect(
    archiveSingleRepoWorktree({
      ...target,
      allowMissingRow: true,
      retainAsArchivedContainer: false,
      deleteBranch: false,
      remainingWorktreeOrder: ['two'],
      expectedRemainingWorktreeOrder: ['two'],
    }),
  ).resolves.toMatchObject({ success: true });
  expect(mockEvents).toEqual([
    {
      target,
      decision: {
        kind: 'worktree.archive.row.remove',
        remainingWorktreeOrder: ['two'],
        expectedRemainingWorktreeOrder: ['two'],
      },
    },
  ]);
});
