import type { JSX } from 'react';
import {
  MoreHorizontalIcon as AppCatalogMoreHorizontalIcon,
  type AppIconProps,
} from './AppIcons';

export function MoreHorizontalIcon(props: AppIconProps): JSX.Element {
  return (
    <AppCatalogMoreHorizontalIcon size="sm" aria-hidden="true" {...props} />
  );
}
