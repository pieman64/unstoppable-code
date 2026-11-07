import type { JSX } from 'react';
import {
  DownloadIcon as AppCatalogDownloadIcon,
  type AppIconProps,
} from './AppIcons';

export function DownloadIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogDownloadIcon size="sm" {...props} />;
}
