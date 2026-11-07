import type { JSX } from 'react';
import {
  MessageIcon as AppCatalogMessageIcon,
  type AppIconProps,
} from './AppIcons';

export function MessageIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogMessageIcon size="sm" {...props} />;
}
