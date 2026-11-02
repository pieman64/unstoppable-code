'use client';

import { useEffect, useRef, useState, type JSX } from 'react';
import type { LedgerFilePicker } from '@canopy/app-core';
import type { LedgerViewDraft, LedgerViewOwnersState } from '@canopy/app-state';
import {
  ledgerViewScopeKey,
  type LedgerTaskViewScope,
  type LedgerViewFileCandidate,
} from '@canopy/protocol/ledger-view';
import {
  LedgerFileSearch,
  LedgerOwnerPicker,
} from '@canopy/ui-shared/components';

/** Typing settles this long before a file search runs. */
const FILE_SEARCH_DEBOUNCE_MS = 200;
const FILE_SEARCH_LIMIT = 20;

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
