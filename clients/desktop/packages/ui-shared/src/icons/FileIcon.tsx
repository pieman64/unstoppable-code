import type { JSX, SVGProps } from 'react';
import { FileIcon as AppCatalogFileIcon } from './AppIcons';

export function FileIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogFileIcon width="14" height="14" {...props} />;
}
