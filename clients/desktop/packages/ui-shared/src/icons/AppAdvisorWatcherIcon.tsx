import type { JSX, SVGProps } from 'react';
import { AppAdvisorWatcherIcon as AppCatalogAppAdvisorWatcherIcon } from './AppIcons';

/**
 * App Advisor watcher icon converted from the provided
 * `bigtop-updates-24dp-e3e3e3-fill0-wght400-grad0-opsz24.svg` asset.
 * Visible paths use `currentColor`, so the composer indicator can apply its
 * blue active treatment without importing the source SVG at runtime.
 */
export function AppAdvisorWatcherIcon(
  props: SVGProps<SVGSVGElement>,
): JSX.Element {
  return (
    <AppCatalogAppAdvisorWatcherIcon
      width="14"
      height="14"
      aria-hidden="true"
      {...props}
    />
  );
}
