import type { JSX, SVGProps } from 'react';
import { MessageIcon as AppCatalogMessageIcon } from './AppIcons';

export function MessageIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogMessageIcon width="14" height="14" {...props} />;
}
