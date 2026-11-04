/*
 * `expect(child.postMessage).toHaveBeenCalled…` references electron-typed
 * methods (`postMessage`/`kill`/`fork`) as unbound values, which
 * `@typescript-eslint/unbound-method` flags. That is a false positive for
 * asserting on jest mocks — the mocks never rely on `this` — so the rule is
 * disabled for this test file only.
 */
/* eslint-disable @typescript-eslint/unbound-method */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, totalmem } from 'node:os';
import * as path from 'node:path';
import type * as NodeEventsModule from 'node:events';
import { DatabaseSync } from 'node:sqlite';

// The global electron mock (jest.config moduleNameMapper) has no
// `utilityProcess`; provide a controllable fake here. Each `fork` returns a
// fresh EventEmitter-backed fake so tests can drive `message`/`exit` events and
// assert `postMessage`/`kill` were called. The runner reads `utilityProcess`
// lazily (only inside a build), so importing it here is side-effect free.
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
  EXECUTION_HOST_LIMIT_EXIT_CODES,
  type ExecutionHostLaunchRequest,
} from '@canopy/core-platform/execution-host/port';
import { codeGraphHostBudget } from '@canopy/code-graph/host/budgets';
import {
  getExecutionHostPort,
  setExecutionHostPort,
} from '../execution-host/utility-process-host';
import { getExecutionAccounting } from '../execution-accounting';
import {
  CODE_GRAPH_FIRST_BUILD_OVERTAKE_LIMIT,
  CodeGraphWorkerBuildError,
  cancelBuild,
  codeGraphBuildConcurrencyCap,
  codeGraphBuildRunnerTestExports,
  getCodeGraphGenerationQueueSnapshot,
  isCodeGraphBuildPending,
  killAllBuilds,
  reconcileCodeGraphBuildAvailability,
  reorderCodeGraphGenerationQueue,
  runCodeGraphWorkerBuild,
  runCodeGraphWorkerEagerSeed,
  setCodeGraphBuildStatusListener,
  setCodeGraphGenerationQueueListener,
  type CodeGraphBuildPriority,
  type CodeGraphBuildSchedulingOptions,
  type CodeGraphBuildStatus,
  type CodeGraphWorkerBuildRequest,
  type CodeGraphWorkerBuildResponse,
  type CodeGraphWorkerEagerSeedRequest,
} from '../code-graph/build-runner';
import {
  codeGraphWorkerCpuProfileDirectory,
  executeCodeGraphBuild,
} from '../code-graph/build-worker';
import {
  getCodeGraphWorktreeService,
  resetCodeGraphWorktreeServiceForTests,
} from '@canopy/desktop-shared/node/code-graph/service';
import { getBundledCodeGraphDir } from '@canopy/desktop-shared/pipelines/config-paths';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import type { CodeGraphBuildResult } from '@canopy/desktop-shared/types/code-graph';
import { CodeGraphEngine } from '@canopy/code-graph/engine';
import { fingerprintCustomLanguageInputs } from '@canopy/code-graph/languages/custom-config';
import {
  resetCodeGraphAvailabilityForTests,
  setCodeGraphPreferences,
} from '../lib/code-graph-availability';

const forkMock = jest.mocked(utilityProcess.fork);

describe('code-graph build concurrency performance seam', () => {
  it('uses one worker only for the explicit E2E performance override', () => {
    const env = { CANOPY_PERFORMANCE_CODE_GRAPH_CONCURRENCY: '1' };
    expect(codeGraphBuildConcurrencyCap(true, env)).toBe(1);
    expect(codeGraphBuildConcurrencyCap(false, env)).toBe(2);
    expect(codeGraphBuildConcurrencyCap(true, {})).toBe(2);
  });
});

describe('code-graph worker CPU profile directory', () => {
  it('accepts an absolute harness-owned path only in E2E builds', () => {
    const env = {
      CANOPY_PERFORMANCE_UTILITY_CPU_PROFILE_DIR:
        '/tmp/canopy-perf/utility-cpu',
    };
    expect(codeGraphWorkerCpuProfileDirectory(true, env)).toBe(
      '/tmp/canopy-perf/utility-cpu',
    );
    expect(codeGraphWorkerCpuProfileDirectory(false, env)).toBeUndefined();
  });

  it('rejects missing, blank, and relative output paths', () => {
    expect(codeGraphWorkerCpuProfileDirectory(true, {})).toBeUndefined();
    expect(
      codeGraphWorkerCpuProfileDirectory(true, {
        CANOPY_PERFORMANCE_UTILITY_CPU_PROFILE_DIR: '   ',
      }),
    ).toBeUndefined();
    expect(
      codeGraphWorkerCpuProfileDirectory(true, {
        CANOPY_PERFORMANCE_UTILITY_CPU_PROFILE_DIR: 'utility-cpu',
      }),
    ).toBeUndefined();
  });
});

function makeRequest(
  overrides?: Partial<CodeGraphWorkerBuildRequest>,
): CodeGraphWorkerBuildRequest {
  return {
    dbPath: '/tmp/cg/graph.db',
    worktreeRootPath: '/tmp/cg',
    resourcesDir: '/res',
    repositories: [{ repoId: WORKSPACE_ROOT_REPO_ID, rootPath: '/tmp/cg' }],
    options: {},
    ...overrides,
  };
}

function sampleResult(): CodeGraphBuildResult {
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
    lastBuildAt: 1_800_000_000_000,
  };
}

function okResponse(): CodeGraphWorkerBuildResponse {
  return { ok: true, result: sampleResult() };
}

// Typed access to the fake child a given fork call returned. `.value` is the
// `UtilityProcess` return type, so `.emit`/`.postMessage`/`.kill` are all
// visible to the type-checker without any `as` casting.
function forkedChild(index: number): ReturnType<typeof utilityProcess.fork> {
  const result = forkMock.mock.results[index];
  if (result === undefined || result.type !== 'return') {
    throw new Error(`No forked worker at index ${index}`);
  }
  return result.value;
}

function runAgentBuild(
  key: string,
  request: CodeGraphWorkerBuildRequest,
): Promise<CodeGraphWorkerBuildResponse> {
  return runCodeGraphWorkerBuild(key, request, { priority: 'agent' });
}

describe('code-graph build runner (mocked utilityProcess)', () => {
  beforeEach(() => {
    // Most lifecycle tests care about ordering and concurrency, not wall-clock
    // pacing. Keep them synchronous; the dedicated yield test below restores
    // and verifies the production delay.
    codeGraphBuildRunnerTestExports.setBackgroundBuildInterTaskDelayMs(0);
  });

  afterEach(() => {
    // Reject/clear any leftover in-flight builds so runner state never leaks
    // between tests. killAllBuilds' synchronous body fully resets that state;
    // its returned exit-wait promise is intentionally NOT awaited here — the
    // fake children never emit 'exit' on kill(), so awaiting would burn the
    // bounded real-time fallthrough per test. Emitting 'exit' on every fake
    // child instead resolves any pending exit waits and clears their
    // fallback timers.
    void killAllBuilds();
    for (const result of forkMock.mock.results) {
      if (result.type === 'return') {
        result.value.emit('exit', 0);
      }
    }
    forkMock.mockClear();
    setCodeGraphBuildStatusListener(null);
    setCodeGraphGenerationQueueListener(null);
    resetCodeGraphAvailabilityForTests();
  });

  it('posts the request after wiring handlers and resolves with the worker response', async () => {
    const request = makeRequest();
    expect(isCodeGraphBuildPending('ws/wt')).toBe(false);
    const promise = runCodeGraphWorkerBuild('ws/wt', request);
    expect(isCodeGraphBuildPending('ws/wt')).toBe(true);
    const child = forkedChild(0);

    expect(forkMock).toHaveBeenCalledWith(
      expect.stringContaining('code-graph-build-worker'),
      [],
      expect.objectContaining({ serviceName: 'code-graph-build' }),
    );
    expect(child.postMessage).toHaveBeenCalledWith(request);

    const response = okResponse();
    child.emit('message', response);
    await expect(promise).resolves.toEqual(response);
    expect(isCodeGraphBuildPending('ws/wt')).toBe(false);
  });

  it('holds the execution lease until a host stopped at its heap limit exits', async () => {
    const accounting = getExecutionAccounting();
    const active = (): number => accounting.familyStatus().codeGraph.active;
    const before = active();
    const promise = runCodeGraphWorkerBuild('ws/limit', makeRequest());
    const child = forkedChild(0);
    expect(active()).toBe(before + 1);
    child.emit('exit', EXECUTION_HOST_LIMIT_EXIT_CODES.heap);
    await expect(promise).rejects.toMatchObject({ reason: 'worker-exit' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(active()).toBe(before);
  });

  it('launches each build host through getExecutionHostPort().launch with the build entry and budget', async () => {
    const utility = getExecutionHostPort();
    const launches: ExecutionHostLaunchRequest[] = [];
    setExecutionHostPort({
      probe: (probeRequest) => utility.probe(probeRequest),
      launch: (launchRequest) => {
        launches.push(launchRequest);
        return utility.launch(launchRequest);
      },
    });
    try {
      const promise = runCodeGraphWorkerBuild('ws/budget', makeRequest());
      expect(launches).toEqual([
        {
          entry: 'code-graph-build-worker.js',
          serviceName: 'code-graph-build',
          budget: codeGraphHostBudget('build', {
            totalMemoryBytes: totalmem(),
          }),
        },
      ]);
      forkedChild(0).emit('message', okResponse());
      await promise;
    } finally {
      setExecutionHostPort(undefined);
    }
  });

  it('stamps the queue wait into a build request that carries a timing prelude', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const first = runAgentBuild('queue-a', makeRequest({ dbPath: '/qa' }));
      const second = runAgentBuild('queue-b', makeRequest({ dbPath: '/qb' }));
      const request = makeRequest({
        dbPath: '/qc',
        timings: { fingerprintMs: 20, firstGraphRequestedAt: 900 },
      });
      const third = runAgentBuild('queue-c', request);
      // A failed assertion leaves these to teardown, which rejects them.
      second.catch(() => undefined);
      third.catch(() => undefined);
      expect(forkMock).toHaveBeenCalledTimes(2);

      nowSpy.mockReturnValue(1_450);
      forkedChild(0).emit('message', okResponse());
      await first;

      expect(forkMock).toHaveBeenCalledTimes(3);
      expect(forkedChild(2).postMessage).toHaveBeenCalledWith({
        ...request,
        timings: {
          fingerprintMs: 20,
          firstGraphRequestedAt: 900,
          queueWaitMs: 450,
        },
      });
      // Requests without a prelude keep their exact bytes.
      expect(forkedChild(1).postMessage).toHaveBeenCalledWith(
        makeRequest({ dbPath: '/qb' }),
      );
      forkedChild(1).emit('message', okResponse());
      forkedChild(2).emit('message', okResponse());
      await Promise.all([second, third]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('uses the dedicated bounded utility lane for eager seed-only requests', async () => {
    const request = {
      operation: 'eager-seed' as const,
      targetDbPath: '/tmp/cg/eager.db',
      repositories: [{ repoId: WORKSPACE_ROOT_REPO_ID, rootPath: '/tmp/cg' }],
      source: { kind: 'base-worktree' as const, dbPath: '/tmp/base/graph.db' },
    };
    const promise = runCodeGraphWorkerEagerSeed('ws/eager', request);
    const child = forkedChild(0);
    expect(child.postMessage).toHaveBeenCalledWith(request);
    const response = {
      ok: true as const,
      status: 'seeded' as const,
      source: 'base-worktree' as const,
      durationMs: 50,
    };
    child.emit('message', response);
    await expect(promise).resolves.toEqual(response);
  });

  it('starts one eager seed while both full-build slots are occupied', async () => {
    const buildA = runAgentBuild(
      'build-a',
      makeRequest({ dbPath: '/build-a' }),
    );
    const buildB = runAgentBuild(
      'build-b',
      makeRequest({ dbPath: '/build-b' }),
    );
    const makeSeedRequest = (
      targetDbPath: string,
    ): CodeGraphWorkerEagerSeedRequest => ({
      operation: 'eager-seed' as const,
      targetDbPath,
      repositories: [{ repoId: WORKSPACE_ROOT_REPO_ID, rootPath: '/tmp/cg' }],
      source: { kind: 'base-worktree' as const, dbPath: '/tmp/base/graph.db' },
    });
    const firstSeedRequest = makeSeedRequest('/seed-a');
    const secondSeedRequest = makeSeedRequest('/seed-b');
    const firstSeed = runCodeGraphWorkerEagerSeed('seed-a', firstSeedRequest);
    const secondSeed = runCodeGraphWorkerEagerSeed('seed-b', secondSeedRequest);

    expect(forkMock).toHaveBeenCalledTimes(3);
    expect(forkedChild(2).postMessage).toHaveBeenCalledWith(firstSeedRequest);

    const seedResponse = {
      ok: true as const,
      status: 'seeded' as const,
      source: 'base-worktree' as const,
      durationMs: 10,
    };
    forkedChild(2).emit('message', seedResponse);
    expect(forkMock).toHaveBeenCalledTimes(4);
    expect(forkedChild(3).postMessage).toHaveBeenCalledWith(secondSeedRequest);

    forkedChild(0).emit('message', okResponse());
    forkedChild(1).emit('message', okResponse());
    forkedChild(3).emit('message', seedResponse);
    await Promise.all([buildA, buildB, firstSeed, secondSeed]);
  });

  it('surfaces an ok:false worker response as a resolved value, not a rejection', async () => {
    const promise = runCodeGraphWorkerBuild('ws/wt', makeRequest());
    forkedChild(0).emit('message', { ok: false, message: 'boom' });
    await expect(promise).resolves.toEqual({ ok: false, message: 'boom' });
  });

  it('is single-flight per key: a second call for the same key returns the same promise', async () => {
    const request = makeRequest();
    const first = runCodeGraphWorkerBuild('ws/wt', request);
    const second = runCodeGraphWorkerBuild('ws/wt', request);
    expect(second).toBe(first);
    expect(forkMock).toHaveBeenCalledTimes(1);
    forkedChild(0).emit('message', okResponse());
    await Promise.all([first, second]);
  });

  it('serializes different operations for the same key without sharing response types', async () => {
    const buildRequest = makeRequest();
    const seedRequest: CodeGraphWorkerEagerSeedRequest = {
      operation: 'eager-seed',
      targetDbPath: buildRequest.dbPath,
      repositories: buildRequest.repositories,
      source: { kind: 'base-worktree', dbPath: '/tmp/base/graph.db' },
    };
    const build = runCodeGraphWorkerBuild('ws/wt', buildRequest);
    const seed = runCodeGraphWorkerEagerSeed('ws/wt', seedRequest);

    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(forkedChild(0).postMessage).toHaveBeenCalledWith(buildRequest);

    const buildResponse = okResponse();
    forkedChild(0).emit('message', buildResponse);
    await expect(build).resolves.toEqual(buildResponse);

    expect(forkMock).toHaveBeenCalledTimes(2);
    expect(forkedChild(1).postMessage).toHaveBeenCalledWith(seedRequest);
    const seedResponse = {
      ok: true as const,
      status: 'seeded' as const,
      source: 'base-worktree' as const,
      durationMs: 10,
    };
    forkedChild(1).emit('message', seedResponse);
    await expect(seed).resolves.toEqual(seedResponse);
  });

  it('does not resolve a full build with an in-flight eager-seed response', async () => {
    const buildRequest = makeRequest();
    const seedRequest: CodeGraphWorkerEagerSeedRequest = {
      operation: 'eager-seed',
      targetDbPath: buildRequest.dbPath,
      repositories: buildRequest.repositories,
      source: { kind: 'base-worktree', dbPath: '/tmp/base/graph.db' },
    };
    const seed = runCodeGraphWorkerEagerSeed('ws/wt', seedRequest);
    const build = runCodeGraphWorkerBuild('ws/wt', buildRequest);

    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(forkedChild(0).postMessage).toHaveBeenCalledWith(seedRequest);

    const seedResponse = {
      ok: true as const,
      status: 'seeded' as const,
      source: 'base-worktree' as const,
      durationMs: 10,
    };
    forkedChild(0).emit('message', seedResponse);
    await expect(seed).resolves.toEqual(seedResponse);

    expect(forkMock).toHaveBeenCalledTimes(2);
    expect(forkedChild(1).postMessage).toHaveBeenCalledWith(buildRequest);
    const buildResponse = okResponse();
    forkedChild(1).emit('message', buildResponse);
    await expect(build).resolves.toEqual(buildResponse);
  });

  it('caps concurrency at 2 and starts queued builds FIFO as slots free', async () => {
    const reqA = makeRequest({ dbPath: '/a' });
    const reqB = makeRequest({ dbPath: '/b' });
    const reqC = makeRequest({ dbPath: '/c' });
    const reqD = makeRequest({ dbPath: '/d' });

    const pA = runAgentBuild('a', reqA);
    const pB = runAgentBuild('b', reqB);
    const pC = runCodeGraphWorkerBuild('c', reqC);
    const pD = runCodeGraphWorkerBuild('d', reqD);

    // Only two workers spawn; c and d stay queued.
    expect(forkMock).toHaveBeenCalledTimes(2);
    expect(forkedChild(0).postMessage).toHaveBeenCalledWith(reqA);
    expect(forkedChild(1).postMessage).toHaveBeenCalledWith(reqB);

    // Freeing a's slot starts the head of the FIFO queue (c), not d.
    forkedChild(0).emit('message', okResponse());
    expect(forkMock).toHaveBeenCalledTimes(3);
    expect(forkedChild(2).postMessage).toHaveBeenCalledWith(reqC);

    // Freeing b's total slot does not start another background build while c
    // is still using the single background lane.
    forkedChild(1).emit('message', okResponse());
    expect(forkMock).toHaveBeenCalledTimes(3);

    forkedChild(2).emit('message', okResponse());
    expect(forkMock).toHaveBeenCalledTimes(4);
    expect(forkedChild(3).postMessage).toHaveBeenCalledWith(reqD);
    forkedChild(3).emit('message', okResponse());
    await Promise.all([pA, pB, pC, pD]);
  });

  it('serializes background builds while preserving the second slot for an agent build', async () => {
    const backgroundARequest = makeRequest({ dbPath: '/background-a' });
    const backgroundBRequest = makeRequest({ dbPath: '/background-b' });
    const agentRequest = makeRequest({ dbPath: '/agent' });
    const backgroundA = runCodeGraphWorkerBuild(
      'background-a',
      backgroundARequest,
      { priority: 'worktree' },
    );
    const backgroundB = runCodeGraphWorkerBuild(
      'background-b',
      backgroundBRequest,
      { priority: 'maintenance' },
    );

    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(forkedChild(0).postMessage).toHaveBeenCalledWith(backgroundARequest);

    const agent = runCodeGraphWorkerBuild('agent', agentRequest, {
      priority: 'agent',
    });
    expect(forkMock).toHaveBeenCalledTimes(2);
    expect(forkedChild(1).postMessage).toHaveBeenCalledWith(agentRequest);

    forkedChild(1).emit('message', okResponse());
    expect(forkMock).toHaveBeenCalledTimes(2);
    forkedChild(0).emit('message', okResponse());
    expect(forkMock).toHaveBeenCalledTimes(3);
    expect(forkedChild(2).postMessage).toHaveBeenCalledWith(backgroundBRequest);
    forkedChild(2).emit('message', okResponse());
    await Promise.all([backgroundA, backgroundB, agent]);
  });

  it('yields between background builds while letting an agent bypass the cooldown', async () => {
    jest.useFakeTimers();
    codeGraphBuildRunnerTestExports.setBackgroundBuildInterTaskDelayMs(
      codeGraphBuildRunnerTestExports.defaultBackgroundBuildInterTaskDelayMs,
    );
    const backgroundA = runCodeGraphWorkerBuild(
      'background-yield-a',
      makeRequest({ dbPath: '/background-yield-a' }),
    );
    const backgroundB = runCodeGraphWorkerBuild(
      'background-yield-b',
      makeRequest({ dbPath: '/background-yield-b' }),
    );
    // Keep teardown rejections observed when a deliberately red assertion
    // exits before the queued promise reaches the green-path await below.
    void backgroundB.catch(() => undefined);

    try {
      expect(forkMock).toHaveBeenCalledTimes(1);
      forkedChild(0).emit('message', okResponse());
      await expect(backgroundA).resolves.toEqual(okResponse());

      // Completing one automatic build must leave a macrotask gap before the
      // next utility starts instead of draining a large restored workspace as
      // an uninterrupted CPU train.
      expect(forkMock).toHaveBeenCalledTimes(1);

      const agent = runAgentBuild(
        'agent-during-background-yield',
        makeRequest({ dbPath: '/agent-during-background-yield' }),
      );
      expect(forkMock).toHaveBeenCalledTimes(2);
      expect(forkedChild(1).postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ dbPath: '/agent-during-background-yield' }),
      );

      await jest.advanceTimersByTimeAsync(499);
      expect(forkMock).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(1);
      expect(forkMock).toHaveBeenCalledTimes(3);
      expect(forkedChild(2).postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ dbPath: '/background-yield-b' }),
      );

      forkedChild(1).emit('message', okResponse());
      forkedChild(2).emit('message', okResponse());
      await Promise.all([backgroundB, agent]);
    } finally {
      codeGraphBuildRunnerTestExports.setBackgroundBuildInterTaskDelayMs(0);
      jest.useRealTimers();
    }
  });

  it('starts queued worktree builds before maintenance builds', async () => {
    const pA = runAgentBuild('a', makeRequest({ dbPath: '/a' }));
    const pB = runAgentBuild('b', makeRequest({ dbPath: '/b' }));
    const maintenance = runCodeGraphWorkerBuild(
      'base:maintenance',
      makeRequest({ dbPath: '/maintenance' }),
      { priority: 'maintenance' },
    );
    const worktree = runCodeGraphWorkerBuild(
      'workspace/worktree',
      makeRequest({ dbPath: '/worktree' }),
    );

    forkedChild(0).emit('message', okResponse());
    expect(forkedChild(2).postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ dbPath: '/worktree' }),
    );
    forkedChild(1).emit('message', okResponse());
    expect(forkMock).toHaveBeenCalledTimes(3);
    forkedChild(2).emit('message', okResponse());
    expect(forkedChild(3).postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ dbPath: '/maintenance' }),
    );

    forkedChild(3).emit('message', okResponse());
    await Promise.all([pA, pB, maintenance, worktree]);
  });

  it('moves a newly requested agent build to the front of the queue', async () => {
    const pA = runAgentBuild('a', makeRequest({ dbPath: '/a' }));
    const pB = runAgentBuild('b', makeRequest({ dbPath: '/b' }));
    const background = runCodeGraphWorkerBuild(
      'workspace/background',
      makeRequest({ dbPath: '/background' }),
    );
    const agent = runCodeGraphWorkerBuild(
      'workspace/agent',
      makeRequest({ dbPath: '/agent' }),
      { priority: 'agent' },
    );

    forkedChild(0).emit('message', okResponse());
    expect(forkedChild(2).postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ dbPath: '/agent' }),
    );
    forkedChild(1).emit('message', okResponse());
    expect(forkedChild(3).postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ dbPath: '/background' }),
    );

    forkedChild(2).emit('message', okResponse());
    forkedChild(3).emit('message', okResponse());
    await Promise.all([pA, pB, background, agent]);
  });

  it('promotes an existing queued single-flight build when an agent requests it', async () => {
    const pA = runAgentBuild('a', makeRequest({ dbPath: '/a' }));
    const pB = runAgentBuild('b', makeRequest({ dbPath: '/b' }));
    const targetRequest = makeRequest({ dbPath: '/target' });
    const target = runCodeGraphWorkerBuild('workspace/target', targetRequest);
    const other = runCodeGraphWorkerBuild(
      'workspace/other',
      makeRequest({ dbPath: '/other' }),
    );

    const promoted = runCodeGraphWorkerBuild(
      'workspace/target',
      targetRequest,
      { priority: 'agent' },
    );
    expect(promoted).toBe(target);

    forkedChild(0).emit('message', okResponse());
    expect(forkedChild(2).postMessage).toHaveBeenCalledWith(targetRequest);
    forkedChild(1).emit('message', okResponse());
    expect(forkedChild(3).postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ dbPath: '/other' }),
    );

    forkedChild(2).emit('message', okResponse());
    forkedChild(3).emit('message', okResponse());
    await Promise.all([pA, pB, target, promoted, other]);
  });

  it('upgrades a queued weaker build before an explicit verified request starts it', async () => {
    const pA = runAgentBuild('a', makeRequest({ dbPath: '/a' }));
    const pB = runAgentBuild('b', makeRequest({ dbPath: '/b' }));
    const weakRequest = makeRequest({
      dbPath: '/target',
      options: { computeDerived: false },
    });
    const verifiedRequest = makeRequest({
      dbPath: '/target',
      options: { verifyContent: true },
    });
    const target = runCodeGraphWorkerBuild('workspace/target', weakRequest);
    const verified = runCodeGraphWorkerBuild(
      'workspace/target',
      verifiedRequest,
      { priority: 'agent' },
    );

    expect(verified).toBe(target);
    forkedChild(0).emit('message', okResponse());
    expect(forkedChild(2).postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        options: {
          computeDerived: true,
          verifyContent: true,
        },
      }),
    );

    forkedChild(1).emit('message', okResponse());
    forkedChild(2).emit('message', okResponse());
    await Promise.all([pA, pB, target, verified]);
  });

  it('runs a stronger verified follow-up when the weaker build already started', async () => {
    const weakRequest = makeRequest({
      dbPath: '/target',
      options: { computeDerived: false },
    });
    const verifiedRequest = makeRequest({
      dbPath: '/target',
      options: { verifyContent: true },
    });
    const weak = runCodeGraphWorkerBuild('workspace/target', weakRequest);
    const verified = runCodeGraphWorkerBuild(
      'workspace/target',
      verifiedRequest,
      { priority: 'agent' },
    );
    void verified.catch(() => undefined);

    expect(verified).not.toBe(weak);
    expect(forkMock).toHaveBeenCalledTimes(1);
    forkedChild(0).emit('message', okResponse());
    await weak;
    expect(forkMock).toHaveBeenCalledTimes(2);
    expect(forkedChild(1).postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        options: { computeDerived: true, verifyContent: true },
      }),
    );

    forkedChild(1).emit('message', okResponse());
    await verified;
  });

  it('merges concurrent stronger requests into one forced follow-up', async () => {
    const weakRequest = makeRequest({
      dbPath: '/target',
      options: { computeDerived: false },
    });
    const verifiedRequest = makeRequest({
      dbPath: '/target',
      options: { verifyContent: true },
    });
    const forcedRequest = makeRequest({
      dbPath: '/target',
      options: { forceReparse: true },
    });
    const weak = runCodeGraphWorkerBuild('workspace/target', weakRequest);
    const verified = runCodeGraphWorkerBuild(
      'workspace/target',
      verifiedRequest,
      { priority: 'agent' },
    );
    const forced = runCodeGraphWorkerBuild('workspace/target', forcedRequest, {
      priority: 'agent',
    });
    void verified.catch(() => undefined);
    void forced.catch(() => undefined);

    expect(forced).toBe(verified);
    expect(forkMock).toHaveBeenCalledTimes(1);
    forkedChild(0).emit('message', okResponse());
    await weak;
    expect(forkMock).toHaveBeenCalledTimes(2);
    expect(forkedChild(1).postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        options: {
          computeDerived: true,
          forceReparse: true,
          verifyContent: true,
        },
      }),
    );

    forkedChild(1).emit('message', okResponse());
    await Promise.all([verified, forced]);
    expect(forkMock).toHaveBeenCalledTimes(2);
  });

  it('starts a queued background build immediately when an agent promotes it', async () => {
    const runningRequest = makeRequest({ dbPath: '/running-background' });
    const targetRequest = makeRequest({ dbPath: '/promoted-background' });
    const running = runCodeGraphWorkerBuild(
      'workspace/running-background',
      runningRequest,
    );
    const target = runCodeGraphWorkerBuild(
      'workspace/promoted-background',
      targetRequest,
    );
    // Keep teardown rejections observed when the deliberately red assertion
    // exits before the green-path await below.
    void running.catch(() => undefined);
    void target.catch(() => undefined);

    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(forkedChild(0).postMessage).toHaveBeenCalledWith(runningRequest);

    const promoted = runCodeGraphWorkerBuild(
      'workspace/promoted-background',
      targetRequest,
      { priority: 'agent' },
    );

    expect(promoted).toBe(target);
    expect(forkMock).toHaveBeenCalledTimes(2);
    expect(forkedChild(1).postMessage).toHaveBeenCalledWith(targetRequest);

    forkedChild(0).emit('message', okResponse());
    forkedChild(1).emit('message', okResponse());
    await Promise.all([running, target, promoted]);
  });

  it('preserves manual queue order when an agent coalesces with a queued build', async () => {
    const pA = runAgentBuild('a', makeRequest({ dbPath: '/a' }));
    const pB = runAgentBuild('b', makeRequest({ dbPath: '/b' }));
    const targetRequest = makeRequest({ dbPath: '/target' });
    const target = runCodeGraphWorkerBuild('target', targetRequest);
    const otherRequest = makeRequest({ dbPath: '/other' });
    const other = runCodeGraphWorkerBuild('other', otherRequest);
    const before = getCodeGraphGenerationQueueSnapshot();
    const queuedIds = before.entries
      .filter((entry) => entry.status === 'queued')
      .map((entry) => entry.id);
    reorderCodeGraphGenerationQueue({
      revision: before.revision,
      orderedQueuedEntryIds: queuedIds.reverse(),
    });

    const coalesced = runCodeGraphWorkerBuild('target', targetRequest, {
      priority: 'agent',
    });
    expect(coalesced).toBe(target);

    forkedChild(0).emit('message', okResponse());
    expect(forkedChild(2).postMessage).toHaveBeenCalledWith(otherRequest);
    forkedChild(1).emit('message', okResponse());
    expect(forkedChild(3).postMessage).toHaveBeenCalledWith(targetRequest);

    forkedChild(2).emit('message', okResponse());
    forkedChild(3).emit('message', okResponse());
    await Promise.all([pA, pB, target, coalesced, other]);
  });

  it('publishes safe queue metadata and dispatches the exact user-reordered order', async () => {
    const snapshots: ReturnType<typeof getCodeGraphGenerationQueueSnapshot>[] =
      [];
    setCodeGraphGenerationQueueListener((snapshot) => snapshots.push(snapshot));
    const pA = runAgentBuild('a', makeRequest({ dbPath: '/a' }));
    const pB = runAgentBuild('b', makeRequest({ dbPath: '/b' }));
    const maintenance = runCodeGraphWorkerBuild(
      'private-base-key',
      makeRequest({ dbPath: '/private/shadow/graph.db' }),
      {
        priority: 'maintenance',
        metadata: {
          scope: 'workspace-shadow',
          workspaceIds: ['workspace-a', 'workspace-b'],
          repositoryId: 'repo-a',
          label: 'Repository A',
          trigger: 'shadow-maintenance',
        },
      },
    );
    const worktree = runCodeGraphWorkerBuild(
      'private-worktree-key',
      makeRequest({ dbPath: '/private/worktree/graph.db' }),
      {
        priority: 'worktree',
        metadata: {
          scope: 'worktree',
          workspaceIds: ['workspace-c'],
          workspaceLabel: 'Project C',
          worktreeId: 'worktree-c',
          label: 'Feature branch',
          trigger: 'manual',
        },
      },
    );

    const before = getCodeGraphGenerationQueueSnapshot();
    const queued = before.entries.filter((entry) => entry.status === 'queued');
    expect(queued.map((entry) => entry.scope)).toEqual([
      'worktree',
      'workspace-shadow',
    ]);
    expect(JSON.stringify(before)).not.toContain('/private/');
    expect(queued[1]).toMatchObject({
      workspaceIds: ['workspace-a', 'workspace-b'],
      repositoryId: 'repo-a',
      label: 'Repository A',
      reorderable: true,
    });
    expect(queued[0]).toMatchObject({
      workspaceIds: ['workspace-c'],
      workspaceLabel: 'Project C',
      worktreeId: 'worktree-c',
      label: 'Feature branch',
    });

    const reordered = reorderCodeGraphGenerationQueue({
      revision: before.revision,
      orderedQueuedEntryIds: queued.map((entry) => entry.id).reverse(),
    });
    expect('ok' in reordered ? reordered.ok : true).not.toBe(false);
    expect(getCodeGraphGenerationQueueSnapshot().revision).toBeGreaterThan(
      before.revision,
    );

    forkedChild(0).emit('message', okResponse());
    expect(forkedChild(2).postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ dbPath: '/private/shadow/graph.db' }),
    );
    forkedChild(1).emit('message', okResponse());
    expect(forkMock).toHaveBeenCalledTimes(3);
    forkedChild(2).emit('message', okResponse());
    expect(forkedChild(3).postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ dbPath: '/private/worktree/graph.db' }),
    );
    forkedChild(3).emit('message', okResponse());
    await Promise.all([pA, pB, maintenance, worktree]);
    expect(snapshots.length).toBeGreaterThan(4);
  });

  it('appends later arrivals after a manual reorder and restores default priority after the queue drains', async () => {
    const pA = runAgentBuild('a', makeRequest({ dbPath: '/a' }));
    const pB = runAgentBuild('b', makeRequest({ dbPath: '/b' }));
    const maintenance = runCodeGraphWorkerBuild(
      'maintenance',
      makeRequest({ dbPath: '/maintenance' }),
      { priority: 'maintenance' },
    );
    const worktree = runCodeGraphWorkerBuild(
      'worktree',
      makeRequest({ dbPath: '/worktree' }),
    );
    const before = getCodeGraphGenerationQueueSnapshot();
    const queued = before.entries.filter((entry) => entry.status === 'queued');
    expect(queued.map((entry) => entry.scope)).toEqual([
      'worktree',
      'workspace-shadow',
    ]);
    reorderCodeGraphGenerationQueue({
      revision: before.revision,
      orderedQueuedEntryIds: queued.map((entry) => entry.id).reverse(),
    });

    const later = runCodeGraphWorkerBuild(
      'later-worktree',
      makeRequest({ dbPath: '/later-worktree' }),
    );
    expect(
      getCodeGraphGenerationQueueSnapshot()
        .entries.filter((entry) => entry.status === 'queued')
        .map((entry) => entry.scope),
    ).toEqual(['workspace-shadow', 'worktree', 'worktree']);

    forkedChild(0).emit('message', okResponse());
    forkedChild(1).emit('message', okResponse());
    forkedChild(2).emit('message', okResponse());
    expect(forkMock).toHaveBeenCalledTimes(4);
    forkedChild(3).emit('message', okResponse());
    expect(forkMock).toHaveBeenCalledTimes(5);

    const nextMaintenance = runCodeGraphWorkerBuild(
      'next-maintenance',
      makeRequest({ dbPath: '/next-maintenance' }),
      { priority: 'maintenance' },
    );
    const nextWorktree = runCodeGraphWorkerBuild(
      'next-worktree',
      makeRequest({ dbPath: '/next-worktree' }),
    );
    expect(
      getCodeGraphGenerationQueueSnapshot()
        .entries.filter((entry) => entry.status === 'queued')
        .map((entry) => entry.scope),
    ).toEqual(['worktree', 'workspace-shadow']);

    forkedChild(4).emit('message', okResponse());
    forkedChild(5).emit('message', okResponse());
    forkedChild(6).emit('message', okResponse());
    await Promise.all([
      pA,
      pB,
      maintenance,
      worktree,
      later,
      nextMaintenance,
      nextWorktree,
    ]);
  });

  it('rejects every coalesced waiter as unavailable when its running project is disabled', async () => {
    const first = runCodeGraphWorkerBuild(
      'workspace-a/worktree-a',
      makeRequest(),
      {
        metadata: {
          scope: 'worktree',
          workspaceIds: ['workspace-a'],
          worktreeId: 'worktree-a',
          trigger: 'tool-request',
        },
      },
    );
    const second = runCodeGraphWorkerBuild(
      'workspace-a/worktree-a',
      makeRequest(),
      {
        metadata: {
          scope: 'worktree',
          workspaceIds: ['workspace-a'],
          worktreeId: 'worktree-a',
          trigger: 'manual',
        },
      },
    );
    expect(second).toBe(first);
    const firstRejection = first.catch((error: unknown) => error);
    const secondRejection = second.catch((error: unknown) => error);

    const reconciliation = reconcileCodeGraphBuildAvailability(() => false);
    expect(forkedChild(0).kill).toHaveBeenCalledTimes(1);
    forkedChild(0).emit('exit', 0);
    await reconciliation;

    await expect(firstRejection).resolves.toMatchObject({
      reason: 'unavailable',
    });
    await expect(secondRejection).resolves.toMatchObject({
      reason: 'unavailable',
    });
  });

  it('rejects stale/invalid reorders and removes unavailable owners reference-safely', async () => {
    const pA = runAgentBuild('a', makeRequest());
    const pB = runAgentBuild('b', makeRequest());
    const shared = runCodeGraphWorkerBuild('shared', makeRequest(), {
      priority: 'maintenance',
      metadata: {
        scope: 'workspace-shadow',
        workspaceIds: ['workspace-a', 'workspace-b'],
        repositoryId: 'repo-a',
        trigger: 'shadow-maintenance',
      },
    });
    const sharedRejection = shared.catch((error: unknown) => error);
    const snapshot = getCodeGraphGenerationQueueSnapshot();
    const runningEntryId = snapshot.entries[0]?.id ?? '';
    const sharedEntryId =
      snapshot.entries[snapshot.entries.length - 1]?.id ?? '';
    expect(
      reorderCodeGraphGenerationQueue({
        revision: snapshot.revision - 1,
        orderedQueuedEntryIds: snapshot.entries
          .filter((entry) => entry.status === 'queued')
          .map((entry) => entry.id),
      }),
    ).toMatchObject({ ok: false, code: 'conflict' });
    expect(
      reorderCodeGraphGenerationQueue({
        revision: snapshot.revision,
        orderedQueuedEntryIds: [],
      }),
    ).toMatchObject({ ok: false, code: 'invalid-request' });
    expect(
      reorderCodeGraphGenerationQueue({
        revision: snapshot.revision,
        orderedQueuedEntryIds: [runningEntryId, sharedEntryId],
      }),
    ).toMatchObject({ ok: false, code: 'invalid-request' });

    await reconcileCodeGraphBuildAvailability(
      (workspaceId) => workspaceId === 'workspace-b',
    );
    expect(
      getCodeGraphGenerationQueueSnapshot().entries.find(
        (entry) => entry.id === sharedEntryId,
      )?.workspaceIds,
    ).toEqual(['workspace-b']);
    await reconcileCodeGraphBuildAvailability(() => false);
    await expect(sharedRejection).resolves.toMatchObject({
      reason: 'unavailable',
    });
    forkedChild(0).emit('message', okResponse());
    forkedChild(1).emit('message', okResponse());
    await Promise.all([pA, pB]);
  });

  it('kills the worker and rejects with a timeout error when the default 30-minute watchdog fires', async () => {
    jest.useFakeTimers();
    try {
      const promise = runCodeGraphWorkerBuild('ws/wt', makeRequest());
      const rejection = promise.catch((error: unknown) => error);
      const child = forkedChild(0);

      await jest.advanceTimersByTimeAsync(30 * 60 * 1000);

      expect(child.kill).toHaveBeenCalled();
      child.emit('exit', 0);
      const error = await rejection;
      expect(error).toBeInstanceOf(CodeGraphWorkerBuildError);
      expect(error).toMatchObject({ reason: 'timeout' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('ignores a worker response after the watchdog commits a timeout', async () => {
    jest.useFakeTimers();
    try {
      const promise = runCodeGraphWorkerBuild('ws/wt', makeRequest());
      const rejection = promise.catch((error: unknown) => error);
      const child = forkedChild(0);
      let settled = false;
      void promise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await jest.advanceTimersByTimeAsync(30 * 60 * 1000);
      child.emit('message', okResponse());
      await Promise.resolve();

      expect(settled).toBe(false);
      child.emit('exit', 0);
      await expect(rejection).resolves.toMatchObject({ reason: 'timeout' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not fire the watchdog once the worker has responded', async () => {
    jest.useFakeTimers();
    try {
      const promise = runCodeGraphWorkerBuild('ws/wt', makeRequest());
      const child = forkedChild(0);
      child.emit('message', okResponse());
      await expect(promise).resolves.toEqual(okResponse());
      await jest.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('captures the latest timeout when a queued worker starts without changing a running deadline', async () => {
    jest.useFakeTimers();
    try {
      setCodeGraphPreferences({
        mode: 'enabled',
        selectedWorkspaceIds: [],
        generationTimeoutMinutes: 2,
      });
      const running = runAgentBuild('running', makeRequest());
      const runningRejection = running.catch((error: unknown) => error);
      const blocker = runAgentBuild('blocker', makeRequest());
      const queued = runCodeGraphWorkerBuild('queued', makeRequest());
      const queuedRejection = queued.catch((error: unknown) => error);

      setCodeGraphPreferences({
        mode: 'enabled',
        selectedWorkspaceIds: [],
        generationTimeoutMinutes: 1,
      });
      forkedChild(1).emit('message', okResponse());
      await blocker;
      expect(forkMock).toHaveBeenCalledTimes(3);

      await jest.advanceTimersByTimeAsync(60_000);
      expect(forkedChild(0).kill).not.toHaveBeenCalled();
      expect(forkedChild(2).kill).toHaveBeenCalled();
      forkedChild(2).emit('exit', 0);
      await expect(queuedRejection).resolves.toMatchObject({
        reason: 'timeout',
      });

      await jest.advanceTimersByTimeAsync(60_000);
      expect(forkedChild(0).kill).toHaveBeenCalled();
      forkedChild(0).emit('exit', 0);
      await expect(runningRejection).resolves.toMatchObject({
        reason: 'timeout',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancelBuild kills the worker and rejects the in-flight build as canceled', async () => {
    const promise = runCodeGraphWorkerBuild('ws/wt', makeRequest());
    const rejection = promise.catch((error: unknown) => error);
    const child = forkedChild(0);

    void cancelBuild('ws/wt');

    expect(child.kill).toHaveBeenCalled();
    const error = await rejection;
    expect(error).toBeInstanceOf(CodeGraphWorkerBuildError);
    expect(error).toMatchObject({ reason: 'canceled' });
  });

  it('cancelBuild resolves only after the killed worker exits, not at kill time', async () => {
    const promise = runCodeGraphWorkerBuild('ws/wt', makeRequest());
    const rejection = promise.catch((error: unknown) => error);
    const child = forkedChild(0);

    let cancelSettled = false;
    const cancelPromise = cancelBuild('ws/wt').then(() => {
      cancelSettled = true;
    });

    // The record settles (kill issued, build promise rejected) synchronously…
    expect(child.kill).toHaveBeenCalled();
    await expect(rejection).resolves.toMatchObject({ reason: 'canceled' });
    // …but the returned cancel promise must stay pending until the worker
    // has actually exited and released its fds (the cleanup invariant).
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelSettled).toBe(false);

    child.emit('exit', 0);
    await cancelPromise;
    expect(cancelSettled).toBe(true);
  });

  it('cancelBuild falls through after a bounded wait when the killed worker never exits', async () => {
    jest.useFakeTimers();
    try {
      const promise = runCodeGraphWorkerBuild('ws/wt', makeRequest());
      const rejection = promise.catch((error: unknown) => error);
      const cancelPromise = cancelBuild('ws/wt');
      await expect(rejection).resolves.toMatchObject({ reason: 'canceled' });

      // Zombie worker: never emits 'exit'. The bounded fallthrough must
      // resolve the cancel anyway so cleanup/quit can never hang on it.
      await jest.advanceTimersByTimeAsync(5_000);
      await expect(cancelPromise).resolves.toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a repeat cancelBuild returns the still-pending exit wait from an earlier fire-and-forget cancel', async () => {
    const promise = runCodeGraphWorkerBuild('ws/wt', makeRequest());
    const rejection = promise.catch((error: unknown) => error);
    const child = forkedChild(0);

    // The production sequence in worktree cleanup: the scheduler's composed
    // cancel fires and DISCARDS its exit wait (killing the worker and
    // deleting its record synchronously)…
    void cancelBuild('ws/wt');
    await expect(rejection).resolves.toMatchObject({ reason: 'canceled' });

    // …then cleanup's own direct awaited cancel for the same key one line
    // later must still block until the killed worker exits — NOT resolve
    // vacuously just because the record is already gone.
    let repeatSettled = false;
    const repeat = cancelBuild('ws/wt').then(() => {
      repeatSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(repeatSettled).toBe(false);

    child.emit('exit', 0);
    await repeat;
    expect(repeatSettled).toBe(true);
  });

  it('a repeat cancelBuild falls through on the bounded wait when the earlier-killed worker never exits', async () => {
    jest.useFakeTimers();
    try {
      const promise = runCodeGraphWorkerBuild('ws/wt', makeRequest());
      const rejection = promise.catch((error: unknown) => error);
      void cancelBuild('ws/wt');
      await expect(rejection).resolves.toMatchObject({ reason: 'canceled' });

      const repeat = cancelBuild('ws/wt');
      await jest.advanceTimersByTimeAsync(5_000);
      await expect(repeat).resolves.toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a cancelBuild arriving after a watchdog kill waits for the dying worker to exit', async () => {
    jest.useFakeTimers();
    try {
      const promise = runCodeGraphWorkerBuild('ws/wt', makeRequest());
      const rejection = promise.catch((error: unknown) => error);
      const child = forkedChild(0);

      // The default watchdog fires after 30 minutes. It kills immediately but
      // retains the slot and waiter until the child exits (or the bounded exit
      // wait elapses).
      await jest.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(child.kill).toHaveBeenCalled();

      // Cleanup arriving during that exit wait shares it and must not replace
      // the typed timeout with a generic cancellation.
      let cancelSettled = false;
      const cancelPromise = cancelBuild('ws/wt').then(() => {
        cancelSettled = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(cancelSettled).toBe(false);

      child.emit('exit', 0);
      await expect(rejection).resolves.toMatchObject({ reason: 'timeout' });
      await cancelPromise;
      expect(cancelSettled).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('killAllBuilds folds in exit waits from earlier cancels whose workers have not exited', async () => {
    const promise = runCodeGraphWorkerBuild('ws/wt', makeRequest());
    const rejection = promise.catch((error: unknown) => error);
    const child = forkedChild(0);
    void cancelBuild('ws/wt');
    await expect(rejection).resolves.toMatchObject({ reason: 'canceled' });

    let killSettled = false;
    const killPromise = killAllBuilds().then(() => {
      killSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(killSettled).toBe(false);

    child.emit('exit', 0);
    await killPromise;
    expect(killSettled).toBe(true);
  });

  it('cancelBuild rejects a still-queued build without spawning it, resolving immediately', async () => {
    const pA = runAgentBuild('a', makeRequest());
    const pB = runAgentBuild('b', makeRequest());
    const pC = runCodeGraphWorkerBuild('c', makeRequest());
    const rejectionC = pC.catch((error: unknown) => error);
    expect(forkMock).toHaveBeenCalledTimes(2);

    // A queued-only record has no child process, so the cancel promise
    // resolves without waiting on any exit event.
    await expect(cancelBuild('c')).resolves.toBeUndefined();
    const error = await rejectionC;
    expect(error).toMatchObject({ reason: 'canceled' });

    // Cancelling a queued build must not have spawned it, and must not have
    // stolen the freed slot — a and b are still the only running workers.
    expect(forkMock).toHaveBeenCalledTimes(2);

    forkedChild(0).emit('message', okResponse());
    forkedChild(1).emit('message', okResponse());
    await Promise.all([pA, pB]);
  });

  it('cancelBuild is a no-op for an unknown key, resolving immediately', async () => {
    await expect(cancelBuild('unknown-key')).resolves.toBeUndefined();
  });

  it('killAllBuilds kills running workers, rejects every build, and resolves once the workers exit', async () => {
    const pA = runAgentBuild('a', makeRequest());
    const pB = runAgentBuild('b', makeRequest());
    const pC = runCodeGraphWorkerBuild('c', makeRequest());
    const rejections = [pA, pB, pC].map((promise) =>
      promise.catch((error: unknown) => error),
    );

    let killSettled = false;
    const killPromise = killAllBuilds().then(() => {
      killSettled = true;
    });

    expect(forkedChild(0).kill).toHaveBeenCalled();
    expect(forkedChild(1).kill).toHaveBeenCalled();
    const errors = await Promise.all(rejections);
    for (const error of errors) {
      expect(error).toBeInstanceOf(CodeGraphWorkerBuildError);
      expect(error).toMatchObject({ reason: 'canceled' });
    }

    // Same awaitable contract as cancelBuild: pending until every killed
    // worker has exited (the queued build c never spawned, so it contributes
    // no exit wait).
    await Promise.resolve();
    await Promise.resolve();
    expect(killSettled).toBe(false);
    forkedChild(0).emit('exit', 0);
    forkedChild(1).emit('exit', 0);
    await killPromise;
    expect(killSettled).toBe(true);

    // State is fully reset: a brand-new build spawns cleanly from a fresh queue.
    forkMock.mockClear();
    const fresh = runCodeGraphWorkerBuild('a', makeRequest());
    expect(forkMock).toHaveBeenCalledTimes(1);
    forkedChild(0).emit('message', okResponse());
    await expect(fresh).resolves.toEqual(okResponse());
  });

  it('rejects with a worker-exit error when the worker exits before responding', async () => {
    const promise = runCodeGraphWorkerBuild('ws/wt', makeRequest());
    const rejection = promise.catch((error: unknown) => error);
    forkedChild(0).emit('exit', 1);
    const error = await rejection;
    expect(error).toBeInstanceOf(CodeGraphWorkerBuildError);
    expect(error).toMatchObject({ reason: 'worker-exit' });
  });

  it('rejects with a malformed-response error when the worker posts a bad message', async () => {
    const promise = runCodeGraphWorkerBuild('ws/wt', makeRequest());
    const rejection = promise.catch((error: unknown) => error);
    forkedChild(0).emit('message', { not: 'a response' });
    const error = await rejection;
    expect(error).toBeInstanceOf(CodeGraphWorkerBuildError);
    expect(error).toMatchObject({ reason: 'malformed-response' });
  });

  it('rejects with a spawn-failed error when forking the worker throws', async () => {
    forkMock.mockImplementationOnce(() => {
      throw new Error('fork exploded');
    });
    const promise = runCodeGraphWorkerBuild('ws/wt', makeRequest());
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CodeGraphWorkerBuildError);
    expect(error).toMatchObject({ reason: 'spawn-failed' });
  });
});

describe('code-graph build runner first-build precedence', () => {
  beforeEach(() => {
    codeGraphBuildRunnerTestExports.setBackgroundBuildInterTaskDelayMs(0);
  });

  afterEach(() => {
    void killAllBuilds();
    for (const result of forkMock.mock.results) {
      if (result.type === 'return') {
        result.value.emit('exit', 0);
      }
    }
    forkMock.mockClear();
    resetCodeGraphAvailabilityForTests();
  });

  function scheduled(
    priority: CodeGraphBuildPriority,
    key: string,
  ): CodeGraphBuildSchedulingOptions {
    return {
      priority,
      metadata: {
        scope: priority === 'maintenance' ? 'workspace-shadow' : 'worktree',
        workspaceIds: [],
        label: key,
        trigger: 'test',
      },
    };
  }

  function build(
    key: string,
    priority: CodeGraphBuildPriority,
    options: CodeGraphWorkerBuildRequest['options'] = {},
  ): Promise<CodeGraphWorkerBuildResponse> {
    const promise = runCodeGraphWorkerBuild(
      key,
      makeRequest({ dbPath: `/${key}`, options }),
      scheduled(priority, key),
    );
    // Teardown rejects whatever a test leaves queued.
    promise.catch(() => undefined);
    return promise;
  }

  function queuedLabels(): Array<string | undefined> {
    return getCodeGraphGenerationQueueSnapshot()
      .entries.filter((entry) => entry.status === 'queued')
      .map((entry) => entry.label);
  }

  function dispatchedDbPaths(): string[] {
    return forkMock.mock.results.map((result) => {
      if (result.type !== 'return') throw new Error('fork threw');
      const request: unknown = jest.mocked(result.value.postMessage).mock
        .calls[0]?.[0];
      if (
        typeof request !== 'object' ||
        request === null ||
        !('dbPath' in request) ||
        typeof request.dbPath !== 'string'
      ) {
        throw new Error('fork without a build request');
      }
      return request.dbPath;
    });
  }

  function lastDispatchedDbPath(): string | undefined {
    const paths = dispatchedDbPaths();
    return paths[paths.length - 1];
  }

  /** Completes the running worker that received `dbPath`. */
  function complete(dbPath: string): void {
    const index = dispatchedDbPaths().indexOf(dbPath);
    forkedChild(index).emit('message', okResponse());
  }

  async function flushChains(): Promise<void> {
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  }

  it('orders queued work agent, then first-build, then refresh, then maintenance', async () => {
    void build('running-refresh', 'worktree');
    void build('running-agent', 'agent');
    expect(forkMock).toHaveBeenCalledTimes(2);

    void build('refresh', 'worktree');
    void build('maintenance', 'maintenance');
    void build('first', 'first-build');
    void build('agent', 'agent');
    expect(queuedLabels()).toEqual([
      'agent',
      'first',
      'refresh',
      'maintenance',
    ]);

    complete('/running-agent');
    expect(lastDispatchedDbPath()).toBe('/agent');
    complete('/running-refresh');
    expect(lastDispatchedDbPath()).toBe('/first');
    complete('/first');
    expect(lastDispatchedDbPath()).toBe('/refresh');
    complete('/refresh');
    expect(lastDispatchedDbPath()).toBe('/maintenance');
    complete('/maintenance');
    complete('/agent');
    await flushChains();
  });

  it(`ages a queued refresh so at most ${CODE_GRAPH_FIRST_BUILD_OVERTAKE_LIMIT} first builds pass it`, async () => {
    expect(CODE_GRAPH_FIRST_BUILD_OVERTAKE_LIMIT).toBe(3);
    void build('running', 'worktree');
    void build('refresh', 'worktree');
    for (let index = 1; index <= 5; index += 1) {
      void build(`first-${index}`, 'first-build');
    }
    // A refresh queued later than the first builds has not been passed yet.
    void build('late-refresh', 'worktree');
    expect(queuedLabels()).toEqual([
      'first-1',
      'first-2',
      'first-3',
      'refresh',
      'first-4',
      'first-5',
      'late-refresh',
    ]);

    complete('/running');
    for (const next of [
      'first-1',
      'first-2',
      'first-3',
      'refresh',
      'first-4',
      'first-5',
      'late-refresh',
    ]) {
      expect(lastDispatchedDbPath()).toBe(`/${next}`);
      // Only the single background slot is ever used.
      expect(getCodeGraphGenerationQueueSnapshot().entries[0]).toMatchObject({
        status: 'running',
        label: next,
      });
      complete(`/${next}`);
    }
    await flushChains();
  });

  it('keeps one background slot and never preempts a running refresh', async () => {
    void build('running', 'worktree');
    void build('first', 'first-build');
    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(forkedChild(0).kill).not.toHaveBeenCalled();
    expect(
      getCodeGraphGenerationQueueSnapshot().entries.map((entry) => [
        entry.label,
        entry.status,
      ]),
    ).toEqual([
      ['running', 'running'],
      ['first', 'queued'],
    ]);

    complete('/running');
    expect(forkMock).toHaveBeenCalledTimes(2);
    expect(dispatchedDbPaths()[1]).toBe('/first');
    complete('/first');
    await flushChains();
  });

  it('re-places a queued refresh as a first build when its key has no graph', async () => {
    void build('running', 'worktree');
    void build('other', 'worktree');
    const queuedRefresh = build('target', 'worktree');
    expect(queuedLabels()).toEqual(['other', 'target']);

    expect(build('target', 'first-build')).toBe(queuedRefresh);
    expect(queuedLabels()).toEqual(['target', 'other']);
    complete('/running');
    expect(lastDispatchedDbPath()).toBe('/target');
    complete('/target');
    complete('/other');
    await flushChains();
  });

  it('never moves a refresh later, or ages others, when it is re-placed as a first build', () => {
    void build('running', 'worktree');
    void build('target', 'worktree');
    for (let index = 1; index <= 5; index += 1) {
      void build(`first-${index}`, 'first-build');
    }
    void build('late-refresh', 'worktree');
    // Aging already put the refresh ahead of the last two first builds.
    expect(queuedLabels()).toEqual([
      'first-1',
      'first-2',
      'first-3',
      'target',
      'first-4',
      'first-5',
      'late-refresh',
    ]);

    void build('target', 'first-build');
    expect(queuedLabels()).toEqual([
      'first-1',
      'first-2',
      'first-3',
      'target',
      'first-4',
      'first-5',
      'late-refresh',
    ]);
    // The late refresh was not passed again, so three more first builds can
    // still go ahead of it.
    for (let index = 6; index <= 9; index += 1) {
      void build(`first-${index}`, 'first-build');
    }
    expect(queuedLabels().slice(-3)).toEqual([
      'first-8',
      'late-refresh',
      'first-9',
    ]);
  });

  describe('a worktree whose graph becomes published moves to ordinary priority', () => {
    function seedRequest(key: string): CodeGraphWorkerEagerSeedRequest {
      return {
        operation: 'eager-seed',
        targetDbPath: `/${key}`,
        repositories: [{ repoId: WORKSPACE_ROOT_REPO_ID, rootPath: '/tmp/cg' }],
        source: { kind: 'base-worktree', dbPath: '/tmp/base/graph.db' },
      };
    }

    it.each([
      ['seeded', ['refresh-1', 'refresh-2', 'target']],
      ['existing', ['refresh-1', 'refresh-2', 'target']],
      ['no-compatible-source', ['target', 'refresh-1', 'refresh-2']],
    ] as const)(
      'after an eager seed that resolves %s',
      async (status, expectedQueue) => {
        void build('running', 'worktree');
        void build('refresh-1', 'worktree');
        void build('refresh-2', 'worktree');
        const seed = runCodeGraphWorkerEagerSeed(
          'target',
          seedRequest('target'),
        );
        // The first build for the same key waits for the seed to settle.
        const firstBuild = build('target', 'first-build');
        expect(queuedLabels()).toEqual(['refresh-1', 'refresh-2']);

        forkedChild(1).emit('message', {
          ok: true,
          status,
          durationMs: 5,
        });
        await seed;
        await flushChains();
        expect(queuedLabels()).toEqual(expectedQueue);
        void firstBuild;
      },
    );

    it('for a stronger follow-up of a first build that succeeded', async () => {
      void build('first', 'first-build');
      void build('refresh-1', 'worktree');
      void build('refresh-2', 'worktree');
      const followUp = build('first', 'worktree', { verifyContent: true });
      complete('/first');
      await flushChains();
      // refresh-1 took the freed slot; the follow-up is an ordinary refresh.
      expect(lastDispatchedDbPath()).toBe('/refresh-1');
      expect(queuedLabels()).toEqual(['refresh-2', 'first']);
      void followUp;
    });

    it('but a failed first build keeps its follow-up a first build', async () => {
      void build('first', 'first-build');
      void build('refresh-1', 'worktree');
      void build('refresh-2', 'worktree');
      const followUp = build('first', 'worktree', { verifyContent: true });
      forkedChild(0).emit('message', { ok: false, message: 'parse failed' });
      await flushChains();
      expect(lastDispatchedDbPath()).toBe('/refresh-1');
      expect(queuedLabels()).toEqual(['first', 'refresh-2']);
      void followUp;
    });
  });
});

describe('code-graph build runner status broadcast', () => {
  afterEach(() => {
    void killAllBuilds();
    for (const result of forkMock.mock.results) {
      if (result.type === 'return') {
        result.value.emit('exit', 0);
      }
    }
    forkMock.mockClear();
    setCodeGraphBuildStatusListener(null);
  });

  function trackEvents(): Array<[string, CodeGraphBuildStatus]> {
    const events: Array<[string, CodeGraphBuildStatus]> = [];
    setCodeGraphBuildStatusListener((key, status) => {
      events.push([key, status]);
    });
    return events;
  }

  it('emits building when the worker actually forks, and idle once the build resolves', async () => {
    const events = trackEvents();
    const promise = runCodeGraphWorkerBuild('ws/wt', makeRequest());
    expect(events).toEqual([['ws/wt', 'building']]);

    forkedChild(0).emit('message', okResponse());
    await promise;
    expect(events).toEqual([
      ['ws/wt', 'building'],
      ['ws/wt', 'idle'],
    ]);
  });

  it('single-flight coalescing: a second call for the same key emits building only once', async () => {
    const events = trackEvents();
    const first = runCodeGraphWorkerBuild('ws/wt', makeRequest());
    const second = runCodeGraphWorkerBuild('ws/wt', makeRequest());
    expect(second).toBe(first);
    expect(events).toEqual([['ws/wt', 'building']]);

    forkedChild(0).emit('message', okResponse());
    await Promise.all([first, second]);
    // Both callers settle off the SAME record, so 'idle' fires exactly once
    // too — never a spurious second building/idle pair for the coalesced call.
    expect(events).toEqual([
      ['ws/wt', 'building'],
      ['ws/wt', 'idle'],
    ]);
  });

  it('a queued build only emits building once it actually starts (not on enqueue)', async () => {
    const events = trackEvents();
    const pA = runAgentBuild('a', makeRequest());
    const pB = runAgentBuild('b', makeRequest());
    // c is queued behind the concurrency cap — no 'building' for it yet.
    const pC = runCodeGraphWorkerBuild('c', makeRequest());
    expect(events).toEqual([
      ['a', 'building'],
      ['b', 'building'],
    ]);

    forkedChild(0).emit('message', okResponse());
    // Freeing a's slot starts c — NOW c emits building.
    expect(events).toEqual([
      ['a', 'building'],
      ['b', 'building'],
      ['a', 'idle'],
      ['c', 'building'],
    ]);

    forkedChild(1).emit('message', okResponse());
    forkedChild(2).emit('message', okResponse());
    await Promise.all([pA, pB, pC]);
  });

  it('canceling a still-queued build never emits building for it, but still emits idle', async () => {
    const events = trackEvents();
    const pA = runAgentBuild('a', makeRequest());
    const pB = runAgentBuild('b', makeRequest());
    const pC = runCodeGraphWorkerBuild('c', makeRequest());
    const rejectionC = pC.catch((error: unknown) => error);
    expect(events).toEqual([
      ['a', 'building'],
      ['b', 'building'],
    ]);

    await cancelBuild('c');
    await rejectionC;
    // c never started (it was canceled while still queued), so it never
    // emitted 'building' — but its terminal settle still emits 'idle', the
    // same "no running build and nothing queued for this key" signal any
    // other terminal path produces.
    expect(events).toEqual([
      ['a', 'building'],
      ['b', 'building'],
      ['c', 'idle'],
    ]);

    forkedChild(0).emit('message', okResponse());
    forkedChild(1).emit('message', okResponse());
    await Promise.all([pA, pB]);
  });

  it('a watchdog timeout still emits idle like any other terminal transition', async () => {
    jest.useFakeTimers();
    try {
      const events = trackEvents();
      const promise = runCodeGraphWorkerBuild('ws/wt', makeRequest());
      const rejection = promise.catch((error: unknown) => error);
      expect(events).toEqual([['ws/wt', 'building']]);

      await jest.advanceTimersByTimeAsync(30 * 60 * 1000);
      forkedChild(0).emit('exit', 0);
      await rejection;
      expect(events).toEqual([
        ['ws/wt', 'building'],
        ['ws/wt', 'idle'],
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a rebuild for the same key after settling emits a fresh building/idle pair', async () => {
    const events = trackEvents();
    const first = runCodeGraphWorkerBuild('ws/wt', makeRequest());
    forkedChild(0).emit('message', okResponse());
    await first;

    const second = runCodeGraphWorkerBuild('ws/wt', makeRequest());
    forkedChild(1).emit('message', okResponse());
    await second;

    expect(events).toEqual([
      ['ws/wt', 'building'],
      ['ws/wt', 'idle'],
      ['ws/wt', 'building'],
      ['ws/wt', 'idle'],
    ]);
  });

  it('a throwing listener never breaks the build', async () => {
    setCodeGraphBuildStatusListener(() => {
      throw new Error('listener exploded');
    });
    const promise = runCodeGraphWorkerBuild('ws/wt', makeRequest());
    forkedChild(0).emit('message', okResponse());
    await expect(promise).resolves.toEqual(okResponse());
  });
});

const LIB = `export function doWork(): number {
  return 42;
}
`;
const MAIN = `import { doWork } from './lib';

export function run(): number {
  return doWork();
}
`;
const TEST = `import { doWork } from '../lib';

function checksDoWork(): void {
  doWork();
}
checksDoWork();
`;

// Response-shape parity: the worker's exported handler must produce the exact
// same counts as the real production path (`service.buildOrUpdate`) building
// the same fixture. Runs the REAL engine in-process (no fork) against a tmp
// repo — the honest end-to-end check that the request → engine → response
// wiring is faithful.
describe('executeCodeGraphBuild (real engine, in-process parity)', () => {
  let root: string;
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'cg-worker-fixture-'));
    mkdirSync(path.join(root, 'src', '__tests__'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'lib.ts'), LIB);
    writeFileSync(path.join(root, 'src', 'main.ts'), MAIN);
    writeFileSync(path.join(root, 'src', '__tests__', 'lib.test.ts'), TEST);

    dataDir = mkdtempSync(path.join(tmpdir(), 'cg-worker-data-'));
    previousDataDir = process.env.CANOPY_DATA_DIR;
    process.env.CANOPY_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    await resetCodeGraphWorktreeServiceForTests();
    if (previousDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = previousDataDir;
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('matches a direct service.buildOrUpdate on the same fixture', async () => {
    const repositories = [{ repoId: WORKSPACE_ROOT_REPO_ID, rootPath: root }];

    // A — the real production path (service-owned engine + db under the data dir).
    const service = getCodeGraphWorktreeService();
    const direct = await service.buildOrUpdate({
      workspaceId: 'ws',
      worktreeId: 'wt',
      repositories,
      worktreeRootPath: root,
    });

    // B — the worker's exported handler, with every path resolved by the
    // caller (exactly as main will resolve them before forking).
    const response = await executeCodeGraphBuild({
      dbPath: path.join(dataDir, 'worker', 'graph.db'),
      worktreeRootPath: root,
      resourcesDir: getBundledCodeGraphDir(),
      repositories,
      options: {},
    });

    expect(response.ok).toBe(true);
    if (!response.ok) {
      throw new Error(`worker build failed: ${response.message}`);
    }

    const stableCounts = (
      result: CodeGraphBuildResult,
    ): Record<string, number> => ({
      filesScanned: result.filesScanned,
      filesParsed: result.filesParsed,
      filesUnchanged: result.filesUnchanged,
      filesSkipped: result.filesSkipped,
      filesRemoved: result.filesRemoved,
      parseFailures: result.parseFailures,
      symbolCount: result.symbolCount,
      edgeCount: result.edgeCount,
    });

    expect(stableCounts(response.result)).toEqual(stableCounts(direct));
    expect(response.result.filesParsed).toBe(3);
  });

  it('seeds only an incomplete target, then incrementally reuses the completed graph', async () => {
    const repoId = WORKSPACE_ROOT_REPO_ID;
    const repositories = [{ repoId, rootPath: root }];
    const fingerprint = (await fingerprintCustomLanguageInputs(root)).value;
    const baseDbPath = path.join(dataDir, 'base', 'graph.db');
    const baseEngine = await CodeGraphEngine.open({
      dbPath: baseDbPath,
      repositories,
      worktreeRootPath: root,
      resourcesDir: getBundledCodeGraphDir(),
    });
    try {
      await baseEngine.buildOrUpdate();
    } finally {
      baseEngine.close();
    }
    const baseDb = new DatabaseSync(baseDbPath);
    baseDb
      .prepare(
        "INSERT INTO graph_metadata (key, value) VALUES ('base_canonical_repo_root', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(root);
    baseDb.close();

    const targetDbPath = path.join(dataDir, 'target', 'graph.db');
    const firstSeedStaging = path.join(dataDir, 'seed-first');
    mkdirSync(firstSeedStaging, { recursive: true });
    const copiedBase = path.join(firstSeedStaging, 'base.db');
    copyFileSync(baseDbPath, copiedBase);
    const first = await executeCodeGraphBuild({
      dbPath: targetDbPath,
      worktreeRootPath: root,
      resourcesDir: getBundledCodeGraphDir(),
      repositories,
      options: {},
      preparation: {
        seedSources: [
          {
            dbPath: copiedBase,
            repoId,
            canonicalRepoRoot: root,
            destinationRootPath: root,
            generationId: 'generation-a',
            gitHead: null,
          },
        ],
        coldFallbacks: [],
        customLanguagesFingerprint: fingerprint,
        seedStagingDir: firstSeedStaging,
      },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      throw new Error(first.message);
    }
    expect(first.seedOutcomes).toEqual([
      expect.objectContaining({ repoId, status: 'seeded' }),
    ]);
    expect(first.result.filesParsed).toBe(0);
    expect(existsSync(firstSeedStaging)).toBe(false);

    writeFileSync(
      path.join(root, 'src', 'lib.ts'),
      'export function doWork(): number { return 84; }\n',
    );
    const secondSeedStaging = path.join(dataDir, 'seed-second');
    mkdirSync(secondSeedStaging, { recursive: true });
    const second = await executeCodeGraphBuild({
      dbPath: targetDbPath,
      worktreeRootPath: root,
      resourcesDir: getBundledCodeGraphDir(),
      repositories,
      options: {},
      preparation: {
        seedSources: [],
        coldFallbacks: [],
        customLanguagesFingerprint: fingerprint,
        seedStagingDir: secondSeedStaging,
      },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      throw new Error(second.message);
    }
    expect(second.seedOutcomes).toEqual([
      { repoId, status: 'existing-graph-reused' },
    ]);
    expect(second.result.filesParsed).toBe(1);
    expect(existsSync(secondSeedStaging)).toBe(false);
  });
});
