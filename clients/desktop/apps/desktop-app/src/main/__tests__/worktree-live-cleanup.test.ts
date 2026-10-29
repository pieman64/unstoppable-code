const destroyWorktreeSessionsMock = jest.fn(() => Promise.resolve());
const stopTrackingMock = jest.fn();
const cancelScheduledGenerationMock = jest.fn();
const cleanupClaudeTerminalWorktreeMock = jest.fn(() => Promise.resolve());
const drainWorktreeTerminalsMock = jest.fn();
const drainWorktreeShellScriptsMock = jest.fn(() => Promise.resolve());
const purgeWorktreeDataMock = jest.fn(() => Promise.resolve());
const drainWorktreePipelinesMock = jest.fn(() => Promise.resolve());
const createElectronExecutionRuntimeMock = jest.fn(() => ({
  executionsDir: '/pipeline-executions',
}));

jest.mock('../agents/session-manager', () => ({
  destroyWorktreeSessions: destroyWorktreeSessionsMock,
}));

jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    purgeWorktreeData: purgeWorktreeDataMock,
  })),
}));

jest.mock('../lib/github-poller', () => ({
  stopTracking: stopTrackingMock,
}));

jest.mock('../lib/worktree-summary-scheduler', () => ({
  cancelScheduledGeneration: cancelScheduledGenerationMock,
}));

jest.mock('../integration/claude-terminal-session-service', () => ({
  getClaudeTerminalSessionService: jest.fn(() => ({
    cleanupWorktree: cleanupClaudeTerminalWorktreeMock,
  })),
}));

jest.mock('../terminal/pty-manager', () => ({
  ptyManager: {
    drainWorktreeTerminals: drainWorktreeTerminalsMock,
  },
}));

jest.mock('../lib/script-runner', () => ({
  drainWorktreeShellScripts: drainWorktreeShellScriptsMock,
}));

jest.mock('../pipelines/worktree-cleanup', () => ({
  drainWorktreePipelines: drainWorktreePipelinesMock,
}));

jest.mock('../pipelines/execution-runtime', () => ({
  createElectronExecutionRuntime: createElectronExecutionRuntimeMock,
}));

import {
  cleanupLiveWorktreeState,
  purgeLiveWorktreeObservabilityData,
} from '../lib/worktree-live-cleanup';
import { setDelegationActivity } from '../agents/delegation/activity';

describe('worktree live cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cleanupClaudeTerminalWorktreeMock.mockResolvedValue(undefined);
    drainWorktreeShellScriptsMock.mockResolvedValue(undefined);
    drainWorktreeTerminalsMock.mockResolvedValue(undefined);
  });

  it('stays a lifecycle boundary for CLI removals while delegates are live', async () => {
    // A worktree deleted out of process is reconciled through this shared
    // cleanup; only in-app removal entry points refuse live delegates.
    setDelegationActivity('cli-removal-owner', 'project-1/wt-1/chat-a', 1);
    try {
      await expect(
        cleanupLiveWorktreeState('project-1', 'wt-1'),
      ).resolves.toBeUndefined();
    } finally {
      setDelegationActivity('cli-removal-owner', 'project-1/wt-1/chat-a', 0);
    }
    expect(destroyWorktreeSessionsMock).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
  });

  it('kills worktree terminals through the shared cleanup hook', async () => {
    await cleanupLiveWorktreeState('project-1', 'wt-1');

    expect(stopTrackingMock).toHaveBeenCalledWith('project-1', 'wt-1');
    expect(cancelScheduledGenerationMock).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(cleanupClaudeTerminalWorktreeMock).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(drainWorktreeTerminalsMock).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(destroyWorktreeSessionsMock).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(drainWorktreePipelinesMock).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      { executionsDir: '/pipeline-executions' },
    );
  });

  it('still kills worktree terminals if Claude terminal cleanup fails', async () => {
    const onSessionsDestroyed = jest.fn();
    cleanupClaudeTerminalWorktreeMock.mockRejectedValueOnce(
      new Error('claude cleanup failed'),
    );

    await expect(
      cleanupLiveWorktreeState('project-1', 'wt-1', onSessionsDestroyed),
    ).rejects.toThrow('claude cleanup failed');

    expect(drainWorktreeTerminalsMock).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(destroyWorktreeSessionsMock).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(onSessionsDestroyed).toHaveBeenCalledTimes(1);
  });

  it('awaits main-owned scripts and terminal cleanup even when the renderer has no script state', async () => {
    let finishScripts: (() => void) | undefined;
    let finishTerminals: (() => void) | undefined;
    drainWorktreeShellScriptsMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishScripts = resolve;
      }),
    );
    drainWorktreeTerminalsMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishTerminals = resolve;
      }),
    );
    let finished = false;
    const cleanup = cleanupLiveWorktreeState('project-1', 'wt-1').then(() => {
      finished = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(drainWorktreeShellScriptsMock).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(finished).toBe(false);
    if (!finishScripts) throw new Error('Expected script cleanup gate');
    finishScripts();
    await new Promise((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    if (!finishTerminals) throw new Error('Expected terminal cleanup gate');
    finishTerminals();
    await cleanup;
    expect(finished).toBe(true);
  });

  it('still drains other resource owners when a script cannot stop, then refuses teardown', async () => {
    drainWorktreeShellScriptsMock.mockRejectedValueOnce(
      new Error('script still alive'),
    );
    await expect(cleanupLiveWorktreeState('project-1', 'wt-1')).rejects.toThrow(
      'script still alive',
    );
    expect(drainWorktreeTerminalsMock).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(destroyWorktreeSessionsMock).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
  });

  it('refuses teardown when a running pipeline cannot be drained', async () => {
    drainWorktreePipelinesMock.mockRejectedValueOnce(
      new Error('pipeline still alive'),
    );

    await expect(cleanupLiveWorktreeState('project-1', 'wt-1')).rejects.toThrow(
      'pipeline still alive',
    );
    expect(destroyWorktreeSessionsMock).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
  });

  it('purges persisted observability data for the worktree', async () => {
    await purgeLiveWorktreeObservabilityData('project-1', 'wt-1');

    expect(purgeWorktreeDataMock).toHaveBeenCalledWith('project-1', 'wt-1');
  });
});
