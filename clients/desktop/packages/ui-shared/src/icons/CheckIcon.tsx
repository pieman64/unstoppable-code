import type { JSX } from 'react';
import {
  CheckIcon as AppCatalogCheckIcon,
  type AppIconProps,
} from './AppIcons';

export function CheckIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogCheckIcon size="sm" {...props} />;
}
