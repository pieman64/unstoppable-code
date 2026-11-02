import { getOrgProjectCatalogService } from '../services/org-project-catalog-service';
import { readWorkspaceOwnership } from './workspace-persistence';

/** Binding publication alone never admits new work in a shared combination. */
export async function assertSharedMultiRepoWorkReady(
  workspaceId: string,
): Promise<void> {
  const read = await readWorkspaceOwnership(workspaceId);
  if (read.authority === 'absent') return;
  if (read.authority !== 'ok')
    throw new Error('Project ownership is unreadable');
  if (read.type !== 'multi-repo' || !read.owner) return;
  const owner = read.owner;
  const catalog = await getOrgProjectCatalogService().list({
    kind: 'organization',
    organizationId: owner.organizationId,
  });
  const project = catalog.projects.find((row) => row.id === owner.projectId);
  if (catalog.stale || catalog.error || !project || !project.capabilities.use)
    throw new Error('Project access could not be checked');
  if (project.memberOwned && project.visibility === 'private') return;
  const { getOrgProjectMaterialization } =
    await import('./org-project-materialization');
  if (await getOrgProjectMaterialization().hasPendingSetup(workspaceId))
    throw new Error('Shared project setup has not finished');
  if (
    project.instance?.id !== owner.instanceId ||
    project.instance.state !== 'READY'
  )
    throw new Error('Shared project setup has not finished');
}
