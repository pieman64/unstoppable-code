import type { JSX, ReactNode } from 'react';

export interface RailTabBarTab<TId extends string> {
  id: TId;
  label: string;
  /** Optional test id applied to the tab button. */
  dataTestId?: string;
}

export interface RailTabBarProps<TId extends string> {
  tabs: readonly RailTabBarTab<TId>[];
  activeTab: TId;
  onTabChange: (tab: TId) => void;
  /** Right-aligned actions rendered after the tab strip. */
  actions?: ReactNode;
  /**
   * When true the row receives the `electron-drag` class so the desktop
   * Electron window can be dragged from the empty space, and tab buttons
   * receive `electron-no-drag` so clicks still work. The web portal must
   * leave this off.
   */
  electronDrag?: boolean;
  /**
   * Enforce ≥44px touch targets on the tab buttons (CAN-1206). Opt-in so the
   * desktop rail header stays pixel-identical; the web portal passes it only
   * for the mobile-drawer variant.
   */
  touchTarget?: boolean;
}

/**
 * Top header row used on the activity right rail. Matches canopy's
 * desktop activity panel header: small all-caps tab labels with the active
 * tab in `fg-primary` and inactive tabs in `fg-secondary`.
 */
export function RailTabBar<TId extends string>({
  tabs,
  activeTab,
  onTabChange,
  actions,
  electronDrag = false,
  touchTarget = false,
}: RailTabBarProps<TId>): JSX.Element {
  const rowClass = `${electronDrag ? 'electron-drag ' : ''}flex items-center justify-between border-b px-4 py-2`;
  // `min-h-11 min-w-11` + centering give each tab a ≥44px touch target
  // in the mobile drawer without changing the text metrics the desktop header
  // relies on.
  const buttonClass = `${electronDrag ? 'electron-no-drag ' : ''}${
    touchTarget
      ? 'inline-flex min-h-11 min-w-11 items-center justify-center '
      : ''
  }focus-ring text-2xs font-medium transition`;
  return (
    <div className={rowClass}>
      <div className="flex items-center gap-3">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={(): void => onTabChange(tab.id)}
              className={`${buttonClass} ${
                isActive ? 'fg-primary' : 'fg-secondary hover:fg-primary'
              }`}
              aria-pressed={isActive}
              data-testid={tab.dataTestId}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {actions != null && (
        <div className="flex items-center gap-1.5">{actions}</div>
      )}
    </div>
  );
}
