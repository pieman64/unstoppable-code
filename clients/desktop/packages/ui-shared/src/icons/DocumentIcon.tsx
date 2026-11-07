import type { JSX } from 'react';
import {
  DocumentIcon as AppCatalogDocumentIcon,
  type AppIconProps,
} from './AppIcons';

export function DocumentIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogDocumentIcon size="sm" {...props} />;
}
