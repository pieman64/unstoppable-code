import type { JSX, SVGProps } from 'react';
import { GlobeIcon as AppCatalogGlobeIcon } from './AppIcons';

export function GlobeIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogGlobeIcon width="14" height="14" {...props} />;
}
