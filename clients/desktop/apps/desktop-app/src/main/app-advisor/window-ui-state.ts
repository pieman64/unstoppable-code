import type { AppAdvisorWindowUiState } from '@canopy/desktop-shared/types';

let latestWindowUiState: AppAdvisorWindowUiState = {
  activeWorkEntryId: null,
  activeChatId: null,
  navCollapsed: false,
  settingsModalOpen: false,
  archivedOverviewOpen: false,
  archivedOverviewWorkspaceId: null,
  emptyTrashConfirmationOpen: false,
  emptyTrashRunning: false,
  lastArchivedOverviewRequestId: null,
  lastArchivedOverviewConfirmationOpened: null,
};

export function getLatestAppAdvisorWindowUiState(): AppAdvisorWindowUiState {
  return latestWindowUiState;
}

export function setLatestAppAdvisorWindowUiState(
  state: AppAdvisorWindowUiState,
): void {
  latestWindowUiState = state;
}
