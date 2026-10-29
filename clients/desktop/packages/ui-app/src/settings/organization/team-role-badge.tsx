import type { JSX } from 'react';
import {
  StatusBadge,
  type StatusBadgeVariant,
} from '@canopy/ui-shared/components';
import type { OrganizationRole } from '@canopy/protocol/settings';
import { ROLE_LABEL } from './team-role-label';

const ROLE_VARIANT: Record<OrganizationRole, StatusBadgeVariant> = {
  OWNER: 'active',
  ADMIN: 'success',
  MEMBER: 'muted',
};

/** Consistent role chip used across the dashboard panel and `/organization` sections. */
export function TeamRoleBadge({
  role,
}: {
  role: OrganizationRole;
}): JSX.Element {
  return <StatusBadge variant={ROLE_VARIANT[role]} label={ROLE_LABEL[role]} />;
}
