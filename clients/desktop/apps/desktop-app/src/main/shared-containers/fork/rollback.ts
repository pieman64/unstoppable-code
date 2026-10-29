import {
  hideSharedContainerForkWorkspace,
  type SharedContainerForkHideRequest,
} from './fork-metadata';

export interface SharedContainerForkRollback {
  defer(action: () => Promise<unknown>): void;
}

class SharedContainerForkAggregateError extends Error {
  readonly errors: unknown[];

  constructor(errors: unknown[], message: string) {
    super(message);
    this.name = 'AggregateError';
    this.errors = errors;
  }
}

/**
 * Removes a project the fork created; when the deletion fails, hides it
 * through `hideSharedContainerForkWorkspace` (index entry only) and rethrows
 * the deletion error, or both errors when it cannot be hidden either.
 */
export async function deleteForkWorkspaceOrHide(
  fork: SharedContainerForkHideRequest,
  deleteWorkspace: () => Promise<void>,
): Promise<void> {
  try {
    await deleteWorkspace();
  } catch (deletionError) {
    try {
      await hideSharedContainerForkWorkspace(fork);
    } catch (visibilityError) {
      throw new SharedContainerForkAggregateError(
        [deletionError, visibilityError],
        `Failed to delete or hide fork workspace ${fork.workspaceId}`,
      );
    }
    throw deletionError;
  }
}

/** Run a fork transaction and compensate completed stages in reverse order. */
export async function runWithSharedContainerForkRollback<T>(
  operation: (rollback: SharedContainerForkRollback) => Promise<T>,
): Promise<T> {
  const actions: Array<() => Promise<unknown>> = [];
  try {
    return await operation({
      defer: (action): void => {
        actions.push(action);
      },
    });
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const action of actions.reverse()) {
      try {
        await action();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new SharedContainerForkAggregateError(
        [error, ...cleanupErrors],
        'Shared-container fork failed and rollback was incomplete',
      );
    }
    throw error;
  }
}
