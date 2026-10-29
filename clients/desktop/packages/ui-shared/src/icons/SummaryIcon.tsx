import type { JSX, SVGProps } from 'react';
import { SummaryIcon as AppCatalogSummaryIcon } from './AppIcons';

export function SummaryIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogSummaryIcon width="14" height="14" {...props} />;
}
