import {
  createWorkspaceManifestRepository as createCoreWorkspaceManifestRepository,
  type WorkspaceManifestRepository as CoreWorkspaceManifestRepository,
  type WorkspaceManifestRepositoryDeps,
} from '@canopy/core-runtime/node/w5/workspace-manifest-repository';
import type { WorkspaceConfigFile } from '@canopy/desktop-shared/types';

export {
  WorkspaceConfigUnreadableError,
  type WorkspaceManifestRead,
  type WorkspaceManifestRepositoryDeps,
} from '@canopy/core-runtime/node/w5/workspace-manifest-repository';

export type WorkspaceManifestRepository =
  CoreWorkspaceManifestRepository<WorkspaceConfigFile>;

/** The desktop `<data>/workspaces/{id}/workspace.json` repository (CAN-3800). */
export function createWorkspaceManifestRepository(
  deps: WorkspaceManifestRepositoryDeps,
): WorkspaceManifestRepository {
  return createCoreWorkspaceManifestRepository<WorkspaceConfigFile>(deps);
}
