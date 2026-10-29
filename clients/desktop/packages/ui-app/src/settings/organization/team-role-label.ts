import type { OrganizationRole } from '@canopy/protocol/settings';

/**
 * Display labels for organization roles. Kept free of UI-package imports so
 * server components (the invite lander) can use it without pulling the
 * `@canopy/ui-shared/components` barrel, and its client-only hooks, into the
 * server graph.
 */
export const ROLE_LABEL: Record<OrganizationRole, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MEMBER: 'Member',
};
