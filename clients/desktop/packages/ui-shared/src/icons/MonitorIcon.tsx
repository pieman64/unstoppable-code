import type { JSX, SVGProps } from 'react';
import { MonitorIcon as AppCatalogMonitorIcon } from './AppIcons';

export function MonitorIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogMonitorIcon width="14" height="14" {...props} />;
}
