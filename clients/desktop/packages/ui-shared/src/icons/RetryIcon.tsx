import type { JSX } from 'react';
import {
  RetryIcon as AppCatalogRetryIcon,
  type AppIconProps,
} from './AppIcons';

export function RetryIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogRetryIcon size="sm" {...props} />;
}
