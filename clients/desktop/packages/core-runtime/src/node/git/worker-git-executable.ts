import type {
  CanopyQueryHandler,
  WorkerGitExecutableGetResult,
  WorkerGitExecutableIssue,
  WorkerGitExecutableSource,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import type { CanopyHandlerContext } from '../../runtime/types';
import {
  assertWorkerGitServedSelection,
  type WorkerGitServedSelection,
} from './worker-git-selection';

/** What the host's detection reported; its path and message stay on the host. */
export interface WorkerGitExecutableObservation {
  readonly status: {
    readonly platform: string;
    readonly required: boolean;
    readonly ready: boolean;
    readonly version: string | null;
    readonly source: WorkerGitExecutableSource;
    readonly wingetAvailable: boolean;
    readonly checkedAt: string;
  };
  /** Why the status is not ready; ignored when it is. */
  readonly issue: WorkerGitExecutableIssue | null;
}

/**
 * Host port for `worker.git.executable.get`. The host detects Git with its
 * own preference, environment and filesystem; the handler sees only the
 * observation.
 */
export interface WorkerGitExecutableHost extends WorkerGitServedSelection {
  detect(
    request: { readonly recheck: boolean },
    context: CanopyHandlerContext,
  ): Promise<WorkerGitExecutableObservation>;
}

export interface WorkerGitExecutableHandlers {
  'worker.git.executable.get': CanopyQueryHandler<
    'worker.git.executable.get',
    CanopyHandlerContext
  >;
}

export function createWorkerGitExecutableHandlers(
  host: WorkerGitExecutableHost,
): WorkerGitExecutableHandlers {
  return {
    'worker.git.executable.get': async (
      { scope, recheck },
      context,
    ): Promise<WorkerGitExecutableGetResult> => {
      assertWorkerGitServedSelection(scope, host);
      let observation: WorkerGitExecutableObservation;
      try {
        observation = await host.detect({ recheck }, context);
      } catch (error) {
        if (error instanceof CanopyOperationError) throw error;
        // The cause stays the runtime cause for in-process projections.
        throw new CanopyOperationError(
          {
            kind: 'internal',
            code: 'worker.git.executable.detectionFailed',
            message: 'Git executable detection failed.',
            retry: { kind: 'never' },
          },
          error,
        );
      }
      const { status, issue } = observation;
      return {
        platform: status.platform,
        required: status.required,
        ready: status.ready,
        version: status.version,
        source: status.source,
        wingetAvailable: status.wingetAvailable,
        checkedAt: status.checkedAt,
        issue: status.ready ? null : (issue ?? 'not-found'),
      };
    },
  };
}
