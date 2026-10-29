'use client';

import type { JSX } from 'react';
import { settingsRouteToPath } from '@canopy/protocol/settings';
import { TeamLapsedState } from '../organization/team-lapsed-state';
import { SettingsPageColumn } from '../layout/SettingsPageColumn';
import type { SettingsPageProps } from '../pages/page-props';
import { DigestDetailHeader } from './digest-detail-header';
import { DigestDetailNavigation } from './digest-detail-navigation';
import { DigestReport } from './digest-report';

function organizationDigestPath(
  organizationId: string,
  digestId: string | null,
): string | null {
  return digestId === null
    ? null
    : settingsRouteToPath({
        scope: 'organization',
        organizationId,
        page: 'digests',
        digestId,
      });
}

/**
 * `/organization/[orgId]/digests/[digestId]`: the full org report, scoped to
 * the viewer's membership. A lapsed org renders only the lapsed notice. The
 * share trigger renders only for editors whose digest carries a share path.
 */
export function OrganizationDigestPage({
  page,
}: SettingsPageProps<'organization.digest'>): JSX.Element {
  const { organization, canEdit, lapsed, report } = page.data;
  const organizationId = organization.id;

  if (lapsed !== null || report === null) {
    return (
      <SettingsPageColumn as="main">
        <div className="w-full max-w-3xl">
          <TeamLapsedState
            orgId={organizationId}
            orgName={organization.name}
            trialEndedAt={lapsed?.trialEndedAt ?? null}
            lapseReason={lapsed?.lapseReason ?? null}
            requiredPlanName={lapsed?.requiredPlanName ?? null}
            canEdit={canEdit}
          />
        </div>
      </SettingsPageColumn>
    );
  }
  const { digest, neighbors, share } = report;

  return (
    // The report keeps its reading measure inside the shared column.
    <SettingsPageColumn as="main">
      <div className="flex w-full max-w-3xl flex-col gap-4">
        {/*
        `share` is only present for viewers who can manage sharing — the slug
        is a bearer capability for the whole report, so it is withheld from
        everyone else. Keyed by digest so moving to a neighbor starts the share
        controls from that digest's own state.
      */}
        <DigestDetailHeader
          key={digest.externalId}
          backHref={settingsRouteToPath({
            scope: 'organization',
            organizationId,
            page: 'digests',
          })}
          share={
            share
              ? {
                  owner: { kind: 'organization', organizationId },
                  digestId: digest.externalId,
                  initialSharePath: share.sharePath,
                  initialSharingEnabled: share.sharingEnabled,
                }
              : null
          }
        />
        <DigestReport
          digest={digest}
          linkPolicy="interactive"
          orgId={organizationId}
        />
        <DigestDetailNavigation
          olderHref={organizationDigestPath(organizationId, neighbors.olderId)}
          newerHref={organizationDigestPath(organizationId, neighbors.newerId)}
          settingsHref={
            canEdit
              ? settingsRouteToPath({
                  scope: 'organization',
                  organizationId,
                  page: 'settings',
                })
              : null
          }
        />
      </div>
    </SettingsPageColumn>
  );
}
