import type { JSX, SVGProps } from 'react';
import { WrenchIcon as AppCatalogWrenchIcon } from './AppIcons';

export function WrenchIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogWrenchIcon width="14" height="14" {...props} />;
}
