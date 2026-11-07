import type { JSX } from 'react';
import {
  ChevronRightIcon as AppCatalogChevronRightIcon,
  type AppIconProps,
} from './AppIcons';

export function ChevronRightIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogChevronRightIcon size="sm" {...props} />;
}
