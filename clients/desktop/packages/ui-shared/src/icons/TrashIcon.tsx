import type { JSX } from 'react';
import {
  TrashIcon as AppCatalogTrashIcon,
  type AppIconProps,
} from './AppIcons';

export function TrashIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogTrashIcon size="sm" {...props} />;
}
