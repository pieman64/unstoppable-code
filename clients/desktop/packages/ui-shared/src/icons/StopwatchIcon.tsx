import type { JSX, SVGProps } from 'react';
import { StopwatchIcon as AppCatalogStopwatchIcon } from './AppIcons';

export function StopwatchIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogStopwatchIcon width="14" height="14" {...props} />;
}
