'use client';

import type { JSX } from 'react';
import { AttentionDot } from '@canopy/ui-shared/components/settings/AttentionDot';
import { ScrollableTabStrip } from './ScrollableTabStrip';

/**
 * Enumerated so the generated `data-testid`s stay greppable and a typo cannot
 * silently orphan an automation selector. Adding a third consumer is a
 * deliberate edit here rather than an arbitrary new string at the call site.
 */
type SubTabNavTestIdPrefix = 'usage-metric' | 'memory-views';

interface SubTabNavProps<TKey extends string> {
  tabs: ReadonlyArray<{
    key: TKey;
    label: string;
    /**
     * Renders a dot on the tab, matching the settings rail's affordance, for a
     * tab hosting something the viewer should act on. Deliberately generic —
     * the caller decides what "needs attention" means.
     */
    attention?: boolean;
  }>;
  activeTab: TKey;
  onSelect: (tab: TKey) => void;
  /** Yields `<prefix>-tabs` / `<prefix>-tab-<key>`. */
  testIdPrefix: SubTabNavTestIdPrefix;
  ariaLabel: string;
  /**
   * `segmented` (default) for a view toggle inside a page's content;
   * `underline` for a page-level switcher directly under a page header.
   */
  variant?: SubTabNavVariant;
}

type SubTabNavVariant = 'segmented' | 'underline';

const NAV_CLASS: Record<SubTabNavVariant, string> = {
  segmented: 'flex gap-0.5',
  underline: 'flex gap-1',
};

const TAB_CLASS: Record<
  SubTabNavVariant,
  { base: string; active: string; inactive: string }
> = {
  segmented: {
    base: 'cursor-pointer shrink-0 whitespace-nowrap rounded px-2.5 py-1 text-s font-medium transition-colors',
    active: 'bg-accent fg-emphasis',
    inactive: 'fg-secondary hover:fg-primary',
  },
  underline: {
    base: '-mb-px inline-flex shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-s font-medium transition-colors',
    // The unlayered base `border-color` rule overrides `tab-accent-line`
    // (CAN-2734), so the selected bar is drawn over the border instead.
    active:
      'tab-accent-line relative fg-primary after:absolute after:inset-x-0 after:-bottom-0.5 after:h-0.5 after:bg-line-accent',
    inactive: 'border-transparent fg-secondary hover:fg-primary',
  },
};

/**
 * Shared in-page view-switcher. The settings rail navigates between pages;
 * this switches views inside one. `segmented` is a pill control for a toggle
 * within a page's content (the statistics metric strip). `underline` is the
 * page-level switcher under the page header (the organization Settings
 * subtabs and the Memory views). On narrow widths the tabs stay on one line
 * and scroll horizontally rather than wrapping or overflowing.
 *
 * `aria-pressed` (not `aria-current="page"`) is the convention for both
 * variants: they toggle a view in place rather than navigating, so nothing here
 * is "the current page". The rail's links use `aria-current`.
 *
 * Accessibility trade-off, recorded deliberately: the settings bar is closer to
 * a true tab UI (it discloses one panel at a time) than the metric strip is, so
 * a `role="tablist"` / `role="tab"` + `aria-selected` + `aria-controls` pairing
 * with a `role="tabpanel"` region would announce "tab 2 of 4" there. One shared
 * component cannot be correct for both uses at once, and the metric strip is a
 * genuine toggle. `aria-pressed` is kept for both so the two bars stay
 * consistent; if the settings bar ever needs full tab semantics, add an opt-in
 * `semantics: 'toggle' | 'tabs'` prop rather than switching this default.
 *
 * That opt-in should carry keyboard behavior with it, not just ARIA roles: a
 * real tablist moves between tabs with arrow keys (roving `tabindex`), whereas
 * this bar leaves every button in the tab order individually. The roles and the
 * keyboard model belong in the same change — shipping one without the other
 * announces an affordance that does not work.
 */
export function SubTabNav<TKey extends string>({
  tabs,
  activeTab,
  onSelect,
  testIdPrefix,
  ariaLabel,
  variant = 'segmented',
}: SubTabNavProps<TKey>): JSX.Element {
  const tabClass = TAB_CLASS[variant];
  return (
    <ScrollableTabStrip frame={variant}>
      <nav
        className={NAV_CLASS[variant]}
        data-testid={`${testIdPrefix}-tabs`}
        aria-label={ariaLabel}
      >
        {tabs.map((tab) => {
          const isActive = tab.key === activeTab;
          return (
            <button
              key={tab.key}
              type="button"
              data-settings-control="chip"
              onClick={() => onSelect(tab.key)}
              data-testid={`${testIdPrefix}-tab-${tab.key}`}
              aria-pressed={isActive}
              className={`${tabClass.base} ${
                isActive ? tabClass.active : tabClass.inactive
              }`}
            >
              {tab.attention === true ? (
                <AttentionDot
                  label={`${tab.label} needs attention`}
                  testId={`${testIdPrefix}-tab-${tab.key}-attention-dot`}
                >
                  {tab.label}
                </AttentionDot>
              ) : (
                tab.label
              )}
            </button>
          );
        })}
      </nav>
    </ScrollableTabStrip>
  );
}
