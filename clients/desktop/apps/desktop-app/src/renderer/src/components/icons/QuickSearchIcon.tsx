import type { JSX, SVGProps } from 'react';
import { SearchIcon as AppCatalogSearchIcon } from '@canopy/ui-shared/icons/AppIcons';

export function QuickSearchIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogSearchIcon width="16" height="16" {...props} />;
}
