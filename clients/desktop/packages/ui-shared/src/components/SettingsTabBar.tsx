import type { JSX, ReactNode } from 'react';

export interface SettingsTab<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
}

export interface SettingsTabBarProps<T extends string> {
  tabs: ReadonlyArray<SettingsTab<T>>;
  activeTab: T;
  onChange: (next: T) => void;
}

/**
 * Tab bar header used by `ProjectSettingsModal` and `WorkspaceSettingsModal`.
 * Generic over the tab id type so each modal can keep its own union literal
 * (e.g. `'details' | 'scripts' | ...`) without losing type safety.
 *
 * Markup, classes, and danger-tab styling are preserved verbatim from the
 * original inline implementations so visual diffs and test selectors remain
 * stable.
 */
export function SettingsTabBar<T extends string>({
  tabs,
  activeTab,
  onChange,
}: SettingsTabBarProps<T>): JSX.Element {
  return (
    <div
      className="canopy-tab-list flex min-w-0 shrink-0 gap-1 overflow-x-auto px-5"
      role="tablist"
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={activeTab === tab.id}
          onClick={() => onChange(tab.id)}
          className={`canopy-tab-trigger flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-2 text-xs font-medium transition-colors ${
            tab.danger ? 'fg-destructive' : ''
          } ${
            activeTab === tab.id
              ? tab.danger
                ? 'fg-destructive'
                : 'fg-primary'
              : `${tab.danger ? 'fg-destructive/60 hover:fg-destructive' : 'fg-secondary hover:fg-primary'}`
          }`}
        >
          {tab.icon}
          {tab.label}
        </button>
      ))}
    </div>
  );
}
