/**
 * `@canopy/app-state` holds the shared Zustand stores and the
 * {@link CanopyClientProvider} that injects a transport into the React tree.
 *
 * Browser-safe: depends only on `@canopy/app-core`, `zustand`, and React. No
 * Electron, Node, Prisma, Next, or `window.api` imports — the transport
 * arrives via the injected {@link CanopyClient}.
 */
export * from './CanopyClientProvider';
export * from './create-client-store';
export {
  NavigationProvider,
  useNavigation,
  useNavigationController,
  type NavigationProviderProps,
  type UseNavigationResult,
} from './navigation/NavigationProvider';
export * from './chat/create-chat-store';
export * from './chat/chat-repair';
export {
  computeIncrementalTurnGroups,
  createEmptyTurnGroupCache,
  hasLiveTurnTimer,
  isTurnTimerMessage,
  type TurnGroupCache,
} from './chat/turn-groups';
export {
  hasAuthoritativeMatch,
  isOptimisticMessage,
  makeOptimisticUserMessage,
  reconcileOptimistic,
  OPTIMISTIC_ID_PREFIX,
  RECONCILE_SKEW_MS,
} from './chat/optimistic';
export { detectSentPrompt, type SentPromptSummary } from './chat/sent-prompt';
export {
  createFileViewerStore,
  useFileViewerStore,
  useFileViewerStoreApi,
  fileViewerKey,
  diffViewerKey,
  type FileViewMode,
  type FileViewerStatus,
  type FileViewerSession,
  type DiffViewerSession,
  type FileViewerState,
} from './file-viewer/create-file-viewer-store';
export {
  createActivityStore,
  useActivityStore,
  selectSectionOrder,
  selectChangedFiles,
  selectPrStatus,
  selectWorktreeItems,
  type ActivityState,
} from './activity/create-activity-store';
export {
  CODE_ONLY_ACTIVITY_SECTION_IDS,
  DEFAULT_ACTIVITY_SECTION_ORDER,
  isActivitySectionId,
  isActivitySectionInteractive,
  isActivitySectionVisibleForTarget,
  isActivitySectionVisibleForWorkspaceType,
  isCodeOnlyActivitySection,
  COWORK_AMBIENT_ACTIVITY_SECTION_IDS,
  isWorkActivitySection,
  mergeVisibleActivitySectionOrder,
  resolveActivitySectionOrder,
  visibleActivitySectionIds,
  WORK_ACTIVITY_SECTION_IDS,
  type ActivitySectionCapabilities,
  type ActivitySectionId,
  type ActivityWorkspaceType,
} from './activity/section-order';
export {
  createOverviewStore,
  useOverviewStore,
  selectUnreadWorktrees,
  selectInProgressChatWorktrees,
  selectAwaitingApprovalWorktrees,
  selectRunningPipelineRuns,
  selectUnreadPipelineRuns,
  selectOverviewCounts,
  selectWorktreeLabel,
  type OverviewState,
  type OverviewWorktree,
  type OverviewCounts,
  type WorktreeLabel,
} from './overview/create-overview-store';
export {
  createWorkspaceContextStore,
  useWorkspaceContextStore,
  selectCurrentWorkspaceContext,
  selectSwitchableOrganizations,
  type WorkspaceContextStatus,
  type WorkspaceContextStoreState,
} from './workspace-context/create-workspace-context-store';
export {
  computeOrgProjectListed,
  createOrgProjectsStore,
  useOrgProjectsStore,
  useOrgProjectsStoreApi,
  selectCatalogSnapshot,
  selectCatalogLoading,
  selectCatalogError,
  selectListedProjects,
  selectPlaceholderRows,
  selectSetupProgress,
  type OrgProjectsStoreState,
} from './org-projects/create-org-projects-store';
export {
  DEFAULT_LEDGER_VIEW_FILTERS,
  LEDGER_VIEW_PAGE_SIZE,
  createLedgerViewStore,
  ledgerViewSearchParams,
  type LedgerViewDetailState,
  type LedgerViewListState,
  type LedgerViewProblem,
  type LedgerViewState,
  type LedgerViewStore,
  type LedgerViewStoreOptions,
  type LedgerViewSelectOptions,
} from './ledger/create-ledger-view-store';
export {
  DEFAULT_LEDGER_FEED_FILTERS,
  createLedgerFeedStore,
  ledgerFeedDraft,
  type LedgerFeedComposerState,
  type LedgerFeedListState,
  type LedgerFeedRemoteDetailState,
  type LedgerFeedState,
  type LedgerFeedStore,
  type LedgerFeedStoreOptions,
  type LedgerViewStoreFor,
} from './ledger/create-ledger-feed-store';
export {
  isLedgerDraftComplete,
  ledgerDraftAddParams,
  ledgerDraftMovable,
  ledgerViewHoldsDraft,
  type LedgerViewChangeNotice,
  type LedgerViewComposerState,
  type LedgerViewCorrectionState,
  type LedgerViewDraft,
  type LedgerViewEntryChangeState,
  type LedgerViewOwnersState,
  type LedgerViewSavedAdopted,
  type LedgerViewWriteProblem,
  type LedgerCorrectionTarget,
} from './ledger/ledger-view-writes';
export {
  createLinearPreviewStore,
  githubOriginKey,
  githubPreviewKey,
  githubTitleSlot,
  invalidateReferencePreviews,
  linearPreviewKey,
  linearTitleSlot,
  setReferenceEnrichmentModes,
  useLinearPreviewStore,
  LINEAR_PREVIEW_CACHE_LIMITS,
  LINEAR_VISIBILITY_QUEUE_LIMITS,
  REFERENCE_PREVIEW_RESET_KEY,
  REFERENCE_PREVIEW_STORAGE_KEY,
  type GitHubPreviewView,
  type GitHubRepositoryName,
  type LinearPreviewStoreDeps,
  type LinearPreviewStoreState,
  type LinearPreviewView,
  type LinearTeamCatalog,
  type LinearTitleSlot,
  type ReferencePreviewProvider,
  type ReferencePreviewView,
  type ReferenceTitleSlot,
} from './reference-previews/linear-preview-store';

export {
  createExternalAgentStore,
  createExternalAgentsOverviewStore,
  type ExternalAgentAction,
  type ExternalAgentOutcome,
  type ExternalAgentState,
  type ExternalAgentStore,
  type ExternalAgentsOverviewState,
  type ExternalAgentsOverviewStore,
} from './external-agents';
export {
  buildSidebarActivitySnapshot,
  compareSidebarActivityEntries,
  sidebarActivityStandaloneChatKey,
  sidebarActivityWorktreeChatKey,
  SIDEBAR_ACTIVITY_UNREPLIED_PAGE_SIZE,
  type SidebarActivityBuildInput,
  type SidebarActivityChatSummary,
  type SidebarActivityEntry,
  type SidebarActivityInventory,
  type SidebarActivityStandaloneChat,
  type SidebarActivityWorkspace,
  type SidebarActivityWorktree,
  type SidebarActivitySection,
  type SidebarActivitySnapshot,
  type SidebarActivityStandaloneEntry,
  type SidebarActivityWorktreeEntry,
} from './sidebar-activity/sidebar-activity-mode-model';
export {
  createSidebarActivityModeStore,
  useSidebarActivityModeStore,
  type SidebarActivityLoader,
  type SidebarActivityModeState,
  type SidebarActivityStatus,
} from './sidebar-activity/create-sidebar-activity-mode-store';
export * from './script-actions';
