import type { JSX } from 'react';
import { ChevronLeftMediumIcon as AppCatalogChevronLeftMediumIcon } from '@canopy/ui-shared/icons/AppIcons';

interface DetailBackChipProps {
  onNavigateBack: () => void;
}

/**
 * Small "back to previous detail" affordance rendered at the top of a detail
 * modal body when the surface was opened from another detail (related-item
 * navigation, CAN-2382).
 */
export function DetailBackChip({
  onNavigateBack,
}: DetailBackChipProps): JSX.Element {
  return (
    <div className="mb-2 shrink-0">
      <button
        type="button"
        onClick={onNavigateBack}
        data-testid="plugins-entry-detail-back"
        className="inline-flex items-center gap-1 text-xs fg-secondary hover:fg-primary transition-colors"
      >
        <AppCatalogChevronLeftMediumIcon width="12" height="12" />
        Back
      </button>
    </div>
  );
}
