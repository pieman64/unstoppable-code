jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(() => Promise.resolve()),
  readdir: jest.fn(),
}));
jest.mock('../lib/git', () => ({
  getCurrentBranch: jest.fn(),
}));
jest.mock('../lib/paths', () => ({
  getWorktreeDataDir: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/mock/workspaces/${workspaceId}/worktree-data/${worktreeId}`,
  ),
  getWorkspaceWorktreeDir: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/mock/workspaces/${workspaceId}/worktrees/${worktreeId}`,
  ),
  getWorkspaceWorktreeRepoDir: jest.fn(
    (workspaceId: string, worktreeId: string, repoId: string) =>
      `/mock/workspaces/${workspaceId}/worktrees/${worktreeId}/repos/${repoId}`,
  ),
  getWorkspaceWorktreeReposDir: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/mock/workspaces/${workspaceId}/worktrees/${worktreeId}/repos`,
  ),
}));
jest.mock('../lib/script-runner', () => ({
  runShellScript: jest.fn(),
}));
jest.mock('../lib/script-events', () => ({
  createWorkspaceRootScriptDescriptor: jest.fn(
    (
      scriptName: string,
      command: string,
      devServerPattern?: unknown,
      shell?: unknown,
      interactive?: boolean,
    ) => ({
      scriptKey: `workspace-root:${scriptName}`,
      scriptName,
      label: scriptName,
      command,
      lifecycle: scriptName,
      target: 'workspace-root',
      ...(devServerPattern !== undefined ? { devServerPattern } : {}),
      ...(shell !== undefined ? { shell } : {}),
      ...(interactive === true ? { interactive: true } : {}),
    }),
  ),
  createWorkspaceRepoScriptDescriptor: jest.fn(
    (
      repoId: string,
      repoName: string,
      scriptName: string,
      command: string,
      devServerPattern?: unknown,
      shell?: unknown,
      interactive?: boolean,
    ) => ({
      scriptKey: `workspace-repo:${repoId}:${scriptName}`,
      scriptName,
      label: `${repoName}:${scriptName}`,
      command,
      lifecycle: scriptName,
      target: 'workspace-repo',
      repoId,
      repoName,
      ...(devServerPattern !== undefined ? { devServerPattern } : {}),
      ...(shell !== undefined ? { shell } : {}),
      ...(interactive === true ? { interactive: true } : {}),
    }),
  ),
  createScriptStartedEvent: jest.fn(() => ({ type: 'started' })),
  createScriptOutputEvent: jest.fn(() => ({ type: 'output' })),
  createScriptCompleteEvent: jest.fn(() => ({ type: 'complete' })),
}));
jest.mock('../lib/script-resolver', () => ({
  getResolvedScriptDefinition: jest.fn(),
  resolveWorkspaceRepoScripts: jest.fn(() => Promise.resolve({})),
  resolveWorkspaceRootScripts: jest.fn(() => Promise.resolve({})),
}));
jest.mock('../lib/script-log-store', () => ({
  appendScriptRunLogLines: jest.fn(() => Promise.resolve()),
  completeScriptRunLog: jest.fn(() => Promise.resolve()),
  startScriptRunLog: jest.fn(
    ({
      projectId,
      worktreeId,
      script,
    }: {
      projectId: string;
      worktreeId: string;
      script: { scriptKey: string };
    }) =>
      Promise.resolve({
        projectId,
        worktreeId,
        script,
        runId: 'run-1',
      }),
  ),
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({
      scriptTimeoutMinutes: 5,
    }),
  ),
}));
jest.mock('../ipc/worktree-discovery', () => ({
  triggerDiscovery: jest.fn(),
}));
jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));
jest.mock('../lib/workspace-persistence', () => ({
  getWorkspaceWorktreeCreatedAt: jest.fn(() =>
    Promise.resolve('2026-07-11T00:00:00.000Z'),
  ),
  isWorkspaceWorktreeCurrent: jest.fn(() => Promise.resolve(true)),
  readWorkspaceConfig: jest.fn(),
}));
jest.mock('../lib/code-graph-scheduler', () => ({
  scheduleCodeGraphBuild: jest.fn(),
}));

import { mkdir } from 'node:fs/promises';
import { scheduleCodeGraphBuild } from '../lib/code-graph-scheduler';
import { triggerDiscovery } from '../ipc/worktree-discovery';
import {
  appendScriptRunLogLines,
  completeScriptRunLog,
  startScriptRunLog,
} from '../lib/script-log-store';
import {
  createWorkspaceRepoScriptDescriptor,
  createWorkspaceRootScriptDescriptor,
} from '../lib/script-events';
import { runShellScript } from '../lib/script-runner';
import {
  DEFAULT_PREFERENCES,
  readPreferencesFile,
} from '../lib/preferences-store';
import { getResolvedScriptDefinition } from '../lib/script-resolver';
import { sendToWindow } from '../lib/window-send';
import { isWorkspaceWorktreeCurrent } from '../lib/workspace-persistence';
import {
  startWorkspaceRepoSetupAndDiscovery,
  startWorkspaceWorktreePostCreateSetup,
} from '../lib/workspace-worktree-runtime';
import {
  cancelWorkspaceTargetRuntimePreparation,
  resetWorkspaceTargetExclusionsForTests,
  withWorkspaceTargetArchiveDrain,
} from '../lib/workspace-target-exclusion';

const mockedMkdir = jest.mocked(mkdir);
const mockedAppendScriptRunLogLines = jest.mocked(appendScriptRunLogLines);
const mockedCompleteScriptRunLog = jest.mocked(completeScriptRunLog);
const mockedStartScriptRunLog = jest.mocked(startScriptRunLog);
const mockedRunShellScript = jest.mocked(runShellScript);
const mockedGetResolvedScriptDefinition = jest.mocked(
  getResolvedScriptDefinition,
);
const mockedCreateWorkspaceRootScriptDescriptor = jest.mocked(
  createWorkspaceRootScriptDescriptor,
);
const mockedCreateWorkspaceRepoScriptDescriptor = jest.mocked(
  createWorkspaceRepoScriptDescriptor,
);
const mockedSendToWindow = jest.mocked(sendToWindow);
const mockedTriggerDiscovery = jest.mocked(triggerDiscovery);
const mockedScheduleCodeGraphBuild = jest.mocked(scheduleCodeGraphBuild);
const mockedIsWorkspaceWorktreeCurrent = jest.mocked(
  isWorkspaceWorktreeCurrent,
);

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function flushTurns(turns = 5): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await flush();
  }
}

function holdPreferences(): {
  release: () => void;
  fail: (error: Error) => void;
} {
  const held: { release: () => void; fail: (error: Error) => void } = {
    release: (): void => undefined,
    fail: (): void => undefined,
  };
  jest.mocked(readPreferencesFile).mockImplementationOnce(
    (): ReturnType<typeof readPreferencesFile> =>
      new Promise((resolve, reject) => {
        held.release = (): void =>
          resolve({ ...DEFAULT_PREFERENCES, scriptTimeoutMinutes: 5 });
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
  mockedMkdir.mockResolvedValue(undefined);
  mockedRunShellScript.mockImplementation((options) => {
    options.onChunk?.(['script line']);
    return Promise.resolve({
      success: true,
      exitCode: 0,
      output: 'script line',
      timedOut: false,
      durationMs: 25,
    });
  });
  mockedGetResolvedScriptDefinition.mockReturnValue(undefined);
  mockedSendToWindow.mockReturnValue(true);
  mockedIsWorkspaceWorktreeCurrent.mockResolvedValue(true);
});

describe('startWorkspaceRepoSetupAndDiscovery', () => {
  it('holds preparation across preference resolution and suppresses stale discovery', async () => {
    let resolvePreferences = (): void => undefined;
    jest.mocked(readPreferencesFile).mockImplementationOnce(
      (): ReturnType<typeof readPreferencesFile> =>
        new Promise((resolve) => {
          resolvePreferences = (): void =>
            resolve({ ...DEFAULT_PREFERENCES, scriptTimeoutMinutes: 5 });
        }),
    );
    mockedIsWorkspaceWorktreeCurrent.mockResolvedValue(false);

    void startWorkspaceRepoSetupAndDiscovery({
      workspaceId: 'test-workspace',
      worktreeId: 'test-animal',
      repo: { id: 'repo-a', name: 'Repo A', repoPath: '/repos/repo-a' },
      getWindow: () => null,
    });
    await flush();
    await withWorkspaceTargetArchiveDrain(
      'test-workspace',
      'test-animal',
      (): Promise<void> => Promise.resolve(),
    );
    resolvePreferences();
    await flush();
    await flush();

    expect(mockedRunShellScript).not.toHaveBeenCalled();
    expect(mockedTriggerDiscovery).not.toHaveBeenCalled();
  });

  it('returns a promise that settles only after the held setup and discovery finish', async () => {
    const preferences = holdPreferences();

    const setup = observeSettlement(
      startWorkspaceRepoSetupAndDiscovery({
        workspaceId: 'test-workspace',
        worktreeId: 'test-animal',
        repo: { id: 'repo-a', name: 'Repo A', repoPath: '/repos/repo-a' },
        getWindow: () => null,
      }),
    );
    await flushTurns();

    expect(setup.settled).toBe(false);
    expect(mockedTriggerDiscovery).not.toHaveBeenCalled();

    preferences.release();
    await setup.done;

    expect(setup.rejected).toBe(false);
    expect(mockedTriggerDiscovery).toHaveBeenCalledTimes(1);
  });

  it('resolves rather than rejects when the held setup fails', async () => {
    const preferences = holdPreferences();

    const setup = observeSettlement(
      startWorkspaceRepoSetupAndDiscovery({
        workspaceId: 'test-workspace',
        worktreeId: 'test-animal',
        repo: { id: 'repo-a', name: 'Repo A', repoPath: '/repos/repo-a' },
        getWindow: () => null,
      }),
    );
    await flushTurns();

    expect(setup.settled).toBe(false);

    preferences.fail(new Error('preferences unreadable'));
    await setup.done;

    expect(setup.rejected).toBe(false);
    expect(mockedTriggerDiscovery).toHaveBeenCalledTimes(1);
  });
});

describe('startWorkspaceWorktreePostCreateSetup', () => {
  it('returns a promise that settles only after the held post-create setup finishes', async () => {
    const preferences = holdPreferences();

    const setup = observeSettlement(
      startWorkspaceWorktreePostCreateSetup({
        workspaceId: 'test-workspace',
        worktreeId: 'test-animal',
        workspaceRootPath:
          '/mock/workspaces/test-workspace/worktrees/test-animal',
        repos: [],
        getWindow: () => null,
      }),
    );
    await flushTurns();

    expect(setup.settled).toBe(false);
    expect(mockedScheduleCodeGraphBuild).not.toHaveBeenCalled();

    preferences.release();
    await setup.done;

    expect(setup.rejected).toBe(false);
    expect(mockedScheduleCodeGraphBuild).toHaveBeenCalledTimes(1);
  });

  it('resolves rather than rejects when the held post-create setup fails', async () => {
    const preferences = holdPreferences();

    const setup = observeSettlement(
      startWorkspaceWorktreePostCreateSetup({
        workspaceId: 'test-workspace',
        worktreeId: 'test-animal',
        workspaceRootPath:
          '/mock/workspaces/test-workspace/worktrees/test-animal',
        repos: [],
        getWindow: () => null,
      }),
    );
    await flushTurns();

    expect(setup.settled).toBe(false);

    preferences.fail(new Error('preferences unreadable'));
    await setup.done;

    expect(setup.rejected).toBe(false);
    expect(mockedScheduleCodeGraphBuild).toHaveBeenCalledTimes(1);
  });

  it('does not recreate a repository parent after archive cancels preparation', async () => {
    let resolvePreferences = (): void => undefined;
    jest.mocked(readPreferencesFile).mockImplementationOnce(
      (): ReturnType<typeof readPreferencesFile> =>
        new Promise((resolve) => {
          resolvePreferences = (): void =>
            resolve({ ...DEFAULT_PREFERENCES, scriptTimeoutMinutes: 5 });
        }),
    );

    void startWorkspaceWorktreePostCreateSetup({
      workspaceId: 'test-workspace',
      worktreeId: 'test-animal',
      workspaceRootPath:
        '/mock/workspaces/test-workspace/worktrees/test-animal',
      repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/repo-a' }],
      getWindow: () => null,
    });
    await flush();
    await withWorkspaceTargetArchiveDrain(
      'test-workspace',
      'test-animal',
      (): Promise<void> => Promise.resolve(),
    );
    resolvePreferences();
    await flush();
    await flush();

    expect(mockedMkdir).not.toHaveBeenCalled();
    expect(mockedRunShellScript).not.toHaveBeenCalled();
  });

  it('persists project lifecycle output even when no window is attached', async () => {
    mockedGetResolvedScriptDefinition.mockImplementation(
      (_scripts, scriptName) =>
        scriptName === 'before-setup' ? { command: 'echo before' } : undefined,
    );

    void startWorkspaceWorktreePostCreateSetup({
      workspaceId: 'test-workspace',
      worktreeId: 'test-animal',
      workspaceRootPath:
        '/mock/workspaces/test-workspace/worktrees/test-animal',
      repos: [],
      getWindow: () => null,
    });
    await flush();
    await flush();

    expect(mockedStartScriptRunLog).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'test-workspace',
        worktreeId: 'test-animal',
        invocation: 'workspace-lifecycle',
      }),
    );
    expect(mockedAppendScriptRunLogLines).toHaveBeenCalledWith(
      expect.objectContaining({
        lines: ['script line'],
      }),
    );
    const runArgs = mockedRunShellScript.mock.calls[0]?.[0];
    expect(runArgs?.backgroundPriority).toBe(false);
    expect(runArgs?.env).toEqual(
      expect.objectContaining({
        CANOPY_WORKSPACE_ID: 'test-workspace',
        CANOPY_WORKTREE_NAME: 'test-animal',
        CONDUCTOR_WORKSPACE_NAME: 'test-animal',
        CANOPY_WORKTREE_DATA_DIR:
          '/mock/workspaces/test-workspace/worktree-data/test-animal',
      }),
    );
    expect(runArgs?.env?.CANOPY_WORKSPACE_CHILD_REPO_ID).toBeUndefined();
    expect(mockedCompleteScriptRunLog).toHaveBeenCalled();
    expect(mockedSendToWindow).not.toHaveBeenCalled();
    expect(mockedScheduleCodeGraphBuild).toHaveBeenCalledWith({
      projectId: 'test-workspace',
      worktreeId: 'test-animal',
      reason: 'worktree-created',
    });
    const triggerDiscoveryOrder =
      mockedTriggerDiscovery.mock.invocationCallOrder[0];
    const scheduleCodeGraphBuildOrder =
      mockedScheduleCodeGraphBuild.mock.invocationCallOrder[0];
    expect(triggerDiscoveryOrder).toBeDefined();
    expect(scheduleCodeGraphBuildOrder).toBeDefined();
    expect(scheduleCodeGraphBuildOrder).toBeGreaterThan(triggerDiscoveryOrder);
  });

  it('skips discovery and graph scheduling when setup finishes for a stale worktree', async () => {
    mockedGetResolvedScriptDefinition.mockImplementation(
      (_scripts, scriptName) =>
        scriptName === 'before-setup' ? { command: 'echo before' } : undefined,
    );
    mockedIsWorkspaceWorktreeCurrent.mockResolvedValue(false);

    void startWorkspaceWorktreePostCreateSetup({
      workspaceId: 'test-workspace',
      worktreeId: 'test-animal',
      workspaceRootPath:
        '/mock/workspaces/test-workspace/worktrees/test-animal',
      repos: [],
      getWindow: () => null,
    });
    await flush();
    await flush();

    expect(mockedTriggerDiscovery).not.toHaveBeenCalled();
    expect(mockedScheduleCodeGraphBuild).not.toHaveBeenCalled();
  });

  it('does not restart discovery after archive cancels an already-running setup', async () => {
    let finishSetup = (): void => undefined;
    mockedGetResolvedScriptDefinition.mockImplementation(
      (_scripts, scriptName) =>
        scriptName === 'before-setup' ? { command: 'echo before' } : undefined,
    );
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
    void startWorkspaceWorktreePostCreateSetup({
      workspaceId: 'test-workspace',
      worktreeId: 'test-animal',
      workspaceRootPath:
        '/mock/workspaces/test-workspace/worktrees/test-animal',
      repos: [],
      getWindow: () => null,
    });
    await flush();
    expect(mockedRunShellScript).toHaveBeenCalledTimes(1);

    await withWorkspaceTargetArchiveDrain(
      'test-workspace',
      'test-animal',
      (): Promise<void> => Promise.resolve(),
    );
    finishSetup();
    await flush();
    await flush();

    expect(mockedTriggerDiscovery).not.toHaveBeenCalled();
    expect(mockedScheduleCodeGraphBuild).not.toHaveBeenCalled();
  });

  it('does not start after-setup once a removal cancels the running repo setup', async () => {
    let stopRepoSetup = (): void => undefined;
    mockedGetResolvedScriptDefinition.mockImplementation(
      (_scripts, scriptName) =>
        scriptName === 'setup' || scriptName === 'after-setup'
          ? { command: `echo ${scriptName}` }
          : undefined,
    );
    mockedRunShellScript.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          stopRepoSetup = (): void =>
            resolve({
              success: false,
              exitCode: null,
              output: '',
              timedOut: false,
              durationMs: 25,
            });
        }),
    );
    void startWorkspaceWorktreePostCreateSetup({
      workspaceId: 'test-workspace',
      worktreeId: 'test-animal',
      workspaceRootPath:
        '/mock/workspaces/test-workspace/worktrees/test-animal',
      repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/repo-a' }],
      getWindow: () => null,
    });
    await flush();
    await flush();
    expect(mockedRunShellScript).toHaveBeenCalledTimes(1);

    // The removal cancels the sequence, then stops the running step.
    cancelWorkspaceTargetRuntimePreparation('test-workspace', 'test-animal');
    stopRepoSetup();
    await flush();
    await flush();
    await flush();

    expect(mockedRunShellScript).toHaveBeenCalledTimes(1);
    expect(mockedTriggerDiscovery).not.toHaveBeenCalled();
    expect(mockedScheduleCodeGraphBuild).not.toHaveBeenCalled();
  });

  it('starts a fresh setup after an earlier one was cancelled', async () => {
    mockedGetResolvedScriptDefinition.mockImplementation(
      (_scripts, scriptName) =>
        scriptName === 'after-setup' ? { command: 'echo after' } : undefined,
    );
    cancelWorkspaceTargetRuntimePreparation('test-workspace', 'test-animal');
    void startWorkspaceWorktreePostCreateSetup({
      workspaceId: 'test-workspace',
      worktreeId: 'test-animal',
      workspaceRootPath:
        '/mock/workspaces/test-workspace/worktrees/test-animal',
      repos: [],
      getWindow: () => null,
    });
    await flush();
    await flush();

    expect(mockedRunShellScript).toHaveBeenCalledTimes(1);
  });

  it('persists project repo setup output even when no window is attached', async () => {
    mockedGetResolvedScriptDefinition.mockImplementation(
      (_scripts, scriptName) =>
        scriptName === 'setup' ? { command: 'npm run setup' } : undefined,
    );

    void startWorkspaceWorktreePostCreateSetup({
      workspaceId: 'test-workspace',
      worktreeId: 'test-animal',
      workspaceRootPath:
        '/mock/workspaces/test-workspace/worktrees/test-animal',
      repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/repo-a' }],
      getWindow: () => null,
    });
    await flush();
    await flush();

    expect(mockedStartScriptRunLog).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'test-workspace',
        worktreeId: 'test-animal',
        invocation: 'automatic-setup',
      }),
    );
    expect(mockedAppendScriptRunLogLines).toHaveBeenCalledWith(
      expect.objectContaining({
        lines: ['script line'],
      }),
    );
    const runArgs = mockedRunShellScript.mock.calls[0]?.[0];
    expect(runArgs?.backgroundPriority).toBe(true);
    expect(runArgs?.env).toEqual(
      expect.objectContaining({
        CANOPY_WORKSPACE_ID: 'test-workspace',
        CANOPY_WORKTREE_NAME: 'test-animal',
        CONDUCTOR_WORKSPACE_NAME: 'test-animal',
        CANOPY_WORKTREE_DATA_DIR:
          '/mock/workspaces/test-workspace/worktree-data/test-animal',
        CANOPY_WORKSPACE_CHILD_REPO_ID: 'repo-a',
      }),
    );
    expect(mockedCompleteScriptRunLog).toHaveBeenCalled();
    expect(mockedSendToWindow).not.toHaveBeenCalled();
  });

  it('passes each target devServerPattern to its own setup descriptor', async () => {
    const rootPattern = 'Root:\\s+(https?://\\S+)';
    const repoPattern = {
      pattern: 'Repo:\\s+(https?://\\S+)',
      label: 'Repo',
    };
    mockedGetResolvedScriptDefinition.mockImplementation(
      (_scripts, scriptName) => {
        if (scriptName === 'before-setup') {
          return {
            command: 'echo before',
            devServerPattern: rootPattern,
            interactive: true,
          };
        }
        if (scriptName === 'setup') {
          return {
            command: 'npm run setup',
            devServerPattern: repoPattern,
            interactive: true,
          };
        }
        return undefined;
      },
    );

    void startWorkspaceWorktreePostCreateSetup({
      workspaceId: 'test-workspace',
      worktreeId: 'test-animal',
      workspaceRootPath:
        '/mock/workspaces/test-workspace/worktrees/test-animal',
      repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/repo-a' }],
      getWindow: () => null,
    });
    await flush();
    await flush();
    await flush();

    expect(mockedCreateWorkspaceRootScriptDescriptor).toHaveBeenCalledWith(
      'before-setup',
      'echo before',
      rootPattern,
      undefined,
      true,
    );
    expect(mockedCreateWorkspaceRepoScriptDescriptor).toHaveBeenCalledWith(
      'repo-a',
      'Repo A',
      'setup',
      'npm run setup',
      repoPattern,
      undefined,
      true,
    );
    expect(
      mockedRunShellScript.mock.calls.map(([options]) => options.interactive),
    ).toEqual([true, true]);
    expect(
      mockedRunShellScript.mock.calls.map(
        ([options]) => options.timeoutSeconds,
      ),
    ).toEqual([null, null]);
  });
});
