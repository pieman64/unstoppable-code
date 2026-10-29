jest.mock('../lib/paths', () => ({
  getWorktreeDataDir: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/worktree-data/${worktreeId}`,
  ),
  getWorktreeDir: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/worktrees/${worktreeId}`,
  ),
}));
jest.mock('../lib/script-resolver', () => ({
  getResolvedScriptDefinition: jest.fn(),
  resolveProjectScripts: jest.fn(() => Promise.resolve({})),
}));
jest.mock('../lib/workspace-persistence', () => ({
  getWorkspaceWorktreeCreatedAt: jest.fn(() =>
    Promise.resolve('2026-07-11T00:00:00.000Z'),
  ),
  isWorkspaceWorktreeCurrent: jest.fn(() => Promise.resolve(true)),
}));
jest.mock('../ipc/worktree-discovery', () => ({
  triggerDiscovery: jest.fn(),
}));
jest.mock('../lib/code-graph-scheduler', () => ({
  scheduleCodeGraphBuild: jest.fn(),
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(() => Promise.resolve(null)),
}));
jest.mock('../lib/script-runner', () => ({
  runShellScript: jest.fn(),
}));
jest.mock('../lib/script-log-store', () => ({
  appendScriptRunLogLines: jest.fn(() => Promise.resolve()),
  completeScriptRunLog: jest.fn(() => Promise.resolve()),
  startScriptRunLog: jest.fn(() => Promise.resolve(null)),
}));
jest.mock('../lib/script-events', () => ({
  createProjectScriptDescriptor: jest.fn(
    (
      scriptName: string,
      command: string,
      devServerPattern?: unknown,
      shell?: unknown,
      interactive?: boolean,
    ) => ({
      scriptKey: `project:${scriptName}`,
      scriptName,
      label: scriptName,
      command,
      lifecycle: scriptName,
      target: 'project',
      ...(devServerPattern !== undefined ? { devServerPattern } : {}),
      ...(shell !== undefined ? { shell } : {}),
      ...(interactive === true ? { interactive: true } : {}),
    }),
  ),
  createScriptCompleteEvent: jest.fn(),
  createScriptOutputEvent: jest.fn(),
  createScriptStartedEvent: jest.fn(),
}));
jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));

import { scheduleCodeGraphBuild } from '../lib/code-graph-scheduler';
import { triggerDiscovery } from '../ipc/worktree-discovery';
import { getResolvedScriptDefinition } from '../lib/script-resolver';
import { runShellScript } from '../lib/script-runner';
import { isWorkspaceWorktreeCurrent } from '../lib/workspace-persistence';
import {
  runProjectWorktreePostCreateSetup,
  startProjectWorktreePostCreateSetup,
} from '../lib/project-worktree-runtime';
import {
  resetWorkspaceTargetExclusionsForTests,
  withWorkspaceTargetArchiveDrain,
} from '../lib/workspace-target-exclusion';

const mockedGetResolvedScriptDefinition = jest.mocked(
  getResolvedScriptDefinition,
);
const mockedIsWorkspaceWorktreeCurrent = jest.mocked(
  isWorkspaceWorktreeCurrent,
);
const mockedTriggerDiscovery = jest.mocked(triggerDiscovery);
const mockedScheduleCodeGraphBuild = jest.mocked(scheduleCodeGraphBuild);
const mockedRunShellScript = jest.mocked(runShellScript);

function flushTurns(turns = 5): Promise<void> {
  let chain = Promise.resolve();
  for (let turn = 0; turn < turns; turn += 1) {
    chain = chain.then(
      () => new Promise<void>((resolve) => setImmediate(resolve)),
    );
  }
  return chain;
}

function holdSetupScript(): {
  release: () => void;
  fail: (error: Error) => void;
} {
  const held: { release: () => void; fail: (error: Error) => void } = {
    release: (): void => undefined,
    fail: (): void => undefined,
  };
  mockedGetResolvedScriptDefinition.mockReturnValue({
    command: 'npm install',
  });
  mockedRunShellScript.mockImplementationOnce(
    () =>
      new Promise((resolve, reject) => {
        held.release = (): void =>
          resolve({
            success: true,
            exitCode: 0,
            output: '',
            timedOut: false,
            durationMs: 25,
          });
        held.fail = reject;
      }),
  );
  return held;
}

/** Wraps the starter's return so a void (untrackable) return reads as settled. */
function observeSettlement(started: Promise<void> | void): {
  readonly settled: boolean;
  readonly rejected: boolean;
  done: Promise<void>;
} {
  const state = { settled: false, rejected: false, done: Promise.resolve() };
  state.done = Promise.resolve(started).then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
      state.rejected = true;
    },
  );
  return state;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetWorkspaceTargetExclusionsForTests();
  mockedGetResolvedScriptDefinition.mockReturnValue(undefined);
  mockedIsWorkspaceWorktreeCurrent.mockResolvedValue(true);
  mockedRunShellScript.mockResolvedValue({
    success: true,
    exitCode: 0,
    output: '',
    timedOut: false,
    durationMs: 25,
  });
});

describe('runProjectWorktreePostCreateSetup', () => {
  it('runs automatic setup below the app process priority', async () => {
    mockedGetResolvedScriptDefinition.mockReturnValue({
      command: 'npm install',
      interactive: true,
    });

    const result = await runProjectWorktreePostCreateSetup({
      projectId: 'test-project',
      worktreeId: 'test-animal',
      project: { repoPath: '/repo', scripts: {} },
      getWindow: () => null,
    });

    expect(result).toEqual({ status: 'completed' });
    const runOptions = mockedRunShellScript.mock.calls[0]?.[0];
    expect(runOptions?.script).toBe('npm install');
    expect(runOptions?.backgroundPriority).toBe(true);
    expect(runOptions?.interactive).toBe(true);
    expect(runOptions?.timeoutSeconds).toBeNull();
    expect(runOptions?.tracking?.script?.interactive).toBe(true);
  });

  it('schedules discovery and graph build when the worktree is still current', async () => {
    const result = await runProjectWorktreePostCreateSetup({
      projectId: 'test-project',
      worktreeId: 'test-animal',
      project: { repoPath: '/repo', scripts: {} },
      getWindow: () => null,
    });

    expect(result).toEqual({ status: 'skipped' });
    expect(mockedTriggerDiscovery).toHaveBeenCalledWith(
      'test-project',
      'test-animal',
      expect.any(Function),
    );
    expect(mockedScheduleCodeGraphBuild).toHaveBeenCalledWith({
      projectId: 'test-project',
      worktreeId: 'test-animal',
      reason: 'worktree-created',
    });
  });

  it('skips discovery and graph scheduling when setup finishes for a stale worktree', async () => {
    mockedIsWorkspaceWorktreeCurrent.mockResolvedValue(false);

    const result = await runProjectWorktreePostCreateSetup({
      projectId: 'test-project',
      worktreeId: 'test-animal',
      project: { repoPath: '/repo', scripts: {} },
      getWindow: () => null,
    });

    expect(result).toEqual({ status: 'skipped' });
    expect(mockedTriggerDiscovery).not.toHaveBeenCalled();
    expect(mockedScheduleCodeGraphBuild).not.toHaveBeenCalled();
  });

  it('does not restart discovery after archive cancels an already-running setup', async () => {
    let finishSetup = (): void => undefined;
    mockedGetResolvedScriptDefinition.mockReturnValue({
      command: 'npm install',
    });
    mockedRunShellScript.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSetup = (): void =>
            resolve({
              success: true,
              exitCode: 0,
              output: '',
              timedOut: false,
              durationMs: 25,
            });
        }),
    );
    const setup = runProjectWorktreePostCreateSetup({
      projectId: 'test-project',
      worktreeId: 'test-animal',
      project: { repoPath: '/repo', scripts: {} },
      getWindow: () => null,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockedRunShellScript).toHaveBeenCalledTimes(1);

    await withWorkspaceTargetArchiveDrain(
      'test-project',
      'test-animal',
      (): Promise<void> => Promise.resolve(),
    );
    finishSetup();
    await setup;

    expect(mockedTriggerDiscovery).not.toHaveBeenCalled();
    expect(mockedScheduleCodeGraphBuild).not.toHaveBeenCalled();
  });
});

describe('startProjectWorktreePostCreateSetup', () => {
  const setupParams = {
    projectId: 'test-project',
    worktreeId: 'test-animal',
    project: { repoPath: '/repo', scripts: {} },
    getWindow: (): null => null,
  };

  it('returns a promise that settles only after the held setup run finishes', async () => {
    const setupScript = holdSetupScript();

    const setup = observeSettlement(
      startProjectWorktreePostCreateSetup(setupParams),
    );
    await flushTurns();

    expect(mockedRunShellScript).toHaveBeenCalledTimes(1);
    expect(setup.settled).toBe(false);
    expect(mockedScheduleCodeGraphBuild).not.toHaveBeenCalled();

    setupScript.release();
    await setup.done;

    expect(setup.rejected).toBe(false);
    expect(mockedScheduleCodeGraphBuild).toHaveBeenCalledTimes(1);
  });

  it('resolves rather than rejects when the held setup run fails', async () => {
    const setupScript = holdSetupScript();
    // The finalizer throwing makes the underlying run reject, not just report failure.
    mockedTriggerDiscovery.mockImplementationOnce(() => {
      throw new Error('discovery unavailable');
    });

    const setup = observeSettlement(
      startProjectWorktreePostCreateSetup(setupParams),
    );
    await flushTurns();

    expect(setup.settled).toBe(false);

    setupScript.fail(new Error('spawn failed'));
    await setup.done;

    expect(setup.rejected).toBe(false);
    expect(mockedTriggerDiscovery).toHaveBeenCalledTimes(1);
  });
});
