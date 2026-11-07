import type { JSX } from 'react';
import { InfoIcon as AppCatalogInfoIcon, type AppIconProps } from './AppIcons';

export function InfoIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogInfoIcon size="sm" {...props} />;
}
