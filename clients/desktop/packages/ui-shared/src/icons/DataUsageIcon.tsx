import type { JSX, SVGProps } from 'react';
import { DataUsageIcon as AppCatalogDataUsageIcon } from './AppIcons';

export function DataUsageIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogDataUsageIcon width="14" height="14" {...props} />;
}
