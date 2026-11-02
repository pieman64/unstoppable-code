import type { JSX } from 'react';
import type { UnifiedEntryKind } from '@canopy/protocol/unified-entry';
import { CUSTOMIZE_ROW_GRID_CLASS } from '../lib/customize-grid';
import { McpServerLogo } from './McpServerLogo';
import { MarketplaceTypeLabel } from './MarketplaceTypeLabel';

/** One row in a related-items section (CAN-2382). */
export interface RelatedItemRow {
  key: string;
  /** Emoji tile shown before the title (pipelines); omitted for capabilities. */
  icon?: string;
  title: string;
  subtitle?: string;
  /** Small type/source badge, e.g. "Bundled", "Skill", "Plugin". */
  badge?: string;
  badgeClass?: string;
  /** The item's kind: a list badge takes the Customize type tint. */
  kind?: UnifiedEntryKind;
  /** Why this item is related, when it is not obvious. */
  reason?: string;
  onOpen: () => void;
}

interface RelatedItemsSectionProps {
  title: string;
  description?: string;
  emptyLabel: string;
  items: RelatedItemRow[];
  loading?: boolean;
  testId: string;
  presentation?: 'cards' | 'list';
  hideWhenEmpty?: boolean;
}

/**
 * Sectioned list of related items shown on skill, plugin, and pipeline detail
 * surfaces. Follows the pipeline-settings section idiom (heading, optional
 * description, bordered rows) so it reads natively on every host. Renders a
 * small empty state when there are no items; renders nothing while loading so
 * the empty state never flashes.
 */
export function RelatedItemsSection({
  title,
  description,
  emptyLabel,
  items,
  loading = false,
  testId,
  presentation = 'cards',
  hideWhenEmpty = false,
}: RelatedItemsSectionProps): JSX.Element {
  if (hideWhenEmpty && items.length === 0) return <></>;
  const list = presentation === 'list';
  return (
    <section data-testid={testId}>
      <h3
        className={`text-s font-semibold fg-primary ${description ? 'mb-1' : 'mb-3'}`}
      >
        {title}
      </h3>
      {description && (
        <p className="text-xs fg-secondary mb-3">{description}</p>
      )}
      {loading ? null : items.length === 0 ? (
        <p className="text-xs fg-secondary" data-testid={`${testId}-empty`}>
          {emptyLabel}
        </p>
      ) : (
        // `list` rows are the Customize list's row cards (CAN-4261): an
        // avatar, the name with its tinted type, the inset rounded hover,
        // in the same two-column grid as Installed and Browse.
        <div
          data-testid={`${testId}-rows`}
          className={list ? CUSTOMIZE_ROW_GRID_CLASS : 'space-y-2'}
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={item.onOpen}
              data-testid={`${testId}-item-${item.key}`}
              // `hover:bg-subtle` is the app's row hover (DropdownMenuItem,
              // the sidebar rows, SidebarPageNav), and it lives here rather
              // than at a call site: hosts render this primitive as-is, and a
              // restyling class on a shared component is a design-lint error.
              className={
                list
                  ? 'focus-ring -ml-4 flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-xl px-4 py-2.5 text-left transition-colors hover:bg-subtle pointer-coarse:min-h-11'
                  : 'w-full flex items-start gap-3 p-3 rounded-lg border cursor-pointer hover:bg-subtle text-left'
              }
            >
              {list && item.icon === undefined && (
                <span
                  data-testid={`${testId}-item-${item.key}-avatar`}
                  className="flex shrink-0"
                >
                  <McpServerLogo
                    size={28}
                    fallback="monogram"
                    name={item.title}
                    shape="circle"
                    fit="contain"
                  />
                </span>
              )}
              {item.icon !== undefined && (
                <div className="shrink-0 w-8 h-8 rounded-lg bg-accent-subtle flex items-center justify-center text-m">
                  {item.icon || '⚡'}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div
                  className={`flex items-center ${list ? 'gap-1.5' : 'gap-2'}`}
                >
                  <span className="min-w-0 truncate text-s font-medium fg-primary">
                    {item.title}
                  </span>
                  {item.badge && item.kind && (
                    <MarketplaceTypeLabel kind={item.kind} label={item.badge} />
                  )}
                  {item.badge && !item.kind && (
                    <span
                      className={
                        list
                          ? 'shrink-0 text-xs fg-secondary'
                          : `shrink-0 px-1.5 py-0.5 text-3xs font-medium rounded ${item.badgeClass ?? 'bg-secondary fg-secondary'}`
                      }
                    >
                      {item.badge}
                    </span>
                  )}
                </div>
                {item.subtitle && (
                  <p
                    className={`mt-0.5 truncate text-xs ${list ? 'fg-tertiary' : 'fg-secondary'}`}
                  >
                    {item.subtitle}
                  </p>
                )}
                {item.reason && !list && (
                  <p className="text-xs fg-secondary mt-0.5 truncate">
                    {item.reason}
                  </p>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
