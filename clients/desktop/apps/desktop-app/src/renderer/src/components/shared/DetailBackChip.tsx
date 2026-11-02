import type { JSX } from 'react';
import { ChevronLeftMediumIcon as AppCatalogChevronLeftMediumIcon } from '@canopy/ui-shared/icons/AppIcons';
import { Button } from '@/components/shared/Button';

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
      <Button
        variant="ghost"
        size="compact"
        onClick={onNavigateBack}
        data-testid="plugins-entry-detail-back"
        className="-ml-3"
      >
        <AppCatalogChevronLeftMediumIcon width="12" height="12" />
        Back
      </Button>
    </div>
  );
}
