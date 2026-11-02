// CAN-4989 item 5: two removals of one scope each hold its watcher fence, so
// the one that finishes first must not restore watchers the other still holds
// or, by committing, reopen admission while the other is still removing.
// The real IPC Work Entry deletion, Auto Delete, external worktree removal and
// worktree archive race over the real watcher service, commit-log worker,
// files and Git, observed only through the watcher service's public API.
// Completion order is set at the registry row removal, the archive's sidecar
// cleanup, the chat scope deletion and the worktree list commit.
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import type * as ArchiveEngine from '../../archive/archive-io-engine';
import type * as CostLifecycle from '../../cost-index/lifecycle';
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
jest.mock('../../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
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
    deleteWorktreeDocs: jest.fn(() => Promise.resolve()),
    worktreeContainerArchived: jest.fn(() => Promise.resolve()),
  })),
}));
jest.mock('../../ledger/lifecycle', () => ({
  notifyLedgerContainerArchived: jest.fn(),
  notifyLedgerContainerRemovedExternally: jest.fn(),
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

import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import {
  APP_ADVISOR_PROJECT_ID,
  IPC_CHANNELS,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import { getAppAdvisorWatcherService } from '../../app-advisor/watchers';
import { registerWorkEntryHandlers } from '../../ipc/work-entries';
import { registerIpcHandler } from '../../ipc/register';
import {
  getChatStateService,
  resetChatStateServiceForTests,
} from '../../services/chat-state-service';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import { waitForScheduledArchivedContainerDiskUsage } from '../archived-container-disk-usage';
import * as coworkWorkEntries from '../cowork-work-entries';
import { stopPolling } from '../github-poller';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { archiveWorkEntry } from '../work-entry-archive';
import { archiveWorktree } from '../worktree-archive';
import * as worktreeDataCleanup from '../worktree-data-cleanup';
import { reconcileExternalWorktreeSnapshot } from '../worktree-registry-reconciliation';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import { shutdownW5BoundaryHost } from './fixtures/w5-boundary-host';

jest.setTimeout(60_000);
let dir: string;
let root: string;
let repo: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;
let worktrees: readonly WorktreeData[];

const wakeup = {
  kind: 'scheduled_wakeup' as const,
  delaySeconds: 3600,
  scheduledFor: '',
};

beforeEach(() => {
  resetChatStateServiceForTests();
  ({ dir, root, repo } = createW5BoundaryFixture((createdAt) => {
    worktrees = [
      { id: 'one', branchName: 'one', createdAt },
      { id: 'two', branchName: 'two', createdAt },
    ];
    return worktrees;
  }));
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
  // A failed expectation must not leave the first remover held open.
  openGates.splice(0).forEach((resume) => resume());
  await Promise.allSettled(inFlight.splice(0));
  getAppAdvisorWatcherService().shutdown();
  await waitForScheduledArchivedContainerDiskUsage();
  await settleDetachedWork();
  jest.restoreAllMocks();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await shutdownW5BoundaryHost(host, join(dir, 'w5', 'commit-log.sqlite'));
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

interface Gate {
  reached: Promise<void>;
  resume: () => void;
}

const openGates: (() => void)[] = [];
const inFlight: Promise<unknown>[] = [];

/** Starts the first remover, settled after each test even if it fails. */
function track<T>(operation: Promise<T>): Promise<T> {
  inFlight.push(operation.catch(() => undefined));
  return operation;
}

function gate(): Gate & { arrive: () => Promise<void> } {
  let signal = (): void => {};
  const reached = new Promise<void>((resolve) => {
    signal = resolve;
  });
  let resume = (): void => {};
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  openGates.push(resume);
  return {
    reached,
    resume,
    arrive: async (): Promise<void> => {
      signal();
      await resumed;
    },
  };
}

type Destination = { projectId: string; worktreeId: string; chatId: string };

async function activeIds(destination: Destination): Promise<string[]> {
  return (await getAppAdvisorWatcherService().list(destination))
    .filter((row) => row.status === 'active')
    .map((row) => row.id);
}

async function hasWatcher(
  destination: Destination,
  id: string,
): Promise<boolean> {
  return (await getAppAdvisorWatcherService().list(destination)).some(
    (row) => row.id === id,
  );
}

/** The second remover's view while the first still holds the fence. */
async function expectFenceHeld(destination: Destination): Promise<void> {
  expect(await activeIds(destination)).toEqual([]);
  await expect(
    getAppAdvisorWatcherService().createLocalWatcher(
      wakeup,
      destination,
      'tool-during',
    ),
  ).rejects.toThrow('removed or archived');
}

describe('two deletions of one Work Entry (CAN-4989)', () => {
  let entry: Destination;
  let lastTouchedAt: string | undefined;

  beforeEach(async () => {
    registerWorkEntryHandlers();
    const { entry: created } = await coworkWorkEntries.createWorkEntry(
      APP_ADVISOR_PROJECT_ID,
      { title: 'Entry' },
    );
    lastTouchedAt = created.lastTouchedAt;
    entry = {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: created.id,
      chatId: 'chat-entry',
    };
  });

  /** The registered `work-entries:delete` handler, as the renderer calls it. */
  function deleteFromIpc(): Promise<unknown> {
    const call = jest
      .mocked(registerIpcHandler)
      .mock.calls.find(
        ([channel]) => channel === IPC_CHANNELS.workEntriesDelete,
      );
    const handler = call?.[1];
    if (typeof handler !== 'function')
      throw new Error('Missing work-entries:delete handler');
    return Promise.resolve(
      Reflect.apply(handler, undefined, [
        undefined,
        { projectId: entry.projectId, entryId: entry.worktreeId },
      ]),
    );
  }

  /** As Auto Delete calls it, without its policy revalidation. */
  function autoDelete(): Promise<unknown> {
    return archiveWorkEntry({
      workspaceId: entry.projectId,
      entryId: entry.worktreeId,
      requireArchivedContainer: true,
      expectedLastTouchedAt: lastTouchedAt,
    });
  }

  /**
   * Holds the first deletion at its registry row removal, with its fence up,
   * and fails the second deletion's row removal.
   */
  function holdFirstRowRemovalAndFailSecond(error: Error): Gate {
    const held = gate();
    const remove = coworkWorkEntries.removeWorkEntryRow;
    let calls = 0;
    jest
      .spyOn(coworkWorkEntries, 'removeWorkEntryRow')
      .mockImplementation(async (projectId, entryId) => {
        calls += 1;
        if (calls === 2) throw error;
        if (calls === 1) await held.arrive();
        return remove(projectId, entryId);
      });
    return held;
  }

  it.each([
    {
      first: 'an IPC deletion',
      second: 'an Auto Delete',
      runFirst: (): Promise<unknown> => deleteFromIpc(),
      runSecond: (): Promise<unknown> => autoDelete(),
    },
    {
      first: 'an Auto Delete',
      second: 'an IPC deletion',
      runFirst: (): Promise<unknown> => autoDelete(),
      runSecond: (): Promise<unknown> => deleteFromIpc(),
    },
    {
      first: 'an IPC deletion',
      second: 'a duplicate IPC deletion',
      runFirst: (): Promise<unknown> => deleteFromIpc(),
      runSecond: (): Promise<unknown> => deleteFromIpc(),
    },
  ])(
    "keeps $first's fence when $second of the same entry fails first",
    async ({ runFirst, runSecond }) => {
      const service = getAppAdvisorWatcherService();
      const watcher = await service.createLocalWatcher(
        wakeup,
        entry,
        'tool-entry',
      );
      const error = new Error('row removal failed');
      const held = holdFirstRowRemovalAndFailSecond(error);
      const first = track(runFirst());
      await held.reached;
      expect(await activeIds(entry)).toEqual([]);

      await expect(runSecond()).rejects.toBe(error);

      await expectFenceHeld(entry);
      held.resume();
      await first;
      expect(await hasWatcher(entry, watcher.id)).toBe(false);
    },
  );
});

describe('an external removal and an archive of one worktree (CAN-4989)', () => {
  const one: Destination = { projectId: 'a', worktreeId: 'one', chatId: 'c1' };
  const archiveOne = (): Promise<unknown> =>
    archiveWorktree({
      workspaceId: 'a',
      worktreeId: 'one',
      source: 'single_repo',
      deleteWithoutRetentionIfMissing: true,
    });

  beforeEach(async () => {
    execFileSync('git', [
      '-C',
      repo,
      'worktree',
      'add',
      '-q',
      '-b',
      'one',
      join(root, 'a', 'worktrees', 'one'),
    ]);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    // Tracking only: no pull request poll runs for the tracked worktrees.
    stopPolling();
    // The watcher tracks the listed worktrees; a later snapshot without "one"
    // reports it removed outside the app.
    await reconcileExternalWorktreeSnapshot('a', worktrees);
  });

  function removeOneExternally(): Promise<void> {
    return reconcileExternalWorktreeSnapshot(
      'a',
      worktrees.filter((worktree) => worktree.id !== 'one'),
    );
  }

  /**
   * Holds the archive at its sidecar cleanup, after its fence and before its
   * row removal; other cleanups of the worktree run for real.
   */
  function holdArchiveSidecarCleanup(): Gate {
    const held = gate();
    const cleanup = worktreeDataCleanup.cleanupPersistedWorktreeData;
    jest
      .spyOn(worktreeDataCleanup, 'cleanupPersistedWorktreeData')
      .mockImplementation(async (projectId, worktreeId, options) => {
        if (options?.deferLocalWatcherCancellationCommit) await held.arrive();
        return cleanup(projectId, worktreeId, options);
      });
    return held;
  }

  it("keeps an archive's fence when an external removal of the worktree fails first", async () => {
    const service = getAppAdvisorWatcherService();
    const watcher = await service.createLocalWatcher(wakeup, one, 'tool-one');
    const held = holdArchiveSidecarCleanup();
    const archive = track(archiveOne());
    await held.reached;
    expect(await activeIds(one)).toEqual([]);
    // The archive's live teardown untracked "one", but its row is still
    // listed: a snapshot read now tracks it again, and the next one reports
    // it removed.
    await reconcileExternalWorktreeSnapshot('a', worktrees);
    const cleanupError = new Error('external cleanup failed');
    const failedCleanup = jest
      .spyOn(getChatStateService(), 'runWithScopeDeletion')
      .mockRejectedValueOnce(cleanupError);

    // External cleanup reports its failure as a warning.
    await removeOneExternally();

    expect(failedCleanup).toHaveBeenCalledTimes(1);
    await expect(failedCleanup.mock.results[0]?.value).rejects.toBe(
      cleanupError,
    );
    await expectFenceHeld(one);
    held.resume();
    await expect(archive).resolves.toMatchObject({ success: true });
    expect(await hasWatcher(one, watcher.id)).toBe(false);
  });

  it("keeps an archive's fence when an external removal of the worktree commits first", async () => {
    const service = getAppAdvisorWatcherService();
    const watcher = await service.createLocalWatcher(wakeup, one, 'tool-one');
    const held = holdArchiveSidecarCleanup();
    const archive = track(archiveOne());
    await held.reached;
    // As above, a snapshot read before the row removal tracks "one" again.
    await reconcileExternalWorktreeSnapshot('a', worktrees);

    await removeOneExternally();

    // Only a commit deletes the watcher; a failed cleanup would keep it.
    expect(await hasWatcher(one, watcher.id)).toBe(false);
    await expectFenceHeld(one);
    held.resume();
    await expect(archive).resolves.toMatchObject({ success: true });
    expect(await service.list(one)).toEqual([]);
  });

  /** Holds the external removal inside its chat scope deletion, fence up. */
  function holdExternalScopeDeletion(): Gate {
    const chatState = getChatStateService();
    const runWithScopeDeletion = chatState.runWithScopeDeletion.bind(chatState);
    const held = gate();
    jest
      .spyOn(chatState, 'runWithScopeDeletion')
      .mockImplementationOnce(
        async <T>(
          scope: Parameters<typeof runWithScopeDeletion>[0],
          operation: () => Promise<T>,
        ): Promise<T> => {
          await held.arrive();
          return runWithScopeDeletion(scope, operation);
        },
      );
    return held;
  }

  it("keeps an external removal's fence when an archive of the worktree commits first", async () => {
    const service = getAppAdvisorWatcherService();
    const watcher = await service.createLocalWatcher(wakeup, one, 'tool-one');
    const held = holdExternalScopeDeletion();
    const removal = track(removeOneExternally());
    await held.reached;

    await expect(archiveOne()).resolves.toMatchObject({ success: true });

    expect(await hasWatcher(one, watcher.id)).toBe(false);
    await expectFenceHeld(one);
    held.resume();
    await removal;
    expect(await service.list(one)).toEqual([]);
  });

  it("keeps an external removal's fence when an archive of the worktree fails first", async () => {
    const service = getAppAdvisorWatcherService();
    const watcher = await service.createLocalWatcher(wakeup, one, 'tool-one');
    const held = holdExternalScopeDeletion();
    const removal = track(removeOneExternally());
    await held.reached;
    expect(await activeIds(one)).toEqual([]);
    const archiveError = new Error('worktree list commit failed');
    const commit = host.commit.bind(host);
    const failedCommit = jest
      .spyOn(host, 'commit')
      .mockImplementation((request) =>
        request.files.some((file) => file.path.endsWith('worktrees.json'))
          ? Promise.reject(archiveError)
          : commit(request),
      );

    // Before its row is removed, so the archive releases its own fence.
    await expect(archiveOne()).rejects.toBe(archiveError);

    await expectFenceHeld(one);
    failedCommit.mockRestore();
    held.resume();
    await removal;
    expect(await hasWatcher(one, watcher.id)).toBe(false);
  });
});
