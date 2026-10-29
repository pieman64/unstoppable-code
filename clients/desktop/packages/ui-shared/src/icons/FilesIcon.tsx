import type { JSX, SVGProps } from 'react';
import { FilesIcon as AppCatalogFilesIcon } from './AppIcons';

export function FilesIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogFilesIcon width="14" height="14" {...props} />;
}
