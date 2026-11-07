import type { JSX } from 'react';
import {
  PluginsIcon as AppCatalogPluginsIcon,
  type AppIconProps,
} from './AppIcons';

export function PluginsIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogPluginsIcon size="sm" {...props} />;
}
