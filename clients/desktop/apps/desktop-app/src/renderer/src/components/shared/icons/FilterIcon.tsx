import type { JSX } from 'react';
import { FilterIcon as AppCatalogFilterIcon } from '@canopy/ui-shared/icons/AppIcons';

/**
 * Funnel filter icon shared across filter controls (worktree list, pipeline
 * details). Renders filled when a filter is active, outlined otherwise.
 */
export function FilterIcon({ active }: { active: boolean }): JSX.Element {
  return (
    <AppCatalogFilterIcon
      width="12"
      height="12"
      fill={active ? 'currentColor' : 'none'}
      aria-hidden="true"
    />
  );
}
