import type { JSX } from 'react';
import { Badge } from '@canopy/ui-shared/components/Badge';
import type { OrganizationRole } from '@canopy/protocol/settings';
import { ROLE_LABEL } from './team-role-label';

/**
 * Consistent role badge used across the dashboard panel and `/organization`
 * sections. Roles are identity, not run states, so every role is the neutral
 * Badge.
 */
export function TeamRoleBadge({
  role,
}: {
  role: OrganizationRole;
}): JSX.Element {
  return <Badge>{ROLE_LABEL[role]}</Badge>;
}
