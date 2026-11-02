import {
  estimateGitUntrackedChanges,
  GIT_UNTRACKED_ESTIMATE_MAX_FILE_BYTES,
  GIT_UNTRACKED_ESTIMATE_MAX_FILES,
  type GitUntrackedEstimate,
} from '@canopy/core-runtime/node/git';

/**
 * Files larger than this are skipped so artifacts cannot inflate line counts
 * or stall the changed-files projection.
 */
export const MAX_UNTRACKED_FILE_BYTES = GIT_UNTRACKED_ESTIMATE_MAX_FILE_BYTES;
export const MAX_UNTRACKED_FILES = GIT_UNTRACKED_ESTIMATE_MAX_FILES;

/** One untracked file's estimated added lines, and whether it is binary. */
export type UntrackedChange = GitUntrackedEstimate;

/**
 * Line counts for untracked files, which `git diff --numstat` never lists
 * because they have no HEAD side. Every changed-files surface (the desktop
 * activity panel, the Portal `changed_files` entity read by web and mobile)
 * uses this so an added file shows `+N` like a tracked one.
 *
 * Unreadable files count as 0 rather than failing the whole listing.
 */
export async function estimateUntrackedInsertions(
  worktreePath: string,
  files: readonly string[],
): Promise<number[]> {
  return (await estimateUntrackedChanges(worktreePath, files)).map(
    (change) => change.insertions,
  );
}

/**
 * {@link estimateUntrackedInsertions} with each file's binary classification,
 * so a changed-files row can say "Binary" instead of a line count (REG-3024).
 * The estimate is the daemon host's, read here without its confinement.
 */
export function estimateUntrackedChanges(
  worktreePath: string,
  files: readonly string[],
): Promise<UntrackedChange[]> {
  return estimateGitUntrackedChanges(worktreePath, files);
}
