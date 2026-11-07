import type { JSX } from 'react';
import {
  GlobeIcon as AppCatalogGlobeIcon,
  type AppIconProps,
} from './AppIcons';

export function GlobeIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogGlobeIcon size="sm" {...props} />;
}
