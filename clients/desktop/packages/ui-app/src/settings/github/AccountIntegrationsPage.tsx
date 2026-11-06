'use client';

import type { JSX } from 'react';
import type { SettingsPageProps } from '../pages/page-props';
import { GitHubCloudSettings } from './GitHubCloudSettings';

/**
 * `/account/integrations`: connections to third parties that work on the
 * user's behalf. Today that is GitHub for cloud work, one Settings card
 * driven by the single page-level connection controller, which also handles
 * a GitHub callback that landed on this page (`github_cloud=...`).
 *
 * The page's gate (the Cloud Git gate) stays with each host's loader: web
 * redirects to `/account`, `settings.pageData` answers `not_found`.
 */
export function AccountIntegrationsPage({
  page,
}: SettingsPageProps<'account.integrations'>): JSX.Element {
  return <GitHubCloudSettings userId={page.data.userId} />;
}
