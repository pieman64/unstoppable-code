import type * as NodeCrypto from 'node:crypto';
import type * as ScriptExecutionDouble from './helpers/script-execution-double';
// The setup runtime names the run; the worker's log takes that id.
jest.mock('node:crypto', () => ({
  ...jest.requireActual<typeof NodeCrypto>('node:crypto'),
  randomUUID: (): string => 'run-setup-1',
}));
jest.mock('../lib/script-execution', () =>
  jest.requireActual<typeof ScriptExecutionDouble>(
    './helpers/script-execution-double',
  ),
);
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
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

import { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { sendToWindow } from '../lib/window-send';
import { scheduleCodeGraphBuild } from '../lib/code-graph-scheduler';
import { triggerDiscovery } from '../ipc/worktree-discovery';
import { getResolvedScriptDefinition } from '../lib/script-resolver';
import { runShellScript } from '../lib/script-runner';
import {
  completeScriptRunLog,
  startScriptRunLog,
} from '../lib/script-log-store';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { isWorkspaceWorktreeCurrent } from '../lib/workspace-persistence';
import type {
  WorktreeSetupObserver,
  WorktreeSetupScriptRef,
  WorktreeSetupScriptResult,
} from '../lib/worktree-setup-result';
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
const mockedStartScriptRunLog = jest.mocked(startScriptRunLog);
const mockedCompleteScriptRunLog = jest.mocked(completeScriptRunLog);
const mockedLogMainProcessWarn = jest.mocked(logMainProcessWarn);

const SETUP_LOG_REF = {
  projectId: 'test-project',
  worktreeId: 'test-animal',
  script: {
    scriptKey: 'project:setup',
    scriptName: 'setup',
    label: 'setup',
    command: 'npm install',
    lifecycle: 'setup' as const,
    target: 'project' as const,
  },
  runId: 'run-setup-1',
};

function recordingObserver(): {
  observer: WorktreeSetupObserver;
  events: string[];
  resolved: boolean[];
  started: WorktreeSetupScriptRef[];
  completed: WorktreeSetupScriptResult[];
} {
  const record = {
    events: [] as string[],
    resolved: [] as boolean[],
    started: [] as WorktreeSetupScriptRef[],
    completed: [] as WorktreeSetupScriptResult[],
  };
  return {
    ...record,
    observer: {
      onResolved: (configured): void => {
        record.events.push(`resolved:${String(configured)}`);
        record.resolved.push(configured);
      },
      onScriptStarted: (script): void => {
        record.events.push(`started:${script.scriptKey}`);
        record.started.push(script);
      },
      onScriptCompleted: (script): void => {
        record.events.push(`completed:${script.scriptKey}`);
        record.completed.push(script);
      },
    },
  };
}

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

    expect(result).toMatchObject({ status: 'completed' });
    const runOptions = mockedRunShellScript.mock.calls[0]?.[0];
    expect(runOptions?.script).toBe('npm install');
    expect(runOptions?.backgroundPriority).toBe(true);
    expect(runOptions?.interactive).toBe(true);
    expect(runOptions?.timeoutSeconds).toBeNull();
    expect(runOptions?.tracking?.script?.interactive).toBe(true);
  });

  it('reports observer events in order around the canonical log and the process', async () => {
    mockedGetResolvedScriptDefinition.mockReturnValue({
      command: 'npm install',
    });
    const recorder = recordingObserver();
    mockedStartScriptRunLog.mockImplementationOnce(() => {
      recorder.events.push('log-started');
      return Promise.resolve(SETUP_LOG_REF);
    });
    mockedRunShellScript.mockImplementationOnce(() => {
      recorder.events.push('process');
      return Promise.resolve({
        success: true,
        exitCode: 0,
        output: '',
        timedOut: false,
        durationMs: 25,
      });
    });
    mockedCompleteScriptRunLog.mockImplementationOnce(() => {
      recorder.events.push('log-completed');
      return Promise.resolve();
    });

    const result = await runProjectWorktreePostCreateSetup({
      projectId: 'test-project',
      worktreeId: 'test-animal',
      project: { repoPath: '/repo', scripts: {} },
      getWindow: () => null,
      observer: recorder.observer,
    });

    // The worker starts the run's log once the run is reported started.
    expect(recorder.events).toEqual([
      'resolved:true',
      'started:project:setup',
      'log-started',
      'process',
      'log-completed',
      'completed:project:setup',
    ]);
    const expectedScript: WorktreeSetupScriptResult = {
      scriptKey: 'project:setup',
      runId: 'run-setup-1',
      target: 'project',
      lifecycle: 'setup',
      logRef: SETUP_LOG_REF,
      status: 'succeeded',
      exitCode: 0,
      timedOut: false,
    };
    expect(result).toEqual({ status: 'completed', script: expectedScript });
    expect(recorder.completed).toEqual([expectedScript]);
    expect(recorder.started).toEqual([
      {
        scriptKey: 'project:setup',
        runId: 'run-setup-1',
        target: 'project',
        lifecycle: 'setup',
        logRef: SETUP_LOG_REF,
      },
    ]);
  });

  it('calls onResolved exactly once with configured false when no setup script exists', async () => {
    const recorder = recordingObserver();

    const result = await runProjectWorktreePostCreateSetup({
      projectId: 'test-project',
      worktreeId: 'test-animal',
      project: { repoPath: '/repo', scripts: {} },
      getWindow: () => null,
      observer: recorder.observer,
    });

    expect(result).toEqual({ status: 'skipped' });
    expect(recorder.events).toEqual(['resolved:false']);
  });

  it('returns the real exit code and log ref when setup fails', async () => {
    mockedGetResolvedScriptDefinition.mockReturnValue({
      command: 'npm install',
    });
    mockedStartScriptRunLog.mockResolvedValueOnce(SETUP_LOG_REF);
    mockedRunShellScript.mockResolvedValueOnce({
      success: false,
      exitCode: 3,
      output: 'boom',
      timedOut: false,
      durationMs: 25,
    });

    const result = await runProjectWorktreePostCreateSetup({
      projectId: 'test-project',
      worktreeId: 'test-animal',
      project: { repoPath: '/repo', scripts: {} },
      getWindow: () => null,
    });

    expect(result).toMatchObject({
      status: 'failed',
      detail: 'setup script exited with code 3',
      script: {
        runId: 'run-setup-1',
        logRef: SETUP_LOG_REF,
        status: 'failed',
        exitCode: 3,
        timedOut: false,
      },
    });
  });

  it('reports a script deadline as timed out', async () => {
    mockedGetResolvedScriptDefinition.mockReturnValue({
      command: 'npm install',
      timeoutSeconds: 5,
    });
    mockedRunShellScript.mockResolvedValueOnce({
      success: false,
      exitCode: null,
      output: '',
      timedOut: true,
      durationMs: 5000,
    });
    const recorder = recordingObserver();

    const result = await runProjectWorktreePostCreateSetup({
      projectId: 'test-project',
      worktreeId: 'test-animal',
      project: { repoPath: '/repo', scripts: {} },
      getWindow: () => null,
      observer: recorder.observer,
    });

    expect(result.status).toBe('failed');
    expect(result.detail).toBe('setup script timed out');
    expect(result.script).toMatchObject({
      status: 'timed_out',
      exitCode: null,
      timedOut: true,
    });
    // The worker writes the log under the run's id.
    expect(result.script?.logRef?.runId).toBe('run-setup-1');
    expect(typeof result.script?.runId).toBe('string');
    expect(recorder.completed).toEqual([result.script]);
    expect(mockedRunShellScript.mock.calls[0]?.[0]?.timeoutSeconds).toBe(5);
  });

  it('keeps exit code 1 and the started run when the script runner throws', async () => {
    mockedGetResolvedScriptDefinition.mockReturnValue({
      command: 'npm install',
    });
    mockedStartScriptRunLog.mockResolvedValueOnce(SETUP_LOG_REF);
    mockedRunShellScript.mockRejectedValueOnce(new Error('spawn failed'));
    const recorder = recordingObserver();

    const result = await runProjectWorktreePostCreateSetup({
      projectId: 'test-project',
      worktreeId: 'test-animal',
      project: { repoPath: '/repo', scripts: {} },
      getWindow: () => null,
      observer: recorder.observer,
    });

    const expectedScript: WorktreeSetupScriptResult = {
      scriptKey: 'project:setup',
      runId: 'run-setup-1',
      target: 'project',
      lifecycle: 'setup',
      logRef: SETUP_LOG_REF,
      status: 'failed',
      exitCode: 1,
      timedOut: false,
    };
    expect(result).toEqual({
      status: 'failed',
      detail: 'spawn failed',
      script: expectedScript,
    });
    expect(recorder.events).toEqual([
      'resolved:true',
      'started:project:setup',
      'completed:project:setup',
    ]);
  });

  it('keeps the completed script when the completion broadcast throws', async () => {
    mockedGetResolvedScriptDefinition.mockReturnValue({
      command: 'npm install',
    });
    mockedStartScriptRunLog.mockResolvedValueOnce(SETUP_LOG_REF);
    let completeSends = 0;
    jest.mocked(sendToWindow).mockImplementation((_window, channel) => {
      if (channel === IPC_CHANNELS.scriptComplete) {
        completeSends += 1;
        if (completeSends === 1) throw new Error('renderer gone');
      }
      return true;
    });
    const recorder = recordingObserver();
    const window = new BrowserWindow();

    const result = await runProjectWorktreePostCreateSetup({
      projectId: 'test-project',
      worktreeId: 'test-animal',
      project: { repoPath: '/repo', scripts: {} },
      getWindow: () => window,
      observer: recorder.observer,
    });

    expect(result).toEqual({
      status: 'failed',
      detail: 'renderer gone',
      script: recorder.completed[0],
    });
    expect(recorder.completed).toHaveLength(1);
    expect(result.script).toMatchObject({
      runId: 'run-setup-1',
      status: 'succeeded',
      exitCode: 0,
    });
    // The canonical log keeps the real completion; it is not rewritten.
    expect(mockedCompleteScriptRunLog).toHaveBeenCalledTimes(1);
    expect(
      mockedCompleteScriptRunLog.mock.calls[0]?.[0].response,
    ).toMatchObject({ success: true, exitCode: 0 });
    expect(completeSends).toBe(1);
  });

  it('does not fail or delay setup when observer callbacks throw, reject or hang', async () => {
    mockedGetResolvedScriptDefinition.mockReturnValue({
      command: 'npm install',
    });
    const observer: WorktreeSetupObserver = {
      onResolved: (): void => {
        throw new Error('secret branch feature/private');
      },
      onScriptStarted: (): Promise<void> => new Promise<void>(() => undefined),
      onScriptCompleted: (): Promise<void> =>
        Promise.reject(new Error('secret group name')),
    };

    const result = await runProjectWorktreePostCreateSetup({
      projectId: 'test-project',
      worktreeId: 'test-animal',
      project: { repoPath: '/repo', scripts: {} },
      getWindow: () => null,
      observer,
    });
    await flushTurns(2);

    expect(result).toMatchObject({
      status: 'completed',
      script: { status: 'succeeded', exitCode: 0 },
    });
    expect(mockedRunShellScript).toHaveBeenCalledTimes(1);
    expect(mockedTriggerDiscovery).toHaveBeenCalledTimes(1);
    expect(mockedLogMainProcessWarn).toHaveBeenCalledTimes(2);
    const logged = JSON.stringify(mockedLogMainProcessWarn.mock.calls);
    expect(logged).not.toContain('secret');
  });

  it('reports a cancelled script when the caller aborts the run', async () => {
    mockedGetResolvedScriptDefinition.mockReturnValue({
      command: 'npm install',
    });
    const controller = new AbortController();
    mockedRunShellScript.mockImplementationOnce((options) => {
      expect(options.signal).toBe(controller.signal);
      return Promise.resolve({
        success: false,
        exitCode: null,
        output: '',
        timedOut: false,
        durationMs: 10,
      });
    });

    const result = await runProjectWorktreePostCreateSetup({
      projectId: 'test-project',
      worktreeId: 'test-animal',
      project: { repoPath: '/repo', scripts: {} },
      getWindow: () => null,
      signal: controller.signal,
    });

    expect(result.status).toBe('failed');
    expect(result.script).toMatchObject({
      status: 'cancelled',
      exitCode: null,
      timedOut: false,
    });
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
  it('resolves undefined even though the awaitable runner returns a result', async () => {
    mockedGetResolvedScriptDefinition.mockReturnValue({
      command: 'npm install',
    });

    await expect(
      startProjectWorktreePostCreateSetup(setupParams),
    ).resolves.toBeUndefined();
    expect(mockedRunShellScript).toHaveBeenCalledTimes(1);
  });
});
