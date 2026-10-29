import type { JSX, SVGProps } from 'react';
import { TrashIcon as AppCatalogTrashIcon } from './AppIcons';

export function TrashIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogTrashIcon width="14" height="14" {...props} />;
}
