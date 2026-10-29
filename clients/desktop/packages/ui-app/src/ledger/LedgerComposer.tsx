'use client';

import type { JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { LedgerFilePicker } from '@canopy/app-core';
import type { LedgerViewDraft, LedgerViewStore } from '@canopy/app-state';
import { LedgerEntryForm } from '@canopy/ui-shared/components';
import {
  LedgerDraftFileSearch,
  LedgerDraftOwnerPicker,
} from './LedgerDraftFields';
import { ledgerSaveProblemText } from './ledger-write-copy';

export interface LedgerComposerProps {
  readonly store: LedgerViewStore;
  /** Finds files to reference; without it, files cannot be added. */
  readonly files?: LedgerFilePicker;
  /** Binds the form to this entry's correction instead of a new entry. */
  readonly correctionOf?: string;
  /** Prevents a moved correction form from taking focus unexpectedly. */
  readonly autoFocusContent?: boolean;
  /** Hears of a saved correction, with the entry it became. */
  readonly onSaved?: (entryId: string) => void;
}

/**
 * The person's draft of a new entry or a correction, saved through the
 * store. The draft survives leaving the panel; it closes once saved or
 * canceled.
 */
export function LedgerComposer({
  store,
  files,
  correctionOf,
  autoFocusContent,
  onSaved,
}: LedgerComposerProps): JSX.Element | null {
  const { scope, draft, saving, problem, owners } = store(
    useShallow((state) => {
      if (correctionOf === undefined) {
        const { composer } = state;
        return {
          scope: state.scope,
          draft: composer.draft,
          saving: composer.saving,
          problem: composer.problem,
          owners: state.owners,
        };
      }
      const correction = state.corrections[correctionOf] ?? null;
      return {
        scope: state.scope,
        draft: correction?.draft ?? null,
        saving: correction?.saving ?? false,
        problem: correction?.problem ?? null,
        owners: state.owners,
      };
    }),
  );

  if (draft === null) return null;
  const onChange = (patch: Partial<LedgerViewDraft>): void => {
    if (correctionOf === undefined) store.getState().updateDraft(patch);
    else store.getState().updateCorrection(correctionOf, patch);
  };
  return (
    <LedgerEntryForm
      value={draft}
      correctionOf={draft.supersedes}
      {...(autoFocusContent === undefined ? {} : { autoFocusContent })}
      saving={saving}
      problem={problem === null ? null : ledgerSaveProblemText(problem)}
      ownerControl={(labelId) => (
        <LedgerDraftOwnerPicker
          labelId={labelId}
          draft={draft}
          owners={owners}
          saving={saving}
          onOpen={() => void store.getState().loadOwners()}
          onChange={onChange}
        />
      )}
      fileSearch={
        files === undefined ? undefined : (
          <LedgerDraftFileSearch
            files={files}
            scope={scope}
            draft={draft}
            saving={saving}
            onChange={onChange}
          />
        )
      }
      onChange={onChange}
      onSave={() => {
        if (correctionOf === undefined) {
          void store.getState().submitDraft();
        } else {
          void store
            .getState()
            .submitCorrection(correctionOf)
            .then((savedId) => {
              if (savedId !== null) onSaved?.(savedId);
            });
        }
      }}
      onDiscard={() => {
        if (correctionOf === undefined) store.getState().discardDraft();
        else store.getState().cancelCorrection(correctionOf);
      }}
    />
  );
}
