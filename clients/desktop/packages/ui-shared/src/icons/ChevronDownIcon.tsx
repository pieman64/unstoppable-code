import type { JSX } from 'react';
import {
  ChevronDownIcon as AppCatalogChevronDownIcon,
  type AppIconProps,
} from './AppIcons';

export function ChevronDownIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogChevronDownIcon size="sm" {...props} />;
}
