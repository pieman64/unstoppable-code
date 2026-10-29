import type { JSX } from 'react';
import { SearchIcon as AppCatalogSearchIcon } from '@canopy/ui-shared/icons/AppIcons';

export function SearchIcon(): JSX.Element {
  return (
    <AppCatalogSearchIcon
      width="14"
      height="14"
      className="shrink-0 fg-secondary"
      aria-hidden="true"
    />
  );
}
