import type { JSX, SVGProps } from 'react';
import { FolderIcon as AppCatalogFolderIcon } from './AppIcons';

export function FolderIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogFolderIcon width="14" height="14" {...props} />;
}
