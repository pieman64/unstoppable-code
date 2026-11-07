import type { JSX } from 'react';
import {
  CognitionIcon as AppCatalogCognitionIcon,
  type AppIconProps,
} from './AppIcons';

export function CognitionIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogCognitionIcon size="sm" aria-hidden="true" {...props} />;
}
