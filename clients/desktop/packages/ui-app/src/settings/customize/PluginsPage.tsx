'use client';

import type { JSX } from 'react';
import { PluginsSettingsSection } from './PluginsSettingsSection';

/** `/account/plugins`: what loads into every new chat, managed in Customize. */
// `account.plugins` page data is empty, so the page takes no props (it still
// satisfies the registry's `SettingsPageProps` component type).
export function PluginsPage(): JSX.Element {
  return (
    <div className="flex flex-col gap-6" data-testid="account-plugins-page">
      <PluginsSettingsSection />
    </div>
  );
}
