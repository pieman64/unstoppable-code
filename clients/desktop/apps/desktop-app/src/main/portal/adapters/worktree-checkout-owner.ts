import { isAbsolute, relative, resolve, sep } from 'node:path';
import { getWorktreeDir } from '../../lib/paths';
import { validateId } from '../../lib/validation';
import { readWorkspaceWorktrees } from '../../lib/workspace-persistence';

/** True when `checkoutPath` is `worktreePath` or a directory inside it. */
export function containsCheckoutPath(
  worktreePath: string,
  checkoutPath: string,
): boolean {
  const withinWorktree = relative(resolve(worktreePath), resolve(checkoutPath));
  return (
    withinWorktree === '' ||
    (withinWorktree !== '..' &&
      !withinWorktree.startsWith(`..${sep}`) &&
      !isAbsolute(withinWorktree))
  );
}

/**
 * The project worktree whose directory holds a Git checkout, or for a
 * multi-repository project contains it. The main checkout, or a directory
 * Canopy does not manage, gives none.
 */
export async function findManagedCheckoutWorktreeId(
  workspaceId: string,
  checkoutPath: string,
): Promise<string | undefined> {
  if (!isAbsolute(checkoutPath)) return undefined;
  try {
    const worktrees = await readWorkspaceWorktrees(workspaceId);
    for (const worktree of worktrees) {
      try {
        validateId(worktree.id, 'worktreeId');
      } catch {
        continue;
      }
      if (
        containsCheckoutPath(
          getWorktreeDir(workspaceId, worktree.id),
          checkoutPath,
        )
      ) {
        return worktree.id;
      }
    }
  } catch {
    // A lookup failure must not replace the typed, path-free refusal.
  }
  return undefined;
}
