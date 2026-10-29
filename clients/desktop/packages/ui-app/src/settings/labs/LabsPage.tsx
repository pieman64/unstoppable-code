'use client';

import type { JSX } from 'react';
import { AccountLabsSection } from './account-labs-section';
import { LabsSettingsSection } from './LabsSettingsSection';
import { useLabsSettingsPort } from './labs-settings-port';

/**
 * `/account/labs`: switches for features still being tried. A host with its
 * own Labs port lists through it; any other host lists what the account
 * settings operations return.
 */
// `account.labs` page data is empty, so the page takes no props (it still
// satisfies the registry's `SettingsPageProps` component type).
export function LabsPage(): JSX.Element {
  const hostPort = useLabsSettingsPort();
  return (
    <div className="flex flex-col gap-6" data-testid="account-labs-page">
      {hostPort === null ? <AccountLabsSection /> : <LabsSettingsSection />}
    </div>
  );
}
