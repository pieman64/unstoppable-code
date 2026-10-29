import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getSharedContainersRootDir } from './paths';
import { isPathInside } from './path-safety';

export const READ_ONLY_SCOPE_ERROR =
  'Shared-container recipient workspaces are read-only';

/** Whether a renderer-selected scope may reach a content writer. */
export function isWritableScope(projectId: string): boolean {
  return projectId !== SHARED_CONTAINER_VIEWER_PROJECT_ID;
}

/** Fail closed before a renderer-selected scope reaches any content writer. */
export function assertWritableScope(projectId: string): void {
  if (!isWritableScope(projectId)) {
    throw new Error(READ_ONLY_SCOPE_ERROR);
  }
}

async function canonicalPathOrResolved(pathValue: string): Promise<string> {
  try {
    const canonical = await realpath(pathValue);
    return typeof canonical === 'string' ? canonical : resolve(pathValue);
  } catch {
    return resolve(pathValue);
  }
}

/**
 * Optional-scope shell IPC predates worktree ids, so a compromised renderer
 * can omit them. Reject paths that resolve into the sealed replica store even
 * when no explicit viewer scope was supplied. This is deliberately limited to
 * the replica root: trusted unscoped requests such as feedback-bundle reveals
 * remain supported.
 */
export async function assertPathOutsideSharedContainerReplicas(
  absolutePath: string,
): Promise<void> {
  const [replicaRoot, target] = await Promise.all([
    canonicalPathOrResolved(getSharedContainersRootDir()),
    canonicalPathOrResolved(absolutePath),
  ]);
  if (isPathInside(replicaRoot, target)) {
    throw new Error(READ_ONLY_SCOPE_ERROR);
  }
}
