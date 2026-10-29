import type { JSX, SVGProps } from 'react';
import { PlusIcon as AppCatalogPlusIcon } from './AppIcons';

export function PlusIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogPlusIcon width="14" height="14" {...props} />;
}
