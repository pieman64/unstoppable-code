'use client';

import type { JSX } from 'react';
import { settingsRouteToPath } from '@canopy/protocol/settings';
import type { SettingsPageProps } from '../pages/page-props';
import { ACCOUNT_DIGEST_OWNER } from './digest-api';
import { DigestDetailHeader } from './digest-detail-header';
import { DigestDetailNavigation } from './digest-detail-navigation';
import { DigestReport } from './digest-report';

function accountDigestPath(digestId: string | null): string | null {
  return digestId === null
    ? null
    : settingsRouteToPath({ scope: 'account', page: 'digests', digestId });
}

/**
 * `/account/digests/[digestId]`: the full report, with the share trigger in
 * the header and older/newer/cadence-settings navigation below it. Neighbors
 * arrive as ids and become paths through the settings route helpers.
 */
export function AccountDigestPage({
  page,
}: SettingsPageProps<'account.digest'>): JSX.Element {
  const { digest, audiences, neighbors } = page.data;

  return (
    <div className="flex flex-col gap-4">
      {/*
        Always present on this path — a user digest has a single owner, so
        `getUserDigest` never withholds the share link. The guard exists because
        the serializer makes it optional for the org path, where a non-editor
        must not receive the capability URL. Keyed by digest so moving to a
        neighbor starts the share controls from that digest's own state.
      */}
      <DigestDetailHeader
        key={digest.externalId}
        backHref={settingsRouteToPath({ scope: 'account', page: 'digests' })}
        share={
          digest.sharePath !== undefined
            ? {
                owner: ACCOUNT_DIGEST_OWNER,
                digestId: digest.externalId,
                initialSharePath: digest.sharePath,
                initialSharingEnabled: digest.sharingEnabled === true,
                initialAudiences: audiences,
              }
            : null
        }
      />
      <DigestReport digest={digest} linkPolicy="interactive" />
      <DigestDetailNavigation
        olderHref={accountDigestPath(neighbors.olderDigestId)}
        newerHref={accountDigestPath(neighbors.newerDigestId)}
        settingsHref={settingsRouteToPath({
          scope: 'account',
          page: 'notifications',
        })}
      />
    </div>
  );
}
