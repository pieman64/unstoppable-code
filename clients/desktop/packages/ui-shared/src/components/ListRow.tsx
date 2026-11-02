import {
  forwardRef,
  type ButtonHTMLAttributes,
  type JSX,
  type ReactNode,
} from 'react';
import {
  SIDEBAR_ITEM_IDLE_CLASSNAME,
  SIDEBAR_ITEM_SELECTED_CLASSNAME,
} from './sidebar-item-classes';

export interface ListRowProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children'
> {
  /** The row's label. */
  readonly children: ReactNode;
  /** One line of secondary text under the label; the row grows to hold it. */
  readonly description?: ReactNode;
  /** A 16px glyph before the label. */
  readonly icon?: ReactNode;
  /** Quiet content at the end of the row: a time, a count, a chevron. */
  readonly trailing?: ReactNode;
  /**
   * The row the user is on; takes the selected fill instead of the hover.
   * Visual only: pass `aria-current` or `aria-selected` for what it means.
   */
  readonly selected?: boolean;
}

// The sidebar row's geometry (`SIDEBAR_LIST_ITEM_CLASSNAME`: 32px, row radius,
// 8px inset, 8px gap, 14px label) for clickable rows in page and panel
// content, so every list in the app shares one row. A disabled row greys its
// label, description, icon and trailing text together; the inner parts read
// the state through the row's group. A disabled row stays the click target
// (a click is swallowed, not handed to what is behind it) and drops the hover
// fill instead: `disabled:` sorts after `hover:`, so it wins.
const ROW_CLASS_NAME =
  'group/list-row focus-ring flex w-full gap-2 overflow-hidden rounded-row px-2 text-left text-s font-normal disabled:cursor-not-allowed disabled:fg-disabled';

const DISABLED_INK_CLASS_NAME = 'group-disabled/list-row:fg-disabled';

/**
 * A full-width clickable row that opens or selects something: a pipeline step,
 * a connector, a file. Actions inside a row stay `Button`s; the row itself is
 * this.
 */
export const ListRow = forwardRef<HTMLButtonElement, ListRowProps>(
  function ListRow(
    {
      children,
      description,
      icon,
      trailing,
      selected = false,
      className = '',
      type = 'button',
      ...buttonProps
    },
    ref,
  ): JSX.Element {
    const twoLine = description !== undefined && description !== null;
    const shapeClassName = twoLine
      ? 'min-h-8 items-start py-1.5'
      : 'h-8 items-center whitespace-nowrap';
    const stateClassName = selected
      ? SIDEBAR_ITEM_SELECTED_CLASSNAME
      : `${SIDEBAR_ITEM_IDLE_CLASSNAME} disabled:bg-transparent`;
    return (
      <button
        {...buttonProps}
        ref={ref}
        type={type}
        className={`${ROW_CLASS_NAME} ${shapeClassName} ${stateClassName}${className ? ` ${className}` : ''}`}
      >
        {icon !== undefined && (
          // The sidebar's 16px icon slot, 20px tall to match the label's line,
          // so the glyph centres on the first line in the two-line form too.
          <span
            className={`inline-flex h-5 w-4 shrink-0 items-center justify-center fg-secondary ${DISABLED_INK_CLASS_NAME}`}
          >
            {icon}
          </span>
        )}
        {twoLine ? (
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{children}</span>
            <span
              className={`truncate text-xs fg-secondary ${DISABLED_INK_CLASS_NAME}`}
            >
              {description}
            </span>
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate">{children}</span>
        )}
        {trailing !== undefined && (
          <span
            className={`ml-auto inline-flex h-5 shrink-0 items-center text-xs fg-quaternary ${DISABLED_INK_CLASS_NAME}`}
          >
            {trailing}
          </span>
        )}
      </button>
    );
  },
);

ListRow.displayName = 'ListRow';
