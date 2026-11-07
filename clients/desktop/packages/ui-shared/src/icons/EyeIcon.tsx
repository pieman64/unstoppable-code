import type { JSX } from 'react';
import { EyeIcon as AppCatalogEyeIcon, type AppIconProps } from './AppIcons';

export function EyeIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogEyeIcon size="sm" {...props} />;
}
