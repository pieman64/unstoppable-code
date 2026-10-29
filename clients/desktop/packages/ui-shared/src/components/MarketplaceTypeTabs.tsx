import type { JSX } from 'react';
import {
  marketplaceTypeTabs,
  type MarketplaceTypeTab,
  type MarketplaceTypeTabId,
} from '../lib/marketplace-type-tabs';

/** The tabs every host shows; Agents and Project templates are opt-in. */
const DEFAULT_TABS = marketplaceTypeTabs();

export interface MarketplaceTypeTabsProps {
  readonly value: MarketplaceTypeTabId;
  readonly onChange: (tab: MarketplaceTypeTabId) => void;
  /**
   * The tabs to show, from `marketplaceTypeTabs`. Defaults to the kinds every
   * host lists; pass the host's own set to add Agents or Project templates.
   */
  readonly tabs?: readonly MarketplaceTypeTab[];
  /** Placement only; the tab list owns its own layout. */
  readonly className?: string;
}

/** The Marketplace's capability type tabs, identical on desktop and web. */
export function MarketplaceTypeTabs({
  value,
  onChange,
  tabs = DEFAULT_TABS,
  className,
}: MarketplaceTypeTabsProps): JSX.Element {
  return (
    <div
      role="tablist"
      aria-label="Capability type"
      data-testid="plugins-type-tabs"
      className={`canopy-tab-list flex gap-2 overflow-x-auto overflow-y-hidden ${className ?? ''}`.trim()}
    >
      {tabs.map((tab) => {
        const selected = value === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            data-testid={`plugins-type-tab-${tab.id}`}
            aria-selected={selected}
            onClick={() => onChange(tab.id)}
            className={`canopy-tab-trigger focus-ring shrink-0 px-3 py-2 text-xs transition-colors pointer-coarse:min-h-11 ${
              selected ? 'fg-primary' : 'fg-secondary hover:fg-primary'
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
