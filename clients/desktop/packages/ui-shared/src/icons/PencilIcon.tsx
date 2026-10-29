import type { JSX, SVGProps } from 'react';
import { PencilIcon as AppCatalogPencilIcon } from './AppIcons';

export function PencilIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogPencilIcon width="14" height="14" {...props} />;
}
