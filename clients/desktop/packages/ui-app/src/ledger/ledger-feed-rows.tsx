'use client';

import { useCallback, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { LedgerClient, LedgerFilePicker } from '@canopy/app-core';
import type { LedgerFeedStore, LedgerViewStoreFor } from '@canopy/app-state';
import type {
  LedgerFeedAudience,
  LedgerFeedFilters,
  LedgerViewScope,
} from '@canopy/protocol/ledger-view';
import {
  LedgerComposerPrompt,
  LedgerFeedFilterMenu,
  PageSearchControls,
  PageSearchField,
  PageSearchRow,
  TabBar,
} from '@canopy/ui-shared/components';
import {
  LedgerFeedComposer,
  useLedgerFeedDraft,
  type LedgerFeedScopeOption,
} from './LedgerFeedComposer';
import { Divider } from '@canopy/ui-shared/components';

const SEARCH_INPUT_MAX_LENGTH = 256;

const AUDIENCE_LABELS: { readonly [Audience in LedgerFeedAudience]: string } = {
  mine: 'Mine',
  teammates: 'Teammates',
  this_device: 'This device',
};

/** Every audience, in tab order; a host without a device of its own drops one. */
export const LEDGER_FEED_ALL_AUDIENCES: readonly LedgerFeedAudience[] = [
  'mine',
  'teammates',
  'this_device',
];

/** The Feed's audience, filters and search; typing stays in this toolbar. */
export function FeedControls({
  store,
  audiences = LEDGER_FEED_ALL_AUDIENCES,
  onAudienceChange,
  onSearchChange,
  onFiltersChange,
  heading,
  onOnlyThisDeviceChange,
}: {
  readonly store: LedgerFeedStore;
  /** The tabs offered, in order. */
  readonly audiences?: readonly LedgerFeedAudience[];
  readonly onAudienceChange: (audience: LedgerFeedAudience) => void;
  readonly onSearchChange: (text: string) => void;
  readonly onFiltersChange: (filters: LedgerFeedFilters) => void;
  readonly heading: boolean;
  readonly onOnlyThisDeviceChange: (checked: boolean) => void;
}): JSX.Element {
  const { audience, onlyThisDevice, queryText, filters } = store(
    useShallow((state) => ({
      audience: state.audience,
      onlyThisDevice: state.onlyThisDevice,
      queryText: state.queryText,
      filters: state.filters,
    })),
  );

  return (
    <div
      data-testid="ledger-feed-controls"
      className="flex shrink-0 flex-col gap-4 pb-2"
    >
      {!heading && (
        <TabBar
          items={audiences.map((option) => ({
            id: option,
            label: AUDIENCE_LABELS[option],
            dataTestId: `ledger-feed-audience-${option}`,
          }))}
          value={audience}
          onChange={(next): void => onAudienceChange(next)}
          label="Whose entries"
          density="compact"
        />
      )}
      {/* The page search row: the search fills it, the filters follow as
          one Filter dropdown. No hairline under it; the list follows. */}
      <PageSearchRow>
        <PageSearchField
          data-testid="ledger-feed-search"
          value={queryText}
          maxLength={SEARCH_INPUT_MAX_LENGTH}
          onValueChange={onSearchChange}
          placeholder="Search entries"
          aria-label="Search entries"
        />
        <PageSearchControls>
          <LedgerFeedFilterMenu
            trigger="page"
            filters={filters}
            onChange={onFiltersChange}
            {...(heading
              ? {
                  onlyThisDevice: {
                    checked: onlyThisDevice,
                    onChange: onOnlyThisDeviceChange,
                  },
                }
              : {})}
          />
        </PageSearchControls>
      </PageSearchRow>
    </div>
  );
}

/** The Add entry control/form in its one row above the Feed's entries. */
export function FeedComposerRow({
  store,
  client,
  scopeStore,
  scopeHasDraft,
  addableScopes,
  files,
  personName,
}: {
  readonly store: LedgerFeedStore;
  readonly client: LedgerClient;
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
      <div>
        <div className="pb-4">
          <LedgerFeedComposer
            store={store}
            client={client}
            scopeStore={scopeStore}
            scopeHasDraft={scopeHasDraft}
            addableScopes={addableScopes}
            files={files}
          />
        </div>
        <Divider />
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
