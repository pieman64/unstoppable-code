import type { LedgerFeedState } from '@canopy/app-state';
import type { AppAdvisorJson } from '@canopy/desktop-shared/types';
import {
  isLedgerTaskViewScope,
  type LedgerViewScope,
} from '@canopy/protocol/ledger-view';
import { isLedgerFeedFiltered } from '@canopy/ui-shared/components';

interface FeedComposerUiState {
  readonly addingEntry: true;
  readonly draftProjectId?: string;
  readonly draftWorktreeId?: string;
}

function composerUiState(
  composer: LedgerFeedState['composer'],
): FeedComposerUiState {
  return {
    addingEntry: true,
    ...(composer.projectId === null
      ? {}
      : { draftProjectId: composer.projectId }),
    ...(composer.scope === null
      ? {}
      : { draftWorktreeId: composer.scope.worktreeId }),
  };
}

/** The selected scope by its IDs: a task's, or a global Ledger's. */
function selectedScopeUiState(
  scope: LedgerViewScope,
): Readonly<Record<string, string>> {
  return isLedgerTaskViewScope(scope)
    ? {
        selectedProjectId: scope.projectId,
        selectedWorktreeId: scope.worktreeId,
      }
    : { selectedScopeKind: 'global', selectedLedgerId: scope.ledgerId };
}

/**
 * App Advisor awareness of the Feed: whose entries, how many rows and what
 * is selected, as counts and IDs, and while the new entry's form is open, the
 * project and task chosen for it. A draft set aside is not on screen, so it
 * is not reported. Entry text never leaves the page this way.
 */
export function ledgerFeedUiState(state: LedgerFeedState): AppAdvisorJson {
  return {
    audience: state.audience,
    listStatus: state.list.status,
    rowCount: state.list.rows.length,
    hasMore: state.list.hasMore,
    searching: state.queryText.trim().length > 0,
    filtered: isLedgerFeedFiltered(state.filters),
    newActivity: state.newActivity,
    ...(state.list.notice === null ? {} : { notice: state.list.notice }),
    ...(state.selectedEntryId === null
      ? {}
      : { selectedEntryId: state.selectedEntryId }),
    ...(state.selectedScope === null
      ? {}
      : selectedScopeUiState(state.selectedScope)),
    ...(state.composer.shown ? composerUiState(state.composer) : {}),
  };
}
