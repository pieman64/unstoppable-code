import type { JSX, RefObject } from 'react';
import { PageSearchField } from './PageSearchRow';

export interface MarketplaceSearchFieldProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Escape on an empty field: the host backs out one level (a category, a page). */
  readonly onEscapeEmpty?: () => void;
  readonly inputRef?: RefObject<HTMLInputElement | null>;
  /** Accessible name, also the placeholder: `Search all capabilities`. */
  readonly ariaLabel: string;
  readonly clearAriaLabel: string;
  readonly testId: string;
  readonly clearTestId: string;
  /** Placement only; the field owns its own shape. */
  readonly className?: string;
}

/**
 * The Customize search, shared by the desktop and web browse pages and their
 * category pages: the page search field, filling its `PageSearchRow`. Escape clears the query first, then hands off to the host;
 * ArrowDown moves focus to the first result card.
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
  className = '',
}: MarketplaceSearchFieldProps): JSX.Element {
  return (
    <PageSearchField
      ref={inputRef}
      value={value}
      onValueChange={onChange}
      onEscapeEmpty={onEscapeEmpty}
      aria-label={ariaLabel}
      placeholder={ariaLabel}
      clearLabel={clearAriaLabel}
      data-testid={testId}
      clearTestId={clearTestId}
      className={className}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowDown') return;
        const firstEntry = document.querySelector<HTMLButtonElement>(
          '[data-marketplace-entry="true"]',
        );
        if (firstEntry) {
          event.preventDefault();
          firstEntry.focus();
        }
      }}
    />
  );
}
