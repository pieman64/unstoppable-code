import { CanopyOperationError } from '@canopy/core-runtime';

/** A failed storage read cannot prove that a workspace or chat is gone. */
export function workspaceStorageUnavailable(
  cause?: unknown,
): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'unavailable',
      message:
        'Workspace storage is temporarily unavailable. Try again in a moment.',
      retry: { kind: 'same_request' },
    },
    cause,
  );
}
