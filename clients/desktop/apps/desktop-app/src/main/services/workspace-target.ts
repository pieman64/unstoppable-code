import type { ResourceContextDecision } from '@canopy/desktop-shared/lib/resource-context-policy';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import { readAllSidebarItems } from '../lib/sidebar-items';
import { getOrgProjectCatalogService } from './org-project-catalog-service';
import { resolveOrgProjectRelationships } from './org-project-relationship-service';

type WorkspaceTargetFailureReason = Extract<
  Exclude<ResourceContextDecision, { allow: true }>['reason'],
  'unknown-provenance' | 'unsupported-target'
>;

export class WorkspaceTargetResolutionError extends Error {
  constructor(
    public readonly reason: WorkspaceTargetFailureReason,
    public readonly transient?: true,
  ) {
    super(`Workspace target unavailable (${reason})`);
    this.name = 'WorkspaceTargetResolutionError';
  }
}

export interface ResolvedWorkspaceTarget {
  workspaceOwner: WorkspaceContext;
  linkedOrganizationIds: string[];
}

export async function resolveWorkspaceTarget(
  projectId: string,
  options: {
    organizationId?: string;
    /** Trusted persisted owner used by background execution paths. */
    workspaceOwner?: WorkspaceContext;
    /** Trusted workspace kind check; links apply only to Personal single repos. */
    linkedPersonalCandidate?: boolean;
  } = {},
): Promise<ResolvedWorkspaceTarget> {
  let workspaceOwner = options.workspaceOwner;
  let linkedPersonalCandidate = options.linkedPersonalCandidate;
  if (!workspaceOwner) {
    let workspace:
      | Awaited<ReturnType<typeof readAllSidebarItems>>['items'][number]
      | undefined;
    try {
      workspace = (await readAllSidebarItems()).items.find(
        (item) => item.id === projectId,
      );
    } catch {
      throw new WorkspaceTargetResolutionError('unknown-provenance', true);
    }
    if (!workspace)
      throw new WorkspaceTargetResolutionError('unsupported-target');
    linkedPersonalCandidate = workspace.type === 'single-repo';
    workspaceOwner =
      workspace.owner?.type === 'organization'
        ? {
            kind: 'organization',
            organizationId: workspace.owner.organizationId,
          }
        : { kind: 'personal' };
  }

  if (
    workspaceOwner.kind !== 'personal' ||
    !options.organizationId ||
    linkedPersonalCandidate !== true
  )
    return { workspaceOwner, linkedOrganizationIds: [] };

  const organizationContext = {
    kind: 'organization' as const,
    organizationId: options.organizationId,
  };
  const catalog = getOrgProjectCatalogService();
  const snapshot = catalog.peek(organizationContext);
  if (snapshot === null || snapshot.stale) {
    try {
      await catalog.refresh(organizationContext);
    } catch {
      throw new WorkspaceTargetResolutionError('unknown-provenance', true);
    }
  }
  const relationships = await resolveOrgProjectRelationships(
    options.organizationId,
  );
  if (relationships.status === 'unknown')
    throw new WorkspaceTargetResolutionError('unknown-provenance', true);
  const linked =
    relationships.status === 'resolved' &&
    relationships.links.some(
      (relationship) => relationship.personalWorkspaceId === projectId,
    );
  return {
    workspaceOwner,
    linkedOrganizationIds: linked ? [options.organizationId] : [],
  };
}
