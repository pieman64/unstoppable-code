import {
  gitRemoteEndpoint,
  type CanopyQueryHandler,
  type WorkerGitRemoteGetParams,
  type WorkerGitRemoteGetResult,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import type { CanopyHandlerContext } from '../../runtime/types';
import {
  assertWorkerGitServedSelection,
  type WorkerGitServedSelection,
} from './worker-git-selection';
import { WorkerGitScopeError } from './worker-git-branch-list';

export interface WorkerGitRemoteReads {
  /**
   * `origin`'s URL, or `null` when the repository lists no `origin`. Rejects
   * when Git cannot read the remote configuration.
   */
  readOriginUrl(): Promise<string | null>;
  /** Whether the location is inside a Git repository; never rejects. */
  isRepository(): Promise<boolean>;
}

/**
 * Host port for `worker.git.remote.get`. The host maps the scope to a
 * repository from trusted records and supplies read-only Git reads for it;
 * repository handles and paths never leave the host.
 */
export interface WorkerGitRemoteHost<
  Repository,
> extends WorkerGitServedSelection {
  /** `null` when the workspace records no such repository. */
  resolveRepository(
    params: WorkerGitRemoteGetParams,
    context: CanopyHandlerContext,
  ): Promise<Repository | null>;
  reads(
    repository: Repository,
    context: CanopyHandlerContext,
  ): WorkerGitRemoteReads;
}

export interface WorkerGitRemoteHandlers {
  'worker.git.remote.get': CanopyQueryHandler<
    'worker.git.remote.get',
    CanopyHandlerContext
  >;
}

function refused(
  kind: 'invalid_argument' | 'failed_precondition',
  code:
    | 'worker.git.remote.invalidScope'
    | 'worker.git.remote.repositoryUnavailable'
    | 'worker.git.remote.notRepository',
  message: string,
  cause?: unknown,
): CanopyOperationError {
  return new CanopyOperationError(
    { kind, code, message: message.slice(0, 4_096), retry: { kind: 'never' } },
    cause,
  );
}

function assertScopeShape({
  scope,
  repository,
}: WorkerGitRemoteGetParams): void {
  if (!scope.workspaceId)
    throw refused(
      'invalid_argument',
      'worker.git.remote.invalidScope',
      'A workspace is required.',
    );
  if (scope.worktreeId !== undefined)
    throw refused(
      'invalid_argument',
      'worker.git.remote.invalidScope',
      'A workspace repository takes no worktree.',
    );
  if (repository.kind === 'source' && scope.repoId !== undefined)
    throw refused(
      'invalid_argument',
      'worker.git.remote.invalidScope',
      'The source repository takes no repository.',
    );
}

export function createWorkerGitRemoteHandlers<Repository>(
  host: WorkerGitRemoteHost<Repository>,
): WorkerGitRemoteHandlers {
  return {
    'worker.git.remote.get': async (
      params,
      context,
    ): Promise<WorkerGitRemoteGetResult> => {
      assertScopeShape(params);
      assertWorkerGitServedSelection(params.scope, host);
      let repository: Repository | null;
      try {
        repository = await host.resolveRepository(params, context);
      } catch (error) {
        if (error instanceof WorkerGitScopeError)
          throw refused(
            error.reason === 'invalid'
              ? 'invalid_argument'
              : 'failed_precondition',
            error.reason === 'invalid'
              ? 'worker.git.remote.invalidScope'
              : 'worker.git.remote.repositoryUnavailable',
            error.message,
            error.hostCause,
          );
        throw error;
      }
      if (repository === null)
        throw refused(
          'failed_precondition',
          'worker.git.remote.repositoryUnavailable',
          'The workspace records no such repository.',
        );
      const reads = host.reads(repository, context);
      // `cause` is the failed read; a location that lists no origin and is no
      // repository has none.
      const notRepository = (cause?: unknown): CanopyOperationError =>
        refused(
          'failed_precondition',
          'worker.git.remote.notRepository',
          'The selected location is not a Git repository.',
          cause,
        );
      let url: string | null;
      try {
        url = await reads.readOriginUrl();
      } catch (error) {
        if (!(await reads.isRepository())) throw notRepository(error);
        throw new CanopyOperationError(
          {
            kind: 'internal',
            message: 'Git could not read the remote configuration.',
            retry: { kind: 'never' },
          },
          error,
        );
      }
      if (url !== null)
        return {
          origin: {
            state: 'configured',
            // A local remote's URL can name a host path and userinfo can
            // carry a token, so both stay with the host; projections that
            // need the URL Git printed read it in the host port.
            endpoint: gitRemoteEndpoint(url),
          },
        };
      if (!(await reads.isRepository())) throw notRepository();
      return { origin: { state: 'absent' } };
    },
  };
}
