import type { JSX } from 'react';
import { PlusIcon as AppCatalogPlusIcon, type AppIconProps } from './AppIcons';

export function PlusIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogPlusIcon size="sm" {...props} />;
}
