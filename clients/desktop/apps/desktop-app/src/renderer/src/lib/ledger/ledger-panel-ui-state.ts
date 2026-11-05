import { ledgerViewHoldsDraft, type LedgerViewState } from '@canopy/app-state';
import type { LedgerWorkStatus } from '@canopy/app-state/ledger-feed';
import type { AppAdvisorJson } from '@canopy/desktop-shared/types';
import { isLedgerViewFiltered } from '@canopy/ui-shared/components';

/**
 * Whether the panel holds a draft: a new entry's, shown or set aside, or a
 * correction's, which always shows under its thread.
 */
function draftUiState(state: LedgerViewState): 'shown' | 'set_aside' | null {
  if (state.composer.draft !== null) {
    return state.composer.shown ? 'shown' : 'set_aside';
  }
  return ledgerViewHoldsDraft(state) ? 'shown' : null;
}

/** The panel's Operations view state, from its scoped work store. */
export interface LedgerPanelWorkUiState {
  readonly statusFilter: LedgerWorkStatus | null;
  readonly openIds: readonly string[];
  readonly rowCount: number;
  /** A close waits on the person's choice about its open tasks. */
  readonly closePending: boolean;
}

/**
 * App Advisor awareness of an open Feed panel: its scope and what it shows,
 * as counts and IDs, and whether the person is writing a draft there. Entry
 * text never leaves the panel this way.
 */
export function ledgerPanelUiState(
  state: LedgerViewState,
  projectId: string,
  worktreeId: string,
  work?: LedgerPanelWorkUiState,
): AppAdvisorJson {
  const draft = draftUiState(state);
  return {
    projectId,
    worktreeId,
    live: state.live,
    newActivityCount: state.newActivityCount,
    ...(work === undefined
      ? {}
      : {
          operationsStatusFilter: work.statusFilter,
          operationsOpenRowCount: work.openIds.length,
          operationsRowCount: work.rowCount,
          closePending: work.closePending || state.closeIntent !== null,
        }),
    listStatus: state.list.status,
    entryCount: state.list.entries.length,
    hasMore: state.list.hasMore,
    searching: state.queryText.trim().length > 0,
    filtered: isLedgerViewFiltered(state.filters),
    ...(state.selectedEntryId === null
      ? {}
      : {
          selectedEntryId: state.selectedEntryId,
          detailStatus: state.detail.status,
        }),
    ...(draft === null ? {} : { draft }),
  };
}
