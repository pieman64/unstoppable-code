/** PRIVATE, UNRUN Jest candidates: no acceptance/performance claim. */
import type * as Events from 'node:events';
import type { CodeGraphWorktreeService } from '@canopy/desktop-shared/node/code-graph/service';
import type { CodeGraphRepositoryInput } from '@canopy/desktop-shared/types/code-graph';
import type {
  CodeGraphSummaryProjectionV1,
  ReadCodeGraphSummaryProjectionResult,
} from '@canopy/code-graph/summary-projection';
import type { CodeGraphWorkerReadResponse } from '../code-graph/read-runner';
import type {
  CodeGraphWorkerBuildRequest,
  CodeGraphWorkerBuildResponse,
  CodeGraphSummaryRepairRequest,
} from '../code-graph/build-runner';

interface MockChildProcess extends Events.EventEmitter {
  readonly postMessage: jest.Mock<void, unknown[]>;
  readonly kill: jest.Mock<boolean, []>;
}

jest.mock('electron', () => {
  const { EventEmitter } = jest.requireActual<typeof Events>('node:events');
  class Child extends EventEmitter implements MockChildProcess {
    public readonly postMessage = jest.fn<void, unknown[]>();
    public readonly kill = jest.fn<boolean, []>(() => true);
  }
  return { utilityProcess: { fork: jest.fn(() => new Child()) } };
});
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {
    throw new Error('Uninitialized deferred.');
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let mockCloseGate = deferred<void>();
const mockCloseEvents: string[] = [];
function mockWithClosed<T>(
  project: string,
  worktree: string,
  operation: () => Promise<T>,
): Promise<T> {
  mockCloseEvents.push(`closing:${project}/${worktree}`);
  return mockCloseGate.promise.then(() => {
    mockCloseEvents.push(`closed:${project}/${worktree}`);
    return operation();
  });
}
jest.mock('@canopy/desktop-shared/node/code-graph/service', () => ({
  getCodeGraphWorktreeService: (): Pick<
    CodeGraphWorktreeService,
    'withWorktreeClosed'
  > => ({ withWorktreeClosed: mockWithClosed }),
}));
jest.mock('@canopy/desktop-shared/node/code-graph/worktree-paths', () => ({
  getWorktreeCodeGraphDbPath: (project: string, worktree: string): string =>
    `/graphs/${project}/${worktree}/graph.db`,
}));
jest.mock('@canopy/desktop-shared/pipelines/config-paths', () => ({
  getBundledCodeGraphDir: (): string => '/bundle/code-graph',
}));
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: (project: string, worktree: string): string =>
    `/worktrees/${project}/${worktree}`,
}));
jest.mock('../lib/worktree-repo-entries', () => ({
  resolveWorktreeCodeGraphRepositories: (
    _project: string,
    root: string,
  ): Promise<CodeGraphRepositoryInput[]> =>
    Promise.resolve([{ repoId: 'repo', rootPath: root }]),
}));
const mockAvailable = jest.fn(() => true);
jest.mock('../lib/code-graph-availability', () => ({
  isCodeGraphAvailableForWorkspace: (): boolean => mockAvailable(),
  getCodeGraphGenerationTimeoutMs: (): number => 30 * 60 * 1000,
}));
const mockRead = jest.fn<Promise<CodeGraphWorkerReadResponse>, [unknown]>();
jest.mock('../code-graph/read-runner', () => ({
  runCodeGraphWorkerRead: (
    input: unknown,
  ): Promise<CodeGraphWorkerReadResponse> => mockRead(input),
  CodeGraphReadFailureError: class extends Error {
    constructor(public readonly readFailure: string) {
      super('The code-graph read failed.');
    }
  },
}));
import 'electron';
import {
  beginCodeGraphWorkerBuild,
  cancelBuild,
  codeGraphBuildRunnerTestExports,
  getCodeGraphGenerationQueueSnapshot,
  getCodeGraphSourceBuildState,
  isCodeGraphBuildPending,
  killAllBuilds,
  requestCodeGraphSummaryRepair,
  setCodeGraphGenerationQueueListener,
} from '../code-graph/build-runner';
const mockFork = jest.requireMock<{
  utilityProcess: { fork: jest.Mock<MockChildProcess, unknown[]> };
}>('electron').utilityProcess.fork;
const projection: CodeGraphSummaryProjectionV1 = {
  formatVersion: 1,
  schemaVersion: 1,
  extractorVersion: 1,
  projectionRevision: 1,
  lastBuildAt: 10,
  completedBuildAt: 10,
  derivedAt: null,
  assembly: 'complete',
  customLanguagesFingerprint: null,
  repositories: [],
  totals: {
    fileCount: 0,
    symbolCount: 0,
    edgeCount: 0,
    contextUnresolvedEdgeCount: 0,
    contextFilesWithErrors: 0,
    legacyUnresolvedEdgeCount: 0,
    legacyFilesWithErrors: 0,
    communityCount: 0,
    flowCount: 0,
  },
  topCommunities: [],
  customLanguages: null,
};
const ready: ReadCodeGraphSummaryProjectionResult = {
  state: 'ready',
  projection,
  diagnostics: null,
};
const pending: ReadCodeGraphSummaryProjectionResult = {
  state: 'pending',
  reason: 'projection-missing',
  diagnostics: null,
  observed: {
    schemaVersion: 1,
    extractorVersion: 1,
    projectionRevision: null,
    lastBuildAt: 10,
    completedBuildAt: 10,
    derivedAt: null,
  },
};
function readResponse(
  value: ReadCodeGraphSummaryProjectionResult,
): CodeGraphWorkerReadResponse {
  return { ok: true, result: { kind: 'readonly-summary', value } };
}
function input(worktree: string): CodeGraphSummaryRepairRequest {
  return {
    key: `ws/${worktree}`,
    projectId: 'ws',
    worktreeId: worktree,
    dbPath: `/graphs/ws/${worktree}/graph.db`,
  };
}
function request(): CodeGraphWorkerBuildRequest {
  return {
    dbPath: '/graphs/source/graph.db',
    worktreeRootPath: '/worktrees/source',
    resourcesDir: '/bundle/code-graph',
    repositories: [{ repoId: 'repo', rootPath: '/worktrees/source' }],
    options: {},
  };
}
function requestFor(worktree: string): CodeGraphWorkerBuildRequest {
  const root = `/worktrees/ws/${worktree}`;
  return {
    ...request(),
    dbPath: input(worktree).dbPath,
    worktreeRootPath: root,
    repositories: [{ repoId: 'repo', rootPath: root }],
  };
}
function published(derivedPending = false): CodeGraphWorkerBuildResponse {
  const response: CodeGraphWorkerBuildResponse = {
    ok: true,
    result: {
      filesScanned: 1,
      filesParsed: 1,
      filesUnchanged: 0,
      filesSkipped: 0,
      filesRemoved: 0,
      parseFailures: 0,
      symbolCount: 2,
      edgeCount: 1,
      durationMs: 5,
      derived: [],
      customLanguages: null,
    },
  };
  return derivedPending ? { ...response, derivedPending: true } : response;
}
function child(index: number): MockChildProcess {
  const result = mockFork.mock.results[index];
  if (result === undefined || result.type !== 'return')
    throw new Error(`No child ${index}.`);
  return result.value;
}
async function flush(): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
}

describe('existing owner closure + authoritative repair admission', () => {
  beforeEach(() => {
    mockCloseGate = deferred<void>();
    mockCloseEvents.length = 0;
    mockRead.mockReset();
    mockAvailable.mockReturnValue(true);
    mockRead.mockResolvedValue(readResponse(pending));
    codeGraphBuildRunnerTestExports.setBackgroundBuildInterTaskDelayMs(0);
    codeGraphBuildRunnerTestExports.resetSummaryRepairSchedulingState();
  });
  afterEach(async () => {
    mockCloseGate.resolve();
    const stopped = killAllBuilds();
    for (const result of mockFork.mock.results)
      if (result.type === 'return') result.value.emit('exit', 0);
    await stopped;
    mockFork.mockClear();
    setCodeGraphGenerationQueueListener(null);
    jest.useRealTimers();
  });
  it('a pre-launch cancellation keeps ownership and retries its failed kill on actual spawn', async () => {
    mockCloseGate.resolve();
    const repair = requestCodeGraphSummaryRepair(input('launch-cancel'));
    await flush();
    jest.mocked(child(0).kill).mockReturnValueOnce(false);
    const cleanup = cancelBuild('ws/launch-cancel');
    const later = beginCodeGraphWorkerBuild('after-launch-cancel', request());
    await flush();
    expect(mockFork).toHaveBeenCalledTimes(1);
    child(0).emit('spawn');
    expect(child(0).kill).toHaveBeenCalledTimes(2);
    expect(mockFork).toHaveBeenCalledTimes(1);
    child(0).emit('exit', 0);
    await cleanup;
    await expect(repair).resolves.toMatchObject({
      ok: false,
      reason: 'canceled',
    });
    child(1).emit('message', published());
    await later.promise;
  });
  it('response without exit stays pending beyond five seconds; watchdog still kills and actual exit determines failure', async () => {
    jest.useFakeTimers();
    mockCloseGate.resolve();
    const repair = requestCodeGraphSummaryRepair(input('response-no-exit'));
    await flush();
    const later = beginCodeGraphWorkerBuild(
      'after-response-no-exit',
      request(),
    );
    let settled = false;
    void repair.then(() => {
      settled = true;
    });
    child(0).emit('message', {
      ok: true,
      result: { state: 'ready', projection },
    });
    jest.advanceTimersByTime(5001);
    await flush();
    expect(settled).toBe(false);
    expect(isCodeGraphBuildPending('ws/response-no-exit')).toBe(true);
    expect(mockFork).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(5 * 60 * 1000 - 5001);
    await flush();
    expect(child(0).kill).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(5001);
    await flush();
    expect(settled).toBe(false);
    expect(mockFork).toHaveBeenCalledTimes(1);
    child(0).emit('exit', 0);
    await expect(repair).resolves.toMatchObject({
      ok: false,
      reason: 'worker-failed',
    });
    await flush();
    expect(mockFork).toHaveBeenCalledTimes(2);
    child(1).emit('message', published());
    await later.promise;
  });
  it.each(['cancel', 'timeout'])(
    '%s without exit holds repair key and slots beyond the legacy five-second timer',
    async (terminal) => {
      jest.useFakeTimers();
      mockCloseGate.resolve();
      const owner = input(`actual-exit-${terminal}`);
      const repair = requestCodeGraphSummaryRepair(owner);
      await flush();
      const later = beginCodeGraphWorkerBuild(
        `after-actual-exit-${terminal}`,
        request(),
      );
      let cleanupSettled = false;
      let cleanup: Promise<void> = Promise.resolve();
      if (terminal === 'cancel')
        cleanup = cancelBuild(owner.key).then(() => {
          cleanupSettled = true;
        });
      else jest.advanceTimersByTime(5 * 60 * 1000);
      jest.advanceTimersByTime(5001);
      await flush();
      expect(child(0).kill).toHaveBeenCalledTimes(1);
      expect(mockFork).toHaveBeenCalledTimes(1);
      expect(isCodeGraphBuildPending(owner.key)).toBe(true);
      if (terminal === 'cancel') expect(cleanupSettled).toBe(false);
      child(0).emit('exit', 0);
      await cleanup;
      await expect(repair).resolves.toMatchObject({
        ok: false,
        reason: terminal === 'cancel' ? 'canceled' : 'worker-failed',
      });
      await flush();
      expect(mockFork).toHaveBeenCalledTimes(2);
      expect(child(0).kill).toHaveBeenCalledTimes(1);
      child(0).emit('exit', 0);
      await flush();
      expect(mockFork).toHaveBeenCalledTimes(2); // duplicate exit cannot release another slot
      child(1).emit('message', published());
      await later.promise;
    },
  );
  it('a legacy canceled source exceeding its bounded cleanup timer still cannot authorize a new repair writer', async () => {
    jest.useFakeTimers();
    const owner = input('old-source-no-exit');
    const source = beginCodeGraphWorkerBuild(
      owner.key,
      requestFor(owner.worktreeId),
    );
    const rejection = expect(source.promise).rejects.toMatchObject({
      reason: 'canceled',
    });
    const legacyCleanup = cancelBuild(owner.key);
    jest.advanceTimersByTime(5001);
    await legacyCleanup;
    await rejection;
    mockCloseGate.resolve();
    const repair = requestCodeGraphSummaryRepair(owner);
    await flush();
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockFork).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(10000);
    await flush();
    expect(mockFork).toHaveBeenCalledTimes(1);
    child(0).emit('exit', 0);
    await flush();
    expect(mockFork).toHaveBeenCalledTimes(2);
    child(1).emit('message', {
      ok: true,
      result: { state: 'ready', projection },
    });
    child(1).emit('exit', 0);
    await expect(repair).resolves.toMatchObject({
      ok: true,
      resolution: 'repaired',
    });
  });
  it('immediate/coalesced source handles expose the actual nonnull shared record id and compatibility promise', async () => {
    const first = beginCodeGraphWorkerBuild('identity-immediate', request());
    const second = beginCodeGraphWorkerBuild('identity-immediate', request());
    expect(first.attemptId).not.toBeNull();
    expect(first.attemptId).not.toBe('');
    expect(second.attemptId).toBe(first.attemptId);
    expect(second.promise).toBe(first.promise);
    child(0).emit('message', published());
    await Promise.all([first.promise, second.promise]);
    expect(second.attemptId).toBe(first.attemptId);
  });
  it('held drain/supersession handles remain null until an actual record is selected, then coalesce terminal identity', async () => {
    const initial = beginCodeGraphWorkerBuild('identity-drain', {
      ...request(),
      deferDerived: true,
    });
    child(0).emit('message', published(true));
    await initial.promise;
    const first = beginCodeGraphWorkerBuild('identity-drain', request());
    const second = beginCodeGraphWorkerBuild('identity-drain', request());
    expect(first.attemptId).toBeNull();
    expect(second.attemptId).toBeNull();
    expect(mockFork).toHaveBeenCalledTimes(1);
    child(0).emit('exit', 0);
    await flush();
    expect(mockFork).toHaveBeenCalledTimes(2);
    expect(first.attemptId).not.toBeNull();
    expect(second.attemptId).toBe(first.attemptId);
    child(1).emit('message', published());
    await Promise.all([first.promise, second.promise]);
    expect(second.attemptId).toBe(first.attemptId);
  });
  it('pre-admission cleanup rejection leaves both pending source handles null, with no fake correlation identity', async () => {
    const initial = beginCodeGraphWorkerBuild('identity-cancel', {
      ...request(),
      deferDerived: true,
    });
    child(0).emit('message', published(true));
    await initial.promise;
    const first = beginCodeGraphWorkerBuild('identity-cancel', request());
    const second = beginCodeGraphWorkerBuild('identity-cancel', request());
    const firstRejected = expect(first.promise).rejects.toMatchObject({
      reason: 'canceled',
    });
    const secondRejected = expect(second.promise).rejects.toMatchObject({
      reason: 'canceled',
    });
    const cleanup = cancelBuild('identity-cancel');
    child(0).emit('exit', 0);
    await Promise.all([cleanup, firstRejected, secondRejected]);
    expect(first.attemptId).toBeNull();
    expect(second.attemptId).toBeNull();
    expect(mockFork).toHaveBeenCalledTimes(1);
  });
  it('queued admission ready-skip avoids a writer even when projection became ready after initial preflight', async () => {
    const background = beginCodeGraphWorkerBuild('ready-block-bg', request());
    const agent = beginCodeGraphWorkerBuild('ready-block-agent', request(), {
      priority: 'agent',
    });
    mockCloseGate.resolve();
    const repair = requestCodeGraphSummaryRepair(input('ready-after-queue'));
    await flush();
    expect(mockRead).toHaveBeenCalledTimes(1);
    expect(mockFork).toHaveBeenCalledTimes(2);
    mockRead.mockResolvedValue(readResponse(ready));
    child(0).emit('message', published());
    await background.promise;
    await flush();
    await expect(repair).resolves.toMatchObject({
      ok: true,
      result: { state: 'ready', projection },
    });
    expect(mockFork).toHaveBeenCalledTimes(2);
    child(1).emit('message', published());
    await agent.promise;
  });
  it('successful repair response retains its background slot beyond five seconds until normal actual exit', async () => {
    jest.useFakeTimers();
    mockCloseGate.resolve();
    const repair = requestCodeGraphSummaryRepair(input('success-exit'));
    await flush();
    const source = beginCodeGraphWorkerBuild('after-success-exit', request());
    child(0).emit('message', {
      ok: true,
      result: { state: 'ready', projection },
    });
    jest.advanceTimersByTime(5001);
    await flush();
    expect(child(0).kill).not.toHaveBeenCalled();
    expect(mockFork).toHaveBeenCalledTimes(1);
    expect(isCodeGraphBuildPending('ws/success-exit')).toBe(true);
    child(0).emit('exit', 0);
    await repair;
    await flush();
    expect(mockFork).toHaveBeenCalledTimes(2);
    child(1).emit('message', published());
    await source.promise;
  });
  it('five-minute repair execution timeout kills but does not release its held slot before exit', async () => {
    jest.useFakeTimers();
    mockCloseGate.resolve();
    const repair = requestCodeGraphSummaryRepair(input('execution-timeout'));
    await flush();
    const background = beginCodeGraphWorkerBuild('after-timeout', request());
    jest.advanceTimersByTime(5 * 60 * 1000);
    await flush();
    expect(child(0).kill).toHaveBeenCalledTimes(1);
    expect(mockFork).toHaveBeenCalledTimes(1);
    child(0).emit('exit', 0);
    await expect(repair).resolves.toMatchObject({
      ok: false,
      reason: 'worker-failed',
    });
    await flush();
    expect(mockFork).toHaveBeenCalledTimes(2);
    child(1).emit('message', published());
    await background.promise;
  });
  it('closes/evicts the existing service owner before any readonly preflight or writer fork', async () => {
    const repair = requestCodeGraphSummaryRepair(input('fence'));
    await flush();
    expect(mockCloseEvents).toEqual(['closing:ws/fence']);
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockFork).not.toHaveBeenCalled();
    mockCloseGate.resolve();
    await flush();
    expect(mockCloseEvents).toEqual(['closing:ws/fence', 'closed:ws/fence']);
    expect(mockRead).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'ws/fence',
        kind: 'base-validation',
        diagnosticOwner: { projectId: 'ws', worktreeId: 'fence' },
        request: {
          dbPath: '/graphs/ws/fence/graph.db',
          task: { kind: 'readonly-summary' },
        },
      }),
    );
    expect(child(0).postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'summary-repair',
        worktreeRootPath: '/worktrees/ws/fence',
        customLanguagesRootPath: '/worktrees/ws/fence',
        resourcesDir: '/bundle/code-graph',
        repositories: [{ repoId: 'repo', rootPath: '/worktrees/ws/fence' }],
      }),
    );
    child(0).emit('message', {
      ok: true,
      result: { state: 'ready', projection },
    });
    child(0).emit('exit', 0);
    await expect(repair).resolves.toMatchObject({
      ok: true,
      resolution: 'repaired',
    });
  });
  it('ready preflight avoids repair worker/Engine.open and retains genuine measured zero', async () => {
    mockRead.mockResolvedValue(readResponse(ready));
    mockCloseGate.resolve();
    await expect(
      requestCodeGraphSummaryRepair(input('ready')),
    ).resolves.toMatchObject({
      ok: true,
      attemptId: null,
      resolution: 'already-ready',
      result: { state: 'ready', projection },
    });
    expect(mockRead).toHaveBeenCalledTimes(1);
    expect(mockFork).not.toHaveBeenCalled();
  });
  it.each<ReadCodeGraphSummaryProjectionResult>([
    { state: 'missing' },
    { state: 'error', classification: 'busy' },
    { state: 'error', classification: 'permission-denied' },
    { state: 'error', classification: 'io' },
  ])('does not open a writer for %j', async (value) => {
    mockRead.mockResolvedValue(readResponse(value));
    mockCloseGate.resolve();
    const outcome = await requestCodeGraphSummaryRepair(
      input(
        `failure-${value.state}-${value.state === 'error' ? value.classification : 'missing'}`,
      ),
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'worker-failed' });
    expect(mockFork).not.toHaveBeenCalled();
    expect(JSON.stringify(outcome)).not.toContain('/graphs/');
  });
  it('read admission saturation is an honest failure, not missing/repair permission', async () => {
    mockRead.mockResolvedValue({
      ok: false,
      code: 'busy',
      message: 'The graph read is busy.',
    });
    mockCloseGate.resolve();
    await expect(
      requestCodeGraphSummaryRepair(input('saturated')),
    ).resolves.toMatchObject({ ok: false, reason: 'worker-failed' });
    expect(mockFork).not.toHaveBeenCalled();
  });
  it('cancellation while owner-close is pending prevents later admission and cleanup awaits preparation', async () => {
    const repair = requestCodeGraphSummaryRepair(input('close-cancel'));
    let cleaned = false;
    const cleanup = cancelBuild('ws/close-cancel').then(() => {
      cleaned = true;
    });
    await flush();
    expect(cleaned).toBe(false);
    mockCloseGate.resolve();
    await cleanup;
    await expect(repair).resolves.toMatchObject({
      ok: false,
      reason: 'canceled',
    });
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockFork).not.toHaveBeenCalled();
  });
  it('cancellation during readonly preflight prevents a stale continuation from opening a writer', async () => {
    const read = deferred<CodeGraphWorkerReadResponse>();
    mockRead.mockReturnValue(read.promise);
    mockCloseGate.resolve();
    const repair = requestCodeGraphSummaryRepair(input('read-cancel'));
    await flush();
    const cleanup = cancelBuild('ws/read-cancel');
    read.resolve(readResponse(pending));
    await cleanup;
    await expect(repair).resolves.toMatchObject({
      ok: false,
      reason: 'canceled',
    });
    expect(mockFork).not.toHaveBeenCalled();
  });
  it('joins actual source publication and derived drain, then ready satisfies all repair waiters without a second fork', async () => {
    const source = beginCodeGraphWorkerBuild('ws/drain', {
      ...requestFor('drain'),
      deferDerived: true,
    });
    const first = requestCodeGraphSummaryRepair(input('drain'));
    const second = requestCodeGraphSummaryRepair(input('drain'));
    expect(second).toBe(first);
    mockCloseGate.resolve();
    await flush();
    expect(mockRead).not.toHaveBeenCalled();
    child(0).emit('message', published(true));
    await source.promise;
    expect(getCodeGraphSourceBuildState('ws/drain')).toBe('idle');
    expect(isCodeGraphBuildPending('ws/drain')).toBe(true);
    await flush();
    expect(mockRead).not.toHaveBeenCalled();
    expect(child(0).kill).not.toHaveBeenCalled();
    mockRead.mockResolvedValue(readResponse(ready));
    child(0).emit('message', { kind: 'derived-complete', ok: true });
    child(0).emit('exit', 0);
    await expect(first).resolves.toMatchObject({
      ok: true,
      attemptId: source.attemptId,
      resolution: 'source-publication',
    });
    expect(mockFork).toHaveBeenCalledTimes(1);
  });
  it('lets compatible source replace only a queued repair, preserving its shared waiters and source identity', async () => {
    const background = beginCodeGraphWorkerBuild('block-background', request());
    const agent = beginCodeGraphWorkerBuild('block-agent', request(), {
      priority: 'agent',
    });
    mockCloseGate.resolve();
    const first = requestCodeGraphSummaryRepair(input('queued-source'));
    const second = requestCodeGraphSummaryRepair(input('queued-source'));
    await flush();
    expect(second).toBe(first);
    expect(mockFork).toHaveBeenCalledTimes(2);
    const source = beginCodeGraphWorkerBuild(
      'ws/queued-source',
      requestFor('queued-source'),
      { priority: 'agent' },
    );
    mockRead.mockResolvedValue(readResponse(ready));
    child(1).emit('message', published());
    await agent.promise;
    await flush();
    expect(child(2).postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ options: {} }),
    );
    child(2).emit('message', published());
    child(2).emit('exit', 0);
    await source.promise;
    await expect(first).resolves.toMatchObject({
      ok: true,
      attemptId: source.attemptId,
      resolution: 'source-publication',
    });
    expect(mockFork).toHaveBeenCalledTimes(3);
    child(0).emit('message', published());
    await background.promise;
  });
  it('active repair is not preempted; later source waiters share one queued attempt/promise', async () => {
    mockCloseGate.resolve();
    const repair = requestCodeGraphSummaryRepair(input('active'));
    await flush();
    const first = beginCodeGraphWorkerBuild('ws/active', requestFor('active'));
    const second = beginCodeGraphWorkerBuild('ws/active', requestFor('active'));
    expect(first.promise).toBe(second.promise);
    expect(first.attemptId).toBe(second.attemptId);
    expect(getCodeGraphSourceBuildState('ws/active')).toBe('queued');
    expect(child(0).kill).not.toHaveBeenCalled();
    expect(mockFork).toHaveBeenCalledTimes(1);
    child(0).emit('message', {
      ok: true,
      result: { state: 'ready', projection },
    });
    child(0).emit('exit', 0);
    await repair;
    await flush();
    expect(mockFork).toHaveBeenCalledTimes(2);
    child(1).emit('message', published());
    await Promise.all([first.promise, second.promise]);
    expect(first.attemptId).not.toBeNull();
    expect(second.attemptId).toBe(first.attemptId);
  });
  it.each(['worker-exit', 'malformed-response', 'timeout'])(
    'admits one independent source attempt after active repair %s and actual exit',
    async (failure) => {
      jest.useFakeTimers();
      mockCloseGate.resolve();
      const repair = requestCodeGraphSummaryRepair(input('failed-active'));
      await flush();
      const first = beginCodeGraphWorkerBuild(
        'ws/failed-active',
        requestFor('failed-active'),
      );
      const second = beginCodeGraphWorkerBuild(
        'ws/failed-active',
        requestFor('failed-active'),
      );
      const sourceOutcome = Promise.all([first.promise, second.promise]).then(
        (values) => ({ values }),
        (error: unknown) => ({ error }),
      );
      expect(first.promise).toBe(second.promise);
      expect(first.attemptId).toBe(second.attemptId);
      if (failure === 'malformed-response') {
        child(0).emit('message', { invalid: true });
      } else if (failure === 'timeout') {
        jest.advanceTimersByTime(5 * 60 * 1000);
      }
      await flush();
      // A bounded five-second cleanup fallthrough is not a writer exit.
      jest.advanceTimersByTime(6_000);
      await flush();
      expect(mockFork).toHaveBeenCalledTimes(1);
      expect(getCodeGraphSourceBuildState('ws/failed-active')).toBe('queued');
      child(0).emit('exit', 1);
      await expect(repair).resolves.toMatchObject({
        ok: false,
        reason: 'worker-failed',
      });
      await flush();
      expect(mockFork).toHaveBeenCalledTimes(2);
      expect(first.attemptId).not.toBeNull();
      expect(second.attemptId).toBe(first.attemptId);
      expect(child(1).postMessage).toHaveBeenCalledWith(
        // mergeBuildOptions({}, {}) preserves the default derived build.
        expect.objectContaining({ options: { computeDerived: true } }),
      );
      child(1).emit('message', published());
      await expect(sourceOutcome).resolves.toEqual({
        values: [published(), published()],
      });
    },
  );
  it.each(['cancel', 'unavailable', 'teardown'])(
    '%s after repair protocol failure prevents the waiting source from starting',
    async (stop) => {
      mockCloseGate.resolve();
      const repair = requestCodeGraphSummaryRepair(input('stopped-active'));
      await flush();
      const source = beginCodeGraphWorkerBuild(
        'ws/stopped-active',
        requestFor('stopped-active'),
      );
      const second = beginCodeGraphWorkerBuild(
        'ws/stopped-active',
        requestFor('stopped-active'),
      );
      expect(second.promise).toBe(source.promise);
      const sourceOutcome = Promise.all([source.promise, second.promise]).then(
        (values) => ({ values }),
        (error: unknown) => ({ error }),
      );
      child(0).emit('message', { invalid: true });
      const cleanup =
        stop === 'teardown'
          ? killAllBuilds()
          : cancelBuild(
              'ws/stopped-active',
              stop === 'unavailable' ? { reason: 'unavailable' } : undefined,
            );
      await flush();
      expect(mockFork).toHaveBeenCalledTimes(1);
      child(0).emit('exit', 1);
      await cleanup;
      await repair;
      await flush();
      expect(mockFork).toHaveBeenCalledTimes(1);
      await expect(sourceOutcome).resolves.toMatchObject({
        error: { reason: stop === 'unavailable' ? 'unavailable' : 'canceled' },
      });
    },
  );
  it('holds the background slot through repair cancellation until the killed writer exits', async () => {
    mockCloseGate.resolve();
    const repair = requestCodeGraphSummaryRepair(input('held'));
    await flush();
    const background = beginCodeGraphWorkerBuild('after-held', request());
    const cleanup = cancelBuild('ws/held');
    await flush();
    expect(child(0).kill).toHaveBeenCalledTimes(1);
    expect(mockFork).toHaveBeenCalledTimes(1);
    child(0).emit('exit', 0);
    await cleanup;
    await flush();
    expect(mockFork).toHaveBeenCalledTimes(2);
    await expect(repair).resolves.toMatchObject({
      ok: false,
      reason: 'canceled',
    });
    child(1).emit('message', published());
    await background.promise;
  });
  it('gives a hidden eligible repair a turn after two background completions, never changing visible manual source order', async () => {
    const snapshots: string[][] = [];
    setCodeGraphGenerationQueueListener((snapshot) =>
      snapshots.push(snapshot.entries.map((entry) => entry.label ?? entry.id)),
    );
    const first = beginCodeGraphWorkerBuild('fair-1', request());
    const second = beginCodeGraphWorkerBuild('fair-2', request());
    const third = beginCodeGraphWorkerBuild('fair-3', request());
    mockCloseGate.resolve();
    const repair = requestCodeGraphSummaryRepair(input('fair'));
    await flush();
    expect(mockFork).toHaveBeenCalledTimes(1);
    expect(
      getCodeGraphGenerationQueueSnapshot().entries.some(
        (entry) => entry.label === 'fair',
      ),
    ).toBe(false);
    child(0).emit('message', published());
    await first.promise;
    child(1).emit('message', published());
    await second.promise;
    await flush();
    expect(child(2).postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'summary-repair' }),
    );
    expect(snapshots.flat()).not.toContain('fair');
    child(2).emit('message', {
      ok: true,
      result: { state: 'ready', projection },
    });
    child(2).emit('exit', 0);
    await repair;
    child(3).emit('message', published());
    await third.promise;
  });
  it('superseded repair failure cools down for five minutes; no caller-owned cancellation of another waiter', async () => {
    jest.useFakeTimers();
    mockCloseGate.resolve();
    const first = requestCodeGraphSummaryRepair(input('cooldown'));
    const second = requestCodeGraphSummaryRepair(input('cooldown'));
    await flush();
    child(0).emit('message', { ok: true, result: { state: 'superseded' } });
    child(0).emit('exit', 0);
    await expect(first).resolves.toMatchObject({
      ok: false,
      reason: 'superseded',
    });
    expect(second).toBe(first);
    await expect(
      requestCodeGraphSummaryRepair(input('cooldown')),
    ).resolves.toMatchObject({ ok: false, reason: 'cooldown' });
    jest.advanceTimersByTime(5 * 60 * 1000);
    mockRead.mockResolvedValue(readResponse(ready));
    await expect(
      requestCodeGraphSummaryRepair(input('cooldown')),
    ).resolves.toMatchObject({ ok: true, resolution: 'already-ready' });
    jest.useRealTimers();
  });
});
