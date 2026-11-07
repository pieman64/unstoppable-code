import type { JSX } from 'react';
import { HookIcon as AppCatalogHookIcon, type AppIconProps } from './AppIcons';

export function HookIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogHookIcon size="sm" {...props} />;
}
