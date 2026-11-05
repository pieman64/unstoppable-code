'use client';

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  PickerMenuList,
  PickerMenuOption,
  PickerMenuOptionLabel,
  PickerMenuSearchHeader,
  PickerMenuSearchInput,
  PickerMenuSkeleton,
  PickerMenuState,
} from './PickerMenu';

export interface PickListRowState {
  /** The keyboard-active row (the neutral picker highlight). */
  readonly active: boolean;
  /** The current value, when the list marks one. */
  readonly selected: boolean;
}

export interface PickListProps<T> {
  readonly items: readonly T[];
  readonly getKey: (item: T) => string;
  /** The text the search matches and the default row label. */
  readonly getLabel: (item: T) => string;
  /** Row content; defaults to the label. Draw it with the PickerMenuOption parts. */
  readonly renderItem?: (item: T, state: PickListRowState) => ReactNode;
  readonly onPick: (item: T) => void;
  /** Names the search field: `Search commands`. */
  readonly searchLabel: string;
  readonly placeholder?: string;
  /** Names the list of results for assistive tech. */
  readonly listLabel: string;
  /**
   * Controlled search text, for a list whose results come from elsewhere
   * (a server search). Without it the list filters `items` by label.
   */
  readonly query?: string;
  readonly onQueryChange?: (query: string) => void;
  /** Local filter; defaults to a case-insensitive label match. */
  readonly filter?: (item: T, query: string) => boolean;
  /** Results are on their way: placeholder rows replace the list. */
  readonly loading?: boolean;
  readonly loadingLabel?: string;
  /** One sentence for no results: `No commands match.` */
  readonly emptyLabel: ReactNode;
  readonly selectedKey?: string;
  /** Move focus to the search field on mount (default true). */
  readonly autoFocus?: boolean;
  /** Escape in the search field, for a host that closes on it. */
  readonly onEscape?: () => void;
  readonly 'data-testid'?: string;
  readonly searchTestId?: string;
  readonly optionTestId?: (item: T) => string;
  /**
   * Caps the search field and list at this height so the list scrolls:
   * `md` (256px) in a popover or picker, `lg` (384px) in a palette.
   * Default: the host's height.
   */
  readonly listMaxHeight?: 'md' | 'lg';
}

function labelMatches(label: string, query: string): boolean {
  return label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}

/**
 * The one search-and-pick list: a search field over picker rows. Typing
 * filters; the arrows, Home and End move the active row while focus stays in
 * the field, and Enter or a click picks. It owns the combobox, `listbox` and
 * `option` semantics and the empty and loading states, so a palette, a
 * picker and the composer's lists behave and read the same. Put it in a
 * `DialogModal` (a palette), a `FloatingPickerMenu` or a `Popover`.
 */
export function PickList<T>({
  items,
  getKey,
  getLabel,
  renderItem,
  onPick,
  searchLabel,
  placeholder,
  listLabel,
  query: controlledQuery,
  onQueryChange,
  filter,
  loading = false,
  loadingLabel = 'Loading',
  emptyLabel,
  selectedKey,
  autoFocus = true,
  onEscape,
  'data-testid': dataTestId,
  searchTestId,
  optionTestId,
  listMaxHeight,
}: PickListProps<T>): JSX.Element {
  const baseId = useId();
  const listId = `${baseId}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [localQuery, setLocalQuery] = useState('');
  const query = controlledQuery ?? localQuery;
  const setQuery = (next: string): void => {
    if (controlledQuery === undefined) setLocalQuery(next);
    onQueryChange?.(next);
  };

  const visible = useMemo((): readonly T[] => {
    if (controlledQuery !== undefined && filter === undefined) return items;
    if (query.trim() === '') return items;
    const matches =
      filter ??
      ((item: T, q: string): boolean => labelMatches(getLabel(item), q));
    return items.filter((item) => matches(item, query));
  }, [controlledQuery, filter, getLabel, items, query]);

  const [activeIndex, setActiveIndex] = useState(0);
  // Keyed on the rows' content, not their identity: a host that passes a
  // fresh array or inline callbacks on every render must not move the
  // highlight under the user.
  const visibleKeys = useMemo(
    (): string => visible.map(getKey).join('\u0000'),
    [getKey, visible],
  );
  // A new result set starts on its first row (or the current value).
  useEffect(() => {
    const selectedIndex =
      selectedKey === undefined || visibleKeys === ''
        ? -1
        : visibleKeys.split('\u0000').indexOf(selectedKey);
    setActiveIndex(selectedIndex === -1 ? 0 : selectedIndex);
  }, [selectedKey, visibleKeys]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const optionId = (index: number): string => `${baseId}-option-${index}`;
  const showRows = !loading && visible.length > 0;
  const active = showRows
    ? Math.min(Math.max(activeIndex, 0), visible.length - 1)
    : -1;

  useEffect(() => {
    if (active < 0) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[id="${baseId}-option-${active}"]`,
    );
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [active, baseId]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    // Keys during an IME composition (Enter confirming a candidate) belong to
    // the input method, not to the list.
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && onEscape) {
      event.preventDefault();
      onEscape();
      return;
    }
    if (!showRows) return;
    const last = visible.length - 1;
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = active >= last ? 0 : active + 1;
    else if (event.key === 'ArrowUp') next = active <= 0 ? last : active - 1;
    else if (event.key === 'Home' && !event.shiftKey) next = 0;
    else if (event.key === 'End' && !event.shiftKey) next = last;
    else if (event.key === 'Enter') {
      const item = visible[active];
      if (item !== undefined) {
        event.preventDefault();
        onPick(item);
      }
      return;
    }
    if (next === null) return;
    event.preventDefault();
    setActiveIndex(next);
  };

  return (
    <div
      data-testid={dataTestId}
      className={
        listMaxHeight === 'lg'
          ? 'flex max-h-96 min-h-0 flex-col'
          : listMaxHeight === 'md'
            ? 'flex max-h-64 min-h-0 flex-col'
            : 'flex min-h-0 flex-col'
      }
    >
      <PickerMenuSearchHeader>
        <PickerMenuSearchInput
          ref={inputRef}
          role="combobox"
          aria-label={searchLabel}
          aria-expanded={showRows}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? optionId(active) : undefined}
          placeholder={placeholder ?? searchLabel}
          value={query}
          data-testid={searchTestId}
          onChange={(event): void => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          onClear={query ? (): void => setQuery('') : undefined}
        />
      </PickerMenuSearchHeader>
      <PickerMenuList
        ref={listRef}
        id={listId}
        aria-label={listLabel}
        aria-busy={loading || undefined}
      >
        {loading ? (
          <PickerMenuSkeleton label={loadingLabel} rows={4} leading={false} />
        ) : visible.length === 0 ? (
          <PickerMenuState role="status">{emptyLabel}</PickerMenuState>
        ) : (
          visible.map((item, index) => {
            const key = getKey(item);
            const state: PickListRowState = {
              active: index === active,
              selected: selectedKey === key,
            };
            return (
              <PickerMenuOption
                key={key}
                id={optionId(index)}
                role="option"
                tabIndex={-1}
                aria-selected={state.active}
                active={state.active}
                data-testid={optionTestId?.(item)}
                // Keep focus in the search field.
                onMouseDown={(event): void => event.preventDefault()}
                onMouseMove={(): void => {
                  if (index !== active) setActiveIndex(index);
                }}
                onClick={(): void => onPick(item)}
              >
                {renderItem ? (
                  renderItem(item, state)
                ) : (
                  <PickerMenuOptionLabel>
                    {getLabel(item)}
                  </PickerMenuOptionLabel>
                )}
              </PickerMenuOption>
            );
          })
        )}
      </PickerMenuList>
    </div>
  );
}
