'use client';

import type { JSX } from 'react';
import { settingsRouteToPath } from '@canopy/protocol/settings';
import { SettingsLink, useSettingsPrivacy } from '../host';
import { SettingsPageColumn } from '../layout/SettingsPageColumn';
import type { SettingsPageProps } from '../pages/page-props';
import { DigestDetailNavigation } from './digest-detail-navigation';
import { DigestReport } from './digest-report';

function memberDigestPath(
  organizationId: string,
  userId: string,
  digestId: string | null,
): string | null {
  return digestId === null
    ? null
    : settingsRouteToPath({
        scope: 'organization',
        organizationId,
        page: 'members',
        userId,
        digestId,
      });
}

/**
 * `/organization/[orgId]/members/[userId]/digests/[digestId]`: a personal
 * digest its owner deliberately featured on their profile for this
 * organization.
 *
 * The projection is share-safe by construction, and `linkPolicy="inert"`
 * keeps any link inside the narrative from becoming a live capability URL.
 * There is deliberately no Share control and no cadence-settings link: the
 * viewer owns neither.
 */
export function OrganizationMemberDigestPage({
  page,
}: SettingsPageProps<'organization.memberDigest'>): JSX.Element {
  const { blockClassName } = useSettingsPrivacy();
  const { org, member, digest, neighbors } = page.data;
  const profilePath = settingsRouteToPath({
    scope: 'organization',
    organizationId: org.id,
    page: 'members',
    userId: member.id,
  });

  return (
    // The report keeps its reading measure inside the shared column.
    <SettingsPageColumn>
      <div className="flex w-full max-w-3xl flex-col gap-4">
        <SettingsLink
          href={`${profilePath}?tab=digests`}
          data-testid="featured-digest-back"
          className="text-s font-medium fg-secondary transition-colors hover:fg-primary"
        >
          {/* The member's name is blocked from replay; the link itself stays
            observable. */}
          ← Back to{' '}
          <span className={blockClassName === '' ? undefined : blockClassName}>
            {member.name}
          </span>
          &rsquo;s digests
        </SettingsLink>
        <DigestReport digest={digest} linkPolicy="inert" />
        <DigestDetailNavigation
          olderHref={memberDigestPath(org.id, member.id, neighbors.olderId)}
          newerHref={memberDigestPath(org.id, member.id, neighbors.newerId)}
          // Cadence belongs to the digest's OWNER; a viewer has nothing to
          // configure here.
          settingsHref={null}
        />
      </div>
    </SettingsPageColumn>
  );
}
