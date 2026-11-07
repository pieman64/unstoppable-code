import type { JSX } from 'react';
import { MicIcon as AppCatalogMicIcon, type AppIconProps } from './AppIcons';

export function MicIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogMicIcon size="sm" {...props} />;
}
