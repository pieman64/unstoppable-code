import type { SettingsRoute } from '@canopy/protocol/settings';

/** The organization a Memory page belongs to; Memory routes are always organization routes. */
export function memoryOrganizationId(route: SettingsRoute): string {
  if (route.scope !== 'organization') {
    throw new Error('Memory pages render only on organization routes');
  }
  return route.organizationId;
}
