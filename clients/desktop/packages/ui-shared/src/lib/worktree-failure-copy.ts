/**
 * Why a worktree could not be prepared, as far as the host verified it.
 * `source-no-commits` means the source branch has no first commit; other
 * branches in the repository may still have commits.
 */
export type WorktreeFailureReason = 'storage-unavailable' | 'source-no-commits';

/** Shown on Home and import rows when the source branch is verified unborn. */
export const SOURCE_NO_COMMITS_HINT = 'No commits on this branch yet';

const PREPARE_FAILED = "Couldn't prepare the worktree.";

/**
 * The one sentence for a failed worktree preparation. Raw Git output stays in
 * the notice's details; this copy never repeats it. `sourceName` is the
 * affected source's display name, when the event identifies it.
 */
export function formatWorktreePrepareFailure({
  reason,
  sourceName,
  hasDetails,
}: {
  reason?: WorktreeFailureReason;
  sourceName?: string;
  hasDetails: boolean;
}): string {
  if (reason === 'source-no-commits') {
    const name = sourceName?.trim();
    const where = name ? `in ${name}` : 'in this project';
    return `${PREPARE_FAILED} The current branch ${where} has no commits yet. Create a first commit on this branch, then send again.`;
  }
  // Copy details is the control every failure with details shows; Show
  // details appears only when the output is long, so the copy names the former.
  return hasDetails
    ? `${PREPARE_FAILED} Check the Git output in Copy details, then try again.`
    : `${PREPARE_FAILED} Try again.`;
}
