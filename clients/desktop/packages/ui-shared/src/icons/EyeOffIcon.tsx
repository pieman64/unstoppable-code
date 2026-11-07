import type { JSX } from 'react';
import {
  EyeOffIcon as AppCatalogEyeOffIcon,
  type AppIconProps,
} from './AppIcons';

export function EyeOffIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogEyeOffIcon size="sm" {...props} />;
}
