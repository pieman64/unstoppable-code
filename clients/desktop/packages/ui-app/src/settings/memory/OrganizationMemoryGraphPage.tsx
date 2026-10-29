'use client';

import type { JSX } from 'react';
import type { SettingsPageProps } from '../pages/page-props';
import { EntityGraphView } from './EntityGraphView';
import { memoryOrganizationId } from './memory-route';
import { OrganizationMemoryLayout } from './OrganizationMemoryLayout';

/**
 * `/organization/[orgId]/memory/graph`. The page data only gates access; the
 * graph payload is read through `organization.memory.graph` and cached per
 * organization and filters, and the force graph loads lazily on the client.
 */
export function OrganizationMemoryGraphPage({
  route,
  page,
}: SettingsPageProps<'organization.memory.graph'>): JSX.Element {
  const orgId = memoryOrganizationId(route);
  const { data } = page;
  return (
    <OrganizationMemoryLayout
      orgId={orgId}
      team={data.team}
      view="graph"
      enabled={data.enabled}
    >
      {data.enabled && <EntityGraphView orgId={orgId} />}
    </OrganizationMemoryLayout>
  );
}
