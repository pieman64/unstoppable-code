// CAN-4976: a workspace deletion that fails after fencing its watchers
// releases only its own fences. CAN-4987 and CAN-4989: no scoped release,
// failed watcher delete or startup recovery lifts a fence another holds. The
// real deletion, commit-log worker, files and App Advisor watcher service run
// together. A concurrent worktree operation holds its scope fence through the
// real worktree data cleanup or the watcher service's public scope API.
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import { shutdownW5BoundaryHost } from './fixtures/w5-boundary-host';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { rmSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { join } from 'node:path';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import type * as WorktreeArchive from '../worktree-archive';
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
jest.mock('../../chat-search/service', () => ({
  getChatSearchService: jest.fn(() => ({
    deleteWorkspaceDocs: jest.fn(() => Promise.resolve()),
    deleteWorktreeDocs: jest.fn(() => Promise.resolve()),
  })),
}));
jest.mock('../../ledger/lifecycle', () => ({
  captureLedgerWorkspaceIncarnations: jest.fn(() => Promise.resolve(null)),
  notifyLedgerWorkspaceDeleted: jest.fn(),
}));
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
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
// A user deletion's child archives run their scope fences through a stand-in.
jest.mock('../worktree-archive', () => ({
  ...jest.requireActual<typeof WorktreeArchive>('../worktree-archive'),
  archiveWorkspaceWorktrees: jest.fn(() => Promise.resolve()),
}));

import { getAppAdvisorWatcherService } from '../../app-advisor/watchers';
import { runAsLocalFenceHolder } from '../../app-advisor/local-fence-holder';
import { LocalWatcherScheduler } from '../../app-advisor/local-watcher-scheduler';
import { getChatStateService } from '../../services/chat-state-service';
import { getAppAdvisorWatchersFilePath, getWorkspaceDir } from '../paths';
import { archiveWorkspaceWorktrees } from '../worktree-archive';
import { cleanupPersistedWorktreeData } from '../worktree-data-cleanup';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import { deleteWorkspace } from '../workspace-deletion';

jest.setTimeout(60_000);
let dir: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;

const wakeup = {
  kind: 'scheduled_wakeup' as const,
  delaySeconds: 3600,
  scheduledFor: '',
};
const destination = (
  worktreeId: string,
): { projectId: string; worktreeId: string; chatId: string } => ({
  projectId: 'a',
  worktreeId,
  chatId: `chat-${worktreeId}`,
});

beforeEach(() => {
  let root: string;
  ({ dir, root } = createW5BoundaryFixture((createdAt) => [
    { id: 'one', branchName: 'one', createdAt },
    { id: 'two', branchName: 'two', createdAt },
    { id: 'three', branchName: 'three', createdAt },
  ]));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
});
afterEach(async () => {
  getAppAdvisorWatcherService().shutdown();
  await settleDetachedWork();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await shutdownW5BoundaryHost(host, join(dir, 'w5', 'commit-log.sqlite'));
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

/** Fails the deletion's index commit, after its watcher fence is up. */
function failIndexCommit(beforeFailure?: () => Promise<void>): Error {
  const error = new Error('index commit failed');
  const commit = host.commit.bind(host);
  jest.spyOn(host, 'commit').mockImplementation(async (request) => {
    if (request.files.some((file) => file.path.endsWith('index.json'))) {
      await beforeFailure?.();
      throw error;
    }
    return commit(request);
  });
  return error;
}

async function listed(worktreeId: string): Promise<string[]> {
  return (await getAppAdvisorWatcherService().list(destination(worktreeId)))
    .filter((row) => row.status === 'active')
    .map((row) => row.id);
}

function deleteA(): Promise<unknown> {
  return deleteWorkspace({ workspaceId: 'a', source: 'shared_container_fork' });
}

/** Runs `during` while the deletion waits at its index commit, then commits. */
function duringIndexCommit(during: () => Promise<void>): void {
  const commit = host.commit.bind(host);
  jest.spyOn(host, 'commit').mockImplementation(async (request) => {
    if (request.files.some((file) => file.path.endsWith('index.json')))
      await during();
    return commit(request);
  });
}

async function storedRows(): Promise<unknown[]> {
  const file: unknown = JSON.parse(
    await jest
      .requireActual<typeof FsPromises>('node:fs/promises')
      .readFile(getAppAdvisorWatchersFilePath(), 'utf8'),
  );
  if (
    file === null ||
    typeof file !== 'object' ||
    !('watchers' in file) ||
    !Array.isArray(file.watchers)
  )
    throw new Error('Expected a persisted watcher list.');
  const rows: unknown[] = file.watchers;
  return rows;
}

async function storedIds(): Promise<string[]> {
  return (await storedRows()).flatMap((row: unknown) =>
    row !== null &&
    typeof row === 'object' &&
    'id' in row &&
    typeof row.id === 'string'
      ? [row.id]
      : [],
  );
}

function configureWatcherService(options?: {
  deferStartupRecovery?: boolean;
}): void {
  getAppAdvisorWatcherService().configure(
    {
      getMainWindow: () => null,
      getAppAdvisorWindow: () => null,
      ensureAppAdvisorWindow: jest.fn(() =>
        Promise.reject(new Error('No App Advisor window in this suite.')),
      ),
      sendAppAdvisorWindowCommand: jest.fn(),
      sendChatWindowCommand: jest.fn(() => false),
      deliverWatcherMessage: jest.fn(() =>
        Promise.reject(new Error('No delivery in this suite.')),
      ),
    },
    options,
  );
}

/** The persisted `cancellationPending` record of watcher `id`, if any. */
async function storedCancellation(id: string): Promise<unknown> {
  for (const row of await storedRows()) {
    if (
      row !== null &&
      typeof row === 'object' &&
      'id' in row &&
      row.id === id &&
      'runtimeState' in row &&
      row.runtimeState !== null &&
      typeof row.runtimeState === 'object' &&
      'cancellationPending' in row.runtimeState
    )
      return row.runtimeState.cancellationPending;
  }
  return undefined;
}

it('keeps a scope fence a concurrent operation took before the deletion', async () => {
  const service = getAppAdvisorWatcherService();
  const one = await service.createLocalWatcher(
    wakeup,
    destination('one'),
    'tool-one',
  );
  const two = await service.createLocalWatcher(
    wakeup,
    destination('two'),
    'tool-two',
  );
  // A concurrent worktree cleanup holds scope "one" across the deletion.
  await service.cancelLocalScope('a', 'one');
  const error = failIndexCommit();

  await expect(deleteA()).rejects.toBe(error);

  // The deletion's own fence is released: scope "two" admits again.
  expect(await listed('two')).toEqual([two.id]);
  await expect(
    service.createLocalWatcher(wakeup, destination('two'), 'tool-two-after'),
  ).resolves.toMatchObject({ status: 'active' });
  // The concurrent holder's fence survives: admission and cancellation.
  expect(await listed('one')).toEqual([]);
  await expect(
    service.createLocalWatcher(wakeup, destination('one'), 'tool-one-during'),
  ).rejects.toThrow('removed or archived');

  // Its own release restores the scope.
  await service.releaseLocalScopeFence('a', 'one');
  expect(await listed('one')).toEqual([one.id]);
});

it('keeps a scope fence a concurrent operation took on a scope the deletion already fenced', async () => {
  const service = getAppAdvisorWatcherService();
  const one = await service.createLocalWatcher(
    wakeup,
    destination('one'),
    'tool-one',
  );
  const two = await service.createLocalWatcher(
    wakeup,
    destination('two'),
    'tool-two',
  );
  // The deletion marks the watchers first; the concurrent fence arrives while
  // it is still in flight.
  const error = failIndexCommit(() => service.cancelLocalScope('a', 'one'));

  await expect(deleteA()).rejects.toBe(error);

  expect(await listed('two')).toEqual([two.id]);
  expect(await listed('one')).toEqual([]);
  await expect(
    service.createLocalWatcher(wakeup, destination('one'), 'tool-one-during'),
  ).rejects.toThrow('removed or archived');

  await service.releaseLocalScopeFence('a', 'one');
  expect(await listed('one')).toEqual([one.id]);
});

it('keeps a concurrent fence on a scope without watchers', async () => {
  const service = getAppAdvisorWatcherService();
  await service.cancelLocalScope('a', 'two');
  const error = failIndexCommit();

  await expect(deleteA()).rejects.toBe(error);

  await expect(
    service.createLocalWatcher(wakeup, destination('two'), 'tool-two-during'),
  ).rejects.toThrow('removed or archived');
  await expect(
    service.createLocalWatcher(wakeup, destination('one'), 'tool-one-after'),
  ).resolves.toMatchObject({ status: 'active' });
  await service.releaseLocalScopeFence('a', 'two');
  await expect(
    service.createLocalWatcher(wakeup, destination('two'), 'tool-two-after'),
  ).resolves.toMatchObject({ status: 'active' });
});

it('keeps the fence of a concurrent worktree data cleanup, which then commits it', async () => {
  const service = getAppAdvisorWatcherService();
  const one = await service.createLocalWatcher(
    wakeup,
    destination('one'),
    'tool-one',
  );
  const two = await service.createLocalWatcher(
    wakeup,
    destination('two'),
    'tool-two',
  );
  const chatState = getChatStateService();
  const runWithScopeDeletion = chatState.runWithScopeDeletion.bind(chatState);
  let fenceHeld = (): void => {};
  const cleanupFenced = new Promise<void>((resolve) => {
    fenceHeld = resolve;
  });
  let resumeCleanup = (): void => {};
  const cleanupGate = new Promise<void>((resolve) => {
    resumeCleanup = resolve;
  });
  jest
    .spyOn(chatState, 'runWithScopeDeletion')
    .mockImplementationOnce(
      async <T>(
        scope: Parameters<typeof runWithScopeDeletion>[0],
        operation: () => Promise<T>,
      ): Promise<T> => {
        fenceHeld();
        await cleanupGate;
        return runWithScopeDeletion(scope, operation);
      },
    );
  const cleanup = cleanupPersistedWorktreeData('a', 'one');
  await cleanupFenced;
  const error = failIndexCommit();

  await expect(deleteA()).rejects.toBe(error);

  expect(await listed('two')).toEqual([two.id]);
  expect(await listed('one')).toEqual([]);
  await expect(
    service.createLocalWatcher(wakeup, destination('one'), 'tool-one-during'),
  ).rejects.toThrow('removed or archived');

  resumeCleanup();
  await cleanup;
  // The cleanup's own commit ends the watcher it held.
  expect(
    (await service.list(destination('one'))).map((row) => row.id),
  ).not.toContain(one.id);
  expect(await listed('two')).toEqual([two.id]);
});

it('releases its own fence after a directory removal failure that follows the index commit', async () => {
  const service = getAppAdvisorWatcherService();
  const one = await service.createLocalWatcher(
    wakeup,
    destination('one'),
    'tool-one',
  );
  const two = await service.createLocalWatcher(
    wakeup,
    destination('two'),
    'tool-two',
  );
  await service.cancelLocalScope('a', 'one');
  const error = new Error('directory removal failed');
  const fsPromises = jest.requireActual<typeof FsPromises>('node:fs/promises');
  const rm = fsPromises.rm;
  jest.spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
    if (String(path) === getWorkspaceDir('a')) throw error;
    await rm(path, options);
  });

  await expect(deleteA()).rejects.toBe(error);

  // G1 (CAN-4978): the deletion's own fence is released.
  expect(await listed('two')).toEqual([two.id]);
  expect(await listed('one')).toEqual([]);
  await service.releaseLocalScopeFence('a', 'one');
  expect(await listed('one')).toEqual([one.id]);
});

it('keeps its fence for a retried deletion after its release fails to write the watcher store', async () => {
  const service = getAppAdvisorWatcherService();
  const one = await service.createLocalWatcher(
    wakeup,
    destination('one'),
    'tool-one',
  );
  const two = await service.createLocalWatcher(
    wakeup,
    destination('two'),
    'tool-two',
  );
  await service.cancelLocalScope('a', 'one');
  let failNextStoreWrite = false;
  const storeError = new Error('watcher store write failed');
  const fsPromises = jest.requireActual<typeof FsPromises>('node:fs/promises');
  const rename = fsPromises.rename;
  jest.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
    if (failNextStoreWrite && String(to) === getAppAdvisorWatchersFilePath()) {
      failNextStoreWrite = false;
      throw storeError;
    }
    await rename(from, to);
  });
  // A child archive failure precedes the destructive journal, so the
  // deletion can be retried; an index commit failure needs restart recovery.
  const error = new Error('child archive failed');
  jest
    .mocked(archiveWorkspaceWorktrees)
    .mockImplementationOnce(() => {
      failNextStoreWrite = true;
      return Promise.reject(error);
    })
    .mockImplementationOnce(() => Promise.reject(error));
  const deleteFromPortal = (): Promise<unknown> =>
    deleteWorkspace({ workspaceId: 'a', source: 'portal' });

  // The failed release's error is what the caller sees.
  await expect(deleteFromPortal()).rejects.toBe(storeError);

  // The deletion's fence stays up until a release persists.
  expect(await listed('two')).toEqual([]);
  await expect(
    service.createLocalWatcher(wakeup, destination('two'), 'tool-two-during'),
  ).rejects.toThrow('removed or archived');

  // A retried deletion that fails again releases the first attempt's fence.
  await expect(deleteFromPortal()).rejects.toBe(error);
  expect(await listed('two')).toEqual([two.id]);
  await expect(
    service.createLocalWatcher(wakeup, destination('two'), 'tool-two-after'),
  ).resolves.toMatchObject({ status: 'active' });
  expect(await listed('one')).toEqual([]);
  await service.releaseLocalScopeFence('a', 'one');
  expect(await listed('one')).toEqual([one.id]);
});

it('keeps its fence until restart when the release after an index commit failure fails', async () => {
  const service = getAppAdvisorWatcherService();
  const two = await service.createLocalWatcher(
    wakeup,
    destination('two'),
    'tool-two',
  );
  const storeError = new Error('watcher store write failed');
  let failNextStoreWrite = false;
  const fsPromises = jest.requireActual<typeof FsPromises>('node:fs/promises');
  const rename = fsPromises.rename;
  jest.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
    if (failNextStoreWrite && String(to) === getAppAdvisorWatchersFilePath()) {
      failNextStoreWrite = false;
      throw storeError;
    }
    await rename(from, to);
  });
  failIndexCommit(() => {
    failNextStoreWrite = true;
    return Promise.resolve();
  });

  await expect(deleteA()).rejects.toBe(storeError);

  // Fail closed: the workspace stays fenced, and the journal refuses a retry.
  expect(await listed('two')).toEqual([]);
  await expect(
    service.createLocalWatcher(wakeup, destination('two'), 'tool-two-during'),
  ).rejects.toThrow('removed or archived');
  await expect(deleteA()).rejects.toThrow('needs manual recovery');
  await expect(
    service.createLocalWatcher(wakeup, destination('two'), 'tool-two-retry'),
  ).rejects.toThrow('removed or archived');

  // A restart clears the in-memory fence and restores the cancellation.
  service.shutdown();
  service.configure(
    {
      getMainWindow: () => null,
      getAppAdvisorWindow: () => null,
      ensureAppAdvisorWindow: jest.fn(),
      sendAppAdvisorWindowCommand: jest.fn(),
      sendChatWindowCommand: jest.fn(() => false),
      deliverWatcherMessage: jest.fn(),
    },
    { deferStartupRecovery: true },
  );
  await service.reconcileAtStartup();
  expect(await listed('two')).toEqual([two.id]);
  await expect(
    service.createLocalWatcher(wakeup, destination('two'), 'tool-two-after'),
  ).resolves.toMatchObject({ status: 'active' });
});

it("restores its scopes after a user deletion's child archive fails, keeping a concurrent fence", async () => {
  const service = getAppAdvisorWatcherService();
  const one = await service.createLocalWatcher(
    wakeup,
    destination('one'),
    'tool-one',
  );
  const two = await service.createLocalWatcher(
    wakeup,
    destination('two'),
    'tool-two',
  );
  const three = await service.createLocalWatcher(
    wakeup,
    destination('three'),
    'tool-three',
  );
  await service.cancelLocalScope('a', 'three');
  const error = new Error('child archive failed');
  // As `archiveWorktree` does: "one" archives and commits its fence, then
  // "two" fails and releases its own.
  jest.mocked(archiveWorkspaceWorktrees).mockImplementationOnce(async () => {
    await service.cancelLocalScope('a', 'one');
    await service.commitLocalScopeCancellation('a', 'one');
    await service.cancelLocalScope('a', 'two');
    await service.releaseLocalScopeFence('a', 'two');
    throw error;
  });

  await expect(
    deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
  ).rejects.toBe(error);

  expect(
    (await service.list(destination('one'))).map((row) => row.id),
  ).not.toContain(one.id);
  expect(await listed('two')).toEqual([two.id]);
  await expect(
    service.createLocalWatcher(wakeup, destination('one'), 'tool-one-after'),
  ).resolves.toMatchObject({ status: 'active' });
  expect(await listed('three')).toEqual([]);
  await expect(
    service.createLocalWatcher(
      wakeup,
      destination('three'),
      'tool-three-during',
    ),
  ).rejects.toThrow('removed or archived');
  await service.releaseLocalScopeFence('a', 'three');
  expect(await listed('three')).toEqual([three.id]);
});

describe('a scoped release during an in-flight deletion (CAN-4987)', () => {
  /** A real worktree data cleanup of "one" that fails before removing data. */
  async function failedCleanupOfOne(): Promise<void> {
    const cleanupError = new Error('worktree cleanup failed');
    jest
      .spyOn(getChatStateService(), 'runWithScopeDeletion')
      .mockRejectedValueOnce(cleanupError);
    await expect(cleanupPersistedWorktreeData('a', 'one')).rejects.toBe(
      cleanupError,
    );
  }

  it("keeps the deletion's cancellations when a scoped cleanup fails, until the deletion releases them", async () => {
    const service = getAppAdvisorWatcherService();
    const one = await service.createLocalWatcher(
      wakeup,
      destination('one'),
      'tool-one',
    );
    const two = await service.createLocalWatcher(
      wakeup,
      destination('two'),
      'tool-two',
    );
    let during: Record<string, string[]> = {};
    const error = failIndexCommit(async () => {
      await failedCleanupOfOne();
      during = { one: await listed('one'), two: await listed('two') };
    });

    await expect(deleteA()).rejects.toBe(error);

    expect(during).toEqual({ one: [], two: [] });
    // The deletion's own release restores what it cancelled.
    expect(await listed('one')).toEqual([one.id]);
    expect(await listed('two')).toEqual([two.id]);
  });

  it('leaves no watcher of a deleted workspace behind after a scoped cleanup fails mid-deletion', async () => {
    const service = getAppAdvisorWatcherService();
    const one = await service.createLocalWatcher(
      wakeup,
      destination('one'),
      'tool-one',
    );
    const two = await service.createLocalWatcher(
      wakeup,
      destination('two'),
      'tool-two',
    );
    let during: string[] = [];
    duringIndexCommit(async () => {
      await failedCleanupOfOne();
      during = await listed('one');
    });

    await deleteA();

    expect(during).toEqual([]);
    const stored = await storedIds();
    expect(stored).not.toContain(one.id);
    expect(stored).not.toContain(two.id);
  });

  it('hands a scope fence taken before the deletion to the deletion when released mid-flight', async () => {
    const service = getAppAdvisorWatcherService();
    const one = await service.createLocalWatcher(
      wakeup,
      destination('one'),
      'tool-one',
    );
    // A concurrent worktree operation fences "one" before the deletion starts
    // and fails while the deletion is in flight.
    await service.cancelLocalScope('a', 'one');
    let during: string[] = [];
    const error = failIndexCommit(async () => {
      await service.releaseLocalScopeFence('a', 'one');
      during = await listed('one');
    });

    await expect(deleteA()).rejects.toBe(error);

    expect(during).toEqual([]);
    expect(await listed('one')).toEqual([one.id]);
  });
});

describe('a failed delete or startup recovery while a fence holds the watcher (CAN-4989)', () => {
  /**
   * Holds the first scheduler cancel of `id` until `fail` rejects it; later
   * cancels of it, such as the deletion fence's own, run for real.
   */
  function holdFirstCancelOf(id: string): {
    started: Promise<void>;
    fail: () => void;
  } {
    let signalStarted = (): void => {};
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let fail = (): void => {};
    const failed = new Promise<void>((_resolve, reject) => {
      fail = (): void => reject(new Error('termination failed'));
    });
    let held = false;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with the scheduler's `this` below.
    const cancel = LocalWatcherScheduler.prototype.cancel;
    jest
      .spyOn(LocalWatcherScheduler.prototype, 'cancel')
      .mockImplementation(async function (
        this: LocalWatcherScheduler,
        watcherId: string,
      ) {
        if (watcherId !== id || held) return cancel.call(this, watcherId);
        held = true;
        signalStarted();
        await failed;
      });
    return { started, fail };
  }

  const deletePaths = [
    {
      path: 'deleteWatcher',
      destination: destination('one'),
      remove: (id: string): Promise<unknown> =>
        getAppAdvisorWatcherService().deleteWatcher(id),
    },
    {
      path: 'deleteAgentWatchers',
      destination: destination('one'),
      remove: (id: string): Promise<unknown> =>
        getAppAdvisorWatcherService().deleteAgentWatchers(
          { watcherIds: [id] },
          destination('one'),
        ),
    },
    {
      path: 'removeDelegateWatchersForChat',
      destination: { ...destination('one'), delegationId: 'delegate-1' },
      remove: (): Promise<unknown> =>
        getAppAdvisorWatcherService().removeDelegateWatchersForChat(
          destination('one'),
        ),
    },
  ];

  it.each(deletePaths)(
    'keeps the deletion fence when $path fails to stop the watcher, and the commit removes it',
    async ({ destination: target, remove }) => {
      const service = getAppAdvisorWatcherService();
      const one = await service.createLocalWatcher(wakeup, target, 'tool-one');
      const cancel = holdFirstCancelOf(one.id);
      const removal = remove(one.id);
      await cancel.started;
      let during: string[] = [];
      duringIndexCommit(async () => {
        cancel.fail();
        await expect(removal).rejects.toThrow('termination failed');
        during = await listed('one');
      });

      await deleteA();

      expect(during).toEqual([]);
      expect(await storedIds()).not.toContain(one.id);
    },
  );

  it.each(deletePaths)(
    'passes the watcher to the deletion when $path fails to stop it, so the failed deletion restores it',
    async ({ destination: target, remove }) => {
      const service = getAppAdvisorWatcherService();
      const one = await service.createLocalWatcher(wakeup, target, 'tool-one');
      const cancel = holdFirstCancelOf(one.id);
      const removal = remove(one.id);
      await cancel.started;
      let during: string[] = [];
      const error = failIndexCommit(async () => {
        cancel.fail();
        await expect(removal).rejects.toThrow('termination failed');
        during = await listed('one');
      });

      await expect(deleteA()).rejects.toBe(error);

      expect(during).toEqual([]);
      expect(await listed('one')).toEqual([one.id]);
    },
  );

  // deleteWatcher refuses a watcher whose cancellation is already pending.
  it.each(deletePaths.filter(({ path }) => path !== 'deleteWatcher'))(
    'keeps a watcher the deletion already fenced when $path fails to stop it',
    async ({ destination: target, remove }) => {
      const service = getAppAdvisorWatcherService();
      const one = await service.createLocalWatcher(wakeup, target, 'tool-one');
      let during: string[] = [];
      const error = failIndexCommit(async () => {
        jest
          .spyOn(LocalWatcherScheduler.prototype, 'cancel')
          .mockRejectedValueOnce(new Error('termination failed'));
        await expect(remove(one.id)).rejects.toThrow('termination failed');
        during = await listed('one');
      });

      await expect(deleteA()).rejects.toBe(error);

      expect(during).toEqual([]);
      expect(await listed('one')).toEqual([one.id]);
    },
  );

  it("keeps only a scope fence's watcher, and its cancellation record, when deleteAgentWatchers fails to stop several", async () => {
    const service = getAppAdvisorWatcherService();
    const free = await service.createLocalWatcher(
      wakeup,
      destination('one'),
      'tool-free',
    );
    // Delivers to "one" and runs in "two", which a scope fence holds.
    const held = await service.createLocalWatcher(
      {
        kind: 'command_watch',
        command: 'printf ready',
        cwd: '/approved/worktree',
        intervalSeconds: 5,
        maxAttempts: 1,
      },
      destination('one'),
      'tool-held',
      undefined,
      { projectId: 'a', worktreeId: 'two' },
    );
    await service.cancelLocalScope('a', 'two');
    const fenceRecord = await storedCancellation(held.id);
    expect(fenceRecord).toMatchObject({
      scope: { projectId: 'a', worktreeId: 'two' },
    });
    jest
      .spyOn(LocalWatcherScheduler.prototype, 'cancel')
      .mockRejectedValue(new Error('termination failed'));

    await expect(
      service.deleteAgentWatchers(
        { watcherIds: [free.id, held.id] },
        destination('one'),
      ),
    ).rejects.toThrow('termination failed');

    expect(await listed('one')).toEqual([free.id]);
    expect(await storedCancellation(held.id)).toEqual(fenceRecord);
    jest.restoreAllMocks();
    await service.releaseLocalScopeFence('a', 'two');
    expect((await listed('one')).sort()).toEqual([free.id, held.id].sort());
  });

  function configureWithDeferredRecovery(): void {
    configureWatcherService({ deferStartupRecovery: true });
  }

  it('keeps the deletion fence through deferred startup recovery, and the commit removes the watcher', async () => {
    const service = getAppAdvisorWatcherService();
    configureWithDeferredRecovery();
    const one = await service.createLocalWatcher(
      wakeup,
      destination('one'),
      'tool-one',
    );
    let during: string[] = [];
    duringIndexCommit(async () => {
      await service.reconcileAtStartup();
      during = await listed('one');
    });

    await deleteA();

    expect(during).toEqual([]);
    expect(await storedIds()).not.toContain(one.id);
  });

  it('keeps the deletion fence through deferred startup recovery until the failed deletion restores the watcher', async () => {
    const service = getAppAdvisorWatcherService();
    configureWithDeferredRecovery();
    const one = await service.createLocalWatcher(
      wakeup,
      destination('one'),
      'tool-one',
    );
    let during: string[] = [];
    const error = failIndexCommit(async () => {
      await service.reconcileAtStartup();
      during = await listed('one');
    });

    await expect(deleteA()).rejects.toBe(error);

    expect(during).toEqual([]);
    expect(await listed('one')).toEqual([one.id]);
  });

  it('keeps a scope fence through deferred startup recovery until its own release', async () => {
    const service = getAppAdvisorWatcherService();
    configureWithDeferredRecovery();
    const one = await service.createLocalWatcher(
      wakeup,
      destination('one'),
      'tool-one',
    );
    await service.cancelLocalScope('a', 'one');

    await service.reconcileAtStartup();

    expect(await listed('one')).toEqual([]);
    await service.releaseLocalScopeFence('a', 'one');
    expect(await listed('one')).toEqual([one.id]);
  });

  /** Restarts the service, keeping stored cancellations as a crash would. */
  function restartWithDeferredRecovery(): void {
    getAppAdvisorWatcherService().shutdown();
    configureWithDeferredRecovery();
  }

  it("passes an earlier run's cancelled watcher to the deletion that fences its scope at recovery", async () => {
    const service = getAppAdvisorWatcherService();
    const one = await service.createLocalWatcher(
      wakeup,
      destination('one'),
      'tool-one',
    );
    await service.cancelLocalScope('a', 'one');
    restartWithDeferredRecovery();
    let during: string[] = [];
    const error = failIndexCommit(async () => {
      await service.reconcileAtStartup();
      during = await listed('one');
    });

    await expect(deleteA()).rejects.toBe(error);

    expect(during).toEqual([]);
    expect(await listed('one')).toEqual([one.id]);
  });

  it("removes an earlier run's cancelled watcher whose scope is gone at recovery, though a deletion fences it", async () => {
    const service = getAppAdvisorWatcherService();
    const gone = await service.createLocalWatcher(
      wakeup,
      destination('gone'),
      'tool-gone',
    );
    await service.cancelLocalScope('a', 'gone');
    restartWithDeferredRecovery();
    const error = failIndexCommit(() => service.reconcileAtStartup());

    await expect(deleteA()).rejects.toBe(error);

    expect(await storedIds()).not.toContain(gone.id);
  });

  it.each([
    {
      fence: 'scope',
      raise: (): Promise<void> =>
        getAppAdvisorWatcherService().cancelLocalScope('a', 'one'),
    },
    {
      fence: 'workspace',
      raise: (): Promise<void> =>
        getAppAdvisorWatcherService().cancelLocalWorkspace('a'),
    },
  ])(
    'raises no $fence block again when its queued step runs after shutdown',
    async ({ raise }) => {
      const service = getAppAdvisorWatcherService();
      const fence = raise();
      service.shutdown();
      await fence;

      await expect(
        service.createLocalWatcher(wakeup, destination('one'), 'tool-after'),
      ).resolves.toMatchObject({ status: 'active' });
    },
  );
});

describe('independent holders of one scope key (CAN-4989)', () => {
  /**
   * Starts a real worktree data cleanup of "one" that holds its scope fence
   * until `resume`, as an in-flight deletion of that scope does.
   */
  async function inFlightCleanupOfOne(): Promise<{
    resume: () => void;
    done: Promise<string[]>;
  }> {
    const chatState = getChatStateService();
    const runWithScopeDeletion = chatState.runWithScopeDeletion.bind(chatState);
    let signalFenced = (): void => {};
    const fenced = new Promise<void>((resolve) => {
      signalFenced = resolve;
    });
    let resume = (): void => {};
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    jest
      .spyOn(chatState, 'runWithScopeDeletion')
      .mockImplementationOnce(
        async <T>(
          scope: Parameters<typeof runWithScopeDeletion>[0],
          operation: () => Promise<T>,
        ): Promise<T> => {
          signalFenced();
          await gate;
          return runWithScopeDeletion(scope, operation);
        },
      );
    const done = cleanupPersistedWorktreeData('a', 'one');
    await fenced;
    return { resume, done };
  }

  it("keeps an in-flight cleanup's fence when another cleanup of the same scope fails", async () => {
    const service = getAppAdvisorWatcherService();
    const one = await service.createLocalWatcher(
      wakeup,
      destination('one'),
      'tool-one',
    );
    const inFlight = await inFlightCleanupOfOne();
    const cleanupError = new Error('worktree cleanup failed');
    jest
      .spyOn(getChatStateService(), 'runWithScopeDeletion')
      .mockRejectedValueOnce(cleanupError);

    await expect(cleanupPersistedWorktreeData('a', 'one')).rejects.toBe(
      cleanupError,
    );

    expect(await listed('one')).toEqual([]);
    await expect(
      service.createLocalWatcher(wakeup, destination('one'), 'tool-one-during'),
    ).rejects.toThrow('removed or archived');
    inFlight.resume();
    await inFlight.done;
    expect(await storedIds()).not.toContain(one.id);
  });

  it("keeps an in-flight cleanup's fence when another cleanup of the same scope commits first", async () => {
    const service = getAppAdvisorWatcherService();
    await service.createLocalWatcher(wakeup, destination('one'), 'tool-one');
    const inFlight = await inFlightCleanupOfOne();

    await cleanupPersistedWorktreeData('a', 'one');

    await expect(
      service.createLocalWatcher(wakeup, destination('one'), 'tool-one-during'),
    ).rejects.toThrow('removed or archived');
    inFlight.resume();
    await inFlight.done;
    await expect(
      service.createLocalWatcher(wakeup, destination('one'), 'tool-one-after'),
    ).resolves.toMatchObject({ status: 'active' });
  });

  it('keeps the fence when an operation that never fenced the scope releases it', async () => {
    const service = getAppAdvisorWatcherService();
    const one = await service.createLocalWatcher(
      wakeup,
      destination('one'),
      'tool-one',
    );
    await service.cancelLocalScope('a', 'one');

    // As a deletion that fails before raising its fence releases it.
    await runAsLocalFenceHolder(() =>
      service.releaseLocalScopeFence('a', 'one'),
    );

    expect(await listed('one')).toEqual([]);
    await service.releaseLocalScopeFence('a', 'one');
    expect(await listed('one')).toEqual([one.id]);
  });

  it('gives operations started after a holder settles holders of their own', async () => {
    const service = getAppAdvisorWatcherService();
    await service.createLocalWatcher(wakeup, destination('one'), 'tool-one');
    let startLater = (): void => {};
    const later = new Promise<void>((resolve) => {
      startLater = resolve;
    });
    let leftBehind: Promise<void> = Promise.resolve();
    await runAsLocalFenceHolder(() => {
      // Work an operation leaves behind, such as a timer or listener, keeps
      // its async context after it settles.
      leftBehind = later.then(async () => {
        const inFlight = await inFlightCleanupOfOne();
        const cleanupError = new Error('worktree cleanup failed');
        jest
          .spyOn(getChatStateService(), 'runWithScopeDeletion')
          .mockRejectedValueOnce(cleanupError);
        await expect(cleanupPersistedWorktreeData('a', 'one')).rejects.toBe(
          cleanupError,
        );
        expect(await listed('one')).toEqual([]);
        inFlight.resume();
        await inFlight.done;
      });
      return Promise.resolve();
    });

    startLater();
    await leftBehind;
  });

  it("lets an operation's nested cleanup release that operation's own fence", async () => {
    const service = getAppAdvisorWatcherService();
    const one = await service.createLocalWatcher(
      wakeup,
      destination('one'),
      'tool-one',
    );
    const cleanupError = new Error('worktree cleanup failed');

    await runAsLocalFenceHolder(async () => {
      await service.cancelLocalScope('a', 'one');
      jest
        .spyOn(getChatStateService(), 'runWithScopeDeletion')
        .mockRejectedValueOnce(cleanupError);
      await expect(cleanupPersistedWorktreeData('a', 'one')).rejects.toBe(
        cleanupError,
      );
    });

    expect(await listed('one')).toEqual([one.id]);
  });
});

// Characterization: these paths restore no watcher a live fence holds.
describe('fence paths that restore nothing early (CAN-4989)', () => {
  it("leaves a deletion's watchers cancelled until restart when its release lands between its read and cancel steps", async () => {
    const service = getAppAdvisorWatcherService();
    const one = await service.createLocalWatcher(
      wakeup,
      destination('one'),
      'tool-one',
    );
    // Queued behind the fence's read step, ahead of its per-scope steps.
    const fence = service.cancelLocalWorkspace('a');
    const release = service.releaseLocalWorkspaceFence('a');
    await Promise.all([fence, release]);

    expect(await listed('one')).toEqual([]);
    await expect(
      service.createLocalWatcher(wakeup, destination('two'), 'tool-two'),
    ).resolves.toMatchObject({ status: 'active' });
    service.shutdown();
    configureWatcherService();
    await service.reconcileAtStartup();
    expect(await listed('one')).toEqual([one.id]);
  });

  it('lets no scope holder that a project commit dropped restore its watcher', async () => {
    const service = getAppAdvisorWatcherService();
    const one = await service.createLocalWatcher(
      wakeup,
      destination('one'),
      'tool-one',
    );
    await service.cancelLocalScope('a', 'one');

    await deleteA();
    await service.releaseLocalScopeFence('a', 'one');

    expect(await storedIds()).not.toContain(one.id);
  });
});
