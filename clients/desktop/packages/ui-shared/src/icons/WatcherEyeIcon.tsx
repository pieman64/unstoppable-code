import type { JSX } from 'react';
import {
  WatcherEyeIcon as AppCatalogWatcherEyeIcon,
  type AppIconProps,
} from './AppIcons';

export function WatcherEyeIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogWatcherEyeIcon size="sm" aria-hidden="true" {...props} />;
}
