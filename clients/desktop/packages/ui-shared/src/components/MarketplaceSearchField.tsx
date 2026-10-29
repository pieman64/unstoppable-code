import {
  useRef,
  type JSX,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { CloseIcon, SearchIcon } from '../icons/AppIcons';

export interface MarketplaceSearchFieldProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Escape on an empty field: the host backs out one level (a category, a page). */
  readonly onEscapeEmpty?: () => void;
  readonly inputRef?: RefObject<HTMLInputElement | null>;
  readonly ariaLabel: string;
  readonly clearAriaLabel: string;
  readonly testId: string;
  readonly clearTestId: string;
  /** Placement only; the field owns its own shape. */
  readonly className?: string;
  /** Optional controls inside the field's trailing edge, before Clear. */
  readonly trailing?: ReactNode;
}

/**
 * The Marketplace's pill search, shared by the desktop and web browse pages and
 * their category pages. Escape clears the query first, then hands off to the
 * host; ArrowDown moves focus to the first result card.
 */
export function MarketplaceSearchField({
  value,
  onChange,
  onEscapeEmpty,
  inputRef,
  ariaLabel,
  clearAriaLabel,
  testId,
  clearTestId,
  className,
  trailing,
}: MarketplaceSearchFieldProps): JSX.Element {
  const ownRef = useRef<HTMLInputElement | null>(null);
  const ref: RefObject<HTMLInputElement | null> = inputRef ?? ownRef;
  const assignRef: Ref<HTMLInputElement> = ref;
  return (
    <div className={`relative -ml-4 ${className ?? ''}`.trim()}>
      <SearchIcon
        width="16"
        height="16"
        aria-hidden="true"
        className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 fg-tertiary"
      />
      <input
        ref={assignRef}
        type="search"
        data-testid={testId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            if (value) onChange('');
            else onEscapeEmpty?.();
            return;
          }
          if (event.key === 'ArrowDown') {
            const firstEntry = document.querySelector<HTMLButtonElement>(
              '[data-marketplace-entry="true"]',
            );
            if (firstEntry) {
              event.preventDefault();
              firstEntry.focus();
            }
          }
        }}
        placeholder="Search…"
        aria-label={ariaLabel}
        className={`w-full appearance-none rounded-full border bg-secondary py-2.5 pl-11 text-s fg-primary outline-none [&::-webkit-search-cancel-button]:appearance-none ${
          trailing ? 'pr-28' : 'pr-11'
        }`}
      />
      {trailing && (
        <div
          className={`absolute top-1/2 flex -translate-y-1/2 items-center gap-1 ${
            value ? 'right-10' : 'right-2'
          }`}
        >
          {trailing}
        </div>
      )}
      {value && (
        <button
          type="button"
          data-testid={clearTestId}
          aria-label={clearAriaLabel}
          onClick={() => {
            onChange('');
            ref.current?.focus();
          }}
          className="focus-ring absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full fg-tertiary transition-colors hover:bg-subtle hover:fg-primary pointer-coarse:h-11 pointer-coarse:w-11"
        >
          <CloseIcon width={14} height={14} aria-hidden />
        </button>
      )}
    </div>
  );
}
