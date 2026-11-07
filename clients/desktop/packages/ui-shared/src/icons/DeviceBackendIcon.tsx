import type { JSX } from 'react';
import {
  MonitorIcon as AppCatalogMonitorIcon,
  type AppIconProps,
} from './AppIcons';

/**
 * Backend pip glyph for rows that execute on the user's own machine: a plain
 * laptop outline (screen + base).
 *
 * Deliberately a generic device shape with no product mark — the app is
 * white-labeled across brand packs, so the pip may only depict WHERE work runs,
 * never whose product runs it.
 */
export function DeviceBackendIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogMonitorIcon size="sm" aria-hidden="true" {...props} />;
}
