'use client';

import { useCallback, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { LedgerFilePicker } from '@canopy/app-core';
import type { LedgerFeedStore, LedgerViewStoreFor } from '@canopy/app-state';
import type {
  LedgerFeedAudience,
  LedgerFeedFilters,
  LedgerViewScope,
} from '@canopy/protocol/ledger-view';
import {
  LedgerComposerPrompt,
  LedgerFeedFilterMenu,
  TextInput,
} from '@canopy/ui-shared/components';
import {
  LedgerFeedComposer,
  useLedgerFeedDraft,
  type LedgerFeedScopeOption,
} from './LedgerFeedComposer';

const SEARCH_INPUT_MAX_LENGTH = 256;

const AUDIENCES: ReadonlyArray<{
  readonly audience: LedgerFeedAudience;
  readonly label: string;
}> = [
  { audience: 'mine', label: 'Mine' },
  { audience: 'teammates', label: 'Teammates' },
  { audience: 'this_device', label: 'This device' },
];

/** The Feed's audience, filters and search; typing stays in this toolbar. */
export function FeedControls({
  store,
  onAudienceChange,
  onSearchChange,
  onFiltersChange,
}: {
  readonly store: LedgerFeedStore;
  readonly onAudienceChange: (audience: LedgerFeedAudience) => void;
  readonly onSearchChange: (text: string) => void;
  readonly onFiltersChange: (filters: LedgerFeedFilters) => void;
}): JSX.Element {
  const { audience, queryText, filters } = store(
    useShallow((state) => ({
      audience: state.audience,
      queryText: state.queryText,
      filters: state.filters,
    })),
  );

  return (
    <div
      data-testid="ledger-feed-controls"
      className="flex shrink-0 flex-col gap-2 border-b border-line-base pb-2"
    >
      <div
        role="tablist"
        aria-label="Whose entries"
        className="canopy-tab-list flex gap-1"
      >
        {AUDIENCES.map((option) => {
          const active = option.audience === audience;
          return (
            <button
              key={option.audience}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`ledger-feed-audience-${option.audience}`}
              onClick={() => onAudienceChange(option.audience)}
              className={`canopy-tab-trigger px-3 py-2 text-xs font-medium transition-colors ${
                active ? 'fg-primary' : 'fg-secondary hover:fg-primary'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <LedgerFeedFilterMenu filters={filters} onChange={onFiltersChange} />
        <TextInput
          type="search"
          data-testid="ledger-feed-search"
          value={queryText}
          maxLength={SEARCH_INPUT_MAX_LENGTH}
          onChange={(event) => onSearchChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && queryText.length > 0) {
              event.stopPropagation();
              onSearchChange('');
            }
          }}
          placeholder="Search entries"
          aria-label="Search entries"
          className="min-w-0 flex-1"
        />
      </div>
    </div>
  );
}

/** The Add entry control/form in its one row above the Feed's entries. */
export function FeedComposerRow({
  store,
  scopeStore,
  scopeHasDraft,
  addableScopes,
  files,
  personName,
}: {
  readonly store: LedgerFeedStore;
  readonly scopeStore: LedgerViewStoreFor;
  readonly scopeHasDraft: (scope: LedgerViewScope) => boolean;
  readonly addableScopes: readonly LedgerFeedScopeOption[];
  readonly files?: LedgerFilePicker;
  readonly personName: string;
}): JSX.Element {
  const composer = store((state) => state.composer);
  const { heldDraft, composing } = useLedgerFeedDraft(
    store,
    composer,
    scopeStore,
  );
  const onOpen = useCallback((): void => {
    store.getState().startEntry(scopeStore);
  }, [store, scopeStore]);

  if (composing) {
    return (
      <div className="border-b border-line-base pb-4">
        <LedgerFeedComposer
          store={store}
          scopeStore={scopeStore}
          scopeHasDraft={scopeHasDraft}
          addableScopes={addableScopes}
          files={files}
        />
      </div>
    );
  }

  return (
    <LedgerComposerPrompt
      density="page"
      personName={personName}
      testId="ledger-feed-add-entry"
      {...(heldDraft === null ? {} : { label: 'Continue draft' })}
      disabledReason={
        heldDraft === null && addableScopes.length === 0
          ? 'Open a project or task to add entries to it.'
          : null
      }
      onOpen={onOpen}
    />
  );
}
