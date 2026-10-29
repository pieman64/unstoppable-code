'use client';

import type { JSX } from 'react';
import type { SettingsPageProps } from '../pages/page-props';
import { FactCorpusView } from './FactCorpusView';
import { memoryOrganizationId } from './memory-route';
import {
  memoryPoliciesHref,
  OrganizationMemoryLayout,
} from './OrganizationMemoryLayout';

/** `/organization/[orgId]/memory`: the fact corpus, search, and retrieval preview. */
export function OrganizationMemoryFactsPage({
  route,
  page,
}: SettingsPageProps<'organization.memory.facts'>): JSX.Element {
  const orgId = memoryOrganizationId(route);
  const { data } = page;
  return (
    <OrganizationMemoryLayout
      orgId={orgId}
      team={data.team}
      view="facts"
      enabled={data.enabled}
    >
      {data.enabled && (
        <FactCorpusView
          orgId={orgId}
          initialFacts={data.initialFacts}
          initialNextCursor={data.initialNextCursor}
          policiesHref={memoryPoliciesHref(orgId, data.team)}
        />
      )}
    </OrganizationMemoryLayout>
  );
}
