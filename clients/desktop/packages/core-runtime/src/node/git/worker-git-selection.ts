import { CanopyOperationError } from '../../runtime/errors';

/**
 * The authority and target a `worker.git.*` host serves. A scope that selects
 * any other is refused before the host resolves or runs anything.
 */
export interface WorkerGitServedSelection {
  readonly authorityId: string;
  readonly targetId?: string;
}

/**
 * Refuses a scope that selects another authority or target before any Git
 * runs. Without an enrolled target registry a host never reinterprets a
 * remote selection as its own machine.
 */
export function assertWorkerGitServedSelection(
  scope: { readonly authorityId?: string; readonly targetId?: string },
  host: WorkerGitServedSelection,
): void {
  if (
    (scope.authorityId !== undefined &&
      scope.authorityId !== host.authorityId) ||
    (scope.targetId !== undefined && scope.targetId !== host.targetId)
  )
    throw new CanopyOperationError({
      kind: 'capability_unavailable',
      message: 'The selected Git authority or target is unavailable.',
      retry: { kind: 'never' },
    });
}
