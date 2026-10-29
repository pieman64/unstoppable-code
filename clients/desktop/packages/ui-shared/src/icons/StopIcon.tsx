import type { JSX, SVGProps } from 'react';
import { StopIcon as AppCatalogStopIcon } from './AppIcons';

export function StopIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogStopIcon width="14" height="14" {...props} />;
}
