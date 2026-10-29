import type { JSX, SVGProps } from 'react';
import { InfoIcon as AppCatalogInfoIcon } from './AppIcons';

export function InfoIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogInfoIcon width="14" height="14" {...props} />;
}
