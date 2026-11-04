import type { JSX, ReactNode } from 'react';
import { MoreHorizontalIcon } from '../../icons/AppIcons';
import { LoadingSpinner } from '../LoadingSpinner';
import { Heading } from '../Heading';

export interface PanelEmptyGroupCatalogEntry {
  readonly key: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly onActivate: () => void;
  readonly testId?: string;
  readonly disabled?: boolean;
  /** Shows a spinner in place of the icon while the panel is being created. */
  readonly busy?: boolean;
}

export interface PanelEmptyGroupCatalogProps {
  readonly title: string;
  readonly entries: readonly PanelEmptyGroupCatalogEntry[];
  /** Opens the group's full add menu, for what the short list leaves out. */
  readonly onMore?: () => void;
  /**
   * The open add menu, rendered inside the More row so it opens from that
   * row rather than from the group's `+`.
   */
  readonly moreMenu?: ReactNode;
  readonly moreLabel?: string;
  readonly testId?: string;
}

const ROW_CLASS_NAME =
  'focus-ring flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-s fg-primary hover:bg-subtle disabled:opacity-50 disabled:hover:bg-transparent';

/**
 * An empty panel group's starting point: what can be opened there, one row
 * per surface, so the group explains itself instead of showing a blank area.
 */
export function PanelEmptyGroupCatalog({
  title,
  entries,
  onMore,
  moreMenu,
  moreLabel = 'More…',
  testId,
}: PanelEmptyGroupCatalogProps): JSX.Element {
  return (
    <div
      data-testid={testId}
      className="flex h-full min-h-0 flex-col items-center justify-center overflow-y-auto p-4"
    >
      <div className="flex w-full max-w-64 flex-col gap-2">
        <div className="px-2">
          <Heading level={2} variant="title">
            {title}
          </Heading>
        </div>
        <ul className="flex flex-col">
          {entries.map((entry) => (
            <li key={entry.key}>
              <button
                type="button"
                className={ROW_CLASS_NAME}
                data-testid={entry.testId}
                disabled={entry.disabled}
                aria-busy={entry.busy || undefined}
                onClick={entry.onActivate}
              >
                <span
                  aria-hidden="true"
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center fg-tertiary"
                >
                  {entry.busy ? <LoadingSpinner /> : entry.icon}
                </span>
                <span className="min-w-0 truncate">{entry.label}</span>
              </button>
            </li>
          ))}
          {onMore !== undefined && (
            <li className="relative">
              <button
                type="button"
                className={ROW_CLASS_NAME}
                data-testid={
                  testId !== undefined ? `${testId}-more` : undefined
                }
                aria-haspopup="menu"
                aria-expanded={moreMenu !== undefined}
                onClick={onMore}
              >
                <span
                  aria-hidden="true"
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center fg-tertiary"
                >
                  <MoreHorizontalIcon />
                </span>
                <span className="min-w-0 truncate fg-secondary">
                  {moreLabel}
                </span>
              </button>
              {moreMenu}
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
