import { registerWorkspaceHandlers } from '../../ipc/workspaces';
import { computeWorkspaceReadinessIssues } from '../workspace-readiness';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
// Same real worker/filesystem harness as part 4, with production command callers.
import * as git from '../git';
import * as paths from '../paths';
import * as animals from '../animals';
import type { WorktreeCreationLifecycle } from '../worktree-creation';
import {
  claimWorktreeGitSetup,
  endWorktreeGitSetup,
} from '../worktree-git-setup';
import { readWorkspaceWorktrees } from '../workspace-persistence';
import { getWorktreeDir } from '../paths';
import type {
  WorktreeData,
  WorktreeHealthIssue,
  WorkspaceRepoData,
} from '@canopy/desktop-shared/types';
import type {
  SingleRepoWorktreeCreationOutcome,
  MultiRepoWorktreeCreationOutcome,
} from '../worktree-creation';
import * as sourceControl from '../workspace-source-control';
import * as windowSend from '../window-send';
import { inspectWorktreeCreationRecovery } from '../worktree-create-recovery';
import * as workspacePersistence from '../workspace-persistence';
import {
  readWorkspaceConfig,
  updateWorkspaceWorktrees,
  writeWorkspaceWorktrees,
} from '../workspace-persistence';
import { getWorkspaceWorktreeRepoDir } from '../paths';
import { reconcileGitPendingWorktrees } from '../worktree-boot-recovery';
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
const mockRepairHandlers = new Map<
  string,
  (event: unknown, request: unknown) => Promise<unknown>
>();
jest.mock('../../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, request: unknown) => Promise<unknown>,
  ): void => {
    mockRepairHandlers.set(channel, handler);
  },
}));
jest.mock('../../ipc/worktree-discovery', () => ({
  triggerDiscovery: jest.fn(),
}));
jest.mock('../../memory/local/import/import-job', () => ({
  enqueueWorkspaceLocalMemoryImportBatch: jest.fn(() => Promise.resolve()),
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

import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { WorktreeCreationRefusedError } from '../worktree-creation-selection';
import { createWorktreeFromSelection } from '../worktree-creation';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import { setBeforeProjectPluginDefaultsChangeHandler } from '../workspace-persistence';

jest.setTimeout(60_000);
let dir: string;
let root: string;
let repo: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;

beforeEach(() => {
  ({ dir, root, repo } = createW5BoundaryFixture());
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
  setBeforeProjectPluginDefaultsChangeHandler(undefined);
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

function restartHost(): void {
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  __resetSidebarItemsStateForTests();
}

function invoke(
  name = 'reserved',
  key?: string,
  lifecycle: Omit<WorktreeCreationLifecycle, 'workspaceId'> = {},
): Promise<SingleRepoWorktreeCreationOutcome> {
  return createWorktreeFromSelection({
    workspaceId: 'a',
    workspaceKind: 'single-repo',
    branch: { kind: 'new', branchName: name },
    base: { kind: 'repository-default' },
    allowBaseBranchNetwork: false,
    seedPanelLayoutMode: false,
    idempotencyKey: key,
    ...lifecycle,
  });
}

it('reserves a branch before Git so concurrent same-branch requests cannot both succeed', async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const create: typeof git.createWorktree = git.createWorktree;
  const adds = jest
    .spyOn(git, 'createWorktree')
    .mockImplementationOnce(async (...args) => {
      entered();
      await held;
      return create(...args);
    });
  const first = invoke();
  const firstSettled = Promise.allSettled([first]);
  await started;
  const second = invoke();
  // Let admission finish while the first request has not yet created a branch.
  const result = await second.then(
    () => 'created',
    (error: unknown) => error,
  );
  release();
  expect(await firstSettled).toMatchObject([{ status: 'fulfilled' }]);
  expect(result).toBeInstanceOf(WorktreeCreationRefusedError);
  expect(result).toMatchObject({ reason: 'branch-reserved' });
  expect(adds).toHaveBeenCalledTimes(1);
  expect(await readWorkspaceWorktrees('a')).toHaveLength(1);
});

it('retains an uncertain Git effect and its operation identity across restart and retry', async () => {
  const create: typeof git.createWorktree = git.createWorktree;
  jest.spyOn(git, 'createWorktree').mockImplementationOnce(async (...args) => {
    await create(...args);
    throw new Error('lost Git response');
  });
  await expect(invoke('interrupted', 'key')).rejects.toThrow(
    'lost Git response',
  );
  const rows = await readWorkspaceWorktrees('a');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    setupPhase: 'git-pending',
    creation: {
      state: 'recovery-required',
    },
  });
  expect(rows[0].creation?.operationId).toMatch(/^[a-f0-9-]{36}$/);
  expect(existsSync(getWorktreeDir('a', rows[0].id))).toBe(true);
  await host.shutdown();
  restartHost();
  await reconcileGitPendingWorktrees();
  expect(await readWorkspaceWorktrees('a')).toEqual(rows);
  await expect(invoke('interrupted', 'key')).rejects.toMatchObject({
    reason: 'recovery-required',
  });
});

function configureMulti(): WorkspaceRepoData[] {
  const repos = ['first', 'middle', 'last'].map((id) => {
    const repoPath = join(dir, id);
    execFileSync('git', ['clone', '-q', repo, repoPath]);
    return { id, name: id, repoPath };
  });
  writeFileSync(
    join(root, 'a', 'workspace.json'),
    JSON.stringify({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: repo,
      repos,
    }),
  );
  writeFileSync(
    join(root, 'index.json'),
    JSON.stringify({
      version: 1,
      workspaces: [
        {
          id: 'a',
          name: 'Multi',
          type: 'multi-repo',
          color: 'blue',
          order: 0,
        },
      ],
    }),
  );
  __resetSidebarItemsStateForTests();
  return repos;
}
function invokeMulti(
  repairWorkspaceRoot = true,
  key = 'multi-key',
): Promise<MultiRepoWorktreeCreationOutcome> {
  return createWorktreeFromSelection({
    workspaceId: 'a',
    workspaceKind: 'multi-repo',
    branch: { kind: 'new', branchName: 'multi' },
    base: { kind: 'repository-default' },
    repairWorkspaceRoot,
    surfaceNeedsRepairInResponse: true,
    allowBaseBranchNetwork: false,
    seedPanelLayoutMode: false,
    idempotencyKey: key,
  });
}

it.each(
  ['first', 'middle', 'last'].flatMap((id) =>
    [false, true].map((afterEffect) => ({ id, afterEffect })),
  ),
)(
  'retains all multi-repo identity when $id Git setup fails (afterEffect=$afterEffect)',
  async ({ id: failedId, afterEffect }) => {
    const repos = configureMulti();
    // Real source-root repair executes before the child Git effects.
    const create: typeof git.createWorktree = git.createWorktree;
    jest.spyOn(git, 'createWorktree').mockImplementation(async (...args) => {
      if (args[0] === repos.find((repo) => repo.id === failedId)?.repoPath) {
        if (afterEffect) await create(...args);
        throw new Error('child Git interrupted');
      }
      return create(...args);
    });
    await expect(invokeMulti()).rejects.toThrow('child Git interrupted');
    const rows = await readWorkspaceWorktrees('a');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      setupPhase: 'git-pending',
      creation: {
        state: 'recovery-required',
      },
    });
    expect(row.creation?.checkouts).toHaveLength(4);
    for (const child of repos) {
      expect(
        existsSync(getWorkspaceWorktreeRepoDir('a', row.id, child.id)),
      ).toBe(afterEffect || child.id !== failedId);
    }
    await host.shutdown();
    restartHost();
    await reconcileGitPendingWorktrees();
    expect(await readWorkspaceWorktrees('a')).toEqual(rows);
    await expect(invokeMulti()).rejects.toMatchObject({
      reason: 'recovery-required',
    });
  },
);

it.each([false, true])(
  'retains source-root repair failure (afterEffect=%s)',
  async (afterEffect) => {
    configureMulti();
    const repair = sourceControl.repairWorkspaceRootWorktree;
    jest
      .spyOn(sourceControl, 'repairWorkspaceRootWorktree')
      .mockImplementationOnce(async (...args) => {
        if (afterEffect) await repair(...args);
        throw new Error('repair interrupted');
      });
    await expect(invokeMulti()).rejects.toThrow('repair interrupted');
    const rows = await readWorkspaceWorktrees('a');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      setupPhase: 'git-pending',
      creation: {
        state: 'recovery-required',
        phase: 'source-root-repair',
      },
    });
    await host.shutdown();
    restartHost();
    await reconcileGitPendingWorktrees();
    expect(await readWorkspaceWorktrees('a')).toEqual(rows);
    await expect(invokeMulti()).rejects.toMatchObject({
      reason: 'recovery-required',
    });
  },
);

it('keeps needs-repair identity and replays its committed response without another checkout', async () => {
  configureMulti();
  const first = await invokeMulti(false);
  expect(first.status).toBe('needs-repair');
  const rows = await readWorkspaceWorktrees('a');
  expect(rows[0].creation?.state).toBe('recovery-required');
  await host.shutdown();
  restartHost();
  const adds = jest.spyOn(git, 'createWorktree');
  expect(await invokeMulti(false)).toEqual(first);
  expect(adds).not.toHaveBeenCalled();
  expect(await readWorkspaceWorktrees('a')).toEqual(rows);
});

it('reports an orphan checkout with repository, branch and path without adopting or deleting it', async () => {
  const checkoutPath = getWorktreeDir('a', 'orphan');
  mkdirSync(join(root, 'a', 'worktrees'), { recursive: true });
  execFileSync('git', [
    '-C',
    repo,
    'worktree',
    'add',
    '-q',
    '-b',
    'orphan',
    checkoutPath,
  ]);
  const before = execFileSync(
    'git',
    ['-C', repo, 'worktree', 'list', '--porcelain'],
    { encoding: 'utf8' },
  );
  await reconcileGitPendingWorktrees();
  expect(
    await inspectWorktreeCreationRecovery('a', await readWorkspaceConfig('a')),
  ).toMatchObject([
    {
      code: 'recovery-required',
      recovery: {
        phase: 'orphan-checkout',
        checkoutPath,
        repositoryPath: repo,
        branchName: 'orphan',
      },
    },
  ]);
  expect(await readWorkspaceWorktrees('a')).toEqual([]);
  expect(
    execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
    }),
  ).toBe(before);
  expect(existsSync(checkoutPath)).toBe(true);
});

it('preserves every concurrent create row and unrelated fields', async () => {
  await updateWorkspaceWorktrees('a', (rows) => [
    {
      id: 'sentinel',
      branchName: 'sentinel',
      createdAt: new Date().toISOString(),
      label: 'Keep',
    },
    ...rows,
  ]);
  const outcomes = await Promise.all(
    ['one', 'two', 'three'].map((name) => invoke(name)),
  );
  const rows = await readWorkspaceWorktrees('a');
  expect(rows).toHaveLength(4);
  expect(rows.find((row) => row.id === 'sentinel')?.label).toBe('Keep');
  for (const outcome of outcomes) {
    expect(
      rows.find((row) => row.id === outcome.record.worktreeId)?.creation?.state,
    ).toBe('complete');
  }
});

it.each([
  'before-reserve',
  'after-reserve',
  'before-row',
  'after-row',
  'before-receipt',
  'after-receipt',
])(
  'recovers the original keyed outcome after interruption at %s',
  async (point) => {
    const reserve = host.reserve.bind(host);
    if (point === 'before-reserve' || point === 'after-reserve') {
      jest.spyOn(host, 'reserve').mockImplementationOnce(async (request) => {
        if (point === 'after-reserve') await reserve(request);
        throw new Error('interrupted');
      });
    } else {
      const commit = host.commit.bind(host);
      jest.spyOn(host, 'commit').mockImplementation(async (request) => {
        const target = point.endsWith('receipt')
          ? !!request.receipt
          : !request.receipt;
        if (!target) return commit(request);
        if (point.startsWith('after')) await commit(request);
        throw new Error('interrupted');
      });
    }
    await expect(invoke('fault', 'fault-key')).rejects.toThrow('interrupted');
    await host.shutdown();
    jest.restoreAllMocks();
    restartHost();
    await reconcileGitPendingWorktrees();
    const rows = await readWorkspaceWorktrees('a');
    const adds = jest.spyOn(git, 'createWorktree');
    if (point === 'before-reserve') {
      expect(await invoke('fault', 'fault-key')).toMatchObject({
        status: 'created',
      });
    } else if (point === 'after-receipt') {
      expect(await invoke('fault', 'fault-key')).toMatchObject({
        status: 'created',
      });
      expect(adds).not.toHaveBeenCalled();
    } else {
      await expect(invoke('fault', 'fault-key')).rejects.toMatchObject({
        reason: 'recovery-required',
      });
      expect(await readWorkspaceWorktrees('a')).toEqual(rows);
      expect(adds).not.toHaveBeenCalled();
    }
  },
);

it('does not change a replacement incarnation while exposing interrupted create recovery', async () => {
  const { reconcileWorktreeRecovery } = await import('../worktree-repair');
  const first = await invoke();
  const row = (await readWorkspaceWorktrees('a'))[0];
  await updateWorkspaceWorktrees('a', (rows) =>
    rows.map((entry) => ({
      ...entry,
      createdAt: 'replacement',
      label: 'Keep',
    })),
  );
  await reconcileWorktreeRecovery({
    kind: 'expose-create-reservation',
    workspaceId: 'a',
    worktreeId: first.record.worktreeId,
    createdAt: row.createdAt,
    operationId: row.creation?.operationId ?? '',
    worktreePath: getWorktreeDir('a', row.id),
  });
  expect((await readWorkspaceWorktrees('a'))[0]).toMatchObject({
    createdAt: 'replacement',
    label: 'Keep',
    creation: { state: 'complete' },
  });
});

it('refuses an occupied checkout path before its Git effect and leaves unrelated files intact', async () => {
  jest.spyOn(animals, 'generateUniqueAnimalName').mockReturnValue('occupied');
  const path = getWorktreeDir('a', 'occupied');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'keep'), 'user-owned');
  const adds = jest.spyOn(git, 'createWorktree');
  await expect(invoke()).rejects.toMatchObject({ reason: 'checkout-reserved' });
  expect(adds).not.toHaveBeenCalled();
  expect(existsSync(join(path, 'keep'))).toBe(true);
  expect(await readWorkspaceWorktrees('a')).toHaveLength(0);
});

it('never acknowledges a second deferred same-branch create while the first Git effect is held', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const create = git.createWorktree;
  jest.spyOn(git, 'createWorktree').mockImplementationOnce(async (...args) => {
    await held;
    return create(...args);
  });
  const first = await invoke('deferred', 'deferred-key', {
    deferGitSetup: true,
  });
  const settled = claimWorktreeGitSetup('a', first.record.worktreeId);
  try {
    await expect(
      invoke('deferred', undefined, { deferGitSetup: true }),
    ).rejects.toMatchObject({ reason: 'branch-reserved' });
  } finally {
    release();
  }
  expect(await settled).toBe('ready');
  endWorktreeGitSetup('a', first.record.worktreeId);
  expect(await readWorkspaceWorktrees('a')).toHaveLength(1);
  await host.shutdown();
  restartHost();
  const adds = jest.spyOn(git, 'createWorktree').mockClear();
  expect(
    await invoke('deferred', 'deferred-key', { deferGitSetup: true }),
  ).toEqual(first);
  expect(adds).not.toHaveBeenCalled();
});

it('keeps failed deferred Git setup pending across renderer saves and restart', async () => {
  jest
    .spyOn(git, 'createWorktree')
    .mockRejectedValueOnce(new Error('Git refused'));
  const first = await invoke('failed-deferred', undefined, {
    deferGitSetup: true,
  });
  expect(await claimWorktreeGitSetup('a', first.record.worktreeId)).toBe(
    'failed',
  );
  endWorktreeGitSetup('a', first.record.worktreeId);
  const rows = await readWorkspaceWorktrees('a');
  expect(rows[0]).toMatchObject({
    setupPhase: 'git-pending',
    creation: { state: 'recovery-required' },
  });
  const healthIssue: WorktreeHealthIssue = {
    status: 'broken',
    code: 'git-error',
    message: 'Renderer deferred setup failure',
    checkedAt: new Date().toISOString(),
    worktreePath: getWorktreeDir('a', first.record.worktreeId),
  };
  await writeWorkspaceWorktrees('a', [
    { ...rows[0], setupPhase: 'git-ready', healthIssue },
  ]);
  await host.shutdown();
  restartHost();
  expect(await readWorkspaceWorktrees('a')).toEqual([
    { ...rows[0], healthIssue },
  ]);
  const reconcile = jest.spyOn(
    await import('../worktree-repair'),
    'reconcileWorktreeRecovery',
  );
  await reconcileGitPendingWorktrees();
  expect(reconcile).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'expose-create-reservation',
      worktreeId: first.record.worktreeId,
      operationId: rows[0].creation?.operationId,
    }),
  );
  expect(
    await inspectWorktreeCreationRecovery('a', await readWorkspaceConfig('a')),
  ).toMatchObject([
    {
      recovery: {
        worktreeId: first.record.worktreeId,
        operationId: rows[0].creation?.operationId,
      },
    },
  ]);
});

it('reserves the checkout path atomically even when branches differ', async () => {
  const checkout = getWorktreeDir('a', 'shared-path');
  jest.spyOn(paths, 'getWorktreeDir').mockReturnValue(checkout);
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const create = git.createWorktree;
  jest.spyOn(git, 'createWorktree').mockImplementationOnce(async (...args) => {
    entered();
    await held;
    return create(...args);
  });
  const first = invoke('first-path');
  const result = Promise.allSettled([first]);
  await started;
  try {
    await expect(invoke('second-path')).rejects.toMatchObject({
      reason: 'checkout-reserved',
    });
  } finally {
    release();
  }
  expect(await result).toMatchObject([{ status: 'fulfilled' }]);
  expect(await readWorkspaceWorktrees('a')).toHaveLength(1);
});

it.each([false, true])(
  'retains source-root Git failure (afterEffect=%s)',
  async (afterEffect) => {
    configureMulti();
    const create = git.createWorktree;
    jest
      .spyOn(git, 'createWorktree')
      .mockImplementationOnce(async (...args) => {
        if (afterEffect) await create(...args);
        throw new Error('root Git interrupted');
      });
    await expect(invokeMulti()).rejects.toThrow('root Git interrupted');
    const rows = await readWorkspaceWorktrees('a');
    expect(rows[0]).toMatchObject({
      setupPhase: 'git-pending',
      creation: { state: 'recovery-required', phase: 'git-setup' },
    });
    expect(existsSync(getWorktreeDir('a', rows[0].id))).toBe(afterEffect);
    await host.shutdown();
    restartHost();
    await reconcileGitPendingWorktrees();
    expect(await readWorkspaceWorktrees('a')).toEqual(rows);
    await expect(invokeMulti()).rejects.toMatchObject({
      reason: 'recovery-required',
    });
  },
);

it('refuses a partial list before checkout effects without rewriting unreadable rows', async () => {
  const path = join(root, 'a', 'worktrees.json');
  const contents = JSON.stringify({
    version: 1,
    worktrees: [{ id: 'unreadable', keep: 'unknown' }],
  });
  writeFileSync(path, contents);
  const adds = jest.spyOn(git, 'createWorktree');
  await expect(invoke()).rejects.toThrow('Worktree registry is unreadable');
  expect(adds).not.toHaveBeenCalled();
  expect(await host.recoveryReport()).toBeDefined();
  expect(
    await import('node:fs/promises').then((fs) => fs.readFile(path, 'utf8')),
  ).toBe(contents);
});

it.each(
  ['missing', 'not-git'].flatMap((state) =>
    ['source', 'child'].map((target) => ({ state, target })),
  ),
)(
  'keeps readiness and persisted recovery diagnostics when $target repository is $state',
  async ({ state, target }) => {
    configureMulti();
    const created = await invokeMulti(false);
    expect(created.status).toBe('needs-repair');
    const badPath = join(dir, 'unavailable');
    if (state === 'not-git') mkdirSync(badPath);
    const config = await readWorkspaceConfig('a');
    if (target === 'source') config.sourceRepoPath = badPath;
    else config.repos[1].repoPath = badPath;
    writeFileSync(join(root, 'a', 'workspace.json'), JSON.stringify(config));
    const issues = await computeWorkspaceReadinessIssues('a');
    expect(issues.some((issue) => issue.code === 'recovery-required')).toBe(
      true,
    );
    expect(
      issues.some(
        (issue) =>
          issue.code === 'configure-hooks' && issue.repoName === 'last',
      ),
    ).toBe(true);
    await host.shutdown();
    restartHost();
    await reconcileGitPendingWorktrees();
    expect(
      (await computeWorkspaceReadinessIssues('a')).some(
        (issue) => issue.code === 'recovery-required',
      ),
    ).toBe(true);
  },
);

it('completes a retained creation through approved source-root repair before acknowledging it', async () => {
  configureMulti();
  const created = await invokeMulti(false);
  if (created.status !== 'needs-repair')
    throw new Error('Expected a retained repair reservation');
  const before = (await readWorkspaceWorktrees('a'))[0];
  registerWorkspaceHandlers(() => null, {
    dispatcher: {
      queryWorktreeListForLegacyIpc: async ({
        scope,
      }: {
        scope?: { workspaceId?: string };
      }) => ({
        canonicalResult: null,
        legacyResult: await readWorkspaceWorktrees(scope?.workspaceId ?? ''),
      }),
    },
    resolveCaller: () => ({
      principalId: 'test-user',
      clientInstanceId: 'test-client',
      authorityId: 'local-desktop',
      interfaceKind: 'test',
      grants: ['core.worktree.read'],
    }),
  });
  const repair = mockRepairHandlers.get(IPC_CHANNELS.workspaceRepairWorktree);
  if (!repair) throw new Error('Repair handler was not registered');
  const response = await repair(
    {},
    {
      workspaceId: 'a',
      worktreeId: created.worktreeId,
      branchName: created.branchName,
      restoreClaudeMd: false,
    },
  );
  // The retained row is completed in place, not registered again.
  expect(await readWorkspaceWorktrees('a')).toHaveLength(1);
  expect(response).toMatchObject({ createdAt: before.createdAt });
  const row = (await readWorkspaceWorktrees('a'))[0];
  expect(row).toMatchObject({
    setupPhase: 'git-ready',
    creation: {
      state: 'complete',
      phase: 'git-ready',
      operationId: before.creation?.operationId,
    },
  });
  for (const checkout of row.creation?.checkouts ?? [])
    expect(
      await git.isRegisteredWorktreePath(
        checkout.repositoryPath,
        checkout.checkoutPath,
      ),
    ).toBe(true);
  expect(
    (await computeWorkspaceReadinessIssues('a')).filter(
      (issue) => issue.code === 'recovery-required',
    ),
  ).toEqual([]);
  await host.shutdown();
  restartHost();
  await reconcileGitPendingWorktrees();
  expect((await readWorkspaceWorktrees('a'))[0]).toEqual(row);
  expect(
    (await computeWorkspaceReadinessIssues('a')).filter(
      (issue) => issue.code === 'recovery-required',
    ),
  ).toEqual([]);
});

it('marks recovery readiness evidence as having no Fix launcher', async () => {
  configureMulti();
  await invokeMulti(false);
  const issues = await inspectWorktreeCreationRecovery(
    'a',
    await readWorkspaceConfig('a'),
  );
  expect(issues.length).toBeGreaterThan(0);
  for (const issue of issues) expect(issue.fixPrompt).toBeNull();
});

it('reports readable recovery rows from a partial worktree registry', async () => {
  await invoke('partial');
  const row = (await readWorkspaceWorktrees('a'))[0];
  const recoveryRow = {
    ...row,
    creation: {
      operationId: 'partial-operation',
      state: 'recovery-required' as const,
      phase: 'git-setup' as const,
      checkouts: [
        { repositoryPath: repo, checkoutPath: getWorktreeDir('a', row.id) },
      ],
    },
    setupPhase: 'git-pending' as const,
  };
  jest
    .spyOn(workspacePersistence, 'readWorkspaceWorktreesDetailed')
    .mockResolvedValueOnce({
      worktrees: [recoveryRow],
      authority: 'partial',
    });
  await expect(
    inspectWorktreeCreationRecovery('a', await readWorkspaceConfig('a')),
  ).resolves.toMatchObject([
    {
      code: 'recovery-required',
      recovery: { operationId: 'partial-operation' },
    },
  ]);
});

it.each([
  ['an excluded child repository', ['first'], 'middle'],
  ['a root-only worktree', [], 'first'],
] as const)(
  'reports a registered checkout for %s as an orphan',
  async (_case, includedRepoIds, strayRepoId) => {
    const repos = configureMulti();
    const stray = repos.find((entry) => entry.id === strayRepoId);
    if (!stray) throw new Error('Missing fixture repository');
    const row: WorktreeData = {
      id: 'scoped',
      branchName: 'scoped-branch',
      createdAt: '2026-01-01T00:00:00.000Z',
      includedRepoIds: [...includedRepoIds],
    };
    const strayPath = getWorkspaceWorktreeRepoDir('a', row.id, strayRepoId);
    execFileSync('git', [
      '-C',
      stray.repoPath,
      'worktree',
      'add',
      '-q',
      '-b',
      'stray-branch',
      strayPath,
    ]);
    const issues = await inspectWorktreeCreationRecovery(
      'a',
      await readWorkspaceConfig('a'),
      [row],
    );
    expect(
      issues.map((entry) => [
        entry.recovery?.phase,
        entry.recovery?.checkoutPath,
      ]),
    ).toContainEqual(['orphan-checkout', strayPath]);
  },
);

it('does not claim Git kept a checkout for a reserved creation', async () => {
  configureMulti();
  const row: WorktreeData = {
    id: 'reserved',
    branchName: 'reserved-branch',
    createdAt: '2026-01-01T00:00:00.000Z',
    creation: {
      operationId: 'reserved-operation',
      state: 'recovery-required',
      phase: 'reserved',
      checkouts: [],
    },
  };
  const issues = await inspectWorktreeCreationRecovery(
    'a',
    await readWorkspaceConfig('a'),
    [row],
  );
  const reserved = issues.find(
    (entry) => entry.recovery?.operationId === 'reserved-operation',
  );
  expect(reserved?.message).toBeDefined();
  expect(reserved?.message).not.toMatch(/Git registration have been kept/);
});

it.each([
  ['a partial selection', ['first']],
  ['a root-only selection', []],
] as const)(
  'repairs only the repositories in %s',
  async (_case, includedRepoIds) => {
    const repos = configureMulti();
    const created = await invokeMulti(false);
    if (created.status !== 'needs-repair')
      throw new Error('Expected a retained repair reservation');
    await updateWorkspaceWorktrees('a', (rows) =>
      rows.map((row) =>
        row.id === created.worktreeId
          ? { ...row, includedRepoIds: [...includedRepoIds] }
          : row,
      ),
    );
    registerWorkspaceHandlers(() => null, {
      dispatcher: {
        queryWorktreeListForLegacyIpc: async ({
          scope,
        }: {
          scope?: { workspaceId?: string };
        }) => ({
          canonicalResult: null,
          legacyResult: await readWorkspaceWorktrees(scope?.workspaceId ?? ''),
        }),
      },
      resolveCaller: () => ({
        principalId: 'test-user',
        clientInstanceId: 'test-client',
        authorityId: 'local-desktop',
        interfaceKind: 'test',
        grants: ['core.worktree.read'],
      }),
    });
    const repair = mockRepairHandlers.get(IPC_CHANNELS.workspaceRepairWorktree);
    if (!repair) throw new Error('Repair handler was not registered');
    await repair(
      {},
      {
        workspaceId: 'a',
        worktreeId: created.worktreeId,
        branchName: created.branchName,
        restoreClaudeMd: false,
      },
    );
    for (const repo of repos) {
      expect(
        existsSync(
          getWorkspaceWorktreeRepoDir('a', created.worktreeId, repo.id),
        ),
      ).toBe(includedRepoIds.some((repoId) => repoId === repo.id));
    }
    expect((await readWorkspaceWorktrees('a'))[0]).toMatchObject({
      setupPhase: 'git-ready',
      creation: { state: 'complete' },
    });
  },
);

it('refuses repair when a replacement incarnation appears during root repair', async () => {
  configureMulti();
  const created = await invokeMulti(false);
  if (created.status !== 'needs-repair')
    throw new Error('Expected retained repair');
  registerWorkspaceHandlers(() => null, {
    dispatcher: {
      queryWorktreeListForLegacyIpc: async ({
        scope,
      }: {
        scope?: { workspaceId?: string };
      }) => ({
        canonicalResult: null,
        legacyResult: await readWorkspaceWorktrees(scope?.workspaceId ?? ''),
      }),
    },
    resolveCaller: () => ({
      principalId: 'test-user',
      clientInstanceId: 'test-client',
      authorityId: 'local-desktop',
      interfaceKind: 'test',
      grants: ['core.worktree.read'],
    }),
  });
  const repair = mockRepairHandlers.get(IPC_CHANNELS.workspaceRepairWorktree);
  if (!repair) throw new Error('Repair handler was not registered');
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  jest
    .spyOn(sourceControl, 'repairWorkspaceRootWorktree')
    .mockImplementation(async () => {
      entered();
      await gate;
      return [];
    });
  const before = (await readWorkspaceWorktrees('a'))[0];
  const gitCheckouts = [
    jest.spyOn(git, 'createWorktree'),
    jest.spyOn(git, 'createWorktreeForExistingBranch'),
    jest.spyOn(git, 'createWorktreeFromStartPoint'),
  ];
  const repairing = repair(
    {},
    {
      workspaceId: 'a',
      worktreeId: created.worktreeId,
      branchName: created.branchName,
      restoreClaudeMd: false,
    },
  );
  await started;
  const replacement = {
    ...before,
    createdAt: new Date(Date.parse(before.createdAt) + 1000).toISOString(),
    creation: undefined,
    setupPhase: 'git-ready' as const,
  };
  delete replacement.creation;
  await updateWorkspaceWorktrees('a', () => [replacement]);
  release();
  await expect(repairing).rejects.toThrow(/changed|recovery/i);
  expect(await readWorkspaceWorktrees('a')).toEqual([replacement]);
  // No child Git checkout was attempted for the replacement incarnation.
  for (const checkout of gitCheckouts) expect(checkout).not.toHaveBeenCalled();
});

it('does not treat an unregistered child directory as repaired', async () => {
  configureMulti();
  const created = await invokeMulti(false);
  if (created.status !== 'needs-repair')
    throw new Error('Expected retained repair');
  const before = (await readWorkspaceWorktrees('a'))[0];
  const child = getWorkspaceWorktreeRepoDir('a', created.worktreeId, 'first');
  mkdirSync(child, { recursive: true });
  registerWorkspaceHandlers(() => null, {
    dispatcher: {
      queryWorktreeListForLegacyIpc: async ({
        scope,
      }: {
        scope?: { workspaceId?: string };
      }) => ({
        canonicalResult: null,
        legacyResult: await readWorkspaceWorktrees(scope?.workspaceId ?? ''),
      }),
    },
    resolveCaller: () => ({
      principalId: 'test-user',
      clientInstanceId: 'test-client',
      authorityId: 'local-desktop',
      interfaceKind: 'test',
      grants: ['core.worktree.read'],
    }),
  });
  const repair = mockRepairHandlers.get(IPC_CHANNELS.workspaceRepairWorktree);
  if (!repair) throw new Error('Repair handler was not registered');
  await expect(
    repair(
      {},
      {
        workspaceId: 'a',
        worktreeId: created.worktreeId,
        branchName: created.branchName,
        restoreClaudeMd: false,
      },
    ),
  ).rejects.toThrow();
  expect(await readWorkspaceWorktrees('a')).toMatchObject([
    {
      id: created.worktreeId,
      setupPhase: 'git-pending',
      creation: { state: 'recovery-required' },
    },
  ]);
  expect(existsSync(child)).toBe(true);
  expect(await git.isRegisteredWorktreePath(repo, child)).toBe(false);
  expect((await readWorkspaceWorktrees('a'))[0]?.createdAt).toBe(
    before.createdAt,
  );
});

it('announces readiness once when an approved repair completes a retained creation', async () => {
  configureMulti();
  const created = await invokeMulti(false);
  if (created.status !== 'needs-repair')
    throw new Error('Expected retained repair');
  const sends = jest
    .spyOn(windowSend, 'sendToWindow')
    .mockReturnValue({ delivered: true });
  registerWorkspaceHandlers(() => null, {
    dispatcher: {
      queryWorktreeListForLegacyIpc: async ({
        scope,
      }: {
        scope?: { workspaceId?: string };
      }) => ({
        canonicalResult: null,
        legacyResult: await readWorkspaceWorktrees(scope?.workspaceId ?? ''),
      }),
    },
    resolveCaller: () => ({
      principalId: 'test-user',
      clientInstanceId: 'test-client',
      authorityId: 'local-desktop',
      interfaceKind: 'test',
      grants: ['core.worktree.read'],
    }),
  });
  const repair = mockRepairHandlers.get(IPC_CHANNELS.workspaceRepairWorktree);
  if (!repair) throw new Error('Repair handler was not registered');
  const request = {
    workspaceId: 'a',
    worktreeId: created.worktreeId,
    branchName: created.branchName,
    restoreClaudeMd: false,
  };

  await repair({}, request);

  const row = (await readWorkspaceWorktrees('a'))[0];
  expect(row).toMatchObject({
    setupPhase: 'git-ready',
    creation: { state: 'complete' },
  });
  const readyEvents = (): unknown[] =>
    sends.mock.calls
      .filter(([, channel]) => channel === IPC_CHANNELS.worktreeGitReady)
      .map(([, , payload]) => payload);
  expect(readyEvents()).toEqual([
    { projectId: 'a', worktreeId: row.id, branchName: row.branchName },
  ]);

  // A repeated repair finds the journal already complete and makes no new
  // readiness decision, so the renderer is not asked to flush again.
  await repair({}, request);
  expect(readyEvents()).toHaveLength(1);
});

it('describes each recovery checkout with its branch and path', async () => {
  for (const name of ['alpha', 'beta']) {
    const checkoutPath = getWorktreeDir('a', name);
    execFileSync('git', [
      '-C',
      repo,
      'worktree',
      'add',
      '-q',
      '-b',
      name,
      checkoutPath,
    ]);
  }
  const issues = await inspectWorktreeCreationRecovery(
    'a',
    await readWorkspaceConfig('a'),
  );
  expect(issues).toHaveLength(2);
  for (const issue of issues) {
    expect(issue.message).toContain(issue.recovery?.checkoutPath);
    expect(issue.message).toContain(issue.recovery?.branchName);
  }
});
