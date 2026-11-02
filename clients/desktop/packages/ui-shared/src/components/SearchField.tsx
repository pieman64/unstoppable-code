'use client';

import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { CloseIcon, SearchIcon, SearchXIcon } from '../icons/AppIcons';
import { Button } from './Button';
import { FIELD_EDGE_CLASS, FIELD_FOCUS_WITHIN_CLASS } from './Field';
import { EmptyState } from './StatusBlocks';
import { Tooltip } from './Tooltip';

/**
 * Search field size. `sm` is the 28px field of toolbars, panels and
 * settings lists; `md` is the 32px field of a page search row, on the
 * subtle fill inside a hairline and filling its row (see
 * `PageSearchRow`); `lg` is the 44px
 * borderless header of a palette or picker.
 */
export type SearchFieldSize = 'sm' | 'md' | 'lg';

/**
 * The capsule's height, insets and type. The trailing inset is the gap
 * between the capsule and a nested button above and below it (2px at 28px,
 * 4px at 32px, 8px at 44px), so each button's circle is concentric with the
 * end cap: inner radius = capsule radius − inset. Coarse pointers get a
 * taller capsule with the inset grown to match.
 */
const FIELD_SIZE_CLASS: Record<SearchFieldSize, string> = {
  sm: `h-7 gap-2 rounded-full pl-2.5 pr-0.5 text-xs pointer-coarse:h-9 pointer-coarse:pr-1.5 ${FIELD_EDGE_CLASS} ${FIELD_FOCUS_WITHIN_CLASS}`,
  // A page search row's field: the shared inset hairline at rest; focus
  // swaps it for the shared field focus edge. Its text matches the 28px
  // dropdowns beside it.
  md: `h-8 gap-2 rounded-full pl-3 pr-1 text-xs pointer-coarse:h-10 pointer-coarse:pr-2 ring-[length:var(--border-hairline)] ring-inset ring-line-base transition-shadow has-[input:focus]:ring-0 ${FIELD_FOCUS_WITHIN_CLASS}`,
  // The header of a surface that is itself the focus (a palette): no edge
  // and no focus ring of its own; the host draws the hairline under it.
  lg: 'h-11 gap-2.5 pl-4 pr-2 text-s',
};

/**
 * The fill. A page search row's field (`md`) rests on the subtle fill inside
 * a hairline, so it reads as the page's one search rather than another form
 * field, and takes the secondary fill while its input has focus.
 */
const FIELD_FILL_CLASS: Record<SearchFieldSize, string> = {
  sm: 'bg-transparent',
  md: 'bg-subtle has-[input:focus]:bg-secondary',
  lg: 'bg-transparent',
};

const ICON_SIZE: Record<SearchFieldSize, number> = { sm: 14, md: 16, lg: 16 };

/** Clear's glyph: 12px in a page search row's field, 14px elsewhere. */
const CLEAR_ICON_SIZE: Record<SearchFieldSize, number> = {
  sm: 14,
  md: 12,
  lg: 14,
};

/** Nested buttons: 24px in the 28px and 32px capsules, 28px in the header. */
const BUTTON_SIZE_CLASS: Record<SearchFieldSize, string> = {
  sm: 'h-6 min-w-6',
  md: 'h-6 min-w-6',
  lg: 'h-7 min-w-7',
};

const SearchFieldSizeContext = createContext<SearchFieldSize>('sm');

export interface SearchFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  | 'size'
  | 'type'
  | 'value'
  | 'defaultValue'
  | 'onChange'
  | 'className'
  | 'aria-label'
  | 'children'
> {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  /** Accessible name: `Search workflows`. The field has no visible label. */
  readonly 'aria-label': string;
  readonly size?: SearchFieldSize;
  /**
   * The result count shown while there is a query (`2 of 6`). The field
   * never says "no results" itself; the list's empty state does.
   */
  readonly count?: ReactNode;
  /**
   * Text that stays at the field's end whatever the query, before Clear:
   * a mode hint such as the palette's `Type > for commands`.
   */
  readonly trailing?: ReactNode;
  /**
   * Nested controls at the field's end, after Clear: `SearchFieldButton`s
   * that open filters or a sort.
   */
  readonly actions?: ReactNode;
  readonly clearLabel?: string;
  readonly clearTestId?: string;
  /**
   * Escape first clears the query; on an empty field it calls
   * `onEscapeEmpty`, or gives up focus without one. Set false where Escape
   * already means something else (a palette closes on it).
   */
  readonly clearOnEscape?: boolean;
  /** Escape on an empty field: the host backs out (a category, a page). */
  readonly onEscapeEmpty?: () => void;
  /** `data-testid` of the capsule around the input. */
  readonly fieldTestId?: string;
  /** Placement only (width, margins, flex); the field owns its shape. */
  readonly className?: string;
  /** Classes for the input itself, such as the session replay block class. */
  readonly inputClassName?: string;
}

/**
 * The one search field: the search glyph at its start and round buttons
 * nested in its end cap. While the field holds a query the end shows the
 * result count and a Clear button; filter and sort buttons follow a
 * hairline. `sm` and `md` rest on the shared field edge and focus to the
 * neutral field focus, like `TextInput`.
 *
 * The browser's own clear control is never drawn. The query is user text:
 * it stays inside the input and is never copied into an attribute.
 */
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(
  function SearchField(
    {
      value,
      onValueChange,
      size = 'sm',
      count,
      trailing,
      actions,
      clearLabel = 'Clear search',
      clearTestId,
      clearOnEscape = true,
      onEscapeEmpty,
      fieldTestId,
      className = '',
      inputClassName = '',
      onKeyDown,
      disabled,
      ...inputProps
    },
    ref,
  ): JSX.Element {
    const inputRef = useRef<HTMLInputElement | null>(null);
    const setInput = useCallback(
      (node: HTMLInputElement | null): void => {
        inputRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      },
      [ref],
    );
    const hasValue = value !== '';
    const hasCount = hasValue && count !== undefined && count !== null;
    const hasTrailing = trailing !== undefined && trailing !== null;

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
      onKeyDown?.(event);
      if (
        !clearOnEscape ||
        event.defaultPrevented ||
        event.key !== 'Escape' ||
        event.nativeEvent.isComposing
      ) {
        return;
      }
      if (hasValue) {
        // Clearing is this Escape's whole job; nothing behind the field
        // (a dialog, a panel) should close on it as well.
        event.preventDefault();
        event.stopPropagation();
        onValueChange('');
        return;
      }
      if (onEscapeEmpty) {
        event.preventDefault();
        onEscapeEmpty();
        return;
      }
      event.currentTarget.blur();
    };

    return (
      <SearchFieldSizeContext.Provider value={size}>
        <div
          data-search-field={size}
          data-testid={fieldTestId}
          className={`flex min-w-0 cursor-text items-center fg-primary ${FIELD_SIZE_CLASS[size]} ${disabled ? 'cursor-not-allowed bg-disabled fg-disabled' : FIELD_FILL_CLASS[size]} ${className}`}
          onMouseDown={(event): void => {
            // A press on the capsule's padding or glyph focuses the input,
            // as a press on a field's edge does.
            if (event.target === event.currentTarget) {
              event.preventDefault();
              inputRef.current?.focus();
            }
          }}
        >
          <SearchIcon
            width={ICON_SIZE[size]}
            height={ICON_SIZE[size]}
            aria-hidden="true"
            className="pointer-events-none shrink-0 fg-quaternary"
          />
          <input
            {...inputProps}
            ref={setInput}
            type="search"
            value={value}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            onChange={(event): void => onValueChange(event.target.value)}
            onKeyDown={handleKeyDown}
            className={`h-full min-w-0 flex-1 appearance-none truncate bg-transparent outline-none placeholder:fg-tertiary disabled:cursor-not-allowed [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none ${inputClassName}`}
          />
          {hasCount ? (
            <span
              className="shrink-0 whitespace-nowrap text-xs tabular-nums fg-tertiary"
              data-search-field-count=""
            >
              {count}
            </span>
          ) : null}
          {hasTrailing ? (
            <span className="flex shrink-0 items-center">{trailing}</span>
          ) : null}
          {hasValue ? (
            <SearchFieldButton
              tone="ghost"
              icon={
                <CloseIcon
                  size={CLEAR_ICON_SIZE[size]}
                  // The 12px glyph would otherwise snap to the 14px tier.
                  exactSize={CLEAR_ICON_SIZE[size] === 12}
                  aria-hidden="true"
                />
              }
              aria-label={clearLabel}
              data-testid={clearTestId}
              disabled={disabled}
              // Keep focus (and the caret) in the input.
              onMouseDown={(event): void => event.preventDefault()}
              onClick={(): void => {
                onValueChange('');
                inputRef.current?.focus();
              }}
            />
          ) : null}
          {actions ? (
            <>
              {hasValue ? (
                <span
                  aria-hidden="true"
                  className="h-3.5 w-[var(--border-hairline)] shrink-0 bg-line-base"
                />
              ) : null}
              <span className="flex shrink-0 items-center gap-0.5">
                {actions}
              </span>
            </>
          ) : null}
        </div>
      </SearchFieldSizeContext.Provider>
    );
  },
);

SearchField.displayName = 'SearchField';

export interface SearchFieldButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Action-oriented name, also the tooltip: `Filter`, `Sort: Name`. */
  readonly 'aria-label': string;
  /** The 14px app glyph. */
  readonly icon: ReactNode;
  /**
   * Filled with the primary ink while the control applies something (a
   * filter is on), so the state shows without opening its menu.
   */
  readonly active?: boolean;
  /**
   * `muted` is a quiet disc at rest, for the controls that open a menu;
   * `ghost` has no fill until hovered, for Clear.
   */
  readonly tone?: 'muted' | 'ghost';
}

const BUTTON_BASE_CLASS =
  "canopy-small-icon-stroke focus-ring relative inline-flex shrink-0 select-none items-center justify-center rounded-full px-0 transition-colors before:absolute before:-inset-0.5 before:content-[''] pointer-coarse:before:-inset-2.5 disabled:pointer-events-none disabled:opacity-50";

const BUTTON_TONE_CLASS = {
  active: 'bg-fg-primary [color:var(--bg-base)]',
  muted:
    'bg-muted fg-secondary hover:bg-subtle hover:fg-primary aria-expanded:bg-subtle aria-expanded:fg-primary',
  ghost: 'bg-transparent fg-tertiary hover:bg-subtle hover:fg-primary',
} as const;

/**
 * A round button nested in a `SearchField`'s end cap: Clear, Filter, Sort.
 * Its circle sits concentric with the capsule, and its name shows as a
 * tooltip (held back while its menu is open).
 */
export const SearchFieldButton = forwardRef<
  HTMLButtonElement,
  SearchFieldButtonProps
>(function SearchFieldButton(
  {
    icon,
    active = false,
    tone = 'muted',
    type = 'button',
    className = '',
    ...props
  },
  ref,
): JSX.Element {
  const size = useContext(SearchFieldSizeContext);
  const expanded =
    props['aria-expanded'] === true || props['aria-expanded'] === 'true';
  return (
    <Tooltip label={props['aria-label']} suppressed={expanded}>
      <button
        {...props}
        ref={ref}
        type={type}
        data-active={active ? 'true' : undefined}
        className={`${BUTTON_BASE_CLASS} ${BUTTON_SIZE_CLASS[size]} ${BUTTON_TONE_CLASS[active ? 'active' : tone]} ${className}`}
      >
        {icon}
      </button>
    </Tooltip>
  );
});

SearchFieldButton.displayName = 'SearchFieldButton';

export interface SearchEmptyStateProps {
  /**
   * One sentence: `Nothing matches your search.`, `No workflows match
   * these filters`. A node, so a caller can block a quoted query from
   * session replay.
   */
  readonly title: ReactNode;
  /** The one way out: `Clear search`, `Clear filters`. */
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly actionTestId?: string;
  readonly testId?: string;
}

/**
 * A search or filter that hides every row: the search-x glyph on its own in
 * the quiet ink, one sentence, and at most one action. The field above it
 * keeps its count and never says "no results" itself.
 */
export function SearchEmptyState({
  title,
  actionLabel,
  onAction,
  actionTestId,
  testId,
}: SearchEmptyStateProps): JSX.Element {
  return (
    <EmptyState
      testId={testId}
      icon={
        <SearchXIcon
          width={24}
          height={24}
          aria-hidden="true"
          className="fg-tertiary"
        />
      }
      title={<span className="text-pretty">{title}</span>}
      titleWeight="normal"
      spacing="relaxed"
      action={
        actionLabel && onAction ? (
          <Button
            variant="secondary"
            size="sm"
            data-testid={actionTestId}
            onClick={onAction}
          >
            {actionLabel}
          </Button>
        ) : undefined
      }
    />
  );
}
