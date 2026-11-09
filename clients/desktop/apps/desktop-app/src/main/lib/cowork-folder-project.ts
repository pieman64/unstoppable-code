import { CanopyOperationError } from '@canopy/core-runtime';
import { listCoworkWorkspacesAsChatProjects } from './cowork-workspace-crud';
import { resolveCoworkWorkspaceId } from './cowork-migration-map';
import { resolveProjectSavedOwner } from './project-owner';
import { isOrgCoworkOperationEligible } from './org-cowork-binding-deps';
import { validateId } from './validation';

/** New folder capabilities use saved ownership and live membership, never list order. */
export async function requireCoworkFolderProject(
  projectId: string,
): Promise<string> {
  validateId(projectId, 'projectId');
  const workspaceId = resolveCoworkWorkspaceId(projectId);
  const projects = await listCoworkWorkspacesAsChatProjects(undefined, {
    provisionDefaults: false,
  });
  if (!projects.some((project) => project.id === workspaceId))
    throw new CanopyOperationError({
      kind: 'not_found',
      message: 'Chat project not found',
      retry: { kind: 'never' },
    });
  const owner = await resolveProjectSavedOwner({ projectId: workspaceId });
  if (
    owner.kind === 'none' ||
    owner.kind === 'unknown' ||
    (owner.kind === 'organization' &&
      !(await isOrgCoworkOperationEligible(owner.organizationId, {
        scope: 'membership',
      })))
  )
    throw new CanopyOperationError({
      kind: 'not_found',
      message: 'Chat project not found',
      retry: { kind: 'never' },
    });
  return workspaceId;
}
