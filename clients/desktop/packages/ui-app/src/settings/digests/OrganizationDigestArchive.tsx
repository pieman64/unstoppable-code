'use client';

import type { JSX } from 'react';
import {
  settingsRouteToPath,
  type OrganizationDigestsPageData,
} from '@canopy/protocol/settings';
import { DigestAutoRefresh } from './digest-auto-refresh';
import { DigestList } from './digest-list';
import { DigestRequestForm } from './digest-request-form';
import { DigestRequestUnavailable } from './digest-request-unavailable';
import { isDigestWorkInFlight } from './digest-work-state';
import { Heading } from '@canopy/ui-shared/components';

export interface OrganizationDigestArchiveProps {
  organizationId: string;
  /**
   * The `organization.digests` archive. `null` while the org is lapsed: the
   * organization page renders its lapsed panel instead and nothing renders
   * here.
   */
  archive: OrganizationDigestsPageData['archive'];
}

/**
 * The org Digests tab body: the request form for editors (or its unavailable
 * notice when the billing read failed), the archive, and the bounded
 * auto-refresh while a requested report is still being made. Members can read
 * the archive but cannot request a digest, so `request` is `null` for them and
 * no form renders.
 */
export function OrganizationDigestArchive({
  organizationId,
  archive,
}: OrganizationDigestArchiveProps): JSX.Element | null {
  if (archive === null) return null;
  const { digests, request } = archive;

  return (
    <div className="flex flex-col gap-4" data-testid="org-digests-page">
      {request?.status === 'unavailable' && (
        <DigestRequestUnavailable testIdPrefix="team" />
      )}
      {request?.status === 'ok' && (
        <DigestRequestForm
          owner={{ kind: 'organization', organizationId }}
          testIdPrefix="team"
          credits={request.credits}
        />
      )}
      {/* Labeled group, so the raised rows below are read as the archive
          rather than as more of the request control above them. */}
      <div className="mt-1 flex flex-col gap-3">
        <Heading
          level={3}
          variant="title"
          data-testid="org-digest-archive-heading"
        >
          Past digests
        </Heading>
        <DigestList
          digests={digests}
          basePath={settingsRouteToPath({
            scope: 'organization',
            organizationId,
            page: 'digests',
          })}
          emptyMessage="No digests yet. Once a period with shared organization activity closes, the digest will appear here."
        />
      </div>
      <DigestAutoRefresh active={isDigestWorkInFlight(digests)} />
    </div>
  );
}
