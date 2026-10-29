import { rm } from 'node:fs/promises';
import type { HookDescriptor } from '@canopy/desktop-shared/types';
import type { PersistedPrSnapshotFileV1 } from '@canopy/desktop-shared/types/github';
import {
  appendHookRunLogLines,
  type HookRunLogRef,
} from '../lib/hook-log-store';

let hookRunLogCounter = 0;

jest.mock('../lib/worktree-data-env', () => ({
  buildWorktreeDataEnv: jest.fn(
    (
      projectId: string,
      worktreeId: string,
      env?: NodeJS.ProcessEnv,
    ): NodeJS.ProcessEnv => ({
      ...env,
      CANOPY_WORKSPACE_ID: projectId,
      CANOPY_WORKTREE_NAME: worktreeId,
      CONDUCTOR_WORKSPACE_NAME: worktreeId,
      CANOPY_WORKTREE_DATA_DIR: '/tmp/canopy-hook-runner-test/worktree-data',
    }),
  ),
}));

jest.mock('../lib/hook-log-store', () => ({
  startHookRunLog: jest.fn(() =>
    Promise.resolve({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      hook: {
        hookKey: 'project:pr:create',
        triggerName: 'pr:create',
        label: 'PR Created',
        actions: [{ type: 'command', command: 'echo hook' }],
        target: 'project',
      },
      runId: `run-${++hookRunLogCounter}`,
    }),
  ),
  appendHookRunLogLines: jest.fn(() => Promise.resolve()),
  completeHookRunLog: jest.fn(() => Promise.resolve()),
}));

jest.mock('../lib/paths', () => ({
  getHookInvocationDir: jest.fn(
    (_projectId: string, _worktreeId: string, runId: string) =>
      `/tmp/canopy-hook-runner-test/hook-invocations/${runId}`,
  ),
}));

jest.mock('../lib/script-runner', () => ({
  runShellScript: jest.fn(() =>
    Promise.resolve({
      success: true,
      exitCode: 0,
      output: '',
      timedOut: false,
      durationMs: 5,
    }),
  ),
}));

jest.mock('../lib/hook-chat', () => ({
  launchHookChat: jest.fn(() => Promise.resolve()),
}));

jest.mock('../lib/hook-pipeline', () => ({
  launchHookPipeline: jest.fn(() =>
    Promise.resolve({
      status: 'started',
      pipelineName: 'Review pipeline',
      executionId: 'execution-1',
    }),
  ),
}));

import {
  runHook,
  stopHooksForRepoTarget,
  stopHooksForWorktree,
  stopRunningHook,
} from '../lib/hook-runner';
import { launchHookChat } from '../lib/hook-chat';
import { launchHookPipeline } from '../lib/hook-pipeline';
import { runShellScript } from '../lib/script-runner';

const mockedLaunchHookChat = jest.mocked(launchHookChat);
const mockedLaunchHookPipeline = jest.mocked(launchHookPipeline);
const mockedRunShellScript = jest.mocked(runShellScript);
const mockedAppendHookRunLogLines = jest.mocked(appendHookRunLogLines);

function buildSnapshot(): PersistedPrSnapshotFileV1 {
  return {
    version: 1,
    provider: 'github',
    capturedAt: '2026-04-09T00:00:00.000Z',
    includesComments: true,
    includesReviews: true,
    includesReviewComments: true,
    repository: {
      owner: 'acme',
      name: 'repo',
      fullName: 'acme/repo',
    },
    branch: {
      currentName: 'feature-1',
      headRefName: 'feature-1',
      baseRefName: 'main',
      headSha: 'head',
      baseSha: 'base',
    },
    pr: {
      id: 100,
      number: 42,
      nodeId: 'PR_node',
      htmlUrl: 'https://github.com/acme/repo/pull/42',
      apiUrl: 'https://api.github.com/repos/acme/repo/pulls/42',
      state: 'open',
      isDraft: false,
      title: 'Test PR',
      body: 'Body',
      author: null,
      createdAt: '2026-04-09T00:00:00.000Z',
      updatedAt: '2026-04-09T00:00:00.000Z',
      mergedAt: null,
      closedAt: null,
      mergeCommitSha: null,
      mergedBy: null,
      isCrossRepository: false,
      labels: [],
      assignees: [],
      requestedReviewers: [],
    },
    issueComments: [],
    reviews: [],
    reviewComments: [],
  };
}

describe('hook-runner', () => {
  const hook: HookDescriptor = {
    hookKey: 'project:pr:create',
    triggerName: 'pr:create',
    label: 'PR Created',
    actions: [{ type: 'command', command: 'echo hook' }],
    target: 'project',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockedRunShellScript.mockReset();
    mockedRunShellScript.mockResolvedValue({
      success: true,
      exitCode: 0,
      output: '',
      timedOut: false,
      durationMs: 5,
    });
    mockedLaunchHookChat.mockReset();
    mockedLaunchHookChat.mockResolvedValue(undefined);
    mockedLaunchHookPipeline.mockReset();
    mockedLaunchHookPipeline.mockResolvedValue({
      status: 'started',
      pipelineName: 'Review pipeline',
      executionId: 'execution-1',
    });
    mockedAppendHookRunLogLines.mockReset();
    mockedAppendHookRunLogLines.mockResolvedValue(undefined);
    hookRunLogCounter = 0;
    await rm('/tmp/canopy-hook-runner-test', {
      recursive: true,
      force: true,
    });
  });

  it('passes the human-visible PR number through CANOPY_PR_ID', async () => {
    await runHook({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      hook,
      cwd: '/tmp',
      getWindow: () => null,
      invocation: 'manual',
      currentSnapshot: buildSnapshot(),
      currentSnapshotPath: '/tmp/does-not-exist/current.json',
      previousSnapshotPath: '/tmp/does-not-exist/previous.json',
    });

    expect(mockedRunShellScript).toHaveBeenCalledTimes(1);
    const firstCall = mockedRunShellScript.mock.calls[0]?.[0];
    expect(firstCall?.env?.CANOPY_PR_ID).toBe('42');
    expect(firstCall?.env?.CANOPY_PR_NUMBER).toBe('42');
    expect(firstCall?.env?.CANOPY_PR_BRANCH).toBe('feature-1');
    expect(firstCall?.env?.CANOPY_PR_BASE_BRANCH).toBe('main');
    expect(firstCall?.env?.CANOPY_WORKSPACE_ID).toBe('project-a');
    expect(firstCall?.env?.CANOPY_WORKTREE_NAME).toBe('worktree-a');
    expect(firstCall?.env?.CONDUCTOR_WORKSPACE_NAME).toBe('worktree-a');
    expect(firstCall?.env?.CANOPY_PR_REPO_NAME).toBe('repo');
    expect(firstCall?.env?.CANOPY_PR_REPO_OWNER).toBe('acme');
    expect(firstCall?.env?.CANOPY_PR_URL).toBe(
      'https://github.com/acme/repo/pull/42',
    );
  });

  it('sets the merge queue variables only for the merge queue triggers', async () => {
    const snapshot: PersistedPrSnapshotFileV1 = {
      ...buildSnapshot(),
      mergeQueue: {
        required: true,
        membership: {
          inQueue: true,
          entryId: 'MQE_2',
          phase: 'queued',
          enqueuedAt: null,
          position: 1,
        },
        lastEntered: {
          entryId: 'MQE_2',
          enqueuedAt: null,
          phase: 'queued',
          position: 1,
          reentry: true,
          observedAt: '2026-04-09T00:00:00.000Z',
        },
        lastRemoved: {
          entryId: 'MQE_1',
          removedAt: '2026-04-09T00:00:00.000Z',
          reason: 'failed_checks',
          evidence: 'timeline',
          requeued: true,
          observedAt: '2026-04-09T00:00:00.000Z',
        },
      },
    };
    const run = async (triggerName: string): Promise<NodeJS.ProcessEnv> => {
      mockedRunShellScript.mockClear();
      await runHook({
        projectId: 'project-a',
        worktreeId: 'worktree-a',
        hook: { ...hook, hookKey: `project:${triggerName}`, triggerName },
        cwd: '/tmp',
        getWindow: () => null,
        invocation: 'manual',
        currentSnapshot: snapshot,
        currentSnapshotPath: '/tmp/does-not-exist/current.json',
      });
      return mockedRunShellScript.mock.calls[0]?.[0]?.env ?? {};
    };

    expect(await run('pr:queue:removed')).toMatchObject({
      CANOPY_PR_QUEUE_ENTRY_ID: 'MQE_1',
      CANOPY_PR_QUEUE_REMOVAL_REASON: 'failed_checks',
    });
    expect(await run('pr:queue:entered')).toMatchObject({
      CANOPY_PR_QUEUE_ENTRY_ID: 'MQE_2',
      CANOPY_PR_QUEUE_REMOVAL_REASON: '',
    });
    const other = await run('pr:merged');
    expect(other).not.toHaveProperty('CANOPY_PR_QUEUE_ENTRY_ID');
    expect(other).not.toHaveProperty('CANOPY_PR_QUEUE_REMOVAL_REASON');
  });

  it('accepts a queued hook before the prior target run finishes', async () => {
    let finishFirst: (
      value: Awaited<ReturnType<typeof runShellScript>>,
    ) => void = (): void => undefined;
    mockedRunShellScript.mockReturnValueOnce(
      new Promise((resolve) => {
        finishFirst = resolve;
      }),
    );
    const first = runHook({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      hook,
      cwd: '/tmp',
      getWindow: () => null,
      invocation: 'manual',
    });
    await Promise.resolve();

    const onEnqueued = jest.fn();
    const onStarted = jest.fn();
    const second = runHook({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      hook: { ...hook, hookKey: 'project:pr:update' },
      cwd: '/tmp',
      getWindow: () => null,
      invocation: 'manual',
      onEnqueued,
      onStarted,
    });

    expect(onEnqueued).toHaveBeenCalledTimes(1);
    expect(onStarted).not.toHaveBeenCalled();
    finishFirst({
      success: true,
      exitCode: 0,
      output: '',
      timedOut: false,
      durationMs: 5,
    });
    await first;
    await second;
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it('cancels a queued hook before it starts', async () => {
    let finishFirst: (
      value: Awaited<ReturnType<typeof runShellScript>>,
    ) => void = (): void => undefined;
    mockedRunShellScript.mockReturnValueOnce(
      new Promise((resolve) => {
        finishFirst = resolve;
      }),
    );
    const first = runHook({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      hook,
      cwd: '/tmp',
      getWindow: () => null,
      invocation: 'manual',
    });
    await Promise.resolve();

    const queuedHook = { ...hook, hookKey: 'project:pr:update' };
    const onStarted = jest.fn();
    const queued = runHook({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      hook: queuedHook,
      cwd: '/tmp',
      getWindow: () => null,
      invocation: 'manual',
      onStarted,
    });
    const cancelled = stopRunningHook({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      hookKey: queuedHook.hookKey,
    });
    finishFirst({
      success: true,
      exitCode: 0,
      output: '',
      timedOut: false,
      durationMs: 5,
    });

    await first;
    expect(await queued).toMatchObject({ stopped: true });
    expect(await cancelled).toMatchObject({ stopped: true });
    expect(onStarted).not.toHaveBeenCalled();
    expect(mockedRunShellScript).toHaveBeenCalledTimes(1);
  });

  it('passes hook timeoutSeconds through to command actions', async () => {
    await runHook({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      hook,
      cwd: '/tmp',
      getWindow: () => null,
      invocation: 'manual',
      timeoutSeconds: 600,
      currentSnapshot: buildSnapshot(),
      currentSnapshotPath: '/tmp/does-not-exist/current.json',
    });

    expect(mockedRunShellScript).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutSeconds: 600,
      }),
    );
  });

  it('passes command hook shell through to the script runner', async () => {
    await runHook({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      hook: {
        ...hook,
        actions: [
          {
            type: 'command',
            command: 'echo hook',
            shell: { windows: 'bash', mac: 'zsh' },
          },
        ],
      },
      cwd: '/tmp',
      getWindow: () => null,
      invocation: 'manual',
      currentSnapshot: buildSnapshot(),
      currentSnapshotPath: '/tmp/does-not-exist/current.json',
    });

    expect(mockedRunShellScript).toHaveBeenCalledWith(
      expect.objectContaining({
        shell: { windows: 'bash', mac: 'zsh' },
      }),
    );
  });

  it('runs interactive command hooks in a monitored project terminal', async () => {
    await runHook({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      hook: {
        ...hook,
        label: 'PR Created Interactive Prompt',
        actions: [
          {
            type: 'command',
            command: 'read name',
            interactive: true,
          },
        ],
      },
      cwd: '/tmp',
      getWindow: () => null,
      invocation: 'manual',
      timeoutSeconds: 600,
      currentSnapshot: buildSnapshot(),
      currentSnapshotPath: '/tmp/does-not-exist/current.json',
    });

    expect(mockedRunShellScript).toHaveBeenCalledTimes(1);
    const options = mockedRunShellScript.mock.calls[0]?.[0];
    expect(options?.interactive).toBe(true);
    expect(options?.timeoutSeconds).toBeNull();
    expect(options?.terminalTitle).toBe('PR Created Interactive Prompt');
    expect(options?.tracking).toEqual({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      scriptKey: hook.hookKey,
      kind: 'hook',
    });
  });

  it('reports the active action index while a mixed hook runs', async () => {
    const actionIndexes: number[] = [];
    const onOutput = jest.fn(
      (
        _hook: HookDescriptor,
        _lines: string[],
        _ref?: HookRunLogRef,
        activeActionIndex?: number,
      ): void => {
        if (activeActionIndex !== undefined) {
          actionIndexes.push(activeActionIndex);
        }
      },
    );
    await runHook({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      hook: {
        ...hook,
        actions: [
          { type: 'command', command: 'read name', interactive: true },
          { type: 'command', command: 'echo done' },
        ],
      },
      cwd: '/tmp',
      getWindow: () => null,
      invocation: 'manual',
      currentSnapshot: buildSnapshot(),
      currentSnapshotPath: '/tmp/does-not-exist/current.json',
      onOutput,
    });

    expect(actionIndexes).toContain(0);
    expect(actionIndexes).toContain(1);
  });

  it('dispatches chat actions through the hook chat launcher', async () => {
    await runHook({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      hook: {
        ...hook,
        actions: [
          {
            type: 'chat',
            prompt:
              'Review {{CANOPY_PR_CURRENT_FILE}} in {{CANOPY_WORKTREE_DATA_DIR}}',
            model: 'gpt-6-sol',
            thinking: 'medium',
          },
        ],
      },
      cwd: '/tmp',
      getWindow: () => null,
      invocation: 'manual',
      currentSnapshot: buildSnapshot(),
      currentSnapshotPath: '/tmp/does-not-exist/current.json',
    });

    expect(mockedLaunchHookChat).toHaveBeenCalledTimes(1);
    const firstCall = mockedLaunchHookChat.mock.calls[0];
    if (!firstCall) {
      throw new Error('Expected launchHookChat to be called');
    }
    expect(firstCall[0].projectId).toBe('project-a');
    expect(firstCall[0].worktreeId).toBe('worktree-a');
    expect(firstCall[0].action).toEqual({
      type: 'chat',
      prompt:
        'Review {{CANOPY_PR_CURRENT_FILE}} in {{CANOPY_WORKTREE_DATA_DIR}}',
      model: 'gpt-6-sol',
      thinking: 'medium',
    });
    expect(firstCall[0].prompt).toBe(
      'Review /tmp/canopy-hook-runner-test/hook-invocations/run-1/snapshots/current.json in /tmp/canopy-hook-runner-test/worktree-data',
    );
    expect(typeof firstCall[0].getWindow).toBe('function');
    expect(mockedRunShellScript).not.toHaveBeenCalled();
    const boundaryCall = mockedAppendHookRunLogLines.mock.calls.find(
      ([options]) =>
        options.lines.some(
          (line) =>
            line === '$ [1/1] Chat action (gpt-6-sol)' &&
            !line.includes('Review {{CANOPY_PR_CURRENT_FILE}}'),
        ),
    );
    expect(boundaryCall).toBeDefined();
  });

  it('interpolates the hidden worktree-name alias for chat actions', async () => {
    await runHook({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      hook: {
        ...hook,
        actions: [
          {
            type: 'chat',
            prompt: 'Review {{CONDUCTOR_WORKSPACE_NAME}}',
          },
        ],
      },
      cwd: '/tmp',
      getWindow: () => null,
      invocation: 'manual',
      currentSnapshot: buildSnapshot(),
      currentSnapshotPath: '/tmp/does-not-exist/current.json',
    });

    expect(mockedLaunchHookChat).toHaveBeenCalledTimes(1);
    const firstCall = mockedLaunchHookChat.mock.calls[0];
    if (!firstCall) {
      throw new Error('Expected launchHookChat to be called');
    }

    expect(firstCall[0].prompt).toBe('Review worktree-a');
  });

  it('runs non-PR hooks with event-specific env vars', async () => {
    await runHook({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      hook: {
        hookKey: 'project:worktree:precommit:failure',
        triggerName: 'worktree:precommit:failure',
        label: 'Pre-commit Failure',
        actions: [
          {
            type: 'chat',
            prompt:
              'Explain {{CANOPY_WORKTREE_PRECOMMIT_FAILURE_ERROR}} from {{CANOPY_WORKTREE_PRECOMMIT_FAILURE_COMMIT_MESSAGE}} in {{CANOPY_WORKTREE_NAME}}',
          },
        ],
        target: 'project',
      },
      cwd: '/tmp',
      getWindow: () => null,
      invocation: 'automatic',
      env: {
        CANOPY_WORKTREE_PRECOMMIT_FAILURE_ERROR: 'pre-commit failed',
        CANOPY_WORKTREE_PRECOMMIT_FAILURE_COMMIT_MESSAGE: 'feat: test',
      },
    });

    expect(mockedLaunchHookChat).toHaveBeenCalledTimes(1);
    const firstCall = mockedLaunchHookChat.mock.calls[0];
    if (!firstCall) {
      throw new Error('Expected launchHookChat to be called');
    }
    expect(firstCall[0].prompt).toBe(
      'Explain pre-commit failed from feat: test in worktree-a',
    );
  });

  it('dispatches pipeline actions with hook trigger source metadata', async () => {
    await runHook({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      hook: {
        ...hook,
        actions: [
          {
            type: 'pipeline',
            source: 'bundled',
            id: 'review',
            inputs: {
              pr_url: '{{CANOPY_PR_URL}}',
            },
          },
        ],
      },
      cwd: '/tmp',
      getWindow: () => null,
      invocation: 'manual',
      currentSnapshot: buildSnapshot(),
      currentSnapshotPath: '/tmp/does-not-exist/current.json',
    });

    expect(mockedLaunchHookPipeline).toHaveBeenCalledTimes(1);
    const firstCall = mockedLaunchHookPipeline.mock.calls[0];
    if (!firstCall) {
      throw new Error('Expected launchHookPipeline to be called');
    }

    expect(firstCall[0].action).toEqual({
      type: 'pipeline',
      source: 'bundled',
      id: 'review',
      inputs: {
        pr_url: '{{CANOPY_PR_URL}}',
      },
    });
    expect(firstCall[0].cwd).toBe('/tmp');
    expect(firstCall[0].projectId).toBe('project-a');
    expect(firstCall[0].worktreeId).toBe('worktree-a');
    expect(firstCall[0].triggerSource).toMatchObject({
      kind: 'hook',
      hook_key: 'project:pr:create',
      hook_label: 'PR Created',
      trigger_name: 'pr:create',
      target: 'project',
      action_index: 0,
    });
    expect(firstCall[0].triggerSource.triggered_at).toEqual(expect.any(String));
    expect(firstCall[0].env.CANOPY_PR_URL).toBe(
      'https://github.com/acme/repo/pull/42',
    );
  });

  it('continues to later hook actions after pipeline start or queue success', async () => {
    mockedLaunchHookPipeline.mockResolvedValueOnce({
      status: 'queued',
      pipelineName: 'Review pipeline',
      queueId: 'queued-pipeline-1',
    });

    const result = await runHook({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      hook: {
        ...hook,
        actions: [
          {
            type: 'pipeline',
            source: 'bundled',
            id: 'review',
          },
          {
            type: 'command',
            command: 'echo later',
          },
        ],
      },
      cwd: '/tmp',
      getWindow: () => null,
      invocation: 'manual',
      currentSnapshot: buildSnapshot(),
      currentSnapshotPath: '/tmp/does-not-exist/current.json',
    });

    expect(result.success).toBe(true);
    expect(mockedLaunchHookPipeline).toHaveBeenCalledTimes(1);
    expect(mockedRunShellScript).toHaveBeenCalledTimes(1);
    expect(mockedRunShellScript.mock.calls[0]?.[0].script).toBe('echo later');
  });

  it('fails the hook when pipeline validation or start fails', async () => {
    mockedLaunchHookPipeline.mockRejectedValueOnce(
      new Error('Pipeline "Review" does not define a dispatch trigger'),
    );

    const result = await runHook({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      hook: {
        ...hook,
        actions: [
          {
            type: 'pipeline',
            source: 'bundled',
            id: 'review',
          },
          {
            type: 'command',
            command: 'echo should-not-run',
          },
        ],
      },
      cwd: '/tmp',
      getWindow: () => null,
      invocation: 'manual',
      currentSnapshot: buildSnapshot(),
      currentSnapshotPath: '/tmp/does-not-exist/current.json',
    });

    expect(result.success).toBe(false);
    expect(result.output).toBe(
      'Pipeline "Review" does not define a dispatch trigger',
    );
    expect(mockedRunShellScript).not.toHaveBeenCalled();
  });

  it('stops a chat action when if-command exits 2', async () => {
    mockedRunShellScript.mockResolvedValueOnce({
      success: false,
      exitCode: 2,
      output: '',
      timedOut: false,
      durationMs: 5,
    });

    const result = await runHook({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      hook: {
        ...hook,
        actions: [
          {
            type: 'chat',
            prompt: 'Review changes',
            'if-command': 'test -f "$CANOPY_PR_CURRENT_FILE"',
          },
          { type: 'command', command: 'echo should-not-run' },
        ],
      },
      cwd: '/tmp',
      getWindow: () => null,
      invocation: 'manual',
      currentSnapshot: buildSnapshot(),
      currentSnapshotPath: '/tmp/does-not-exist/current.json',
    });

    expect(result.success).toBe(false);
    expect(result.stopped).toBe(true);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('intentionally stopped');
    expect(mockedLaunchHookChat).not.toHaveBeenCalled();
    expect(mockedRunShellScript).toHaveBeenCalledTimes(1);
  });

  it('fails the hook when if-command exits non-zero', async () => {
    mockedRunShellScript.mockResolvedValueOnce({
      success: false,
      exitCode: 1,
      output: '',
      timedOut: false,
      durationMs: 5,
    });

    const result = await runHook({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      hook: {
        ...hook,
        actions: [
          {
            type: 'chat',
            prompt: 'Review changes',
            'if-command': 'exit 1',
          },
        ],
      },
      cwd: '/tmp',
      getWindow: () => null,
      invocation: 'manual',
      currentSnapshot: buildSnapshot(),
      currentSnapshotPath: '/tmp/does-not-exist/current.json',
    });

    expect(result.success).toBe(false);
    expect(result.stopped).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.output).toBe('Chat if-command failed with exit code 1.');
    expect(mockedLaunchHookChat).not.toHaveBeenCalled();
  });

  it('preserves stopped status when the if-command is cancelled', async () => {
    mockedRunShellScript.mockResolvedValueOnce({
      success: false,
      exitCode: null,
      output: 'cancelled',
      timedOut: false,
      durationMs: 5,
    });

    const result = await runHook({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      hook: {
        ...hook,
        actions: [
          {
            type: 'chat',
            prompt: 'Review changes',
            'if-command': 'sleep 10',
          },
        ],
      },
      cwd: '/tmp',
      getWindow: () => null,
      invocation: 'manual',
      currentSnapshot: buildSnapshot(),
      currentSnapshotPath: '/tmp/does-not-exist/current.json',
    });

    expect(result.success).toBe(false);
    expect(result.stopped).toBe(true);
    expect(result.exitCode).toBe(null);
    expect(result.output).toBe('cancelled');
    expect(mockedLaunchHookChat).not.toHaveBeenCalled();
  });

  it('labels timed out if-commands accurately when they produce no output', async () => {
    mockedRunShellScript.mockResolvedValueOnce({
      success: false,
      exitCode: null,
      output: '',
      timedOut: true,
      durationMs: 5,
    });

    const result = await runHook({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      hook: {
        ...hook,
        actions: [
          {
            type: 'chat',
            prompt: 'Review changes',
            'if-command': 'sleep 999',
          },
        ],
      },
      cwd: '/tmp',
      getWindow: () => null,
      invocation: 'manual',
      currentSnapshot: buildSnapshot(),
      currentSnapshotPath: '/tmp/does-not-exist/current.json',
    });

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.stopped).toBe(false);
    expect(result.output).toBe('Chat if-command timed out.');
    expect(mockedLaunchHookChat).not.toHaveBeenCalled();
  });

  it('labels cancelled if-commands accurately when they produce no output', async () => {
    mockedRunShellScript.mockResolvedValueOnce({
      success: false,
      exitCode: null,
      output: '',
      timedOut: false,
      durationMs: 5,
    });

    const result = await runHook({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      hook: {
        ...hook,
        actions: [
          {
            type: 'chat',
            prompt: 'Review changes',
            'if-command': 'sleep 10',
          },
        ],
      },
      cwd: '/tmp',
      getWindow: () => null,
      invocation: 'manual',
      currentSnapshot: buildSnapshot(),
      currentSnapshotPath: '/tmp/does-not-exist/current.json',
    });

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.stopped).toBe(true);
    expect(result.output).toBe(
      'Chat if-command was cancelled before completion.',
    );
    expect(mockedLaunchHookChat).not.toHaveBeenCalled();
  });

  it('does not dispatch pipeline actions after repo-target cancellation', async () => {
    const repoHook: HookDescriptor = {
      hookKey: 'workspace-repo:repo-1:pr:create',
      triggerName: 'pr:create',
      label: 'PR Created',
      actions: [
        {
          type: 'pipeline',
          source: 'bundled',
          id: 'review',
        },
      ],
      target: 'workspace-repo',
      repoId: 'repo-1',
      repoName: 'Repo 1',
    };

    const result = await runHook({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      hook: repoHook,
      cwd: '/tmp',
      getWindow: () => null,
      invocation: 'automatic',
      currentSnapshot: buildSnapshot(),
      currentSnapshotPath: '/tmp/does-not-exist/current.json',
      onOutput: (activeHook, lines): void => {
        if (
          activeHook.hookKey === repoHook.hookKey &&
          lines.some((line) =>
            line.includes('$ [1/1] Pipeline action (bundled/review)'),
          )
        ) {
          void stopHooksForRepoTarget({
            projectId: 'project-a',
            worktreeId: 'worktree-a',
            repoId: 'repo-1',
          });
        }
      },
    });

    expect(result).toMatchObject({
      success: false,
      stopped: true,
      exitCode: null,
      output: 'Hook run cancelled.',
    });
    expect(mockedLaunchHookPipeline).not.toHaveBeenCalled();
  });

  it('cancels queued runs for a repo target before they execute', async () => {
    let markFirstRunStarted: (() => void) | undefined;
    const firstRunStarted = new Promise<void>((resolve) => {
      markFirstRunStarted = resolve;
    });
    let resolveFirstRun:
      | ((value: {
          success: boolean;
          exitCode: number | null;
          output: string;
          timedOut: boolean;
          durationMs: number;
        }) => void)
      | undefined;
    const firstRunResult = new Promise<{
      success: boolean;
      exitCode: number | null;
      output: string;
      timedOut: boolean;
      durationMs: number;
    }>((resolve) => {
      resolveFirstRun = resolve;
    });

    mockedRunShellScript
      .mockImplementationOnce(() => {
        markFirstRunStarted?.();
        return firstRunResult;
      })
      .mockImplementationOnce(() =>
        Promise.resolve({
          success: true,
          exitCode: 0,
          output: 'should not run',
          timedOut: false,
          durationMs: 1,
        }),
      );

    const repoHook: HookDescriptor = {
      hookKey: 'workspace-repo:repo-1:pr:create',
      triggerName: 'pr:create',
      label: 'PR Created',
      actions: [{ type: 'command', command: 'echo hook' }],
      target: 'workspace-repo',
      repoId: 'repo-1',
      repoName: 'Repo 1',
    };

    const firstRun = runHook({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      hook: repoHook,
      cwd: '/tmp',
      getWindow: () => null,
      invocation: 'automatic',
      currentSnapshot: buildSnapshot(),
      currentSnapshotPath: '/tmp/does-not-exist/current.json',
    });
    await firstRunStarted;
    const secondRun = runHook({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      hook: repoHook,
      cwd: '/tmp',
      getWindow: () => null,
      invocation: 'automatic',
      currentSnapshot: buildSnapshot(),
      currentSnapshotPath: '/tmp/does-not-exist/current.json',
    });

    const stopPromise = stopHooksForRepoTarget({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      repoId: 'repo-1',
    });
    resolveFirstRun?.({
      success: false,
      exitCode: null,
      output: 'cancelled',
      timedOut: false,
      durationMs: 1,
    });

    await stopPromise;
    await firstRun;
    await expect(secondRun).resolves.toEqual({
      success: false,
      stopped: true,
      exitCode: null,
      output: 'Hook run cancelled before start.',
      timedOut: false,
      durationMs: 0,
    });
    expect(mockedRunShellScript).toHaveBeenCalledTimes(1);
  });

  it('cancels queued runs and awaits active hooks for a worktree', async () => {
    let markFirstRunStarted: (() => void) | undefined;
    const firstRunStarted = new Promise<void>((resolve) => {
      markFirstRunStarted = resolve;
    });
    let resolveFirstRun:
      | ((value: Awaited<ReturnType<typeof runShellScript>>) => void)
      | undefined;
    mockedRunShellScript.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstRun = resolve;
          markFirstRunStarted?.();
        }),
    );

    const firstRun = runHook({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      hook,
      cwd: '/tmp',
      getWindow: () => null,
      invocation: 'automatic',
    });
    await firstRunStarted;
    const secondRun = runHook({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      hook: { ...hook, hookKey: 'project:pr:update' },
      cwd: '/tmp',
      getWindow: () => null,
      invocation: 'automatic',
    });

    const stopPromise = stopHooksForWorktree({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
    });
    let stopped = false;
    void stopPromise.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    resolveFirstRun?.({
      success: false,
      exitCode: null,
      output: 'cancelled',
      timedOut: false,
      durationMs: 1,
    });

    await stopPromise;
    await firstRun;
    await expect(secondRun).resolves.toMatchObject({
      stopped: true,
      output: 'Hook run cancelled before start.',
    });
    expect(mockedRunShellScript).toHaveBeenCalledTimes(1);
  });
});
