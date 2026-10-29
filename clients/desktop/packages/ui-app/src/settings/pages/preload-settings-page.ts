import {
  settingsPageDataKindForRoute,
  type OrganizationSettingsNavTab,
  type SettingsPageDataKind,
} from '@canopy/protocol/settings';
import { HOSTED_SETTINGS_PAGES } from './registry';

/**
 * Load a hosted settings page's chunk ahead of a visit, so opening it does
 * not wait on the download or flash the Suspense fallback. Each chunk loads
 * once; a failed load is retried by the next call or the visit itself.
 */
export function preloadSettingsPage(kind: SettingsPageDataKind): void {
  const page = HOSTED_SETTINGS_PAGES[kind];
  if (page.isLoaded()) return;
  page.preload().catch(() => {
    // The visit loads the chunk again and reports a failure itself.
  });
}

/** Whether a page's chunk has loaded, so it renders without suspending. */
export function settingsPageLoaded(kind: SettingsPageDataKind): boolean {
  return HOSTED_SETTINGS_PAGES[kind].isLoaded();
}

/**
 * Load the chunks behind an organization's tabs when the viewer enters the
 * organization, so moving between its tabs only waits on page data.
 */
export function preloadOrganizationTabPages(
  organizationId: string,
  tabs: readonly OrganizationSettingsNavTab[],
): void {
  for (const page of tabs)
    preloadSettingsPage(
      settingsPageDataKindForRoute({
        scope: 'organization',
        organizationId,
        page,
      }),
    );
}
