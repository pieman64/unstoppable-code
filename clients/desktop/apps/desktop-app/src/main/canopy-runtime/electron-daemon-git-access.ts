import { resolveWorktreeTargetIds } from '../lib/resolve-worktree';
import { getWorkspaceType } from '../lib/workspace-registry';
import { createDaemonGitRoute, type DaemonGitRoute } from './daemon-git-route';
import {
  getElectronDaemonCallerLifetime,
  getElectronDaemonConnections,
  getElectronDaemonFilesContext,
} from './electron-daemon-access';

let route: DaemonGitRoute | undefined;

/** No production selection or grant yet; constructing the route makes no contact. */
export function getDesktopDaemonGitRoute(): DaemonGitRoute {
  route ??= createDaemonGitRoute({
    lifetime: getElectronDaemonCallerLifetime(),
    connections: getElectronDaemonConnections,
    hostContext: getElectronDaemonFilesContext,
    workspaceType: getWorkspaceType,
    resolveWorktreeTargetIds,
  });
  return route;
}

export function disposeDesktopDaemonGitRoute(): void {
  route?.dispose();
}
