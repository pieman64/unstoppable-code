/**
 * Eligibility for the renderer's local file actions (reveal in the platform
 * file manager, open in the default app). The request always carries the
 * owning workspace scope so main can canonicalize the path against that
 * workspace's allowed roots; main stays authoritative and these checks only
 * decide whether to offer the action.
 */
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type ShowFilesWorkspaceTarget,
  type ShowInFinderRequest,
} from '@canopy/desktop-shared/types';
import { readRemoteControlContext } from '@/stores/remoteControlStore';

/** Native file actions have no route in a window showing another computer. */
export function isLocalFileActionAvailable(
  action: 'showInFinder' | 'openExternalFile',
): boolean {
  return (
    typeof window !== 'undefined' &&
    readRemoteControlContext().mode !== 'remote' &&
    typeof window.api?.[action] === 'function'
  );
}

export interface LocalFileActionInput {
  /** Absolute path of the file on this device. */
  absolutePath: string | undefined;
  /** Workspace that owns the file; defaults to the surface's own scope. */
  target?: ShowFilesWorkspaceTarget;
  /** Workspace of the surface offering the action. */
  surfaceScope: ShowFilesWorkspaceTarget;
  /** Whether the surface's own scope is read-only. */
  surfaceReadOnly: boolean;
}

function isAbsoluteLocalPath(path: string): boolean {
  return /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path);
}

function sameScope(
  left: ShowFilesWorkspaceTarget,
  right: ShowFilesWorkspaceTarget,
): boolean {
  return (
    left.projectId === right.projectId && left.worktreeId === right.worktreeId
  );
}

/**
 * The scoped request for a local file action, or undefined when the file has
 * no usable local path, its owning scope is incomplete, or that scope is
 * read-only. Permissions follow the owning workspace, not the surface: an
 * App Advisor chip that targets another workspace is judged by that target.
 */
export function resolveLocalFileActionRequest({
  absolutePath,
  target,
  surfaceScope,
  surfaceReadOnly,
}: LocalFileActionInput): ShowInFinderRequest | undefined {
  if (!absolutePath || !isAbsoluteLocalPath(absolutePath)) return undefined;
  const scope = target ?? surfaceScope;
  if (!scope.projectId || !scope.worktreeId) return undefined;
  // A shared-container replica is read-only wherever it is shown.
  if (scope.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) return undefined;
  if (surfaceReadOnly && sameScope(scope, surfaceScope)) return undefined;
  return {
    absolutePath,
    projectId: scope.projectId,
    worktreeId: scope.worktreeId,
  };
}

/**
 * Fixed copy for failed local actions. Main's rejection text is diagnostic
 * (IPC wrappers, raw paths), so it is not shown.
 */
export const REVEAL_FILE_FAILED =
  "Couldn't show this file. It may have been moved or deleted.";
export const OPEN_EXTERNAL_FILE_FAILED =
  "Couldn't open this file in its default app. It may have been moved or deleted.";
