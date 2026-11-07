import type { JSX } from 'react';
import {
  RocketLaunchIcon as AppCatalogRocketLaunchIcon,
  type AppIconProps,
} from './AppIcons';

export function RocketLaunchIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogRocketLaunchIcon size="sm" {...props} />;
}
