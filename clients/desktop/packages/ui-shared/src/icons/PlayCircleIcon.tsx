import type { JSX } from 'react';
import {
  PlayCircleIcon as AppCatalogPlayCircleIcon,
  type AppIconProps,
} from './AppIcons';

export function PlayCircleIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogPlayCircleIcon size="sm" {...props} />;
}
