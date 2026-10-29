'use client';

import type { JSX } from 'react';
import { SettingsLink, useSettingsBrand } from '../host';
import { ACCOUNT_DIGEST_OWNER } from '../digests/digest-api';
import { DigestPreferencesCard } from '../digests/digest-preferences-card';

/**
 * The viewer's own work-digest cadence toggles, plus a way into the archive of
 * everything already generated for them.
 *
 * Renders nothing while `canopy-digests-enabled` is off — the card resolves
 * that from the API's 404 rather than from a threaded prop, so the flag has one
 * server-side source of truth.
 */
export function DigestPreferencesSection(): JSX.Element {
  const brand = useSettingsBrand();

  return (
    <DigestPreferencesCard
      owner={ACCOUNT_DIGEST_OWNER}
      title="Work digests"
      // "your recent work" rather than "what you shipped": digests go to
      // everyone on a team, and "shipped" reads as engineering jargon to the
      // marketers, designers, and PMs who also get one.
      description={`A periodic summary of your recent work, generated from your ${brand.displayName} activity and emailed to you.`}
      testIdPrefix="account"
      footer={
        <SettingsLink
          href="/account/digests"
          data-testid="account-view-digests-link"
          className="text-s font-medium fg-accent hover:underline"
        >
          View past digests
        </SettingsLink>
      }
    />
  );
}
