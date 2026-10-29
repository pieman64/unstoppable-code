import type { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import type {
  ExecutionLifecycleHooks,
  StepPostProcessContext,
} from '@canopy/desktop-shared/node/pipelines/executor/types';
import { getWakeLockService } from '../power/wake-lock-service';
import {
  finishPipelineExecutionTelemetry,
  startPipelineExecutionTelemetry,
} from './instrumentation';
import { showOsNotification } from '../ipc/os-notifications';
import { isSpaceNotificationDeliverable } from '../lib/space-notification-gate';

export function createDesktopLifecycleHooks(): ExecutionLifecycleHooks {
  const settled = new Set<string>();

  return {
    onExecutionStart: (state): void => {
      getWakeLockService().acquire(
        `pipeline:${state.id}`,
        'pipeline execution',
      );
      startPipelineExecutionTelemetry(state);
    },
    onExecutionSettled: (state): void => {
      if (settled.has(state.id)) {
        return;
      }
      settled.add(state.id);
      finishPipelineExecutionTelemetry(state);
      getWakeLockService().release(`pipeline:${state.id}`);
    },
  };
}

interface GitCommitPushRepoOutput {
  repoId?: string;
  repoName?: string;
  repoPath?: string;
  status?: string;
  error?: string;
  failurePhase?: string;
  precommitFailureError?: string;
  commitMessage?: string;
}

function parseGitCommitPushResults(
  outputs: Record<string, string>,
): GitCommitPushRepoOutput[] {
  const rawResults = outputs.results_json;
  if (!rawResults) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(rawResults);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry): entry is GitCommitPushRepoOutput =>
        typeof entry === 'object' && entry !== null,
    );
  } catch {
    return [];
  }
}

export function createDesktopStepPostProcess(
  getWindow?: () => BrowserWindow | null,
): (ctx: StepPostProcessContext) => Promise<void> {
  return async (ctx) => {
    // A custom notification step carries no typed attention or failure
    // reason, so it is routine activity in the run's space (CAN-3615).
    const notifications =
      !ctx.projectId ||
      !ctx.worktreeId ||
      isSpaceNotificationDeliverable(
        { projectId: ctx.projectId, worktreeId: ctx.worktreeId },
        'routine',
      )
        ? (ctx.notifications ?? [])
        : [];
    for (const notification of notifications) {
      showOsNotification(
        {
          id: `pipeline-${randomUUID()}`,
          title: notification.title,
          body: notification.body,
        },
        () => getWindow?.() ?? null,
      );
    }

    if (
      ctx.step.uses !== 'builtin/git-commit-push' ||
      !ctx.projectId ||
      !ctx.worktreeId
    ) {
      return;
    }

    const failedCommitResults = parseGitCommitPushResults(ctx.outputs).filter(
      (result) =>
        result.status === 'failed' &&
        result.failurePhase === 'commit' &&
        typeof result.repoPath === 'string' &&
        typeof result.repoName === 'string',
    );

    if (failedCommitResults.length === 0) {
      return;
    }

    const { triggerWorktreePrecommitFailureHook } =
      await import('../lib/worktree-precommit-failure-hook');

    await Promise.all(
      failedCommitResults.map((result) =>
        triggerWorktreePrecommitFailureHook({
          projectId: ctx.projectId ?? '',
          worktreeId: ctx.worktreeId ?? '',
          repo: {
            repoPath: result.repoPath ?? '',
            repoId: result.repoId,
            repoName: result.repoName ?? '',
          },
          error: result.precommitFailureError ?? result.error ?? '',
          commitMessage: result.commitMessage,
          getWindow,
        }).catch(() => {}),
      ),
    );
  };
}
