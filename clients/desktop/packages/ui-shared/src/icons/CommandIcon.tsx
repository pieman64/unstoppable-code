import type { JSX } from 'react';
import {
  CommandIcon as AppCatalogCommandIcon,
  type AppIconProps,
} from './AppIcons';

export function CommandIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogCommandIcon size="sm" {...props} />;
}
