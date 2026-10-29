import type { JSX } from 'react';
import { ChevronRightMediumIcon as AppCatalogChevronRightMediumIcon } from './AppIcons';

/** Right-pointing chevron used to expand inline rows; rotates 90° when open. */
export function ChevronIcon({ open }: { open: boolean }): JSX.Element {
  return (
    <span
      className={`inline-flex shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
    >
      <AppCatalogChevronRightMediumIcon width="14" height="14" />
    </span>
  );
}
