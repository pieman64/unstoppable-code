import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
import type * as CoreStorage from '@canopy/core-runtime/storage';
// W6g: the same rows every checked writer reads, daemon-owned on the daemon side.
jest.mock('@canopy/core-runtime/storage', () => {
  const actual = jest.requireActual<typeof CoreStorage>(
    '@canopy/core-runtime/storage',
  );
  const rows: CoreStorage.StorageOwnershipRow[] = [...actual.STORAGE_OWNERSHIP];
  return {
    ...actual,
    STORAGE_OWNERSHIP: rows,
    setDaemonOwnedForTest: (namespaceIds: readonly string[]): void => {
      actual.STORAGE_OWNERSHIP.forEach((row, index) => {
        rows[index] = namespaceIds.includes(row.id)
          ? { ...row, transitionOwner: 'daemon', currentWriters: [] }
          : row;
      });
    },
  };
});
const { setDaemonOwnedForTest } = jest.requireMock<{
  setDaemonOwnedForTest: (namespaceIds: readonly string[]) => void;
}>('@canopy/core-runtime/storage');
jest.mock('../../agents/session-manager', () => ({
  getActiveChatIds: jest.fn(() => []),
}));
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
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
  recordWorktreeCrudTelemetry: jest.fn(),
}));
jest.mock('../../ledger/lifecycle', () => ({
  LEDGER_INTENT_REFUSING_WAIT_MS: 5000,
  recordLedgerMoveIntent: jest.fn(() => Promise.resolve('recorded')),
  discardLedgerMoveIntent: jest.fn(),
  notifyLedgerContainerMoved: jest.fn(),
}));
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
  W5RevisionConflictError,
  w5ResourceKey,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import {
  combineWorktreeWithWorkspace,
  promoteTemporaryWorkspace,
} from '../adhoc-multi-repo-workspaces';
import { combineWorktreeWithExistingWorktree } from '../adhoc-existing-worktree-join';
import { installW5StoreSide, W5_STORE_SIDES } from './fixtures/w5-store-sides';

jest.setTimeout(60000);
let dir: string;
let root: string;
let repo: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;
const indexSchema = z
  .object({
    workspaces: z.array(
      z.object({ id: z.string(), type: z.string() }).passthrough(),
    ),
  })
  .passthrough();
const listSchema = z.object({
  worktrees: z.array(
    z.object({ createdAt: z.string(), label: z.string().optional() }),
  ),
});
function readJson(path: string): unknown {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return value;
}

beforeEach(() => {
  ({ dir, root, repo } = createW5BoundaryFixture(
    (createdAt) => [{ id: 'one', branchName: 'topic', createdAt }],
    ['b', 'dest'],
  ));
  const repoB = join(dir, 'repo-b');
  mkdirSync(repoB);
  execFileSync('git', ['init', '-q', '-b', 'main', repoB]);
  execFileSync('git', [
    '-C',
    repoB,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'base',
  ]);
  writeFileSync(
    join(root, 'b', 'workspace.json'),
    JSON.stringify({
      version: 1,
      type: 'single-repo',
      repoPath: repoB,
      repos: [],
    }),
  );
  writeFileSync(
    join(root, 'b', 'worktrees.json'),
    JSON.stringify({
      version: 1,
      worktrees: [
        {
          id: 'two',
          branchName: 'joined',
          createdAt: listSchema.parse(
            readJson(join(root, 'a', 'worktrees.json')),
          ).worktrees[0]?.createdAt,
        },
      ],
    }),
  );
  writeFileSync(
    join(root, 'dest', 'workspace.json'),
    JSON.stringify({
      version: 1,
      type: 'multi-repo',
      temporary: true,
      repos: [
        { id: 'a', name: 'A', repoPath: repo },
        { id: 'b', name: 'B', repoPath: repoB },
      ],
    }),
  );
  writeFileSync(
    join(root, 'index.json'),
    JSON.stringify({
      version: 1,
      workspaces: ['a', 'b', 'dest'].map((id, order) => ({
        id,
        name: id,
        type: id === 'dest' ? 'multi-repo' : 'single-repo',
        color: '#7C3AED',
        collapsed: false,
        order,
      })),
    }),
  );
  execFileSync('git', [
    '-C',
    repo,
    'worktree',
    'add',
    '-q',
    '-b',
    'topic',
    join(root, 'a', 'worktrees', 'one'),
  ]);
  execFileSync('git', [
    '-C',
    repoB,
    'worktree',
    'add',
    '-q',
    '-b',
    'joined',
    join(root, 'b', 'worktrees', 'two'),
  ]);
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  jest.clearAllMocks();
});
afterEach(async () => {
  await settleDetachedWork();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});
const boundaries = [
  'workspace-combine',
  'worktree-combine',
  'promote',
] as const;
function invoke(
  kind: (typeof boundaries)[number],
  revision?: number,
  idempotencyKey?: string,
  changed = false,
): Promise<unknown> {
  const options = {
    idempotencyKey,
    expectedRevision: revision,
    expectedRevisions:
      revision === undefined
        ? undefined
        : [
            {
              resource: { kind: 'workspace' as const, workspaceId: 'a' },
              revision,
            },
            {
              resource: {
                kind: 'worktree' as const,
                workspaceId: 'a',
                worktreeId: 'one',
              },
              revision,
            },
            {
              resource: { kind: 'workspace' as const, workspaceId: 'b' },
              revision,
            },
            ...(kind === 'worktree-combine'
              ? [
                  {
                    resource: {
                      kind: 'worktree' as const,
                      workspaceId: 'b',
                      worktreeId: 'two',
                    },
                    revision,
                  },
                ]
              : []),
          ],
  };
  if (kind === 'promote')
    return promoteTemporaryWorkspace({
      ...options,
      workspaceId: 'dest',
      name: changed ? 'Other' : 'Promoted',
    });
  if (kind === 'workspace-combine')
    return combineWorktreeWithWorkspace({
      ...options,
      sourceWorkspaceId: 'a',
      sourceWorktreeId: 'one',
      joinWorkspaceId: changed ? 'dest' : 'b',
      mode: 'temporary',
    });
  return combineWorktreeWithExistingWorktree({
    ...options,
    sourceWorkspaceId: 'a',
    sourceWorktreeId: 'one',
    joinWorkspaceId: 'b',
    joinWorktreeId: changed ? 'missing' : 'two',
    mode: 'temporary',
  });
}
function images(): string[] {
  return [
    'index.json',
    ...['a', 'b', 'dest'].flatMap((id) => [
      `${id}/workspace.json`,
      `${id}/worktrees.json`,
    ]),
  ].map((file) => readFileSync(join(root, file), 'utf8'));
}
import * as git from '../git';
import { ownsW5RepositoryLock } from '../w5-repository-locks';
import {
  isWorkspaceWorktreeRecentlyRemoved,
  updateWorkspaceWorktree,
  updateWorkspaceConfig,
} from '../workspace-persistence';
import { notifyPortalStructureChanged } from '../../portal/portal-event-bus';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import { diagnoseW5State, type W5Diagnosis } from '../w5-maintenance-diagnosis';
import * as processCleanup from '../worktree-process-cleanup';
describe.each(W5_STORE_SIDES)('over the %s store', (side) => {
  let teardown = (): Promise<void> => Promise.resolve();
  beforeEach(async () => {
    teardown = await installW5StoreSide(side, {
      host,
      root,
      setDaemonOwned: setDaemonOwnedForTest,
    });
  });
  afterEach(() => teardown());

  it.each(boundaries)(
    '%s refuses a stale revision before any effect',
    async (kind) => {
      const before = images();
      const commits = jest.spyOn(host, 'commit');
      await expect(invoke(kind, 99, 'key')).rejects.toBeInstanceOf(
        W5RevisionConflictError,
      );
      expect(images()).toEqual(before);
      expect(commits).not.toHaveBeenCalled();
    },
  );
  it.each(boundaries)(
    '%s replays its portable final outcome and refuses parameter reuse',
    async (kind) => {
      const first = await invoke(kind, 0, 'key');
      expect(JSON.stringify(first)).not.toContain(dir);
      const before = images();
      const commits = jest.spyOn(host, 'commit');
      expect(await invoke(kind, 99, 'key')).toStrictEqual(first);
      expect(images()).toEqual(before);
      expect(commits).not.toHaveBeenCalled();
      await expect(invoke(kind, undefined, 'key', true)).rejects.toMatchObject({
        reason: 'key-reused',
      });
    },
  );

  it.each(boundaries)(
    '%s releases stale admission and permits the same key with a current revision',
    async (kind) => {
      await expect(invoke(kind, 99, 'released')).rejects.toBeInstanceOf(
        W5RevisionConflictError,
      );
      await expect(invoke(kind, 0, 'released')).resolves.toBeDefined();
    },
  );
  it.each(boundaries)(
    '%s marks a failure after its first uncertain effect recovery-required, even after rollback',
    async (kind) => {
      jest
        .spyOn(host, 'commit')
        .mockRejectedValueOnce(new Error('decision failed'));
      await expect(invoke(kind, 0, 'failed')).rejects.toThrow(
        // The daemon reports a failed decision call uncertain, with fixed text.
        side === 'daemon'
          ? 'The W5 record port call failed.'
          : 'decision failed',
      );
      await expect(invoke(kind, 0, 'failed')).rejects.toMatchObject({
        reason: 'recovery-required',
      });
    },
  );
  it.each(boundaries)(
    '%s uses separate lifecycle decisions and one final receipt',
    async (kind) => {
      const commits = jest.spyOn(host, 'commit');
      await invoke(kind, 0, 'counted');
      expect(commits).toHaveBeenCalledTimes(3);
      const writes = commits.mock.calls
        .filter(([request]) => request.files.length > 0)
        .map(([request]) => request);
      expect(writes).toHaveLength(2);
      expect(writes.every((request) => request.receipt === undefined)).toBe(
        true,
      );
      expect(commits.mock.calls[2]?.[0].receipt?.idempotencyKey).toBe(
        'counted',
      );
      if (kind === 'promote') {
        expect(writes[1]?.files.map((file) => file.path)).toEqual(
          expect.arrayContaining([
            join(root, 'index.json'),
            join(root, 'dest/workspace.json'),
          ]),
        );
      }
      if (kind === 'worktree-combine') {
        expect(writes[1]?.files.map((file) => file.path)).toEqual([
          join(root, 'a/worktrees.json'),
          join(root, 'b/worktrees.json'),
        ]);
      }
    },
  );

  it.each(boundaries)(
    '%s holds no repository lock during Git effects',
    async (kind) => {
      const move = git.moveWorktree;
      const create = git.createWorktreeAvoidingCheckedOutBranch;
      const init = git.initGitRepo;
      jest.spyOn(git, 'moveWorktree').mockImplementation(async (...args) => {
        expect(ownsW5RepositoryLock()).toBe(false);
        return move(...args);
      });
      jest
        .spyOn(git, 'createWorktreeAvoidingCheckedOutBranch')
        .mockImplementation(async (...args) => {
          expect(ownsW5RepositoryLock()).toBe(false);
          return create(...args);
        });
      jest.spyOn(git, 'initGitRepo').mockImplementation(async (...args) => {
        expect(ownsW5RepositoryLock()).toBe(false);
        return init(...args);
      });
      await invoke(kind, 0, 'no-lock');
    },
  );
  it.each(['workspace-combine', 'worktree-combine'] as const)(
    '%s rechecks source revisions at final publication after Git',
    async (kind) => {
      const move = git.moveWorktree;
      jest
        .spyOn(git, 'moveWorktree')
        .mockImplementationOnce(async (...args) => {
          await move(...args);
          await updateWorkspaceWorktree('a', 'one', (row) => ({
            ...row,
            label: 'Foreign edit',
          }));
        });
      await expect(invoke(kind, 0, 'conflict')).rejects.toBeInstanceOf(
        W5RevisionConflictError,
      );
      await expect(invoke(kind, 0, 'conflict')).rejects.toMatchObject({
        reason: 'recovery-required',
      });
      expect(
        listSchema.parse(readJson(join(root, 'a', 'worktrees.json')))
          .worktrees[0]?.label,
      ).toBe('Foreign edit');
    },
  );
  it('promotion advances precisely its own source-repository record, but refuses a foreign revision before its final decision', async () => {
    // Root repair runs after the source-repository journal, before promotion.
    writeFileSync(
      join(root, 'dest', 'worktrees.json'),
      JSON.stringify({
        version: 1,
        worktrees: [
          {
            id: 'repair',
            branchName: 'repair',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    mkdirSync(join(root, 'dest', 'worktrees', 'repair'), { recursive: true });
    const create = git.createWorktree;
    jest
      .spyOn(git, 'createWorktree')
      .mockImplementationOnce(async (...args) => {
        const result = await create(...args);
        await updateWorkspaceConfig('dest', (config) => {
          config.alwaysShow = true;
        });
        return result;
      });
    await expect(invoke('promote', 0, 'conflict')).rejects.toBeInstanceOf(
      W5RevisionConflictError,
    );
    await expect(invoke('promote', 0, 'conflict')).rejects.toMatchObject({
      reason: 'recovery-required',
    });
  });
  it.each(boundaries)(
    '%s does not save success when a publication hook fails',
    async (kind) => {
      jest.mocked(notifyPortalStructureChanged).mockImplementationOnce(() => {
        throw new Error('notification failed');
      });
      await expect(invoke(kind, 0, 'hook')).rejects.toThrow(
        'notification failed',
      );
      await expect(invoke(kind, 0, 'hook')).rejects.toMatchObject({
        reason: 'recovery-required',
      });
    },
  );

  function makeSourceMultiRepo(): void {
    const oldRoot = join(root, 'a', 'worktrees', 'one');
    const temporary = join(dir, 'source-checkout');
    execFileSync('git', ['-C', repo, 'worktree', 'move', oldRoot, temporary]);
    mkdirSync(join(oldRoot, 'repos'), { recursive: true });
    execFileSync('git', [
      '-C',
      repo,
      'worktree',
      'move',
      temporary,
      join(oldRoot, 'repos', 'a'),
    ]);
    writeFileSync(
      join(root, 'a', 'workspace.json'),
      JSON.stringify({
        version: 1,
        type: 'multi-repo',
        repos: [{ id: 'a', name: 'A', repoPath: repo }],
        sentinel: 'keep',
      }),
    );
    const index = indexSchema.parse(readJson(join(root, 'index.json')));
    const source = index.workspaces.find((entry) => entry.id === 'a');
    if (!source) throw new Error('Source index entry missing');
    source.type = 'multi-repo';
    writeFileSync(join(root, 'index.json'), JSON.stringify(index));
  }
  function invokeUpdate(
    existing: boolean,
    revision?: number,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const options = {
      sourceWorkspaceId: 'a',
      sourceWorktreeId: 'one',
      joinWorkspaceId: 'b',
      mode: 'update-source-workspace' as const,
      idempotencyKey,
      expectedRevisions:
        revision === undefined
          ? undefined
          : [
              {
                resource: { kind: 'workspace' as const, workspaceId: 'a' },
                revision,
              },
              {
                resource: {
                  kind: 'worktree' as const,
                  workspaceId: 'a',
                  worktreeId: 'one',
                },
                revision,
              },
              {
                resource: { kind: 'workspace' as const, workspaceId: 'b' },
                revision,
              },
              {
                resource: {
                  kind: 'worktree' as const,
                  workspaceId: 'b',
                  worktreeId: 'two',
                },
                revision,
              },
            ],
    };
    return existing
      ? combineWorktreeWithExistingWorktree({
          ...options,
          joinWorktreeId: 'two',
        })
      : combineWorktreeWithWorkspace(options);
  }
  it.each([false, true])(
    'update-source (existing=%s) advances its own manifest journal and replays the final DTO',
    async (existing) => {
      makeSourceMultiRepo();
      const first = await invokeUpdate(existing, 0, 'update');
      expect(JSON.stringify(first)).not.toContain(dir);
      const commits = jest.spyOn(host, 'commit');
      expect(await invokeUpdate(existing, 999, 'update')).toStrictEqual(first);
      expect(commits).not.toHaveBeenCalled();
      expect(
        z
          .object({ sentinel: z.string() })
          .parse(readJson(join(root, 'a', 'workspace.json'))).sentinel,
      ).toBe('keep');
    },
  );
  it.each([false, true])(
    'update-source (existing=%s) refuses stale admission and preserves recovery after a later Git failure',
    async (existing) => {
      makeSourceMultiRepo();
      const before = images();
      await expect(invokeUpdate(existing, 99, 'update')).rejects.toBeInstanceOf(
        W5RevisionConflictError,
      );
      expect(images()).toEqual(before);
      const effect = existing
        ? 'moveWorktree'
        : 'createWorktreeAvoidingCheckedOutBranch';
      jest.spyOn(git, effect).mockRejectedValueOnce(new Error('git failed'));
      await expect(invokeUpdate(existing, 0, 'update')).rejects.toThrow(
        'git failed',
      );
      await expect(invokeUpdate(existing, 0, 'update')).rejects.toMatchObject({
        reason: 'recovery-required',
      });
    },
  );
  it.each(['workspace-combine', 'worktree-combine'] as const)(
    '%s groups the new destination manifest/list seed before its separate index publication',
    async (kind) => {
      const index = indexSchema.parse(readJson(join(root, 'index.json')));
      index.workspaces = index.workspaces.filter(
        (entry: { id: string }) => entry.id !== 'dest',
      );
      writeFileSync(join(root, 'index.json'), JSON.stringify(index));
      rmSync(join(root, 'dest'), { recursive: true, force: true });
      const commits = jest.spyOn(host, 'commit');
      await invoke(kind, 0, 'new-destination');
      const writes = commits.mock.calls
        .filter(([request]) => request.files.length > 0)
        .map(([request]) => request);
      expect(writes).toHaveLength(4);
      expect(writes[0]?.files).toHaveLength(2);
      expect(writes[0]?.files.map((file) => file.path)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/workspace\.json$/),
          expect.stringMatching(/worktrees\.json$/),
        ]),
      );
      expect(
        writes[1]?.files.some((file) => file.path.endsWith('index.json')),
      ).toBe(true);
    },
  );
  it.each(boundaries)(
    '%s releases a read-only validation refusal before effects',
    async (kind) => {
      // The same incarnation can become valid later without changing the request.
      const source = kind === 'promote' ? 'dest' : 'a';
      const manifest = readFileSync(
        join(root, source, 'workspace.json'),
        'utf8',
      );
      writeFileSync(
        join(root, source, 'workspace.json'),
        '{"version":1,"type":"multi-repo","repos":[]}',
      );
      if (kind === 'promote') {
        await expect(invoke(kind, undefined, 'validation')).rejects.toThrow(
          'not temporary',
        );
      } else {
        writeFileSync(
          join(root, 'a', 'worktrees.json'),
          '{"version":1,"worktrees":[]}',
        );
        await expect(invoke(kind, undefined, 'validation')).rejects.toThrow(
          /source|Source|Project/,
        );
      }
      writeFileSync(join(root, source, 'workspace.json'), manifest);
      if (kind !== 'promote') {
        // A fresh fixture incarnation avoids any removal tombstone; no command ran.
        writeFileSync(
          join(root, 'a', 'worktrees.json'),
          JSON.stringify({
            version: 1,
            worktrees: [
              {
                id: 'one',
                branchName: 'topic',
                createdAt: new Date().toISOString(),
              },
            ],
          }),
        );
      }
      await expect(
        invoke(kind, undefined, 'validation'),
      ).resolves.toBeDefined();
    },
  );

  it('existing update-source releases a different-clone refusal before any effect', async () => {
    makeSourceMultiRepo();
    // Same repository identity, different local clones. A dirty target wins the
    // overlap, which update-source must refuse before checkout removal.
    for (const path of [repo, join(dir, 'repo-b')]) {
      execFileSync('git', [
        '-C',
        path,
        'remote',
        'add',
        'origin',
        'https://example.com/test/repo.git',
      ]);
    }
    writeFileSync(
      join(root, 'b', 'worktrees', 'two', 'changed.txt'),
      'target edits',
    );
    const before = images();
    const commits = jest.spyOn(host, 'commit');
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(invokeUpdate(true, 0, 'different-clone')).rejects.toThrow(
        'different local clone',
      );
    }
    expect(commits).not.toHaveBeenCalled();
    expect(images()).toEqual(before);
  });

  interface RecordedDecision {
    operation: string;
    files: string[];
    expected: string[];
    bound: boolean;
    refused?: string;
  }
  function recordDecisions(): RecordedDecision[] {
    const decisions: RecordedDecision[] = [];
    const commit = host.commit.bind(host);
    jest.spyOn(host, 'commit').mockImplementation(async (request) => {
      const decision: RecordedDecision = {
        operation: request.operation,
        files: request.files.map((file) => relative(root, file.path)).sort(),
        expected: (request.expectedRevisions ?? []).map(
          ({ resource, revision }) => `${w5ResourceKey(resource)}@${revision}`,
        ),
        bound:
          request.receipt !== undefined || request.reservationId !== undefined,
      };
      decisions.push(decision);
      try {
        return await commit(request);
      } catch (error) {
        decision.refused =
          error instanceof W5CommitRefusedError ? error.reason : 'failed';
        throw error;
      }
    });
    return decisions;
  }
  async function diagnoseOffline(): Promise<W5Diagnosis> {
    await host.shutdown();
    // Diagnosis reads <data>/w5; this harness keeps the log beside the data root.
    mkdirSync(join(dir, 'data', 'w5'), { recursive: true });
    for (const suffix of ['', '-wal']) {
      const source = join(dir, 'w5', `commit-log.sqlite${suffix}`);
      if (existsSync(source))
        copyFileSync(
          source,
          join(dir, 'data', 'w5', `commit-log.sqlite${suffix}`),
        );
    }
    return diagnoseW5State(join(dir, 'data'));
  }

  function seedRepairRow(): void {
    writeFileSync(
      join(root, 'dest', 'worktrees.json'),
      JSON.stringify({
        version: 1,
        worktrees: [
          {
            id: 'repair',
            branchName: 'repair',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    mkdirSync(join(root, 'dest', 'worktrees', 'repair'), { recursive: true });
  }
  function checkouts(repoPath: string): string[] {
    return execFileSync('git', [
      '-C',
      repoPath,
      'worktree',
      'list',
      '--porcelain',
    ])
      .toString()
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => realpathSync(line.slice('worktree '.length)));
  }
  function expectRecoveryRequired(
    diagnosis: W5Diagnosis,
    operation: string,
  ): void {
    expect(diagnosis.logIssue).toBeNull();
    expect(diagnosis.commits).toEqual([]);
    expect(
      diagnosis.reservations.map((reservation) => ({
        state: reservation.state,
        diagnostics: z.unknown().parse(JSON.parse(reservation.diagnostics)),
      })),
    ).toEqual([
      {
        state: 'recovery-required',
        diagnostics: { operation, errorName: 'W5RevisionConflictError' },
      },
    ]);
  }
  const promotedManifestSchema = z
    .object({
      temporary: z.boolean().optional(),
      alwaysShow: z.boolean().optional(),
      sourceRepoPath: z.string().optional(),
      repos: z.array(
        z.object({ id: z.string(), source: z.string().optional() }),
      ),
    })
    .passthrough();

  it('promotion keeps its Git and source-repository effects when a foreign edit refuses its final decision, and diagnosis reports recovery-required', async () => {
    seedRepairRow();
    const create = git.createWorktree;
    jest
      .spyOn(git, 'createWorktree')
      .mockImplementationOnce(async (...args) => {
        const result = await create(...args);
        await updateWorkspaceConfig('dest', (config) => {
          config.alwaysShow = true;
        });
        return result;
      });
    const index = readFileSync(join(root, 'index.json'), 'utf8');
    const decisions = recordDecisions();
    await expect(invoke('promote', 0, 'e7')).rejects.toBeInstanceOf(
      W5RevisionConflictError,
    );
    await expect(invoke('promote', 0, 'e7')).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    const operation = 'core.workspace.composition.promote';
    expect(decisions).toEqual([
      {
        operation,
        files: ['dest/workspace.json'],
        expected: ['workspace:dest@0'],
        bound: false,
      },
      {
        operation: 'w5.workspace_manifest.write',
        files: ['dest/workspace.json'],
        expected: [],
        bound: false,
      },
      {
        operation,
        files: ['dest/workspace.json', 'index.json', 'index.json.bak'],
        expected: ['workspace:dest@1'],
        bound: false,
        refused: 'revision-conflict',
      },
    ]);

    const sourceRepoPath = join(dir, 'data', 'repos', 'promoted');
    expect(
      promotedManifestSchema.parse(
        readJson(join(root, 'dest', 'workspace.json')),
      ),
    ).toMatchObject({
      temporary: true,
      alwaysShow: true,
      sourceRepoPath,
      repos: [
        { id: 'a', source: 'local' },
        { id: 'b', source: 'local' },
      ],
    });
    execFileSync('git', [
      '-C',
      sourceRepoPath,
      'rev-parse',
      '--verify',
      'HEAD',
    ]);
    expect(checkouts(sourceRepoPath)).toContain(
      realpathSync(join(root, 'dest', 'worktrees', 'repair')),
    );
    expect(readFileSync(join(root, 'index.json'), 'utf8')).toBe(index);

    const diagnosis = await diagnoseOffline();
    expectRecoveryRequired(diagnosis, operation);
    // The kept manifest is the logged image; the refused index write never applied.
    expect(
      diagnosis.files.filter((file) => file.path === 'dest/workspace.json'),
    ).toEqual([]);
    expect(diagnosis.files).toContainEqual({
      path: 'index.json',
      reason: 'untracked-file',
    });
  });

  it('worktree-combine: a foreign source edit after its Git moves refuses the join record, the existing rollback restores the checkouts, and diagnosis reports recovery-required', async () => {
    const move = git.moveWorktree;
    jest.spyOn(git, 'moveWorktree').mockImplementationOnce(async (...args) => {
      await move(...args);
      await updateWorkspaceWorktree('a', 'one', (row) => ({
        ...row,
        label: 'Foreign edit',
      }));
    });
    const before = images();
    const decisions = recordDecisions();
    await expect(invoke('worktree-combine', 0, 'e7')).rejects.toBeInstanceOf(
      W5RevisionConflictError,
    );
    await expect(invoke('worktree-combine', 0, 'e7')).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    const operation = 'core.workspace.composition.combine';
    const expected = [
      'workspace:a@0',
      'worktree:a/one@0',
      'workspace:b@0',
      'worktree:b/two@0',
    ];
    expect(decisions).toEqual([
      {
        operation: 'w5.worktree_list.write',
        files: ['a/worktrees.json'],
        expected: [],
        bound: false,
      },
      {
        operation,
        files: ['dest/worktrees.json'],
        expected,
        bound: false,
        refused: 'revision-conflict',
      },
    ]);
    const after = images();
    const sourceList = 2;
    expect(after.filter((_, file) => file !== sourceList)).toEqual(
      before.filter((_, file) => file !== sourceList),
    );
    expect(
      listSchema.parse(readJson(join(root, 'a', 'worktrees.json'))).worktrees,
    ).toEqual([expect.objectContaining({ label: 'Foreign edit' })]);
    expect(checkouts(repo)).toContain(
      realpathSync(join(root, 'a', 'worktrees', 'one')),
    );
    expect(checkouts(join(dir, 'repo-b'))).toContain(
      realpathSync(join(root, 'b', 'worktrees', 'two')),
    );

    const diagnosis = await diagnoseOffline();
    expectRecoveryRequired(diagnosis, operation);
    expect(
      diagnosis.files.filter((file) => file.reason === 'log-mismatch'),
    ).toEqual([]);
  });

  it('worktree-combine: after a foreign edit refuses a new destination, its cleanup removes only that index entry outside the receipt, and diagnosis reports recovery-required', async () => {
    const seeded = indexSchema.parse(readJson(join(root, 'index.json')));
    seeded.workspaces = seeded.workspaces.filter(
      (entry) => entry.id !== 'dest',
    );
    writeFileSync(join(root, 'index.json'), JSON.stringify(seeded));
    rmSync(join(root, 'dest'), { recursive: true, force: true });
    const move = git.moveWorktree;
    jest.spyOn(git, 'moveWorktree').mockImplementationOnce(async (...args) => {
      await move(...args);
      await updateWorkspaceWorktree('a', 'one', (row) => ({
        ...row,
        label: 'Foreign edit',
      }));
    });
    const decisions = recordDecisions();
    await expect(invoke('worktree-combine', 0, 'e7')).rejects.toBeInstanceOf(
      W5RevisionConflictError,
    );
    await expect(invoke('worktree-combine', 0, 'e7')).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    const operation = 'core.workspace.composition.combine';
    const expected = [
      'workspace:a@0',
      'worktree:a/one@0',
      'workspace:b@0',
      'worktree:b/two@0',
    ];
    const destination = 'a-b';
    expect(decisions).toEqual([
      {
        operation,
        files: [
          `${destination}/workspace.json`,
          `${destination}/worktrees.json`,
        ],
        expected,
        bound: false,
      },
      {
        operation,
        files: ['index.json', 'index.json.bak'],
        expected,
        bound: false,
      },
      {
        operation: 'w5.worktree_list.write',
        files: ['a/worktrees.json'],
        expected: [],
        bound: false,
      },
      {
        operation,
        files: [`${destination}/worktrees.json`],
        expected,
        bound: false,
        refused: 'revision-conflict',
      },
      // Row 1 cleanup: the targeted index removal, not bound to the receipt.
      {
        operation: 'w5.workspace_index.write',
        files: ['index.json', 'index.json.bak'],
        expected: [],
        bound: false,
      },
    ]);
    expect(indexSchema.parse(readJson(join(root, 'index.json')))).toEqual(
      seeded,
    );
    expect(existsSync(join(root, destination))).toBe(false);
    expect(
      listSchema.parse(readJson(join(root, 'a', 'worktrees.json'))).worktrees,
    ).toEqual([expect.objectContaining({ label: 'Foreign edit' })]);
    expect(checkouts(repo)).toContain(
      realpathSync(join(root, 'a', 'worktrees', 'one')),
    );
    expect(checkouts(join(dir, 'repo-b'))).toContain(
      realpathSync(join(root, 'b', 'worktrees', 'two')),
    );

    const diagnosis = await diagnoseOffline();
    expectRecoveryRequired(diagnosis, operation);
    // As before, the directory removal stays outside the log.
    expect(
      diagnosis.files.filter((file) => file.reason === 'log-mismatch'),
    ).toEqual([
      { path: `${destination}/workspace.json`, reason: 'log-mismatch' },
      { path: `${destination}/worktrees.json`, reason: 'log-mismatch' },
    ]);
  });

  const rowIdentitySchema = z.object({
    worktrees: z.array(
      z.object({
        id: z.string(),
        createdAt: z.string(),
        label: z.string().optional(),
      }),
    ),
  });
  function rowIdentities(
    workspaceId: string,
  ): z.infer<typeof rowIdentitySchema>['worktrees'] {
    return rowIdentitySchema.parse(
      readJson(join(root, workspaceId, 'worktrees.json')),
    ).worktrees;
  }

  it.each([
    {
      kind: 'worktree-combine' as const,
      removals: ['a/worktrees.json', 'b/worktrees.json'],
      expected: [
        'workspace:a@0',
        'worktree:a/one@0',
        'workspace:b@0',
        'worktree:b/two@0',
      ],
      // Row 6 re-applies b's unremoved row; a's bytes already match it.
      restoreWrites: ['b/worktrees.json'],
    },
    {
      kind: 'workspace-combine' as const,
      removals: ['a/worktrees.json'],
      expected: ['workspace:a@0', 'worktree:a/one@0', 'workspace:b@0'],
      restoreWrites: [],
    },
  ])(
    '$kind: a foreign edit after its join record refuses the removal; rollback compensates only with unbound writes, the refused removal leaves no tombstone, and diagnosis reports recovery-required',
    async ({ kind, removals, expected, restoreWrites }) => {
      // Rollback's checkout removal scans every host process; not a record effect.
      jest
        .spyOn(processCleanup, 'terminateProcessesReferencingPath')
        .mockResolvedValue(0);
      const [one] = rowIdentities('a');
      const [two] = rowIdentities('b');
      if (!one || !two) throw new Error('Fixture rows missing');
      const files = [
        'index.json',
        ...['a', 'b', 'dest'].flatMap((id) => [
          `${id}/workspace.json`,
          `${id}/worktrees.json`,
        ]),
      ];
      const before = images();
      const operation = 'core.workspace.composition.combine';
      const decisions = recordDecisions();
      // Step 1's post-commit Portal notification runs outside its commit scope.
      let injected = false;
      jest.mocked(notifyPortalStructureChanged).mockImplementation(() => {
        const recorded = decisions.some(
          (decision) =>
            decision.operation === operation &&
            decision.files.includes('dest/worktrees.json') &&
            decision.refused === undefined,
        );
        if (injected || !recorded) return;
        injected = true;
        return updateWorkspaceWorktree('a', 'one', (row) => ({
          ...row,
          label: 'Foreign edit',
        }));
      });
      try {
        await expect(invoke(kind, 0, 'e7-removal')).rejects.toBeInstanceOf(
          W5RevisionConflictError,
        );
      } finally {
        // restoreAllMocks does not reset this factory mock.
        jest.mocked(notifyPortalStructureChanged).mockReset();
      }
      await expect(invoke(kind, 0, 'e7-removal')).rejects.toMatchObject({
        reason: 'recovery-required',
      });
      const plain = (file: string): RecordedDecision => ({
        operation: 'w5.worktree_list.write',
        files: [file],
        expected: [],
        bound: false,
      });
      expect(decisions).toEqual([
        { operation, files: ['dest/worktrees.json'], expected, bound: false },
        plain('a/worktrees.json'),
        {
          operation,
          files: removals,
          expected,
          bound: false,
          refused: 'revision-conflict',
        },
        // Row 4: the join undo removes the appended destination row.
        plain('dest/worktrees.json'),
        ...restoreWrites.map(plain),
      ]);

      const after = images();
      const rewritten = new Set([
        'a/worktrees.json',
        'dest/worktrees.json',
        ...restoreWrites,
      ]);
      expect(files.filter((_, i) => before[i] !== after[i])).toEqual(
        files.filter((file) => rewritten.has(file)),
      );
      expect(rowIdentities('a')).toEqual([{ ...one, label: 'Foreign edit' }]);
      expect(rowIdentities('b')).toEqual([two]);
      expect(rowIdentities('dest')).toEqual([]);
      // The refused removal's tombstones aborted; the applied undo's remains.
      expect(
        isWorkspaceWorktreeRecentlyRemoved('a', 'one', one.createdAt),
      ).toBe(false);
      expect(
        isWorkspaceWorktreeRecentlyRemoved('b', 'two', two.createdAt),
      ).toBe(false);
      expect(
        isWorkspaceWorktreeRecentlyRemoved('dest', 'one', one.createdAt),
      ).toBe(true);
      expect(checkouts(repo)).toEqual([
        realpathSync(repo),
        realpathSync(join(root, 'a', 'worktrees', 'one')),
      ]);
      expect(checkouts(join(dir, 'repo-b'))).toEqual([
        realpathSync(join(dir, 'repo-b')),
        realpathSync(join(root, 'b', 'worktrees', 'two')),
      ]);
      expect(existsSync(join(root, 'dest', 'worktrees', 'one'))).toBe(false);

      const diagnosis = await diagnoseOffline();
      expectRecoveryRequired(diagnosis, operation);
      expect(
        diagnosis.files.filter((file) => file.reason === 'log-mismatch'),
      ).toEqual([]);
    },
  );
});
