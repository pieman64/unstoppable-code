const mockWakeLockAcquire = jest.fn();
const mockWakeLockRelease = jest.fn();

jest.mock('../power/wake-lock-service', () => ({
  getWakeLockService: jest.fn(() => ({
    acquire: mockWakeLockAcquire,
    release: mockWakeLockRelease,
  })),
}));

const mockStartPipelineExecutionTelemetry = jest.fn();
const mockFinishPipelineExecutionTelemetry = jest.fn();

jest.mock('../pipelines/instrumentation', () => ({
  startPipelineExecutionTelemetry: mockStartPipelineExecutionTelemetry,
  finishPipelineExecutionTelemetry: mockFinishPipelineExecutionTelemetry,
}));

const mockTriggerWorktreePrecommitFailureHook = jest.fn(() =>
  Promise.resolve(),
);

jest.mock('../lib/worktree-precommit-failure-hook', () => ({
  triggerWorktreePrecommitFailureHook: mockTriggerWorktreePrecommitFailureHook,
}));

const mockShowOsNotification = jest.fn(() => ({ shown: true }));
jest.mock('../ipc/os-notifications', () => ({
  showOsNotification: mockShowOsNotification,
}));

import type { BrowserWindow } from 'electron';
import {
  EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
  spaceNotificationScopeKey,
} from '@canopy/desktop-shared/lib/space-notification-policy';
import { publishSpaceNotificationPolicy } from '../lib/space-notification-gate';
import type {
  ExecutionState,
  NormalizedStep,
} from '@canopy/desktop-shared/node/pipelines/executor/types';
import {
  createDesktopLifecycleHooks,
  createDesktopStepPostProcess,
} from '../pipelines/execution-runtime-hooks';

function createExecutionState(): ExecutionState {
  return {
    version: 5,
    id: 'exec-1',
    pipeline_id: 'pipeline-1',
    pipeline_snapshot: { name: 'Pipeline 1', jobs: {} },
    status: 'running',
    jobs: {},
    started_at: '2026-05-31T00:00:00.000Z',
    cwd: '/repo',
    env: {},
    inputs: {},
  };
}

function createStep(id: string, uses: string): NormalizedStep {
  return {
    id,
    uses,
    shell: 'bash',
    continue_on_error: false,
    timeout_minutes: 0,
    skip_on_missing_action: false,
  };
}

describe('execution-runtime-hooks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('acquires wake lock and starts telemetry when execution starts', () => {
    const hooks = createDesktopLifecycleHooks();
    const state = createExecutionState();

    hooks.onExecutionStart?.(state);

    expect(mockWakeLockAcquire).toHaveBeenCalledWith(
      'pipeline:exec-1',
      'pipeline execution',
    );
    expect(mockStartPipelineExecutionTelemetry).toHaveBeenCalledWith(state);
  });

  it('finishes telemetry and releases wake lock once when execution settles', () => {
    const hooks = createDesktopLifecycleHooks();
    const state = createExecutionState();

    hooks.onExecutionSettled?.(state);
    hooks.onExecutionSettled?.(state);

    expect(mockFinishPipelineExecutionTelemetry).toHaveBeenCalledTimes(1);
    expect(mockFinishPipelineExecutionTelemetry).toHaveBeenCalledWith(state);
    expect(mockWakeLockRelease).toHaveBeenCalledTimes(1);
    expect(mockWakeLockRelease).toHaveBeenCalledWith('pipeline:exec-1');
  });

  it('triggers precommit failure hooks for failed git commit push results', async () => {
    const getWindow = jest.fn<BrowserWindow | null, []>(() => null);
    const postProcess = createDesktopStepPostProcess(getWindow);
    const results = [
      {
        status: 'failed',
        failurePhase: 'commit',
        repoPath: '/repo',
        repoId: 'repo-1',
        repoName: 'Repo 1',
        precommitFailureError: 'precommit failed',
        commitMessage: 'feat: pipeline commit',
      },
      {
        status: 'failed',
        failurePhase: 'push',
        repoPath: '/repo',
        repoName: 'Repo 1',
      },
      {
        status: 'success',
        failurePhase: 'commit',
        repoPath: '/repo',
        repoName: 'Repo 1',
      },
    ];

    await postProcess({
      step: createStep('commit', 'builtin/git-commit-push'),
      outputs: { results_json: JSON.stringify(results) },
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });

    expect(mockTriggerWorktreePrecommitFailureHook).toHaveBeenCalledTimes(1);
    expect(mockTriggerWorktreePrecommitFailureHook).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      repo: {
        repoPath: '/repo',
        repoId: 'repo-1',
        repoName: 'Repo 1',
      },
      error: 'precommit failed',
      commitMessage: 'feat: pipeline commit',
      getWindow,
    });
  });

  it('ignores invalid or irrelevant post-process inputs', async () => {
    const postProcess = createDesktopStepPostProcess();

    await postProcess({
      step: createStep('other', 'builtin/other'),
      outputs: { results_json: '{' },
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    await postProcess({
      step: createStep('commit', 'builtin/git-commit-push'),
      outputs: { results_json: '{' },
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    await postProcess({
      step: createStep('commit', 'builtin/git-commit-push'),
      outputs: { results_json: JSON.stringify({ status: 'failed' }) },
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    await postProcess({
      step: createStep('commit', 'builtin/git-commit-push'),
      outputs: {
        results_json: JSON.stringify([
          {
            status: 'failed',
            failurePhase: 'commit',
            repoPath: '/repo',
          },
        ]),
      },
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });

    expect(mockTriggerWorktreePrecommitFailureHook).not.toHaveBeenCalled();
  });

  it('sends custom notification steps only when the run’s space allows routine activity', async () => {
    const postProcess = createDesktopStepPostProcess();
    const notify = {
      step: createStep('notify', 'builtin/run'),
      outputs: {},
      notifications: [{ title: 'Deploy', body: 'Step finished' }],
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    };
    const policy = (override: 'attention' | 'mute' | null): void =>
      publishSpaceNotificationPolicy({
        ...EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
        accountKey: 'user-1',
        spaces: {
          [spaceNotificationScopeKey({
            projectId: 'project-1',
            worktreeId: 'worktree-1',
          })]: {
            notificationSpaceId: 'space-1',
            revision: 1,
            override,
            transitions: [],
          },
        },
      });

    policy('attention');
    await postProcess(notify);
    policy('mute');
    await postProcess(notify);
    expect(mockShowOsNotification).not.toHaveBeenCalled();

    // Another space, a run with no space, and the default all deliver.
    await postProcess({ ...notify, worktreeId: 'worktree-2' });
    await postProcess({
      ...notify,
      projectId: undefined,
      worktreeId: undefined,
    });
    policy(null);
    await postProcess(notify);
    expect(mockShowOsNotification).toHaveBeenCalledTimes(3);
    publishSpaceNotificationPolicy(EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT);
  });
});
