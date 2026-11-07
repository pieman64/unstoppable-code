import type { JSX } from 'react';
import {
  MagnifyingGlassIcon as AppCatalogMagnifyingGlassIcon,
  type AppIconProps,
} from './AppIcons';

export function MagnifyingGlassIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogMagnifyingGlassIcon size="sm" {...props} />;
}
