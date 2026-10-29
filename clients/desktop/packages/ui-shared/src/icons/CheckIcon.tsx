import type { JSX, SVGProps } from 'react';
import { CheckIcon as AppCatalogCheckIcon } from './AppIcons';

export function CheckIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogCheckIcon width="14" height="14" {...props} />;
}
