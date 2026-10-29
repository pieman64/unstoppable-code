import type { OpenExternalFileRequest } from '@canopy/desktop-shared/types';
import {
  getAuthorizedFileRoots,
  type AuthorizedFileRoots,
} from './authorized-file-open';
import {
  assertPathOutsideSharedContainerReplicas,
  assertWritableScope,
} from './read-only-scope';
import { validateAbsolutePath, validateId } from './validation';

/** Fails unless this computer would open the file in its default app. */
export async function assertExternalFileOpenAllowed(
  request: OpenExternalFileRequest,
): Promise<void> {
  if (request.projectId) assertWritableScope(request.projectId);
  validateAbsolutePath(request.absolutePath, 'absolutePath');
  await assertPathOutsideSharedContainerReplicas(request.absolutePath);
}

/**
 * Authorizes reading a file for another computer to open: everything the
 * local open checks, and, when the request names a worktree, the roots the
 * file must be inside. Null roots mean the request named no project, as
 * every unscoped local open does.
 */
export async function authorizeExternalFileRead(
  request: OpenExternalFileRequest,
): Promise<AuthorizedFileRoots | null> {
  await assertExternalFileOpenAllowed(request);
  const { projectId, worktreeId } = request;
  if (projectId === undefined && worktreeId === undefined) return null;
  if (projectId === undefined || worktreeId === undefined) {
    throw new Error(
      'Invalid file scope: projectId and worktreeId must be provided together',
    );
  }
  validateId(projectId, 'projectId');
  validateId(worktreeId, 'worktreeId');
  return getAuthorizedFileRoots({ projectId, worktreeId }, { images: true });
}
