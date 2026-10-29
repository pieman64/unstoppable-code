'use client';

import type { JSX } from 'react';
import { TeamPage } from '../organization/team-page';
import { teamPagePropsFromData } from '../organization/team-page-props';
import type { SettingsPageProps } from '../pages/page-props';
import { OrganizationDigestArchive } from './OrganizationDigestArchive';

/**
 * `/organization/[orgId]/digests`: the organization's digest archive inside
 * the organization page shell. A lapsed organization has no archive
 * (`archive` is `null`) and the shell renders its lapsed panel instead.
 */
export function OrganizationDigestsPage({
  page,
}: SettingsPageProps<'organization.digests'>): JSX.Element {
  const { data } = page;
  return (
    <TeamPage
      key={data.detail.id}
      {...teamPagePropsFromData(data)}
      activeTab="digests"
      digestContent={
        data.archive === null ? null : (
          <OrganizationDigestArchive
            organizationId={data.detail.id}
            archive={data.archive}
          />
        )
      }
    />
  );
}
