import type { JSX, SVGProps } from 'react';
import { CommandIcon as AppCatalogCommandIcon } from './AppIcons';

export function CommandIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogCommandIcon width="14" height="14" {...props} />;
}
