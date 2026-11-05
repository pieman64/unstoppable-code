'use client';

import { useEffect, useId, useRef, useState, type JSX } from 'react';
import type { LedgerClient, LedgerFilePicker } from '@canopy/app-core';
import type { LedgerViewDraft, LedgerViewOwnersState } from '@canopy/app-state';
import type { LedgerEntrySearchItem } from '@canopy/protocol/canopy-core';
import {
  ledgerViewScopeKey,
  type LedgerTaskViewScope,
  type LedgerViewFileCandidate,
  type LedgerViewScope,
} from '@canopy/protocol/ledger-view';
import {
  LedgerFileSearch,
  FormField,
  LedgerOwnerPicker,
  SettingsSelect,
} from '@canopy/ui-shared/components';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

/** Typing settles this long before a file search runs. */
const FILE_SEARCH_DEBOUNCE_MS = 200;
const FILE_SEARCH_LIMIT = 20;
const OPERATION_OPTION_TEST_ID = 'feed-composer-operation-picker-option';

export interface LedgerDraftFileSearchProps {
  readonly files: LedgerFilePicker;
  /** The task whose files are found; a global scope has none. */
  readonly scope: LedgerTaskViewScope;
  readonly draft: LedgerViewDraft;
  readonly saving: boolean;
  readonly onChange: (patch: Partial<LedgerViewDraft>) => void;
}

/** The files a search found, and the scope it searched. */
interface FoundFiles {
  readonly scopeKey: string;
  readonly files: readonly LedgerViewFileCandidate[];
}

/**
 * Finds one of the scope's files and adds it to the draft's references. When
 * the draft moves to another scope, the files found in the one it left never
 * show, even for a moment: they can't be picked for the new one.
 */
export function LedgerDraftFileSearch({
  files,
  scope,
  draft,
  saving,
  onChange,
}: LedgerDraftFileSearchProps): JSX.Element {
  const [query, setQuery] = useState('');
  const scopeKey = ledgerViewScopeKey(scope);
  const [found, setFound] = useState<FoundFiles>({ scopeKey, files: [] });
  const [searching, setSearching] = useState(false);
  const searchGeneration = useRef(0);
  const current = found.scopeKey === scopeKey;

  useEffect(() => {
    const trimmed = query.trim();
    const searched = ledgerViewScopeKey(scope);
    const generation = ++searchGeneration.current;
    if (trimmed.length === 0) {
      setFound({ scopeKey: searched, files: [] });
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      void files
        .searchFiles(scope, trimmed, FILE_SEARCH_LIMIT)
        .catch((): readonly LedgerViewFileCandidate[] => [])
        .then((matched) => {
          if (generation !== searchGeneration.current) return;
          setFound({ scopeKey: searched, files: matched });
          setSearching(false);
        });
    }, FILE_SEARCH_DEBOUNCE_MS);
    return (): void => clearTimeout(timer);
  }, [query, files, scope]);

  return (
    <LedgerFileSearch
      query={query}
      onQueryChange={setQuery}
      results={current ? found.files : []}
      // A query with no results of this scope yet is still being searched.
      searching={searching || (!current && query.trim().length > 0)}
      disabled={saving}
      onPick={(file) => {
        setQuery('');
        if (
          draft.referenceFiles.some(
            (existing) =>
              existing.rootId === file.rootId && existing.path === file.path,
          )
        ) {
          return;
        }
        onChange({
          referenceFiles: [
            ...draft.referenceFiles,
            { rootId: file.rootId, path: file.path },
          ],
        });
      }}
    />
  );
}

export interface LedgerDraftOwnerPickerProps {
  /** The field's visible label; the trigger takes `${labelId}-picker`. */
  readonly labelId: string;
  readonly draft: LedgerViewDraft;
  readonly owners: LedgerViewOwnersState;
  readonly saving: boolean;
  /** Why no owner can be chosen yet; the picker waits. */
  readonly disabledReason?: string;
  readonly onOpen: () => void;
  readonly onChange: (patch: Partial<LedgerViewDraft>) => void;
}

/** The draft's owner: the person ("You") unless they choose another. */
export function LedgerDraftOwnerPicker({
  labelId,
  draft,
  owners,
  saving,
  disabledReason,
  onOpen,
  onChange,
}: LedgerDraftOwnerPickerProps): JSX.Element {
  return (
    <LedgerOwnerPicker
      variant="field"
      id={`${labelId}-picker`}
      aria-labelledby={labelId}
      ownerName={draft.owner === null ? 'You' : draft.owner.displayName}
      ownerActorId={draft.owner === null ? null : draft.owner.actor.actorId}
      ownerPipelineAgent={draft.owner?.pipelineAgent}
      candidates={owners.candidates}
      status={owners.status}
      saving={saving}
      {...(disabledReason === undefined ? {} : { disabledReason })}
      onOpen={onOpen}
      onSelect={(candidate) =>
        onChange({
          owner: candidate === null || candidate.isSelf ? null : candidate,
        })
      }
    />
  );
}

interface FoundOperations {
  readonly scopeKey: string;
  readonly entries: readonly LedgerEntrySearchItem[];
  readonly pending: boolean;
}

export interface LedgerDraftOperationPickerProps {
  readonly client: LedgerClient;
  readonly scope: LedgerViewScope;
  readonly draft: LedgerViewDraft;
  readonly saving: boolean;
  readonly onChange: (patch: Partial<LedgerViewDraft>) => void;
}

/** The open operation in this task that owns the new task. */
export function LedgerDraftOperationPicker({
  client,
  scope,
  draft,
  saving,
  onChange,
}: LedgerDraftOperationPickerProps): JSX.Element {
  const id = useId();
  const scopeKey = ledgerViewScopeKey(scope);
  const [found, setFound] = useState<FoundOperations>(() => ({
    scopeKey,
    entries: [],
    pending: true,
  }));
  const searchGeneration = useRef(0);

  useEffect(() => {
    const generation = ++searchGeneration.current;
    setFound({ scopeKey, entries: [], pending: true });
    void client
      .searchEntries({
        scope,
        params: {
          types: ['OPERATION'],
          statuses: ['TODO', 'IN_PROGRESS', 'BLOCKED', 'NEEDS_REVIEW'],
          parentEntryId: null,
          limit: 100,
        },
      })
      .then(
        (result): void => {
          if (generation !== searchGeneration.current) return;
          setFound({
            scopeKey,
            entries: result.status === 'ok' ? result.value.entries : [],
            pending: false,
          });
        },
        (): void => {
          if (generation !== searchGeneration.current) return;
          setFound({ scopeKey, entries: [], pending: false });
        },
      );
    return (): void => {
      searchGeneration.current += 1;
    };
  }, [client, scope, scopeKey]);

  const entries = found.scopeKey === scopeKey ? found.entries : [];
  const parentListed =
    draft.parent !== null &&
    entries.some((entry) => entry.entryId === draft.parent?.entryId);

  return (
    <FormField label="Operation" id={id}>
      {(control) => (
        <SettingsSelect
          {...control}
          data-testid="feed-composer-operation-picker"
          aria-label="Operation"
          width="fill"
          value={draft.parent?.entryId ?? ''}
          disabled={saving}
          replayPrivacy={{ maskClassName: REPLAY_MASK_CLASS }}
          options={[
            {
              value: '',
              label: 'No operation',
              testId: OPERATION_OPTION_TEST_ID,
            },
            ...(draft.parent !== null && !parentListed
              ? [
                  {
                    value: draft.parent.entryId,
                    label: draft.parent.title,
                    testId: OPERATION_OPTION_TEST_ID,
                  },
                ]
              : []),
            ...entries.map((entry) => ({
              value: entry.entryId,
              label: entry.title,
              testId: OPERATION_OPTION_TEST_ID,
            })),
          ]}
          onValueChange={(selectedId) => {
            if (selectedId.length === 0) {
              onChange({ parent: null });
              return;
            }
            const selected = entries.find(
              (entry) => entry.entryId === selectedId,
            );
            if (selected !== undefined) {
              onChange({
                parent: { entryId: selected.entryId, title: selected.title },
              });
              return;
            }
            if (draft.parent?.entryId !== selectedId)
              onChange({ parent: null });
          }}
        />
      )}
    </FormField>
  );
}
