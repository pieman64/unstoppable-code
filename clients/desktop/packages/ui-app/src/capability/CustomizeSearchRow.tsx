import type { JSX } from 'react';
import type { InstalledItemStatus } from '@canopy/protocol/installed-items';
import {
  InstalledStatusFilterDropdown,
  MarketplaceSearchField,
  PageSearchControls,
  PageSearchRow,
  type MarketplaceSearchFieldProps,
} from '@canopy/ui-shared/components';
import type { MarketplaceTypeTabId } from '@canopy/ui-shared/lib';
import { customizeTabHasInstalledStatuses } from './customizeSections';

export interface CustomizeSearchRowProps {
  readonly tab: MarketplaceTypeTabId;
  /** The row owns the field's placement. */
  readonly search: Omit<MarketplaceSearchFieldProps, 'className'>;
  /** `null` or omitted is Any status. */
  readonly installedStatusFilter?: InstalledItemStatus | null;
  /** Omit to render the search alone. */
  readonly onInstalledStatusFilterChange?: (
    value: InstalledItemStatus | null,
  ) => void;
  readonly className?: string;
}

/**
 * The Customize search with its Installed status filter beside it, shared by
 * desktop and web (CAN-4838). The filter shows only on tabs whose Installed
 * rows carry a status.
 */
export function CustomizeSearchRow({
  tab,
  search,
  installedStatusFilter,
  onInstalledStatusFilterChange,
  className,
}: CustomizeSearchRowProps): JSX.Element {
  return (
    <PageSearchRow testId="customize-search-row" className={className}>
      {/* The search takes the row; the status filter follows it. */}
      <MarketplaceSearchField {...search} />
      {customizeTabHasInstalledStatuses(tab) &&
        onInstalledStatusFilterChange !== undefined && (
          <PageSearchControls>
            <InstalledStatusFilterDropdown
              value={installedStatusFilter ?? null}
              onChange={onInstalledStatusFilterChange}
            />
          </PageSearchControls>
        )}
    </PageSearchRow>
  );
}
