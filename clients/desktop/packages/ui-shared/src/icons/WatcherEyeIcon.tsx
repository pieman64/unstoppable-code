import type { JSX, SVGProps } from 'react';
import { WatcherEyeIcon as AppCatalogWatcherEyeIcon } from './AppIcons';

export function WatcherEyeIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <AppCatalogWatcherEyeIcon
      width="16"
      height="16"
      aria-hidden="true"
      {...props}
    />
  );
}
