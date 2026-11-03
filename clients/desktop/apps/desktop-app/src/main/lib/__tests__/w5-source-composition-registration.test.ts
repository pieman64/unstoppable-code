// W7b-4 (CAN-5552): the keyed source, composition, rename and fork lifecycles
// registered on the desktop dispatcher, over the real commit-log worker,
// canonical files and Git, as the other keyed W5 boundary suites run.
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  hostPlatformOperatingSystem,
  hostPlatformServices,
  createPlatformEndpointServices,
} from '@canopy/core-platform';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
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

import {
  hasHostAbsolutePath,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { deriveCoreLifecycleOperationId } from '@canopy/core-runtime/node/workspace/lifecycle-commands';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import { projectedSourceCompositionCommands } from '../../canopy-runtime/source-composition-dispatch';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import * as featureFlags from '../../feature-flags';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { withStorageOwnershipChange } from '@canopy/desktop-shared/node/lib/storage-admission';
import * as git from '../git';
import { getWorkspaceWorktreeRootRepoDir } from '../paths';
import {
  WORKSPACE_MANIFEST_STORAGE,
  WORKTREE_LIST_STORAGE,
} from '../w5-storage';
import * as orgSync from '../org-member-multi-repo-sync-deps';
import {
  createOrgMemberMultiRepoSync,
  OrgMultiRepoSyncRefusedError,
  type OrgMemberMultiRepoSync,
} from '../org-member-multi-repo-sync';
import { readWorkspaceConfig } from '../workspace-persistence';
import { applySourceChanges } from '../workspace-source-changes';
import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import type {
  DesktopOrgProjectCatalogSnapshot,
  WorkspaceApplySourceChangesRequest,
} from '@canopy/desktop-shared/types';
import * as workspaceWorktreeRuntime from '../workspace-worktree-runtime';
import * as diffStats from '../../services/worktree-diff-stats-cache';
import * as referencePoller from '../workspace-reference-repo-poller';
import * as forkDestination from '../../shared-containers/fork/destination';
import * as forkGuard from '../../shared-containers/fork/fork-guard';
import * as forkInstall from '../../shared-containers/capability-package/install';
import * as forkCopyTree from '../../shared-containers/fork/copy-tree';
import * as sharedContainerReader from '../../shared-containers/read/reader';
import * as sharedContainerReconciliation from '../../shared-containers/reconciliation-service';
import { SharedContainerReplicaStore } from '../../shared-containers/replica/store';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import {
  renameWorktreeBranch,
  WorktreeBranchRenameRefusedError,
} from '../worktree-branch-rename';
import { inProcessBranchRenameGit } from '../../__tests__/helpers/in-process-branch-rename-git';
import {
  runW5Maintenance,
  type W5MaintenanceContext,
  type W5MaintenanceDecision,
} from '../w5-maintenance';

jest.setTimeout(90_000);
let dir: string;
let dataRoot: string;
let root: string;
let repo: string;
let host: W5CommitLogHost;
let dispatcher: DesktopCanopyDispatcher;
let originalDataDir: string | undefined;

const dbPath = (): string => join(dataRoot, 'w5', 'commit-log.sqlite');
const posix = process.platform === 'win32' ? it.skip : it;

function startHost(): void {
  host = new W5CommitLogHost({
    dbPath: dbPath(),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  __resetSidebarItemsStateForTests();
}

function checkout(worktreeId: string): string {
  return join(root, 'a', 'worktrees', worktreeId);
}
function addCheckout(worktreeId: string, branch: string): void {
  mkdirSync(dirname(checkout(worktreeId)), { recursive: true });
  execFileSync('git', [
    '-C',
    repo,
    'worktree',
    'add',
    '-q',
    '-b',
    branch,
    checkout(worktreeId),
  ]);
}
function currentBranch(worktreeId: string): string {
  return execFileSync(
    'git',
    ['-C', checkout(worktreeId), 'branch', '--show-current'],
    { encoding: 'utf8' },
  ).trim();
}

beforeEach(() => {
  ({ dir, root, repo } = createW5BoundaryFixture(
    (createdAt) => [{ id: 'one', branchName: 'old', createdAt }],
    ['b'],
  ));
  dataRoot = join(dir, 'data');
  // Maintenance runs only under a private data root.
  chmodSync(dataRoot, 0o700);
  mkdirSync(join(dataRoot, 'runtime'), { mode: 0o700 });
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataRoot;
  addCheckout('one', 'old');
  startHost();
  dispatcher = createDesktopRuntime();
  jest.clearAllMocks();
});
afterEach(async () => {
  await settleDetachedWork();
  await dispatcher.shutdown();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

const IPC_CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.workspace.read'],
};
/** An agent or tool acting as the local user, holding the write grants. */
const USER: CanopyCallerDescriptor = {
  ...IPC_CALLER,
  clientInstanceId: 'agent-client',
  grants: ['core.workspace.write', 'core.worktree.write'],
};

function writeManifest(id: string, value: Record<string, unknown>): void {
  writeFileSync(join(root, id, 'workspace.json'), JSON.stringify(value));
  __resetSidebarItemsStateForTests();
}
function worktreeRows(): Array<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(
    readFileSync(join(root, 'a', 'worktrees.json'), 'utf8'),
  );
  return (parsed as { worktrees: Array<Record<string, unknown>> }).worktrees;
}
function images(): string[] {
  return ['index.json', 'a/workspace.json', 'a/worktrees.json'].map((file) =>
    readFileSync(join(root, file), 'utf8'),
  );
}

/** Workspace `a` as a temporary multi-repo project, for #20. */
function makeTemporaryMultiRepo(): void {
  const index: unknown = JSON.parse(
    readFileSync(join(root, 'index.json'), 'utf8'),
  );
  const { workspaces } = index as {
    workspaces: Array<Record<string, unknown>>;
  };
  writeFileSync(
    join(root, 'index.json'),
    JSON.stringify({
      version: 1,
      workspaces: workspaces.map((entry) =>
        entry.id === 'a' ? { ...entry, type: 'multi-repo' } : entry,
      ),
    }),
  );
  writeManifest('a', {
    version: 1,
    type: 'multi-repo',
    repos: [],
    temporary: true,
  });
}

/** Any operation by name, as a wire caller sends it. */
function instruct(
  operation: string,
  params: Record<string, unknown>,
  caller: CanopyCallerDescriptor = USER,
  key = 'k',
): Promise<unknown> {
  const call = dispatcher.instruction.bind(dispatcher) as unknown as (
    name: string,
    params: Record<string, unknown>,
    options: {
      caller: CanopyCallerDescriptor;
      metadata: { idempotencyKey: string };
    },
  ) => Promise<unknown>;
  return call(
    operation,
    { ...params, _meta: { idempotencyKey: key } },
    { caller, metadata: { idempotencyKey: key } },
  );
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected a failure');
}

const RENAME = {
  workspaceId: 'a',
  worktreeId: 'one',
  branchName: 'renamed',
} as const;

const OPERATIONS: Array<[string, Record<string, unknown>, string]> = [
  [
    'core.workspace.sourceRepo.initialize',
    { workspaceId: 'a' },
    'core.workspace.write',
  ],
  [
    'core.workspace.type.convert',
    { workspaceId: 'a', targetKind: 'multi_repo' },
    'core.workspace.write',
  ],
  [
    'core.workspace.sourceChanges.apply',
    { workspaceId: 'a', target: { mode: 'existing', worktreeId: 'one' } },
    'core.workspace.write',
  ],
  [
    'core.workspace.composition.combine',
    { optionId: 'o', expectedRevision: 0, moveChats: false },
    'core.workspace.write',
  ],
  [
    'core.workspace.composition.split',
    {
      previewId: 'p',
      expectedWorkspaceRevision: 0,
      approvedDestructiveItems: [],
    },
    'core.workspace.write',
  ],
  [
    'core.workspace.composition.promote',
    { workspaceId: 'a', expectedRevision: 0, name: 'Kept' },
    'core.workspace.write',
  ],
  ['core.worktree.branch.rename', RENAME, 'core.worktree.write'],
  [
    'core.sharedContainer.fork',
    {
      containerId: 'c',
      revisionId: 'r',
      sourceOwnerDisplayName: 'Ada',
      destination: { kind: 'new-workspace', owner: { kind: 'personal' } },
    },
    'core.workspace.write',
  ],
];

describe('registration and callers (D-1(a), Q8)', () => {
  it.each(OPERATIONS)(
    '%s needs its write grant before the handler runs',
    async (operation, params, grant) => {
      const before = images();
      const reserves = jest.spyOn(host, 'reserve');
      const commits = jest.spyOn(host, 'commit');
      expect(
        await failureOf(instruct(operation, params, IPC_CALLER)),
      ).toMatchObject({ payload: { kind: 'permission_denied' } });
      expect(
        await failureOf(
          instruct(operation, params, {
            ...USER,
            grants: USER.grants.filter((held) => held !== grant),
          }),
        ),
      ).toMatchObject({ payload: { kind: 'permission_denied' } });
      expect(reserves).not.toHaveBeenCalled();
      expect(commits).not.toHaveBeenCalled();
      expect(images()).toEqual(before);
    },
  );

  it.each(OPERATIONS)(
    '%s refuses renderer relay and Portal principals holding the grant',
    async (operation, params) => {
      const before = images();
      const reserves = jest.spyOn(host, 'reserve');
      const lookups = jest.spyOn(host, 'lookupReceipt');
      for (const caller of [
        { ...USER, principalId: 'local-desktop-renderer:main' },
        {
          ...USER,
          principalId: 'portal-session:s',
          interfaceKind: 'portal' as const,
        },
        // W7b-3's rule also refuses a Portal session on the desktop interface.
        { ...USER, clientInstanceId: 'portal-session:s-1' },
      ])
        expect(
          await failureOf(instruct(operation, params, caller)),
        ).toMatchObject({
          payload: {
            kind: 'permission_denied',
            details: { reason: 'caller-refused' },
          },
        });
      expect(lookups).not.toHaveBeenCalled();
      expect(reserves).not.toHaveBeenCalled();
      expect(images()).toEqual(before);
      expect(currentBranch('one')).toBe('old');
    },
  );

  it.each(OPERATIONS.filter(([, params]) => 'workspaceId' in params))(
    '%s refuses a malformed row sharing the workspace id before any key (RR5)',
    async (operation, params) => {
      // `notebook` is unreadable here: a write would drop that row.
      const index: unknown = JSON.parse(
        readFileSync(join(root, 'index.json'), 'utf8'),
      );
      const { workspaces } = index as { workspaces: unknown[] };
      writeFileSync(
        join(root, 'index.json'),
        JSON.stringify({
          version: 1,
          workspaces: [...workspaces, { id: 'a', type: 'notebook', order: 9 }],
        }),
      );
      __resetSidebarItemsStateForTests();
      const before = images();
      const reserves = jest.spyOn(host, 'reserve');
      expect(await failureOf(instruct(operation, params))).toMatchObject({
        payload: {
          kind: 'invalid_argument',
          details: { reason: 'duplicate-workspace' },
        },
      });
      expect(reserves).not.toHaveBeenCalled();
      expect(images()).toEqual(before);
      expect(currentBranch('one')).toBe('old');
    },
  );
});

describe('core.worktree.branch.rename (#27)', () => {
  it('a wire rename runs worker.git.branch.rename as its caller and keeps a principal-scoped receipt', async () => {
    const reserves = jest.spyOn(host, 'reserve');
    const instructions = jest.spyOn(dispatcher, 'instruction');
    const invalidations = jest.spyOn(diffStats, 'invalidateWorktreeDiffStats');
    const caller = { ...USER, principalId: 'remote-device:phone-1' };
    const result = await instruct(
      'core.worktree.branch.rename',
      RENAME,
      caller,
    );
    expect(result).toEqual({
      workspaceId: 'a',
      worktreeId: 'one',
      branchName: 'renamed',
    });
    expect(currentBranch('one')).toBe('renamed');
    expect(worktreeRows()[0]).toMatchObject({ branchName: 'renamed' });
    expect(reserves.mock.calls[0]?.[0]).toMatchObject({
      operation: 'core.worktree.branch.rename',
      receipt: { caller: 'daemon:remote-device:phone-1:desktop' },
    });
    const gitCall = instructions.mock.calls.find(
      ([name]) => name === 'worker.git.branch.rename',
    );
    expect(gitCall?.[2]?.caller.principalId).toBe('remote-device:phone-1');
    expect(gitCall?.[1]).toEqual({
      scope: { workspaceId: 'a', worktreeId: 'one' },
      name: 'renamed',
    });
    expect(gitCall?.[2]?.caller.grants).toEqual(['worker.git.write']);

    await settleDetachedWork();
    // Replaying a removed workspace must repeat neither Git nor cache work.
    rmSync(join(root, 'a'), { recursive: true, force: true });
    __resetSidebarItemsStateForTests();
    invalidations.mockClear();
    instructions.mockClear();
    await expect(
      instruct('core.worktree.branch.rename', RENAME, caller),
    ).resolves.toEqual(result);
    expect(
      instructions.mock.calls.filter(
        ([name]) => name === 'worker.git.branch.rename',
      ),
    ).toEqual([]);
    expect(invalidations).not.toHaveBeenCalled();
    expect(
      await failureOf(
        instruct(
          'core.worktree.branch.rename',
          { ...RENAME, branchName: 'other' },
          caller,
        ),
      ),
    ).toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'core.worktree.idempotencyKeyReused',
        retry: { kind: 'never' },
      },
    });
  });

  it('addresses the worktree before any key is used (RR5)', async () => {
    const reserves = jest.spyOn(host, 'reserve');
    expect(
      await failureOf(
        instruct('core.worktree.branch.rename', {
          ...RENAME,
          worktreeId: 'ghost',
        }),
      ),
    ).toMatchObject({
      payload: {
        kind: 'not_found',
        code: 'core.worktree.notFound',
        details: { reason: 'not-found' },
      },
    });
    expect(
      await failureOf(
        instruct('core.worktree.branch.rename', {
          ...RENAME,
          workspaceId: 'zz',
        }),
      ),
    ).toMatchObject({ payload: { code: 'core.worktree.notFound' } });
    expect(reserves).not.toHaveBeenCalled();
  });

  it('maps its refusals before Git, releasing the key', async () => {
    addCheckout('two', 'taken');
    const taken = await failureOf(
      instruct('core.worktree.branch.rename', {
        ...RENAME,
        branchName: 'taken',
      }),
    );
    expect(taken).toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.worktree.invalidState',
        details: { reason: 'branch-unavailable' },
        retry: { kind: 'after_refresh', resource: 'core.worktree.get' },
      },
    });
    expect(
      await failureOf(
        instruct(
          'core.worktree.branch.rename',
          { ...RENAME, branchName: 'bad..name' },
          USER,
          'k2',
        ),
      ),
    ).toMatchObject({
      payload: {
        kind: 'invalid_argument',
        details: { reason: 'invalid-branch-name' },
      },
    });
    expect(currentBranch('one')).toBe('old');
    // The released key decides again.
    await expect(
      instruct('core.worktree.branch.rename', RENAME),
    ).resolves.toMatchObject({ branchName: 'renamed' });
  });

  it('a failed worker Git rename is internal, then recoveryRequired: the effect may have run', async () => {
    const dispatch = dispatcher.instruction.bind(dispatcher) as unknown as (
      name: string,
      ...rest: unknown[]
    ) => Promise<unknown>;
    (
      jest.spyOn(dispatcher, 'instruction') as unknown as jest.SpyInstance
    ).mockImplementation((name: string, ...rest: unknown[]) =>
      name === 'worker.git.branch.rename'
        ? Promise.reject(new Error(`git failed in ${repo}`))
        : dispatch(name, ...rest),
    );
    const failure = await failureOf(
      instruct('core.worktree.branch.rename', RENAME),
    );
    expect(failure).toMatchObject({ payload: { kind: 'internal' } });
    expect(JSON.stringify(failure)).not.toContain(repo);
    expect(currentBranch('one')).toBe('old');
    expect(
      await failureOf(instruct('core.worktree.branch.rename', RENAME)),
    ).toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.worktree.recoveryRequired',
        retry: { kind: 'never' },
      },
    });
  });

  it('a shared-container viewer scope is readOnly', async () => {
    const reserves = jest.spyOn(host, 'reserve');
    expect(
      await failureOf(
        instruct('core.worktree.branch.rename', {
          ...RENAME,
          workspaceId: 'shared-container-viewer',
        }),
      ),
    ).toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.worktree.readOnly',
      },
    });
    expect(reserves).not.toHaveBeenCalled();
  });

  it("the IPC projection runs today's unkeyed rename: no receipt or reservation for the minted key", async () => {
    const reserves = jest.spyOn(host, 'reserve');
    const lookups = jest.spyOn(host, 'lookupReceipt');
    const commits = jest.spyOn(host, 'commit');
    const instructions = jest.spyOn(dispatcher, 'instruction');
    const target = {
      workspaceId: 'a',
      worktreeId: 'one',
      newBranchName: 'renamed',
    };
    const outcome = await projectedSourceCompositionCommands({
      dispatcher,
      caller: IPC_CALLER,
    }).renameBranch(target, () =>
      renameWorktreeBranch(
        { source: 'desktop', ...target },
        inProcessBranchRenameGit,
      ),
    );
    expect(outcome).toMatchObject({ branchName: 'renamed' });
    const [name, , options] = instructions.mock.calls[0] ?? [];
    expect(name).toBe('core.worktree.branch.rename');
    expect(options?.caller.grants).toEqual(['core.worktree.write']);
    expect(reserves).not.toHaveBeenCalled();
    expect(lookups).not.toHaveBeenCalled();
    expect(commits.mock.calls[0]?.[0].receipt).toBeUndefined();
    expect(currentBranch('one')).toBe('renamed');
  });

  it("the IPC projection rethrows the host's own refusal", async () => {
    const target = {
      workspaceId: 'a',
      worktreeId: 'one',
      newBranchName: 'bad..name',
    };
    const direct = await failureOf(
      renameWorktreeBranch(
        { source: 'desktop', ...target },
        inProcessBranchRenameGit,
      ),
    );
    const projected = await failureOf(
      projectedSourceCompositionCommands({
        dispatcher,
        caller: IPC_CALLER,
      }).renameBranch(target, () =>
        renameWorktreeBranch(
          { source: 'desktop', ...target },
          inProcessBranchRenameGit,
        ),
      ),
    );
    expect(direct).toBeInstanceOf(WorktreeBranchRenameRefusedError);
    expect(projected).toBeInstanceOf(WorktreeBranchRenameRefusedError);
    expect(projected).toMatchObject({
      reason: 'invalid-branch-name',
      message: direct instanceof Error ? direct.message : '',
    });
  });
});

describe('core.workspace.sourceRepo.initialize (#15)', () => {
  beforeEach(() => {
    writeManifest('a', { version: 1, type: 'multi-repo', repos: [] });
  });

  it('a wire initialization answers the saved manifest without host paths and replays it', async () => {
    const reserves = jest.spyOn(host, 'reserve');
    const result = await instruct('core.workspace.sourceRepo.initialize', {
      workspaceId: 'a',
      expectedRevision: 0,
    });
    expect(result).toEqual({
      workspaceId: 'a',
      manifest: { version: 1, repos: [] },
      warnings: [],
    });
    expect(hasHostAbsolutePath(JSON.stringify(result))).toBe(false);
    expect(reserves.mock.calls[0]?.[0]).toMatchObject({
      operation: 'core.workspace.sourceRepo.initialize',
      receipt: {
        caller: 'daemon:local-desktop-user:workspace-source-initialization',
      },
    });
    const initGit = jest.spyOn(git, 'initGitRepo');
    rmSync(join(root, 'a'), { recursive: true, force: true });
    __resetSidebarItemsStateForTests();
    await expect(
      instruct('core.workspace.sourceRepo.initialize', {
        workspaceId: 'a',
        expectedRevision: 0,
      }),
    ).resolves.toEqual(result);
    expect(initGit).not.toHaveBeenCalled();
  });

  it('refuses an unknown workspace before the reservation and a temporary one before any effect', async () => {
    const reserves = jest.spyOn(host, 'reserve');
    const releases = jest.spyOn(host, 'releaseReservation');
    expect(
      await failureOf(
        instruct('core.workspace.sourceRepo.initialize', { workspaceId: 'zz' }),
      ),
    ).toMatchObject({
      payload: { kind: 'not_found', code: 'core.workspace.notFound' },
    });
    expect(reserves).not.toHaveBeenCalled();
    writeManifest('a', {
      version: 1,
      type: 'multi-repo',
      repos: [],
      temporary: true,
    });
    expect(
      await failureOf(
        instruct('core.workspace.sourceRepo.initialize', { workspaceId: 'a' }),
      ),
    ).toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.workspace.invalidState',
        details: { reason: 'temporary' },
      },
    });
    expect(releases).toHaveBeenCalledTimes(1);
  });

  it('the IPC projection keeps its unkeyed host request', async () => {
    const reserves = jest.spyOn(host, 'reserve');
    const { initializeWorkspaceSourceRepo } =
      await import('../workspace-source-control');
    const outcome = await projectedSourceCompositionCommands({
      dispatcher,
      caller: IPC_CALLER,
    }).initializeSourceRepo({ workspaceId: 'a' }, () =>
      initializeWorkspaceSourceRepo({
        workspaceId: 'a',
        source: 'workspace_settings',
      }),
    );
    // The IPC answer still carries the host path the settings dialog shows.
    expect(outcome.sourceRepoPath.startsWith(dataRoot)).toBe(true);
    expect(reserves).not.toHaveBeenCalled();
  });
});

describe('core.workspace.type.convert (#16)', () => {
  it('refuses a project with worktrees after a refresh, releasing the key', async () => {
    expect(
      await failureOf(
        instruct('core.workspace.type.convert', {
          workspaceId: 'a',
          targetKind: 'multi_repo',
        }),
      ),
    ).toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.workspace.invalidState',
        details: { reason: 'has-worktrees' },
        retry: { kind: 'after_refresh', resource: 'core.workspace.get' },
      },
    });
    expect(await host.recoveryReport()).toMatchObject({
      interruptedReservations: 0,
      recoveryRequired: [],
    });
  });

  it('converts an empty single-repo project with a principal-scoped receipt', async () => {
    const sidebarReads = jest.spyOn(
      await import('../sidebar-items'),
      'readAllSidebarItems',
    );
    const { notifyPortalStructureChanged } =
      await import('../../portal/portal-event-bus');
    writeFileSync(
      join(root, 'a', 'worktrees.json'),
      JSON.stringify({ version: 1, worktrees: [] }),
    );
    __resetSidebarItemsStateForTests();
    const reserves = jest.spyOn(host, 'reserve');
    await expect(
      instruct('core.workspace.type.convert', {
        workspaceId: 'a',
        targetKind: 'multi_repo',
      }),
    ).resolves.toEqual({ workspaceId: 'a', kind: 'multi_repo' });
    expect(reserves.mock.calls[0]?.[0]).toMatchObject({
      receipt: {
        caller: 'daemon:local-desktop-user:workspace-type-conversion',
      },
    });
    const parsed: unknown = JSON.parse(
      readFileSync(join(root, 'index.json'), 'utf8'),
    );
    expect(
      (parsed as { workspaces: Array<Record<string, unknown>> }).workspaces[0],
    ).toMatchObject({ id: 'a', type: 'multi-repo' });
    expect(sidebarReads).toHaveBeenCalled();
    expect(notifyPortalStructureChanged).toHaveBeenCalled();
    rmSync(join(root, 'a'), { recursive: true, force: true });
    __resetSidebarItemsStateForTests();
    sidebarReads.mockClear();
    jest.mocked(notifyPortalStructureChanged).mockClear();
    await expect(
      instruct('core.workspace.type.convert', {
        workspaceId: 'a',
        targetKind: 'multi_repo',
      }),
    ).resolves.toEqual({ workspaceId: 'a', kind: 'multi_repo' });
    expect(sidebarReads).not.toHaveBeenCalled();
    expect(notifyPortalStructureChanged).not.toHaveBeenCalled();
  });
});

describe('core.workspace.sourceChanges.apply (#17)', () => {
  it('derives the variant: a single-repo project refuses multi-repo fields before any key', async () => {
    const reserves = jest.spyOn(host, 'reserve');
    expect(
      await failureOf(
        instruct('core.workspace.sourceChanges.apply', {
          workspaceId: 'a',
          target: { mode: 'existing', worktreeId: 'one' },
          claudeMd: '# Root',
        }),
      ),
    ).toMatchObject({
      payload: {
        kind: 'invalid_argument',
        details: { reason: 'not-multi-repo' },
      },
    });
    expect(reserves).not.toHaveBeenCalled();
  });

  it('refuses a plugin ref that is not portable before any key', async () => {
    const reserves = jest.spyOn(host, 'reserve');
    expect(
      await failureOf(
        instruct('core.workspace.sourceChanges.apply', {
          workspaceId: 'a',
          target: { mode: 'existing', worktreeId: 'one' },
          plugins: [{ type: 'collection', id: 'local' }],
        }),
      ),
    ).toMatchObject({
      payload: {
        kind: 'invalid_argument',
        details: { reason: 'invalid-request' },
      },
    });
    expect(reserves).not.toHaveBeenCalled();
  });

  it('writes canopy.json in an existing single-repo worktree and saves foreground acceptance', async () => {
    const reserves = jest.spyOn(host, 'reserve');
    const result = await instruct('core.workspace.sourceChanges.apply', {
      workspaceId: 'a',
      target: { mode: 'existing', worktreeId: 'one' },
      scripts: { dev: 'pnpm dev' },
    });
    expect(result).toEqual({
      workspaceId: 'a',
      worktreeId: 'one',
      branchName: 'old',
      createdWorktree: false,
    });
    expect(
      JSON.parse(readFileSync(join(checkout('one'), 'canopy.json'), 'utf8')),
    ).toMatchObject({ scripts: { dev: 'pnpm dev' } });
    expect(reserves.mock.calls[0]?.[0]).toMatchObject({
      receipt: { caller: 'daemon:local-desktop-user:workspace-source-changes' },
    });
  });

  const savedSource = (): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(
      readFileSync(join(checkout('one'), 'canopy.json'), 'utf8'),
    );
    return parsed as Record<string, unknown>;
  };

  it('an empty hook map clears the saved hooks, as the IPC request does', async () => {
    const hooks = { 'pr:create': [{ type: 'command', command: 'echo hi' }] };
    await instruct(
      'core.workspace.sourceChanges.apply',
      {
        workspaceId: 'a',
        target: { mode: 'existing', worktreeId: 'one' },
        hooks,
      },
      USER,
      'set',
    );
    expect(savedSource()).toMatchObject({ hooks });
    await instruct(
      'core.workspace.sourceChanges.apply',
      {
        workspaceId: 'a',
        target: { mode: 'existing', worktreeId: 'one' },
        hooks: {},
      },
      USER,
      'clear',
    );
    expect(savedSource()).not.toHaveProperty('hooks');
  });

  it('saves only the normalized fields of a portable plugin ref', async () => {
    await instruct('core.workspace.sourceChanges.apply', {
      workspaceId: 'a',
      target: { mode: 'existing', worktreeId: 'one' },
      plugins: [
        {
          type: 'skill',
          source: { type: 'builtin', id: 'app' },
          skill_name: 'review',
          localPath: '/Users/someone/skills/review',
        },
      ],
    });
    expect(savedSource().plugins).toEqual([
      {
        type: 'skill',
        source: { type: 'builtin', id: 'app' },
        skill_name: 'review',
      },
    ]);
  });

  it('checks the start page feature for a new key only: a completed key replays after it is turned off', async () => {
    const service = featureFlags.getFeatureFlagService();
    const isEnabled = service.isEnabled.bind(service);
    let startPageOn = true;
    jest
      .spyOn(service, 'isEnabled')
      .mockImplementation((key) =>
        key === CLIENT_FEATURE_FLAGS.canopyDesktopStartPage.key
          ? startPageOn
          : isEnabled(key),
      );
    const change = {
      workspaceId: 'a',
      target: { mode: 'existing', worktreeId: 'one' },
      startPage: { kind: 'url', url: 'https://example.com/start' },
    };
    const result = await instruct(
      'core.workspace.sourceChanges.apply',
      change,
      USER,
      'start-page',
    );
    expect(savedSource()).toMatchObject({ startPage: change.startPage });
    startPageOn = false;
    const reserves = jest.spyOn(host, 'reserve');
    const lookups = jest.spyOn(host, 'lookupReceipt');
    await expect(
      instruct(
        'core.workspace.sourceChanges.apply',
        change,
        USER,
        'start-page',
      ),
    ).resolves.toEqual(result);
    lookups.mockClear();
    expect(
      await failureOf(
        instruct('core.workspace.sourceChanges.apply', change, USER, 'new-key'),
      ),
    ).toMatchObject({
      payload: {
        kind: 'capability_unavailable',
        details: { reason: 'feature-unavailable' },
      },
    });
    // A new key is refused after its receipt lookup, before any reservation.
    expect(lookups).toHaveBeenCalled();
    expect(reserves).not.toHaveBeenCalled();
  });

  describe('a multi-repo project', () => {
    /** The source repository's committed `canopy.json`, which new worktrees start from. */
    function commitSource(repos: Array<Record<string, unknown>>): void {
      writeFileSync(
        join(repo, 'canopy.json'),
        JSON.stringify({ version: 1, repos }),
      );
      writeFileSync(join(repo, '.gitignore'), 'repos/\n');
      execFileSync('git', ['-C', repo, 'add', '.']);
      execFileSync('git', [
        '-C',
        repo,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'source',
      ]);
    }

    beforeEach(() => {
      commitSource([]);
      writeFileSync(
        join(root, 'a', 'worktrees.json'),
        JSON.stringify({ version: 1, worktrees: [] }),
      );
      writeManifest('a', {
        version: 1,
        type: 'multi-repo',
        sourceRepoPath: repo,
        repos: [],
      });
      jest
        .spyOn(
          workspaceWorktreeRuntime,
          'startWorkspaceWorktreePostCreateSetup',
        )
        .mockResolvedValue(undefined);
      jest
        .spyOn(workspaceWorktreeRuntime, 'startWorkspaceRepoSetupAndDiscovery')
        .mockResolvedValue(undefined);
    });

    const ROOT_CHANGE = {
      workspaceId: 'a',
      target: { mode: 'new', existingWorktreeIds: [] },
      scripts: { dev: 'pnpm dev' },
      hooks: { 'pr:create': [{ type: 'command', command: 'echo hi' }] },
      claudeMd: '# Root\n',
    };

    /** A local checkout, without a remote yet, bound to the project as `id`. */
    function bindLocalCheckout(id: string): void {
      const local = join(dir, id);
      mkdirSync(local);
      execFileSync('git', ['init', '-q', '-b', 'main', local]);
      execFileSync('git', [
        '-C',
        local,
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
        'init',
      ]);
      const config: unknown = JSON.parse(
        readFileSync(join(root, 'a', 'workspace.json'), 'utf8'),
      );
      writeManifest('a', {
        ...(config as Record<string, unknown>),
        repos: [{ id, name: id, repoPath: local }],
      });
    }

    const ADD_LEDGER = {
      ...ROOT_CHANGE,
      repoAdds: [
        {
          repoId: 'ledger',
          repoName: 'ledger',
          remoteUrl: 'https://github.com/acme/ledger.git',
        },
      ],
    };

    // The wire has no repoPath, so only a repository already bound here can be added.
    it('refuses an addition with no checkout on this device before any key, and the key stays unused', async () => {
      const before = images();
      const reserves = jest.spyOn(host, 'reserve');
      const failure = await failureOf(
        instruct('core.workspace.sourceChanges.apply', ADD_LEDGER),
      );
      expect(failure).toMatchObject({
        payload: {
          kind: 'failed_precondition',
          code: 'core.workspace.invalidState',
          details: { reason: 'repository-not-local' },
          retry: { kind: 'never' },
          message:
            'ledger has no checkout on this device. Add it to this project here first.',
        },
      });
      expect(hasHostAbsolutePath(JSON.stringify(failure))).toBe(false);
      expect(reserves).not.toHaveBeenCalled();
      expect(images()).toEqual(before);
      bindLocalCheckout('ledger');
      await expect(
        instruct('core.workspace.sourceChanges.apply', ADD_LEDGER),
      ).resolves.toMatchObject({ workspaceId: 'a', createdWorktree: true });
      await settleDetachedWork();
      expect(worktreeRows()).toHaveLength(1);
    });

    it('refuses an addition whose remote is blank before any key', async () => {
      const reserves = jest.spyOn(host, 'reserve');
      expect(
        await failureOf(
          instruct('core.workspace.sourceChanges.apply', {
            ...ROOT_CHANGE,
            repoAdds: [{ repoName: 'blank', remoteUrl: '   ' }],
          }),
        ),
      ).toMatchObject({
        payload: {
          kind: 'invalid_argument',
          details: { reason: 'invalid-request' },
        },
      });
      expect(reserves).not.toHaveBeenCalled();
    });

    const OTHER_LEDGER = {
      id: 'ledger',
      name: 'ledger',
      url: 'https://github.com/acme/other-ledger.git',
    };
    const OTHER_LEDGER_ADD = {
      repoId: OTHER_LEDGER.id,
      repoName: OTHER_LEDGER.name,
      remoteUrl: OTHER_LEDGER.url,
    };
    const conflictRefusal = {
      payload: {
        kind: 'failed_precondition',
        code: 'core.workspace.invalidState',
        details: { reason: 'repository-id-conflict' },
        retry: { kind: 'never' },
        message:
          "ledger is already in this project's canopy.json with a different remote URL. Choose another repository ID.",
      },
    };

    it('refuses an addition whose id canopy.json saves with another remote before any key, and the key stays unused', async () => {
      commitSource([OTHER_LEDGER]);
      bindLocalCheckout('ledger');
      const before = images();
      const reserves = jest.spyOn(host, 'reserve');
      const createWorktree = jest.spyOn(git, 'createWorktree');
      const failure = await failureOf(
        instruct('core.workspace.sourceChanges.apply', ADD_LEDGER),
      );
      expect(failure).toMatchObject(conflictRefusal);
      expect(hasHostAbsolutePath(JSON.stringify(failure))).toBe(false);
      expect(reserves).not.toHaveBeenCalled();
      expect(createWorktree).not.toHaveBeenCalled();
      expect(images()).toEqual(before);
      // The apply's own rule: a removal in the same change frees the id.
      await expect(
        instruct(
          'core.workspace.sourceChanges.apply',
          { ...ADD_LEDGER, repoRemovals: ['ledger'] },
          USER,
          'replace',
        ),
      ).resolves.toMatchObject({ createdWorktree: true });
      await settleDetachedWork();
      commitSource([]);
      await expect(
        instruct('core.workspace.sourceChanges.apply', ADD_LEDGER),
      ).resolves.toMatchObject({ workspaceId: 'a', createdWorktree: true });
      await settleDetachedWork();
      expect(worktreeRows()).toHaveLength(2);
    });

    it("refuses a second addition that reuses an earlier addition's id with another remote, as the apply would", async () => {
      bindLocalCheckout('ledger');
      const reserves = jest.spyOn(host, 'reserve');
      const createWorktree = jest.spyOn(git, 'createWorktree');
      const failure = await failureOf(
        instruct('core.workspace.sourceChanges.apply', {
          ...ADD_LEDGER,
          repoAdds: [...ADD_LEDGER.repoAdds, OTHER_LEDGER_ADD],
        }),
      );
      expect(failure).toMatchObject(conflictRefusal);
      expect(reserves).not.toHaveBeenCalled();
      expect(createWorktree).not.toHaveBeenCalled();
    });

    // A new worktree starts from a commit, so the source checkout's working
    // copy is only a hint for the conflict check.
    it("adds to a new worktree when the source checkout's working canopy.json is unreadable", async () => {
      bindLocalCheckout('ledger');
      writeFileSync(join(repo, 'canopy.json'), '{ not json');
      await expect(
        instruct('core.workspace.sourceChanges.apply', ADD_LEDGER),
      ).resolves.toMatchObject({ workspaceId: 'a', createdWorktree: true });
      await settleDetachedWork();
      expect(worktreeRows()).toHaveLength(1);
    });

    it("checks an existing target against that worktree's own canopy.json", async () => {
      bindLocalCheckout('ledger');
      const { worktreeId } = (await instruct(
        'core.workspace.sourceChanges.apply',
        ROOT_CHANGE,
        USER,
        'create',
      )) as { worktreeId: string };
      await settleDetachedWork();
      const target = getWorkspaceWorktreeRootRepoDir('a', worktreeId);
      writeFileSync(
        join(target, 'canopy.json'),
        JSON.stringify({ version: 1, repos: [OTHER_LEDGER] }),
      );
      const addToTarget = {
        workspaceId: 'a',
        target: { mode: 'existing', worktreeId },
        repoAdds: ADD_LEDGER.repoAdds,
      };
      const reserves = jest.spyOn(host, 'reserve');
      expect(
        await failureOf(
          instruct('core.workspace.sourceChanges.apply', addToTarget),
        ),
      ).toMatchObject(conflictRefusal);
      expect(reserves).not.toHaveBeenCalled();
      writeFileSync(
        join(target, 'canopy.json'),
        JSON.stringify({ version: 1, repos: [] }),
      );
      await expect(
        instruct('core.workspace.sourceChanges.apply', addToTarget),
      ).resolves.toMatchObject({ worktreeId, createdWorktree: false });
    });

    it('creates a worktree with the root change through the organization repository gate, and replays it', async () => {
      const refresh = jest.spyOn(referencePoller, 'requestRefresh');
      const setup = jest.mocked(
        workspaceWorktreeRuntime.startWorkspaceWorktreePostCreateSetup,
      );
      const sync = orgSync.getOrgMemberMultiRepoSync();
      const gate = jest.spyOn(sync, 'checkSourceChanges');
      jest.spyOn(orgSync, 'getOrgMemberMultiRepoSync').mockReturnValue(sync);
      const reserves = jest.spyOn(host, 'reserve');
      const result = await instruct(
        'core.workspace.sourceChanges.apply',
        ROOT_CHANGE,
      );
      await settleDetachedWork();
      expect(result).toMatchObject({
        workspaceId: 'a',
        createdWorktree: true,
        localRepoBindingsUpdated: false,
      });
      expect(hasHostAbsolutePath(JSON.stringify(result))).toBe(false);
      expect(gate).toHaveBeenCalledTimes(1);
      expect(gate.mock.calls[0]?.[1]).toMatchObject({
        workspaceId: 'a',
        workspaceScripts: { dev: 'pnpm dev' },
        workspaceHooks: ROOT_CHANGE.hooks,
        claudeMd: '# Root\n',
      });
      expect(reserves.mock.calls[0]?.[0]).toMatchObject({
        receipt: {
          caller: 'daemon:local-desktop-user:workspace-source-changes',
        },
      });
      const createWorktree = jest.spyOn(git, 'createWorktree');
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(setup).toHaveBeenCalledTimes(1);
      refresh.mockClear();
      setup.mockClear();
      await expect(
        instruct('core.workspace.sourceChanges.apply', ROOT_CHANGE),
      ).resolves.toEqual(result);
      await settleDetachedWork();
      expect(createWorktree).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
      expect(setup).not.toHaveBeenCalled();
      // A replay answers its saved outcome before the gate.
      expect(gate).toHaveBeenCalledTimes(1);
      expect(worktreeRows()).toHaveLength(1);
    });

    // A gate failure that is not one of its typed refusals stays `internal`.
    it('an unclassified organization repository gate failure uses no key', async () => {
      const sync = orgSync.getOrgMemberMultiRepoSync();
      jest.spyOn(orgSync, 'getOrgMemberMultiRepoSync').mockReturnValue({
        ...sync,
        checkSourceChanges: () =>
          Promise.reject(
            new Error('Acme only allows its own repositories in this project.'),
          ),
      });
      const reserves = jest.spyOn(host, 'reserve');
      expect(
        await failureOf(
          instruct('core.workspace.sourceChanges.apply', {
            ...ROOT_CHANGE,
            repoAdds: [
              { repoName: 'outside', remoteUrl: 'https://example.com/o.git' },
            ],
          }),
        ),
      ).toMatchObject({ payload: { kind: 'internal' } });
      expect(reserves).not.toHaveBeenCalled();
    });

    describe('owned by an organization', () => {
      const ORGANIZATION = '00000000-0000-4000-8000-0000000000aa';
      const PAYMENTS = 'https://github.com/acme/payments.git';
      const ADD_PAYMENTS = {
        ...ROOT_CHANGE,
        repoAdds: [
          { repoId: 'payments', repoName: 'payments', remoteUrl: PAYMENTS },
        ],
      };
      let held: OrgProjectSummary[];
      let refresh: jest.Mock<Promise<DesktopOrgProjectCatalogSnapshot>>;
      let gate: OrgMemberMultiRepoSync;

      const payments: OrgProjectSummary = {
        id: '00000000-0000-4000-8000-0000000000b1',
        organizationId: ORGANIZATION,
        name: 'payments',
        description: null,
        kind: 'CODE',
        purpose: 'project',
        visibility: 'organization',
        memberOwned: false,
        location: 'LOCAL',
        repository: {
          provider: 'github',
          host: 'github.com',
          owner: 'acme',
          name: 'payments',
          providerRepoId: 'b1',
          defaultBranch: 'main',
          verification: 'VERIFIED',
        },
        state: 'ACTIVE',
        revision: 1,
        authorizationVersion: 1,
        defaultListed: true,
        preference: 'FOLLOW_DEFAULTS',
        listed: true,
        capabilities: { administer: false, manageCloud: false, use: true },
        instance: null,
      };

      beforeEach(() => {
        writeManifest('a', {
          version: 1,
          type: 'multi-repo',
          sourceRepoPath: repo,
          repos: [],
          owner: {
            type: 'organization',
            organizationId: ORGANIZATION,
            projectId: '00000000-0000-4000-8000-0000000000dd',
            instanceId: '00000000-0000-4000-8000-0000000000ee',
            bindingGeneration: 0,
          },
        });
        held = [];
        refresh = jest.fn(() =>
          Promise.resolve({
            context: `org:${ORGANIZATION}`,
            projects: held,
            revision: '1',
            fetchedAt: '2026-11-01T00:00:00.000Z',
            stale: false,
            error: null,
          }),
        );
        // The real gate over the real manifest and Git; only the hosted
        // catalog and project update are stubbed.
        gate = createOrgMemberMultiRepoSync({
          readConfig: readWorkspaceConfig,
          readRemoteUrl: (path) => git.getRemoteUrlStrict(path),
          catalog: { refresh },
          organizationName: () => 'Acme',
          updateRepositories: () => Promise.resolve('updated'),
          revert: {
            removeRepo: () => Promise.resolve(),
            restoreRepo: () => Promise.resolve(),
          },
        });
        jest.spyOn(orgSync, 'getOrgMemberMultiRepoSync').mockReturnValue(gate);
      });

      it.each([
        [
          'organization-repository-outside',
          { kind: 'never' },
          "payments doesn't belong to Acme. Choose repositories that belong to Acme.",
          (): void => {},
        ],
        [
          'organization-catalog-unavailable',
          { kind: 'after_refresh', resource: 'core.workspace.get' },
          "Couldn't check this repository with Acme. Try again.",
          (): void => {
            refresh.mockRejectedValue(new Error('offline'));
          },
        ],
        [
          'organization-remote-unreadable',
          { kind: 'after_refresh', resource: 'core.workspace.get' },
          // The checkout's folder name, never its path.
          /^Couldn't read the git remote of [^/\\]+\. Try again\.$/,
          (): void => {
            jest
              .spyOn(git, 'getRemoteUrlStrict')
              .mockRejectedValue(
                new Error(`fatal: not a git repository: ${repo}`),
              );
          },
        ],
      ] as const)(
        'a %s refusal is a path-free invalidState that uses no key',
        async (reason, retry, message, arrange) => {
          arrange();
          const before = images();
          const reserves = jest.spyOn(host, 'reserve');
          const lookups = jest.spyOn(host, 'lookupReceipt');
          const failure = await failureOf(
            instruct('core.workspace.sourceChanges.apply', ADD_PAYMENTS),
          );
          expect(failure).toMatchObject({
            payload: {
              kind: 'failed_precondition',
              code: 'core.workspace.invalidState',
              details: { reason },
              retry,
            },
          });
          const { payload } = failure as {
            payload: { message: string };
          };
          expect(payload.message).toMatch(message);
          expect(hasHostAbsolutePath(JSON.stringify(payload))).toBe(false);
          // Recheck the same key after admission, so a racing replay wins.
          expect(lookups).toHaveBeenCalledTimes(2);
          expect(lookups.mock.calls[1]).toEqual(lookups.mock.calls[0]);
          expect(reserves).not.toHaveBeenCalled();
          expect(images()).toEqual(before);
          expect(worktreeRows()).toHaveLength(0);
        },
      );

      it('the refused key stays unused: the same request and key apply once the organization holds the repository', async () => {
        bindLocalCheckout('payments');
        expect(
          await failureOf(
            instruct('core.workspace.sourceChanges.apply', ADD_PAYMENTS),
          ),
        ).toMatchObject({
          payload: { details: { reason: 'organization-repository-outside' } },
        });
        held = [payments];
        await expect(
          instruct('core.workspace.sourceChanges.apply', ADD_PAYMENTS),
        ).resolves.toMatchObject({ workspaceId: 'a', createdWorktree: true });
        await settleDetachedWork();
        expect(worktreeRows()).toHaveLength(1);
      });

      it('asks the organization outside the storage admission, so an ownership change never waits on it', async () => {
        bindLocalCheckout('payments');
        held = [payments];
        const answer = refresh.getMockImplementation();
        if (!answer) throw new Error('Expected the catalog stub');
        let asked = (): void => {};
        const asking = new Promise<void>((resolve) => {
          asked = resolve;
        });
        let answerNow = (): void => {};
        const answering = new Promise<void>((resolve) => {
          answerNow = resolve;
        });
        refresh.mockImplementation(async (organizationId) => {
          asked();
          await answering;
          return answer(organizationId);
        });
        const reserves = jest.spyOn(host, 'reserve');
        const applied = instruct(
          'core.workspace.sourceChanges.apply',
          ADD_PAYMENTS,
        );
        await asking;
        const change = withStorageOwnershipChange(
          [
            WORKSPACE_MANIFEST_STORAGE.namespace,
            WORKTREE_LIST_STORAGE.namespace,
          ],
          () => 'changed',
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        const waited = new Promise<string>((resolve) => {
          timer = setTimeout(
            () => resolve('waited on the organization'),
            2_000,
          );
        });
        const settled = await Promise.race([change, waited]);
        clearTimeout(timer);
        // The key is reserved only after the organization answers.
        const reservedWhileAsking = reserves.mock.calls.length;
        answerNow();
        expect(settled).toBe('changed');
        expect(reservedWhileAsking).toBe(0);
        await expect(applied).resolves.toMatchObject({
          workspaceId: 'a',
          createdWorktree: true,
        });
        expect(reserves).toHaveBeenCalledTimes(1);
        await change;
        await settleDetachedWork();
      });

      it('a replay answers its saved outcome without asking the organization again', async () => {
        bindLocalCheckout('payments');
        held = [payments];
        const result = await instruct(
          'core.workspace.sourceChanges.apply',
          ADD_PAYMENTS,
        );
        await settleDetachedWork();
        const asked = refresh.mock.calls.length;
        refresh.mockRejectedValue(new Error('offline'));
        const createWorktree = jest.spyOn(git, 'createWorktree');
        await expect(
          instruct('core.workspace.sourceChanges.apply', ADD_PAYMENTS),
        ).resolves.toEqual(result);
        expect(refresh).toHaveBeenCalledTimes(asked);
        expect(createWorktree).not.toHaveBeenCalled();
        expect(worktreeRows()).toHaveLength(1);
      });

      it("the IPC projection answers the gate's own error, its text unchanged", async () => {
        const request: WorkspaceApplySourceChangesRequest = {
          workspaceId: 'a',
          target: { mode: 'new', existingWorktreeIds: [] },
          repoAdds: [{ repoName: 'payments', remoteUrl: PAYMENTS }],
        };
        const run = (): Promise<unknown> =>
          gate.applySourceChanges('a', request, () =>
            applySourceChanges({
              kind: 'workspace',
              source: 'workspace_settings',
              request,
              getWindow: () => null,
            }),
          );
        const direct = await failureOf(run());
        const reserves = jest.spyOn(host, 'reserve');
        const projected = await failureOf(
          projectedSourceCompositionCommands({
            dispatcher,
            caller: IPC_CALLER,
          }).applySourceChanges('a', request, run),
        );
        expect(projected).toBeInstanceOf(OrgMultiRepoSyncRefusedError);
        // Electron's rejection text is built from the name and message.
        expect(String(projected)).toBe(String(direct));
        expect(String(projected)).toBe(
          "Error: payments doesn't belong to Acme. Choose repositories that belong to Acme.",
        );
        expect(reserves).not.toHaveBeenCalled();
      });
    });
  });
});

describe('composition (#18–20)', () => {
  it.each([
    [
      'core.workspace.composition.combine',
      { optionId: 'o', expectedRevision: 0, moveChats: false },
      'option-unavailable',
    ],
    [
      'core.workspace.composition.split',
      {
        previewId: 'p',
        expectedWorkspaceRevision: 0,
        approvedDestructiveItems: [],
      },
      'preview-unavailable',
    ],
  ] as const)(
    '%s is capability_unavailable and consumes no key',
    async (operation, params, reason) => {
      const before = images();
      const reserves = jest.spyOn(host, 'reserve');
      const lookups = jest.spyOn(host, 'lookupReceipt');
      expect(await failureOf(instruct(operation, params))).toMatchObject({
        payload: {
          kind: 'capability_unavailable',
          details: { reason },
          retry: { kind: 'never' },
        },
      });
      expect(lookups).not.toHaveBeenCalled();
      expect(reserves).not.toHaveBeenCalled();
      expect(await host.recoveryReport()).toMatchObject({
        interruptedReservations: 0,
        recoveryRequired: [],
      });
      expect(images()).toEqual(before);
      // The same key answers the same refusal, with nothing held.
      expect(await failureOf(instruct(operation, params))).toMatchObject({
        payload: { kind: 'capability_unavailable' },
      });
    },
  );

  it('#20 promotes a temporary project under a principal-scoped receipt and replays its reference', async () => {
    makeTemporaryMultiRepo();
    const reserves = jest.spyOn(host, 'reserve');
    const params = { workspaceId: 'a', expectedRevision: 0, name: 'Kept' };
    const result = await instruct('core.workspace.composition.promote', params);
    expect(result).toEqual({
      workspaceId: 'a',
      operation: {
        operationId: deriveCoreLifecycleOperationId(
          'local-desktop-user',
          'core.workspace.composition.promote',
          'k',
        ),
        state: 'succeeded',
      },
    });
    expect(reserves.mock.calls[0]?.[0]).toMatchObject({
      operation: 'core.workspace.composition.promote',
      receipt: { caller: 'daemon:local-desktop-user:composition-promote' },
    });
    const promoted: unknown = JSON.parse(
      readFileSync(join(root, 'index.json'), 'utf8'),
    );
    expect(
      (promoted as { workspaces: Array<Record<string, unknown>> })
        .workspaces[0],
    ).toMatchObject({ id: 'a', name: 'Kept' });
    const manifest: unknown = JSON.parse(
      readFileSync(join(root, 'a', 'workspace.json'), 'utf8'),
    );
    expect(manifest).not.toHaveProperty('temporary');
    const initGit = jest.spyOn(git, 'initGitRepo');
    rmSync(join(root, 'a'), { recursive: true, force: true });
    __resetSidebarItemsStateForTests();
    await expect(
      instruct('core.workspace.composition.promote', params),
    ).resolves.toEqual(result);
    expect(initGit).not.toHaveBeenCalled();
  });

  it('#20 refuses a project that is not temporary before any key', async () => {
    const reserves = jest.spyOn(host, 'reserve');
    expect(
      await failureOf(
        instruct('core.workspace.composition.promote', {
          workspaceId: 'a',
          expectedRevision: 0,
          name: 'Kept',
        }),
      ),
    ).toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.workspace.invalidState',
        details: { reason: 'not-temporary' },
      },
    });
    expect(
      await failureOf(
        instruct('core.workspace.composition.promote', {
          workspaceId: 'a',
          expectedRevision: 0,
          name: '   ',
        }),
      ),
    ).toMatchObject({
      payload: {
        kind: 'invalid_argument',
        details: { reason: 'invalid-request' },
      },
    });
    expect(reserves).not.toHaveBeenCalled();
  });

  it('#20 replays a concurrent same-key promotion even when its admission sees the promoted project', async () => {
    makeTemporaryMultiRepo();
    const params = { workspaceId: 'a', expectedRevision: 0, name: 'Kept' };
    const paused = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const lookup = host.lookupReceipt.bind(host);
    jest
      .spyOn(host, 'lookupReceipt')
      .mockImplementationOnce(async (receipt) => {
        const result = await lookup(receipt);
        expect(result.status).toBe('none');
        paused.resolve();
        await resume.promise;
        return result;
      });
    const reserves = jest.spyOn(host, 'reserve');
    const duplicate = instruct('core.workspace.composition.promote', params);
    await paused.promise;
    try {
      const winner = await instruct(
        'core.workspace.composition.promote',
        params,
      );
      resume.resolve();
      await expect(duplicate).resolves.toEqual(winner);
      expect(reserves).toHaveBeenCalledTimes(1);
    } finally {
      resume.resolve();
      await duplicate.catch(() => undefined);
    }
  });
});

describe('core.sharedContainer.fork (#29)', () => {
  const FORK = {
    containerId: 'c',
    revisionId: 'r',
    sourceOwnerDisplayName: 'Ada',
    destination: { kind: 'new-workspace', owner: { kind: 'personal' } },
  };

  it('is capability_unavailable for a new key while shared containers are off, before any workspace or source read', async () => {
    const service = featureFlags.getFeatureFlagService();
    jest.spyOn(service, 'isEnabled').mockReturnValue(false);
    const source = jest.spyOn(forkDestination, 'resolveForkSourceContext');
    const reserves = jest.spyOn(host, 'reserve');
    expect(
      await failureOf(instruct('core.sharedContainer.fork', FORK)),
    ).toMatchObject({
      payload: {
        kind: 'capability_unavailable',
        details: { reason: 'feature-unavailable' },
      },
    });
    expect(source).not.toHaveBeenCalled();
    expect(reserves).not.toHaveBeenCalled();
  });

  it('refuses a share this device never accepted before any key', async () => {
    const reserves = jest.spyOn(host, 'reserve');
    expect(
      await failureOf(instruct('core.sharedContainer.fork', FORK)),
    ).toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.sharedContainer.invalidState',
        details: { reason: 'source-unavailable' },
        retry: { kind: 'after_refresh', resource: 'core.workspace.list' },
      },
    });
    expect(reserves).not.toHaveBeenCalled();
  });

  describe('an accepted personal share', () => {
    const PROVENANCE = {
      sourceContainerId: 'c',
      sourceRevisionId: 'r',
      sourceOwnerDisplayName: 'Ada',
      forkedAt: '2026-11-01T00:00:00.000Z',
    };
    let copies: jest.SpiedFunction<
      typeof forkGuard.withSharedContainerForkGuard
    >;
    beforeEach(() => {
      jest
        .spyOn(forkDestination, 'resolveForkSourceContext')
        .mockResolvedValue({
          owner: { kind: 'personal' },
          acceptedAt: '2026-10-31T00:00:00.000Z',
          access: 'direct',
        });
      // The copy itself is the fork suites'; this one covers its wire entry.
      copies = jest
        .spyOn(forkGuard, 'withSharedContainerForkGuard')
        .mockImplementation(() =>
          Promise.resolve({
            containerType: 'CODE_WORKTREE',
            projectId: 'b',
            worktreeId: 'copy',
            warnings: [],
            provenance: PROVENANCE,
          }),
        );
      jest
        .spyOn(forkInstall, 'installForkCapabilityPackage')
        .mockResolvedValue([]);
    });

    it.each([
      { warnings: [] },
      { warnings: ['The capability package could not be installed.'] },
    ])(
      'replays the first package-install warnings without another install: %j',
      async ({ warnings }) => {
        const install = jest.mocked(forkInstall.installForkCapabilityPackage);
        install.mockResolvedValueOnce(warnings).mockResolvedValue([]);
        const result = await instruct('core.sharedContainer.fork', FORK);
        expect(result).toMatchObject({ warnings });
        await expect(
          instruct('core.sharedContainer.fork', FORK),
        ).resolves.toEqual(result);
        expect(install).toHaveBeenCalledTimes(1);
        expect(copies).toHaveBeenCalledTimes(1);
      },
    );

    it.each(['deleted', 'unreadable', 'transferred'] as const)(
      'replays an existing-destination fork before ownership admission: %s',
      async (state) => {
        const owner = jest.spyOn(forkDestination, 'assertForkWorkspaceOwner');
        const request = {
          ...FORK,
          destination: { kind: 'existing-workspace', workspaceId: 'b' },
        };
        const result = await instruct('core.sharedContainer.fork', request);
        expect(owner).toHaveBeenCalledTimes(1);
        if (state === 'deleted') {
          rmSync(join(root, 'b'), { recursive: true, force: true });
        } else if (state === 'unreadable') {
          writeFileSync(join(root, 'b', 'workspace.json'), '{invalid');
        } else {
          writeManifest('b', {
            version: 1,
            type: 'single-repo',
            repoPath: repo,
            repos: [],
            owner: {
              type: 'organization',
              organizationId: '11111111-1111-4111-8111-111111111111',
              projectId: '33333333-3333-4333-8333-333333333333',
              instanceId: '44444444-4444-4444-8444-444444444444',
              bindingGeneration: 1,
            },
          });
        }
        await expect(
          instruct('core.sharedContainer.fork', request),
        ).resolves.toEqual(result);
        expect(owner).toHaveBeenCalledTimes(1);
        expect(
          await failureOf(
            instruct('core.sharedContainer.fork', request, USER, 'new-fork'),
          ),
        ).toMatchObject({
          payload: {
            kind: 'failed_precondition',
            details: {
              reason:
                state === 'transferred'
                  ? 'owner-mismatch'
                  : 'destination-unavailable',
            },
          },
        });
        expect(copies).toHaveBeenCalledTimes(1);
      },
    );

    it('holds the fork reservation until the capability install settles', async () => {
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<string[]>();
      const install = jest.mocked(forkInstall.installForkCapabilityPackage);
      install.mockImplementationOnce(() => {
        entered.resolve();
        return finish.promise;
      });
      const first = instruct('core.sharedContainer.fork', FORK);
      try {
        await entered.promise;
        expect(
          await failureOf(instruct('core.sharedContainer.fork', FORK)),
        ).toMatchObject({
          payload: {
            kind: 'unavailable',
            code: 'core.sharedContainer.requestInProgress',
          },
        });
        finish.resolve(['Package install warning']);
        const result = await first;
        await expect(
          instruct('core.sharedContainer.fork', FORK),
        ).resolves.toEqual(result);
        expect(install).toHaveBeenCalledTimes(1);
      } finally {
        finish.resolve([]);
        await first.catch(() => undefined);
      }
    });

    it('does not replay a fork for a different disclosed capability package', async () => {
      const request = {
        ...FORK,
        expectedPackageDigest: `pp:v1:${'a'.repeat(43)}`,
      };
      await instruct('core.sharedContainer.fork', request);
      expect(
        await failureOf(
          instruct('core.sharedContainer.fork', {
            ...request,
            expectedPackageDigest: `pp:v1:${'b'.repeat(43)}`,
          }),
        ),
      ).toMatchObject({
        payload: {
          kind: 'conflict',
          code: 'core.sharedContainer.idempotencyKeyReused',
        },
      });
      expect(copies).toHaveBeenCalledTimes(1);
    });

    it('replays before the share context or capability changes, but refuses a new key', async () => {
      const result = await instruct('core.sharedContainer.fork', FORK);
      const source = jest.mocked(forkDestination.resolveForkSourceContext);
      source.mockClear();
      source.mockRejectedValue(
        new forkDestination.SharedContainerForkError(
          'source-unavailable',
          'Share dismissed',
        ),
      );
      const service = featureFlags.getFeatureFlagService();
      jest.spyOn(service, 'isEnabled').mockReturnValue(false);
      await expect(
        instruct('core.sharedContainer.fork', FORK),
      ).resolves.toEqual(result);
      expect(source).not.toHaveBeenCalled();
      expect(copies).toHaveBeenCalledTimes(1);
      expect(
        await failureOf(
          instruct('core.sharedContainer.fork', FORK, USER, 'new-fork'),
        ),
      ).toMatchObject({
        payload: {
          kind: 'capability_unavailable',
          details: { reason: 'feature-unavailable' },
        },
      });
    });

    it('forks into a new workspace at the host default under a principal-scoped receipt, and replays it', async () => {
      const reserves = jest.spyOn(host, 'reserve');
      const caller = { ...USER, principalId: 'remote-device:phone-1' };
      const result = await instruct('core.sharedContainer.fork', FORK, caller);
      expect(result).toEqual({
        containerType: 'CODE_WORKTREE',
        workspaceId: 'b',
        worktreeId: 'copy',
        warnings: [],
        provenance: PROVENANCE,
      });
      expect(copies.mock.calls[0]?.[0]).toMatchObject({
        destination: { kind: 'new-workspace', owner: { kind: 'personal' } },
      });
      expect(copies.mock.calls[0]?.[0].destination).not.toHaveProperty(
        'parentDirectory',
      );
      expect(reserves.mock.calls[0]?.[0]).toMatchObject({
        operation: 'core.sharedContainer.fork',
        receipt: {
          caller: 'daemon:remote-device:phone-1:shared-container-fork',
        },
      });
      await expect(
        instruct('core.sharedContainer.fork', FORK, caller),
      ).resolves.toEqual(result);
      expect(copies).toHaveBeenCalledTimes(1);
      expect(
        await failureOf(
          instruct(
            'core.sharedContainer.fork',
            { ...FORK, sourceOwnerDisplayName: 'Grace' },
            caller,
          ),
        ),
      ).toMatchObject({
        payload: {
          kind: 'conflict',
          code: 'core.sharedContainer.idempotencyKeyReused',
        },
      });
      // Another principal's same key is its own request.
      await instruct('core.sharedContainer.fork', FORK);
      expect(copies).toHaveBeenCalledTimes(2);
    });

    it('refuses an owner other than the accepted one before any key', async () => {
      const reserves = jest.spyOn(host, 'reserve');
      expect(
        await failureOf(
          instruct('core.sharedContainer.fork', {
            ...FORK,
            destination: {
              kind: 'new-workspace',
              owner: {
                kind: 'organization',
                organizationId: '00000000-0000-4000-8000-000000000001',
              },
            },
          }),
        ),
      ).toMatchObject({
        payload: {
          kind: 'failed_precondition',
          code: 'core.sharedContainer.invalidState',
          details: { reason: 'owner-mismatch' },
        },
      });
      expect(reserves).not.toHaveBeenCalled();
      expect(copies).not.toHaveBeenCalled();
    });
  });

  describe('a real copy into the host default location', () => {
    const REVISION_CREATED_AT = '2026-10-31T12:00:00.000Z';
    let reposDir: string;
    let baseCommitSha: string;

    beforeEach(async () => {
      reposDir = join(dataRoot, 'repos');
      const replicaRoot = join(dir, 'replicas');
      const revisionRoot = join(replicaRoot, 'c', 'revisions', 'r');
      // The published repository as the replica holds it: a checkout at its
      // base commit, with no remote of its own.
      const published = join(revisionRoot, 'repos', 'published-repo');
      mkdirSync(dirname(published), { recursive: true });
      execFileSync('git', ['clone', '-q', '--no-hardlinks', repo, published]);
      execFileSync('git', ['-C', published, 'remote', 'remove', 'origin']);
      baseCommitSha = execFileSync(
        'git',
        ['-C', published, 'rev-parse', 'HEAD'],
        { encoding: 'utf8' },
      ).trim();
      mkdirSync(join(revisionRoot, 'artifacts'));
      writeFileSync(
        join(revisionRoot, 'artifacts', 'container.json'),
        JSON.stringify({
          schemaVersion: 1,
          containerType: 'CODE_WORKTREE',
          title: 'Shared app',
          repositories: [
            {
              repoId: 'published-repo',
              repoName: 'app',
              remoteUrl: 'https://github.com/acme/app.git',
              owner: 'acme',
              repository: 'app',
              baseCommitSha,
              files: [],
            },
          ],
          files: [],
          notes: [],
          prompts: [],
          attachmentPaths: {},
        }),
      );
      const store = new SharedContainerReplicaStore(replicaRoot);
      await store.set({
        containerId: 'c',
        containerType: 'CODE_WORKTREE',
        access: 'direct',
        status: 'available',
        revisionId: 'r',
        revision: 1,
        revisionCreatedAt: REVISION_CREATED_AT,
        updatedAt: REVISION_CREATED_AT,
      });
      jest
        .spyOn(sharedContainerReader, 'getSharedContainerReader')
        .mockReturnValue(
          new sharedContainerReader.SharedContainerReader(store),
        );
      // Stubbed: the hosted acceptance lookup, the replica sync's read guard
      // (which pins this revision root) and the post-commit package install.
      jest
        .spyOn(forkDestination, 'resolveForkSourceContext')
        .mockResolvedValue({
          owner: { kind: 'personal' },
          acceptedAt: '2026-10-31T00:00:00.000Z',
          access: 'direct',
        });
      const reconciliation =
        sharedContainerReconciliation.getSharedContainerReconciliationService();
      jest
        .spyOn(reconciliation, 'withReplicaReadGuard')
        .mockImplementation((_containerId, _organizationId, revisionId, run) =>
          run(revisionRoot, {
            revisionId,
            revisionCreatedAt: REVISION_CREATED_AT,
          }),
        );
      jest
        .spyOn(forkInstall, 'installForkCapabilityPackage')
        .mockResolvedValue([]);
    });

    it('rechecks destination ownership after layout reads, before copying', async () => {
      const reader = sharedContainerReader.getSharedContainerReader();
      const readLayout = reader.readForkLayout.bind(reader);
      jest
        .spyOn(reader, 'readForkLayout')
        .mockImplementationOnce(async (input) => {
          const source = await readLayout(input);
          rmSync(join(root, 'b'), { recursive: true, force: true });
          return source;
        });
      const copies = jest.spyOn(forkCopyTree, 'copySharedContainerTree');
      const reserves = jest.spyOn(host, 'reserve');
      const releases = jest.spyOn(host, 'releaseReservation');
      expect(
        await failureOf(
          instruct('core.sharedContainer.fork', {
            ...FORK,
            destination: { kind: 'existing-workspace', workspaceId: 'b' },
          }),
        ),
      ).toMatchObject({
        payload: {
          kind: 'failed_precondition',
          details: { reason: 'destination-unavailable' },
        },
      });
      expect(reserves).toHaveBeenCalledTimes(1);
      expect(releases).toHaveBeenCalledTimes(1);
      expect(copies).not.toHaveBeenCalled();
      expect(forkInstall.installForkCapabilityPackage).not.toHaveBeenCalled();
    });

    it('forks end to end under a principal-scoped receipt, and replays without a second copy', async () => {
      const copies = jest.spyOn(forkCopyTree, 'copySharedContainerTree');
      const reserves = jest.spyOn(host, 'reserve');
      const commits = jest.spyOn(host, 'commit');
      const caller = { ...USER, principalId: 'remote-device:phone-1' };
      const result = await instruct('core.sharedContainer.fork', FORK, caller);
      await settleDetachedWork();
      expect(result).toMatchObject({
        containerType: 'CODE_WORKTREE',
        warnings: [],
        provenance: {
          sourceContainerId: 'c',
          sourceRevisionId: 'r',
          sourceRevisionCreatedAt: REVISION_CREATED_AT,
          sourceOwnerDisplayName: 'Ada',
        },
      });
      expect(hasHostAbsolutePath(JSON.stringify(result))).toBe(false);
      const { workspaceId, worktreeId } = result as {
        workspaceId: string;
        worktreeId: string;
      };
      // The promoted checkout is in the host's managed repos directory.
      expect(copies).toHaveBeenCalledTimes(1);
      const [, destination] = copies.mock.calls[0] ?? [];
      expect(destination).toBe(join(reposDir, 'app'));
      expect(existsSync(join(reposDir, 'app', '.git'))).toBe(true);
      expect(
        execFileSync(
          'git',
          ['-C', join(reposDir, 'app'), 'rev-parse', 'HEAD'],
          {
            encoding: 'utf8',
          },
        ).trim(),
      ).toBe(baseCommitSha);
      const manifest: unknown = JSON.parse(
        readFileSync(join(root, workspaceId, 'workspace.json'), 'utf8'),
      );
      expect(manifest).toMatchObject({
        type: 'single-repo',
        repoPath: join(reposDir, 'app'),
      });
      const worktrees: unknown = JSON.parse(
        readFileSync(join(root, workspaceId, 'worktrees.json'), 'utf8'),
      );
      expect(
        (worktrees as { worktrees: Array<{ id: string }> }).worktrees.map(
          (row) => row.id,
        ),
      ).toEqual([worktreeId]);
      expect(reserves.mock.calls[0]?.[0]).toMatchObject({
        operation: 'core.sharedContainer.fork',
        receipt: {
          caller: 'daemon:remote-device:phone-1:shared-container-fork',
        },
      });
      expect(commits).toHaveBeenCalled();
      const workspacesAfterFork = images()[0];

      await expect(
        instruct('core.sharedContainer.fork', FORK, caller),
      ).resolves.toEqual(result);
      expect(copies).toHaveBeenCalledTimes(1);
      expect(images()[0]).toBe(workspacesAfterFork);
      const reused = await failureOf(
        instruct(
          'core.sharedContainer.fork',
          { ...FORK, sourceOwnerDisplayName: 'Grace' },
          caller,
        ),
      );
      expect(reused).toMatchObject({
        payload: {
          kind: 'conflict',
          code: 'core.sharedContainer.idempotencyKeyReused',
        },
      });
      expect(
        hasHostAbsolutePath(
          JSON.stringify((reused as { payload: unknown }).payload),
        ),
      ).toBe(false);
      expect(copies).toHaveBeenCalledTimes(1);
    });
  });

  it('never takes a parent directory: the host path is not a wire field', async () => {
    expect(
      await failureOf(
        instruct('core.sharedContainer.fork', {
          containerId: 'c',
          revisionId: 'r',
          sourceOwnerDisplayName: 'Ada',
          destination: {
            kind: 'new-workspace',
            owner: { kind: 'personal' },
            parentDirectory: '/tmp/elsewhere',
          },
        }),
      ),
    ).toMatchObject({ payload: { kind: 'invalid_argument' } });
  });
});

describe('recovery classes (A24-L)', () => {
  /** Maintenance needs a host that never started a worker. */
  function maintenanceContext(): W5MaintenanceContext {
    const os = hostPlatformOperatingSystem();
    const platform = hostPlatformServices(createPlatformEndpointServices(os));
    return {
      host: new W5CommitLogHost({
        dbPath: dbPath(),
        root,
        workerEntry: join(
          __dirname,
          '../../w5-commit-log/commit-log-worker.ts',
        ),
      }),
      dataRoot,
      platform: {
        ...platform,
        supervision: {
          ...platform.supervision,
          inspectProcess: ({ pid }) =>
            Promise.resolve(
              pid === process.pid
                ? { state: 'running', startIdentity: 'fixture-self-start' }
                : { state: 'absent' },
            ),
        },
      },
    };
  }
  const resolve = (
    decisions: readonly W5MaintenanceDecision[],
  ): ReturnType<typeof runW5Maintenance> =>
    runW5Maintenance(maintenanceContext(), {
      source: 'offline_maintenance',
      mode: 'resolve',
      decisions,
    });
  async function diagnosis(): Promise<
    Extract<Awaited<ReturnType<typeof runW5Maintenance>>, { mode: 'diagnose' }>
  > {
    const result = await runW5Maintenance(maintenanceContext(), {
      source: 'offline_maintenance',
      mode: 'diagnose',
    });
    if (result.mode !== 'diagnose') throw new Error('Expected diagnosis');
    return result;
  }

  posix(
    '#27: a failure after Git is recoveryRequired, diagnosed, and never resolvable offline',
    async () => {
      jest.spyOn(host, 'commit').mockImplementationOnce(async () => {
        await host.shutdown();
        throw new Error('interrupted at the record');
      });
      expect(
        await failureOf(instruct('core.worktree.branch.rename', RENAME)),
      ).toMatchObject({ payload: { kind: 'internal' } });
      // The started rename is kept.
      expect(currentBranch('one')).toBe('renamed');
      await host.shutdown();
      startHost();
      const rename = jest.spyOn(git, 'renameBranch');
      expect(
        await failureOf(instruct('core.worktree.branch.rename', RENAME)),
      ).toMatchObject({
        payload: {
          kind: 'failed_precondition',
          code: 'core.worktree.recoveryRequired',
          retry: { kind: 'never' },
        },
      });
      expect(rename).not.toHaveBeenCalled();
      await host.shutdown();
      const { diagnosis: found } = await diagnosis();
      const [reservation] = found.reservations;
      expect(reservation).toMatchObject({
        operation: 'core.worktree.branch.rename',
        state: 'recovery-required',
      });
      await expect(
        resolve([
          {
            kind: 'resolve-reservation',
            reservationId: reservation?.reservationId ?? '',
          },
        ]),
      ).rejects.toMatchObject({ reason: 'operation-excluded', decision: 0 });
    },
  );

  /** A wire call whose decision commits but whose files changed out of band. */
  function wedgeNextDecision(): void {
    const commit = host.commit.bind(host);
    jest.spyOn(host, 'commit').mockImplementationOnce(async (request) => {
      for (const { path, previousFingerprint } of request.files)
        if (previousFingerprint !== null)
          writeFileSync(path, '{"foreign":true}\n');
      return commit(request);
    });
  }

  posix(
    '#27: abandoning its receipt-free record releases no key; the reservation stays terminal',
    async () => {
      wedgeNextDecision();
      expect(
        await failureOf(instruct('core.worktree.branch.rename', RENAME)),
      ).toMatchObject({
        payload: { code: 'core.worktree.recoveryRequired' },
      });
      await host.shutdown();
      const { diagnosis: found } = await diagnosis();
      const [decided] = found.commits;
      expect(decided).toMatchObject({
        operation: 'core.worktree.branch.rename',
        state: 'recovery-required',
        receiptOperations: [],
      });
      const [reservation] = found.reservations;
      expect(reservation).toMatchObject({
        operation: 'core.worktree.branch.rename',
        state: 'recovery-required',
      });
      // The receipt is saved only after the record, so the decided record
      // holds none: abandoning it keeps the reservation, and its key.
      await expect(
        resolve([{ kind: 'abandon-commit', commitId: decided?.commitId ?? 0 }]),
      ).resolves.toMatchObject({
        results: [{ status: 'abandoned' }],
        diagnosis: {
          reservations: [
            {
              operation: 'core.worktree.branch.rename',
              state: 'recovery-required',
            },
          ],
        },
      });
      await expect(
        resolve([
          {
            kind: 'resolve-reservation',
            reservationId: reservation?.reservationId ?? '',
          },
        ]),
      ).rejects.toMatchObject({ reason: 'operation-excluded', decision: 0 });
      startHost();
      expect(
        await failureOf(instruct('core.worktree.branch.rename', RENAME)),
      ).toMatchObject({
        payload: { code: 'core.worktree.recoveryRequired' },
      });
    },
  );

  posix(
    '#16: a decided but unapplied conversion holds its receipt, so abandon-commit refuses',
    async () => {
      writeFileSync(
        join(root, 'a', 'worktrees.json'),
        JSON.stringify({ version: 1, worktrees: [] }),
      );
      __resetSidebarItemsStateForTests();
      wedgeNextDecision();
      expect(
        await failureOf(
          instruct('core.workspace.type.convert', {
            workspaceId: 'a',
            targetKind: 'multi_repo',
          }),
        ),
      ).toMatchObject({
        payload: { code: 'core.workspace.recoveryRequired' },
      });
      await host.shutdown();
      const { diagnosis: found } = await diagnosis();
      const [decided] = found.commits;
      expect(decided).toMatchObject({
        operation: 'core.workspace.type.convert',
        state: 'recovery-required',
        receiptOperations: ['core.workspace.type.convert'],
      });
      await expect(
        resolve([{ kind: 'abandon-commit', commitId: decided?.commitId ?? 0 }]),
      ).rejects.toMatchObject({ reason: 'operation-excluded', decision: 0 });
    },
  );

  posix(
    '#15: a Git failure after the folder exists is recoveryRequired and keeps the folder',
    async () => {
      writeManifest('a', { version: 1, type: 'multi-repo', repos: [] });
      jest
        .spyOn(git, 'commitWithLocalIdentity')
        .mockRejectedValueOnce(new Error('git commit failed'));
      expect(
        await failureOf(
          instruct('core.workspace.sourceRepo.initialize', {
            workspaceId: 'a',
          }),
        ),
      ).toMatchObject({ payload: { kind: 'internal' } });
      expect(existsSync(join(dataRoot, 'repos', 'original'))).toBe(true);
      expect(
        await failureOf(
          instruct('core.workspace.sourceRepo.initialize', {
            workspaceId: 'a',
          }),
        ),
      ).toMatchObject({
        payload: { code: 'core.workspace.recoveryRequired' },
      });
      await host.shutdown();
      const { diagnosis: found } = await diagnosis();
      const [reservation] = found.reservations;
      expect(reservation).toMatchObject({
        operation: 'core.workspace.sourceRepo.initialize',
        state: 'recovery-required',
      });
      await expect(
        resolve([
          {
            kind: 'resolve-reservation',
            reservationId: reservation?.reservationId ?? '',
          },
        ]),
      ).rejects.toMatchObject({ reason: 'operation-excluded' });
    },
  );

  /** Diagnoses the one terminal reservation and shows it never resolves. */
  async function expectTerminalReservation(operation: string): Promise<void> {
    await host.shutdown();
    const { diagnosis: found } = await diagnosis();
    const [reservation] = found.reservations;
    expect(reservation).toMatchObject({
      operation,
      state: 'recovery-required',
    });
    await expect(
      resolve([
        {
          kind: 'resolve-reservation',
          reservationId: reservation?.reservationId ?? '',
        },
      ]),
    ).rejects.toMatchObject({ reason: 'operation-excluded', decision: 0 });
  }

  posix(
    '#20: a Git failure after promotion starts is recoveryRequired, diagnosed, and never resolvable offline',
    async () => {
      makeTemporaryMultiRepo();
      jest
        .spyOn(git, 'commitWithLocalIdentity')
        .mockRejectedValueOnce(new Error('git commit failed'));
      const params = { workspaceId: 'a', expectedRevision: 0, name: 'Kept' };
      expect(
        await failureOf(instruct('core.workspace.composition.promote', params)),
      ).toMatchObject({ payload: { kind: 'internal' } });
      expect(
        await failureOf(instruct('core.workspace.composition.promote', params)),
      ).toMatchObject({
        payload: { code: 'core.workspace.recoveryRequired' },
      });
      await expectTerminalReservation('core.workspace.composition.promote');
    },
  );

  posix(
    '#17: an interruption at the foreground acceptance is recoveryRequired, diagnosed, and never resolvable offline',
    async () => {
      const change = {
        workspaceId: 'a',
        target: { mode: 'existing', worktreeId: 'one' },
        scripts: { dev: 'pnpm dev' },
      };
      jest.spyOn(host, 'commit').mockImplementationOnce(async () => {
        await host.shutdown();
        throw new Error('interrupted at the acceptance');
      });
      expect(
        await failureOf(instruct('core.workspace.sourceChanges.apply', change)),
      ).toMatchObject({ payload: { kind: 'internal' } });
      // The started change is kept.
      expect(
        readFileSync(join(checkout('one'), 'canopy.json'), 'utf8'),
      ).toContain('pnpm dev');
      await host.shutdown();
      startHost();
      expect(
        await failureOf(instruct('core.workspace.sourceChanges.apply', change)),
      ).toMatchObject({
        payload: {
          kind: 'failed_precondition',
          code: 'core.workspace.recoveryRequired',
          retry: { kind: 'never' },
        },
      });
      await expectTerminalReservation('core.workspace.sourceChanges.apply');
    },
  );

  posix(
    '#29: an interruption after the copy is recoveryRequired, diagnosed, and never resolvable offline',
    async () => {
      jest
        .spyOn(forkDestination, 'resolveForkSourceContext')
        .mockResolvedValue({
          owner: { kind: 'personal' },
          acceptedAt: '2026-10-31T00:00:00.000Z',
          access: 'direct',
        });
      const copies = jest
        .spyOn(forkGuard, 'withSharedContainerForkGuard')
        .mockResolvedValue({
          containerType: 'CODE_WORKTREE',
          projectId: 'b',
          worktreeId: 'copy',
          warnings: [],
          provenance: {
            sourceContainerId: 'c',
            sourceRevisionId: 'r',
            sourceOwnerDisplayName: 'Ada',
            forkedAt: '2026-11-01T00:00:00.000Z',
          },
        });
      jest.spyOn(host, 'commit').mockImplementationOnce(async () => {
        await host.shutdown();
        throw new Error('interrupted at the outcome');
      });
      const fork = {
        containerId: 'c',
        revisionId: 'r',
        sourceOwnerDisplayName: 'Ada',
        destination: { kind: 'new-workspace', owner: { kind: 'personal' } },
      };
      expect(
        await failureOf(instruct('core.sharedContainer.fork', fork)),
      ).toMatchObject({ payload: { kind: 'internal' } });
      await host.shutdown();
      startHost();
      expect(
        await failureOf(instruct('core.sharedContainer.fork', fork)),
      ).toMatchObject({
        payload: {
          kind: 'failed_precondition',
          code: 'core.sharedContainer.recoveryRequired',
          retry: { kind: 'never' },
        },
      });
      expect(copies).toHaveBeenCalledTimes(1);
      await expectTerminalReservation('core.sharedContainer.fork');
    },
  );
});
