import type { JSX } from 'react';
import {
  RerunIcon as AppCatalogRerunIcon,
  type AppIconProps,
} from './AppIcons';

export function RerunIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogRerunIcon size="sm" {...props} />;
}
