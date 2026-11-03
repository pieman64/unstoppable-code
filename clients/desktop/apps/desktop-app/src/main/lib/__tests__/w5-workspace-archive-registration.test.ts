// W7b-2a (CAN-5524): archive, workspace delete and archive restore registered
// on the real desktop runtime, commit-log worker, canonical files and Git; the
// creates' suite is w5-workspace-lifecycle-registration.test.ts. Host hooks
// the archive suites stub are stubbed here too.
import type * as CostLifecycle from '../../cost-index/lifecycle';
import type * as LedgerLifecycle from '../../ledger/lifecycle';
import type * as MainProcessLogging from '../main-process-logging';
import type * as WindowSend from '../window-send';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import type * as ArchiveEngine from '../../archive/archive-io-engine';
import type {
  ArchiveIoOperationRequest,
  ArchiveIoOperationType,
  ArchiveIoResultMap,
} from '../../archive/archive-io-protocol';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('../post-archive-sync', () => ({
  queueTrackedGitHubWorktreeSync: jest.fn(),
}));
jest.mock('../auto-archive-teardown', () => ({
  runAutoArchiveTeardown: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../browser/browser-profile-lifecycle', () => ({
  prepareTaskBrowserRetirement: jest.fn(() => Promise.resolve('retirement')),
  settleFailedTaskBrowserRetirement: jest.fn(() => Promise.resolve()),
  retireRemovedBrowserTask: jest.fn(() => Promise.resolve()),
  prepareWorkspaceBrowserRetirement: jest.fn(() => Promise.resolve([])),
  commitTaskBrowserRetirement: jest.fn(() => Promise.resolve(false)),
  abortTaskBrowserRetirement: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({
    cancelLocalScope: jest.fn(() => Promise.resolve()),
    commitLocalScopeCancellation: jest.fn(() => Promise.resolve()),
    releaseLocalScopeFence: jest.fn(() => Promise.resolve()),
    cancelLocalWorkspace: jest.fn(() => Promise.resolve()),
    commitLocalWorkspaceCancellation: jest.fn(() => Promise.resolve()),
    releaseLocalWorkspaceFence: jest.fn(() => Promise.resolve()),
  })),
}));
jest.mock('../../chat-search/service', () => ({
  getChatSearchService: jest.fn(() => ({
    deleteWorkspaceDocs: jest.fn(() => Promise.resolve()),
    deleteWorktreeDocs: jest.fn(() => Promise.resolve()),
    worktreeContainerArchived: jest.fn(() => Promise.resolve()),
    worktreeContainerPurged: jest.fn(() => Promise.resolve()),
    worktreeContainerRestored: jest.fn(() => Promise.resolve()),
  })),
}));
jest.mock('../../ledger/lifecycle', () => ({
  ...jest.requireActual<typeof LedgerLifecycle>('../../ledger/lifecycle'),
  LEDGER_INTENT_REFUSING_WAIT_MS: 5000,
  captureLedgerWorkspaceIncarnations: jest.fn(() => Promise.resolve(null)),
  notifyLedgerWorkspaceDeleted: jest.fn(),
  notifyLedgerContainerArchived: jest.fn(),
  notifyLedgerContainerRestored: jest.fn(),
  recordLedgerRestoreIntent: jest.fn(() => Promise.resolve('recorded')),
}));
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    purgeWorktreeData: jest.fn(() => Promise.resolve()),
    recordAppDiagnostic: jest.fn(),
    recordUsageMetricEvent: jest.fn(),
    interruptMatchingEntries: jest.fn(),
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
jest.mock('../../archive/archive-io-runner', () => ({
  // Replace Electron utility-process transport with the real filesystem engine.
  runArchiveIoRequest: (
    request: ArchiveIoOperationRequest,
  ): Promise<ArchiveIoResultMap[ArchiveIoOperationType]> =>
    jest
      .requireActual<typeof ArchiveEngine>('../../archive/archive-io-engine')
      .executeArchiveIoRequest(request, new AbortController().signal, {
        progress: () => {},
        child: { started: () => {}, exited: () => {} },
      }),
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
jest.mock('../window-send', () => ({
  ...jest.requireActual<typeof WindowSend>('../window-send'),
  sendToAllWindows: jest.fn(),
}));

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
} from '@canopy/core-platform';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  W5CommitLog,
  applyW5Commit,
} from '@canopy/desktop-shared/node/w5-commit-log';
import { CanopyOperationError } from '@canopy/core-runtime';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { getAppAdvisorWatcherService } from '../../app-advisor/watchers';
import { prepareWorkspaceBrowserRetirement } from '../../browser/browser-profile-lifecycle';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import { projectedWorkspaceLifecycleCommands } from '../../canopy-runtime/workspace-lifecycle-dispatch';
import { projectedWorkspaceGuardedCommands } from '../../canopy-runtime/workspace-guarded-dispatch';
import { unusedGitReadRuntime } from '../../__tests__/helpers/unused-git-read-runtime';
import { resetChatStateServiceForTests } from '../../services/chat-state-service';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import * as archiveGit from '../archived-container-git';
import * as archivedContainers from '../archived-containers';
import { waitForScheduledArchivedContainerDiskUsage } from '../archived-container-disk-usage';
import { listArchivedContainerManifests } from '../archived-containers';
import { logMainProcessWarn } from '../main-process-logging';
import {
  getArchivedContainerManifestPath,
  getW5DestructiveLifecycleDir,
} from '../paths';
import { readDestructiveRecovery } from '../w5-destructive-recovery';
import {
  __resetSidebarItemsStateForTests,
  getWorkspaceIndexRepository,
} from '../sidebar-items';
import {
  createW5CommitLogFileStore,
  readW5Revisions,
  __setDesktopW5FileStoreForTests,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import {
  runW5Maintenance,
  type W5MaintenanceContext,
  type W5MaintenanceDecision,
} from '../w5-maintenance';
import { updateWorkspaceMetadata } from '../workspace-metadata';
import { sendToAllWindows } from '../window-send';
import { readWorkspaceWorktrees } from '../workspace-persistence';
import { archiveWorktree } from '../worktree-archive';
import { runAutoArchiveTeardown } from '../auto-archive-teardown';
import { updateWorktree } from '../worktree-update';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import { shutdownW5BoundaryHost } from './fixtures/w5-boundary-host';

jest.setTimeout(60_000);
// restoreAllMocks keeps a module mock's mockReturnValue; tests that share one
// watcher service put the factory's fresh service back afterwards.
const freshWatcherService = jest
  .mocked(getAppAdvisorWatcherService)
  .getMockImplementation();
let dir: string;
let dataRoot: string;
let root: string;
let repo: string;
let createdAt: string;
let host: W5CommitLogHost;
let dispatcher: DesktopCanopyDispatcher;
let originalDataDir: string | undefined;

const dbPath = (): string => join(dataRoot, 'w5', 'commit-log.sqlite');
const listPath = (workspaceId = 'a'): string =>
  join(root, workspaceId, 'worktrees.json');
const checkout = (): string => join(root, 'a', 'worktrees', 'one');

function startHost(): void {
  host = new W5CommitLogHost({
    dbPath: dbPath(),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  __resetSidebarItemsStateForTests();
}

/**
 * Recreates `a`'s list through a logged W5 commit, as the desktop creates
 * lists, so its provenance is canonical (a list the log never created is
 * `pre-log` or `untracked`). No row is advanced: each has no revision.
 */
async function logList(): Promise<void> {
  const contents = readFileSync(listPath(), 'utf8');
  rmSync(listPath());
  mkdirSync(join(dataRoot, 'w5'), { recursive: true });
  const log = W5CommitLog.open(dbPath());
  try {
    const { commitId } = log.commit({
      operation: 'fixture.list',
      advance: [{ kind: 'worktrees', workspaceId: 'a' }],
      files: [{ path: listPath(), contents, previousFingerprint: null }],
      outcome: null,
    });
    const pending = log
      .listPendingCommits()
      .find((entry) => entry.commitId === commitId);
    if (!pending) throw new Error('Missing fixture commit');
    await applyW5Commit(log, pending, { root });
  } finally {
    log.close();
  }
}

beforeEach(async () => {
  jest.mocked(sendToAllWindows).mockReset();
  resetChatStateServiceForTests();
  ({ dir, root, repo } = createW5BoundaryFixture(
    (at) => {
      createdAt = at;
      return [
        { id: 'one', branchName: 'old', createdAt: at },
        { id: 'two', branchName: 'second', createdAt: at },
      ];
    },
    ['b'],
  ));
  dataRoot = join(dir, 'data');
  // Maintenance runs only under a private data root.
  chmodSync(dataRoot, 0o700);
  mkdirSync(join(dataRoot, 'runtime'), { mode: 0o700 });
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataRoot;
  await logList();
  startHost();
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
  dispatcher = createDesktopRuntime();
});
afterEach(async () => {
  await waitForScheduledArchivedContainerDiskUsage();
  await settleDetachedWork();
  await dispatcher.shutdown();
  jest.restoreAllMocks();
  if (freshWatcherService)
    jest
      .mocked(getAppAdvisorWatcherService)
      .mockImplementation(freshWatcherService);
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await shutdownW5BoundaryHost(host, dbPath());
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

const ANY_STRING: unknown = expect.any(String);
const OPERATION_ID: unknown = expect.stringMatching(/^[0-9a-f-]{36}$/);

/** The local user, as an agent or a wire client calls; Q8 admits it. */
const USER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'agent-client',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [
    'core.worktree.read',
    'core.worktree.write',
    'core.workspace.write',
    'core.archive.write',
  ],
};
/** A trusted renderer caller, as `deriveDesktopIpcCaller` builds one. */
const IPC_CALLER: CanopyCallerDescriptor = {
  ...USER,
  clientInstanceId: 'electron-web-contents:1',
  grants: ['core.workspace.read', 'core.worktree.read'],
};

/** Any operation by name, as a wire caller sends it. */
function instruct(
  operation: string,
  params: Record<string, unknown>,
  caller: CanopyCallerDescriptor = USER,
): Promise<unknown> {
  const call = dispatcher.instruction.bind(dispatcher) as unknown as (
    name: string,
    params: Record<string, unknown>,
    options: {
      caller: CanopyCallerDescriptor;
      metadata?: { idempotencyKey: string };
    },
  ) => Promise<unknown>;
  const meta = params._meta as { idempotencyKey: string } | undefined;
  return call(operation, params, {
    caller,
    ...(meta && { metadata: { idempotencyKey: meta.idempotencyKey } }),
  });
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected a failure');
}

function rowIds(workspaceId = 'a'): string[] {
  const parsed: unknown = JSON.parse(
    readFileSync(listPath(workspaceId), 'utf8'),
  );
  return (parsed as { worktrees: Array<{ id: string }> }).worktrees.map(
    (row) => row.id,
  );
}

function indexIds(): string[] {
  const parsed: unknown = JSON.parse(
    readFileSync(join(root, 'index.json'), 'utf8'),
  );
  return (parsed as { workspaces: Array<{ id: string }> }).workspaces.map(
    (entry) => entry.id,
  );
}

/** The worktree's revision as `core.worktree.get` publishes it, if it does. */
async function readRevision(worktreeId = 'one'): Promise<number | undefined> {
  const read = await dispatcher.query(
    'core.worktree.get',
    { worktreeId, scope: { workspaceId: 'a' } },
    { caller: USER },
  );
  return read.revision;
}

/** A W5 commit of the list that advances only `worktreeId` (unkeyed). */
async function commitRow(worktreeId: string): Promise<void> {
  await updateWorktree({
    workspaceId: 'a',
    worktreeId,
    patch: { pinned: true },
  });
}

const archive = (
  revision: number,
  extra: Record<string, unknown> = {},
): Promise<unknown> =>
  instruct('core.worktree.archive', {
    worktreeId: 'one',
    expectedRevision: revision,
    archived: true,
    ...extra,
  });

describe('registration and Q8 callers', () => {
  const OPERATIONS: Array<[string, Record<string, unknown>]> = [
    [
      'core.worktree.delete',
      {
        worktreeId: 'one',
        expectedRevision: 0,
        _meta: { idempotencyKey: 'no-grant' },
      },
    ],
    [
      'core.worktree.archive',
      { worktreeId: 'one', expectedRevision: 0, archived: true },
    ],
    [
      'core.workspace.delete',
      {
        workspaceId: 'b',
        expectedRevision: 0,
        _meta: { idempotencyKey: 'no-grant' },
      },
    ],
    [
      'core.archive.container.restore',
      {
        archiveId: 'archive-1',
        expectedRevision: 0,
        destinationScope: { workspaceId: 'a' },
        conflictPolicy: 'fail',
        _meta: { idempotencyKey: 'no-grant' },
      },
    ],
  ];

  it.each(OPERATIONS)(
    '%s without its grant is permission_denied with nothing changed',
    async (operation, params) => {
      const reserve = jest.spyOn(host, 'reserve');
      const before = [rowIds(), indexIds()];
      expect(
        await failureOf(instruct(operation, params, IPC_CALLER)),
      ).toMatchObject({ payload: { kind: 'permission_denied' } });
      expect([rowIds(), indexIds()]).toEqual(before);
      expect(reserve).not.toHaveBeenCalled();
    },
  );

  it.each(OPERATIONS)(
    '%s refuses the relay, Portal sessions and unlisted principals despite the grant',
    async (operation, params) => {
      const reserve = jest.spyOn(host, 'reserve');
      for (const caller of [
        { ...USER, principalId: 'local-desktop-renderer:main' },
        { ...USER, principalId: 'portal-session:s-1', interfaceKind: 'portal' },
        { ...USER, principalId: 'agent-7' },
      ] satisfies CanopyCallerDescriptor[])
        expect(
          await failureOf(instruct(operation, params, caller)),
        ).toMatchObject({
          payload: {
            kind: 'permission_denied',
            details: { reason: 'caller-refused' },
          },
        });
      expect(rowIds()).toEqual(['one', 'two']);
      expect(indexIds()).toEqual(['a', 'b']);
      expect(reserve).not.toHaveBeenCalled();
    },
  );

  it('admits a paired remote device (B5)', async () => {
    await commitRow('one');
    const revision = await readRevision();
    await expect(
      instruct(
        'core.worktree.archive',
        { worktreeId: 'one', expectedRevision: revision, archived: true },
        { ...USER, principalId: 'remote-device:device-1' },
      ),
    ).resolves.toMatchObject({ worktreeId: 'one', state: 'archived' });
  });
});

describe('core.worktree.archive (#24)', () => {
  it('a retained result that cannot be represented is invalidState without changing anything', async () => {
    await wireArchive();
    const manifests = await listArchivedContainerManifests('a');
    jest
      .spyOn(archivedContainers, 'listArchivedContainerManifests')
      .mockResolvedValue(
        manifests.map((manifest) => {
          if (!manifest.originalWorktree)
            throw new Error('Missing worktree snapshot');
          return {
            ...manifest,
            originalWorktree: {
              ...manifest.originalWorktree,
              label: 'x'.repeat(513),
            },
          };
        }),
      );
    const before = readFileSync(listPath(), 'utf8');
    expect(
      await failureOf(archive(0, { scope: { workspaceId: 'a' } })),
    ).toMatchObject({
      payload: {
        kind: 'capability_unavailable',
        code: 'core.worktree.invalidState',
        details: { reason: 'result-unavailable' },
        retry: { kind: 'never' },
      },
    });
    expect(readFileSync(listPath(), 'utf8')).toBe(before);
  });

  it('archives with the read revision, answers the row read before the effect and keeps a locked container', async () => {
    await commitRow('one');
    const revision = await readRevision();
    expect(revision).toBe(1);
    const result = await archive(revision ?? -1);
    expect(result).toEqual({
      worktreeId: 'one',
      workspaceId: 'a',
      name: 'old',
      state: 'archived',
      baseBranch: null,
      branch: 'old',
      createdAt,
    });
    expect(rowIds()).toEqual(['two']);
    expect(existsSync(checkout())).toBe(false);
    const [manifest] = await listArchivedContainerManifests('a');
    expect(manifest).toMatchObject({
      kind: 'worktree',
      lockedAt: ANY_STRING,
      originalWorktree: { id: 'one', createdAt },
    });
    // B5/DP-2: a repeat answers the retained container's worktree, no effect.
    const commits = jest.spyOn(host, 'commit');
    await expect(archive(revision ?? -1)).resolves.toEqual(result);
    await expect(
      archive(0, { scope: { workspaceId: 'a' }, expectedCreatedAt: createdAt }),
    ).resolves.toEqual(result);
    expect(commits).not.toHaveBeenCalled();
  });

  it('a repeat after a failed post-publication cleanup resumes that cleanup through the boundary before answering', async () => {
    const watcher = getAppAdvisorWatcherService();
    const commitCancellation = jest
      .spyOn(watcher, 'commitLocalScopeCancellation')
      .mockRejectedValueOnce(new Error('watcher failed'));
    jest.mocked(getAppAdvisorWatcherService).mockReturnValue(watcher);
    await commitRow('one');
    const revision = (await readRevision()) ?? -1;
    expect(await failureOf(archive(revision))).toBeInstanceOf(
      CanopyOperationError,
    );
    expect(sendToAllWindows).not.toHaveBeenCalledWith(
      IPC_CHANNELS.workspaceWorktreesUpdated,
      expect.anything(),
    );
    // The manifest is published and the row is gone; cleanup is unfinished.
    expect(rowIds()).toEqual(['two']);
    expect(await listArchivedContainerManifests('a')).toHaveLength(1);
    expect(await readDestructiveRecovery('a', 'one')).toMatchObject({
      operation: 'worktree-archive',
      state: 'recovery-required',
    });
    await expect(archive(revision)).resolves.toMatchObject({
      worktreeId: 'one',
      state: 'archived',
    });
    expect(commitCancellation).toHaveBeenCalledTimes(2);
    expect(await readDestructiveRecovery('a', 'one')).toMatchObject({
      state: 'completed',
    });
    expect(sendToAllWindows).toHaveBeenCalledWith(
      IPC_CHANNELS.workspaceWorktreesUpdated,
      { workspaceId: 'a' },
    );
    jest.mocked(sendToAllWindows).mockClear();
    // Once finished, a repeat answers again with no effect.
    await expect(archive(revision)).resolves.toMatchObject({
      worktreeId: 'one',
      state: 'archived',
    });
    expect(commitCancellation).toHaveBeenCalledTimes(2);
    expect(sendToAllWindows).not.toHaveBeenCalledWith(
      IPC_CHANNELS.workspaceWorktreesUpdated,
      expect.anything(),
    );
  });

  it('a repeat whose unfinished cleanup the boundary cannot resume is refused recoveryRequired, not answered', async () => {
    const watcher = getAppAdvisorWatcherService();
    const commitCancellation = jest
      .spyOn(watcher, 'commitLocalScopeCancellation')
      .mockRejectedValueOnce(new Error('watcher failed'));
    jest.mocked(getAppAdvisorWatcherService).mockReturnValue(watcher);
    await commitRow('one');
    const revision = (await readRevision()) ?? -1;
    expect(await failureOf(archive(revision))).toBeInstanceOf(
      CanopyOperationError,
    );
    // The retained container can no longer be verified for this cleanup.
    const [manifest] = await listArchivedContainerManifests('a');
    writeFileSync(
      getArchivedContainerManifestPath('a', manifest?.id ?? ''),
      'not json',
    );
    for (let attempt = 0; attempt < 2; attempt += 1)
      expect(await failureOf(archive(revision))).toMatchObject({
        payload: {
          kind: 'failed_precondition',
          code: 'core.worktree.recoveryRequired',
          retry: { kind: 'never' },
        },
      });
    expect(commitCancellation).toHaveBeenCalledTimes(1);
    expect(await readDestructiveRecovery('a', 'one')).toMatchObject({
      state: 'recovery-required',
    });
  });

  it('a repeat naming another incarnation answers for that one and leaves the unfinished cleanup alone', async () => {
    const watcher = getAppAdvisorWatcherService();
    const commitCancellation = jest
      .spyOn(watcher, 'commitLocalScopeCancellation')
      .mockRejectedValueOnce(new Error('watcher failed'));
    jest.mocked(getAppAdvisorWatcherService).mockReturnValue(watcher);
    await commitRow('one');
    const revision = (await readRevision()) ?? -1;
    expect(await failureOf(archive(revision))).toBeInstanceOf(
      CanopyOperationError,
    );
    expect(
      await failureOf(
        archive(revision, { expectedCreatedAt: '2000-01-01T00:00:00.000Z' }),
      ),
    ).toMatchObject({
      payload: {
        kind: 'not_found',
        code: 'core.worktree.notFound',
        retry: { kind: 'never' },
      },
    });
    expect(commitCancellation).toHaveBeenCalledTimes(1);
    expect(await readDestructiveRecovery('a', 'one')).toMatchObject({
      state: 'recovery-required',
    });
  });

  it('a repeat whose scope names another worktree is refused notFound with no cleanup or answer', async () => {
    const watcher = getAppAdvisorWatcherService();
    const commitCancellation = jest
      .spyOn(watcher, 'commitLocalScopeCancellation')
      .mockRejectedValueOnce(new Error('watcher failed'));
    jest.mocked(getAppAdvisorWatcherService).mockReturnValue(watcher);
    await commitRow('one');
    const revision = (await readRevision()) ?? -1;
    expect(await failureOf(archive(revision))).toBeInstanceOf(
      CanopyOperationError,
    );
    const mismatched = { scope: { workspaceId: 'a', worktreeId: 'two' } };
    expect(await failureOf(archive(revision, mismatched))).toMatchObject({
      payload: { kind: 'not_found', retry: { kind: 'never' } },
    });
    expect(commitCancellation).toHaveBeenCalledTimes(1);
    expect(await readDestructiveRecovery('a', 'one')).toMatchObject({
      state: 'recovery-required',
    });
    // Once the cleanup finishes, the retained container is still not answered.
    await expect(archive(revision)).resolves.toMatchObject({
      state: 'archived',
    });
    expect(await failureOf(archive(revision, mismatched))).toMatchObject({
      payload: { kind: 'not_found', retry: { kind: 'never' } },
    });
    // A scope naming a workspace the index doesn't hold is not looked into.
    expect(
      await failureOf(archive(revision, { scope: { workspaceId: '..' } })),
    ).toMatchObject({ payload: { kind: 'not_found' } });
  });

  it('an unscoped repeat matching archives in two workspaces is refused as ambiguous before any cleanup resumes', async () => {
    const watcher = getAppAdvisorWatcherService();
    const commitCancellation = jest
      .spyOn(watcher, 'commitLocalScopeCancellation')
      .mockRejectedValueOnce(new Error('watcher failed'));
    jest.mocked(getAppAdvisorWatcherService).mockReturnValue(watcher);
    await commitRow('one');
    const revision = (await readRevision()) ?? -1;
    // `a`'s archive of `one` is left with its cleanup unfinished.
    expect(await failureOf(archive(revision))).toBeInstanceOf(
      CanopyOperationError,
    );
    // `b` holds its own `one`, archived with a retained container.
    const otherCheckout = join(root, 'b', 'worktrees', 'one');
    execFileSync('git', [
      '-C',
      repo,
      'worktree',
      'add',
      '-q',
      '-b',
      'other',
      otherCheckout,
    ]);
    writeFileSync(
      listPath('b'),
      JSON.stringify({
        version: 1,
        worktrees: [{ id: 'one', branchName: 'other', createdAt }],
      }),
    );
    __resetSidebarItemsStateForTests();
    await archiveWorktree({
      workspaceId: 'b',
      worktreeId: 'one',
      source: 'single_repo',
      lockAfterArchive: true,
    });
    expect(await listArchivedContainerManifests('b')).toHaveLength(1);
    const cleanups = commitCancellation.mock.calls.length;
    expect(await failureOf(archive(revision))).toMatchObject({
      payload: { kind: 'invalid_argument', retry: { kind: 'never' } },
    });
    expect(commitCancellation).toHaveBeenCalledTimes(cleanups);
    expect(await readDestructiveRecovery('a', 'one')).toMatchObject({
      state: 'recovery-required',
    });
    // Scoped, the same repeat resumes `a`'s cleanup and answers `a`'s worktree.
    await expect(
      archive(revision, { scope: { workspaceId: 'a' } }),
    ).resolves.toMatchObject({ workspaceId: 'a', branch: 'old' });
    expect(commitCancellation).toHaveBeenCalledTimes(cleanups + 1);
    await expect(
      archive(revision, { scope: { workspaceId: 'b' } }),
    ).resolves.toMatchObject({ workspaceId: 'b', branch: 'other' });
  });

  it('refuses a moved revision as revisionConflict without the stored revision, archiving nothing', async () => {
    await commitRow('one');
    const error = await failureOf(archive(5));
    expect(error).toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'core.worktree.revisionConflict',
        details: { expected: 5 },
        retry: { kind: 'after_refresh', resource: 'core.worktree.get' },
      },
    });
    if (error instanceof CanopyOperationError)
      expect(error.payload.details).not.toHaveProperty('actual');
    expect(rowIds()).toEqual(['one', 'two']);
    expect(existsSync(checkout())).toBe(true);
  });

  it('DP-1: a row with no revision archives with 0; an unverified one is refused without its revision', async () => {
    // `b`'s list was never logged: its provenance is unverified.
    writeFileSync(
      listPath('b'),
      JSON.stringify({
        version: 1,
        worktrees: [{ id: 'three', branchName: 'third', createdAt }],
      }),
    );
    __resetSidebarItemsStateForTests();
    expect(
      await failureOf(
        instruct('core.worktree.archive', {
          scope: { workspaceId: 'b' },
          worktreeId: 'three',
          expectedRevision: 0,
          archived: true,
        }),
      ),
    ).toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.worktree.invalidState',
        details: { reason: 'revision-unverified' },
        retry: { kind: 'never' },
      },
    });
    expect(rowIds('b')).toEqual(['three']);
    // A logged list whose rows were never advanced: `one` has no revision.
    expect(await readRevision()).toBeUndefined();
    await expect(archive(0)).resolves.toMatchObject({
      worktreeId: 'one',
      state: 'archived',
    });
  });

  it('D-6(1): archived:false is invalid_argument use-container-restore', async () => {
    await commitRow('one');
    expect(
      await failureOf(
        archive((await readRevision()) ?? -1, { archived: false }),
      ),
    ).toMatchObject({
      payload: {
        kind: 'invalid_argument',
        details: { reason: 'use-container-restore' },
        retry: { kind: 'never' },
      },
    });
    expect(rowIds()).toEqual(['one', 'two']);
  });

  it('DP-2: an unknown worktree is notFound; one removed without retention is refused removed-without-retention', async () => {
    expect(
      await failureOf(
        instruct('core.worktree.archive', {
          worktreeId: 'missing',
          expectedRevision: 0,
          archived: true,
        }),
      ),
    ).toMatchObject({
      payload: {
        kind: 'not_found',
        code: 'core.worktree.notFound',
        retry: { kind: 'never' },
      },
    });
    // `two` has no checkout: the Delete button keeps nothing for it.
    await archiveWorktree({
      workspaceId: 'a',
      worktreeId: 'two',
      source: 'single_repo',
      deleteWithoutRetentionIfMissing: true,
    });
    expect(rowIds()).toEqual(['one']);
    expect(
      await failureOf(
        instruct('core.worktree.archive', {
          scope: { workspaceId: 'a' },
          worktreeId: 'two',
          expectedRevision: 0,
          archived: true,
        }),
      ),
    ).toMatchObject({
      payload: {
        kind: 'not_found',
        code: 'core.worktree.notFound',
        details: { reason: 'removed-without-retention' },
        retry: { kind: 'never' },
      },
    });
  });

  it('A4: resolves an unscoped id as the read does and refuses an ambiguous one', async () => {
    writeFileSync(
      listPath('b'),
      JSON.stringify({
        version: 1,
        worktrees: [{ id: 'one', branchName: 'other', createdAt }],
      }),
    );
    __resetSidebarItemsStateForTests();
    expect(await failureOf(archive(0))).toMatchObject({
      payload: { kind: 'invalid_argument', retry: { kind: 'never' } },
    });
    expect(rowIds()).toEqual(['one', 'two']);
    expect(rowIds('b')).toEqual(['one']);
  });
});

describe('IPC projections', () => {
  const projected = (
    caller = IPC_CALLER,
  ): ReturnType<typeof projectedWorkspaceLifecycleCommands> =>
    projectedWorkspaceLifecycleCommands({ dispatcher, caller });

  const GRANTED_IPC_CALLER: unknown = expect.objectContaining({
    principalId: 'local-desktop-user',
    grants: ['core.worktree.write'],
  });

  it('nested archive projections inside project delete preserve both outcomes and original errors', async () => {
    const reserve = jest.spyOn(host, 'reserve');
    const commands = projected();
    const request = {
      workspaceId: 'a',
      worktreeId: 'one',
      lockAfterArchive: true,
    };
    const archiveRun = jest.fn(() => Promise.resolve({ archived: 'one' }));
    await expect(
      commands.deleteWorkspace({ workspaceId: 'a' }, async () => ({
        deleted: await commands.archiveWorktree(request, archiveRun),
      })),
    ).resolves.toEqual({ deleted: { archived: 'one' } });
    expect(archiveRun).toHaveBeenCalledTimes(1);

    const failure = new Error('Child archive failed');
    await expect(
      commands.deleteWorkspace({ workspaceId: 'a' }, () =>
        commands.archiveWorktree(request, () => Promise.reject(failure)),
      ),
    ).rejects.toBe(failure);
    // A failed nested projection cannot poison the next call's context.
    await expect(
      commands.deleteWorkspace({ workspaceId: 'a' }, () =>
        Promise.resolve('next'),
      ),
    ).resolves.toBe('next');
    expect(reserve).not.toHaveBeenCalled();
    expect(indexIds()).toEqual(['a', 'b']);
    expect(rowIds()).toEqual(['one', 'two']);
  });

  it('the shared IPC fixture serves guarded and archive projections in the same call', async () => {
    const runtime = unusedGitReadRuntime();
    const target = { dispatcher: runtime.dispatcher, caller: IPC_CALLER };
    const guarded = projectedWorkspaceGuardedCommands(target);
    const lifecycle = projectedWorkspaceLifecycleCommands(target);
    const instruction = jest.spyOn(runtime.dispatcher, 'instruction');
    const reserve = jest.spyOn(host, 'reserve');
    await expect(
      lifecycle.archiveWorktree(
        { workspaceId: 'a', worktreeId: 'one', lockAfterArchive: true },
        () =>
          guarded.updateWorktree({
            workspaceId: 'a',
            worktreeId: 'two',
            patch: { label: 'From guarded projection' },
          }),
      ),
    ).resolves.toMatchObject({
      changed: true,
      worktree: { id: 'two', label: 'From guarded projection' },
    });
    expect(instruction.mock.calls.map(([name]) => name)).toEqual([
      'core.worktree.archive',
      'core.worktree.update',
    ]);
    expect(reserve).not.toHaveBeenCalled();
    expect(rowIds()).toEqual(['one', 'two']);
  });

  it('an archive runs its host request under the dispatcher with the grant added for the call', async () => {
    const instruction = jest.spyOn(dispatcher, 'instruction');
    const run = jest.fn(() =>
      archiveWorktree({
        workspaceId: 'a',
        worktreeId: 'one',
        source: 'single_repo',
        expectedKind: 'single-repo',
        lockAfterArchive: true,
      }),
    );
    // Unverified for the wire, and no revision: the projection checks neither.
    const outcome = await projected().archiveWorktree(
      { workspaceId: 'a', worktreeId: 'one', lockAfterArchive: true },
      run,
    );
    expect(outcome).toMatchObject({ success: true, status: 'archived' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(instruction).toHaveBeenCalledWith(
      'core.worktree.archive',
      expect.objectContaining({ worktreeId: 'one', archived: true }),
      { caller: GRANTED_IPC_CALLER },
    );
    expect(rowIds()).toEqual(['two']);
    expect(sendToAllWindows).not.toHaveBeenCalledWith(
      IPC_CHANNELS.workspaceWorktreesUpdated,
      expect.anything(),
    );
  });

  it('the Delete button projects #25 but runs its original unkeyed host request', async () => {
    const instruction = jest.spyOn(dispatcher, 'instruction');
    const run = jest.fn(() => Promise.resolve('deleted'));
    for (const request of [
      { workspaceId: 'a', worktreeId: 'one' },
      { workspaceId: 'a', worktreeId: 'one', lockAfterArchive: false },
      {
        workspaceId: 'a',
        worktreeId: 'one',
        lockAfterArchive: true,
        deleteWithoutRetentionIfMissing: true,
      },
    ])
      await expect(projected().archiveWorktree(request, run)).resolves.toBe(
        'deleted',
      );
    expect(run).toHaveBeenCalledTimes(3);
    expect(instruction).toHaveBeenCalledTimes(3);
    expect(instruction).toHaveBeenCalledWith(
      'core.worktree.delete',
      expect.objectContaining({
        worktreeId: 'one',
        scope: { workspaceId: 'a' },
      }),
      expect.objectContaining({
        caller: GRANTED_IPC_CALLER,
      }),
    );
    expect(IPC_CALLER.grants).toEqual([
      'core.workspace.read',
      'core.worktree.read',
    ]);
  });

  it("a paired device's Delete projection keeps the real host lifecycle and consumes no dispatcher key", async () => {
    const reserve = jest.spyOn(host, 'reserve');
    const commits = jest.spyOn(host, 'commit');
    const outcome = await projected({
      ...IPC_CALLER,
      principalId: 'remote-device:device-1',
    }).archiveWorktree(
      {
        workspaceId: 'a',
        worktreeId: 'one',
        lockAfterArchive: false,
        deleteWithoutRetentionIfMissing: true,
      },
      () =>
        archiveWorktree({
          workspaceId: 'a',
          worktreeId: 'one',
          source: 'single_repo',
          expectedKind: 'single-repo',
          lockAfterArchive: false,
          deleteWithoutRetentionIfMissing: true,
        }),
    );
    expect(outcome).toMatchObject({ success: true, status: 'archived' });
    expect(rowIds()).toEqual(['two']);
    expect(
      (await listArchivedContainerManifests('a'))[0]?.lockedAt,
    ).toBeUndefined();
    expect(reserve).not.toHaveBeenCalled();
    expect(
      commits.mock.calls.some(([call]) => call.receipt !== undefined),
    ).toBe(false);
  });

  it("a projection rethrows its host request's own error and answers its outcome", async () => {
    const failure = new Error('/Users/me/a failed');
    const fail = (): Promise<never> => Promise.reject(failure);
    await expect(
      projected().archiveWorktree(
        { workspaceId: 'a', worktreeId: 'one', lockAfterArchive: true },
        fail,
      ),
    ).rejects.toBe(failure);
    await expect(
      projected().deleteWorkspace({ workspaceId: 'b' }, fail),
    ).rejects.toBe(failure);
    await expect(
      projected().restoreArchive(
        { workspaceId: 'a', containerId: 'c-1' },
        fail,
      ),
    ).rejects.toBe(failure);
    const reserve = jest.spyOn(host, 'reserve');
    await expect(
      projected().deleteWorkspace({ workspaceId: 'b' }, () =>
        Promise.resolve('done'),
      ),
    ).resolves.toBe('done');
    await expect(
      projected().restoreArchive({ workspaceId: 'a', containerId: 'c-1' }, () =>
        Promise.resolve('restored'),
      ),
    ).resolves.toBe('restored');
    // The minted keys never reach a reservation.
    expect(reserve).not.toHaveBeenCalled();
    expect(sendToAllWindows).not.toHaveBeenCalledWith(
      IPC_CHANNELS.workspaceWorktreesUpdated,
      expect.anything(),
    );
  });

  it("a paired remote device's tunneled channels run their host request (B5)", async () => {
    const run = jest.fn(() => Promise.resolve('ran'));
    const remote = projectedWorkspaceLifecycleCommands({
      dispatcher,
      caller: { ...IPC_CALLER, principalId: 'remote-device:device-1' },
    });
    await expect(
      remote.archiveWorktree(
        { workspaceId: 'a', worktreeId: 'one', lockAfterArchive: true },
        run,
      ),
    ).resolves.toBe('ran');
    await expect(
      remote.deleteWorkspace({ workspaceId: 'b' }, run),
    ).resolves.toBe('ran');
    await expect(
      remote.restoreArchive({ workspaceId: 'a', containerId: 'c-1' }, run),
    ).resolves.toBe('ran');
    expect(run).toHaveBeenCalledTimes(3);
    expect(sendToAllWindows).not.toHaveBeenCalledWith(
      IPC_CHANNELS.workspaceWorktreesUpdated,
      expect.anything(),
    );
  });

  it('a projection the caller allowlist refuses never runs its host request', async () => {
    const run = jest.fn(() => Promise.resolve('ran'));
    const relay = projectedWorkspaceLifecycleCommands({
      dispatcher,
      caller: { ...IPC_CALLER, principalId: 'local-desktop-renderer:main' },
    });
    await expect(
      relay.deleteWorkspace({ workspaceId: 'b' }, run),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('core.worktree.delete (#25, P-1(i))', () => {
  const remove = (extra: Record<string, unknown> = {}): Promise<unknown> =>
    instruct('core.worktree.delete', {
      worktreeId: 'one',
      scope: { workspaceId: 'a' },
      expectedRevision: 0,
      _meta: { idempotencyKey: 'worktree-delete' },
      ...extra,
    });

  it('deletes through the registered entry, retains an unlocked container and replays the completed reference', async () => {
    jest.mocked(runAutoArchiveTeardown).mockClear();
    const commits = jest.spyOn(host, 'commit');
    const params = {
      worktreeId: 'one',
      scope: { workspaceId: 'a' },
      expectedRevision: 0,
      expectedCreatedAt: createdAt,
      _meta: { idempotencyKey: 'worktree-delete' },
    };
    expect(
      execFileSync('git', ['-C', repo, 'branch', '--list', 'old'], {
        encoding: 'utf8',
      }),
    ).toContain('old');
    const result = await instruct('core.worktree.delete', params);
    expect(result).toEqual({
      operationId: OPERATION_ID,
      kind: 'core.worktree.delete',
      status: 'completed',
    });
    expect(rowIds()).toEqual(['two']);
    expect(existsSync(checkout())).toBe(false);
    const [manifest] = await listArchivedContainerManifests('a');
    expect(manifest?.originalWorktree).toMatchObject({
      id: 'one',
      createdAt,
    });
    expect(manifest?.lockedAt).toBeUndefined();
    expect(runAutoArchiveTeardown).not.toHaveBeenCalled();
    // Like Delete, the archive prunes a fully merged branch by default.
    expect(
      execFileSync('git', ['-C', repo, 'branch', '--list', 'old'], {
        encoding: 'utf8',
      }),
    ).toBe('');
    if (!manifest) throw new Error('Missing retained container');
    expect(
      Date.parse(manifest.expiresAt) - Date.parse(manifest.archivedAt),
    ).toBe(manifest.retentionDays * 86_400_000);
    const receipt = commits.mock.calls.find(([call]) => call.receipt)?.[0]
      .receipt;
    expect(receipt).toMatchObject({
      caller: 'daemon:local-desktop-user:desktop_canopy_client',
      operation: 'core.worktree.delete',
      idempotencyKey: 'worktree-delete',
    });
    const count = commits.mock.calls.length;
    expect(await instruct('core.worktree.delete', params)).toEqual(result);
    expect(commits).toHaveBeenCalledTimes(count);
    expect(await listArchivedContainerManifests('a')).toHaveLength(1);
    await host.shutdown();
    startHost();
    expect(await instruct('core.worktree.delete', params)).toEqual(result);
    await expect(
      remove({ expectedCreatedAt: 'different' }),
    ).rejects.toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'core.worktree.idempotencyKeyReused',
        retry: { kind: 'never' },
      },
    });
  });

  it('skips retention only for a missing checkout; same-key replay survives, but a new key gets DP-2', async () => {
    rmSync(checkout(), { recursive: true });
    const first = await remove();
    expect(rowIds()).toEqual(['two']);
    expect(await listArchivedContainerManifests('a')).toEqual([]);
    await expect(remove()).resolves.toEqual(first);
    await expect(
      remove({ _meta: { idempotencyKey: 'new-key' } }),
    ).rejects.toMatchObject({
      payload: {
        kind: 'not_found',
        details: { reason: 'removed-without-retention' },
        retry: { kind: 'never' },
      },
    });
  });

  it('pins the admitted incarnation when the caller omits expectedCreatedAt', async () => {
    const reserve = host.reserve.bind(host);
    const replacementCreatedAt = new Date(
      Date.parse(createdAt) + 1,
    ).toISOString();
    jest.spyOn(host, 'reserve').mockImplementationOnce(async (request) => {
      const result = await reserve(request);
      writeFileSync(
        listPath(),
        JSON.stringify({
          version: 1,
          worktrees: [
            { id: 'one', branchName: 'old', createdAt: replacementCreatedAt },
            { id: 'two', branchName: 'second', createdAt },
          ],
        }),
      );
      __resetSidebarItemsStateForTests();
      return result;
    });
    await expect(remove()).rejects.toMatchObject({
      payload: { kind: 'not_found', retry: { kind: 'never' } },
    });
    expect(rowIds()).toEqual(['one', 'two']);
    expect(existsSync(checkout())).toBe(true);
    expect(await listArchivedContainerManifests('a')).toEqual([]);
    expect((await readWorkspaceWorktrees('a'))[0]?.createdAt).toBe(
      replacementCreatedAt,
    );
  });

  it('pins a retained repeat before reservation so a recreated incarnation survives', async () => {
    await remove({ _meta: { idempotencyKey: 'original-delete' } });
    const reserve = host.reserve.bind(host);
    const replacementCreatedAt = new Date(
      Date.parse(createdAt) + 1,
    ).toISOString();
    jest.spyOn(host, 'reserve').mockImplementationOnce(async (request) => {
      const result = await reserve(request);
      writeFileSync(
        listPath(),
        JSON.stringify({
          version: 1,
          worktrees: [
            {
              id: 'one',
              branchName: 'replacement',
              createdAt: replacementCreatedAt,
            },
            { id: 'two', branchName: 'second', createdAt },
          ],
        }),
      );
      execFileSync('git', [
        '-C',
        repo,
        'worktree',
        'add',
        '-q',
        '-b',
        'replacement',
        checkout(),
      ]);
      __resetSidebarItemsStateForTests();
      return result;
    });
    await expect(remove()).resolves.toMatchObject({ status: 'completed' });
    expect(rowIds()).toEqual(['one', 'two']);
    expect(existsSync(checkout())).toBe(true);
    const manifests = await listArchivedContainerManifests('a');
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.originalWorktree?.createdAt).toBe(createdAt);
    expect((await readWorkspaceWorktrees('a'))[0]?.createdAt).toBe(
      replacementCreatedAt,
    );
  });

  it('force true, empty IDs, unknown addressing and creation guards refuse before reserving a key', async () => {
    const reserve = jest.spyOn(host, 'reserve');
    for (const [extra, kind] of [
      [{ force: true }, 'capability_unavailable'],
      [{ worktreeId: '' }, 'invalid_argument'],
      [{ expectedRevision: -1 }, 'invalid_argument'],
      [{ expectedRevision: undefined }, 'invalid_argument'],
      [{ _meta: undefined }, 'invalid_argument'],
      [{ worktreeId: 'unknown' }, 'not_found'],
      [{ expectedCreatedAt: 'another-incarnation' }, 'not_found'],
      [{ scope: { workspaceId: 'a', worktreeId: 'two' } }, 'not_found'],
      [{ scope: { workspaceId: 'a', organizationId: 'foreign' } }, 'not_found'],
      [
        { scope: { workspaceId: 'a', targetId: 'foreign' } },
        'capability_unavailable',
      ],
    ] as const)
      expect(await failureOf(remove(extra))).toMatchObject({
        payload: { kind },
      });
    expect(reserve).not.toHaveBeenCalled();
    expect(rowIds()).toEqual(['one', 'two']);
    await expect(remove({ force: false })).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('DP-1 refuses an unverifiable row; a moved revision conflicts without exposing the stored revision', async () => {
    await commitRow('one');
    const conflict = await failureOf(remove());
    expect(conflict).toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'core.worktree.revisionConflict',
        retry: { kind: 'after_refresh', resource: 'core.worktree.get' },
      },
    });
    if (!(conflict instanceof CanopyOperationError))
      throw new Error('Expected wire error');
    expect(conflict.payload.details).not.toHaveProperty('actual');
    // An out-of-band list makes its committed counters unverifiable.
    writeFileSync(listPath(), readFileSync(listPath(), 'utf8') + '\n');
    const reserve = jest.spyOn(host, 'reserve');
    await expect(remove({ expectedRevision: 1 })).rejects.toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.worktree.invalidState',
        details: { reason: 'revision-unverified' },
        retry: { kind: 'never' },
      },
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(rowIds()).toEqual(['one', 'two']);
  });

  it('resolves unscoped IDs, refuses ambiguous live and retained IDs, and admits a scoped retained repeat', async () => {
    writeFileSync(listPath('b'), readFileSync(listPath(), 'utf8'));
    const reserve = jest.spyOn(host, 'reserve');
    await expect(remove({ scope: undefined })).rejects.toMatchObject({
      payload: { kind: 'invalid_argument' },
    });
    expect(reserve).not.toHaveBeenCalled();
    writeFileSync(listPath('b'), JSON.stringify({ version: 1, worktrees: [] }));
    await expect(remove({ scope: undefined })).resolves.toMatchObject({
      status: 'completed',
    });
    await expect(remove({ scope: undefined })).resolves.toMatchObject({
      status: 'completed',
    });
    await expect(
      remove({ _meta: { idempotencyKey: 'new-key' }, expectedRevision: 999 }),
    ).resolves.toMatchObject({ status: 'completed' });
    const [manifest] = await listArchivedContainerManifests('a');
    if (!manifest) throw new Error('Missing retained container');
    const duplicate = getArchivedContainerManifestPath('b', manifest.id);
    mkdirSync(join(duplicate, '..'), { recursive: true });
    writeFileSync(duplicate, JSON.stringify({ ...manifest, projectId: 'b' }));
    await expect(
      remove({
        scope: undefined,
        _meta: { idempotencyKey: 'ambiguous-repeat' },
      }),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    // Receipt lookup precedes all addressing, even after its evidence is gone.
    rmSync(join(root, 'a'), { recursive: true });
    await expect(remove({ scope: undefined })).resolves.toMatchObject({
      status: 'completed',
    });
  });
});

describe('core.workspace.delete (#5)', () => {
  const remove = (
    idempotencyKey: string,
    extra: Record<string, unknown> = {},
  ): Promise<unknown> =>
    instruct('core.workspace.delete', {
      workspaceId: 'b',
      expectedRevision: 0,
      _meta: { idempotencyKey },
      ...extra,
    });

  it('DP-3: deletes, answers a completed operation reference keyed to the principal, and replays it', async () => {
    const commits = jest.spyOn(host, 'commit');
    const first = await remove('delete-key');
    expect(first).toEqual({
      operationId: OPERATION_ID,
      kind: 'core.workspace.delete',
      status: 'completed',
    });
    expect(indexIds()).toEqual(['a']);
    expect(existsSync(join(root, 'b'))).toBe(false);
    const receipt = commits.mock.calls.find(([call]) => call.receipt)?.[0]
      .receipt;
    expect(receipt).toMatchObject({
      caller: 'daemon:local-desktop-user:desktop_canopy_client',
      operation: 'core.workspace.delete',
      idempotencyKey: 'delete-key',
    });
    const count = commits.mock.calls.length;
    await expect(remove('delete-key')).resolves.toEqual(first);
    expect(commits).toHaveBeenCalledTimes(count);
  });

  it('duplicate workspace addressing carries invalidState and reserves no key', async () => {
    const repository = getWorkspaceIndexRepository();
    const snapshot = await repository.read();
    const row = snapshot.entries.find((entry) => entry.id === 'b');
    if (!row) throw new Error('Missing workspace fixture');
    jest.spyOn(repository, 'read').mockResolvedValue({
      ...snapshot,
      entries: [...snapshot.entries, row],
    });
    const reserve = jest.spyOn(host, 'reserve');
    expect(await failureOf(remove('duplicate-key'))).toMatchObject({
      payload: {
        kind: 'invalid_argument',
        code: 'core.workspace.invalidState',
        details: { reason: 'duplicate-workspace' },
        retry: { kind: 'never' },
      },
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(indexIds()).toEqual(['a', 'b']);
  });

  it('RR5: an unknown workspace is notFound with no key reserved; deleteRemoteBranches true is refused', async () => {
    const reserve = jest.spyOn(host, 'reserve');
    expect(
      await failureOf(
        instruct('core.workspace.delete', {
          workspaceId: 'missing',
          expectedRevision: 0,
          _meta: { idempotencyKey: 'missing-key' },
        }),
      ),
    ).toMatchObject({
      payload: {
        kind: 'not_found',
        code: 'core.workspace.notFound',
        retry: { kind: 'never' },
      },
    });
    expect(
      await failureOf(remove('remote-key', { deleteRemoteBranches: true })),
    ).toMatchObject({ payload: { kind: 'capability_unavailable' } });
    expect(reserve).not.toHaveBeenCalled();
    expect(indexIds()).toEqual(['a', 'b']);
  });

  it('a revision the read withholds is revision-unverified, not a conflict a refresh cannot resolve', async () => {
    // A logged write over `b`'s unlogged files: committed, but pre-log.
    await updateWorkspaceMetadata({
      workspaceId: 'b',
      patch: { pinned: true },
      source: 'desktop_canopy_client',
    });
    const read = await dispatcher.query(
      'core.workspace.get',
      { workspaceId: 'b' },
      { caller: { ...USER, grants: ['core.workspace.read'] } },
    );
    expect(read.revision).toBeUndefined();
    const [stored] = await readW5Revisions([
      { kind: 'workspace', workspaceId: 'b' },
    ]);
    expect(stored?.revision).toBeGreaterThan(0);
    // Any revision but the stored one, which the client cannot know.
    for (const revision of [0, (stored?.revision ?? 0) + 7]) {
      const error = await failureOf(
        remove(`withheld-${revision}`, { expectedRevision: revision }),
      );
      expect(error).toMatchObject({
        payload: {
          kind: 'failed_precondition',
          code: 'core.workspace.invalidState',
          details: { reason: 'revision-unverified' },
          retry: { kind: 'never' },
        },
      });
      if (error instanceof CanopyOperationError)
        expect(JSON.stringify(error.payload)).not.toContain('"actual"');
    }
    expect(indexIds()).toEqual(['a', 'b']);
  });
});

/** Archives `one` over the wire with its Git capture refused (files only). */
async function wireArchive(): Promise<string> {
  await commitRow('one');
  jest
    .spyOn(archiveGit, 'captureArchivedContainerGitState')
    .mockRejectedValueOnce(
      new archiveGit.MissingWorktreeIncompleteArchivedGitCaptureError(),
    );
  await archive((await readRevision()) ?? -1);
  await waitForScheduledArchivedContainerDiskUsage();
  await settleDetachedWork();
  const [manifest] = await listArchivedContainerManifests('a');
  if (!manifest) throw new Error('Expected a retained container');
  return manifest.id;
}

/** `a`'s list revision as `core.worktree.list` publishes it to a client. */
async function collectionRevision(): Promise<number> {
  const list = await dispatcher.query(
    'core.worktree.list',
    { scope: { workspaceId: 'a' } },
    { caller: USER },
  );
  const [stored] = await readW5Revisions([
    { kind: 'worktrees', workspaceId: 'a' },
  ]);
  expect(list.collectionRevision).toBe(stored?.revision);
  return list.collectionRevision ?? 0;
}

const restore = (
  archiveId: string,
  expectedRevision: number,
  idempotencyKey: string,
  extra: Record<string, unknown> = {},
): Promise<unknown> =>
  instruct('core.archive.container.restore', {
    archiveId,
    expectedRevision,
    destinationScope: { workspaceId: 'a' },
    conflictPolicy: 'fail',
    _meta: { idempotencyKey },
    ...extra,
  });

describe('core.archive.container.restore (#28)', () => {
  it('work-entry refusal keeps its reason and omits invalidState absent from the archive enum', async () => {
    const archiveId = await wireArchive();
    const [manifest] = await listArchivedContainerManifests('a');
    if (!manifest) throw new Error('Missing archive fixture');
    jest
      .spyOn(archivedContainers, 'listArchivedContainerManifests')
      .mockResolvedValue([{ ...manifest, version: 1, kind: 'work-entry' }]);
    const reserve = jest.spyOn(host, 'reserve');
    const error = await failureOf(restore(archiveId, 0, 'work-entry-key'));
    expect(error).toMatchObject({
      payload: {
        kind: 'capability_unavailable',
        details: { reason: 'work-entry-archive' },
        retry: { kind: 'never' },
      },
    });
    if (!(error instanceof CanopyOperationError))
      throw new Error('Untyped refusal');
    expect(error.payload).not.toHaveProperty('code');
    expect(reserve).not.toHaveBeenCalled();
    expect(rowIds()).toEqual(['two']);
  });

  it('restores into a new worktree, keyed to the principal, and replays its answer', async () => {
    const archiveId = await wireArchive();
    const commits = jest.spyOn(host, 'commit');
    const first = await restore(
      archiveId,
      await collectionRevision(),
      'restore-key',
    );
    await settleDetachedWork();
    expect(first).toEqual({
      operation: {
        operationId: OPERATION_ID,
        kind: 'core.archive.container.restore',
        status: 'completed',
      },
      restoredScope: {
        workspaceId: 'a',
        worktreeId: ANY_STRING,
      },
    });
    const restored = (first as { restoredScope: { worktreeId: string } })
      .restoredScope.worktreeId;
    expect((await readWorkspaceWorktrees('a')).map((row) => row.id)).toContain(
      restored,
    );
    expect(
      commits.mock.calls.find(([call]) => call.receipt)?.[0].receipt,
    ).toMatchObject({
      caller: 'daemon:local-desktop-user:archive-container-restore',
      operation: 'core.archive.container.restore',
    });
    const count = commits.mock.calls.length;
    await expect(restore(archiveId, 0, 'restore-key')).resolves.toEqual(first);
    expect(commits).toHaveBeenCalledTimes(count);
    // DP-2: once restored no container is kept for the original id, and a
    // repeat archive leaves the restored worktree alone.
    expect(await failureOf(archive(0))).toMatchObject({
      payload: {
        kind: 'not_found',
        code: 'core.worktree.notFound',
        details: { reason: 'removed-without-retention' },
        retry: { kind: 'never' },
      },
    });
    expect((await readWorkspaceWorktrees('a')).map((row) => row.id)).toContain(
      restored,
    );
  });

  it('RR5: an unknown archive is not_found with no key reserved', async () => {
    const reserve = jest.spyOn(host, 'reserve');
    expect(
      await failureOf(restore(randomUUID(), 0, 'unknown-key')),
    ).toMatchObject({
      payload: {
        kind: 'not_found',
        details: { reason: 'archive-not-found' },
        retry: { kind: 'never' },
      },
    });
    expect(
      await failureOf(
        restore(randomUUID(), 0, 'unknown-key', {
          destinationScope: { workspaceId: 'missing' },
        }),
      ),
    ).toMatchObject({ payload: { kind: 'not_found' } });
    expect(reserve).not.toHaveBeenCalled();
  });

  it('a collection revision the list withholds is revision-unverified, not a conflict', async () => {
    const archiveId = await wireArchive();
    const [stored] = await readW5Revisions([
      { kind: 'worktrees', workspaceId: 'a' },
    ]);
    // The list changed out of band: its logged chain no longer verifies.
    writeFileSync(
      listPath(),
      `${JSON.stringify(JSON.parse(readFileSync(listPath(), 'utf8')), null, 4)}\n`,
    );
    __resetSidebarItemsStateForTests();
    const list = await dispatcher.query(
      'core.worktree.list',
      { scope: { workspaceId: 'a' } },
      { caller: USER },
    );
    expect(list.collectionRevision).toBeUndefined();
    for (const revision of [0, (stored?.revision ?? 0) + 7])
      expect(
        await failureOf(restore(archiveId, revision, `withheld-${revision}`)),
      ).toMatchObject({
        payload: {
          kind: 'failed_precondition',
          details: { reason: 'revision-unverified' },
          retry: { kind: 'never' },
        },
      });
    expect(await listArchivedContainerManifests('a')).toEqual([
      expect.objectContaining({ id: archiveId }),
    ]);
  });
});

describe('wire lifecycle renderer refresh', () => {
  const expectNoRefresh = (): void => {
    expect(sendToAllWindows).not.toHaveBeenCalledWith(
      IPC_CHANNELS.workspaceWorktreesUpdated,
      expect.anything(),
    );
  };
  const expectRefresh = (workspaceId: string): void => {
    expect(sendToAllWindows).toHaveBeenCalledWith(
      IPC_CHANNELS.workspaceWorktreesUpdated,
      { workspaceId },
    );
  };

  it('archive refreshes after success, not after a revision refusal or an effect-free repeat', async () => {
    await expect(archive(5)).rejects.toMatchObject({
      payload: { kind: 'conflict' },
    });
    expectNoRefresh();
    await expect(archive(0)).resolves.toMatchObject({ state: 'archived' });
    expect(rowIds()).toEqual(['two']);
    expectRefresh('a');
    jest.mocked(sendToAllWindows).mockClear();
    await expect(archive(0)).resolves.toMatchObject({ state: 'archived' });
    expectNoRefresh();
  });

  it('delete refreshes the removed workspace, not after an addressing refusal', async () => {
    const remove = (workspaceId: string): Promise<unknown> =>
      instruct('core.workspace.delete', {
        workspaceId,
        expectedRevision: 0,
        _meta: { idempotencyKey: `refresh-delete-${workspaceId}` },
      });
    await expect(remove('missing')).rejects.toMatchObject({
      payload: { kind: 'not_found' },
    });
    expectNoRefresh();
    await expect(remove('b')).resolves.toMatchObject({ status: 'completed' });
    expect(indexIds()).toEqual(['a']);
    expectRefresh('b');
  });

  it('restore refreshes the destination workspace, not after an unknown archive refusal', async () => {
    const archiveId = await wireArchive();
    jest.mocked(sendToAllWindows).mockClear();
    await expect(
      restore(randomUUID(), 0, 'refresh-missing'),
    ).rejects.toMatchObject({
      payload: { kind: 'not_found' },
    });
    expectNoRefresh();
    await expect(
      restore(archiveId, await collectionRevision(), 'refresh-restore'),
    ).resolves.toMatchObject({ restoredScope: { workspaceId: 'a' } });
    expectRefresh('a');
  });

  it.each(['archive', 'delete', 'restore', 'resumed archive'])(
    '%s keeps its successful answer when the renderer refresh throws',
    async (operation) => {
      const archiveId = operation === 'restore' ? await wireArchive() : '';
      if (operation === 'resumed archive') {
        const watcher = getAppAdvisorWatcherService();
        jest
          .spyOn(watcher, 'commitLocalScopeCancellation')
          .mockRejectedValueOnce(new Error('watcher failed'));
        jest.mocked(getAppAdvisorWatcherService).mockReturnValue(watcher);
        await expect(archive(0)).rejects.toBeInstanceOf(CanopyOperationError);
      }
      const sendFailure = new Error('Object has been destroyed');
      jest.mocked(sendToAllWindows).mockImplementation((channel) => {
        if (channel === IPC_CHANNELS.workspaceWorktreesUpdated)
          throw sendFailure;
      });
      if (operation === 'delete') {
        await expect(
          instruct('core.workspace.delete', {
            workspaceId: 'b',
            expectedRevision: 0,
            _meta: { idempotencyKey: 'refresh-delete' },
          }),
        ).resolves.toMatchObject({ status: 'completed' });
        expect(indexIds()).toEqual(['a']);
      } else if (operation === 'restore') {
        await expect(
          restore(archiveId, await collectionRevision(), 'refresh-restore'),
        ).resolves.toMatchObject({ restoredScope: { workspaceId: 'a' } });
      } else {
        await expect(archive(0)).resolves.toMatchObject({ state: 'archived' });
        expect(rowIds()).toEqual(['two']);
      }
      expect(logMainProcessWarn).toHaveBeenCalledWith(
        'Workspace lifecycle renderer refresh failed',
        sendFailure,
      );
    },
  );
});

describe('recovery classes (§8)', () => {
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
  const diagnose = async (): Promise<
    Extract<
      Awaited<ReturnType<typeof runW5Maintenance>>,
      { mode: 'diagnose' }
    >['diagnosis']
  > => {
    await host.shutdown();
    const result = await runW5Maintenance(maintenanceContext(), {
      source: 'offline_maintenance',
      mode: 'diagnose',
    });
    if (result.mode !== 'diagnose') throw new Error('Expected diagnosis');
    return result.diagnosis;
  };
  const resolve = (
    decisions: readonly W5MaintenanceDecision[],
  ): ReturnType<typeof runW5Maintenance> =>
    runW5Maintenance(maintenanceContext(), {
      source: 'offline_maintenance',
      mode: 'resolve',
      decisions,
    });

  const posix = process.platform === 'win32' ? it.skip : it;
  const FOREIGN = '{"foreign":true}\n';

  posix(
    'archive (unkeyed): a recovery-required commit refuses the wire archive; diagnosis lists it and abandon-commit is allowed',
    async () => {
      await commitRow('one');
      const revision = (await readRevision()) ?? -1;
      const original = readFileSync(listPath(), 'utf8');
      // A decided list change whose file changed out of band before it applied.
      const commit = host.commit.bind(host);
      jest.spyOn(host, 'commit').mockImplementationOnce(async (request) => {
        writeFileSync(listPath(), FOREIGN);
        return commit(request);
      });
      await expect(commitRow('two')).rejects.toBeDefined();
      writeFileSync(listPath(), original);
      // DP-1: the unresolved commit withholds every revision.
      for (let attempt = 0; attempt < 2; attempt += 1)
        expect(await failureOf(archive(revision))).toMatchObject({
          payload: {
            kind: 'failed_precondition',
            code: 'core.worktree.invalidState',
            details: { reason: 'revision-unverified' },
            retry: { kind: 'after_refresh', resource: 'core.worktree.get' },
          },
        });
      expect(rowIds()).toEqual(['one', 'two']);
      const reserve = jest.spyOn(host, 'reserve');
      await expect(
        instruct('core.worktree.delete', {
          worktreeId: 'one',
          scope: { workspaceId: 'a' },
          expectedRevision: revision,
          _meta: { idempotencyKey: 'pending-delete' },
        }),
      ).rejects.toMatchObject({
        payload: {
          kind: 'failed_precondition',
          code: 'core.worktree.invalidState',
          details: { reason: 'revision-unverified' },
          retry: { kind: 'after_refresh', resource: 'core.worktree.get' },
        },
      });
      expect(reserve).not.toHaveBeenCalled();
      const diagnosis = await diagnose();
      const wedged = diagnosis.commits.find(
        (entry) => entry.state === 'recovery-required',
      );
      expect(wedged).toMatchObject({ receiptOperations: [] });
      // An archive is unkeyed: abandoning it drops no receipt (RX2).
      await expect(
        resolve([{ kind: 'abandon-commit', commitId: wedged?.commitId ?? 0 }]),
      ).resolves.toMatchObject({
        results: [{ status: 'abandoned' }],
        diagnosis: { commits: [], reservations: [] },
      });
      startHost();
      // Abandoned history leaves no canonical revision to verify (DP-1).
      expect(await failureOf(archive(revision))).toMatchObject({
        payload: {
          details: { reason: 'revision-unverified' },
          retry: { kind: 'never' },
        },
      });
      expect(rowIds()).toEqual(['one', 'two']);
    },
  );

  posix(
    'archive: an unreadable destructive journal is A24-J terminal, refused and counted by RX3',
    async () => {
      await commitRow('one');
      const journals = getW5DestructiveLifecycleDir();
      mkdirSync(journals, { recursive: true });
      writeFileSync(join(journals, `${randomUUID()}.json`), 'not json');
      const revision = (await readRevision()) ?? -1;
      for (let attempt = 0; attempt < 2; attempt += 1)
        expect(await failureOf(archive(revision))).toMatchObject({
          payload: {
            kind: 'failed_precondition',
            code: 'core.worktree.recoveryRequired',
            details: { reason: 'recovery-required' },
            retry: { kind: 'never' },
          },
        });
      expect(rowIds()).toEqual(['one', 'two']);
      expect(existsSync(checkout())).toBe(true);
      const diagnosis = await diagnose();
      expect(diagnosis.destructiveJournalArtifactCount).toBe(1);
      startHost();
    },
  );

  posix(
    'worktree.delete: a read-only journal refusal releases the key, and the same key succeeds after repair',
    async () => {
      const journals = getW5DestructiveLifecycleDir();
      mkdirSync(journals, { recursive: true });
      const artifact = join(journals, `${randomUUID()}.json`);
      writeFileSync(artifact, 'not json');
      const call = (): Promise<unknown> =>
        instruct('core.worktree.delete', {
          worktreeId: 'one',
          scope: { workspaceId: 'a' },
          expectedRevision: 0,
          _meta: { idempotencyKey: 'journal-delete' },
        });
      for (let attempt = 0; attempt < 2; attempt += 1)
        expect(await failureOf(call())).toMatchObject({
          payload: { kind: 'failed_precondition' },
        });
      expect(existsSync(checkout())).toBe(true);
      rmSync(artifact);
      await expect(call()).resolves.toMatchObject({ status: 'completed' });
      expect(rowIds()).toEqual(['two']);
    },
  );

  posix(
    'worktree.delete: a lifecycle failure retains its key (A24-L), diagnosed and operation-excluded',
    async () => {
      const watcher = getAppAdvisorWatcherService();
      jest
        .spyOn(watcher, 'commitLocalScopeCancellation')
        .mockRejectedValueOnce(new Error('watcher cleanup failed'));
      jest.mocked(getAppAdvisorWatcherService).mockReturnValue(watcher);
      const call = (): Promise<unknown> =>
        instruct('core.worktree.delete', {
          worktreeId: 'one',
          scope: { workspaceId: 'a' },
          expectedRevision: 0,
          _meta: { idempotencyKey: 'terminal-delete' },
        });
      expect(await failureOf(call())).toBeDefined();
      expect(await failureOf(call())).toMatchObject({
        payload: {
          kind: 'failed_precondition',
          code: 'core.worktree.recoveryRequired',
          details: { reason: 'recovery-required' },
          retry: { kind: 'never' },
        },
      });
      const diagnosis = await diagnose();
      const reservation = diagnosis.reservations.find(
        (entry) => entry.operation === 'core.worktree.delete',
      );
      expect(reservation).toMatchObject({
        state: 'recovery-required',
        operation: 'core.worktree.delete',
      });
      await expect(
        resolve([
          {
            kind: 'resolve-reservation',
            reservationId: reservation?.reservationId ?? '',
          },
        ]),
      ).rejects.toMatchObject({ reason: 'operation-excluded' });
      startHost();
    },
  );

  posix(
    'worktree.delete: a concurrent hosted row write after Git removal keeps the key terminal (Q3)',
    async () => {
      const commit = host.commit.bind(host);
      jest.spyOn(host, 'commit').mockImplementation(async (request) => {
        if (
          request.operation === 'core.worktree.delete' &&
          request.files.length > 0
        )
          await commit({
            operation: 'fixture.hosted-write',
            outcome: null,
            files: [],
            advance: [
              { kind: 'worktree', workspaceId: 'a', worktreeId: 'one' },
            ],
          });
        return commit(request);
      });
      const call = (): Promise<unknown> =>
        instruct('core.worktree.delete', {
          worktreeId: 'one',
          scope: { workspaceId: 'a' },
          expectedRevision: 0,
          _meta: { idempotencyKey: 'raced-delete' },
        });
      expect(await failureOf(call())).toBeDefined();
      expect(await failureOf(call())).toMatchObject({
        payload: {
          kind: 'failed_precondition',
          details: { reason: 'recovery-required' },
          retry: { kind: 'never' },
        },
      });
      const diagnosis = await diagnose();
      expect(diagnosis.reservations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation: 'core.worktree.delete',
            state: 'recovery-required',
          }),
        ]),
      );
      startHost();
    },
  );

  posix(
    'workspace.delete: a read-only journal refusal releases the key, and the same key succeeds after repair',
    async () => {
      const journals = getW5DestructiveLifecycleDir();
      mkdirSync(journals, { recursive: true });
      const name = `${randomUUID()}.json`;
      writeFileSync(join(journals, name), 'not json');
      const call = (): Promise<unknown> =>
        instruct('core.workspace.delete', {
          workspaceId: 'b',
          expectedRevision: 0,
          _meta: { idempotencyKey: 'journal-key' },
        });
      for (let attempt = 0; attempt < 2; attempt += 1)
        expect(await failureOf(call())).toMatchObject({
          payload: { kind: 'failed_precondition' },
        });
      expect(existsSync(join(root, 'b'))).toBe(true);
      // Repair: the unreadable entry leaves the journal directory.
      rmSync(join(journals, name));
      await expect(call()).resolves.toMatchObject({ status: 'completed' });
      expect(indexIds()).toEqual(['a']);
    },
  );

  posix(
    'workspace.delete: a lifecycle failure after its first step keeps the key (A24-L), listed by diagnosis',
    async () => {
      // `b` gets a browser task whose retirement fails after the index commit.
      jest
        .mocked(prepareWorkspaceBrowserRetirement)
        .mockResolvedValueOnce([{ worktreeId: 'x', operationId: 'op-1' }]);
      const browser = jest.requireMock<{
        commitTaskBrowserRetirement: jest.Mock;
      }>('../../browser/browser-profile-lifecycle');
      browser.commitTaskBrowserRetirement.mockRejectedValueOnce(
        new Error('browser retirement failed'),
      );
      const call = (): Promise<unknown> =>
        instruct('core.workspace.delete', {
          workspaceId: 'b',
          expectedRevision: 0,
          _meta: { idempotencyKey: 'lifecycle-key' },
        });
      expect(await failureOf(call())).toBeDefined();
      expect(await failureOf(call())).toMatchObject({
        payload: {
          kind: 'failed_precondition',
          details: { reason: 'recovery-required' },
          retry: { kind: 'never' },
        },
      });
      const diagnosis = await diagnose();
      const reservation = diagnosis.reservations.find(
        (entry) => entry.operation === 'core.workspace.delete',
      );
      expect(reservation).toMatchObject({
        operation: 'core.workspace.delete',
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
      startHost();
      expect(getAppAdvisorWatcherService).toHaveBeenCalled();
    },
  );

  posix(
    'restore (keyed lifecycle): an unapplied restore keeps its key recovery-required (A24-L), diagnosed, and maintenance cannot release it',
    async () => {
      const archiveId = await wireArchive();
      const revision = await collectionRevision();
      const commit = host.commit.bind(host);
      jest.spyOn(host, 'commit').mockImplementation(async (request) => {
        // The restore's file decision; its receipt is saved after it.
        if (request.operation === 'core.archive.container.restore')
          for (const file of request.files)
            if (file.previousFingerprint !== null)
              writeFileSync(file.path, FOREIGN);
        return commit(request);
      });
      const call = (): Promise<unknown> =>
        restore(archiveId, revision, 'wedged-restore');
      expect(await failureOf(call())).toBeDefined();
      jest.restoreAllMocks();
      const terminal = {
        payload: {
          kind: 'failed_precondition',
          code: 'core.archive.recoveryRequired',
          details: { reason: 'recovery-required' },
          retry: { kind: 'never' },
        },
      };
      expect(await failureOf(call())).toMatchObject(terminal);
      const diagnosis = await diagnose();
      const wedged = diagnosis.commits.find(
        (entry) => entry.operation === 'core.archive.container.restore',
      );
      // The file decision holds no receipt: abandoning it releases no key.
      expect(wedged).toMatchObject({
        state: 'recovery-required',
        receiptOperations: [],
      });
      const reservation = diagnosis.reservations.find(
        (entry) => entry.operation === 'core.archive.container.restore',
      );
      expect(reservation).toMatchObject({ state: 'recovery-required' });
      await expect(
        resolve([
          {
            kind: 'resolve-reservation',
            reservationId: reservation?.reservationId ?? '',
          },
        ]),
      ).rejects.toMatchObject({ reason: 'operation-excluded' });
      await expect(
        resolve([{ kind: 'abandon-commit', commitId: wedged?.commitId ?? 0 }]),
      ).resolves.toMatchObject({
        results: [{ status: 'abandoned' }],
        diagnosis: {
          reservations: [
            expect.objectContaining({
              operation: 'core.archive.container.restore',
              state: 'recovery-required',
            }),
          ],
        },
      });
      startHost();
      expect(await failureOf(call())).toMatchObject(terminal);
    },
  );
});
