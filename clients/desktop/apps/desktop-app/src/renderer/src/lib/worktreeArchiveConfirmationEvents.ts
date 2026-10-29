export const OPEN_WORKTREE_ARCHIVE_CONFIRMATION_EVENT =
  'canopy:worktree-archive-confirmation-open';

export interface WorktreeArchiveConfirmationRequest {
  projectId: string;
  worktreeId: string;
  requestedDeleteBranch: boolean;
  /**
   * Open the confirmation in Archive mode (the retained container is kept
   * until the user deletes it) instead of the default Delete mode (kept for
   * the workspace's retention window).
   */
  lockAfterArchive?: boolean;
}

function isWorktreeArchiveConfirmationRequest(
  value: unknown,
): value is WorktreeArchiveConfirmationRequest {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'projectId' in value &&
    typeof value.projectId === 'string' &&
    'worktreeId' in value &&
    typeof value.worktreeId === 'string' &&
    'requestedDeleteBranch' in value &&
    typeof value.requestedDeleteBranch === 'boolean' &&
    (!('lockAfterArchive' in value) ||
      value.lockAfterArchive === undefined ||
      typeof value.lockAfterArchive === 'boolean')
  );
}

export function requestWorktreeArchiveConfirmation(
  request: WorktreeArchiveConfirmationRequest,
): boolean {
  return !window.dispatchEvent(
    new CustomEvent(OPEN_WORKTREE_ARCHIVE_CONFIRMATION_EVENT, {
      detail: request,
      cancelable: true,
    }),
  );
}

export function subscribeToWorktreeArchiveConfirmationRequests(
  listener: (request: WorktreeArchiveConfirmationRequest) => boolean,
): () => void {
  const handleRequest = (event: Event): void => {
    if (event.defaultPrevented || !(event instanceof CustomEvent)) return;
    const detail: unknown = event.detail;
    if (isWorktreeArchiveConfirmationRequest(detail) && listener(detail)) {
      event.preventDefault();
    }
  };
  window.addEventListener(
    OPEN_WORKTREE_ARCHIVE_CONFIRMATION_EVENT,
    handleRequest,
  );
  return () => {
    window.removeEventListener(
      OPEN_WORKTREE_ARCHIVE_CONFIRMATION_EVENT,
      handleRequest,
    );
  };
}
