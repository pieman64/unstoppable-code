'use client';

import { useCallback, useEffect, type JSX, type RefObject } from 'react';
import {
  SearchIcon as AppCatalogSearchIcon,
  ChevronTopMediumIcon as AppCatalogChevronTopMediumIcon,
  ChevronDownMediumIcon as AppCatalogChevronDownMediumIcon,
  CloseIcon as AppCatalogCloseIcon,
} from '../icons/AppIcons';

export interface SearchBarProps {
  query: string;
  onQueryChange: (query: string) => void;
  currentIndex: number;
  totalCount: number;
  onNext: () => void;
  onPrevious: () => void;
  /** When provided, renders a close button (X) and Escape dismisses. */
  onClose?: () => void;
  autoFocus?: boolean;
  className?: string;
  /** Allows the parent to imperatively focus the input (e.g. on repeated Cmd+F). */
  inputRef?: RefObject<HTMLInputElement | null>;
  /** Accessible input name; defaults to the common search label. */
  label?: string;
  /** Input placeholder; defaults to `Search…`. */
  placeholder?: string;
}

function SearchIcon(): JSX.Element {
  return (
    <AppCatalogSearchIcon
      width="14"
      height="14"
      className="shrink-0 fg-secondary"
    />
  );
}

function ChevronUpIcon(): JSX.Element {
  return <AppCatalogChevronTopMediumIcon width="14" height="14" />;
}

function ChevronDownIcon(): JSX.Element {
  return <AppCatalogChevronDownMediumIcon width="14" height="14" />;
}

function CloseIcon(): JSX.Element {
  return <AppCatalogCloseIcon width="14" height="14" />;
}

export function SearchBar({
  query,
  onQueryChange,
  currentIndex,
  totalCount,
  onNext,
  onPrevious,
  onClose,
  autoFocus = false,
  className = '',
  inputRef,
  label = 'Search',
  placeholder = 'Search…',
}: SearchBarProps): JSX.Element {
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>): void => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onNext();
      } else if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        onPrevious();
      } else if (e.key === 'Escape' && onClose) {
        e.preventDefault();
        onClose();
      }
    },
    [onNext, onPrevious, onClose],
  );

  // Focus input on mount when autoFocus is true (handles lazy-rendered tray)
  useEffect(() => {
    if (autoFocus && inputRef?.current) {
      inputRef.current.focus();
    }
  }, [autoFocus, inputRef]);

  const hasQuery = query.length >= 2;
  const counterText = hasQuery
    ? `${totalCount === 0 ? 0 : currentIndex + 1} of ${totalCount}`
    : '';

  return (
    <div
      className={`flex items-center gap-1.5 ${className}`}
      data-testid="content-search-bar"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border bg-base/80 px-2 py-1">
        <SearchIcon />
        <input
          ref={inputRef}
          aria-label={label}
          data-search-bar
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          autoFocus={autoFocus}
          className="min-w-0 flex-1 bg-transparent text-xs fg-primary outline-none placeholder:fg-secondary"
        />
        {query.length > 0 && (
          <button
            type="button"
            onClick={() => onQueryChange('')}
            className="shrink-0 rounded-sm p-0.5 fg-secondary transition hover:fg-primary"
            aria-label="Clear search"
          >
            <CloseIcon />
          </button>
        )}
        {hasQuery && (
          <span
            className="shrink-0 text-3xs tabular-nums fg-secondary"
            aria-live="polite"
          >
            {counterText}
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={onPrevious}
        disabled={totalCount === 0}
        className="focus-ring rounded p-1 fg-secondary transition hover:fg-primary disabled:opacity-30"
        aria-label="Previous match"
      >
        <ChevronUpIcon />
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={totalCount === 0}
        className="focus-ring rounded p-1 fg-secondary transition hover:fg-primary disabled:opacity-30"
        aria-label="Next match"
      >
        <ChevronDownIcon />
      </button>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="focus-ring rounded p-1 fg-secondary transition hover:fg-primary"
          aria-label="Close search"
        >
          <CloseIcon />
        </button>
      )}
    </div>
  );
}
