import type { JSX, SVGProps } from 'react';
import { PlayCircleIcon as AppCatalogPlayCircleIcon } from './AppIcons';

export function PlayCircleIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogPlayCircleIcon width="14" height="14" {...props} />;
}
