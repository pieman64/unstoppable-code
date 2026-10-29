'use client';

import type { JSX } from 'react';
import { settingsRouteToPath } from '@canopy/protocol/settings';
import { useSettingsBrand } from '../host';
import type { SettingsPageProps } from '../pages/page-props';
import { ACCOUNT_DIGEST_OWNER } from './digest-api';
import { DigestAutoRefresh } from './digest-auto-refresh';
import { DigestList } from './digest-list';
import { DigestRequestForm } from './digest-request-form';
import { DigestRequestUnavailable } from './digest-request-unavailable';
import { isDigestWorkInFlight } from './digest-work-state';

/**
 * `/account/digests`: the viewer's digest archive, with the on-demand request
 * form above it (or its unavailable notice when the billing read failed) and
 * the bounded auto-refresh while a requested report is still being made.
 * Renders inside the account page frame on both hosts.
 */
export function AccountDigestsPage({
  page,
}: SettingsPageProps<'account.digests'>): JSX.Element {
  const brand = useSettingsBrand();
  const { digests, billing } = page.data;

  return (
    <div className="flex flex-col gap-4" data-testid="account-digests-page">
      {billing.status === 'ok' ? (
        <DigestRequestForm
          owner={ACCOUNT_DIGEST_OWNER}
          testIdPrefix="account"
          credits={billing.billing}
        />
      ) : (
        <DigestRequestUnavailable testIdPrefix="account" />
      )}
      {/* Labeled group, so the raised rows below are read as the archive
          rather than as more of the request control above them. */}
      <div className="mt-1 flex flex-col gap-3">
        <h3
          className="text-s font-semibold fg-primary"
          data-testid="account-digest-archive-heading"
        >
          Past digests
        </h3>
        <DigestList
          digests={digests}
          basePath={settingsRouteToPath({ scope: 'account', page: 'digests' })}
          emptyMessage={`No digests yet. Once a period with ${brand.displayName} activity closes, your digest will appear here.`}
        />
      </div>
      <DigestAutoRefresh active={isDigestWorkInFlight(digests)} />
    </div>
  );
}
