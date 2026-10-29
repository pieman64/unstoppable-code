/*
 * Phase 20 (G6): a worktree build that defers derived analysis answers its
 * caller as soon as the graph is published (`derivedPending`), then keeps
 * its worker, key and slot while it finishes derived analysis (the drain).
 * The drain never piles up or blocks the key: a later build for the same
 * key supersedes it (kill, wait for exit, then start), several such builds
 * coalesce into one, and cleanup still cancels and awaits the worker.
 */
/* eslint-disable @typescript-eslint/unbound-method */
import type * as NodeEventsModule from 'node:events';

jest.mock('electron', () => {
  const { EventEmitter } =
    jest.requireActual<typeof NodeEventsModule>('node:events');
  class FakeUtilityProcess extends EventEmitter {
    public readonly postMessage = jest.fn();
    public readonly kill = jest.fn(() => true);
    public readonly pid = 4242;
  }
  return {
    __esModule: true,
    utilityProcess: {
      fork: jest.fn(() => new FakeUtilityProcess()),
    },
  };
});

import { utilityProcess } from 'electron';
import {
  cancelBuild,
  codeGraphBuildRunnerTestExports,
  getCodeGraphGenerationQueueSnapshot,
  getCodeGraphSourceBuildState,
  isCodeGraphBuildPending,
  killAllBuilds,
  runCodeGraphWorkerBuild,
  runCodeGraphWorkerEagerSeed,
  setCodeGraphBuildStatusListener,
  type CodeGraphBuildStatus,
  type CodeGraphWorkerBuildRequest,
  type CodeGraphWorkerBuildResponse,
} from '../code-graph/build-runner';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import type { CodeGraphBuildResult } from '@canopy/desktop-shared/types/code-graph';
import { resetCodeGraphAvailabilityForTests } from '../lib/code-graph-availability';

const forkMock = jest.mocked(utilityProcess.fork);

function request(dbPath = '/tmp/cg/graph.db'): CodeGraphWorkerBuildRequest {
  return {
    dbPath,
    worktreeRootPath: '/tmp/cg',
    resourcesDir: '/res',
    repositories: [{ repoId: WORKSPACE_ROOT_REPO_ID, rootPath: '/tmp/cg' }],
    options: {},
    deferDerived: true,
  };
}

function result(): CodeGraphBuildResult {
  return {
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
    derivedDeferred: true,
  };
}

function published(): CodeGraphWorkerBuildResponse {
  return { ok: true, result: result(), derivedPending: true };
}

const SEED_REQUEST = {
  operation: 'eager-seed',
  targetDbPath: '/tmp/cg/graph.db',
  repositories: [{ repoId: WORKSPACE_ROOT_REPO_ID, rootPath: '/tmp/cg' }],
  source: { kind: 'base-worktree', dbPath: '/base.db' },
} as const;

const DERIVED_COMPLETE = {
  kind: 'derived-complete',
  ok: true,
  ran: true,
  derived: [],
  derivedMs: 3,
  diagnosticsMs: 1,
} as const;

function forkedChild(index: number): ReturnType<typeof utilityProcess.fork> {
  const forked = forkMock.mock.results[index];
  if (forked === undefined || forked.type !== 'return') {
    throw new Error(`No forked worker at index ${index}`);
  }
  return forked.value;
}

/**
 * Keeps a build promise observed: teardown rejects whatever is still in
 * flight, and an assertion failure must not turn that into an unhandled
 * rejection that hides the failure.
 */
function observed<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

describe('code-graph build runner deferred derived drain', () => {
  beforeEach(() => {
    codeGraphBuildRunnerTestExports.setBackgroundBuildInterTaskDelayMs(0);
  });

  afterEach(() => {
    void killAllBuilds();
    for (const forked of forkMock.mock.results) {
      if (forked.type === 'return') forked.value.emit('exit', 0);
    }
    forkMock.mockClear();
    setCodeGraphBuildStatusListener(null);
    resetCodeGraphAvailabilityForTests();
  });

  it('answers the caller at publication and keeps the key, slot and worker until derived analysis completes', async () => {
    const statuses: CodeGraphBuildStatus[] = [];
    setCodeGraphBuildStatusListener((_key, status) => statuses.push(status));
    const build = observed(runCodeGraphWorkerBuild('ws/wt', request()));
    const child = forkedChild(0);

    child.emit('message', published());
    await expect(build).resolves.toEqual(published());
    expect(isCodeGraphBuildPending('ws/wt')).toBe(true);
    expect(getCodeGraphGenerationQueueSnapshot().entries).toEqual([
      expect.objectContaining({ status: 'running' }),
    ]);
    // Source facts are published, while derived analysis still owns the key
    // and slot. Frozen R16 separates source UI state from scheduler pending.
    expect(statuses).toEqual(['building', 'idle']);
    expect(getCodeGraphSourceBuildState('ws/wt')).toBe('idle');

    // The drain holds the single background slot: another worktree waits.
    const other = observed(
      runCodeGraphWorkerBuild('ws/other', request('/other.db')),
    );
    expect(forkMock).toHaveBeenCalledTimes(1);

    child.emit('message', DERIVED_COMPLETE);
    expect(isCodeGraphBuildPending('ws/wt')).toBe(false);
    expect(statuses).toEqual(['building', 'idle', 'building']);
    expect(child.kill).not.toHaveBeenCalled();
    expect(forkMock).toHaveBeenCalledTimes(2);
    forkedChild(1).emit('message', { ok: true, result: result() });
    await other;
  });

  it('lets a same-key build supersede the drain: it kills the worker, waits for its exit, then starts', async () => {
    const first = observed(runCodeGraphWorkerBuild('ws/wt', request()));
    forkedChild(0).emit('message', published());
    await first;

    const second = observed(runCodeGraphWorkerBuild('ws/wt', request()));
    expect(forkedChild(0).kill).toHaveBeenCalledTimes(1);
    await flush();
    // The superseded worker may still hold the database: no new writer yet.
    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(isCodeGraphBuildPending('ws/wt')).toBe(true);

    forkedChild(0).emit('exit', 0);
    await flush();
    expect(forkMock).toHaveBeenCalledTimes(2);
    expect(forkedChild(1).postMessage).toHaveBeenCalledWith(request());
    forkedChild(1).emit('message', published());
    await expect(second).resolves.toEqual(published());
  });

  it('coalesces every build requested during one drain into one superseding build', async () => {
    const first = observed(runCodeGraphWorkerBuild('ws/wt', request()));
    forkedChild(0).emit('message', published());
    await first;

    const second = observed(runCodeGraphWorkerBuild('ws/wt', request()));
    const third = observed(runCodeGraphWorkerBuild('ws/wt', request()));
    forkedChild(0).emit('exit', 0);
    await flush();
    const fourth = observed(runCodeGraphWorkerBuild('ws/wt', request()));
    expect(forkMock).toHaveBeenCalledTimes(2);

    forkedChild(1).emit('message', published());
    const responses = await Promise.all([second, third, fourth]);
    expect(responses).toEqual([published(), published(), published()]);
    expect(forkMock).toHaveBeenCalledTimes(2);
  });

  it('lets an eager seed wait for the drain instead of superseding it', async () => {
    const build = observed(runCodeGraphWorkerBuild('ws/wt', request()));
    forkedChild(0).emit('message', published());
    await build;

    const seed = observed(
      runCodeGraphWorkerEagerSeed('ws/wt', {
        operation: 'eager-seed',
        targetDbPath: '/tmp/cg/graph.db',
        repositories: [{ repoId: WORKSPACE_ROOT_REPO_ID, rootPath: '/tmp/cg' }],
        source: { kind: 'base-worktree', dbPath: '/base.db' },
      }),
    );
    await flush();
    expect(forkedChild(0).kill).not.toHaveBeenCalled();
    expect(forkMock).toHaveBeenCalledTimes(1);

    forkedChild(0).emit('message', DERIVED_COMPLETE);
    await flush();
    // The drained worker still holds the database until it exits.
    expect(forkMock).toHaveBeenCalledTimes(1);
    forkedChild(0).emit('exit', 0);
    await flush();
    expect(forkMock).toHaveBeenCalledTimes(2);
    forkedChild(1).emit('message', {
      ok: true,
      status: 'existing',
      durationMs: 1,
    });
    await expect(seed).resolves.toMatchObject({ status: 'existing' });
  });

  it.each([
    ['worktree cleanup cancels', (): Promise<void> => cancelBuild('ws/wt')],
    ['app teardown kills', (): Promise<void> => killAllBuilds()],
  ] as const)(
    'starts no eager seed that waited on a drain %s',
    async (_label, stop) => {
      const build = observed(runCodeGraphWorkerBuild('ws/wt', request()));
      forkedChild(0).emit('message', published());
      await build;
      const seed = observed(runCodeGraphWorkerEagerSeed('ws/wt', SEED_REQUEST));
      await flush();

      const stopped = stop();
      forkedChild(0).emit('exit', 0);
      await stopped;
      await flush();

      expect(forkMock).toHaveBeenCalledTimes(1);
      await expect(seed).rejects.toMatchObject({ reason: 'canceled' });
    },
  );

  it('cancels a draining worker and waits for its exit, as cleanup requires', async () => {
    const build = observed(runCodeGraphWorkerBuild('ws/wt', request()));
    const child = forkedChild(0);
    child.emit('message', published());
    await build;

    let canceled = false;
    const cancellation = cancelBuild('ws/wt').then(() => {
      canceled = true;
    });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(isCodeGraphBuildPending('ws/wt')).toBe(false);
    await flush();
    expect(canceled).toBe(false);

    child.emit('exit', 0);
    await cancellation;
    expect(canceled).toBe(true);
  });

  it('finalizes a drain whose worker exits without reporting, leaving the published answer intact', async () => {
    const build = observed(runCodeGraphWorkerBuild('ws/wt', request()));
    forkedChild(0).emit('message', published());
    await expect(build).resolves.toEqual(published());

    forkedChild(0).emit('exit', 1);
    expect(isCodeGraphBuildPending('ws/wt')).toBe(false);
    await expect(build).resolves.toEqual(published());
  });

  it('treats a derived completion outside a drain as a malformed response', async () => {
    const build = observed(runCodeGraphWorkerBuild('ws/wt', request()));
    forkedChild(0).emit('message', DERIVED_COMPLETE);
    await expect(build).rejects.toMatchObject({ reason: 'malformed-response' });
  });
});
