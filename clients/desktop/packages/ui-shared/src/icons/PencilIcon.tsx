import type { JSX } from 'react';
import {
  PencilIcon as AppCatalogPencilIcon,
  type AppIconProps,
} from './AppIcons';

export function PencilIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogPencilIcon size="sm" {...props} />;
}
