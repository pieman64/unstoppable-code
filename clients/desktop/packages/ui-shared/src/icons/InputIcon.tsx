import type { JSX } from 'react';
import {
  InputIcon as AppCatalogInputIcon,
  type AppIconProps,
} from './AppIcons';

export function InputIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogInputIcon size="sm" {...props} />;
}
