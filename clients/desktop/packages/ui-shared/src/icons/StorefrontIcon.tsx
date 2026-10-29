import type { JSX, SVGProps } from 'react';
import { StorefrontIcon as AppCatalogStorefrontIcon } from './AppIcons';

export function StorefrontIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogStorefrontIcon width="14" height="14" {...props} />;
}
