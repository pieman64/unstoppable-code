import type { JSX, SVGProps } from 'react';
import { ChevronDownIcon as AppCatalogChevronDownIcon } from './AppIcons';

export function ChevronDownIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogChevronDownIcon width="12" height="12" {...props} />;
}
