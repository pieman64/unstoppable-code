'use client';

import type { JSX } from 'react';
import type { LedgerViewFileCandidate } from '@canopy/protocol/ledger-view';
import { ListRow } from '../ListRow';
import { SearchField } from '../SearchField';

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
  const showResults = query.trim().length > 0;
  return (
    <div className="flex flex-col gap-1">
      <SearchField
        aria-label="Find a file"
        value={query}
        disabled={disabled}
        placeholder="Find a file"
        data-testid="ledger-file-search"
        onValueChange={onQueryChange}
        clearLabel="Clear file search"
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
              <ListRow
                data-testid="ledger-file-search-result"
                onClick={() => onPick(file)}
                trailing={file.rootName}
              >
                {/* The root shows beside it; the cut-off path keeps its full
                    value as a native title. */}
                <span className="font-mono" title={file.path}>
                  {file.path}
                </span>
              </ListRow>
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
