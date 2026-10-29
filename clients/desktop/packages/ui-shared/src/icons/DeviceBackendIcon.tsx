import type { JSX, SVGProps } from 'react';
import { MonitorIcon as AppCatalogMonitorIcon } from './AppIcons';

/**
 * Backend pip glyph for rows that execute on the user's own machine: a plain
 * laptop outline (screen + base).
 *
 * Deliberately a generic device shape with no product mark — the app is
 * white-labeled across brand packs, so the pip may only depict WHERE work runs,
 * never whose product runs it.
 */
export function DeviceBackendIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <AppCatalogMonitorIcon
      width="14"
      height="14"
      aria-hidden="true"
      {...props}
    />
  );
}
