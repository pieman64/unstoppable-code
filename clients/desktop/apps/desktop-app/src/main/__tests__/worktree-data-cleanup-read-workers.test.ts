/**
 * Worktree removal against the real read-worker pool (only the utility
 * processes are fake): cleanup must cancel the build, await every read worker
 * for the worktree (busy, idle, or already shutting down), close the engine,
 * and only then remove `worktree-data/{worktreeId}`.
 */
import { EventEmitter } from 'node:events';

const events: string[] = [];

class FakeUtilityProcess extends EventEmitter {
  public readonly postMessage = jest.fn();
  public readonly kill = jest.fn(() => {
    events.push('reader-kill');
    return true;
  });
  public exited = false;

  public answer(): void {
    this.emit('message', {
      data: { ok: true, result: { kind: 'calls', value: [[]] } },
    });
  }

  public answerPersist(): void {
    this.emit('message', {
      data: { ok: true, result: { kind: 'persist-fingerprint' } },
    });
  }

  public exit(): void {
    if (this.exited) return;
    this.exited = true;
    events.push('reader-exit');
    this.emit('exit', 0);
  }
}

const children: FakeUtilityProcess[] = [];
const forkMock = jest.fn((): FakeUtilityProcess => {
  const child = new FakeUtilityProcess();
  children.push(child);
  return child;
});
jest.mock('electron', () => ({
  app: { getVersion: jest.fn(() => '0.0.0-test') },
  utilityProcess: {
    fork: (): FakeUtilityProcess => forkMock(),
  },
}));
jest.mock('../lib/code-graph-telemetry', () => ({
  recordCodeGraphReadDiagnostic: (): void => undefined,
  flushCodeGraphReadDiagnostics: (): void => undefined,
  recordCodeGraphQueryTelemetry: (): void => undefined,
  flushCodeGraphQueryTelemetry: (): void => undefined,
}));
jest.mock('../browser/browser-profile-lifecycle', () => ({
  retireRemovedBrowserTask: jest.fn(() => Promise.resolve()),
}));
jest.mock('node:fs/promises');
jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({
    cancelLocalScope: jest.fn(() => Promise.resolve()),
    releaseLocalScopeFence: jest.fn(() => Promise.resolve()),
    commitLocalScopeCancellation: jest.fn(),
  })),
}));
jest.mock('../lib/paths', () => ({
  getWorktreeBrowserStateFilePath: jest.fn(() => '/mock/browser.json'),
  getWorktreeAttachmentsDir: jest.fn(() => '/mock/attachments'),
  getWorktreeDataRootDir: jest.fn(() => '/mock/worktree-data'),
  getWorktreeSummaryFilePath: jest.fn(() => '/mock/summary.json'),
}));
// Cost removal has its own lifecycle suites; this one is about read workers.
jest.mock('../cost-index/lifecycle', () => ({
  removeEntryCost: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/plan-persistence', () => ({
  deleteTrackedPlansForWorktree: jest.fn(() => Promise.resolve()),
  listTrackedPlans: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../lib/plan-explore-cleanup', () => ({
  removePlanExploreChatsForWorktree: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../lib/code-review-scheduler', () => ({
  drainCodeReviewForDeletion: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/code-review-cleanup', () => ({
  removeCodeReviewChatsForWorktree: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../lib/detected-plan-persistence', () => ({
  deleteDetectedPlansForWorktree: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/script-log-store', () => ({
  deleteScriptRunLogsForWorktree: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/split-pr-persistence', () => ({
  deleteSplitPrMapForWorktree: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/hook-log-store', () => ({
  deleteHookRunLogsForWorktree: jest.fn(() => Promise.resolve()),
}));
jest.mock('../plugins/plugin-cleanup', () => ({
  cleanupWorktreeChatPluginDirs: jest.fn(),
}));
jest.mock('../observability/worktree-cleanup', () => ({
  purgePersistedWorktreeObservabilityData: jest.fn(() => Promise.resolve()),
}));
jest.mock('../browser/browser-service-registry', () => ({
  getBrowserService: jest.fn(() => null),
}));
jest.mock('../panels/persistence', () => ({
  panelLayoutPersistenceStore: { cancelPendingWrite: jest.fn() },
}));
const mockedCloseWorktree = jest.fn((): Promise<void> => {
  events.push('close');
  return Promise.resolve();
});
jest.mock('@canopy/desktop-shared/node/code-graph/service', () => ({
  getCodeGraphWorktreeService: jest.fn(() => ({
    closeWorktree: (): Promise<void> => mockedCloseWorktree(),
  })),
}));
jest.mock('../lib/code-graph-scheduler', () => ({
  cancelCodeGraphBuilds: (): void => {
    events.push('cancel-build');
  },
}));
jest.mock('../code-graph/build-runner', () => ({
  cancelBuild: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../code-graph/fingerprint-runner', () => ({
  cancelCodeGraphFingerprint: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../chat-search/service', () => ({
  getChatSearchService: jest.fn(() => ({
    deleteWorktreeDocs: jest.fn(() => Promise.resolve()),
    worktreeContainerArchived: jest.fn(() => Promise.resolve()),
  })),
}));
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: jest.fn(() => ({
    deleteScope: jest.fn(() => Promise.resolve()),
    runWithScopeDeletion: async (
      _scope: unknown,
      operation: () => Promise<unknown>,
    ): Promise<unknown> => operation(),
  })),
}));
const mockedRemoveWorktreeData = jest.fn((): Promise<void> => {
  events.push('rm');
  return Promise.resolve();
});
jest.mock('@canopy/desktop-shared/node/lib/worktree-data-cleanup', () => ({
  removePersistedWorktreeDataDirectory: (): Promise<void> =>
    mockedRemoveWorktreeData(),
}));

import { rm } from 'node:fs/promises';
import {
  CODE_GRAPH_READ_WORKER_IDLE_TIMEOUT_MS,
  cancelCodeGraphReads,
  resetCodeGraphReadRunnerForTests,
  runCodeGraphWorkerRead,
} from '../code-graph/read-runner';
import { cleanupPersistedWorktreeData } from '../lib/worktree-data-cleanup';

const KEY = 'project-1/wt-1';

function read(key = KEY): ReturnType<typeof runCodeGraphWorkerRead> {
  return runCodeGraphWorkerRead({
    key,
    kind: 'context',
    request: {
      dbPath: '/mock/worktree-data/wt-1/code-graph/graph.db',
      task: {
        kind: 'calls',
        calls: [{ method: 'file-summary', target: 'fixture.ts' }],
      },
    },
  });
}

function persistFingerprint(): ReturnType<typeof runCodeGraphWorkerRead> {
  return runCodeGraphWorkerRead({
    key: KEY,
    kind: 'fingerprint-persist',
    request: {
      dbPath: '/mock/worktree-data/wt-1/code-graph/graph.db',
      task: { kind: 'persist-fingerprint', fingerprint: 'fingerprint' },
    },
  });
}

/** Lets the cleanup run as far as it can without the reader exiting. */
async function drain(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function codeGraphOrder(): string[] {
  return events.filter((event) =>
    ['cancel-build', 'reader-kill', 'reader-exit', 'close', 'rm'].includes(
      event,
    ),
  );
}

describe('worktree removal with long-lived read workers', () => {
  beforeEach(() => {
    jest.mocked(rm).mockResolvedValue(undefined);
    resetCodeGraphReadRunnerForTests();
    events.length = 0;
    children.length = 0;
    forkMock.mockClear();
    mockedCloseWorktree.mockClear();
    mockedRemoveWorktreeData.mockClear();
  });

  afterEach(async () => {
    jest.useRealTimers();
    const canceling = Promise.all(
      [KEY, 'project-1/wt-2'].map((key) => cancelCodeGraphReads(key)),
    );
    for (const child of children) child.exit();
    await canceling;
  });

  it('awaits a reader that is mid-request before close and rm', async () => {
    const pending = read();
    const cleanup = cleanupPersistedWorktreeData('project-1', 'wt-1');
    await expect(pending).rejects.toMatchObject({ reason: 'canceled' });
    await drain();
    expect(mockedCloseWorktree).not.toHaveBeenCalled();
    expect(mockedRemoveWorktreeData).not.toHaveBeenCalled();

    children[0]?.exit();
    await expect(cleanup).resolves.toEqual([]);
    expect(codeGraphOrder()).toEqual([
      'cancel-build',
      'reader-kill',
      'reader-exit',
      'close',
      'rm',
    ]);
  });

  it('awaits an idle reader before close and rm', async () => {
    const first = read();
    children[0]?.answer();
    await first;

    const cleanup = cleanupPersistedWorktreeData('project-1', 'wt-1');
    await drain();
    expect(children[0]?.kill).toHaveBeenCalledTimes(1);
    expect(mockedCloseWorktree).not.toHaveBeenCalled();
    expect(mockedRemoveWorktreeData).not.toHaveBeenCalled();

    children[0]?.exit();
    await expect(cleanup).resolves.toEqual([]);
    expect(codeGraphOrder()).toEqual([
      'cancel-build',
      'reader-kill',
      'reader-exit',
      'close',
      'rm',
    ]);
  });

  it('awaits a reader that is mid-shutdown before close and rm', async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
    });
    const first = read();
    children[0]?.answer();
    await first;
    // The idle timer has killed the reader; its process has not exited.
    jest.advanceTimersByTime(CODE_GRAPH_READ_WORKER_IDLE_TIMEOUT_MS);
    expect(children[0]?.kill).toHaveBeenCalledTimes(1);

    const cleanup = cleanupPersistedWorktreeData('project-1', 'wt-1');
    await drain();
    expect(mockedCloseWorktree).not.toHaveBeenCalled();
    expect(mockedRemoveWorktreeData).not.toHaveBeenCalled();

    children[0]?.exit();
    await expect(cleanup).resolves.toEqual([]);
    expect(codeGraphOrder()).toEqual([
      'reader-kill',
      'cancel-build',
      'reader-exit',
      'close',
      'rm',
    ]);
  });

  it('awaits a reader retiring after an end-of-build write before close and rm', async () => {
    const persist = persistFingerprint();
    children[0]?.answerPersist();
    await persist;
    // A maintenance-only reader is killed once it answers; it has not exited.
    expect(children[0]?.kill).toHaveBeenCalledTimes(1);

    const cleanup = cleanupPersistedWorktreeData('project-1', 'wt-1');
    await drain();
    expect(mockedCloseWorktree).not.toHaveBeenCalled();
    expect(mockedRemoveWorktreeData).not.toHaveBeenCalled();

    children[0]?.exit();
    await expect(cleanup).resolves.toEqual([]);
    expect(codeGraphOrder()).toEqual([
      'reader-kill',
      'cancel-build',
      'reader-exit',
      'close',
      'rm',
    ]);
  });

  it('starts no reader for a request that arrives during cleanup', async () => {
    const first = read();
    children[0]?.answer();
    await first;
    const cleanup = cleanupPersistedWorktreeData('project-1', 'wt-1');
    await drain();

    // Mid-cleanup: the old reader is still exiting.
    await expect(read()).rejects.toMatchObject({ reason: 'canceled' });
    children[0]?.exit();
    await cleanup;
    expect(forkMock).toHaveBeenCalledTimes(1);

    // Another worktree's reads were never fenced.
    const other = read('project-1/wt-2');
    expect(forkMock).toHaveBeenCalledTimes(2);
    children[1]?.answer();
    await other;
  });

  it('keeps the fence through metadata removal and lifts it afterwards', async () => {
    let finishRm: (() => void) | undefined;
    mockedRemoveWorktreeData.mockImplementationOnce(() => {
      events.push('rm');
      return new Promise<void>((resolve) => {
        finishRm = resolve;
      });
    });
    const cleanup = cleanupPersistedWorktreeData('project-1', 'wt-1');
    await drain();
    expect(finishRm).toBeDefined();
    await expect(read()).rejects.toMatchObject({ reason: 'canceled' });
    expect(forkMock).not.toHaveBeenCalled();

    finishRm?.();
    await cleanup;
    // The worktree's data is gone; a late read opens nothing it could keep.
    const late = read();
    expect(forkMock).toHaveBeenCalledTimes(1);
    children[0]?.answer();
    await late;
  });
});
