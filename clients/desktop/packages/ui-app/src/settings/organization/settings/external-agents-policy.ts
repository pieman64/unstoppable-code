import type { OrganizationDetail } from '@canopy/protocol/settings/organization';

/**
 * Whether the viewer manages members' outside agents here: the hosted MCP
 * servers are on, the viewer is an OWNER, and the organization is not
 * Personal. The card stays reachable while the organization is lapsed.
 */
export function canManageOrganizationExternalAgents(
  detail: OrganizationDetail,
  externalAgentsEnabled: boolean,
): boolean {
  return (
    externalAgentsEnabled &&
    detail.viewerRole === 'OWNER' &&
    detail.isPersonal !== true
  );
}
