import type { JSX } from 'react';
import { TaskIcon as AppCatalogTaskIcon, type AppIconProps } from './AppIcons';

export function TaskIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogTaskIcon size="sm" {...props} />;
}
