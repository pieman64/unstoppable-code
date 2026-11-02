import type {
  CanopyQueryHandler,
  WorkerGitWorktreeHealthGetParams,
  WorkerGitWorktreeHealthGetResult,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import type { CanopyHandlerContext } from '../../runtime/types';
import { WorkerGitScopeError } from './worker-git-branch-list';
import {
  assertWorkerGitServedSelection,
  type WorkerGitServedSelection,
} from './worker-git-selection';
import {
  inspectWorktreeHealth,
  type WorktreeHealthIssue,
  type WorktreeHealthSources,
} from './worktree-health';

/**
 * Host port for `worker.git.worktree.health.get`. The host maps the scope to
 * a worktree from trusted records and supplies its read-only sources; paths
 * never leave the host.
 */
export interface WorkerGitWorktreeHealthHost<
  Worktree,
> extends WorkerGitServedSelection {
  /** Throws {@link WorkerGitScopeError} for a scope it refuses. */
  resolveWorktree(
    params: WorkerGitWorktreeHealthGetParams,
    context: CanopyHandlerContext,
  ): Promise<Worktree>;
  sources(
    worktree: Worktree,
    context: CanopyHandlerContext,
  ): WorktreeHealthSources;
  /**
   * Sees the host's full issue before the canonical result is returned, for
   * the host's own compatibility projection. It never changes the result.
   */
  observe?(worktree: Worktree, issue: WorktreeHealthIssue | null): void;
}

export interface WorkerGitWorktreeHealthHandlers {
  'worker.git.worktree.health.get': CanopyQueryHandler<
    'worker.git.worktree.health.get',
    CanopyHandlerContext
  >;
}

function scopeError(error: WorkerGitScopeError): CanopyOperationError {
  const message = error.message.slice(0, 4_096);
  return new CanopyOperationError(
    error.reason === 'invalid'
      ? {
          kind: 'invalid_argument',
          code: 'worker.git.worktree.invalidScope',
          message,
          retry: { kind: 'never' },
        }
      : {
          kind: 'failed_precondition',
          code: 'worker.git.worktree.scopeUnsupported',
          message,
          retry: { kind: 'never' },
        },
    error.hostCause,
  );
}

/** The canonical result: ids, codes and the check time only. */
export function toWorkerGitWorktreeHealthResult(
  issue: WorktreeHealthIssue | null,
): WorkerGitWorktreeHealthGetResult {
  if (!issue) return { healthy: true };
  return {
    healthy: false,
    issue: {
      code: issue.code,
      checkedAt: issue.checkedAt,
      repoIssues:
        issue.repoIssues?.map(({ repoId, code }) => ({ repoId, code })) ?? null,
    },
  };
}

export function createWorkerGitWorktreeHealthHandlers<Worktree>(
  host: WorkerGitWorktreeHealthHost<Worktree>,
): WorkerGitWorktreeHealthHandlers {
  return {
    'worker.git.worktree.health.get': async (
      params,
      context,
    ): Promise<WorkerGitWorktreeHealthGetResult> => {
      assertWorkerGitServedSelection(params.scope, host);
      let worktree: Worktree;
      try {
        worktree = await host.resolveWorktree(params, context);
      } catch (error) {
        if (error instanceof WorkerGitScopeError) throw scopeError(error);
        throw error;
      }
      const issue = await inspectWorktreeHealth(
        host.sources(worktree, context),
      );
      host.observe?.(worktree, issue);
      return toWorkerGitWorktreeHealthResult(issue);
    },
  };
}
