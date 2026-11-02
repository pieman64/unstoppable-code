import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
// Same real worker/filesystem harness as part 4, with production command callers.
import { W5CommitLog } from '@canopy/desktop-shared/node/w5-commit-log';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import {
  projectW5WorkspaceCreationOutcome,
  projectW5WorktreeCreationOutcome,
  w5StoredOutcomeForm,
} from '@canopy/core-runtime/node/w5/stored-outcome-projection';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
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
}));

import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { withStorageAdmission, PROJECT_W5_STORAGE } from '../w5-storage';
import type { WorkspaceCreationReceiptOutcome } from '../workspace-creation';
import type { WorktreeCreationOutcome } from '../worktree-creation';
import {
  createWorkspace,
  type WorkspaceCreationRequest,
} from '../workspace-creation';
import { WorkspaceCreationRefusedError } from '../workspace-creation-refusal';
import { WorktreeCreationRefusedError } from '../worktree-creation-selection';
import { createWorktreeFromSelection } from '../worktree-creation';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import * as coworkWorkEntries from '../cowork-work-entries';
import { setBeforeProjectPluginDefaultsChangeHandler } from '../workspace-persistence';
import { installW5StoreSide, W5_STORE_SIDES } from './fixtures/w5-store-sides';

jest.setTimeout(60_000);
let dir: string;
let root: string;
let repo: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;

beforeEach(() => {
  ({ dir, root, repo } = createW5BoundaryFixture());
  execFileSync('git', ['clone', '-q', repo, join(dir, 'import-repo')]);
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

function snapshot(path = join(dir, 'data')): unknown {
  return readdirSync(path, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => [
      entry.name,
      entry.isDirectory()
        ? snapshot(join(path, entry.name))
        : readFileSync(join(path, entry.name), 'utf8'),
    ]);
}
const cases = ['create', 'import', 'worktree'] as const;
function invoke(
  kind: (typeof cases)[number],
  name = 'Created',
  expectedRevision?: number,
): Promise<WorkspaceCreationReceiptOutcome | WorktreeCreationOutcome> {
  if (kind === 'worktree')
    return createWorktreeFromSelection({
      workspaceId: 'a',
      workspaceKind: 'single-repo',
      branch: { kind: 'new', branchName: name },
      base: { kind: 'repository-default' },
      allowBaseBranchNetwork: false,
      seedPanelLayoutMode: false,
      idempotencyKey: 'key',
      expectedRevision,
    });
  return createWorkspace({
    source: kind === 'create' ? 'new_multi_repo' : 'import_from_repo',
    variant:
      kind === 'create'
        ? { kind: 'new-multi-repo', name }
        : {
            kind: 'repository-without-manifest',
            repoPath: join(dir, 'import-repo'),
            name,
          },
    idempotencyKey: 'key',
    expectedRevision,
  });
}
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

  async function restartHost(): Promise<void> {
    await teardown();
    host = new W5CommitLogHost({
      dbPath: join(dir, 'w5', 'commit-log.sqlite'),
      root,
      workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
    });
    __resetSidebarItemsStateForTests();
    teardown = await installW5StoreSide(side, {
      host,
      root,
      setDaemonOwned: setDaemonOwnedForTest,
    });
  }
  /** A failed decision call: the daemon reports it uncertain, with fixed text. */
  const uncertain = (message: string): string =>
    side === 'daemon' ? 'The W5 record port call failed.' : message;
  /** The original failure in-process; the daemon's uncertain internal error. */
  async function expectFailure(
    pending: Promise<unknown>,
    error: Error,
  ): Promise<void> {
    if (side === 'in-process') await expect(pending).rejects.toBe(error);
    else
      await expect(pending).rejects.toMatchObject({
        payload: { kind: 'internal' },
      });
  }

  it.each(cases)(
    '%s replays a saved outcome without effects or another commit, before revisions',
    async (kind) => {
      const commits = jest.spyOn(host, 'commit');
      const first = await invoke(kind);
      const before = snapshot();
      const gitBefore = execFileSync(
        'git',
        ['-C', repo, 'worktree', 'list', '--porcelain'],
        { encoding: 'utf8' },
      );
      const count = commits.mock.calls.length;
      expect(await invoke(kind, 'Created', 999)).toEqual(first);
      expect(snapshot()).toEqual(before);
      expect(
        execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {
          encoding: 'utf8',
        }),
      ).toBe(gitBefore);
      expect(commits).toHaveBeenCalledTimes(count);
      const saved = commits.mock.calls.find(
        ([request]) => request.receipt,
      )?.[0];
      expect(saved?.reservationId).toEqual(expect.any(String));
      expect(JSON.stringify(saved?.outcome)).not.toContain(dir);
    },
  );
  it.each(cases)(
    '%s refuses changed parameters before effects',
    async (kind) => {
      await invoke(kind);
      const before = snapshot();
      const pending = invoke(kind, 'Different');
      await expect(pending).rejects.toBeInstanceOf(W5CommitRefusedError);
      await expect(pending).rejects.toMatchObject({ reason: 'key-reused' });
      expect(snapshot()).toEqual(before);
    },
  );
  it.each(cases)(
    '%s retains an interrupted reservation after restart without resuming',
    async (kind) => {
      jest.spyOn(host, 'commit').mockImplementationOnce(async () => {
        await host.shutdown();
        throw new Error('interrupted before decision');
      });
      await expect(invoke(kind)).rejects.toThrow(
        uncertain('interrupted before decision'),
      );
      await restartHost();
      const before = snapshot();
      const commits = jest.spyOn(host, 'commit');
      await expect(invoke(kind)).rejects.toMatchObject({
        reason: 'recovery-required',
      });
      expect(snapshot()).toEqual(before);
      expect(commits).not.toHaveBeenCalled();
    },
  );
  it.each(cases)(
    '%s recovers a decision interrupted before application and replays',
    async (kind) => {
      let saved: unknown;
      const commit = host.commit.bind(host);
      jest.spyOn(host, 'commit').mockImplementation(async (request) => {
        if (!request.receipt) return commit(request);
        await host.shutdown();
        const log = W5CommitLog.open(join(dir, 'w5', 'commit-log.sqlite'));
        try {
          log.commit(request);
          saved = request.outcome;
        } finally {
          log.close();
        }
        throw new Error('interrupted after decision');
      });
      await expect(invoke(kind)).rejects.toThrow(
        uncertain('interrupted after decision'),
      );
      await restartHost();
      expect((await host.recoveryReport()).applied).toHaveLength(1);
      const before = snapshot();
      const commits = jest.spyOn(host, 'commit');
      expect(await invoke(kind)).toEqual(saved);
      expect(snapshot()).toEqual(before);
      expect(commits).not.toHaveBeenCalled();
    },
  );

  it.each(cases)(
    '%s refuses a live same-key reservation before effects',
    async (kind) => {
      const reserve = host.reserve.bind(host);
      let resume: () => void = () => {};
      let reserved: () => void = () => {};
      const reached = new Promise<void>((resolve) => {
        reserved = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        resume = resolve;
      });
      jest.spyOn(host, 'reserve').mockImplementationOnce(async (input) => {
        await reserve(input);
        reserved();
        await blocked;
      });
      const before = snapshot();
      const first = invoke(kind);
      await reached;
      try {
        expect(snapshot()).toEqual(before);
        await expect(invoke(kind)).rejects.toMatchObject({
          reason: 'in-progress',
        });
        expect(snapshot()).toEqual(before);
      } finally {
        resume();
        await first;
      }
    },
  );
  it.each(cases)(
    '%s refuses an expired replay without effects',
    async (kind) => {
      await invoke(kind);
      await host.shutdown();
      const log = W5CommitLog.open(join(dir, 'w5', 'commit-log.sqlite'), {
        clock: () => Date.now() + 31 * 24 * 60 * 60 * 1000,
      });
      try {
        expect(log.compact()).toBeGreaterThan(0);
      } finally {
        log.close();
      }
      await restartHost();
      const before = snapshot();
      const commits = jest.spyOn(host, 'commit');
      await expect(invoke(kind)).rejects.toMatchObject({
        reason: 'outcome-expired',
      });
      expect(snapshot()).toEqual(before);
      expect(commits).not.toHaveBeenCalled();
    },
  );

  // CAN-5428 (W5a3, RR4): the first response and a replay after restart project
  // the saved receipt identically, with no host path.
  it.each(cases)(
    '%s projects its first response and its replay identically',
    async (kind) => {
      const project = (stored: unknown): unknown =>
        kind === 'worktree'
          ? projectW5WorktreeCreationOutcome(stored, { workspaceId: 'a' })
          : projectW5WorkspaceCreationOutcome(stored);
      const commits = jest.spyOn(host, 'commit');
      const first = project(w5StoredOutcomeForm(await invoke(kind)));
      const receipt = commits.mock.calls.find(
        ([request]) => request.receipt,
      )?.[0].receipt;
      if (!receipt) throw new Error('Expected a keyed decision');
      await host.shutdown();
      await restartHost();
      const lookup = await host.lookupReceipt(receipt);
      if (lookup.status !== 'replay')
        throw new Error('Expected a saved receipt');
      expect(project(lookup.outcome)).toStrictEqual(first);
      expect(project(w5StoredOutcomeForm(await invoke(kind)))).toStrictEqual(
        first,
      );
      expect(JSON.stringify(first)).not.toContain(dir);
    },
  );

  it('folder import replays its portable outcome even when the source folder has gone', async () => {
    const request = {
      source: 'folder',
      variant: { kind: 'local-folder', folderPath: join(dir, 'import-repo') },
      idempotencyKey: 'folder-key',
    } as const;
    const first = await createWorkspace(request);
    rmSync(request.variant.folderPath, { recursive: true, force: true });
    const before = snapshot();
    const commits = jest.spyOn(host, 'commit');
    expect(await createWorkspace(request)).toEqual(first);
    expect(snapshot()).toEqual(before);
    expect(commits).not.toHaveBeenCalled();
  });

  it('an unkeyed local create inside a keyed worktree callback retains its own interrupted effects', async () => {
    await withStorageAdmission(PROJECT_W5_STORAGE, () =>
      createWorktreeFromSelection({
        workspaceId: 'a',
        workspaceKind: 'single-repo',
        idempotencyKey: 'callback-key',
        branch: { kind: 'new', branchName: 'callback' },
        base: { kind: 'repository-default' },
        allowBaseBranchNetwork: false,
        seedPanelLayoutMode: false,
        beforeGitReady: async () => {
          await expect(
            createWorkspace({
              source: 'new_multi_repo',
              variant: { kind: 'new-multi-repo', name: 'Nested' },
              expectedRevision: 999,
            }),
          ).rejects.toMatchObject({ reason: 'revision-conflict' });
        },
      }),
    );
    expect(existsSync(join(dir, 'data', 'repos', 'nested'))).toBe(true);
    expect(existsSync(join(root, 'nested'))).toBe(true);
  });

  it.each(cases)(
    '%s releases a proven pre-effect refusal so the same key can succeed',
    async (kind) => {
      const before = snapshot();
      if (kind === 'create') {
        const request: WorkspaceCreationRequest = {
          source: 'new_multi_repo',
          variant: { kind: 'new-multi-repo', name: 'Created' },
          idempotencyKey: 'key',
        };
        const reserve = host.reserve.bind(host);
        jest.spyOn(host, 'reserve').mockImplementationOnce(async (input) => {
          await reserve(input);
          request.variant = { kind: 'new-multi-repo', name: ' ' };
        });
        await expect(createWorkspace(request)).rejects.toMatchObject({
          reason: 'name-required',
        });
        request.variant = { kind: 'new-multi-repo', name: 'Created' };
        expect(snapshot()).toEqual(before);
        await expect(createWorkspace(request)).resolves.toHaveProperty(
          'workspace',
        );
      } else if (kind === 'import') {
        renameSync(join(dir, 'import-repo', '.git'), join(dir, 'saved-git'));
        await expect(invoke(kind)).rejects.toMatchObject({
          reason: 'not-a-repository',
        });
        expect(snapshot()).toEqual(before);
        renameSync(join(dir, 'saved-git'), join(dir, 'import-repo', '.git'));
        await expect(invoke(kind)).resolves.toHaveProperty('workspace');
      } else {
        const path = join(root, 'a', 'workspace.json');
        const original = readFileSync(path, 'utf8');
        writeFileSync(
          path,
          JSON.stringify({ version: 1, type: 'multi-repo', repos: [] }),
        );
        const refusedImages = snapshot();
        await expect(invoke(kind)).rejects.toMatchObject({
          reason: 'unsupported-workspace',
        });
        expect(snapshot()).toEqual(refusedImages);
        writeFileSync(path, original);
        await expect(invoke(kind)).resolves.toHaveProperty('record');
      }
    },
  );
  it.each(cases)(
    '%s marks an uncertain failure immediately and keeps diagnostics content-free',
    async (kind) => {
      const reserve = jest.spyOn(host, 'reserve');
      const error = Object.assign(
        kind === 'worktree'
          ? new WorktreeCreationRefusedError(
              'invalid-selection',
              'private contents at ' + dir,
            )
          : new WorkspaceCreationRefusedError(
              'not-importable',
              'private contents at ' + dir,
            ),
        { code: 'EIO' },
      );
      jest.spyOn(host, 'commit').mockRejectedValueOnce(error);
      await expectFailure(invoke(kind), error);
      const receipt = reserve.mock.calls[0]?.[0].receipt;
      if (!receipt) throw new Error('Expected a durable reservation');
      const lookup = await host.lookupReceipt(receipt);
      expect(lookup).toMatchObject({
        status: 'recovery-required',
        diagnostics:
          side === 'daemon'
            ? // The daemon side records the uncertain transport failure.
              { operation: receipt.operation, errorName: 'CanopyClientError' }
            : {
                operation: receipt.operation,
                errorName: error.name,
                errorCode: 'EIO',
              },
      });
      expect(JSON.stringify(lookup)).not.toContain(dir);
      expect(JSON.stringify(lookup)).not.toContain('private contents');
      const before = snapshot();
      const commits = jest.spyOn(host, 'commit');
      const count = commits.mock.calls.length;
      await expect(invoke(kind)).rejects.toMatchObject({
        reason: 'recovery-required',
      });
      expect(snapshot()).toEqual(before);
      expect(commits).toHaveBeenCalledTimes(count);
    },
  );

  it.each(['branch', 'base'] as const)(
    'worktree releases its own %s validation error before effects',
    async (kind) => {
      if (kind === 'branch')
        execFileSync('git', ['-C', repo, 'branch', 'Created']);
      const request: Parameters<typeof createWorktreeFromSelection>[0] = {
        workspaceId: 'a',
        workspaceKind: 'single-repo',
        branch: { kind: 'new', branchName: 'Created' },
        base:
          kind === 'base'
            ? { kind: 'branch', baseBranch: 'missing' }
            : { kind: 'repository-default' },
        allowBaseBranchNetwork: false,
        seedPanelLayoutMode: false,
        idempotencyKey: 'validation-key',
      };
      const before = snapshot();
      await expect(createWorktreeFromSelection(request)).rejects.toThrow(
        kind === 'base' ? 'was not found' : 'already in use',
      );
      expect(snapshot()).toEqual(before);
      execFileSync('git', [
        '-C',
        repo,
        'branch',
        ...(kind === 'base' ? ['missing'] : ['-D', 'Created']),
      ]);
      await expect(
        createWorktreeFromSelection(request),
      ).resolves.toHaveProperty('record');
    },
  );
  it('keeps the original error and reserved state when immediate recovery marking fails', async () => {
    const error = new Error('failed after effects');
    const reserve = jest.spyOn(host, 'reserve');
    jest.spyOn(host, 'commit').mockRejectedValueOnce(error);
    jest
      .spyOn(host, 'markReservationRecoveryRequired')
      .mockRejectedValueOnce(new Error('marking unavailable'));
    await expectFailure(invoke('create'), error);
    const receipt = reserve.mock.calls[0]?.[0].receipt;
    if (!receipt) throw new Error('Expected a reservation');
    expect(await host.lookupReceipt(receipt)).toMatchObject({
      status: 'in-progress',
    });
    await host.shutdown();
    await restartHost();
    await expect(invoke('create')).rejects.toMatchObject({
      reason: 'recovery-required',
    });
  });
  it('keeps worker reservation-state refusals when marking or releasing recovery twice', async () => {
    const receipt = {
      caller: 'state-test',
      operation: 'core.workspace.create',
      idempotencyKey: 'state-key',
      fingerprint: 'f',
    };
    await host.reserve({
      reservationId: 'held',
      operation: receipt.operation,
      receipt,
    });
    const diagnostics = { operation: receipt.operation, errorName: 'Error' };
    await host.markReservationRecoveryRequired('held', diagnostics);
    await expect(
      host.markReservationRecoveryRequired('held', diagnostics),
    ).rejects.toMatchObject({
      reason: 'invalid-state',
      details: { actual: 'recovery-required', expected: 'reserved' },
    });
    await expect(host.releaseReservation('held')).rejects.toMatchObject({
      reason: 'invalid-state',
    });
    await expect(
      host.markReservationRecoveryRequired('missing', diagnostics),
    ).rejects.toMatchObject({
      reason: 'invalid-state',
      details: { actual: 'missing' },
    });
  });

  it.each(['startPostCreateSetup', 'surfaceNeedsRepairInResponse'] as const)(
    'multi-repo keyed creation saves and replays needs-repair with %s',
    async (flag) => {
      useMultiRepoWorkspace(repo);
      const request = {
        workspaceId: 'a',
        workspaceKind: 'multi-repo',
        branch: { kind: 'new', branchName: 'repair' },
        base: { kind: 'repository-default' },
        includedRepoIds: [],
        allowBaseBranchNetwork: false,
        seedPanelLayoutMode: false,
        idempotencyKey: 'repair-key',
        [flag]: true,
      } as const;
      const commits = jest.spyOn(host, 'commit');
      const first = await createWorktreeFromSelection(request);
      expect(first.status).toBe('needs-repair');
      if (first.status !== 'needs-repair')
        throw new Error('Expected a repair outcome');
      expect(first.repairIssues).toContainEqual({
        code: 'missing-gitignore',
        blocking: true,
        message: '.gitignore must include \"repos/\" for nested project repos',
      });
      const before = snapshot();
      const gitBefore = execFileSync(
        'git',
        ['-C', repo, 'worktree', 'list', '--porcelain'],
        { encoding: 'utf8' },
      );
      const count = commits.mock.calls.length;
      expect(await createWorktreeFromSelection(request)).toEqual(first);
      expect(snapshot()).toEqual(before);
      expect(
        execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {
          encoding: 'utf8',
        }),
      ).toBe(gitBefore);
      expect(commits).toHaveBeenCalledTimes(count);
      const decision = commits.mock.calls.find(([input]) => input.receipt)?.[0];
      expect(decision?.outcome).toEqual(first);
      const removal = decision?.files.find(
        (file) => file.path === join(root, 'a', 'worktrees.json'),
      );
      expect(removal).toBeDefined();
      expect(removal?.contents).toContain('git-pending');
      expect(removal?.contents).toContain('recovery-required');
    },
  );

  function useMultiRepoWorkspace(sourceRepoPath?: string): void {
    writeFileSync(
      join(root, 'a', 'workspace.json'),
      JSON.stringify({
        version: 1,
        type: 'multi-repo',
        sourceRepoPath,
        repos: sourceRepoPath
          ? []
          : [{ id: 'app', name: 'App', repoPath: repo }],
      }),
    );
    writeFileSync(
      join(root, 'index.json'),
      JSON.stringify({
        version: 1,
        workspaces: [
          {
            id: 'a',
            name: 'Original',
            type: 'multi-repo',
            color: '#7C3AED',
            collapsed: false,
            order: 0,
          },
        ],
      }),
    );
  }

  it.each(['single-repo', 'multi-repo'] as const)(
    '%s deferred creation replays its returned pending outcome after readiness',
    async (workspaceKind) => {
      if (workspaceKind === 'multi-repo') useMultiRepoWorkspace();
      let settle: () => void = () => {};
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const onGitReady = jest.fn();
      const request = {
        workspaceId: 'a',
        workspaceKind,
        branch: { kind: 'new', branchName: 'deferred' },
        base: { kind: 'repository-default' },
        deferGitSetup: true,
        allowBaseBranchNetwork: false,
        seedPanelLayoutMode: false,
        idempotencyKey: 'deferred-key',
        onGitSetupSettled: settle,
        onGitReady,
      } as const;
      const first = await createWorktreeFromSelection(request);
      expect(first).toMatchObject({
        status: 'created',
        response: { setupPhase: 'git-pending' },
      });
      await settled;
      expect(onGitReady).toHaveBeenCalledTimes(1);
      const before = snapshot();
      const commits = jest.spyOn(host, 'commit');
      expect(await createWorktreeFromSelection(request)).toEqual(first);
      expect(snapshot()).toEqual(before);
      expect(commits).not.toHaveBeenCalled();
      expect(onGitReady).toHaveBeenCalledTimes(1);
    },
  );

  it('multi-repo deferred repair uses the existing event and keeps the returned receipt', async () => {
    useMultiRepoWorkspace(repo);
    let settle: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const onNeedsRepair = jest.fn();
    const request = {
      workspaceId: 'a',
      workspaceKind: 'multi-repo',
      branch: { kind: 'new', branchName: 'deferred-repair' },
      base: { kind: 'repository-default' },
      includedRepoIds: [],
      deferGitSetup: true,
      allowBaseBranchNetwork: false,
      seedPanelLayoutMode: false,
      idempotencyKey: 'deferred-repair-key',
      onGitSetupSettled: settle,
      onNeedsRepair,
    } as const;
    const first = await createWorktreeFromSelection(request);
    expect(first).toMatchObject({
      status: 'created',
      response: { setupPhase: 'git-pending' },
    });
    await settled;
    expect(onNeedsRepair).toHaveBeenCalledTimes(1);
    const before = snapshot();
    const commits = jest.spyOn(host, 'commit');
    expect(await createWorktreeFromSelection(request)).toEqual(first);
    expect(snapshot()).toEqual(before);
    expect(commits).not.toHaveBeenCalled();
    expect(onNeedsRepair).toHaveBeenCalledTimes(1);
  });

  it.each(['single-repo', 'multi-repo'] as const)(
    '%s keeps a crash between pending publication and the outcome decision for recovery',
    async (workspaceKind) => {
      if (workspaceKind === 'multi-repo') useMultiRepoWorkspace();
      const request = {
        workspaceId: 'a',
        workspaceKind,
        branch: { kind: 'new', branchName: 'crash' },
        base: { kind: 'repository-default' },
        allowBaseBranchNetwork: false,
        seedPanelLayoutMode: false,
        idempotencyKey: 'crash-key',
      } as const;
      const commit = host.commit.bind(host);
      const commits = jest
        .spyOn(host, 'commit')
        .mockImplementation(async (input) => {
          if (!input.receipt) return commit(input);
          await host.shutdown();
          throw new Error('interrupted before outcome decision');
        });
      await expect(createWorktreeFromSelection(request)).rejects.toThrow(
        uncertain('interrupted before outcome decision'),
      );
      const publication = commits.mock.calls[0]?.[0];
      expect(publication?.receipt).toBeUndefined();
      expect(publication?.reservationId).toBeUndefined();
      expect(
        publication?.files.some((file) =>
          file.contents?.includes('git-pending'),
        ),
      ).toBe(true);
      await restartHost();
      const before = snapshot();
      const retried = jest.spyOn(host, 'commit');
      await expect(createWorktreeFromSelection(request)).rejects.toMatchObject({
        reason: 'recovery-required',
      });
      expect(snapshot()).toEqual(before);
      expect(retried).not.toHaveBeenCalled();
    },
  );

  it('multi-repo synchronous success saves the final ready result', async () => {
    useMultiRepoWorkspace();
    const request = {
      workspaceId: 'a',
      workspaceKind: 'multi-repo',
      branch: { kind: 'new', branchName: 'success' },
      base: { kind: 'repository-default' },
      allowBaseBranchNetwork: false,
      seedPanelLayoutMode: false,
      idempotencyKey: 'success-key',
    } as const;
    const first = await createWorktreeFromSelection(request);
    expect(first).toMatchObject({
      status: 'created',
      record: { setupPhase: 'git-ready' },
    });
    const before = snapshot();
    const commits = jest.spyOn(host, 'commit');
    expect(await createWorktreeFromSelection(request)).toEqual(first);
    expect(snapshot()).toEqual(before);
    expect(commits).not.toHaveBeenCalled();
  });

  it('folder import never saves success before external Cowork activation completes', async () => {
    const folderPath = join(dir, 'plain-folder');
    mkdirSync(folderPath);
    const request = {
      source: 'folder',
      variant: { kind: 'local-folder', folderPath },
      idempotencyKey: 'activation-key',
    } as const;
    const activation = jest
      .spyOn(coworkWorkEntries, 'activateWorkEntryWorkspace')
      .mockImplementationOnce(() => {
        throw new Error('activation failed after publication');
      });
    const commits = jest.spyOn(host, 'commit');
    await expect(createWorkspace(request)).rejects.toThrow(
      'activation failed after publication',
    );
    expect(commits.mock.calls.some(([input]) => input.receipt)).toBe(false);
    const before = snapshot();
    const count = commits.mock.calls.length;
    await expect(createWorkspace(request)).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    expect(snapshot()).toEqual(before);
    expect(commits).toHaveBeenCalledTimes(count);
    expect(activation).toHaveBeenCalledTimes(1);
  });

  it.each(['before', 'after'] as const)(
    'multi-repo repair interruption %s its outcome decision never replays created',
    async (when) => {
      useMultiRepoWorkspace(repo);
      const request = {
        workspaceId: 'a',
        workspaceKind: 'multi-repo',
        branch: { kind: 'new', branchName: 'repair-interruption' },
        base: { kind: 'repository-default' },
        includedRepoIds: [],
        surfaceNeedsRepairInResponse: true,
        allowBaseBranchNetwork: false,
        seedPanelLayoutMode: false,
        idempotencyKey: 'repair-interruption',
      } as const;
      const commit = host.commit.bind(host);
      let saved: unknown;
      jest.spyOn(host, 'commit').mockImplementation(async (input) => {
        if (!input.receipt) return commit(input);
        if (when === 'after') {
          await host.shutdown();
          const log = W5CommitLog.open(join(dir, 'w5', 'commit-log.sqlite'));
          try {
            log.commit(input);
            saved = input.outcome;
          } finally {
            log.close();
          }
        }
        throw new Error('repair outcome interrupted');
      });
      await expect(createWorktreeFromSelection(request)).rejects.toThrow(
        uncertain('repair outcome interrupted'),
      );
      if (when === 'after') {
        await restartHost();
        expect((await host.recoveryReport()).applied).toHaveLength(1);
      }
      const before = snapshot();
      const retried = createWorktreeFromSelection(request);
      if (when === 'after') {
        expect(await retried).toEqual(saved);
        await expect(retried).resolves.toHaveProperty('status', 'needs-repair');
      } else {
        await expect(retried).rejects.toMatchObject({
          reason: 'recovery-required',
        });
      }
      expect(snapshot()).toEqual(before);
    },
  );
});
