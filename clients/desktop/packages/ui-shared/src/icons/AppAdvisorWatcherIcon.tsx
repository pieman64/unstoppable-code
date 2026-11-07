import type { JSX } from 'react';
import {
  AppAdvisorWatcherIcon as AppCatalogAppAdvisorWatcherIcon,
  type AppIconProps,
} from './AppIcons';

/**
 * App Advisor watcher icon converted from the provided
 * `bigtop-updates-24dp-e3e3e3-fill0-wght400-grad0-opsz24.svg` asset.
 * Visible paths use `currentColor`, so the composer indicator can apply its
 * blue active treatment without importing the source SVG at runtime.
 */
export function AppAdvisorWatcherIcon(props: AppIconProps): JSX.Element {
  return (
    <AppCatalogAppAdvisorWatcherIcon size="sm" aria-hidden="true" {...props} />
  );
}
