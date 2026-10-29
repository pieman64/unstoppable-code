/**
 * Electron's `UtilityProcess.pid` is `undefined` until the child emits
 * `spawn`. The code-graph runners previously read `child.pid` synchronously
 * after `fork()`, so the priority adjustment never ran and installed builds
 * showed background graph workers at nice 0. These fakes model Electron's
 * contract: the pid only appears together with the `spawn` event.
 *
 * `jest.mocked(utilityProcess.fork)` references an electron-typed method as an
 * unbound value, which `@typescript-eslint/unbound-method` flags; the mock
 * never relies on `this`, so the rule is disabled for this file only (as in
 * `code-graph-build-runner.test.ts`).
 */
/* eslint-disable @typescript-eslint/unbound-method */
import type * as NodeEventsModule from 'node:events';

jest.mock('electron', () => {
  const { EventEmitter } =
    jest.requireActual<typeof NodeEventsModule>('node:events');
  class FakeUtilityProcess extends EventEmitter {
    public readonly postMessage = jest.fn();
    public readonly kill = jest.fn((): boolean => {
      setImmediate(() => this.emit('exit', 0));
      return true;
    });
    public pid: number | undefined = undefined;

    public spawnWithPid(pid: number): void {
      this.pid = pid;
      this.emit('spawn');
    }
  }
  return {
    __esModule: true,
    utilityProcess: {
      fork: jest.fn(() => new FakeUtilityProcess()),
    },
  };
});
jest.mock('../lib/code-graph-availability', () => ({
  getCodeGraphGenerationTimeoutMs: (): number => 60_000,
  isCodeGraphAvailableForWorkspace: (): boolean => true,
}));
jest.mock('../lib/git-executable', () => ({
  getResolvedGitExecutableForSpawn: (): Promise<string> =>
    Promise.resolve('/usr/bin/git'),
}));
const mockLowerSpawnedProcessPriority = jest.fn();
const mockLeaveBackgroundProcessPolicy = jest.fn();
jest.mock('../lib/background-process', () => ({
  leaveBackgroundProcessPolicy: (...args: unknown[]): unknown =>
    mockLeaveBackgroundProcessPolicy(...args),
  lowerSpawnedProcessPriority: (...args: unknown[]): unknown =>
    mockLowerSpawnedProcessPriority(...args),
}));

import { utilityProcess } from 'electron';
import {
  killAllBuilds,
  runCodeGraphWorkerBuild,
  type CodeGraphWorkerBuildRequest,
} from '../code-graph/build-runner';
import {
  resetCodeGraphFingerprintRunnerForTests,
  runCodeGraphWorkerFingerprint,
} from '../code-graph/fingerprint-runner';

interface SpawnableChild {
  spawnWithPid(pid: number): void;
  emit(event: string, ...args: unknown[]): boolean;
}

function isSpawnableChild(value: unknown): value is SpawnableChild {
  return (
    typeof value === 'object' &&
    value !== null &&
    'spawnWithPid' in value &&
    typeof value.spawnWithPid === 'function'
  );
}

function lastForkedChild(): SpawnableChild {
  const results = jest.mocked(utilityProcess.fork).mock.results;
  const child: unknown = results[results.length - 1]?.value;
  if (!isSpawnableChild(child)) {
    throw new Error('No utility process was forked.');
  }
  return child;
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

const request: CodeGraphWorkerBuildRequest = {
  dbPath: '/tmp/canopy-worker-priority/graph.db',
  worktreeRootPath: '/worktrees/stork',
  resourcesDir: '/resources/code-graph',
  repositories: [
    { repoId: '__workspace_root__', rootPath: '/worktrees/stork' },
  ],
  options: {},
};

describe('code-graph worker process priority', () => {
  beforeEach(() => {
    mockLowerSpawnedProcessPriority.mockReset();
    mockLeaveBackgroundProcessPolicy.mockReset();
    jest.mocked(utilityProcess.fork).mockClear();
  });

  afterEach(async () => {
    await killAllBuilds();
    resetCodeGraphFingerprintRunnerForTests();
  });

  it('backgrounds a maintenance build worker once Electron reports its pid', async () => {
    const pending = runCodeGraphWorkerBuild('canopy/maintenance', request, {
      priority: 'maintenance',
    });
    pending.catch(() => undefined);
    await flushAsyncWork();

    const child = lastForkedChild();
    expect(mockLowerSpawnedProcessPriority).not.toHaveBeenCalled();
    child.spawnWithPid(4101);

    expect(mockLowerSpawnedProcessPriority).toHaveBeenCalledWith(4101, {
      background: true,
    });
  });

  it('keeps an agent-requested build out of disk throttling', async () => {
    const pending = runCodeGraphWorkerBuild('canopy/agent', request, {
      priority: 'agent',
    });
    pending.catch(() => undefined);
    await flushAsyncWork();

    lastForkedChild().spawnWithPid(4102);

    expect(mockLowerSpawnedProcessPriority).toHaveBeenCalledWith(4102, {
      background: false,
    });
  });

  it('backgrounds a scheduler fingerprint worker once it spawns', async () => {
    const pending = runCodeGraphWorkerFingerprint('canopy/fingerprint', [
      { repoId: '__workspace_root__', rootPath: '/worktrees/stork' },
    ]);
    pending.catch(() => undefined);
    await flushAsyncWork();

    lastForkedChild().spawnWithPid(4103);

    expect(mockLowerSpawnedProcessPriority).toHaveBeenCalledWith(4103, {
      background: true,
    });
  });

  it('lifts the background policy when an agent starts waiting on a running build', async () => {
    const background = runCodeGraphWorkerBuild('canopy/promoted', request, {
      priority: 'worktree',
    });
    background.catch(() => undefined);
    await flushAsyncWork();
    lastForkedChild().spawnWithPid(4104);
    expect(mockLowerSpawnedProcessPriority).toHaveBeenCalledWith(4104, {
      background: true,
    });

    const agent = runCodeGraphWorkerBuild('canopy/promoted', request, {
      priority: 'agent',
    });
    agent.catch(() => undefined);

    expect(mockLeaveBackgroundProcessPolicy).toHaveBeenCalledWith(4104);
    expect(jest.mocked(utilityProcess.fork)).toHaveBeenCalledTimes(1);
  });

  it('lifts the background policy when a waiting caller joins a running fingerprint', async () => {
    const repositories = [
      { repoId: '__workspace_root__', rootPath: '/worktrees/stork' },
    ];
    const background = runCodeGraphWorkerFingerprint(
      'canopy/fingerprint-join',
      repositories,
    );
    background.catch(() => undefined);
    await flushAsyncWork();
    lastForkedChild().spawnWithPid(4105);

    const waiting = runCodeGraphWorkerFingerprint(
      'canopy/fingerprint-join',
      repositories,
      { background: false },
    );
    waiting.catch(() => undefined);

    expect(mockLeaveBackgroundProcessPolicy).toHaveBeenCalledWith(4105);
  });
});
