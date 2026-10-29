'use client';

import type { JSX } from 'react';
import type { SettingsPageProps } from '../pages/page-props';
import { memoryOrganizationId } from './memory-route';
import { OpsView } from './OpsView';
import { OrganizationMemoryLayout } from './OrganizationMemoryLayout';

/** `/organization/[orgId]/memory/ops`: ingest jobs, search log, and configuration. */
export function OrganizationMemoryOpsPage({
  route,
  page,
}: SettingsPageProps<'organization.memory.ops'>): JSX.Element {
  const orgId = memoryOrganizationId(route);
  const { data } = page;
  return (
    <OrganizationMemoryLayout
      orgId={orgId}
      team={data.team}
      view="ops"
      enabled={data.enabled}
    >
      {data.enabled && (
        <OpsView
          orgId={orgId}
          jobs={data.jobs}
          counts={data.counts}
          searchEntries={data.searchEntries}
          config={data.config}
        />
      )}
    </OrganizationMemoryLayout>
  );
}
