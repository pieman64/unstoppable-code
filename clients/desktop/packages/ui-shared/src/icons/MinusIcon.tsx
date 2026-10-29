import type { JSX, SVGProps } from 'react';
import { MinusIcon as AppCatalogMinusIcon } from './AppIcons';

export function MinusIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogMinusIcon width="14" height="14" {...props} />;
}
