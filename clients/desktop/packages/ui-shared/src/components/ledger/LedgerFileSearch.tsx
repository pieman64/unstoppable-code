'use client';

import { useId, type JSX } from 'react';
import type { LedgerViewFileCandidate } from '@canopy/protocol/ledger-view';
import { TextInput } from '../Field';

export interface LedgerFileSearchProps {
  query: string;
  onQueryChange: (query: string) => void;
  results: readonly LedgerViewFileCandidate[];
  /** The search is running. */
  searching: boolean;
  onPick: (file: LedgerViewFileCandidate) => void;
  disabled?: boolean;
}

/**
 * Finds a file of the scope to reference. Results are paths under the
 * scope's own roots; picking one records its root and relative path, never
 * its content.
 */
export function LedgerFileSearch({
  query,
  onQueryChange,
  results,
  searching,
  onPick,
  disabled = false,
}: LedgerFileSearchProps): JSX.Element {
  const inputId = useId();
  const showResults = query.trim().length > 0;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="sr-only">
        Find a file
      </label>
      <TextInput
        id={inputId}
        type="search"
        value={query}
        disabled={disabled}
        placeholder="Find a file"
        data-testid="ledger-file-search"
        onChange={(event) => onQueryChange(event.target.value)}
        className="w-full"
      />
      {showResults && (
        <ul
          aria-label="Matching files"
          data-testid="ledger-file-search-results"
          className="flex max-h-40 flex-col overflow-y-auto"
        >
          {results.map((file) => (
            <li key={`${file.rootId}:${file.path}`}>
              <button
                type="button"
                data-testid="ledger-file-search-result"
                title={`${file.rootName}: ${file.path}`}
                onClick={() => onPick(file)}
                className="focus-ring flex w-full min-w-0 items-baseline gap-2 rounded px-2 py-1 text-left text-xs hover:bg-subtle"
              >
                <span className="truncate font-mono fg-primary">
                  {file.path}
                </span>
                <span className="shrink-0 fg-tertiary">{file.rootName}</span>
              </button>
            </li>
          ))}
          {!searching && results.length === 0 && (
            <li className="px-2 py-1 text-xs fg-tertiary">
              No matching files.
            </li>
          )}
          {searching && results.length === 0 && (
            <li className="px-2 py-1 text-xs fg-tertiary">Searching…</li>
          )}
        </ul>
      )}
    </div>
  );
}
