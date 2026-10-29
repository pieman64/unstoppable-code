import type { JSX } from 'react';
import { ChevronRightMediumIcon as AppCatalogChevronRightMediumIcon } from '@canopy/ui-shared/icons/AppIcons';

/**
 * Shared 24×24 chevron icon used by collapsible pipeline-detail sections and the
 * Summary view metadata bar. Rotates 90° when `open` is true.
 */
export function DetailChevronIcon({ open }: { open: boolean }): JSX.Element {
  return (
    <AppCatalogChevronRightMediumIcon
      width="12"
      height="12"
      className={`transition-transform ${open ? 'rotate-90' : ''}`}
      aria-hidden="true"
    />
  );
}
