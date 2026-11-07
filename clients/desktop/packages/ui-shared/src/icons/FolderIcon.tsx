import type { JSX } from 'react';
import {
  FolderIcon as AppCatalogFolderIcon,
  type AppIconProps,
} from './AppIcons';

export function FolderIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogFolderIcon size="sm" {...props} />;
}
