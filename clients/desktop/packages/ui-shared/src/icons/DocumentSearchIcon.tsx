import type { JSX } from 'react';
import {
  DocumentSearchIcon as AppCatalogDocumentSearchIcon,
  type AppIconProps,
} from './AppIcons';

export function DocumentSearchIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogDocumentSearchIcon size="sm" {...props} />;
}
