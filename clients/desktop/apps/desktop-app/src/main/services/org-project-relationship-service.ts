import {
  isOrgProjectPlaceholder,
  type OrgProjectDeepLinkOpenEvent,
} from '@canopy/protocol/org-projects';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type {
  OrgProjectRelationship,
  OrgProjectLinksDecideRequest,
  OrgProjectLinksListResult,
  OrgProjectLinksUnknownReason,
  SidebarItem,
} from '@canopy/desktop-shared/types';
import { getFeatureFlagService } from '../feature-flags';
import { getCanopyCloudCredentials } from '../lib/canopy-cloud-account-store';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import { readAllSidebarItems } from '../lib/sidebar-items';
import { getRemoteUrlStrict } from '../lib/git';
import {
  computeRelationships,
  type PersonalRepository,
} from '../lib/org-project-relationships';
import {
  readOrgProjectLinks,
  dismissOrgProjectLink,
} from '../lib/org-project-links';
import { getOrgProjectCatalogService } from './org-project-catalog-service';

function enabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
  );
}
interface LocalRelationships {
  accountId: string;
  organizationId: string;
  revision: number;
  epoch: number;
  items: SidebarItem[];
  relationships: OrgProjectRelationship[];
}
export type OrgProjectRelationshipResolution =
  | { status: 'resolved'; links: OrgProjectRelationship[] }
  | { status: 'unknown'; reason: OrgProjectLinksUnknownReason }
  | { status: 'ineligible' };
type LocalRelationshipResolution =
  | { status: 'resolved'; value: LocalRelationships }
  | { status: 'unknown'; reason: OrgProjectLinksUnknownReason }
  | { status: 'ineligible' };
function current(
  result: Pick<LocalRelationships, 'epoch' | 'organizationId' | 'revision'>,
): boolean {
  const service = getWorkspaceContextService();
  const state = service.getState();
  return (
    enabled() &&
    service.accountEpoch() === result.epoch &&
    state.revision === result.revision &&
    state.organizations.some(
      (organization): boolean => organization.id === result.organizationId,
    )
  );
}
async function resolveRelationships(
  organizationId: string,
): Promise<LocalRelationshipResolution> {
  if (enabled() === false) return { status: 'ineligible' };
  const contextService = getWorkspaceContextService();
  const { revision, organizations } = contextService.getState();
  // Membership, not role: the privacy property is that this match is computed
  // on this device from this device's inventory, so it can only ever be the
  // viewer's own. An admin with the same repository in Personal has the same
  // duplicate-checkout problem, and role-gating would hand them the duplicate
  // silently. Nothing here reaches an admin-facing surface or the cloud.
  if (
    organizations.some(
      (organization): boolean => organization.id === organizationId,
    ) === false
  )
    return { status: 'ineligible' };
  const guard = {
    epoch: contextService.accountEpoch(),
    organizationId,
    revision,
  };
  let credentials: Awaited<ReturnType<typeof getCanopyCloudCredentials>>;
  try {
    credentials = await getCanopyCloudCredentials();
  } catch {
    return current(guard)
      ? { status: 'unknown', reason: 'credentials-unavailable' }
      : { status: 'unknown', reason: 'context-changed' };
  }
  const accountId = credentials.account?.id;
  if (current(guard) === false)
    return { status: 'unknown', reason: 'context-changed' };
  if (accountId === undefined || accountId.length === 0)
    return { status: 'unknown', reason: 'credentials-unavailable' };
  const context = { kind: 'organization' as const, organizationId };
  const snapshot = getOrgProjectCatalogService().peek(context);
  if (
    snapshot === null ||
    snapshot.stale ||
    snapshot.error === 'unavailable' ||
    snapshot.error === 'access-changed' ||
    snapshot.context !== `org:${organizationId}`
  )
    return { status: 'unknown', reason: 'catalog-unavailable' };
  if (current(guard) === false)
    return { status: 'unknown', reason: 'context-changed' };
  let items: SidebarItem[];
  try {
    ({ items } = await readAllSidebarItems());
  } catch {
    return { status: 'unknown', reason: 'inventory-unavailable' };
  }
  const repositories: PersonalRepository[] = [];
  for (const item of items) {
    if (current(guard) === false)
      return { status: 'unknown', reason: 'context-changed' };
    if (item.type === 'single-repo' && item.owner?.type === undefined) {
      let remoteUrl: string | null;
      try {
        remoteUrl = await getRemoteUrlStrict(item.repoPath);
      } catch {
        return { status: 'unknown', reason: 'remote-unavailable' };
      }
      repositories.push({ id: item.id, type: item.type, remoteUrl });
    }
  }
  if (current(guard) === false)
    return { status: 'unknown', reason: 'context-changed' };
  const catalog = snapshot.projects.filter(
    (project): boolean =>
      project.organizationId === organizationId &&
      isOrgProjectPlaceholder(project),
  );
  return {
    status: 'resolved',
    value: {
      ...guard,
      accountId,
      items,
      relationships: computeRelationships(catalog, repositories),
    },
  };
}

export async function resolveOrgProjectRelationships(
  organizationId: string,
): Promise<OrgProjectRelationshipResolution> {
  const result = await resolveRelationships(organizationId);
  if (result.status !== 'resolved') return result;
  const decisions = await readOrgProjectLinks();
  if (current(result.value) === false)
    return { status: 'unknown', reason: 'context-changed' };
  return {
    status: 'resolved',
    links: result.value.relationships.filter(
      (relationship): boolean =>
        decisions.byAccount[result.value.accountId]?.[
          `${relationship.projectId}:${relationship.personalWorkspaceId}`
        ] === undefined,
    ),
  };
}

/** This response is desktop-only; never add it to a catalog/Portal snapshot. */
export async function listOrgProjectRelationships(): Promise<OrgProjectLinksListResult> {
  const context = getWorkspaceContextService().getState().context;
  if (context.kind !== 'organization') return { status: 'resolved', links: [] };
  const result = await resolveOrgProjectRelationships(context.organizationId);
  return result.status === 'ineligible'
    ? { status: 'resolved', links: [] }
    : result;
}
export async function decideOrgProjectRelationship(
  request: OrgProjectLinksDecideRequest,
): Promise<OrgProjectDeepLinkOpenEvent | null> {
  const context = getWorkspaceContextService().getState().context;
  const result =
    context.kind === 'organization'
      ? await resolveRelationships(context.organizationId)
      : { status: 'ineligible' as const };
  if (
    result.status !== 'resolved' ||
    result.value.relationships.some(
      (relationship): boolean =>
        relationship.projectId === request.projectId &&
        relationship.personalWorkspaceId === request.personalWorkspaceId,
    ) === false ||
    current(result.value) === false
  )
    throw new Error('Project not available');
  if (request.decision === 'dismiss') {
    await dismissOrgProjectLink(
      result.value.accountId,
      request.projectId,
      request.personalWorkspaceId,
    );
    return null;
  }
  await getWorkspaceContextService().setContext(
    { kind: 'organization', organizationId: result.value.organizationId },
    result.value.revision,
  );
  if (current(result.value) === false) throw new Error('Project not available');
  const workspaceId =
    result.value.items.find(
      (item): boolean =>
        item.owner?.type === 'organization' &&
        item.owner.organizationId === result.value.organizationId &&
        item.owner.projectId === request.projectId,
    )?.id ?? null;
  return {
    ok: true,
    organizationId: result.value.organizationId,
    projectId: request.projectId,
    workspaceId,
  };
}

/** Setup keeps a fresh directory even after the member dismisses the notice. */
export async function hasPersonalOrgProjectRelationship(
  projectId: string,
): Promise<boolean> {
  const context = getWorkspaceContextService().getState().context;
  if (context.kind !== 'organization') return false;
  const result = await resolveRelationships(context.organizationId);
  return (
    (result.status === 'resolved' &&
      result.value.relationships.some(
        (relationship): boolean => relationship.projectId === projectId,
      )) ||
    false
  );
}
