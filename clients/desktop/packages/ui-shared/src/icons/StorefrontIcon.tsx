import type { JSX } from 'react';
import {
  StorefrontIcon as AppCatalogStorefrontIcon,
  type AppIconProps,
} from './AppIcons';

export function StorefrontIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogStorefrontIcon size="sm" {...props} />;
}
