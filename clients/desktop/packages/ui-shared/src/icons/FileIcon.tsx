import type { JSX } from 'react';
import { FileIcon as AppCatalogFileIcon, type AppIconProps } from './AppIcons';

export function FileIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogFileIcon size="sm" {...props} />;
}
