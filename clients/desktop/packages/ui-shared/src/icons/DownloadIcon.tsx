import type { JSX, SVGProps } from 'react';
import { DownloadIcon as AppCatalogDownloadIcon } from './AppIcons';

export function DownloadIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogDownloadIcon width="14" height="14" {...props} />;
}
