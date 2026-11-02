/**
 * Worker-safe half of the code-graph worktree fingerprint. The digest lives
 * with the fingerprint host in `@canopy/code-graph/host`; this binds the
 * desktop's Git executable for main-only callers.
 *
 * It must never import `electron`, an Electron-only package, or any
 * main-only module, directly or transitively: the persistence half in
 * `code-graph-worktree-fingerprint.ts` stays main-only, and re-exporting
 * `fingerprintCodeGraphWorktree` from there would pull Electron into a host
 * bundle. `pnpm run check:electron-boundary` enforces this.
 */
import { getGitExecutableCommand } from '@canopy/desktop-shared/lib/git-executable';
import type { CodeGraphRepositoryInput } from '@canopy/desktop-shared/types/code-graph';
import { fingerprintCodeGraphWorktree as fingerprintWithGit } from '@canopy/code-graph/host/worktree-fingerprint';

export { isFileNotFoundError } from '@canopy/code-graph/host/worktree-fingerprint';

export function fingerprintCodeGraphWorktree(
  repositories: readonly CodeGraphRepositoryInput[],
): Promise<string> {
  return fingerprintWithGit(repositories, getGitExecutableCommand(process.env));
}
