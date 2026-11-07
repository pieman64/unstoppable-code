import type { JSX } from 'react';
import { CopyIcon as AppCatalogCopyIcon, type AppIconProps } from './AppIcons';

export function CopyIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogCopyIcon size="sm" {...props} />;
}
